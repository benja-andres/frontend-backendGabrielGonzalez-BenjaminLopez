import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Pruebas de integración contra el sistema EN EJECUCIÓN (npm run dev o docker compose up).
//   npm test
// Cada ejecución registra clientes nuevos, así que se puede repetir sin limpiar datos.
// Variables: GATEWAY_URL, PROVIDER_URL, E2E_DIRECT=local|docker (acceso directo a servicios privados).

const GW = `${process.env.GATEWAY_URL || 'http://localhost:8080'}/api/v1`;
const PROVIDER = process.env.PROVIDER_URL || 'http://localhost:4007';
const DIRECT = process.env.E2E_DIRECT || 'local';
const run = crypto.randomBytes(4).toString('hex');
const PASSWORD = `Pw${crypto.randomBytes(6).toString('hex')}`;

const GREEN = 'b0000000-0000-4000-8000-000000000001';
const BERRY = 'b0000000-0000-4000-8000-000000000002';
const TROPICAL = 'b0000000-0000-4000-8000-000000000003';
const SHOT = 'b0000000-0000-4000-8000-000000000010';
const COMBO_PAREJA = 'c0000000-0000-4000-8000-000000000001';

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${GW}${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, body: json, headers: res.headers };
}

const gql = (query, { token, variables } = {}) => api('POST', '/graphql', { token, body: { query, variables } });
const key = () => `k-${crypto.randomUUID()}`;

async function register(name) {
  const email = `${name}.${run}@naturalpower.test`;
  const res = await api('POST', '/auth/register', { body: { name, email, password: PASSWORD } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const addr = await api('POST', '/clients/me/addresses', {
    token: res.body.accessToken,
    body: { label: 'Casa', street: 'Calle Ficticia 100', comuna: 'Providencia' },
  });
  assert.equal(addr.status, 201);
  return { email, token: res.body.accessToken, refresh: res.body.refreshToken, id: res.body.user.id, addressId: addr.body.id };
}

async function login(email, password) {
  const res = await api('POST', '/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken;
}

const A = {}; // cliente A
const B = {}; // cliente B
let admin;

before(async () => {
  Object.assign(A, await register('Ana'));
  Object.assign(B, await register('Beto'));
  admin = await login('admin@naturalpower.test', process.env.SEED_ADMIN_PASSWORD);
});

async function createOrder(user, items, extra = {}, k = key()) {
  return api('POST', '/orders', {
    token: user.token,
    headers: { 'idempotency-key': k },
    body: { items, fulfillment: 'delivery', addressId: user.addressId, ...extra },
  });
}

async function adminProduct(id) {
  const res = await api('GET', '/admin/products?limit=50', { token: admin });
  return res.body.items.find((p) => p.id === id);
}

async function payAndApprove(user, orderId, result = 'approve') {
  const pay = await api('POST', `/orders/${orderId}/pay`, { token: user.token });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const token = pay.body.redirectUrl.split('/pay/')[1];
  const res = await fetch(`${PROVIDER}/pay/${token}/${result}`, { method: 'POST', headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.webhookDelivered, true, 'el aviso del proveedor debe entregarse al backend');
  return { providerToken: token, paymentId: pay.body.paymentId };
}

// ============================================================================
describe('Catálogo público (S: consultar catálogo)', () => {
  it('anónimo lista productos con campos públicos y sin existencias', async () => {
    const res = await api('GET', '/products');
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 10);
    const green = res.body.items.find((p) => p.id === GREEN);
    assert.equal(green.price, 4590);
    assert.equal(green.sizes.find((s) => s.code === 'small').price, 4090);
    assert.equal(green.sizes.find((s) => s.code === 'large').price, 5490);
    assert.equal(green.stock, undefined, 'el stock no es público');
    assert.equal(green.available, true);
  });

  it('filtra por texto y categoría; rechaza filtros inválidos', async () => {
    const q = await api('GET', '/products?q=green');
    assert.equal(q.body.items.length, 1);
    const cat = await api('GET', '/products?category=batido');
    assert.equal(cat.body.items.length, 3);
    assert.equal((await api('GET', '/products?category=pizza')).status, 400);
    assert.equal((await api('GET', '/products?limit=500')).status, 400);
    assert.equal((await api('GET', '/products?available=quizas')).status, 400);
  });

  it('lista combos con su composición', async () => {
    const res = await api('GET', '/combos');
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 5);
    const pareja = res.body.items.find((c) => c.id === COMBO_PAREJA);
    assert.equal(pareja.price, 10990);
    assert.ok(pareja.components.some((c) => c.requiresSelection));
  });
});

// ============================================================================
describe('Autenticación y sesión', () => {
  it('rechaza registro con correo repetido, contraseña débil o datos inválidos', async () => {
    assert.equal((await api('POST', '/auth/register', { body: { name: 'Ana', email: A.email, password: PASSWORD } })).status, 409);
    assert.equal((await api('POST', '/auth/register', { body: { name: 'X', email: `x.${run}@naturalpower.test`, password: '123' } })).status, 400);
    assert.equal((await api('POST', '/auth/register', { body: { name: 'X', email: 'no-es-correo', password: PASSWORD } })).status, 400);
  });

  it('login con credenciales erróneas da 401 genérico (sin revelar si el correo existe)', async () => {
    const a = await api('POST', '/auth/login', { body: { email: A.email, password: 'incorrecta1' } });
    const b = await api('POST', '/auth/login', { body: { email: `nadie.${run}@naturalpower.test`, password: 'incorrecta1' } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error.message, b.body.error.message);
  });

  it('el refresh token rota y su reutilización revoca la sesión', async () => {
    const first = await api('POST', '/auth/login', { body: { email: A.email, password: PASSWORD } });
    const r1 = first.body.refreshToken;
    const second = await api('POST', '/auth/refresh', { body: { refreshToken: r1 } });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.refreshToken, r1);
    const reuse = await api('POST', '/auth/refresh', { body: { refreshToken: r1 } });
    assert.equal(reuse.status, 401);
    const revoked = await api('POST', '/auth/refresh', { body: { refreshToken: second.body.refreshToken } });
    assert.equal(revoked.status, 401, 'al detectar reutilización se revocan las sesiones del usuario');
  });

  it('logout revoca el refresh token', async () => {
    const l = await api('POST', '/auth/login', { body: { email: A.email, password: PASSWORD } });
    assert.equal((await api('POST', '/auth/logout', { body: { refreshToken: l.body.refreshToken } })).status, 204);
    assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: l.body.refreshToken } })).status, 401);
  });

  it('bloquea la cuenta tras 5 intentos fallidos', async () => {
    const u = await register('Lola');
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await api('POST', '/auth/login', { body: { email: u.email, password: 'mala-clave' } })).status, 401);
    }
    const locked = await api('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
  });
});

