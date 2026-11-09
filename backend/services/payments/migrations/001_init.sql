-- dbPayments: pagos, eventos del proveedor (deduplicación) y trazabilidad. No guarda datos de tarjeta.
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL DEFAULT 'CLP',
  status          TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED')),
  provider_token  TEXT NOT NULL UNIQUE,         -- token de transacción del proveedor (no es un secreto de comercio)
  redirect_url    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_at     TEXT,
  refunded_at     TEXT
);
-- Un solo pago "vivo" por pedido.
CREATE UNIQUE INDEX uq_payment_active_order ON payments(order_id) WHERE status IN ('PENDING', 'APPROVED');

-- Una notificación del proveedor se procesa una sola vez, aunque llegue repetida.
CREATE TABLE webhook_events (
  event_id     TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
