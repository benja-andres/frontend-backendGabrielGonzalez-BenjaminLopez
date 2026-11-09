// Tabla EXPLÍCITA de rutas externas permitidas. Lo que no está aquí no existe para el exterior
// (en particular, ninguna ruta /internal/* de los microservicios se publica).
//
// access: 'anon'      -> sin sesión (si llega un token se valida y se propaga igualmente)
//         'customer'  -> token válido con rol customer
//         'user'      -> token válido con rol customer o admin
//         'admin'     -> token válido con rol admin
// limit:  clase de rate limit (ver ratelimit.js)
// pass:   cabeceras del cliente que se reenvían (lista blanca)

export const ROUTES = [
  // --- Autenticación ---
  { id: 'G01', method: 'POST', path: '/auth/register', access: 'anon', target: 'auth', to: '/auth/register', limit: 'auth' },
  { id: 'G02', method: 'POST', path: '/auth/login', access: 'anon', target: 'auth', to: '/auth/login', limit: 'auth' },
  { id: 'G03', method: 'POST', path: '/auth/refresh', access: 'anon', target: 'auth', to: '/auth/refresh', limit: 'auth' },
  { id: 'G04', method: 'POST', path: '/auth/logout', access: 'anon', target: 'auth', to: '/auth/logout', limit: 'auth' },

  // --- Catálogo (público) ---
  { id: 'G05', method: 'GET', path: '/products', access: 'anon', target: 'inventory', to: '/products', limit: 'anon' },
  { id: 'G06', method: 'GET', path: '/products/:id', access: 'anon', target: 'inventory', to: '/products/:id', limit: 'anon' },
  { id: 'G07', method: 'GET', path: '/combos', access: 'anon', target: 'inventory', to: '/combos', limit: 'anon' },
  { id: 'G08', method: 'GET', path: '/combos/:id', access: 'anon', target: 'inventory', to: '/combos/:id', limit: 'anon' },
  { id: 'G09', method: 'POST', path: '/contact', access: 'anon', target: 'clients', to: '/contact', limit: 'auth' },

  // --- Cliente autenticado ---
  { id: 'G10', method: 'GET', path: '/clients/me', access: 'user', target: 'clients', to: '/clients/me', limit: 'user' },
  { id: 'G11', method: 'PUT', path: '/clients/me', access: 'user', target: 'clients', to: '/clients/me', limit: 'user' },
  { id: 'G12', method: 'DELETE', path: '/clients/me', access: 'customer', target: 'clients', to: '/clients/me', limit: 'user' },
  { id: 'G13', method: 'GET', path: '/clients/me/addresses', access: 'user', target: 'clients', to: '/clients/me/addresses', limit: 'user' },
  { id: 'G14', method: 'POST', path: '/clients/me/addresses', access: 'user', target: 'clients', to: '/clients/me/addresses', limit: 'user' },
  { id: 'G15', method: 'PUT', path: '/clients/me/addresses/:id', access: 'user', target: 'clients', to: '/clients/me/addresses/:id', limit: 'user' },
  { id: 'G16', method: 'DELETE', path: '/clients/me/addresses/:id', access: 'user', target: 'clients', to: '/clients/me/addresses/:id', limit: 'user' },

  // --- Pedidos y pagos ---
  { id: 'G17', method: 'POST', path: '/orders', access: 'customer', target: 'orders', to: '/orders', limit: 'user', pass: ['idempotency-key'] },
  { id: 'G18', method: 'GET', path: '/orders', access: 'customer', target: 'orders', to: '/orders', limit: 'user' },
  { id: 'G19', method: 'GET', path: '/orders/:id', access: 'user', target: 'orders', to: '/orders/:id', limit: 'user' },
  { id: 'G20', method: 'DELETE', path: '/orders/:id', access: 'user', target: 'orders', to: '/orders/:id', limit: 'user' },
  { id: 'G21', method: 'POST', path: '/orders/:id/pay', access: 'customer', target: 'orders', to: '/orders/:id/pay', limit: 'user' },

  // --- Aviso del proveedor de pagos (se autentica por firma HMAC en payments) ---
  { id: 'G22', method: 'POST', path: '/payments/webhook', access: 'anon', target: 'payments', to: '/webhooks/provider', limit: 'webhook', pass: ['x-provider-signature'], raw: true },

  // --- GraphQL (agregaciones; cada operación y campo se autoriza en el GraphQL Gateway) ---
  { id: 'G23', method: 'POST', path: '/graphql', access: 'anon', target: 'graphql-gateway', to: '/graphql', limit: 'user', maxBody: 20000, passthrough: true },

  // --- Administración ---
  { id: 'G24', method: 'GET', path: '/admin/orders', access: 'admin', target: 'orders', to: '/admin/orders', limit: 'user' },
  { id: 'G25', method: 'PATCH', path: '/admin/orders/:id/status', access: 'admin', target: 'orders', to: '/admin/orders/:id/status', limit: 'user' },
  { id: 'G26', method: 'GET', path: '/admin/products', access: 'admin', target: 'inventory', to: '/admin/products', limit: 'user' },
  { id: 'G27', method: 'POST', path: '/admin/products', access: 'admin', target: 'inventory', to: '/admin/products', limit: 'user' },
  { id: 'G28', method: 'PUT', path: '/admin/products/:id', access: 'admin', target: 'inventory', to: '/admin/products/:id', limit: 'user' },
  { id: 'G29', method: 'PATCH', path: '/admin/products/:id/stock', access: 'admin', target: 'inventory', to: '/admin/products/:id/stock', limit: 'user' },
  { id: 'G30', method: 'DELETE', path: '/admin/products/:id', access: 'admin', target: 'inventory', to: '/admin/products/:id', limit: 'user' },
  { id: 'G31', method: 'GET', path: '/admin/contact-messages', access: 'admin', target: 'clients', to: '/admin/contact-messages', limit: 'user' },
  { id: 'G32', method: 'PATCH', path: '/admin/contact-messages/:id', access: 'admin', target: 'clients', to: '/admin/contact-messages/:id', limit: 'user' },
  { id: 'G33', method: 'GET', path: '/admin/clients', access: 'admin', target: 'clients', to: '/admin/clients', limit: 'user' },
];
