// Configuración común. Ningún valor secreto vive aquí: todo llega por variables de entorno
// (referencias de arranque) o por el gestor de secretos.

export const PORTS = {
  'secret-manager': 4100,
  auth: 4001,
  clients: 4002,
  inventory: 4003,
  orders: 4004,
  payments: 4005,
  'graphql-gateway': 4006,
  'provider-mock': 4007,
  'api-gateway': 8080,
};

/** URL interna de un servicio. En Docker se resuelve por nombre; en local por 127.0.0.1. */
export function serviceUrl(name) {
  const template = process.env.SVC_URL_TEMPLATE || 'http://{name}:{port}';
  return template.replace('{name}', name).replace('{port}', String(PORTS[name]));
}

export function required(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${key}`);
  }
  return value;
}

export const intEnv = (key, fallback) => {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const isProd = () => process.env.NODE_ENV === 'production';
