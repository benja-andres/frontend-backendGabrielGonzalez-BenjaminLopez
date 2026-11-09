import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { createServiceClient } from '../../lib/client.js';
import { openDb, migrate, seed, tx, nowIso } from '../../lib/db.js';
import { PORTS } from '../../lib/config.js';
import { notFound, HttpError } from '../../lib/errors.js';
import { Validator, pagination } from '../../lib/validate.js';

// Clients: perfil, direcciones y mensajes de contacto. Autoridad de los datos personales.
// Regla de propiedad: un cliente solo accede a SU registro (id == sub del token verificado).

const secrets = createSecretClient();
const call = createServiceClient({ service: 'clients', secrets });
const app = createApp({ service: 'clients', secrets, defaultIssuers: ['api-gateway'] });
const db = openDb('clients');
migrate(db, fileURLToPath(new URL('./migrations', import.meta.url)));
seed(db, fileURLToPath(new URL('./seeds', import.meta.url)));

const ANY = ['customer', 'admin'];
const PHONE_RE = /^[0-9+()\-\s]{6,20}$/;

const profileDto = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, createdAt: c.created_at });
const addressDto = (a) => ({
  id: a.id,
  label: a.label,
  street: a.street,
  comuna: a.comuna,
  region: a.region,
  notes: a.notes,
  isDefault: a.is_default === 1,
});

function getProfile(id) {
  const c = db.prepare("SELECT * FROM clients WHERE id = ? AND status = 'active'").get(id);
  if (!c) throw notFound('Perfil no encontrado');
  return c;
}

function readAddressInput(body, { partial = false } = {}) {
  const v = new Validator(body);
  const label = v.string('label', { min: 1, max: 30 });
  const street = v.string('street', { min: 3, max: 120 });
  const comuna = v.string('comuna', { min: 2, max: 60 });
  const region = v.string('region', { max: 60, required: false });
  const notes = v.string('notes', { max: 200, required: false });
  const isDefault = v.bool('isDefault');
  v.done();
  return { label, street, comuna, region: region || 'Región Metropolitana', notes: notes ?? null, isDefault: Boolean(isDefault), partial };
}

