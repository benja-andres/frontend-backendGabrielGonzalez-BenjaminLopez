import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { createServiceClient } from '../../lib/client.js';
import { openDb, migrate, seed, tx, nowIso } from '../../lib/db.js';
import { PORTS, intEnv } from '../../lib/config.js';
import { HttpError, badRequest, notFound, conflict } from '../../lib/errors.js';
import { Validator, pagination, isUuid } from '../../lib/validate.js';
import { computePricing } from './pricing.js';

// Orders: ciclo de vida de pedidos y cálculo oficial de totales. Única autoridad del estado del pedido.
// El frontend jamás decide que un pedido está pagado: solo payments (con confirmación del proveedor)
// puede mover un pedido a PAID.

const ORDER_TTL_MIN = intEnv('ORDER_TTL_MINUTES', 15);
const RESERVATION_TTL_S = (ORDER_TTL_MIN + 5) * 60;

const secrets = createSecretClient();
const call = createServiceClient({ service: 'orders', secrets });
const READERS = ['api-gateway', 'graphql-gateway'];
const app = createApp({ service: 'orders', secrets, defaultIssuers: ['api-gateway'] });
const db = openDb('orders');
migrate(db, fileURLToPath(new URL('./migrations', import.meta.url)));
seed(db, fileURLToPath(new URL('./seeds', import.meta.url)));

const ANY = ['customer', 'admin'];

