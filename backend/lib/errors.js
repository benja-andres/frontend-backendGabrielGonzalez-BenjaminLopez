export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Autenticación requerida') => new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'No tienes permiso para esta operación') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Recurso no encontrado') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code, message, details) => new HttpError(409, code, message, details);

/** Respuesta con estado y cabeceras explícitas. */
export class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
export const reply = (status, body, headers) => new Reply(status, body, headers);
