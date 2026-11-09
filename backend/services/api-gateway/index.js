import http from 'node:http';
import crypto from 'node:crypto';
import { createSecretClient } from '../../lib/secrets.js';
import { createServiceClient } from '../../lib/client.js';
import { createLogger } from '../../lib/log.js';
import { verifyJwt, JwtError } from '../../lib/jwt.js';
import { writeJson } from '../../lib/http.js';
import { HttpError } from '../../lib/errors.js';
import { PORTS } from '../../lib/config.js';
import { ROUTES } from './routes.js';
import { checkRate } from './ratelimit.js';

// API Gateway: único punto de entrada HTTP desde el navegador.
//  1. Solo reenvía rutas/verbos de la tabla ROUTES.
//  2. Descarta TODA cabecera de identidad aportada por el cliente (x-user-*, x-internal-*, x-forwarded-user...)
//     y no confía en nada salvo el JWT de acceso, que verifica aquí.
//  3. Reenvía un token interno de 60 s con la identidad verificada, firmado con el secreto del destino.
//  4. Aplica límites de solicitudes, tamaño de cuerpo, tiempos de espera y mapea errores sin filtrar detalles.

const log = createLogger('api-gateway');
const secrets = createSecretClient();
const call = createServiceClient({ service: 'api-gateway', secrets });
const PREFIX = '/api/v1';
const TIMEOUT_MS = 8000;
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);

function compile(route) {
  const keys = [];
  const source = route.path.split('/').map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { ...route, regex: new RegExp(`^${source}$`), keys };
}
const table = ROUTES.map(compile);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key',
    'access-control-expose-headers': 'X-Correlation-Id,Idempotent-Replay,Retry-After',
    'access-control-max-age': '600',
  };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else chunks.push(c); });
    req.on('end', () => (tooBig ? reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Cuerpo demasiado grande')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function authenticate(req, route) {
  const header = req.headers.authorization;
  if (!header) {
    if (route.access === 'anon') return null;
    throw new HttpError(401, 'UNAUTHENTICATED', 'Autenticación requerida');
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'UNAUTHENTICATED', 'Cabecera Authorization inválida');
  const { current, previous } = await secrets.get('jwt-access');
  let payload;
  try {
    payload = verifyJwt(token, [current, previous], { aud: 'api-gateway', issuers: ['auth'] });
  } catch (err) {
    const expired = err instanceof JwtError && err.code === 'EXPIRED';
    throw new HttpError(401, expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED', expired ? 'La sesión expiró' : 'Token inválido');
  }
  return { sub: payload.sub, role: payload.role };
}

function authorize(route, user) {
  if (route.access === 'anon') return;
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Autenticación requerida');
  const allowed = { customer: ['customer'], user: ['customer', 'admin'], admin: ['admin'] }[route.access];
  if (!allowed.includes(user.role)) throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso para esta operación');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const cid = crypto.randomUUID();
  const base = { 'x-correlation-id': cid, ...SECURITY_HEADERS, ...corsHeaders(req) };
  let status = 500;
  let routeId = '(none)';
  let sub;

  try {
    if (req.method === 'OPTIONS') {
      status = 204;
      res.writeHead(204, base);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://gateway');
    if (url.pathname === '/health') {
      status = 200;
      writeJson(res, 200, { status: 'ok', service: 'api-gateway' }, base);
      return;
    }
    if (!url.pathname.startsWith(`${PREFIX}/`)) throw new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada');
    const path = url.pathname.slice(PREFIX.length);

    let route = null;
    let params = {};
    let pathExists = false;
    for (const r of table) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathExists = true;
      if (r.method !== req.method) continue;
      route = r;
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      break;
    }
    if (!route) {
      throw pathExists ? new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido') : new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada');
    }
    routeId = route.id;

    // Límite por IP antes de gastar recursos (la IP real es la del socket: no se confía en X-Forwarded-For).
    const ip = req.socket.remoteAddress || 'unknown';
    const preLimit = checkRate(route.limit === 'user' ? 'ip' : route.limit, ip);
    if (!preLimit.ok) {
      const e = new HttpError(429, 'RATE_LIMITED', 'Demasiadas solicitudes');
      e.headers = { 'retry-after': String(preLimit.retryAfter) };
      throw e;
    }

    const user = await authenticate(req, route);
    authorize(route, user);
    sub = user?.sub;
    if (user && route.limit === 'user') {
      const r = checkRate('user', user.sub);
      if (!r.ok) {
        const e = new HttpError(429, 'RATE_LIMITED', 'Demasiadas solicitudes');
        e.headers = { 'retry-after': String(r.retryAfter) };
        throw e;
      }
    }

    let raw;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      raw = await readBody(req, route.maxBody || 65536);
    }

    // Se construyen cabeceras NUEVAS: nada del cliente pasa salvo la lista blanca de la ruta.
    const headers = {};
    for (const name of route.pass || []) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }

    let targetPath = route.to.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k]));
    if (req.method === 'GET' && url.search) targetPath += url.search;

    const out = await call(route.target, req.method, targetPath, {
      rawBody: raw || undefined,
      user,
      cid,
      headers,
      timeoutMs: TIMEOUT_MS,
      passthrough: route.passthrough === true,
    });
    status = out.status;
    const extra = {};
    for (const h of ['idempotent-replay']) if (out.headers.get(h)) extra[h] = out.headers.get(h);
    writeJson(res, out.status, out.body, { ...base, ...extra });
  } catch (err) {
    const known = err instanceof HttpError;
    status = known ? err.status : 500;
    if (!known) log.error('error no controlado', { cid, route: routeId, error: err?.message });
    writeJson(res, status, {
      error: {
        code: known ? err.code : 'INTERNAL_ERROR',
        message: known ? err.message : 'Error interno',
        ...(known && err.details ? { details: err.details } : {}),
        correlationId: cid,
      },
    }, { ...base, ...(known && err.headers ? err.headers : {}) });
  } finally {
    log.info('request', { cid, route: routeId, method: req.method, status, ms: Date.now() - started, sub });
  }
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;

// Se confirma que el gestor de secretos responde antes de abrir el puerto público.
for (let i = 1; ; i += 1) {
  try {
    await secrets.get('jwt-access');
    break;
  } catch (err) {
    if (i >= 40) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await new Promise((resolve) => server.listen(PORTS['api-gateway'], process.env.BIND_HOST || '0.0.0.0', resolve));
log.info('escuchando', { port: PORTS['api-gateway'] });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