// ---------- Máquina de estados ----------
const TRANSITIONS = {
  PENDING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAID: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  PAYMENT_FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  DELIVERED: [],
};
const ADMIN_TARGETS = ['PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];
const NON_COUNTING = ['PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'];

function setStatus(order, to, actor, reason = null) {
  const allowed = TRANSITIONS[order.status] || [];
  if (!allowed.includes(to)) {
    throw conflict('INVALID_TRANSITION', `No se puede pasar de ${order.status} a ${to}`, { from: order.status, to, allowed });
  }
  db.prepare('UPDATE orders SET status = ?, updated_at = ?, cancel_reason = COALESCE(?, cancel_reason) WHERE id = ?').run(
    to, nowIso(), to === 'CANCELLED' ? reason : null, order.id,
  );
  db.prepare('INSERT INTO order_status_history (order_id, from_status, to_status, actor, actor_role, reason) VALUES (?,?,?,?,?,?)').run(
    order.id, order.status, to, actor.id, actor.role, reason,
  );
  order.status = to;
}

// ---------- DTO ----------
function loadItems(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`).all(...orderIds);
  const map = new Map();
  for (const r of rows) {
    const list = map.get(r.order_id) || [];
    list.push({
      kind: r.kind, refId: r.ref_id, name: r.name, size: r.size, sizeLabel: r.size_label, quantity: r.qty,
      unitPrice: r.unit_price, lineTotal: r.line_total, discount: r.discount, promo: r.promo, components: JSON.parse(r.components),
    });
    map.set(r.order_id, list);
  }
  return map;
}

function loadHistory(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = db.prepare(`SELECT * FROM order_status_history WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`).all(...orderIds);
  const map = new Map();
  for (const h of rows) {
    const list = map.get(h.order_id) || [];
    list.push(h);
    map.set(h.order_id, list);
  }
  return map;
}

function orderDto(o, items, { admin = false, history = false, historyRows = null } = {}) {
  const dto = {
    id: o.id,
    status: o.status,
    fulfillment: o.fulfillment,
    items,
    totals: { subtotal: o.subtotal, discount: o.discount_total, deliveryFee: o.delivery_fee, total: o.total, currency: o.currency },
    coupon: o.coupon_code,
    address: o.address_snapshot ? JSON.parse(o.address_snapshot) : null,
    contact: { name: o.contact_name, phone: o.contact_phone },
    notes: o.notes,
    payment: { id: o.payment_id, status: o.payment_status || 'NOT_STARTED' },
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    expiresAt: o.status === 'PENDING_PAYMENT' ? o.expires_at : null,
  };
  if (admin) {
    dto.userId = o.user_id;
    dto.cancelReason = o.cancel_reason;
  }
  if (history) {
    const rows = historyRows ?? db.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id').all(o.id);
    dto.history = rows.map((h) => ({
      status: h.to_status,
      at: h.at,
      ...(admin ? { from: h.from_status, actor: h.actor, actorRole: h.actor_role, reason: h.reason } : {}),
    }));
  }
  return dto;
}

function dtoFor(order, user) {
  return orderDto(order, loadItems([order.id]).get(order.id) || [], { admin: user.role === 'admin', history: true });
}

/** Propiedad del recurso: un cliente solo ve sus pedidos; para otros el pedido "no existe". */
function findOrder(id, user) {
  if (!isUuid(id)) throw notFound('Pedido no encontrado');
  const o = user.role === 'admin'
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, user.sub);
  if (!o) throw notFound('Pedido no encontrado');
  return o;
}

// ---------- Crear pedido (idempotente) ----------
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readCreateInput(body) {
  const v = new Validator(body);
  const rawItems = v.array('items', { min: 1, max: 30 });
  const fulfillment = v.oneOf('fulfillment', ['delivery', 'pickup']);
  const addressId = v.uuid('addressId', { required: fulfillment === 'delivery' });
  const couponCode = v.string('couponCode', { max: 30, required: false });
  const notes = v.string('notes', { max: 200, required: false });
  const contact = body?.contact && typeof body.contact === 'object' ? body.contact : {};
  const cv = new Validator(contact);
  const contactName = cv.string('name', { max: 60, required: false });
  const contactPhone = cv.string('phone', { max: 20, required: false, pattern: /^[0-9+()\-\s]{6,20}$/, patternMessage: 'Teléfono inválido' });
  cv.errors.forEach((e) => v.errors.push({ field: `contact.${e.field}`, message: e.message }));
  v.done();
  // Solo se conservan los campos que el servidor entiende; precios y totales enviados se ignoran.
  const items = rawItems.map((i) => ({
    kind: i?.kind,
    id: i?.id,
    size: i?.size,
    quantity: i?.quantity,
    selections: Array.isArray(i?.selections) ? i.selections : undefined,
  }));
  return {
    items, fulfillment, addressId: fulfillment === 'delivery' ? addressId : null,
    couponCode: couponCode ? couponCode.toUpperCase() : null, notes: notes ?? null,
    contact: { name: contactName ?? null, phone: contactPhone ?? null },
  };
}

app.post('/orders', { roles: ['customer'] }, async (ctx) => {
  const key = ctx.headers['idempotency-key'];
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw badRequest('Falta la cabecera Idempotency-Key (8 a 64 caracteres: letras, números, _ o -)');
  }
  const input = readCreateInput(ctx.body);
  const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const user = ctx.user;

  // Reclama la clave (atómico por clave primaria). Replays devuelven la respuesta original.
  try {
    db.prepare("INSERT INTO idempotency_keys (user_id, key, request_hash, state) VALUES (?, ?, ?, 'in_progress')").run(user.sub, key, hash);
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    const prev = db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?').get(user.sub, key);
    if (prev.request_hash !== hash) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'La clave de idempotencia ya se usó con otra solicitud');
    if (prev.state === 'in_progress') throw conflict('REQUEST_IN_PROGRESS', 'La solicitud original aún se está procesando');
    return reply(prev.response_status, JSON.parse(prev.response_body), { 'idempotent-replay': 'true' });
  }

  const orderId = crypto.randomUUID();
  let reserved = false;
  try {
    // 1) Cotización oficial (precios, composición y demanda de stock)
    const quote = (await call('inventory', 'POST', '/internal/quote', { body: { items: input.items }, user, cid: ctx.cid })).body;

    // 2) Dirección (propiedad verificada por clients con la identidad del token)
    let address = null;
    let contactInfo = { name: input.contact.name, phone: input.contact.phone };
    if (input.fulfillment === 'delivery') {
      const res = (await call('clients', 'GET', `/internal/clients/${user.sub}/addresses/${input.addressId}`, { user, cid: ctx.cid })).body;
      address = res.address;
      contactInfo = { name: input.contact.name ?? res.contact.name ?? null, phone: input.contact.phone ?? res.contact.phone ?? null };
    }

    // 3) Cupón
    let coupon = null;
    if (input.couponCode) {
      const c = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(input.couponCode);
      const now = nowIso();
      if (!c || (c.starts_at && c.starts_at > now) || (c.ends_at && c.ends_at < now)) {
        throw new HttpError(422, 'COUPON_INVALID', 'El cupón no es válido');
      }
      if (c.first_purchase_only) {
        const prior = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status NOT IN (${NON_COUNTING.map(() => '?').join(',')})`).get(user.sub, ...NON_COUNTING).n;
        if (prior > 0) throw new HttpError(422, 'COUPON_NOT_ELIGIBLE', 'El cupón es solo para la primera compra');
      }
      coupon = c;
    }

    // 4) Totales oficiales
    const pricing = computePricing({ lines: quote.lines, fulfillment: input.fulfillment, coupon });

    // 5) Reserva de stock (atómica en inventory)
    await call('inventory', 'POST', '/internal/reservations', {
      body: { orderId, ttlSeconds: RESERVATION_TTL_S, demand: quote.demand },
      user, cid: ctx.cid,
    });
    reserved = true;

    // 6) Persistencia
    const expiresAt = new Date(Date.now() + ORDER_TTL_MIN * 60000).toISOString();
    tx(db, () => {
      db.prepare(
        `INSERT INTO orders (id, user_id, status, fulfillment, subtotal, discount_total, delivery_fee, total, coupon_code,
           contact_name, contact_phone, address_snapshot, notes, expires_at)
         VALUES (?, ?, 'PENDING_PAYMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(orderId, user.sub, input.fulfillment, pricing.subtotal, pricing.discountTotal, pricing.deliveryFee, pricing.total,
        coupon?.code ?? null, contactInfo.name, contactInfo.phone, address ? JSON.stringify(address) : null, input.notes, expiresAt);
      for (const l of pricing.lines) {
        db.prepare(
          `INSERT INTO order_items (order_id, kind, ref_id, name, category, size, size_label, qty, unit_price, line_total, discount, promo, components)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(orderId, l.kind, l.refId, l.name, l.category, l.size, l.sizeLabel, l.quantity, l.unitPrice, l.lineTotal, l.discount, l.promo, JSON.stringify(l.components));
      }
      db.prepare('INSERT INTO order_status_history (order_id, from_status, to_status, actor, actor_role) VALUES (?, NULL, ?, ?, ?)').run(orderId, 'PENDING_PAYMENT', user.sub, user.role);
    });

    const body = dtoFor(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), user);
    db.prepare("UPDATE idempotency_keys SET state = 'completed', response_status = 201, response_body = ? WHERE user_id = ? AND key = ?").run(JSON.stringify(body), user.sub, key);
    return reply(201, body);
  } catch (err) {
    // Compensación: liberar reserva si ya se hizo y soltar la clave para permitir reintento.
    if (reserved) {
      call('inventory', 'POST', `/internal/reservations/${orderId}/release`, { cid: ctx.cid }).catch(() => {});
    }
    db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ? AND state = ?').run(user.sub, key, 'in_progress');
    throw err;
  }
});

