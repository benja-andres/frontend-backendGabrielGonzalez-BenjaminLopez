import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { createServiceClient } from '../../lib/client.js';
import { openDb, migrate, nowIso } from '../../lib/db.js';
import { PORTS, serviceUrl } from '../../lib/config.js';
import { HttpError, notFound, conflict } from '../../lib/errors.js';
import { Validator, isUuid } from '../../lib/validate.js';

// Payments: orquesta el cobro con el proveedor (Webpay/Flow en producción; "provider-mock" en pruebas).
//  - No almacena ni recibe datos de tarjeta: el cliente paga en la página del proveedor.
//  - Un aviso del proveedor se acepta solo si: (1) trae firma HMAC válida, (2) no se procesó antes,
//    y (3) el proveedor CONFIRMA estado y monto por canal servidor-a-servidor.
//  - Solo este servicio puede ordenar a orders el paso a PAID.

const secrets = createSecretClient();
const call = createServiceClient({ service: 'payments', secrets });
const app = createApp({ service: 'payments', secrets, defaultIssuers: ['orders'] });
const db = openDb('payments');
migrate(db, fileURLToPath(new URL('./migrations', import.meta.url)));

const PROVIDER = serviceUrl('provider-mock');

async function provider(method, path, body) {
  const { current } = await secrets.get('provider-api-key');
  let res;
  try {
    res = await fetch(`${PROVIDER}${path}`, {
      method,
      headers: { 'x-api-key': current, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new HttpError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'El proveedor de pagos no responde');
  }
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 409, 'PAYMENT_PROVIDER_ERROR', 'El proveedor rechazó la operación');
  return res.json();
}

const paymentDto = (p, { includeRef = false } = {}) => ({
  id: p.id,
  orderId: p.order_id,
  status: p.status,
  amount: p.amount,
  currency: p.currency,
  createdAt: p.created_at,
  ...(includeRef ? { providerRef: p.provider_token } : {}),
});

// ---- Iniciar pago (solo orders; el monto viene de la base de orders) ----
app.post('/internal/payments', { roles: ['customer'] }, async (ctx) => {
  const v = new Validator(ctx.body);
  const orderId = v.uuid('orderId');
  const amount = v.int('amount', { min: 1, max: 100000000 });
  const description = v.string('description', { max: 120, required: false }) ?? 'Pedido Natural Power';
  v.done();

  const existing = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status IN ('PENDING','APPROVED')").get(orderId);
  if (existing) {
    if (existing.user_id !== ctx.user.sub) throw notFound('Pago no encontrado');
    if (existing.status === 'APPROVED') throw conflict('ALREADY_PAID', 'El pedido ya está pagado');
    return { paymentId: existing.id, status: existing.status, redirectUrl: existing.redirect_url, idempotent: true };
  }

  const id = crypto.randomUUID();
  const tx = await provider('POST', '/v1/transactions', { buyOrder: id, amount, description });
  db.prepare('INSERT INTO payments (id, order_id, user_id, amount, status, provider_token, redirect_url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, orderId, ctx.user.sub, amount, 'PENDING', tx.token, tx.url,
  );
  return reply(201, { paymentId: id, status: 'PENDING', redirectUrl: tx.url });
});

// ---- Lectura por lotes para GraphQL: solo pagos del propio usuario (admin: todos) ----
app.post('/internal/payments/batch', { issuers: ['graphql-gateway'], roles: ['customer', 'admin'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const orderIds = v.array('orderIds', { min: 1, max: 100 });
  v.done();
  const ids = [...new Set(orderIds.filter(isUuid))];
  if (!ids.length) return { items: [] };
  const marks = ids.map(() => '?').join(',');
  const rows = ctx.user.role === 'admin'
    ? db.prepare(`SELECT * FROM payments WHERE order_id IN (${marks}) ORDER BY created_at DESC`).all(...ids)
    : db.prepare(`SELECT * FROM payments WHERE order_id IN (${marks}) AND user_id = ? ORDER BY created_at DESC`).all(...ids, ctx.user.sub);
  return { items: rows.map((p) => paymentDto(p, { includeRef: true })) };
});

// ---- Reembolso (anulación de pedido ya pagado) ----
async function refund(payment) {
  db.prepare("UPDATE payments SET status = 'REFUND_PENDING', updated_at = ? WHERE id = ?").run(nowIso(), payment.id);
  await provider('POST', `/v1/transactions/${payment.provider_token}/refund`, { amount: payment.amount });
  db.prepare("UPDATE payments SET status = 'REFUNDED', refunded_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), payment.id);
}

app.post('/internal/payments/by-order/:orderId/refund', {}, async (ctx) => {
  const p = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status IN ('APPROVED','REFUND_PENDING','REFUNDED') ORDER BY created_at DESC").get(ctx.params.orderId);
  if (!p) throw notFound('No hay un pago aprobado para este pedido');
  if (p.status === 'REFUNDED') return { paymentId: p.id, status: 'REFUNDED', idempotent: true };
  await refund(p);
  return { paymentId: p.id, status: 'REFUNDED' };
});

// ---- Aviso del proveedor (pasa por el gateway sin sesión de usuario; se autentica por firma) ----
function signatureOk(raw, header, secretsList) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  return secretsList.filter(Boolean).some((s) => {
    const expected = crypto.createHmac('sha256', s).update(raw).digest();
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

app.post('/webhooks/provider', { issuers: ['api-gateway'], maxBody: 16384 }, async (ctx) => {
  const { current, previous } = await secrets.get('payment-webhook-hmac');
  if (!signatureOk(ctx.raw, ctx.headers['x-provider-signature'], [current, previous])) {
    app.log.warn('aviso de pago con firma inválida', { cid: ctx.cid });
    throw new HttpError(401, 'INVALID_SIGNATURE', 'Firma inválida');
  }
  const v = new Validator(ctx.body);
  const eventId = v.string('eventId', { min: 8, max: 80 });
  const token = v.string('token', { min: 8, max: 120 });
  v.done();

  if (db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(eventId)) {
    return { duplicate: true };
  }
  const payment = db.prepare('SELECT * FROM payments WHERE provider_token = ?').get(token);
  if (!payment) throw notFound('Transacción desconocida');

  // La verdad viene del proveedor, no del contenido del aviso.
  const tx = await provider('GET', `/v1/transactions/${encodeURIComponent(token)}`);
  if (tx.status === 'PENDING') return reply(202, { pending: true });

  const record = (outcome) =>
    db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, payment_id, outcome) VALUES (?, ?, ?)').run(eventId, payment.id, outcome);

  if (tx.buyOrder !== payment.id || tx.amount !== payment.amount) {
    app.log.error('monto o referencia no coinciden con el proveedor', { cid: ctx.cid, paymentId: payment.id });
    record('mismatch');
    throw new HttpError(422, 'AMOUNT_MISMATCH', 'El monto o la referencia no coinciden');
  }

  const orderUser = { sub: payment.user_id, role: 'customer' };
  if (tx.status === 'AUTHORIZED') {
    if (payment.status === 'PENDING') {
      try {
        await call('orders', 'POST', `/internal/orders/${payment.order_id}/payment-result`, {
          body: { paymentId: payment.id, status: 'APPROVED', amount: payment.amount }, user: orderUser, cid: ctx.cid,
        });
        db.prepare("UPDATE payments SET status = 'APPROVED', approved_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), payment.id);
      } catch (err) {
        if (err.status === 409) {
          // Cobro aprobado pero el pedido ya no admite pago (vencido/anulado): se devuelve el dinero.
          app.log.warn('pago aprobado sobre pedido no pagable: se reembolsa', { cid: ctx.cid, paymentId: payment.id });
          await refund(payment);
          record('refunded_late');
          return { refunded: true };
        }
        throw err; // orders caído: sin registrar el evento, el proveedor reintentará
      }
    }
    record('approved');
    return { status: 'APPROVED' };
  }

  if (payment.status === 'PENDING') {
    await call('orders', 'POST', `/internal/orders/${payment.order_id}/payment-result`, {
      body: { paymentId: payment.id, status: 'REJECTED', amount: payment.amount }, user: orderUser, cid: ctx.cid,
    });
    db.prepare("UPDATE payments SET status = 'REJECTED', updated_at = ? WHERE id = ?").run(nowIso(), payment.id);
  }
  record('rejected');
  return { status: 'REJECTED' };
});

await app.start(PORTS.payments, { onStop: () => db.close() });