// ============================================================================
describe('Control de acceso en el API Gateway (Prueba 1 y suplantación de cabeceras)', () => {
  it('rutas protegidas sin sesión devuelven 401', async () => {
    for (const [m, p] of [['GET', '/orders'], ['GET', '/clients/me'], ['POST', '/orders'], ['GET', '/admin/orders']]) {
      assert.equal((await api(m, p)).status, 401, `${m} ${p}`);
    }
  });

  it('token inválido o manipulado devuelve 401', async () => {
    assert.equal((await api('GET', '/clients/me', { token: 'abc.def.ghi' })).status, 401);
    const [h, p, s] = A.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin' })).toString('base64url');
    assert.equal((await api('GET', '/admin/orders', { token: `${h}.${forged}.${s}` })).status, 401);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
    assert.equal((await api('GET', '/clients/me', { token: none })).status, 401);
  });

  it('un cliente no puede usar rutas de administración (403) aunque falsee cabeceras de rol', async () => {
    const res = await api('GET', '/admin/orders', { token: A.token, headers: { 'x-user-role': 'admin', 'x-internal-token': 'x', 'x-forwarded-user': 'admin' } });
    assert.equal(res.status, 403);
    const sinSesion = await api('GET', '/orders', { headers: { 'x-user-id': A.id, 'x-user-role': 'customer' } });
    assert.equal(sinSesion.status, 401);
  });

  it('solo existen las rutas publicadas: /internal/* y verbos no listados dan 404/405', async () => {
    assert.equal((await api('GET', '/internal/me', { token: A.token })).status, 404);
    assert.equal((await api('POST', '/internal/quote', { token: A.token, body: {} })).status, 404);
    assert.equal((await api('DELETE', '/products/' + GREEN, { token: admin })).status, 405);
    const raw = await fetch(`${GW.replace('/api/v1', '')}/products`);
    assert.equal(raw.status, 404);
  });

  it('rechaza cuerpos JSON inválidos y demasiado grandes', async () => {
    assert.equal((await api('POST', '/auth/login', { raw: '{no es json' })).status, 400);
    const big = await api('POST', '/auth/login', { raw: JSON.stringify({ email: 'a@b.cl', password: 'x'.repeat(200000) }) });
    assert.equal(big.status, 413);
  });
});

