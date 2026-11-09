import { GraphQLError, Kind, getNamedType, isCompositeType, isListType, isNonNullType } from 'graphql';

// Políticas de seguridad de GraphQL:
//  1) Autorización por operación y por CAMPO, evaluada ANTES de ejecutar (si el rol no alcanza,
//     la consulta completa se rechaza: no hay forma de "pedir" un campo prohibido).
//  2) Límite de profundidad.
//  3) Límite de costo/complejidad (las listas multiplican por su tamaño solicitado).

export const FIELD_POLICY = {
  'Query.resumenPedido': ['customer', 'admin'],
  'Query.misPedidos': ['customer'],
  'Query.me': ['customer', 'admin'],
  'Query.pedidosAdmin': ['admin'],
  'Mutation.anularPedido': ['customer', 'admin'],
  'Product.stock': ['admin'],
  'Order.userId': ['admin'],
  'Order.cancelReason': ['admin'],
  'Payment.providerRef': ['admin'],
  'StatusChange.actor': ['admin'],
  'StatusChange.actorRole': ['admin'],
  'StatusChange.reason': ['admin'],
};

export function fieldPolicyRule(user) {
  return (context) => ({
    Field(node) {
      const parent = context.getParentType();
      if (!parent) return;
      const key = `${parent.name}.${node.name.value}`;
      const allowed = FIELD_POLICY[key];
      if (allowed && !(user && allowed.includes(user.role))) {
        context.reportError(
          new GraphQLError(
            user ? `No tienes permiso para consultar ${key}` : `Autenticación requerida para ${key}`,
            { nodes: [node], extensions: { code: user ? 'FORBIDDEN' : 'UNAUTHENTICATED' } },
          ),
        );
      }
    },
  });
}

function fragmentMap(document) {
  const map = new Map();
  for (const def of document.definitions) if (def.kind === Kind.FRAGMENT_DEFINITION) map.set(def.name.value, def);
  return map;
}

export function queryDepth(selectionSet, fragments, seen = new Set()) {
  let max = 0;
  for (const sel of selectionSet?.selections ?? []) {
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value.startsWith('__')) continue;
      max = Math.max(max, 1 + (sel.selectionSet ? queryDepth(sel.selectionSet, fragments, seen) : 0));
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, queryDepth(sel.selectionSet, fragments, seen));
    } else if (sel.kind === Kind.FRAGMENT_SPREAD && !seen.has(sel.name.value)) {
      const frag = fragments.get(sel.name.value);
      if (frag) max = Math.max(max, queryDepth(frag.selectionSet, fragments, new Set([...seen, sel.name.value])));
    }
  }
  return max;
}

export function documentDepth(document) {
  const fragments = fragmentMap(document);
  let max = 0;
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) max = Math.max(max, queryDepth(def.selectionSet, fragments));
  }
  return max;
}

const DEFAULT_LIST = 10;
const MAX_LIST = 50;

function listSize(field, args, variables) {
  const arg = field.arguments?.find((a) => a.name.value === 'first');
  if (!arg) return DEFAULT_LIST;
  const value = arg.value.kind === Kind.VARIABLE ? variables?.[arg.value.name.value] : Number(arg.value.value);
  return Math.max(1, Math.min(Number.isFinite(value) ? value : DEFAULT_LIST, MAX_LIST));
}

function selectionCost(selectionSet, parentType, fragments, variables, seen) {
  let cost = 0;
  for (const sel of selectionSet?.selections ?? []) {
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value.startsWith('__')) continue;
      const def = parentType.getFields?.()[sel.name.value];
      if (!def) continue;
      const named = getNamedType(def.type);
      const unwrapped = isNonNullType(def.type) ? def.type.ofType : def.type;
      const isList = isListType(unwrapped);
      // Las conexiones (ProductConnection/OrderConnection) multiplican su sub-selección "nodes".
      const mult = isList ? (parentType.name.endsWith('Connection') ? 1 : listSize(sel, null, variables)) : 1;
      const child = isCompositeType(named) ? selectionCost(sel.selectionSet, named, fragments, variables, seen) : 0;
      cost += 1 + mult * child;
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      cost += selectionCost(sel.selectionSet, parentType, fragments, variables, seen);
    } else if (sel.kind === Kind.FRAGMENT_SPREAD && !seen.has(sel.name.value)) {
      const frag = fragments.get(sel.name.value);
      if (frag) cost += selectionCost(frag.selectionSet, parentType, fragments, variables, new Set([...seen, sel.name.value]));
    }
  }
  return cost;
}

/**
 * Costo estimado: cada campo cuesta 1; los campos-lista multiplican el costo de sus hijos por el
 * tamaño pedido (`first`, por defecto 10, máximo 50). Las conexiones usan `first` en el campo
 * raíz, por lo que se aplica ese tamaño a `nodes`.
 */
export function documentCost(schema, document, variables) {
  const fragments = fragmentMap(document);
  let total = 0;
  for (const def of document.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const root = def.operation === 'mutation' ? schema.getMutationType() : schema.getQueryType();
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD || sel.name.value.startsWith('__')) continue;
      const field = root.getFields()[sel.name.value];
      if (!field) continue;
      const named = getNamedType(field.type);
      const first = listSize(sel, null, variables);
      const isConnection = named.name.endsWith('Connection');
      const childCost = isCompositeType(named) ? selectionCost(sel.selectionSet, named, fragments, variables, new Set()) : 0;
      // En una conexión, "nodes" es la lista: se multiplica el costo de sus hijos por `first`.
      total += 1 + (isConnection ? childCost * first : childCost * (isListType(isNonNullType(field.type) ? field.type.ofType : field.type) ? first : 1));
    }
  }
  return total;
}
