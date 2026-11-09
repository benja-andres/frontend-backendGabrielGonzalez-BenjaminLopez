-- dbClients: perfil, direcciones y mensajes de contacto. El id del cliente es el id de identidad (sub).
CREATE TABLE clients (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  name        TEXT NOT NULL,
  phone       TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE addresses (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  street      TEXT NOT NULL,
  comuna      TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT 'Región Metropolitana',
  notes       TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_addresses_client ON addresses(client_id);

CREATE TABLE contact_messages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  message     TEXT NOT NULL,
  client_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'answered')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