// ============================================================================
describe('Acceso directo a servicios privados (Prueba 3)', () => {
  const targets = {
    inventory: [4003, 'GET', '/products'],
    orders: [4004, 'GET', '/orders'],
    clients: [4002, 'GET', '/clients/me'],
    payments: [4005, 'POST', '/internal/payments'],
    auth: [4001, 'POST', '/auth/login'],
    'graphql-gateway': [4006, 'POST', '/graphql'],
  };

  for (const [name, [port, method, path]] of Object.entries(targets)) {
    it(`${name}: sin identidad de servicio se rechaza (o el puerto no es alcanzable)`, async () => {
      const call = (headers) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(2500) });
      let spoofed;
      try {
        spoofed = await call({ 'x-user-id': A.id, 'x-user-role': 'admin' });
      } catch {
        return; // en Docker los puertos privados ni siquiera se publican
      }
      assert.equal(DIRECT, 'local');
      assert.equal(spoofed.status, 401, `${name}: cabeceras de usuario falsas sin token interno`);
      assert.equal((await call({ 'x-internal-token': 'a.b.c' })).status, 401, `${name}: token interno basura`);
      // Token con firma ajena (emitido con otra clave) tampoco sirve
      const fake = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'api-gateway', aud: name, exp: 9999999999, usr: { sub: A.id, role: 'admin' } })).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
      assert.equal((await call({ 'x-internal-token': fake })).status, 401, `${name}: token interno falsificado`);
    });
  }

  it('el gestor de secretos exige token de servicio y respeta la ACL', async () => {
    let res;
    try {
      res = await fetch('http://127.0.0.1:4100/v1/secrets/jwt-access', { signal: AbortSignal.timeout(2500) });
    } catch { return; }
    assert.equal(res.status, 401);
    const denied = await fetch('http://127.0.0.1:4100/v1/secrets/svc-orders', { headers: { authorization: `Bearer ${process.env.SM_TOKEN_INVENTORY}` } });
    assert.equal(denied.status, 403, 'inventory no puede leer el secreto de orders');
  });
});

