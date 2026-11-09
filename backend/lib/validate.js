import { badRequest } from './errors.js';

// Validación de entradas. Acumula errores por campo y los devuelve juntos.

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export class Validator {
  constructor(input) {
    this.input = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    this.errors = [];
    if (!this.input) this.errors.push({ field: '(body)', message: 'Se esperaba un objeto JSON' });
  }

  _fail(field, message) {
    this.errors.push({ field, message });
    return undefined;
  }

  _raw(field) {
    return this.input ? this.input[field] : undefined;
  }

  string(field, { min = 0, max = 255, required = true, pattern, patternMessage } = {}) {
    const v = this._raw(field);
    if (v === undefined || v === null || v === '') {
      return required ? this._fail(field, 'Es obligatorio') : undefined;
    }
    if (typeof v !== 'string') return this._fail(field, 'Debe ser texto');
    const s = v.trim();
    if (s.length < min) return this._fail(field, `Debe tener al menos ${min} caracteres`);
    if (s.length > max) return this._fail(field, `Debe tener como máximo ${max} caracteres`);
    if (pattern && !pattern.test(s)) return this._fail(field, patternMessage || 'Formato inválido');
    return s;
  }

  email(field, { required = true } = {}) {
    const s = this.string(field, { required, max: 254 });
    if (s === undefined) return undefined;
    if (!EMAIL.test(s)) return this._fail(field, 'Correo electrónico inválido');
    return s.toLowerCase();
  }

  int(field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
    const v = this._raw(field);
    if (v === undefined || v === null) return required ? this._fail(field, 'Es obligatorio') : undefined;
    if (!Number.isInteger(v)) return this._fail(field, 'Debe ser un número entero');
    if (v < min || v > max) return this._fail(field, `Debe estar entre ${min} y ${max}`);
    return v;
  }

  bool(field, { required = false } = {}) {
    const v = this._raw(field);
    if (v === undefined || v === null) return required ? this._fail(field, 'Es obligatorio') : undefined;
    if (typeof v !== 'boolean') return this._fail(field, 'Debe ser verdadero o falso');
    return v;
  }

  oneOf(field, values, { required = true } = {}) {
    const v = this._raw(field);
    if (v === undefined || v === null || v === '') {
      return required ? this._fail(field, 'Es obligatorio') : undefined;
    }
    if (!values.includes(v)) return this._fail(field, `Valor permitido: ${values.join(', ')}`);
    return v;
  }

  uuid(field, { required = true } = {}) {
    const v = this._raw(field);
    if (v === undefined || v === null || v === '') return required ? this._fail(field, 'Es obligatorio') : undefined;
    if (!isUuid(v)) return this._fail(field, 'Identificador inválido');
    return v;
  }

  array(field, { min = 0, max = 100, required = true } = {}) {
    const v = this._raw(field);
    if (v === undefined || v === null) return required ? this._fail(field, 'Es obligatorio') : undefined;
    if (!Array.isArray(v)) return this._fail(field, 'Debe ser una lista');
    if (v.length < min || v.length > max) return this._fail(field, `Debe tener entre ${min} y ${max} elementos`);
    return v;
  }

  done() {
    if (this.errors.length) throw badRequest('Datos inválidos', this.errors);
  }
}

/** Paginación acotada: limit (1..max) y offset (>=0). */
export function pagination(query, { defaultLimit = 20, maxLimit = 50 } = {}) {
  const parse = (raw, fallback, min, max, field) => {
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw))) throw badRequest(`Parámetro ${field} inválido`);
    const n = Number(raw);
    if (n < min || n > max) throw badRequest(`Parámetro ${field} fuera de rango (${min}-${max})`);
    return n;
  };
  return {
    limit: parse(query.limit, defaultLimit, 1, maxLimit, 'limit'),
    offset: parse(query.offset, 0, 0, 100000, 'offset'),
  };
}
