import { signJwt } from './jwt.js';
import { serviceUrl } from './config.js';
import { HttpError } from './errors.js';

/**
 * Cliente HTTP entre servicios. Cada llamada lleva un token interno de 60 s firmado con el
 * secreto del DESTINO (svc-<destino>), con emisor, audiencia, identidad del usuario verificada
 * y el id de correlación. El usuario nunca puede aportar estos datos: los pone el gateway.
 *
 * Errores del destino:
 *  - 4xx  -> se propaga el mismo estado y código (son reglas de negocio, no fallas).
 *  - 5xx / red / timeout -> 502/503/504 UPSTREAM_UNAVAILABLE, sin detalles internos.
 */
export function createServiceClient({ service, secrets }) {
  return async function call(target, method, path, opts = {}) {
    const { body, rawBody, user, cid, timeoutMs = 5000, headers = {}, passthrough = false } = opts;
    const { current } = await secrets.get(`svc-${target}`);
    const token = signJwt(
      {
        iss: service,
        aud: target,
        usr: user ? { sub: user.sub, role: user.role } : undefined,
        cid,
      },
      current,
      { expiresIn: 60 },
    );

    let res;
    try {
      res = await fetch(`${serviceUrl(target)}${path}`, {
        method,
        headers: {
          'x-internal-token': token,
          'x-correlation-id': cid || '',
          ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const e = new HttpError(
        timeout ? 504 : 503,
        'UPSTREAM_UNAVAILABLE',
        'Servicio no disponible temporalmente',
      );
      e.upstream = target;
      throw e;
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (res.ok || (passthrough && res.status < 500)) return { status: res.status, body: json, headers: res.headers };

    if (res.status >= 400 && res.status < 500) {
      const e = new HttpError(
        res.status,
        json?.error?.code || 'UPSTREAM_ERROR',
        json?.error?.message || 'Solicitud rechazada',
        json?.error?.details,
      );
      e.upstream = target;
      throw e;
    }
    const e = new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Servicio no disponible temporalmente');
    e.upstream = target;
    throw e;
  };
}