// ============================================================================
describe('Pedidos: reglas de negocio, idempotencia y propiedad (IDOR)', () => {
  let orderA;
  const itemsA = [
    { kind: 'product', id: GREEN, size: 'medium', quantity: 2 },
    { kind: 'combo', id: COMBO_PAREJA, quantity: 1, selections: [BERRY, TROPICAL] },
  ];
  const idemKey = key();

  it('el servidor calcula precios y totales; ignora precios, total y estado del navegador', async () => {
    const stockBefore = (await adminProduct(GREEN)).stock;
    const res = await createOrder(A, itemsA.map((i) => ({ ...i, price: 1, name: 'regalo' })),
      { couponCode: 'naturalpower', total: 1, subtotal: 1, status: 'PAID', paymentStatus: 'APPROVED' }, idemKey);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    orderA = res.body;
    assert.equal(orderA.status, 'PENDING_PAYMENT');
    assert.equal(orderA.totals.subtotal, 4590 * 2 + 10990);
    assert.equal(orderA.totals.discount, Math.floor((4590 * 2 + 10990) * 0.15));
    assert.equal(orderA.totals.deliveryFee, 0, 'despacho gratis sobre $15.000');
    assert.equal(orderA.totals.total, 20170 - 3025);
    assert.equal(orderA.coupon, 'NATURALPOWER');
    assert.equal(orderA.address.comuna, 'Providencia');
    assert.equal(orderA.payment.status, 'NOT_STARTED');
    const stockAfter = (await adminProduct(GREEN)).stock;
    assert.equal(stockAfter.reserved, stockBefore.reserved + 2, 'el stock queda reservado');
  });

  it('misma clave de idempotencia y mismo cuerpo devuelve el mismo pedido (sin duplicar)', async () => {
    const again = await createOrder(A, itemsA, { couponCode: 'naturalpower' }, idemKey);
    // El cuerpo "limpio" difiere del original solo en campos ignorados, así que la huella coincide.
    assert.equal(again.status, 201);
    assert.equal(again.body.id, orderA.id);
    assert.equal(again.headers.get('idempotent-replay'), 'true');
    const list = await api('GET', '/orders', { token: A.token });
    assert.equal(list.body.items.filter((o) => o.id === orderA.id).length, 1);
  });

  it('misma clave con otro cuerpo -> 422; sin clave -> 400', async () => {
    const other = await createOrder(A, [{ kind: 'product', id: BERRY, size: 'small', quantity: 1 }], {}, idemKey);
    assert.equal(other.status, 422);
    assert.equal(other.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    const noKey = await api('POST', '/orders', { token: A.token, body: { items: itemsA, fulfillment: 'pickup' } });
    assert.equal(noKey.status, 400);
  });

  it('solicitudes concurrentes con la misma clave crean un solo pedido', async () => {
    const k = key();
    const items = [{ kind: 'product', id: BERRY, size: 'medium', quantity: 1 }];
    const results = await Promise.all([1, 2, 3, 4].map(() => createOrder(B, items, {}, k)));
    const ok = results.filter((r) => r.status === 201);
    const ids = new Set(ok.map((r) => r.body.id));
    assert.equal(ids.size, 1, 'todas las respuestas exitosas deben ser el mismo pedido');
    for (const r of results) assert.ok([201, 409].includes(r.status), `estado inesperado ${r.status}`);
    const mine = await api('GET', '/orders?limit=50', { token: B.token });
    assert.equal(mine.body.items.filter((o) => ids.has(o.id)).length, 1);
    await api('DELETE', `/orders/${[...ids][0]}`, { token: B.token });
  });

  it('valida items: tamaño inexistente, cantidad inválida, combo sin selección, producto inexistente', async () => {
    const bad = async (items) => (await createOrder(A, items)).status;
    assert.equal(await bad([{ kind: 'product', id: GREEN, size: 'gigante', quantity: 1 }]), 400);
    assert.equal(await bad([{ kind: 'product', id: GREEN, size: 'medium', quantity: 0 }]), 400);
    assert.equal(await bad([{ kind: 'product', id: SHOT, size: 'small', quantity: 1 }]), 400);
    assert.equal(await bad([{ kind: 'combo', id: COMBO_PAREJA, quantity: 1 }]), 400);
    assert.equal(await bad([{ kind: 'combo', id: COMBO_PAREJA, quantity: 1, selections: [SHOT, SHOT] }]), 400);
    assert.equal(await bad([{ kind: 'product', id: 'b0000000-0000-4000-8000-0000000000ff', size: 'medium', quantity: 1 }]), 400);
    assert.equal(await bad([]), 400);
  });

  it('cupón: inválido (422) y de primera compra ya usado (422)', async () => {
    const items = [{ kind: 'product', id: GREEN, size: 'medium', quantity: 1 }];
    assert.equal((await createOrder(B, items, { couponCode: 'FALSO' })).status, 422);
    assert.equal((await createOrder(A, items, { couponCode: 'NATURALPOWER' })).status, 422);
  });

  it('despacho: $2.500 bajo el umbral y retiro en tienda sin cargo', async () => {
    const small = [{ kind: 'product', id: SHOT, quantity: 1 }];
    const delivery = await createOrder(B, small);
    assert.equal(delivery.status, 201);
    assert.equal(delivery.body.totals.deliveryFee, 2500);
    assert.equal(delivery.body.totals.total, 1990 + 2500);
    const pickup = await api('POST', '/orders', { token: B.token, headers: { 'idempotency-key': key() }, body: { items: small, fulfillment: 'pickup' } });
    assert.equal(pickup.status, 201);
    assert.equal(pickup.body.totals.deliveryFee, 0);
    assert.equal(pickup.body.address, null);
    await api('DELETE', `/orders/${delivery.body.id}`, { token: B.token });
    await api('DELETE', `/orders/${pickup.body.id}`, { token: B.token });
  });

  it('despacho a una dirección ajena es rechazado', async () => {
    const res = await createOrder(B, [{ kind: 'product', id: SHOT, quantity: 1 }], { addressId: A.addressId });
    assert.equal(res.status, 404);
  });

  it('sin stock suficiente: 409 y no queda nada reservado ni creado', async () => {
    const p = await api('POST', '/admin/products', {
      token: admin,
      body: { name: `Producto escaso ${run}`, description: 'Producto de prueba con poco stock', category: 'jugo', price: 3000, initialStock: 1,
        nutrition: { kcal: 100, carbs: 20, sugars: 10, protein: 1, fat: 0, fiber: 1 } },
    });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const res = await createOrder(B, [{ kind: 'product', id: p.body.id, size: 'medium', quantity: 2 }]);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'OUT_OF_STOCK');
    const after = await adminProduct(p.body.id);
    assert.equal(after.stock.reserved, 0);
    assert.equal(after.stock.onHand, 1);
    await api('DELETE', `/admin/products/${p.body.id}`, { token: admin });
  });

  it('IDOR: otro cliente no puede ver, anular ni pagar el pedido de A (404, sin datos)', async () => {
    const get = await api('GET', `/orders/${orderA.id}`, { token: B.token });
    assert.equal(get.status, 404);
    assert.equal(JSON.stringify(get.body).includes(orderA.id), false);
    assert.equal((await api('DELETE', `/orders/${orderA.id}`, { token: B.token })).status, 404);
    assert.equal((await api('POST', `/orders/${orderA.id}/pay`, { token: B.token })).status, 404);
    const list = await api('GET', '/orders?limit=50', { token: B.token });
    assert.equal(list.body.items.some((o) => o.id === orderA.id), false);
    // El dueño y el administrador sí
    assert.equal((await api('GET', `/orders/${orderA.id}`, { token: A.token })).status, 200);
    const adm = await api('GET', `/orders/${orderA.id}`, { token: admin });
    assert.equal(adm.status, 200);
    assert.equal(adm.body.userId, A.id);
  });

  it('IDOR en direcciones: no se puede editar ni borrar la dirección de otro', async () => {
    assert.equal((await api('PUT', `/clients/me/addresses/${A.addressId}`, { token: B.token, body: { label: 'x', street: 'Calle 1', comuna: 'Ñuñoa' } })).status, 404);
    assert.equal((await api('DELETE', `/clients/me/addresses/${A.addressId}`, { token: B.token })).status, 404);
  });

  it('un cliente no puede cambiar estados (403) y el admin no puede fijar PAID a mano', async () => {
    assert.equal((await api('PATCH', `/admin/orders/${orderA.id}/status`, { token: A.token, body: { status: 'PAID' } })).status, 403);
    assert.equal((await api('PATCH', `/admin/orders/${orderA.id}/status`, { token: admin, body: { status: 'PAID' } })).status, 400);
    assert.equal((await api('PATCH', `/admin/orders/${orderA.id}/status`, { token: admin, body: { status: 'PREPARING' } })).status, 409, 'PENDING_PAYMENT no pasa a PREPARING');
  });

  it('anular un pedido pendiente libera el stock y conserva el historial', async () => {
    const before = (await adminProduct(BERRY)).stock.reserved;
    const o = await createOrder(B, [{ kind: 'product', id: BERRY, size: 'large', quantity: 3 }]);
    assert.equal((await adminProduct(BERRY)).stock.reserved, before + 3);
    const del = await api('DELETE', `/orders/${o.body.id}`, { token: B.token, body: { reason: 'Me equivoqué' } });
    assert.equal(del.status, 200);
    assert.equal(del.body.status, 'CANCELLED');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await adminProduct(BERRY)).stock.reserved, before, 'la reserva se liberó');
    const still = await api('GET', `/orders/${o.body.id}`, { token: B.token });
    assert.equal(still.status, 200, 'anular no borra el registro');
    assert.deepEqual(still.body.history.map((h) => h.status), ['PENDING_PAYMENT', 'CANCELLED']);
    assert.equal((await api('DELETE', `/orders/${o.body.id}`, { token: B.token })).status, 409);
  });

  it('crea 2x1 en smoothies pequeños solo martes y jueves (hora de Chile)', async () => {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Santiago' }).format(new Date());
    const res = await createOrder(B, [{ kind: 'product', id: GREEN, size: 'small', quantity: 2 }], {}, key());
    assert.equal(res.status, 201);
    const promo = day === 'Tue' || day === 'Thu';
    assert.equal(res.body.items[0].discount, promo ? 4090 : 0);
    await api('DELETE', `/orders/${res.body.id}`, { token: B.token });
  });
});

