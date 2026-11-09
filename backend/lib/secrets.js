import { serviceUrl, required } from './config.js';
import { HttpError } from './errors.js';

// Cliente del gestor de secretos. El valor solo vive en memoria del proceso.
// Si el gestor deja de responder se sigue usando la copia en memoria (aunque esté vencida),
// para no caer junto con él; los servicios que nunca obtuvieron el secreto no arrancan.

const TTL_MS = 5 * 60 * 1000;

export function createSecretClient() {
  const base = serviceUrl('secret-manager');
  const token = required('SM_TOKEN');
  const cache = new Map();

  async function fetchSecret(name) {
    const res = await fetch(`${base}/v1/secrets/${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new HttpError(res.status === 403 ? 500 : 503, 'SECRET_UNAVAILABLE', 'Secreto no disponible');
    const json = await res.json();
    return { current: json.current, previous: json.previous ?? null };
  }

  return {
    /** @returns {Promise<{current: string, previous: string|null}>} */
    async get(name) {
      const hit = cache.get(name);
      if (hit && hit.expires > Date.now()) return hit.value;
      try {
        const value = await fetchSecret(name);
        cache.set(name, { value, expires: Date.now() + TTL_MS });
        return value;
      } catch (err) {
        if (hit) return hit.value; // degradación controlada: copia previa
        throw err instanceof HttpError ? err : new HttpError(503, 'SECRET_UNAVAILABLE', 'Secreto no disponible');
      }
    },
  };
}