// ---- Interno: creación del perfil al registrarse (solo Auth) ----
app.post('/internal/clients', { issuers: ['auth'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const id = v.uuid('id');
  const name = v.string('name', { min: 1, max: 60 });
  const email = v.email('email');
  v.done();
  db.prepare('INSERT INTO clients (id, email, name) VALUES (?, ?, ?)').run(id, email, name);
  return reply(201, { id });
});

// ---- Interno: orders resuelve (y valida propiedad de) una dirección para el pedido ----
app.get('/internal/clients/:clientId/addresses/:addressId', { issuers: ['orders'], roles: ANY }, (ctx) => {
  // El token lleva al usuario verificado: solo su dueño (o un admin) puede usarla.
  if (ctx.user.role !== 'admin' && ctx.user.sub !== ctx.params.clientId) throw notFound('Dirección no encontrada');
  const a = db.prepare('SELECT * FROM addresses WHERE id = ? AND client_id = ?').get(ctx.params.addressId, ctx.params.clientId);
  if (!a) throw notFound('Dirección no encontrada');
  const c = db.prepare('SELECT name, phone FROM clients WHERE id = ?').get(ctx.params.clientId);
  return { address: addressDto(a), contact: { name: c?.name, phone: c?.phone } };
});

// ---- Interno: GraphQL resuelve el perfil del usuario autenticado ----
app.get('/internal/me', { issuers: ['graphql-gateway'], roles: ANY }, (ctx) => ({
  ...profileDto(getProfile(ctx.user.sub)),
  addresses: db.prepare('SELECT * FROM addresses WHERE client_id = ? ORDER BY is_default DESC, created_at').all(ctx.user.sub).map(addressDto),
}));

// ---- Perfil propio ----
app.get('/clients/me', { roles: ANY }, (ctx) => profileDto(getProfile(ctx.user.sub)));

app.put('/clients/me', { roles: ANY }, (ctx) => {
  const v = new Validator(ctx.body);
  const name = v.string('name', { min: 1, max: 60 });
  const phone = v.string('phone', { max: 20, required: false, pattern: PHONE_RE, patternMessage: 'Teléfono inválido' });
  v.done();
  getProfile(ctx.user.sub);
  db.prepare('UPDATE clients SET name = ?, phone = ?, updated_at = ? WHERE id = ?').run(name, phone ?? null, nowIso(), ctx.user.sub);
  return profileDto(getProfile(ctx.user.sub));
});

// Eliminación de cuenta: se anonimiza el perfil, se borran las direcciones y se deshabilita la identidad.
// Los pedidos conservan su historial contable (con instantánea de entrega) en el servicio orders.
app.delete('/clients/me', { roles: ['customer'] }, async (ctx) => {
  getProfile(ctx.user.sub);
  await call('auth', 'POST', `/internal/users/${ctx.user.sub}/disable`, { cid: ctx.cid });
  tx(db, () => {
    db.prepare('DELETE FROM addresses WHERE client_id = ?').run(ctx.user.sub);
    db.prepare("UPDATE clients SET name = 'Cliente eliminado', email = NULL, phone = NULL, status = 'deleted', updated_at = ? WHERE id = ?").run(nowIso(), ctx.user.sub);
  });
  return undefined;
});

// ---- Direcciones ----
app.get('/clients/me/addresses', { roles: ANY }, (ctx) => ({
  items: db.prepare('SELECT * FROM addresses WHERE client_id = ? ORDER BY is_default DESC, created_at').all(ctx.user.sub).map(addressDto),
}));

function saveAddress(clientId, id, input) {
  return tx(db, () => {
    if (id) {
      db.prepare('UPDATE addresses SET label=?, street=?, comuna=?, region=?, notes=?, is_default=? WHERE id=? AND client_id=?').run(
        input.label, input.street, input.comuna, input.region, input.notes, input.isDefault ? 1 : 0, id, clientId,
      );
    } else {
      const count = db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE client_id = ?').get(clientId).n;
      if (count >= 10) throw new HttpError(409, 'ADDRESS_LIMIT', 'Máximo 10 direcciones');
      id = crypto.randomUUID();
      const makeDefault = input.isDefault || count === 0;
      db.prepare('INSERT INTO addresses (id, client_id, label, street, comuna, region, notes, is_default) VALUES (?,?,?,?,?,?,?,?)').run(
        id, clientId, input.label, input.street, input.comuna, input.region, input.notes, makeDefault ? 1 : 0,
      );
      input.isDefault = makeDefault;
    }
    if (input.isDefault) db.prepare('UPDATE addresses SET is_default = 0 WHERE client_id = ? AND id <> ?').run(clientId, id);
    return db.prepare('SELECT * FROM addresses WHERE id = ?').get(id);
  });
}

app.post('/clients/me/addresses', { roles: ANY }, (ctx) => {
  getProfile(ctx.user.sub);
  return reply(201, addressDto(saveAddress(ctx.user.sub, null, readAddressInput(ctx.body))));
});

app.put('/clients/me/addresses/:id', { roles: ANY }, (ctx) => {
  // Propiedad: la consulta incluye client_id = sub; una dirección ajena es "no encontrada".
  const own = db.prepare('SELECT 1 FROM addresses WHERE id = ? AND client_id = ?').get(ctx.params.id, ctx.user.sub);
  if (!own) throw notFound('Dirección no encontrada');
  return addressDto(saveAddress(ctx.user.sub, ctx.params.id, readAddressInput(ctx.body)));
});

app.delete('/clients/me/addresses/:id', { roles: ANY }, (ctx) => {
  const r = db.prepare('DELETE FROM addresses WHERE id = ? AND client_id = ?').run(ctx.params.id, ctx.user.sub);
  if (r.changes === 0) throw notFound('Dirección no encontrada');
  return undefined;
});

// ---- Contacto (formulario público del sitio) ----
app.post('/contact', {}, (ctx) => {
  const v = new Validator(ctx.body);
  const name = v.string('name', { min: 1, max: 80 });
  const email = v.email('email');
  const message = v.string('message', { min: 5, max: 1000 });
  v.done();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO contact_messages (id, name, email, message, client_id) VALUES (?,?,?,?,?)').run(
    id, name, email, message, ctx.user?.sub ?? null,
  );
  return reply(201, { id, status: 'new' });
});

// ---- Administración ----
app.get('/admin/contact-messages', { roles: ['admin'] }, (ctx) => {
  const { limit, offset } = pagination(ctx.query);
  const status = ctx.query.status;
  if (status && !['new', 'read', 'answered'].includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Estado inválido');
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contact_messages ${where}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM contact_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { items: items.map((m) => ({ id: m.id, name: m.name, email: m.email, message: m.message, status: m.status, createdAt: m.created_at })), page: { limit, offset, total } };
});

app.patch('/admin/contact-messages/:id', { roles: ['admin'] }, (ctx) => {
  const v = new Validator(ctx.body);
  const status = v.oneOf('status', ['new', 'read', 'answered']);
  v.done();
  const r = db.prepare('UPDATE contact_messages SET status = ? WHERE id = ?').run(status, ctx.params.id);
  if (r.changes === 0) throw notFound('Mensaje no encontrado');
  return { id: ctx.params.id, status };
});

app.get('/admin/clients', { roles: ['admin'] }, (ctx) => {
  const { limit, offset } = pagination(ctx.query);
  const total = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE status = 'active'").get().n;
  const items = db.prepare("SELECT * FROM clients WHERE status = 'active' ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  return { items: items.map(profileDto), page: { limit, offset, total } };
});

await app.start(PORTS.clients, { onStop: () => db.close() });