// ============================================================================
describe('Pagos: flujo completo, aviso firmado, duplicados y datos alterados (Prueba 4)', () => {
  let order;
  let pay;
  const webhook = async (payload, { secret = process.env.SECRET_PAYMENT_WEBHOOK_HMAC, signature } = {}) => {
    const raw = JSON.stringify(payload);
    const sig = signature ?? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    return api('POST', '/payments/webhook', { raw, headers: { 'x-provider-signature': sig } });
  };

  it('iniciar pago: el monto lo fija el servidor y el pago es idempotente', async () => {
    const created = await createOrder(B, [{ kind: 'product', id: GREEN, size: 'medium', quantity: 1 }]);
    order = created.body;
    const first = await api('POST', `/orders/${order.id}/pay`, { token: B.token, body: { amount: 1, total: 1, status: 'PAID' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.amount, order.totals.total, 'se ignora el monto enviado por el navegador');
    assert.match(first.body.redirectUrl, /\/pay\//);
    const second = await api('POST', `/orders/${order.id}/pay`, { token: B.token });
    assert.equal(second.body.paymentId, first.body.paymentId);
    pay = { ...first.body, token: first.body.redirectUrl.split('/pay/')[1] };
    const check = await api('GET', `/orders/${order.id}`, { token: B.token });
    assert.equal(check.body.status, 'PENDING_PAYMENT', 'iniciar el pago no marca el pedido como pagado');
  });

  it('aviso con firma inválida o ausente -> 401 y el pedido sigue pendiente', async () => {
    const payload = { eventId: `evt-${run}-1`, token: pay.token, status: 'AUTHORIZED', amount: 1, buyOrder: pay.paymentId };
    assert.equal((await webhook(payload, { signature: 'sha256=' + '0'.repeat(64) })).status, 401);
    assert.equal((await webhook(payload, { secret: 'otra-clave' })).status, 401);
    assert.equal((await api('POST', '/payments/webhook', { body: payload })).status, 401);
    assert.equal((await api('GET', `/orders/${order.id}`, { token: B.token })).body.status, 'PENDING_PAYMENT');
  });

  it('aviso firmado que afirma "pagado" pero el proveedor aún no autorizó -> no cambia el pedido', async () => {
    const forged = await webhook({ eventId: `evt-${run}-2`, token: pay.token, status: 'AUTHORIZED', amount: 99999, buyOrder: pay.paymentId });
    assert.equal(forged.status, 202, JSON.stringify(forged.body));
    assert.equal((await api('GET', `/orders/${order.id}`, { token: B.token })).body.status, 'PENDING_PAYMENT');
  });

  it('el proveedor aprueba: el pedido pasa a PAID y el stock se descuenta definitivamente', async () => {
    const before = (await adminProduct(GREEN)).stock;
    const res = await fetch(`${PROVIDER}/pay/${pay.token}/approve`, { method: 'POST', headers: { accept: 'application/json' } });
    const out = await res.json();
    assert.equal(out.webhookDelivered, true);
    const got = await api('GET', `/orders/${order.id}`, { token: B.token });
    assert.equal(got.body.status, 'PAID');
    assert.equal(got.body.payment.status, 'APPROVED');
    const after = (await adminProduct(GREEN)).stock;
    assert.equal(after.onHand, before.onHand - 1);
    assert.equal(after.reserved, before.reserved - 1);
  });

  it('avisos repetidos no se procesan dos veces', async () => {
    const evt = { eventId: `evt-${run}-3`, token: pay.token, status: 'AUTHORIZED', amount: 1, buyOrder: pay.paymentId };
    const first = await webhook(evt);
    assert.equal(first.status, 200);
    const dup = await webhook(evt);
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);
    const got = await api('GET', `/orders/${order.id}`, { token: B.token });
    assert.equal(got.body.status, 'PAID');
    assert.deepEqual(got.body.history.map((h) => h.status), ['PENDING_PAYMENT', 'PAID'], 'una sola transición a PAID');
  });

  it('un pedido pagado no se puede volver a pagar ni anular siendo cliente', async () => {
    assert.equal((await api('POST', `/orders/${order.id}/pay`, { token: B.token })).status, 409);
    assert.equal((await api('DELETE', `/orders/${order.id}`, { token: B.token })).status, 409);
  });

  it('el proveedor rechaza el pago: el pedido pasa a PAYMENT_FAILED y se libera el stock', async () => {
    const before = (await adminProduct(TROPICAL)).stock;
    const o = await createOrder(B, [{ kind: 'product', id: TROPICAL, size: 'medium', quantity: 2 }]);
    assert.equal((await adminProduct(TROPICAL)).stock.reserved, before.reserved + 2);
    await payAndApprove(B, o.body.id, 'reject');
    const got = await api('GET', `/orders/${o.body.id}`, { token: B.token });
    assert.equal(got.body.status, 'PAYMENT_FAILED');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await adminProduct(TROPICAL)).stock.reserved, before.reserved);
  });

  it('GraphQL: resumenPedido combina orders + payments + inventory', async () => {
    const res = await gql(
      `query($id: ID!) { resumenPedido(id: $id) { id status totals { total } payment { status amount currency }
         items { name quantity product { id name available nutrition { kcal } } } history { status } } }`,
      { token: B.token, variables: { id: order.id } },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.errors, undefined);
    const r = res.body.data.resumenPedido;
    assert.equal(r.status, 'PAID');
    assert.equal(r.payment.amount, order.totals.total);
    assert.equal(r.items[0].product.id, GREEN);
    assert.equal(r.items[0].product.nutrition.kcal, 180);
    assert.deepEqual(r.history.map((h) => h.status), ['PENDING_PAYMENT', 'PAID']);
  });
});

