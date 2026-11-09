-- dbOrders: pedidos, historial de estados, idempotencia y cupones. Autoridad sobre estados y totales.
CREATE TABLE coupons (
  code                 TEXT PRIMARY KEY,
  percent              INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
  first_purchase_only  INTEGER NOT NULL DEFAULT 0 CHECK (first_purchase_only IN (0, 1)),
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  starts_at            TEXT,
  ends_at              TEXT
);

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('PENDING_PAYMENT','PAID','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED',
                      'PAYMENT_FAILED','EXPIRED','CANCELLED')),
  fulfillment      TEXT NOT NULL CHECK (fulfillment IN ('delivery', 'pickup')),
  subtotal         INTEGER NOT NULL,
  discount_total   INTEGER NOT NULL,
  delivery_fee     INTEGER NOT NULL,
  total            INTEGER NOT NULL CHECK (total >= 0),
  currency         TEXT NOT NULL DEFAULT 'CLP',
  coupon_code      TEXT,
  contact_name     TEXT,
  contact_phone    TEXT,
  address_snapshot TEXT,                       -- JSON: instantánea de la dirección al comprar
  notes            TEXT,
  payment_id       TEXT,
  payment_status   TEXT,
  cancel_reason    TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status, expires_at);

CREATE TABLE order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  kind        TEXT NOT NULL CHECK (kind IN ('product', 'combo')),
  ref_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  size        TEXT,
  size_label  TEXT,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  unit_price  INTEGER NOT NULL,
  line_total  INTEGER NOT NULL,
  discount    INTEGER NOT NULL DEFAULT 0,
  promo       TEXT,
  components  TEXT NOT NULL
);
CREATE INDEX idx_items_order ON order_items(order_id);

-- Historial inmutable: anular un pedido NUNCA borra filas.
CREATE TABLE order_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,                   -- sub del usuario o nombre de servicio
  actor_role  TEXT NOT NULL,
  reason      TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_history_order ON order_status_history(order_id);

-- Control de idempotencia de la creación de pedidos (clave por usuario).
CREATE TABLE idempotency_keys (
  user_id          TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
  response_status  INTEGER,
  response_body    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, key)
);
