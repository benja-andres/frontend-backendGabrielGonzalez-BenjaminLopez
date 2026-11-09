import crypto from 'node:crypto';
import fs from 'node:fs';
import { createApp } from '../../lib/http.js';
import { PORTS } from '../../lib/config.js';
import { HttpError } from '../../lib/errors.js';

// Gestor de secretos (sustituto controlado de Vault para el entorno de la evaluación).
//  - Los valores salen del entorno de ESTE proceso (SECRET_<NOMBRE>), nunca del repositorio.
//  - Cada servicio se identifica con su token de arranque (SM_TOKEN_<SERVICIO>).
//  - La ACL (acl.json) decide qué referencias puede leer cada servicio (mínimo privilegio).
//  - Rotación: SECRET_<NOMBRE> = valor nuevo y SECRET_<NOMBRE>__PREVIOUS = valor anterior;
//    los verificadores aceptan ambos hasta retirar el anterior.
//  - Cada lectura queda auditada (quién, qué referencia, resultado), sin el valor.

const acl = JSON.parse(fs.readFileSync(new URL('./acl.json', import.meta.url), 'utf8'));
const toName = (envKey, prefix) => envKey.slice(prefix.length).toLowerCase().replace(/_/g, '-');

const secrets = new Map();
const tokens = new Map(); // sha256(token) -> servicio

for (const [key, value] of Object.entries(process.env)) {
  if (!value) continue;
  if (key.startsWith('SECRET_')) {
    const isPrev = key.endsWith('__PREVIOUS');
    const base = isPrev ? key.slice(0, -'__PREVIOUS'.length) : key;
    const name = toName(base, 'SECRET_');
    const entry = secrets.get(name) || {};
    entry[isPrev ? 'previous' : 'current'] = value;
    secrets.set(name, entry);
  } else if (key.startsWith('SM_TOKEN_')) {
    const service = toName(key, 'SM_TOKEN_');
    tokens.set(crypto.createHash('sha256').update(value).digest('hex'), service);
  }
}

const app = createApp({ service: 'secret-manager' });

function callerFrom(headers) {
  const auth = headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const digest = crypto.createHash('sha256').update(token).digest();
  for (const [hash, service] of tokens) {
    if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), digest)) return service;
  }
  return null;
}

app.get('/v1/secrets/:name', { public: true }, (ctx) => {
  const caller = callerFrom(ctx.headers);
  if (!caller) {
    app.log.warn('lectura rechazada: identidad desconocida', { cid: ctx.cid, name: ctx.params.name });
    throw new HttpError(401, 'UNAUTHENTICATED', 'Identidad no reconocida');
  }
  const allowed = acl[caller] || [];
  const entry = secrets.get(ctx.params.name);
  if (!allowed.includes(ctx.params.name)) {
    app.log.warn('lectura denegada por ACL', { cid: ctx.cid, caller, name: ctx.params.name });
    throw new HttpError(403, 'FORBIDDEN', 'Sin acceso a esta referencia');
  }
  if (!entry?.current) throw new HttpError(404, 'NOT_FOUND', 'Referencia no configurada');
  app.log.info('lectura de secreto', { cid: ctx.cid, caller, name: ctx.params.name });
  return { name: ctx.params.name, current: entry.current, previous: entry.previous ?? null };
});

await app.start(PORTS['secret-manager']);
