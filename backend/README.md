# Natural Power – Backend seguro (Unidad 2)

Backend de microservicios para la tienda Natural Power (jugos, smoothies, batidos proteicos y combos),
derivado del dominio del frontend `frontend-GabrielGonzalez-BenjaminLopez`.
No está integrado al frontend (no era requisito); la API sigue sus flujos: catálogo, carrito → pedido,
login/registro, formulario de contacto y promociones.

## Arquitectura

```
Navegador ──► API Gateway :8080 ──► auth · clients · inventory · orders · payments
                    │                         │
                    └──► GraphQL Gateway ─────┘ (privado, agrega datos de varios servicios)

Secret Manager (privado)  ◄── todos los servicios leen sus secretos con un token propio (ACL mínima)
provider-mock :4007       ◄──► payments  (proveedor externo simulado, webhook firmado HMAC)
```

| Servicio | Puerto | Responsabilidad | Persistencia |
|---|---|---|---|
| api-gateway | 8080 (público) | Único punto de entrada, JWT, roles, rate limit, CORS, límites de cuerpo | – |
| graphql-gateway | 4006 | Consultas agregadas con autorización por campo, límites de profundidad/costo | – |
| secret-manager | 4100 | Entrega secretos por ACL, rotación (current/previous), auditoría sin valores | env `SECRET_*` |
| auth | 4001 | Registro, login, refresh rotativo, bloqueo por intentos | SQLite |
| clients | 4002 | Perfil, direcciones, contacto, baja de cuenta | SQLite |
| inventory | 4003 | Productos, combos, stock, reservas | SQLite |
| orders | 4004 | Pedidos, precios del servidor, idempotencia, máquina de estados | SQLite |
| payments | 4005 | Pagos, webhook, reembolsos | SQLite |
| provider-mock | 4007 | Sustituto de Webpay/proveedor externo | SQLite |

Un archivo de base de datos por servicio (`data/<servicio>.db`), con migraciones y seeds SQL.
Los servicios privados solo aceptan un token interno de 60 s firmado con su propio secreto.
Con Docker, la red `private` es `internal: true`: solo el gateway (8080) y provider-mock (4007) se publican.

## Requisitos

Node.js ≥ 22.13 (usa `node:sqlite`). Única dependencia npm: `graphql`. Docker es opcional.

## Ejecución local (paso a paso)

```bash
npm install
node scripts/gen-env.mjs     # (= npm run env:init) genera .env con secretos aleatorios; no se versiona
node scripts/dev.mjs         # (= npm run dev) levanta los 9 procesos; datos en ./data
```

En otra terminal, con el sistema en marcha:

```bash
npm test                     # 58 pruebas e2e (seguridad, IDOR, idempotencia, pagos, GraphQL)
npm run loadtest             # prueba de capacidad (ver abajo)
```

`npm run reset` borra `./data` y levanta el sistema con datos nuevos (migraciones + seeds).

## Ejecución con Docker

```bash
node scripts/gen-env.mjs
docker compose up --build
docker compose ps            # los 9 servicios deben quedar (healthy)
```

Solo se publican el API Gateway (8080) y provider-mock (4007, proveedor externo simulado); la red `private` es `internal`.
Con el compose levantado: `npm test` y `npm run loadtest` funcionan igual contra `localhost:8080`.

Usuarios de prueba (contraseñas generadas en `.env`): `admin@naturalpower.test`, `cliente1@naturalpower.test`, `cliente2@naturalpower.test`.

## Documentación de arquitectura

- `docs/c4/workspace.dsl`: modelo C4 en Structurizr DSL (C1, C2, C3 de Gateway/Auth/GraphQL/Orders y vistas dinámicas de catálogo y compra). Se visualiza en Structurizr Lite o structurizr.com/dsl.
- `docs/diagramas/modulo2_dominio.puml`: UML de clases del dominio y servicios (Módulo 2).
- `docs/diagramas/modulo5_api_gateway.puml`: UML del API Gateway, políticas y GraphQL Gateway (Módulo 5).

## API pública (`/api/v1`)

| Método | Ruta | Acceso |
|---|---|---|
| POST | /auth/register, /auth/login, /auth/refresh, /auth/logout | público |
| GET | /products, /products/:id, /combos, /combos/:id | público |
| POST | /contact | público |
| GET/PUT/DELETE | /clients/me | usuario (DELETE: cliente) |
| GET/POST, PUT/DELETE | /clients/me/addresses[/:id] | usuario |
| POST | /orders (header `Idempotency-Key` obligatorio) | cliente |
| GET | /orders, /orders/:id | cliente / usuario |
| DELETE | /orders/:id (cancelación, conserva historial) | usuario |
| POST | /orders/:id/pay | cliente |
| POST | /payments/webhook | firma HMAC del proveedor |
| POST | /graphql | autorización por campo |
| GET/POST/PUT/PATCH/DELETE | /admin/orders, /admin/products, /admin/contact-messages, /admin/clients | admin |

Ninguna ruta `/internal/*` se publica.

## Decisiones de seguridad

- JWT HS256 con algoritmo fijo, expiración corta, rotación de secreto (current + previous).
- Contraseñas con scrypt + sal por usuario; refresh tokens opacos, guardados como sha256, rotados, con detección de reutilización.
- Bloqueo tras 5 intentos fallidos (15 min).
- El gateway descarta cualquier cabecera de identidad del cliente y reconstruye las suyas.
- Precios, totales y estado del pedido los calcula el servidor; lo que envíe el cliente se ignora.
- Un pedido ajeno responde 404 (evita IDOR). Solo `payments` puede dejar un pedido en PAID.
- Webhook: firma HMAC + deduplicación por eventId + confirmación servidor a servidor con el proveedor.
- Los logs son JSON con redacción; los secretos no aparecen en logs ni en el repositorio.

## Supuestos (revisar)

- Costo de despacho 2500; despacho gratis si el subtotal tras promociones ≥ 15000.
- Cupón NATURALPOWER: 15 % en la primera compra, aplicado después de promociones; 2x1 en smoothies pequeños martes y jueves (America/Santiago).
- Stock: 1 unidad por bebida sin importar el tamaño.
- Nombre máx. 60 caracteres (el front limita a 19); contraseña 6–64 sin espacios.
- provider-mock reemplaza a Webpay.
- Módulo 9: sin gRPC ni analítica separada; se entrega medición de capacidad con `scripts/loadtest.mjs`.

## Medición de capacidad (referencia)

Para medir capacidad real hay que subir los límites de solicitudes; con los valores por defecto el gateway responde 429 y la medición no tiene sentido (la columna `limitadas(429)` lo delata):

```bash
RATE_LIMIT_ANON=100000 RATE_LIMIT_USER=100000 RATE_LIMIT_AUTH=100000 RATE_LIMIT_IP=1000000 node scripts/dev.mjs
npm run loadtest      # carga .env (necesario para el login de admin)
```

Resultado de ejemplo (Ryzen 5 5600 de 12 hilos, 16 GB, Node 24, 20 clientes concurrentes, 10 s por escenario, todo en una máquina):

| Escenario | RPS | p50 ms | p95 ms | Errores |
|---|---|---|---|---|
| GET /products | 1389 | 14.1 | 17.3 | 0 |
| GraphQL catálogo | 1127 | 17.0 | 22.9 | 0 |
| GET /admin/orders | 1156 | 16.9 | 25.6 | 0 |
| GraphQL pedidos + productos + pagos | 648 | 30.4 | 41.4 | 0 |

Son mediciones de este entorno, no una proyección de producción.
