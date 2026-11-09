import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Persistencia real: un archivo SQLite por servicio (base propia, nadie más la abre).
// Esquema versionado por migraciones SQL; los datos de prueba (seeds) son scripts SQL aparte.

export function openDb(name, { dataDir = process.env.DATA_DIR || './data' } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, `${name}.db`));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function applyScripts(db, dir, table) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  if (!fs.existsSync(dir)) return [];
  const done = new Set(db.prepare(`SELECT name FROM ${table}`).all().map((r) => r.name));
  const applied = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(file);
      db.exec('COMMIT');
      applied.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Falló ${table}/${file}: ${err.message}`);
    }
  }
  return applied;
}

export const migrate = (db, dir) => applyScripts(db, dir, 'schema_migrations');

/** Datos ficticios de prueba. Se desactivan con SEED_ON_BOOT=false. */
export function seed(db, dir) {
  if (process.env.SEED_ON_BOOT === 'false') return [];
  return applyScripts(db, dir, 'seed_history');
}

/** Transacción inmediata (la API de SQLite es síncrona, así que el bloque es atómico). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
