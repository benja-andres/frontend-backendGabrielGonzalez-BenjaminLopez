import crypto from 'node:crypto';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { openDb } from '../../lib/db.js';
import { PORTS } from '../../lib/config.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { Validator } from '../../lib/validate.js';

// Proveedor de pagos de PRUEBA (hace el papel de Webpay Plus / Flow en modo integración).
// Es un sistema EXTERNO al backend: tiene su propia base, su propia API key y firma sus avisos.
// Reproduce el contrato esencial: crear transacción -> pagar en su página -> aviso firmado
// -> confirmación servidor-a-servidor -> reembolso. No procesa tarjetas reales.

const secrets = createSecretClient();
const app = createApp({ service: 'provider-mock' }); // sin token interno: es un tercero
const db = openDb('provider');
db.exec(`CREATE TABLE IF NOT EXISTS transactions (
  token TEXT PRIMARY KEY, buy_order TEXT NOT NULL, amount INTEGER NOT NULL, description TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','AUTHORIZED','REJECTED','REFUNDED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);

const PUBLIC_URL = process.env.PUBLIC_PROVIDER_URL || 'http://localhost:4007';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://api-gateway:8080/api/v1/payments/webhook';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function requireApiKey(ctx) {
  const given = Buffer.from(String(ctx.headers['x-api-key'] || ''));
  const { current, previous } = await secrets.get('provider-api-key');
  const ok = [current, previous].filter(Boolean).some((k) => {
    const exp = Buffer.from(k);
    return exp.length === given.length && crypto.timingSafeEqual(exp, given);
  });
  if (!ok) throw new HttpError(401, 'UNAUTHENTICATED', 'API key inválida');
}

// ---- API servidor-a-servidor (la usa payments) ----
app.post('/v1/transactions', { public: true }, async (ctx) => {
  await requireApiKey(ctx);
  const v = new Validator(ctx.body);
  const buyOrder = v.string('buyOrder', { min: 8, max: 64 });
  const amount = v.int('amount', { min: 1 });
  const description = v.string('description', { max: 120, required: false });
  v.done();
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO transactions (token, buy_order, amount, description, status) VALUES (?, ?, ?, ?, 'PENDING')").run(token, buyOrder, amount, description ?? null);
  return reply(201, { token, url: `${PUBLIC_URL}/pay/${token}` });
});

app.get('/v1/transactions/:token', { public: true }, async (ctx) => {
  await requireApiKey(ctx);
  const t = db.prepare('SELECT * FROM transactions WHERE token = ?').get(ctx.params.token);
  if (!t) throw notFound('Transacción no encontrada');
  return { token: t.token, status: t.status, amount: t.amount, buyOrder: t.buy_order };
});

app.post('/v1/transactions/:token/refund', { public: true }, async (ctx) => {
  await requireApiKey(ctx);
  const t = db.prepare('SELECT * FROM transactions WHERE token = ?').get(ctx.params.token);
  if (!t) throw notFound('Transacción no encontrada');
  if (t.status === 'REFUNDED') return { status: 'REFUNDED', idempotent: true };
  if (t.status !== 'AUTHORIZED') throw new HttpError(409, 'NOT_REFUNDABLE', 'Solo se reembolsan transacciones autorizadas');
  db.prepare("UPDATE transactions SET status = 'REFUNDED' WHERE token = ?").run(t.token);
  return { status: 'REFUNDED' };
});

// ---- Página de pago del proveedor (la ve el cliente) ----
const html = (body) => reply(200, `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proveedor de pago (prueba)</title><body style="font-family:system-ui;max-width:420px;margin:3rem auto;padding:0 1rem">${body}</body></html>`, { 'content-type': 'text/html; charset=utf-8' });

app.get('/pay/:token', { public: true }, (ctx) => {
  const t = db.prepare('SELECT * FROM transactions WHERE token = ?').get(ctx.params.token);
  if (!t) throw notFound('Transacción no encontrada');
  if (t.status !== 'PENDING') return html(`<h1>Transacción ${esc(t.status.toLowerCase())}</h1><p>Esta transacción ya fue procesada.</p>`);
  return html(`<h1>Pago de prueba</h1><p>Monto: <strong>$${esc(t.amount.toLocaleString('es-CL'))}</strong></p>
    <p>Entorno de integración: no se ingresan datos de tarjeta.</p>
    <form method="post" action="/pay/${esc(t.token)}/approve"><button style="padding:.7rem 1.2rem">Aprobar pago</button></form><br>
    <form method="post" action="/pay/${esc(t.token)}/reject"><button style="padding:.7rem 1.2rem">Rechazar pago</button></form>`);
});

async function deliverWebhook(t) {
  const { current } = await secrets.get('payment-webhook-hmac');
  const raw = JSON.stringify({
    eventId: crypto.randomUUID(), token: t.token, status: t.status, amount: t.amount, buyOrder: t.buy_order, timestamp: new Date().toISOString(),
  });
  const signature = `sha256=${crypto.createHmac('sha256', current).update(raw).digest('hex')}`;
  let delivered = false;
  for (const wait of [0, 2000, 5000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
        body: raw,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) { delivered = true; break; }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // el receptor rechazó: no se reintenta
    } catch { /* se reintenta */ }
  }
  return delivered;
}

app.post('/pay/:token/:result', { public: true }, async (ctx) => {
  if (!['approve', 'reject'].includes(ctx.params.result)) throw notFound('Acción no encontrada');
  const t = db.prepare('SELECT * FROM transactions WHERE token = ?').get(ctx.params.token);
  if (!t) throw notFound('Transacción no encontrada');
  if (t.status !== 'PENDING') throw new HttpError(409, 'ALREADY_PROCESSED', 'La transacción ya fue procesada');
  const status = ctx.params.result === 'approve' ? 'AUTHORIZED' : 'REJECTED';
  db.prepare('UPDATE transactions SET status = ? WHERE token = ?').run(status, t.token);
  const delivered = await deliverWebhook({ ...t, status });
  if (String(ctx.headers.accept || '').includes('application/json')) return { status, webhookDelivered: delivered };
  return html(`<h1>Pago ${status === 'AUTHORIZED' ? 'aprobado' : 'rechazado'}</h1><p>Ya puedes volver a la tienda.</p>`);
});

await app.start(PORTS['provider-mock'], { onStop: () => db.close() });
