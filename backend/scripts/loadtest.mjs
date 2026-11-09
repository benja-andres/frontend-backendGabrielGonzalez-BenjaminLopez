// Prueba de capacidad reproducible (Módulo 9, "caso B": sin gRPC ni analítica separada).
// Mide la solución actual (REST + GraphQL por el API Gateway) con carga transaccional típica.
//
//   npm run loadtest                         (sistema ya levantado)
//   CONCURRENCY=30 DURATION=15 npm run loadtest
//
// Sube los límites de solicitudes para medir capacidad: arranca el sistema con
//   RATE_LIMIT_ANON=100000 RATE_LIMIT_USER=100000 RATE_LIMIT_IP=1000000 npm run dev
// Las cifras son MEDICIONES de este entorno (hardware del equipo), no proyecciones.

import os from 'node:os';

const GW = `${process.env.GATEWAY_URL || 'http://localhost:8080'}/api/v1`;
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const DURATION_S = Number(process.env.DURATION || 10);

async function login() {
  const res = await fetch(`${GW}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@naturalpower.test', password: process.env.SEED_ADMIN_PASSWORD }),
  });
  return (await res.json()).accessToken;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function scenario(name, makeRequest) {
  const latencies = [];
  let errors = 0;
  let limited = 0;
  const stopAt = Date.now() + DURATION_S * 1000;
  const worker = async () => {
    while (Date.now() < stopAt) {
      const t0 = performance.now();
      try {
        const res = await makeRequest();
        await res.arrayBuffer();
        if (res.status === 429) limited += 1;
        else if (res.status >= 400) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - t0);
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    escenario: name,
    solicitudes: latencies.length,
    'RPS': Math.round(latencies.length / seconds),
    'p50 ms': +percentile(latencies, 50).toFixed(1),
    'p95 ms': +percentile(latencies, 95).toFixed(1),
    'p99 ms': +percentile(latencies, 99).toFixed(1),
    errores: errors,
    'limitadas(429)': limited,
  };
}

const token = await login();
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const catalogQuery = '{ catalog(first: 10) { nodes { id name price sizes { code price } } page { total } } }';

console.log(`Entorno: ${os.cpus().length} CPU (${os.cpus()[0].model.trim()}), ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, Node ${process.version}`);
console.log(`Carga: ${CONCURRENCY} clientes concurrentes durante ${DURATION_S} s por escenario\n`);

const rows = [];
rows.push(await scenario('REST  GET /products (anónimo)', () => fetch(`${GW}/products`)));
rows.push(await scenario('GraphQL catalog (anónimo)', () => fetch(`${GW}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: catalogQuery }) })));
rows.push(await scenario('REST  GET /orders (admin: /admin/orders)', () => fetch(`${GW}/admin/orders?limit=10`, { headers: auth })));
rows.push(await scenario('GraphQL pedidosAdmin + productos + pagos', () => fetch(`${GW}/graphql`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ query: '{ pedidosAdmin(first: 10) { nodes { id status totals { total } payment { status amount } items { name product { name } } } } }' }),
})));
console.table(rows);