// ---------- Consultar ----------
function listOrders({ where, args, limit, offset, admin }) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const ids = rows.map((r) => r.id);
  const items = loadItems(ids);
  const histories = loadHistory(ids);
  return {
    items: rows.map((o) => orderDto(o, items.get(o.id) || [], { admin, history: true, historyRows: histories.get(o.id) || [] })),
    page: { limit, offset, total },
  };
}

function statusFilter(query) {
  if (query.status === undefined) return null;
  if (!Object.keys(TRANSITIONS).includes(query.status)) throw badRequest('Estado inválido', [{ field: 'status', message: `Valores: ${Object.keys(TRANSITIONS).join(', ')}` }]);
  return query.status;
}

app.get('/orders', { roles: ['customer'], issuers: READERS }, (ctx) => {
  const { limit, offset } = pagination(ctx.query, { defaultLimit: 10 });
  const status = statusFilter(ctx.query);
  return listOrders({
    where: `user_id = ?${status ? ' AND status = ?' : ''}`,
    args: status ? [ctx.user.sub, status] : [ctx.user.sub],
    limit, offset, admin: false,
  });
});

app.get('/orders/:id', { roles: ANY, issuers: READERS }, (ctx) => dtoFor(findOrder(ctx.params.id, ctx.user), ctx.user));