// ============================================================================
describe('Administración: estados, reembolso y catálogo', () => {
  let order;

  it('flujo de preparación y entrega con transiciones válidas', async () => {
    const created = await createOrder(A, [{ kind: 'product', id: BERRY, size: 'medium', quantity: 1 }]);
    order = created.body;
    await payAndApprove(A, order.id);
    const step = (status, reason) => api('PATCH', `/admin/orders/${order.id}/status`, { token: admin, body: { status, reason } });
    assert.equal((await step('PREPARING')).body.status, 'PREPARING');
    assert.equal((await step('DELIVERED')).status, 409, 'READY/OUT_FOR_DELIVERY son obligatorios');
    assert.equal((await step('READY')).body.status, 'READY');
    assert.equal((await step('DELIVERED')).status, 409, 'con despacho debe pasar por OUT_FOR_DELIVERY');
    assert.equal((await step('OUT_FOR_DELIVERY')).body.status, 'OUT_FOR_DELIVERY');
    assert.equal((await step('DELIVERED')).body.status, 'DELIVERED');
    assert.equal((await step('PREPARING')).status, 409, 'DELIVERED es terminal');
    const adm = await api('GET', '/admin/orders?status=DELIVERED&limit=50', { token: admin });
    assert.ok(adm.body.items.some((o) => o.id === order.id));
  });

  it('anular un pedido pagado: reembolso + stock restituido + historial intacto', async () => {
    const before = (await adminProduct(GREEN)).stock;
    const created = await createOrder(A, [{ kind: 'product', id: GREEN, size: 'medium', quantity: 3 }]);
    await payAndApprove(A, created.body.id);
    assert.equal((await adminProduct(GREEN)).stock.onHand, before.onHand - 3);
    const noReason = await api('PATCH', `/admin/orders/${created.body.id}/status`, { token: admin, body: { status: 'CANCELLED' } });
    assert.equal(noReason.status, 400, 'anular exige motivo');
    const res = await api('PATCH', `/admin/orders/${created.body.id}/status`, { token: admin, body: { status: 'CANCELLED', reason: 'Cliente solicitó anulación' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(res.body.payment.status, 'REFUNDED');
    assert.equal((await adminProduct(GREEN)).stock.onHand, before.onHand, 'las 3 unidades volvieron al stock');
    const hist = (await api('GET', `/orders/${created.body.id}`, { token: admin })).body.history;
    assert.deepEqual(hist.map((h) => h.status), ['PENDING_PAYMENT', 'PAID', 'CANCELLED']);
    assert.equal(hist[2].reason, 'Cliente solicitó anulación');
  });

  it('CRUD de productos: crear, reemplazar, ajustar stock y desactivar (no borra)', async () => {
    const body = { name: `Jugo Prueba ${run}`, description: 'Jugo creado por la prueba automatizada', category: 'jugo', price: 3500, initialStock: 5,
      nutrition: { kcal: 100, carbs: 20, sugars: 10, protein: 1, fat: 0, fiber: 1 } };
    const created = await api('POST', '/admin/products', { token: admin, body });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await api('POST', '/admin/products', { token: admin, body })).status, 409, 'nombre repetido');
    assert.equal((await api('POST', '/admin/products', { token: A.token, body })).status, 403);
    const put = await api('PUT', `/admin/products/${id}`, { token: admin, body: { ...body, price: 3900 } });
    assert.equal(put.body.price, 3900);
    assert.equal((await api('PATCH', `/admin/products/${id}/stock`, { token: admin, body: { onHand: 12 } })).body.stock.onHand, 12);
    assert.equal((await api('PATCH', `/admin/products/${id}/stock`, { token: admin, body: { onHand: -1 } })).status, 400);
    assert.equal((await api('GET', `/products/${id}`)).status, 200);
    assert.equal((await api('DELETE', `/admin/products/${id}`, { token: admin })).status, 204);
    assert.equal((await api('GET', `/products/${id}`)).status, 404, 'ya no es público');
    assert.ok((await adminProduct(id)), 'pero el registro sigue existiendo para el historial');
  });

  it('formulario de contacto: público; la lectura es solo de administradores', async () => {
    const msg = await api('POST', '/contact', { body: { name: 'Visitante', email: 'visita@naturalpower.test', message: 'Hola, ¿tienen opciones sin azúcar?' } });
    assert.equal(msg.status, 201);
    assert.equal((await api('POST', '/contact', { body: { name: 'V', email: 'mal', message: 'x' } })).status, 400);
    assert.equal((await api('GET', '/admin/contact-messages', { token: A.token })).status, 403);
    const list = await api('GET', '/admin/contact-messages?status=new', { token: admin });
    assert.ok(list.body.items.some((m) => m.id === msg.body.id));
    assert.equal((await api('PATCH', `/admin/contact-messages/${msg.body.id}`, { token: admin, body: { status: 'read' } })).body.status, 'read');
  });
});

// ============================================================================
describe('Perfil y datos personales', () => {
  it('cada cliente ve solo su perfil y no recibe credenciales', async () => {
    const me = await api('GET', '/clients/me', { token: A.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.id, A.id);
    const text = JSON.stringify(me.body).toLowerCase();
    assert.equal(text.includes('password'), false);
    assert.equal(text.includes('hash'), false);
  });

  it('eliminar la cuenta anonimiza el perfil, borra direcciones y bloquea el acceso', async () => {
    const u = await register('Temp');
    const del = await api('DELETE', '/clients/me', { token: u.token });
    assert.equal(del.status, 204);
    assert.equal((await api('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } })).status, 401);
    assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: u.refresh } })).status, 401);
  });
});

