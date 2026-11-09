import { HttpError } from '../../lib/errors.js';

// Resolvers: cada uno delega en la API interna del subsistema dueño del dato (nunca a su base),
// propagando la identidad verificada. Las colecciones de productos/pagos se piden por LOTES.

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const upper = (v) => (typeof v === 'string' ? v.toUpperCase() : v);

/** Cargador por lotes: junta las claves pedidas en el mismo turno y hace UNA llamada. */
export function createLoader(batchFn) {
  const cache = new Map();
  let queue = [];
  let scheduled = false;

  async function flush() {
    const batch = queue;
    queue = [];
    scheduled = false;
    try {
      const result = await batchFn([...new Set(batch.map((b) => b.key))]);
      for (const b of batch) b.resolve(result.get(b.key) ?? null);
    } catch (err) {
      for (const b of batch) b.reject(err);
    }
  }

  return {
    load(key) {
      if (cache.has(key)) return cache.get(key);
      const promise = new Promise((resolve, reject) => {
        queue.push({ key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
      });
      cache.set(key, promise);
      return promise;
    },
  };
}

export function createLoaders(call, user, cid) {
  return {
    products: createLoader(async (ids) => {
      const res = await call('inventory', 'POST', '/internal/products/batch', { body: { ids }, user, cid, timeoutMs: 4000 });
      return new Map(res.body.items.map((p) => [p.id, p]));
    }),
    payments: createLoader(async (orderIds) => {
      const res = await call('payments', 'POST', '/internal/payments/batch', { body: { orderIds }, user, cid, timeoutMs: 4000 });
      const map = new Map();
      for (const p of res.body.items) if (!map.has(p.orderId)) map.set(p.orderId, p); // el más reciente
      return map;
    }),
  };
}

const page = (p, count) => ({ ...p, hasMore: p.offset + count < p.total });

function params(obj) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const resolvers = {
  Query: {
    catalog: async (_, a, ctx) => {
      const res = await ctx.call('inventory', 'GET', `/products${params({
        limit: a.first, offset: a.offset, category: lower(a.category), q: a.q, available: a.onlyAvailable ? 'true' : undefined,
      })}`, { user: ctx.user, cid: ctx.cid });
      return { nodes: res.body.items, page: page(res.body.page, res.body.items.length) };
    },
    combos: async (_, __, ctx) => (await ctx.call('inventory', 'GET', '/combos', { user: ctx.user, cid: ctx.cid })).body.items,
    product: async (_, a, ctx) => {
      try {
        return (await ctx.call('inventory', 'GET', `/products/${encodeURIComponent(a.id)}`, { user: ctx.user, cid: ctx.cid })).body;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
    // Agregación principal: orders (estado/totales) + payments (pago) + inventory (productos).
    resumenPedido: async (_, a, ctx) =>
      (await ctx.call('orders', 'GET', `/orders/${encodeURIComponent(a.id)}`, { user: ctx.user, cid: ctx.cid })).body,
    misPedidos: async (_, a, ctx) => {
      const res = await ctx.call('orders', 'GET', `/orders${params({ limit: a.first, offset: a.offset, status: a.status })}`, { user: ctx.user, cid: ctx.cid });
      return { nodes: res.body.items, page: page(res.body.page, res.body.items.length) };
    },
    me: async (_, __, ctx) => (await ctx.call('clients', 'GET', '/internal/me', { user: ctx.user, cid: ctx.cid })).body,
    pedidosAdmin: async (_, a, ctx) => {
      const res = await ctx.call('orders', 'GET', `/admin/orders${params({ limit: a.first, offset: a.offset, status: a.status, userId: a.userId })}`, { user: ctx.user, cid: ctx.cid });
      return { nodes: res.body.items, page: page(res.body.page, res.body.items.length) };
    },
  },
  Mutation: {
    anularPedido: async (_, a, ctx) =>
      (await ctx.call('orders', 'DELETE', `/orders/${encodeURIComponent(a.id)}`, { body: { reason: a.reason }, user: ctx.user, cid: ctx.cid })).body,
  },
  Product: {
    category: (p) => upper(p.category),
    relacionados: async (p, a, ctx) => {
      const first = Math.max(1, Math.min(a.first ?? 4, 10));
      const res = await ctx.call('inventory', 'GET', `/products${params({ category: lower(p.category), limit: first + 1 })}`, { user: ctx.user, cid: ctx.cid });
      return res.body.items.filter((x) => x.id !== p.id).slice(0, first);
    },
  },
  SizeOption: { code: (s) => upper(s.code) },
  OrderItem: {
    size: (i) => (i.size ? upper(i.size) : null),
    // Si inventory no responde, solo este campo falla (error parcial); el pedido se entrega igual.
    product: (i, _, ctx) => (i.kind === 'product' ? ctx.loaders.products.load(i.refId) : null),
  },
  Order: {
    payment: (o) => ({ ...o.payment, orderId: o.id }),
  },
  Payment: {
    status: (p) => p.status,
    amount: async (p, _, ctx) => (await ctx.loaders.payments.load(p.orderId))?.amount ?? null,
    currency: async (p, _, ctx) => (await ctx.loaders.payments.load(p.orderId))?.currency ?? null,
    providerRef: async (p, _, ctx) => (await ctx.loaders.payments.load(p.orderId))?.providerRef ?? null,
  },
};