app.get('/admin/orders', { roles: ['admin'], issuers: READERS }, (ctx) => {
  const { limit, offset } = pagination(ctx.query);
  const status = statusFilter(ctx.query);
  const clauses = ['1 = 1'];
  const args = [];
  if (status) { clauses.push('status = ?'); args.push(status); }
  if (ctx.query.userId) {
    if (!isUuid(ctx.query.userId)) throw badRequest('userId inválido');
    clauses.push('user_id = ?');
    args.push(ctx.query.userId);
  }
  return listOrders({ where: clauses.join(' AND '), args, limit, offset, admin: true });
});

// ---------- Iniciar pago ----------
app.post('/orders/:id/pay', { roles: ['customer'] }, async (ctx) => {
  const order = findOrder(ctx.params.id, ctx.user);
  if (order.status !== 'PENDING_PAYMENT') throw conflict('ORDER_NOT_PAYABLE', `El pedido está en estado ${order.status}`);
  if (order.expires_at < nowIso()) throw conflict('ORDER_EXPIRED', 'El pedido expiró; crea uno nuevo');
  // El monto sale de la base de orders; cualquier monto enviado por el navegador se ignora.
  const res = (await call('payments', 'POST', '/internal/payments', {
    body: { orderId: order.id, amount: order.total, description: `Pedido Natural Power ${order.id.slice(0, 8)}` },
    user: ctx.user, cid: ctx.cid,
  })).body;
  db.prepare('UPDATE orders SET payment_id = ?, payment_status = ?, updated_at = ? WHERE id = ?').run(res.paymentId, res.status, nowIso(), order.id);
  return reply(201, { orderId: order.id, paymentId: res.paymentId, status: res.status, amount: order.total, currency: order.currency, redirectUrl: res.redirectUrl });
});

// ---------- Anular (no destructivo) ----------
async function cancelOrder(order, actor, reason, ctx) {
  const before = order.status;
  if (!TRANSITIONS[before].includes('CANCELLED')) {
    throw conflict('ORDER_NOT_CANCELLABLE', `Un pedido ${before} no se puede anular`);
  }
  if (before === 'PAID' || before === 'PREPARING') {
    // Pedido ya cobrado: primero devolver el dinero, luego el stock.
    await call('payments', 'POST', `/internal/payments/by-order/${order.id}/refund`, { cid: ctx.cid });
    await call('inventory', 'POST', `/internal/reservations/${order.id}/restock`, { cid: ctx.cid });
    db.prepare("UPDATE orders SET payment_status = 'REFUNDED' WHERE id = ?").run(order.id);
  }
  tx(db, () => setStatus(order, 'CANCELLED', actor, reason));
  if (before === 'PENDING_PAYMENT') {
    call('inventory', 'POST', `/internal/reservations/${order.id}/release`, { cid: ctx.cid }).catch((e) =>
      app.log.warn('no se pudo liberar la reserva (se liberará por vencimiento)', { orderId: order.id, error: e.message }));
  }
}

app.delete('/orders/:id', { roles: ANY, issuers: READERS }, async (ctx) => {
  const order = findOrder(ctx.params.id, ctx.user);
  const reasonRaw = ctx.body?.reason;
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim().slice(0, 200) : null;
  if (ctx.user.role === 'customer' && order.status !== 'PENDING_PAYMENT') {
    throw conflict('ORDER_NOT_CANCELLABLE', 'Solo puedes anular pedidos pendientes de pago');
  }
  await cancelOrder(order, { id: ctx.user.sub, role: ctx.user.role }, reason, ctx);
  return dtoFor(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), ctx.user);
});

