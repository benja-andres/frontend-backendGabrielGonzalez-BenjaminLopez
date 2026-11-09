import crypto from 'node:crypto';

// JWT HS256 mínimo. Se fija el algoritmo (sin "alg: none" ni confusión de algoritmos).

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signJwt(payload, secret, { expiresIn = 900 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ ...payload, iat: now, exp: now + expiresIn, jti: crypto.randomUUID() });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export class JwtError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Verifica firma y vigencia. `secrets` admite varios valores (actual + anterior) para rotación.
 */
export function verifyJwt(token, secrets, { aud, issuers } = {}) {
  if (typeof token !== 'string' || token.length > 4096) throw new JwtError('INVALID', 'Token inválido');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('INVALID', 'Token inválido');
  const [head, body, sig] = parts;

  let header;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('INVALID', 'Token inválido');
  }
  if (header.alg !== 'HS256') throw new JwtError('INVALID', 'Algoritmo no permitido');

  const given = Buffer.from(sig, 'base64url');
  const valid = secrets.filter(Boolean).some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
  if (!valid) throw new JwtError('INVALID', 'Firma inválida');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('INVALID', 'Token inválido');
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new JwtError('EXPIRED', 'Token expirado');
  }
  if (aud && payload.aud !== aud) throw new JwtError('INVALID', 'Audiencia inválida');
  if (issuers && !issuers.includes(payload.iss)) throw new JwtError('INVALID', 'Emisor inválido');
  return payload;
}