// ============================================================================
describe('GraphQL Gateway: autorización por campo y límites', () => {
  it('catálogo paginado es público y devuelve datos agregados', async () => {
    const res = await gql('{ catalog(first: 3, category: SMOOTHIE) { nodes { id name category price sizes { code price } } page { total hasMore } } }');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.catalog.nodes.length, 3);
    assert.equal(res.body.data.catalog.nodes[0].category, 'SMOOTHIE');
    assert.equal(res.body.data.catalog.page.total, 3);
  });

  it('operaciones protegidas sin sesión -> 401', async () => {
    const res = await gql('{ misPedidos { nodes { id } } }');
    assert.equal(res.status, 401);
    assert.equal(res.body.errors[0].extensions.code, 'UNAUTHENTICATED');
  });

  it('un cliente no puede pedir campos de administración (403, la consulta no se ejecuta)', async () => {
    const stock = await gql('{ catalog(first: 2) { nodes { name stock { onHand } } } }', { token: A.token });
    assert.equal(stock.status, 403);
    assert.equal(stock.body.data, undefined);
    const admin1 = await gql('{ pedidosAdmin { nodes { id } } }', { token: A.token });
    assert.equal(admin1.status, 403);
    const ref = await gql('query($id: ID!) { resumenPedido(id: $id) { payment { providerRef } } }', { token: A.token, variables: { id: crypto.randomUUID() } });
    assert.equal(ref.status, 403);
    const asAdmin = await gql('{ catalog(first: 2) { nodes { name stock { onHand reserved free } } } }', { token: admin });
    assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
    assert.ok(asAdmin.body.data.catalog.nodes[0].stock.onHand >= 0);
  });

  it('un pedido ajeno no se puede consultar ni anular por GraphQL', async () => {
    const mine = await api('GET', '/orders?limit=1', { token: A.token });
    const id = mine.body.items[0].id;
    const res = await gql('query($id: ID!) { resumenPedido(id: $id) { id } }', { token: B.token, variables: { id } });
    assert.equal(res.body.data.resumenPedido, null);
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND');
    const mut = await gql('mutation($id: ID!) { anularPedido(id: $id) { id status } }', { token: B.token, variables: { id } });
    assert.equal(mut.body.errors[0].extensions.code, 'NOT_FOUND');
  });

  it('misPedidos devuelve solo los pedidos del usuario, con productos resueltos por lote', async () => {
    const res = await gql('{ misPedidos(first: 5) { nodes { id status items { name product { name } } } page { total } } }', { token: A.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.misPedidos.nodes.length > 0);
    const mine = await api('GET', '/orders?limit=50', { token: A.token });
    assert.equal(res.body.data.misPedidos.page.total, mine.body.page.total);
  });

  it('anularPedido: el cliente anula uno pendiente; uno pagado se rechaza', async () => {
    const o = await createOrder(B, [{ kind: 'product', id: SHOT, quantity: 1 }]);
    const ok = await gql('mutation($id: ID!) { anularPedido(id: $id, reason: "Cambio de planes") { status } }', { token: B.token, variables: { id: o.body.id } });
    assert.equal(ok.body.data.anularPedido.status, 'CANCELLED');
    const paid = (await api('GET', '/orders?status=PAID&limit=1', { token: B.token })).body.items[0];
    const no = await gql('mutation($id: ID!) { anularPedido(id: $id) { status } }', { token: B.token, variables: { id: paid.id } });
    assert.equal(no.body.errors[0].extensions.code, 'ORDER_NOT_CANCELLABLE');
  });

  it('límite de profundidad: consultas anidadas en exceso se rechazan', async () => {
    let inner = 'id';
    for (let i = 0; i < 8; i += 1) inner = `relacionados(first: 1) { ${inner} }`;
    const res = await gql(`{ catalog(first: 1) { nodes { ${inner} } } }`);
    assert.equal(res.status, 400);
    assert.equal(res.body.errors[0].extensions.code, 'QUERY_TOO_DEEP');
  });

  it('límite de costo: pedir demasiado de una vez se rechaza', async () => {
    const res = await gql(`{ catalog(first: 50) { nodes { id name slug description category price image badge available
      sizes { code label volumeMl price } nutrition { kcal carbs sugars protein fat fiber }
      relacionados(first: 10) { id name sizes { code price } nutrition { kcal } } } } }`);
    assert.equal(res.status, 400);
    assert.equal(res.body.errors[0].extensions.code, 'QUERY_TOO_COMPLEX');
  });

  it('paginación acotada: first > 50 se rechaza', async () => {
    const res = await gql('{ catalog(first: 500) { nodes { id } } }');
    assert.equal(res.body.errors[0].extensions.code, 'VALIDATION_ERROR');
  });

  it('introspección deshabilitada y consultas malformadas rechazadas', async () => {
    assert.equal((await gql('{ __schema { types { name } } }')).status, 400);
    assert.equal((await gql('{ catalog(first: 1) { nodes { campoInexistente } } }')).status, 400);
    assert.equal((await gql('{ catalog(')).status, 400);
    assert.equal((await api('POST', '/graphql', { body: {} })).status, 400);
  });
});

// ============================================================================
describe('Límite de solicitudes (opcional: E2E_RATELIMIT=1; deja la IP limitada ~1 min)', { skip: process.env.E2E_RATELIMIT !== '1' }, () => {
  it('login repetido termina en 429 con Retry-After', async () => {
    let limited;
    for (let i = 0; i < 120 && !limited; i += 1) {
      const r = await api('POST', '/auth/login', { body: { email: `spam${i}.${run}@naturalpower.test`, password: 'x'.repeat(8) } });
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'debió responder 429');
    assert.ok(limited.headers.get('retry-after'));
  });
});
