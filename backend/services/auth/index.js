import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { createServiceClient } from '../../lib/client.js';
import { openDb, migrate, tx, nowIso } from '../../lib/db.js';
import { signJwt } from '../../lib/jwt.js';
import { PORTS, intEnv } from '../../lib/config.js';
import { HttpError, unauthorized } from '../../lib/errors.js';
import { Validator } from '../../lib/validate.js';

// Auth Service: identidades, contraseñas y sesiones. Emite tokens de acceso (15 min) y
// tokens de refresco opacos y rotativos. Es la única autoridad sobre credenciales.

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const ACCESS_TTL = intEnv('ACCESS_TOKEN_TTL_SECONDS', 900);
const REFRESH_TTL_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');

const secrets = createSecretClient();
const call = createServiceClient({ service: 'auth', secrets });
const app = createApp({ service: 'auth', secrets, defaultIssuers: ['api-gateway'] });
const db = openDb('identity');
migrate(db, fileURLToPath(new URL('./migrations', import.meta.url)));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PASSWORD_RE = /^\S{6,64}$/;

async function issueTokens(user) {
  const { current } = await secrets.get('jwt-access');
  const accessToken = signJwt(
    { iss: 'auth', aud: 'api-gateway', sub: user.id, role: user.role },
    current,
    { expiresIn: ACCESS_TTL },
  );
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    user.id,
    sha256(refreshToken),
    expires,
  );
  return { tokenId: id, body: { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL } };
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// POST /auth/register
app.post('/auth/register', {}, async (ctx) => {
  const v = new Validator(ctx.body);
  const name = v.string('name', { min: 1, max: 60 });
  const email = v.email('email');
  const password = v.string('password', { min: 6, max: 64, pattern: PASSWORD_RE, patternMessage: 'Entre 6 y 64 caracteres, sin espacios' });
  v.done();

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, 'customer')").run(
      id,
      email,
      name,
      passwordHash,
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'Ya existe una cuenta con ese correo');
    }
    throw err;
  }

  try {
    await call('clients', 'POST', '/internal/clients', { body: { id, name, email }, cid: ctx.cid });
  } catch (err) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id); // compensación: sin perfil no hay cuenta
    throw err;
  }

  const user = { id, name, email, role: 'customer' };
  const { body } = await issueTokens(user);
  return reply(201, { user: publicUser(user), ...body });
});

// POST /auth/login
app.post('/auth/login', {}, async (ctx) => {
  const v = new Validator(ctx.body);
  const email = v.email('email');
  const password = v.string('password', { min: 1, max: 128 });
  v.done();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    await verifyPassword(password, await DUMMY_HASH_PROMISE).catch(() => false); // iguala tiempos
    throw unauthorized('Credenciales inválidas');
  }
  if (user.locked_until && user.locked_until > nowIso()) {
    const e = new HttpError(429, 'ACCOUNT_LOCKED', 'Cuenta bloqueada temporalmente por intentos fallidos');
    e.headers = { 'retry-after': String(LOCK_MINUTES * 60) };
    throw e;
  }
  const ok = user.status === 'active' && (await verifyPassword(password, user.password_hash));
  if (!ok) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
      lock ? 0 : attempts,
      lock,
      user.id,
    );
    throw unauthorized('Credenciales inválidas');
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  const { body } = await issueTokens(user);
  return { user: publicUser(user), ...body };
});

// POST /auth/refresh  (rotación; si se reutiliza un token ya usado se revocan todas las sesiones)
app.post('/auth/refresh', {}, async (ctx) => {
  const v = new Validator(ctx.body);
  const refreshToken = v.string('refreshToken', { min: 20, max: 200 });
  v.done();

  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(sha256(refreshToken));
  if (!row) throw unauthorized('Sesión inválida');
  if (row.revoked_at) {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), row.user_id);
    app.log.warn('reutilización de refresh token: sesiones revocadas', { cid: ctx.cid, sub: row.user_id });
    throw unauthorized('Sesión inválida');
  }
  if (row.expires_at < nowIso()) throw unauthorized('Sesión expirada');

  const user = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(row.user_id);
  if (!user) throw unauthorized('Sesión inválida');

  const { tokenId, body } = await issueTokens(user);
  tx(db, () =>
    db.prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?').run(nowIso(), tokenId, row.id),
  );
  return { user: publicUser(user), ...body };
});

// POST /auth/logout
app.post('/auth/logout', {}, (ctx) => {
  const v = new Validator(ctx.body);
  const refreshToken = v.string('refreshToken', { min: 20, max: 200 });
  v.done();
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(
    nowIso(),
    sha256(refreshToken),
  );
  return undefined; // 204 también si el token no existe: no revela información
});

// Interno: clients solicita deshabilitar la identidad al eliminar la cuenta.
app.post('/internal/users/:id/disable', { issuers: ['clients'] }, (ctx) => {
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ctx.params.id);
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), ctx.params.id);
  return undefined;
});

// Usuarios de demostración: solo si hay contraseñas de prueba en el entorno (nunca en el código).
async function seedUsers() {
  if (process.env.SEED_ON_BOOT === 'false') return;
  const demo = [
    ['00000000-0000-4000-8000-000000000001', 'admin@naturalpower.test', 'Administrador Demo', 'admin', 'SEED_ADMIN_PASSWORD'],
    ['00000000-0000-4000-8000-000000000002', 'cliente1@naturalpower.test', 'Cliente Uno', 'customer', 'SEED_CUSTOMER_PASSWORD'],
    ['00000000-0000-4000-8000-000000000003', 'cliente2@naturalpower.test', 'Cliente Dos', 'customer', 'SEED_CUSTOMER_PASSWORD'],
  ];
  for (const [id, email, name, role, envKey] of demo) {
    const password = process.env[envKey];
    if (!password) continue;
    if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) continue;
    db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
      id,
      email,
      name,
      await hashPassword(password),
      role,
    );
  }
}

await seedUsers();
await app.start(PORTS.auth, { onStop: () => db.close() });
