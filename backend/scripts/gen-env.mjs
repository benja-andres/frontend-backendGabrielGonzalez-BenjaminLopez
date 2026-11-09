import crypto from 'node:crypto';
import fs from 'node:fs';

// Crea .env a partir de .env.example reemplazando cada CHANGE_ME por un valor aleatorio.
// No sobrescribe un .env existente salvo con --force.

const target = new URL('../.env', import.meta.url);
if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log('.env ya existe: no se modifica (usa --force para regenerarlo).');
  process.exit(0);
}
const template = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const out = template.replace(/CHANGE_ME/g, () => crypto.randomBytes(24).toString('base64url'));
fs.writeFileSync(target, out, { mode: 0o600 });
console.log('.env generado con secretos aleatorios (permisos 600).');
