import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { openDb, migrate, seed, tx, nowIso } from '../../lib/db.js';
import { PORTS } from '../../lib/config.js';
import { HttpError, badRequest, notFound, conflict } from '../../lib/errors.js';
import { Validator, pagination, isUuid } from '../../lib/validate.js';

// Inventory: catálogo, combos, stock y reservas. Autoridad sobre precios y disponibilidad.
// El navegador nunca informa precios: orders pregunta aquí (quote) y aquí se reserva el stock.

const secrets = createSecretClient();
const app = createApp({ service: 'inventory', secrets, defaultIssuers: ['api-gateway', 'graphql-gateway'] });
const db = openDb('inventory');
migrate(db, fileURLToPath(new URL('./migrations', import.meta.url)));
seed(db, fileURLToPath(new URL('./seeds', import.meta.url)));

const CATEGORIES = ['smoothie', 'jugo', 'batido', 'shot'];
const IMAGE_RE = /^(https:\/\/|img\/)[\w\-./?=&%]{1,300}$/;
const RESERVATION_SAFETY_TTL_S = 20 * 60;

const sizeRows = () => db.prepare('SELECT * FROM sizes').all();
const sizeByCode = (code) => db.prepare('SELECT * FROM sizes WHERE code = ?').get(code);

function sizesFor(product) {
  const all = sizeRows();
  const wanted = product.fixed_size ? ['fixed'] : ['small', 'medium', 'large'];
  return wanted.map((code) => {
    const s = all.find((x) => x.code === code);
    return { code: s.code, label: s.label, volumeMl: s.volume_ml, price: product.base_price + s.price_delta };
  });
}

function nutritionOf(p) {
  return { kcal: p.kcal, carbs: p.carbs, sugars: p.sugars, protein: p.protein, fat: p.fat, fiber: p.fiber };
}

function productDto(p, { admin = false } = {}) {
  const onHand = p.on_hand ?? 0;
  const reserved = p.reserved ?? 0;
  const dto = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    category: p.category,
    price: p.base_price,
    image: p.image_url,
    badge: p.badge,
    available: p.active === 1 && onHand - reserved > 0,
    sizes: sizesFor(p),
    nutrition: nutritionOf(p),
  };
  if (admin) {
    dto.active = p.active === 1;
    dto.stock = { onHand, reserved, free: onHand - reserved };
  }
  return dto;
}

