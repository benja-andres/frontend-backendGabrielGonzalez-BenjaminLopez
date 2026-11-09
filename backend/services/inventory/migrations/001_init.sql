-- dbInventory: catálogo, combos, stock y reservas. Autoridad sobre precios y disponibilidad.
CREATE TABLE sizes (
  code              TEXT PRIMARY KEY CHECK (code IN ('small', 'medium', 'large', 'fixed')),
  label             TEXT NOT NULL,
  volume_ml         INTEGER NOT NULL,
  price_delta       INTEGER NOT NULL,           -- CLP respecto del precio base (tamaño mediano)
  nutrition_factor  REAL NOT NULL
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('smoothie', 'jugo', 'batido', 'shot')),
  base_price    INTEGER NOT NULL CHECK (base_price > 0),   -- precio del tamaño mediano (o del shot)
  fixed_size    INTEGER NOT NULL DEFAULT 0 CHECK (fixed_size IN (0, 1)),
  image_url     TEXT,
  badge         TEXT,
  search_terms  TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  kcal          INTEGER NOT NULL,
  carbs         INTEGER NOT NULL,
  sugars        INTEGER NOT NULL,
  protein       INTEGER NOT NULL,
  fat           INTEGER NOT NULL,
  fiber         INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE stock (
  product_id  TEXT PRIMARY KEY REFERENCES products(id),
  on_hand     INTEGER NOT NULL CHECK (on_hand >= 0),      -- unidades físicas disponibles (1 bebida = 1 unidad)
  reserved    INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= on_hand)
);

CREATE TABLE combos (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price > 0),
  badge       TEXT,
  image_url   TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Un componente es un producto fijo o una "elección" dentro de una categoría.
CREATE TABLE combo_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_id    TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  product_id  TEXT REFERENCES products(id),
  category    TEXT CHECK (category IN ('smoothie', 'jugo', 'batido', 'shot')),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  CHECK ((product_id IS NOT NULL) <> (category IS NOT NULL))
);

CREATE TABLE reservations (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  product_id  TEXT NOT NULL REFERENCES products(id),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  status      TEXT NOT NULL CHECK (status IN ('held', 'committed', 'released', 'restocked')),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (order_id, product_id)
);
CREATE INDEX idx_reservations_status ON reservations(status, expires_at);
