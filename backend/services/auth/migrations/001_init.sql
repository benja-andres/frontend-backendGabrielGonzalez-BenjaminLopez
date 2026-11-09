-- dbIdentity: identidades y sesiones. Solo el Auth Service accede a esta base.
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                      -- scrypt con sal por usuario; nunca se devuelve
  role            TEXT NOT NULL CHECK (role IN ('customer', 'admin')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE refresh_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                  -- sha256 del token; el token en claro no se guarda
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  replaced_by  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
