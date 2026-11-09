import http from 'node:http';
import crypto from 'node:crypto';
import { verifyJwt, JwtError } from './jwt.js';
import { HttpError, Reply, reply } from './errors.js';
import { createLogger } from './log.js';

export { reply };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CID = /^[A-Za-z0-9-]{8,64}$/;

function compilePath(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la solicitud es demasiado grande'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function writeJson(res, status, body, headers = {}) {
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (typeof body === 'string' && String(headers['content-type'] || '').startsWith('text/html')) {
    res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

/**
 * Mini framework HTTP para los servicios internos.
 *
 * Por defecto TODA ruta exige un token interno válido (emitido por otro servicio, con
 * audiencia = este servicio y emisor dentro de la lista permitida de la ruta). Las rutas
 * pueden además exigir rol de usuario. `public: true` solo para /health.
 */
export function createApp({ service, secrets = null, defaultIssuers = [], maxBody = 262144 }) {
  const log = createLogger(service);
  const routes = [];

  function route(method, pattern, opts, handler) {
    const { regex, keys } = compilePath(pattern);
    routes.push({ method, pattern, regex, keys, opts: opts || {}, handler });
  }

  async function authenticate(req, ctx, opts) {
    const token = req.headers['x-internal-token'];
    if (!token || !secrets) throw new HttpError(401, 'UNAUTHENTICATED', 'Identidad de servicio requerida');
    const { current, previous } = await secrets.get(`svc-${service}`);
    let payload;
    try {
      payload = verifyJwt(token, [current, previous], { aud: service });
    } catch (err) {
      throw new HttpError(401, 'UNAUTHENTICATED', err instanceof JwtError ? 'Token interno inválido' : 'No autenticado');
    }
    const issuers = opts.issuers || defaultIssuers;
    if (issuers.length && !issuers.includes(payload.iss)) {
      throw new HttpError(403, 'FORBIDDEN_CALLER', 'Este servicio no puede llamar a esta operación');
    }
    ctx.caller = payload.iss;
    ctx.user = payload.usr && payload.usr.sub ? { sub: payload.usr.sub, role: payload.usr.role } : null;
    if (payload.cid && CID.test(payload.cid)) ctx.cid = payload.cid;
  }

  async function handle(req, res) {
    const started = Date.now();
    const incoming = req.headers['x-correlation-id'];
    const ctx = {
      cid: typeof incoming === 'string' && CID.test(incoming) ? incoming : crypto.randomUUID(),
      user: null,
      caller: null,
      params: {},
      query: {},
      body: undefined,
      raw: '',
      headers: req.headers,
    };
    let status = 500;
    let routePattern = '(none)';

    try {
      const url = new URL(req.url, 'http://internal');
      ctx.query = Object.fromEntries(url.searchParams);
      const method = req.method;

      let match = null;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        match = r;
        ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        break;
      }
      if (!match) {
        throw pathMatched
          ? new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido')
          : new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada');
      }
      routePattern = match.pattern;

      if (!match.opts.public) await authenticate(req, ctx, match.opts);

      if (match.opts.roles && (!ctx.user || !match.opts.roles.includes(ctx.user.role))) {
        throw ctx.user
          ? new HttpError(403, 'FORBIDDEN', 'No tienes permiso para esta operación')
          : new HttpError(401, 'UNAUTHENTICATED', 'Autenticación requerida');
      }

      if (BODY_METHODS.has(method)) {
        ctx.raw = await readBody(req, match.opts.maxBody || maxBody);
        if (ctx.raw) {
          try {
            ctx.body = JSON.parse(ctx.raw);
          } catch {
            throw new HttpError(400, 'INVALID_JSON', 'El cuerpo no es JSON válido');
          }
        }
      }

      const out = await match.handler(ctx);
      if (out instanceof Reply) {
        status = out.status;
        writeJson(res, out.status, out.body, { 'x-correlation-id': ctx.cid, ...out.headers });
      } else if (out === undefined) {
        status = 204;
        writeJson(res, 204, undefined, { 'x-correlation-id': ctx.cid });
      } else {
        status = 200;
        writeJson(res, 200, out, { 'x-correlation-id': ctx.cid });
      }
    } catch (err) {
      const known = err instanceof HttpError;
      status = known ? err.status : 500;
      if (!known) log.error('error no controlado', { cid: ctx.cid, route: routePattern, error: err?.message, stack: err?.stack });
      writeJson(
        res,
        status,
        {
          error: {
            code: known ? err.code : 'INTERNAL_ERROR',
            message: known ? err.message : 'Error interno',
            ...(known && err.details ? { details: err.details } : {}),
            correlationId: ctx.cid,
          },
        },
        { 'x-correlation-id': ctx.cid, ...(known && err.headers ? err.headers : {}) },
      );
    } finally {
      log.info('request', {
        cid: ctx.cid,
        method: req.method,
        route: routePattern,
        status,
        ms: Date.now() - started,
        caller: ctx.caller,
        sub: ctx.user?.sub,
      });
    }
  }

  const app = {
    log,
    route,
    get: (p, o, h) => route('GET', p, o, h),
    post: (p, o, h) => route('POST', p, o, h),
    put: (p, o, h) => route('PUT', p, o, h),
    patch: (p, o, h) => route('PATCH', p, o, h),
    delete: (p, o, h) => route('DELETE', p, o, h),
    server: null,
    async start(port, { onStop } = {}) {
      // Obtiene el secreto propio antes de aceptar tráfico (reintenta mientras arranca el gestor).
      if (secrets) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await secrets.get(`svc-${service}`);
            break;
          } catch (err) {
            if (attempt >= 40) throw err;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      route('GET', '/health', { public: true }, () => ({ status: 'ok', service }));
      app.server = http.createServer((req, res) => {
        handle(req, res).catch((err) => log.error('fallo en handler', { error: err?.message }));
      });
      app.server.requestTimeout = 15000;
      app.server.headersTimeout = 10000;
      await new Promise((resolve) => app.server.listen(port, process.env.BIND_HOST || '0.0.0.0', resolve));
      log.info('escuchando', { port });
      const stop = () => {
        app.server.close(() => {
          if (onStop) onStop();
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    },
  };
  return app;
}
