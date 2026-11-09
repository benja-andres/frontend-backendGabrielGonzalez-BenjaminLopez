import fs from 'node:fs';
import {
  buildSchema, parse, validate, execute, specifiedRules, NoSchemaIntrospectionCustomRule, GraphQLError,
} from 'graphql';
import { createApp, reply } from '../../lib/http.js';
import { createSecretClient } from '../../lib/secrets.js';
import { createServiceClient } from '../../lib/client.js';
import { PORTS, intEnv } from '../../lib/config.js';
import { HttpError } from '../../lib/errors.js';
import { fieldPolicyRule, documentDepth, documentCost } from './rules.js';
import { resolvers, createLoaders } from './resolvers.js';

// GraphQL Gateway PRIVADO: solo lo llama el API Gateway (token interno). Agrega datos de varios
// subsistemas y nunca toca sus bases. Protecciones: identidad propagada, autorización por campo,
// límite de profundidad y costo, tamaño de consulta, paginación acotada, plazo total y errores parciales.

const MAX_DEPTH = intEnv('GRAPHQL_MAX_DEPTH', 7);
const MAX_COST = intEnv('GRAPHQL_MAX_COST', 2000);
const MAX_QUERY_CHARS = 10000;
const TIMEOUT_MS = intEnv('GRAPHQL_TIMEOUT_MS', 10000);
const INTROSPECTION = process.env.GRAPHQL_INTROSPECTION === 'true';

const secrets = createSecretClient();
const call = createServiceClient({ service: 'graphql-gateway', secrets });
const app = createApp({ service: 'graphql-gateway', secrets, defaultIssuers: ['api-gateway'] });

const schema = buildSchema(fs.readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8'));
for (const [typeName, fields] of Object.entries(resolvers)) {
  const type = schema.getType(typeName);
  for (const [fieldName, fn] of Object.entries(fields)) type.getFields()[fieldName].resolve = fn;
}

function formatError(err) {
  const original = err.originalError;
  if (original instanceof HttpError) {
    return { message: original.message, path: err.path, extensions: { code: original.code, status: original.status } };
  }
  if (original) {
    app.log.error('error en resolver', { error: original.message });
    return { message: 'Error interno', path: err.path, extensions: { code: 'INTERNAL_ERROR' } };
  }
  return { message: err.message, path: err.path, locations: err.locations, extensions: err.extensions };
}

const statusFor = (errors) => {
  const codes = errors.map((e) => e.extensions?.code);
  if (codes.includes('UNAUTHENTICATED')) return 401;
  if (codes.includes('FORBIDDEN')) return 403;
  return 400;
};

app.post('/graphql', { maxBody: 32768 }, async (ctx) => {
  const body = ctx.body;
  if (!body || typeof body.query !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'Falta el campo query');
  if (body.query.length > MAX_QUERY_CHARS) throw new HttpError(413, 'QUERY_TOO_LARGE', 'La consulta es demasiado larga');
  if (body.variables !== undefined && (typeof body.variables !== 'object' || body.variables === null || Array.isArray(body.variables))) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'variables debe ser un objeto');
  }

  let document;
  try {
    document = parse(body.query);
  } catch (err) {
    return reply(400, { errors: [{ message: err.message, locations: err.locations, extensions: { code: 'GRAPHQL_PARSE_FAILED' } }] });
  }

  const rules = [...specifiedRules, fieldPolicyRule(ctx.user)];
  if (!INTROSPECTION) rules.push(NoSchemaIntrospectionCustomRule);
  const invalid = validate(schema, document, rules);
  if (invalid.length) {
    const errors = invalid.map(formatError);
    return reply(statusFor(errors), { errors });
  }

  const depth = documentDepth(document);
  if (depth > MAX_DEPTH) {
    return reply(400, { errors: [{ message: `Profundidad ${depth} supera el máximo de ${MAX_DEPTH}`, extensions: { code: 'QUERY_TOO_DEEP' } }] });
  }
  const cost = documentCost(schema, document, body.variables);
  if (cost > MAX_COST) {
    return reply(400, { errors: [{ message: `Costo ${cost} supera el máximo de ${MAX_COST}`, extensions: { code: 'QUERY_TOO_COMPLEX' } }] });
  }

  const contextValue = { user: ctx.user, cid: ctx.cid, call, loaders: createLoaders(call, ctx.user, ctx.cid) };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GraphQLError('La consulta excedió el plazo máximo', { extensions: { code: 'TIMEOUT' } })), TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      execute({ schema, document, variableValues: body.variables, operationName: body.operationName, contextValue }),
      timeout,
    ]);
    const out = { data: result.data ?? null };
    if (result.errors?.length) out.errors = result.errors.map(formatError);
    return reply(200, out);
  } catch (err) {
    if (err?.extensions?.code === 'TIMEOUT') return reply(504, { errors: [formatError(err)] });
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

await app.start(PORTS['graphql-gateway']);
