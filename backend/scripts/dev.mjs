import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Arranque LOCAL sin Docker: levanta el gestor de secretos y luego el resto de servicios.
// Cada servicio recibe SOLO su token de arranque (SM_TOKEN) y nada más del archivo .env,
// salvo el gestor de secretos, que recibe los secretos y los tokens.

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = path.join(root, 'data');

if (process.argv.includes('--reset')) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('Datos locales eliminados (./data). Levantando servicios con datos nuevos...');
}
if (!fs.existsSync(path.join(root, '.env'))) {
  console.error('Falta .env: ejecuta primero  npm run env:init');
  process.exit(1);
}
process.loadEnvFile(path.join(root, '.env'));

const e = process.env;
const common = {
  PATH: e.PATH,
  NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
  SVC_URL_TEMPLATE: 'http://127.0.0.1:{port}',
  BIND_HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  SEED_ON_BOOT: e.SEED_ON_BOOT || 'true',
};
const pick = (...keys) => Object.fromEntries(keys.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
const secretKeys = Object.keys(e).filter((k) => k.startsWith('SECRET_') || k.startsWith('SM_TOKEN_'));

const SERVICES = [
  { name: 'secret-manager', env: pick(...secretKeys) },
  { name: 'auth', env: { SM_TOKEN: e.SM_TOKEN_AUTH, ...pick('SEED_ADMIN_PASSWORD', 'SEED_CUSTOMER_PASSWORD', 'ACCESS_TOKEN_TTL_SECONDS') } },
  { name: 'clients', env: { SM_TOKEN: e.SM_TOKEN_CLIENTS } },
  { name: 'inventory', env: { SM_TOKEN: e.SM_TOKEN_INVENTORY } },
  { name: 'orders', env: { SM_TOKEN: e.SM_TOKEN_ORDERS, ...pick('ORDER_TTL_MINUTES', 'DELIVERY_FEE', 'FREE_DELIVERY_FROM') } },
  { name: 'payments', env: { SM_TOKEN: e.SM_TOKEN_PAYMENTS } },
  { name: 'provider-mock', env: { SM_TOKEN: e.SM_TOKEN_PROVIDER_MOCK, PUBLIC_PROVIDER_URL: e.PUBLIC_PROVIDER_URL || 'http://localhost:4007', WEBHOOK_URL: 'http://127.0.0.1:8080/api/v1/payments/webhook' } },
  { name: 'graphql-gateway', env: { SM_TOKEN: e.SM_TOKEN_GRAPHQL_GATEWAY, ...pick('GRAPHQL_MAX_DEPTH', 'GRAPHQL_MAX_COST', 'GRAPHQL_INTROSPECTION') } },
  { name: 'api-gateway', env: { SM_TOKEN: e.SM_TOKEN_API_GATEWAY, ...pick('CORS_ORIGINS', 'RATE_LIMIT_ANON', 'RATE_LIMIT_USER', 'RATE_LIMIT_AUTH', 'RATE_LIMIT_IP', 'RATE_LIMIT_WEBHOOK') } },
];
const PORTS = { 'secret-manager': 4100, auth: 4001, clients: 4002, inventory: 4003, orders: 4004, payments: 4005, 'graphql-gateway': 4006, 'provider-mock': 4007, 'api-gateway': 8080 };

const children = [];
const stop = () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function start(svc) {
  const child = spawn('node', [path.join(root, 'services', svc.name, 'index.js')], {
    cwd: root,
    env: { ...common, ...svc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[${svc.name}]`.padEnd(18);
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (process.env.DEV_VERBOSE === '1' || !l.includes('"msg":"request"')) out.write(`${tag}${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => { if (code) console.error(`${tag}terminó con código ${code}`); });
  children.push(child);
}

async function waitHealthy(name) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORTS[name]}/health`);
      if (res.ok) return;
    } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} no respondió a tiempo`);
}

fs.mkdirSync(dataDir, { recursive: true });
start(SERVICES[0]);
await waitHealthy('secret-manager');
for (const svc of SERVICES.slice(1)) start(svc);
for (const svc of SERVICES.slice(1)) await waitHealthy(svc.name);
console.log('\nSistema listo. API Gateway: http://localhost:8080/api/v1  |  Proveedor de pagos (prueba): http://localhost:4007');
console.log('Ctrl+C para detener. Usuarios de prueba: admin@naturalpower.test, cliente1@naturalpower.test, cliente2@naturalpower.test (contraseñas en .env)\n');