const PRODUCT_SELECT = 'SELECT p.*, s.on_hand, s.reserved FROM products p LEFT JOIN stock s ON s.product_id = p.id';

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------- Consulta pública ----------
app.get('/products', {}, (ctx) => {
  const { limit, offset } = pagination(ctx.query);
  const { q, category, available } = ctx.query;
  if (category !== undefined && !CATEGORIES.includes(category)) throw badRequest('Categoría inválida', [{ field: 'category', message: `Valores: ${CATEGORIES.join(', ')}` }]);
  if (available !== undefined && !['true', 'false'].includes(available)) throw badRequest('Filtro available inválido', [{ field: 'available', message: 'true o false' }]);
  if (q !== undefined && q.length > 60) throw badRequest('Búsqueda demasiado larga', [{ field: 'q', message: 'Máximo 60 caracteres' }]);

  const where = ['p.active = 1'];
  const args = [];
  if (category) { where.push('p.category = ?'); args.push(category); }
  if (q) { where.push("p.search_terms LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(q.toLocaleLowerCase('es'))}%`); }
  if (available === 'true') where.push('s.on_hand - s.reserved > 0');
  if (available === 'false') where.push('s.on_hand - s.reserved <= 0');

  const base = `${PRODUCT_SELECT} WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p LEFT JOIN stock s ON s.product_id = p.id WHERE ${where.join(' AND ')}`).get(...args).n;
  const rows = db.prepare(`${base} ORDER BY p.created_at, p.name LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const admin = ctx.user?.role === 'admin';
  return { items: rows.map((p) => productDto(p, { admin })), page: { limit, offset, total } };
});

app.get('/products/:id', {}, (ctx) => {
  const p = db.prepare(`${PRODUCT_SELECT} WHERE p.active = 1 AND (p.id = ? OR p.slug = ?)`).get(ctx.params.id, ctx.params.id);
  if (!p) throw notFound('Producto no encontrado');
  return productDto(p, { admin: ctx.user?.role === 'admin' });
});

function comboDto(c) {
  const items = db.prepare(
    `SELECT ci.*, p.name AS product_name FROM combo_items ci LEFT JOIN products p ON p.id = ci.product_id WHERE ci.combo_id = ? ORDER BY ci.id`,
  ).all(c.id);
  const components = items.map((i) => ({
    productId: i.product_id,
    name: i.product_name ?? null,
    category: i.category,
    quantity: i.qty,
    requiresSelection: i.product_id === null,
  }));
  const available = items.every((i) => {
    if (i.product_id) {
      const s = db.prepare('SELECT on_hand - reserved AS free FROM stock WHERE product_id = ?').get(i.product_id);
      return s && s.free >= i.qty;
    }
    const s = db.prepare('SELECT COALESCE(SUM(s.on_hand - s.reserved), 0) AS free FROM stock s JOIN products p ON p.id = s.product_id WHERE p.category = ? AND p.active = 1').get(i.category);
    return s.free >= i.qty;
  });
  return { id: c.id, slug: c.slug, name: c.name, description: c.description, price: c.price, badge: c.badge, image: c.image_url, available: c.active === 1 && available, components };
}

app.get('/combos', {}, () => ({ items: db.prepare('SELECT * FROM combos WHERE active = 1 ORDER BY rowid').all().map(comboDto) }));
app.get('/combos/:id', {}, (ctx) => {
  const c = db.prepare('SELECT * FROM combos WHERE active = 1 AND (id = ? OR slug = ?)').get(ctx.params.id, ctx.params.id);
  if (!c) throw notFound('Combo no encontrado');
  return comboDto(c);
});

// ---------- Interno: lote de productos (evita N consultas desde GraphQL) ----------
app.post('/internal/products/batch', { issuers: ['orders', 'graphql-gateway'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const ids = v.array('ids', { min: 1, max: 100 });
  v.done();
  const valid = [...new Set(ids.filter((i) => isUuid(i)))];
  if (!valid.length) return { items: [] };
  const rows = db.prepare(`${PRODUCT_SELECT} WHERE p.id IN (${valid.map(() => '?').join(',')})`).all(...valid);
  const admin = ctx.user?.role === 'admin';
  return { items: rows.map((p) => productDto(p, { admin })) };
});

// ---------- Interno: cotización oficial (precios y composición) ----------
const MAX_QTY = 20;

app.post('/internal/quote', { issuers: ['orders'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const items = v.array('items', { min: 1, max: 30 });
  v.done();

  const lines = [];
  const problems = [];
  items.forEach((raw, idx) => {
    const iv = new Validator(raw);
    const kind = iv.oneOf('kind', ['product', 'combo']);
    const id = iv.uuid('id');
    const qty = iv.int('quantity', { min: 1, max: MAX_QTY });
    if (iv.errors.length) {
      problems.push(...iv.errors.map((e) => ({ field: `items[${idx}].${e.field}`, message: e.message })));
      return;
    }
    if (kind === 'product') {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
      if (!p) return problems.push({ field: `items[${idx}].id`, message: 'Producto no disponible' });
      const sizeCode = raw.size ?? (p.fixed_size ? 'fixed' : 'medium');
      const allowed = p.fixed_size ? ['fixed'] : ['small', 'medium', 'large'];
      if (!allowed.includes(sizeCode)) return problems.push({ field: `items[${idx}].size`, message: `Tamaños: ${allowed.join(', ')}` });
      const size = sizeByCode(sizeCode);
      const unit = p.base_price + size.price_delta;
      lines.push({
        kind, refId: p.id, name: p.name, category: p.category, size: size.code, sizeLabel: `${size.label} (${size.volume_ml} ml)`,
        unitPrice: unit, quantity: qty, lineTotal: unit * qty, components: [{ productId: p.id, name: p.name, quantity: qty }],
      });
    } else {
      const c = db.prepare('SELECT * FROM combos WHERE id = ? AND active = 1').get(id);
      if (!c) return problems.push({ field: `items[${idx}].id`, message: 'Combo no disponible' });
      const parts = db.prepare('SELECT * FROM combo_items WHERE combo_id = ? ORDER BY id').all(c.id);
      const selections = Array.isArray(raw.selections) ? raw.selections : [];
      const pool = {};
      for (const sel of selections) {
        const p = isUuid(sel) ? db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(sel) : null;
        if (!p) return problems.push({ field: `items[${idx}].selections`, message: 'Selección inválida' });
        (pool[p.category] ||= []).push(p);
      }
      const comps = new Map();
      const addComp = (p, n) => {
        const cur = comps.get(p.id) || { productId: p.id, name: p.name, quantity: 0 };
        cur.quantity += n * qty;
        comps.set(p.id, cur);
      };
      let ok = true;
      for (const part of parts) {
        if (part.product_id) {
          addComp(db.prepare('SELECT * FROM products WHERE id = ?').get(part.product_id), part.qty);
        } else {
          const chosen = (pool[part.category] || []).splice(0, part.qty);
          if (chosen.length !== part.qty) {
            ok = false;
            problems.push({ field: `items[${idx}].selections`, message: `Debes elegir ${part.qty} producto(s) de categoría ${part.category}` });
            break;
          }
          chosen.forEach((p) => addComp(p, 1));
        }
      }
      if (ok && Object.values(pool).some((rest) => rest.length)) {
        ok = false;
        problems.push({ field: `items[${idx}].selections`, message: 'Hay selecciones que no corresponden al combo' });
      }
      if (!ok) return;
      lines.push({
        kind, refId: c.id, name: c.name, category: 'combo', size: null, sizeLabel: null,
        unitPrice: c.price, quantity: qty, lineTotal: c.price * qty, components: [...comps.values()],
      });
    }
  });
  if (problems.length) throw badRequest('Items inválidos', problems);

  const demand = new Map();
  for (const line of lines) for (const comp of line.components) demand.set(comp.productId, (demand.get(comp.productId) || 0) + comp.quantity);
  return { lines, demand: [...demand].map(([productId, quantity]) => ({ productId, quantity })) };
});

// ---------- Interno: reservas de stock (atómicas) ----------
const reservationRows = (orderId) => db.prepare('SELECT * FROM reservations WHERE order_id = ?').all(orderId);

app.post('/internal/reservations', { issuers: ['orders'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const orderId = v.uuid('orderId');
  const ttl = v.int('ttlSeconds', { min: 60, max: RESERVATION_SAFETY_TTL_S, required: false }) ?? RESERVATION_SAFETY_TTL_S;
  const demand = v.array('demand', { min: 1, max: 60 });
  v.done();

  const existing = reservationRows(orderId);
  if (existing.length) return { orderId, status: 'held', expiresAt: existing[0].expires_at, idempotent: true };

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  tx(db, () => {
    for (const d of demand) {
      const dv = new Validator(d);
      const productId = dv.uuid('productId');
      const quantity = dv.int('quantity', { min: 1, max: 1000 });
      dv.done();
      const s = db.prepare('SELECT s.on_hand, s.reserved, p.name, p.active FROM stock s JOIN products p ON p.id = s.product_id WHERE s.product_id = ?').get(productId);
      if (!s || !s.active) throw conflict('PRODUCT_UNAVAILABLE', 'Producto no disponible', { productId });
      if (s.on_hand - s.reserved < quantity) {
        throw conflict('OUT_OF_STOCK', `Sin stock suficiente de ${s.name}`, { productId, name: s.name, requested: quantity, available: s.on_hand - s.reserved });
      }
      db.prepare('UPDATE stock SET reserved = reserved + ? WHERE product_id = ?').run(quantity, productId);
      db.prepare("INSERT INTO reservations (id, order_id, product_id, qty, status, expires_at) VALUES (?, ?, ?, ?, 'held', ?)").run(crypto.randomUUID(), orderId, productId, quantity, expiresAt);
    }
  });
  return reply(201, { orderId, status: 'held', expiresAt });
});

function transition(orderId, from, apply, to) {
  return tx(db, () => {
    const rows = reservationRows(orderId).filter((r) => r.status === from);
    for (const r of rows) {
      apply(r);
      db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), r.id);
    }
    return rows.length;
  });
}

app.post('/internal/reservations/:orderId/commit', { issuers: ['orders'] }, (ctx) => {
  const all = reservationRows(ctx.params.orderId);
  if (!all.length) throw notFound('Reserva no encontrada');
  if (all.every((r) => r.status === 'committed')) return { orderId: ctx.params.orderId, status: 'committed', idempotent: true };
  if (all.some((r) => r.status === 'released')) throw conflict('RESERVATION_RELEASED', 'La reserva ya fue liberada');
  transition(ctx.params.orderId, 'held', (r) => {
    db.prepare('UPDATE stock SET on_hand = on_hand - ?, reserved = reserved - ? WHERE product_id = ?').run(r.qty, r.qty, r.product_id);
  }, 'committed');
  return { orderId: ctx.params.orderId, status: 'committed' };
});

app.post('/internal/reservations/:orderId/release', { issuers: ['orders'] }, (ctx) => {
  const n = transition(ctx.params.orderId, 'held', (r) => {
    db.prepare('UPDATE stock SET reserved = reserved - ? WHERE product_id = ?').run(r.qty, r.product_id);
  }, 'released');
  return { orderId: ctx.params.orderId, released: n };
});

// Pedido pagado que se anula: las unidades vuelven al stock.
app.post('/internal/reservations/:orderId/restock', { issuers: ['orders'] }, (ctx) => {
  const n = transition(ctx.params.orderId, 'committed', (r) => {
    db.prepare('UPDATE stock SET on_hand = on_hand + ? WHERE product_id = ?').run(r.qty, r.product_id);
  }, 'restocked');
  return { orderId: ctx.params.orderId, restocked: n };
});

// Red de seguridad: libera reservas vencidas que orders no haya liberado.
const sweeper = setInterval(() => {
  const due = db.prepare("SELECT DISTINCT order_id FROM reservations WHERE status = 'held' AND expires_at < ?").all(nowIso());
  for (const { order_id } of due) {
    transition(order_id, 'held', (r) => db.prepare('UPDATE stock SET reserved = reserved - ? WHERE product_id = ?').run(r.qty, r.product_id), 'released');
    app.log.warn('reserva vencida liberada', { orderId: order_id });
  }
}, 30000);
sweeper.unref();

// ---------- Administración del catálogo ----------
const ADMIN = ['admin'];

const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function readProductInput(body, { partialActive = false } = {}) {
  const v = new Validator(body);
  const name = v.string('name', { min: 2, max: 60 });
  const description = v.string('description', { min: 5, max: 300 });
  const category = v.oneOf('category', CATEGORIES);
  const price = v.int('price', { min: 100, max: 100000 });
  const fixedSize = v.bool('fixedSize') ?? false;
  const image = v.string('image', { max: 300, required: false, pattern: IMAGE_RE, patternMessage: 'Debe ser https:// o una ruta img/...' });
  const badge = v.string('badge', { max: 30, required: false });
  const active = v.bool('active');
  const nv = new Validator(body?.nutrition);
  const nutrition = {};
  for (const f of ['kcal', 'carbs', 'sugars', 'protein', 'fat', 'fiber']) nutrition[f] = nv.int(f, { min: 0, max: 5000 });
  nv.errors.forEach((e) => v.errors.push({ field: `nutrition.${e.field}`, message: e.message }));
  v.done();
  return { name, description, category, price, fixedSize, image: image ?? null, badge: badge ?? null, active: partialActive ? active : active ?? true, nutrition };
}

app.get('/admin/products', { roles: ADMIN, issuers: ['api-gateway'] }, (ctx) => {
  const { limit, offset } = pagination(ctx.query);
  const total = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const rows = db.prepare(`${PRODUCT_SELECT} ORDER BY p.created_at, p.name LIMIT ? OFFSET ?`).all(limit, offset);
  return { items: rows.map((p) => productDto(p, { admin: true })), page: { limit, offset, total } };
});

app.post('/admin/products', { roles: ADMIN, issuers: ['api-gateway'] }, (ctx) => {
  const input = readProductInput(ctx.body);
  const v = new Validator(ctx.body);
  const initialStock = v.int('initialStock', { min: 0, max: 100000, required: false }) ?? 0;
  v.done();
  const id = crypto.randomUUID();
  const slug = slugify(input.name);
  if (!slug) throw badRequest('Nombre inválido');
  if (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) throw conflict('SLUG_TAKEN', 'Ya existe un producto con ese nombre');
  const n = input.nutrition;
  tx(db, () => {
    db.prepare(
      `INSERT INTO products (id, slug, name, description, category, base_price, fixed_size, image_url, badge, search_terms, active, kcal, carbs, sugars, protein, fat, fiber)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, slug, input.name, input.description, input.category, input.price, input.fixedSize ? 1 : 0, input.image, input.badge,
      `${input.category} ${input.name} ${input.description}`.toLocaleLowerCase('es'), input.active ? 1 : 0, n.kcal, n.carbs, n.sugars, n.protein, n.fat, n.fiber);
    db.prepare('INSERT INTO stock (product_id, on_hand, reserved) VALUES (?, ?, 0)').run(id, initialStock);
  });
  return reply(201, productDto(db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id), { admin: true }));
});

