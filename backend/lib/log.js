// Logs en JSON con identificador de correlación. Nunca se registran cuerpos ni credenciales.

const SENSITIVE = /pass|token|secret|authorization|cookie|signature|apikey|api-key|hash/i;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(service) {
  const write = (level, msg, fields = {}) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...redact(fields),
    });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
  };
}
