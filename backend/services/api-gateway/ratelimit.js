import { intEnv } from '../../lib/config.js';

// Límite de solicitudes por clave (IP o usuario) con ventana deslizante simple.
// En memoria: suficiente para una instancia; con varias réplicas se movería a un almacén compartido.

const WINDOW_MS = 60_000;
const LIMITS = {
  anon: intEnv('RATE_LIMIT_ANON', 120),
  user: intEnv('RATE_LIMIT_USER', 240),
  auth: intEnv('RATE_LIMIT_AUTH', 20), // login/registro/contacto: frena fuerza bruta
  webhook: intEnv('RATE_LIMIT_WEBHOOK', 120),
  ip: intEnv('RATE_LIMIT_IP', 1200), // techo por IP para rutas autenticadas (el límite fino es por usuario)
};

const hits = new Map();

export function checkRate(cls, key) {
  const limit = LIMITS[cls] ?? LIMITS.anon;
  const now = Date.now();
  const k = `${cls}:${key}`;
  const list = (hits.get(k) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= limit) {
    hits.set(k, list);
    return { ok: false, retryAfter: Math.ceil((WINDOW_MS - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(k, list);
  return { ok: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) {
    const alive = list.filter((t) => now - t < WINDOW_MS);
    if (alive.length) hits.set(k, alive);
    else hits.delete(k);
  }
}, WINDOW_MS).unref();