app.put('/admin/products/:id', { roles: ADMIN, issuers: ['api-gateway'] }, (ctx) => {
  if (!isUuid(ctx.params.id)) throw notFound('Producto no encontrado');
  const input = readProductInput(ctx.body);
  const n = input.nutrition;
  const r = db.prepare(
    `UPDATE products SET name=?, description=?, category=?, base_price=?, fixed_size=?, image_url=?, badge=?, search_terms=?, active=?,
       kcal=?, carbs=?, sugars=?, protein=?, fat=?, fiber=?, updated_at=? WHERE id=?`,
  ).run(input.name, input.description, input.category, input.price, input.fixedSize ? 1 : 0, input.image, input.badge,
    `${input.category} ${input.name} ${input.description}`.toLocaleLowerCase('es'), input.active ? 1 : 0, n.kcal, n.carbs, n.sugars, n.protein, n.fat, n.fiber, nowIso(), ctx.params.id);
  if (r.changes === 0) throw notFound('Producto no encontrado');
  return productDto(db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(ctx.params.id), { admin: true });
});

app.patch('/admin/products/:id/stock', { roles: ADMIN, issuers: ['api-gateway'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const onHand = v.int('onHand', { min: 0, max: 100000 });
  v.done();
  const s = db.prepare('SELECT * FROM stock WHERE product_id = ?').get(ctx.params.id);
  if (!s) throw notFound('Producto no encontrado');
  if (onHand < s.reserved) throw conflict('BELOW_RESERVED', 'El stock no puede ser menor que las unidades reservadas', { reserved: s.reserved });
  db.prepare('UPDATE stock SET on_hand = ? WHERE product_id = ?').run(onHand, ctx.params.id);
  return productDto(db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(ctx.params.id), { admin: true });
});

// DELETE desactiva: el historial de pedidos sigue refiriéndose al producto.
app.delete('/admin/products/:id', { roles: ADMIN, issuers: ['api-gateway'] }, (ctx) => {
  const r = db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), ctx.params.id);
  if (r.changes === 0) throw notFound('Producto no encontrado');
  return undefined;
});

await app.start(PORTS.inventory, { onStop: () => db.close() });