// ---------- Administración de estados ----------
app.patch('/admin/orders/:id/status', { roles: ['admin'] }, async (ctx) => {
  const v = new Validator(ctx.body);
  const status = v.oneOf('status', ADMIN_TARGETS);
  const reason = v.string('reason', { min: 3, max: 200, required: status === 'CANCELLED' });
  v.done();
  const order = findOrder(ctx.params.id, ctx.user);
  const actor = { id: ctx.user.sub, role: ctx.user.role };
  if (status === 'CANCELLED') {
    await cancelOrder(order, actor, reason, ctx);
  } else {
    if (status === 'OUT_FOR_DELIVERY' && order.fulfillment !== 'delivery') throw conflict('INVALID_TRANSITION', 'Un retiro en tienda no sale a reparto');
    if (status === 'DELIVERED' && order.status === 'READY' && order.fulfillment === 'delivery') {
      throw conflict('INVALID_TRANSITION', 'Un pedido con despacho debe pasar por OUT_FOR_DELIVERY');
    }
    tx(db, () => setStatus(order, status, actor, reason ?? null));
  }
  return dtoFor(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), ctx.user);
});

// ---------- Interno: resultado de pago (solo payments) ----------
app.post('/internal/orders/:id/payment-result', { issuers: ['payments'] }, async (ctx) => {
  const v = new Validator(ctx.body);
  const paymentId = v.uuid('paymentId');
  const result = v.oneOf('status', ['APPROVED', 'REJECTED']);
  const amount = v.int('amount', { min: 0 });
  v.done();

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ctx.params.id);
  if (!order) throw notFound('Pedido no encontrado');
  if (order.payment_id !== paymentId) throw conflict('PAYMENT_MISMATCH', 'El pago no corresponde a este pedido');
  const actor = { id: 'payments', role: 'service' };

  if (result === 'APPROVED') {
    if (amount !== order.total) throw conflict('AMOUNT_MISMATCH', 'El monto pagado no coincide con el total del pedido');
    if (['PAID', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.status)) {
      return { orderId: order.id, status: order.status, idempotent: true };
    }
    if (order.status !== 'PENDING_PAYMENT') throw conflict('ORDER_NOT_PAYABLE', `El pedido está en estado ${order.status}`);
    try {
      await call('inventory', 'POST', `/internal/reservations/${order.id}/commit`, { cid: ctx.cid });
    } catch (err) {
      if (err.status === 409 || err.status === 404) throw conflict('ORDER_NOT_PAYABLE', 'La reserva de stock ya no está vigente');
      throw err;
    }
    tx(db, () => {
      setStatus(order, 'PAID', actor);
      db.prepare("UPDATE orders SET payment_status = 'APPROVED' WHERE id = ?").run(order.id);
    });
    return { orderId: order.id, status: order.status };
  }

  if (order.status === 'PENDING_PAYMENT') {
    tx(db, () => {
      setStatus(order, 'PAYMENT_FAILED', actor, 'Pago rechazado');
      db.prepare("UPDATE orders SET payment_status = 'REJECTED' WHERE id = ?").run(order.id);
    });
    call('inventory', 'POST', `/internal/reservations/${order.id}/release`, { cid: ctx.cid }).catch(() => {});
  }
  return { orderId: order.id, status: order.status };
});

// ---------- Vencimiento de pedidos sin pago ----------
const expirer = setInterval(() => {
  const due = db.prepare("SELECT * FROM orders WHERE status = 'PENDING_PAYMENT' AND expires_at < ?").all(nowIso());
  for (const order of due) {
    try {
      tx(db, () => setStatus(order, 'EXPIRED', { id: 'system', role: 'service' }, 'Pedido sin pago a tiempo'));
      call('inventory', 'POST', `/internal/reservations/${order.id}/release`, {}).catch(() => {});
      app.log.info('pedido vencido', { orderId: order.id });
    } catch (err) {
      app.log.warn('no se pudo vencer el pedido', { orderId: order.id, error: err.message });
    }
  }
}, 30000);
expirer.unref();

await app.start(PORTS.orders, { onStop: () => db.close() });
