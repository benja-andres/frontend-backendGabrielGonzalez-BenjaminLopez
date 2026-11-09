workspace "Natural Power" "Backend seguro de la tienda de jugos y smoothies Natural Power (Evaluación 2)" {

    !identifiers hierarchical

    model {
        visitante = person "Visitante" "Usuario anónimo: consulta catálogo y combos, envía formulario de contacto."
        cliente   = person "Cliente" "Usuario autenticado: gestiona su perfil y direcciones, crea, paga y anula sus pedidos."
        operador  = person "Operador / Admin" "Gestiona catálogo, stock, estados de pedidos, mensajes y clientes."

        proveedorPagos = softwareSystem "Plataforma de Pagos" "Proveedor externo (Webpay/Flow). En el proyecto lo simula provider-mock." "Externo"

        plataforma = softwareSystem "Plataforma Comercial Natural Power" "Backend de microservicios: autenticación, catálogo, pedidos y pagos." {

            frontend = container "Frontend Responsivo" "Contratos y pantallas de la Unidad 1 (no integrado en esta entrega)." "Navegador web (HTML/CSS/JS)" "Web Browser"

            gateway = container "API Gateway" "Único punto de entrada HTTP: valida JWT, aplica roles, rate limit, CORS y límites de cuerpo; descarta cabeceras de identidad del cliente." "Node.js :8080" {
                httpAdapter     = component "HTTP Adapter" "Recibe la petición, aplica CORS, límite de cuerpo y timeouts." "Node http"
                accessFilter    = component "Access Filter" "Verifica JWT (HS256), rol requerido por la ruta y rate limit; elimina x-user-*, x-internal-*." "JwtVerifier + RateLimiter"
                routeDispatcher = component "Route Dispatcher" "Resuelve la ruta en la tabla explícita ROUTES (G01-G33) y reenvía con token interno de 60 s." "routes.js + ServiceClient"
                errorMapper     = component "Error Mapper" "Traduce errores de servicios a respuestas uniformes sin filtrar detalles internos." "errors.js"
            }

            graphql = container "GraphQL Gateway" "Agregador privado: combina orders, payments, inventory y clients con autorización por campo, límite de profundidad y costo." "Node.js + graphql :4006 (privado)" {
                endpointGql = component "Endpoint GraphQL" "Recibe POST /graphql desde el API Gateway." "http"
                validador   = component "Validador de Consultas" "Rechaza introspección, profundidad y costo excesivos y paginación mayor a 50." "rules.js"
                politica    = component "Política de Acceso a Campos" "Autoriza por operación y campo según el rol propagado." "rules.js"
                resolvers   = component "Resolvers de Negocio" "resumenPedido, misPedidos, catalog, pedidosAdmin, anularPedido." "resolvers.js"
                conectores  = component "Conectores de Subsistemas" "Clientes HTTP con identidad de servicio hacia inventory, orders, payments y clients." "ServiceClient"
                compositor  = component "Compositor de Respuestas" "Une resultados parciales (carga por lote) y mapea errores parciales." "resolvers.js"
            }

            secretManager = container "Secret Manager" "Entrega secretos por referencia simbólica con ACL mínima, rotación current/previous y auditoría sin valores." "Node.js :4100 (privado)"

            auth = container "Auth Service" "Registro, login, refresh rotativo, bloqueo por intentos." "Node.js :4001 (privado)" {
                apiIdentidad    = component "API Identidad" "Endpoints /auth/*." "http"
                gestorSesiones  = component "Gestor de Sesiones" "Emite JWT de acceso y refresh tokens opacos rotativos con detección de reutilización." "jwt.js"
                verificadorCred = component "Verificador de Credenciales" "scrypt con sal por usuario; bloqueo tras 5 fallos." "crypto.scrypt"
                clienteSecretos = component "Cliente de Secretos" "Obtiene el secreto JWT por referencia." "secrets.js"
                repoIdentidades = component "Repositorio de Identidades" "Acceso a users y refresh_tokens." "node:sqlite"
            }

            clients   = container "Clients Service" "Perfil, direcciones, mensajes de contacto y baja de cuenta." "Node.js :4002 (privado)"
            inventory = container "Inventory Service" "Catálogo, combos, stock y reservas." "Node.js :4003 (privado)"

            orders = container "Orders Service" "Pedidos, precios del servidor, cupones, idempotencia y máquina de estados." "Node.js :4004 (privado)" {
                apiPedidos      = component "API Pedidos" "Endpoints /orders y /admin/orders." "http"
                politicaAcceso  = component "Política de Acceso" "Propiedad del recurso (cliente == sub) y rol; pedido ajeno responde 404." "http.js"
                ctlIdempotencia = component "Control de Idempotencia" "Idempotency-Key + hash del cuerpo; misma clave y otro cuerpo responde 422." "idempotency_keys"
                servicioPedidos = component "Servicio de Pedidos" "Cálculo de totales (pricing.js), estados y anulación no destructiva." "pricing.js"
                adaptadores     = component "Adaptadores Inventory/Payments" "Reserva, confirma y libera stock; inicia pagos." "ServiceClient"
                repoPedidos     = component "Repositorio de Pedidos" "orders, order_items, order_status_history, coupons." "node:sqlite"
            }

            payments = container "Payments Service" "Inicio de pago, webhook firmado HMAC con deduplicación, reembolsos." "Node.js :4005 (privado)"

            dbIdentity  = container "dbIdentity"  "users, refresh_tokens" "SQLite" "Database"
            dbClients   = container "dbClients"   "clients, addresses, contact_messages" "SQLite" "Database"
            dbInventory = container "dbInventory" "products, sizes, stock, combos, combo_items, reservations" "SQLite" "Database"
            dbOrders    = container "dbOrders"    "orders, order_items, order_status_history, coupons, idempotency_keys" "SQLite" "Database"
            dbPayments  = container "dbPayments"  "payments, webhook_events" "SQLite" "Database"
        }

        # --- Relaciones C1 ---
        visitante -> plataforma "Consulta catálogo y envía contacto" "HTTPS/JSON"
        cliente   -> plataforma "Compra y gestiona su cuenta" "HTTPS/JSON"
        operador  -> plataforma "Administra catálogo y pedidos" "HTTPS/JSON"

        # --- Relaciones C2 ---
        visitante -> plataforma.frontend "Usa"
        cliente   -> plataforma.frontend "Usa"
        operador  -> plataforma.frontend "Usa"
        plataforma.frontend -> plataforma.gateway "Peticiones /api/v1/*" "HTTPS/JSON"

        plataforma.gateway -> plataforma.auth "Autenticación" "HTTP + token interno"
        plataforma.gateway -> plataforma.clients "Perfil y contacto" "HTTP + token interno"
        plataforma.gateway -> plataforma.inventory "Catálogo" "HTTP + token interno"
        plataforma.gateway -> plataforma.orders "Pedidos" "HTTP + token interno"
        plataforma.gateway -> plataforma.payments "Webhook de pago" "HTTP + token interno"
        plataforma.gateway -> plataforma.graphql "Consultas GraphQL" "HTTP + token interno"

        plataforma.graphql -> plataforma.orders "Lee pedidos" "HTTP + token interno"
        plataforma.graphql -> plataforma.payments "Lee pagos" "HTTP + token interno"
        plataforma.graphql -> plataforma.inventory "Lee productos" "HTTP + token interno"
        plataforma.graphql -> plataforma.clients "Lee direcciones" "HTTP + token interno"

        plataforma.orders -> plataforma.inventory "Cotiza, reserva, confirma y libera stock" "HTTP + token interno"
        plataforma.orders -> plataforma.clients "Valida dirección del cliente" "HTTP + token interno"
        plataforma.orders -> plataforma.payments "Inicia pago y reembolsa" "HTTP + token interno"
        plataforma.payments -> plataforma.orders "Informa resultado de pago" "HTTP + token interno"

        plataforma.payments -> proveedorPagos "Crea y consulta cobro" "HTTPS + API key"
        proveedorPagos -> plataforma.gateway "Webhook firmado HMAC" "HTTPS"

        plataforma.gateway -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"
        plataforma.graphql -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"
        plataforma.auth -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"
        plataforma.clients -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"
        plataforma.inventory -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"
        plataforma.orders -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"
        plataforma.payments -> plataforma.secretManager "Obtiene secretos" "HTTP + SM_TOKEN"

        plataforma.auth -> plataforma.dbIdentity "Lee y escribe" "SQL"
        plataforma.clients -> plataforma.dbClients "Lee y escribe" "SQL"
        plataforma.inventory -> plataforma.dbInventory "Lee y escribe" "SQL"
        plataforma.orders -> plataforma.dbOrders "Lee y escribe" "SQL"
        plataforma.payments -> plataforma.dbPayments "Lee y escribe" "SQL"

        # --- Relaciones C3: API Gateway ---
        plataforma.gateway.httpAdapter -> plataforma.gateway.accessFilter "Entrega la petición"
        plataforma.gateway.accessFilter -> plataforma.gateway.routeDispatcher "Entrega petición con identidad verificada"
        plataforma.gateway.routeDispatcher -> plataforma.gateway.errorMapper "Errores del destino"
        plataforma.gateway.accessFilter -> plataforma.gateway.errorMapper "401 / 403 / 429"
        plataforma.gateway.errorMapper -> plataforma.gateway.httpAdapter "Respuesta de error uniforme"

        # --- Relaciones C3: Auth ---
        plataforma.auth.apiIdentidad -> plataforma.auth.verificadorCred "Valida credenciales"
        plataforma.auth.apiIdentidad -> plataforma.auth.gestorSesiones "Emite y rota sesión"
        plataforma.auth.gestorSesiones -> plataforma.auth.clienteSecretos "Pide secreto JWT"
        plataforma.auth.verificadorCred -> plataforma.auth.repoIdentidades "Lee usuario"
        plataforma.auth.gestorSesiones -> plataforma.auth.repoIdentidades "Guarda refresh token (sha256)"
        plataforma.auth.clienteSecretos -> plataforma.secretManager "Obtiene secretos"
        plataforma.auth.repoIdentidades -> plataforma.dbIdentity "SQL"

        # --- Relaciones C3: GraphQL Gateway ---
        plataforma.graphql.endpointGql -> plataforma.graphql.validador "Documento de consulta"
        plataforma.graphql.validador -> plataforma.graphql.politica "Consulta válida"
        plataforma.graphql.politica -> plataforma.graphql.resolvers "Campos autorizados"
        plataforma.graphql.resolvers -> plataforma.graphql.conectores "Pide datos"
        plataforma.graphql.conectores -> plataforma.orders "Pedidos"
        plataforma.graphql.conectores -> plataforma.payments "Pagos"
        plataforma.graphql.conectores -> plataforma.inventory "Productos"
        plataforma.graphql.resolvers -> plataforma.graphql.compositor "Resultados parciales"
        plataforma.graphql.compositor -> plataforma.graphql.endpointGql "Respuesta compuesta"

        # --- Relaciones C3: Orders ---
        plataforma.orders.apiPedidos -> plataforma.orders.politicaAcceso "Verifica rol y propiedad"
        plataforma.orders.apiPedidos -> plataforma.orders.ctlIdempotencia "Verifica Idempotency-Key"
        plataforma.orders.apiPedidos -> plataforma.orders.servicioPedidos "Ejecuta caso de uso"
        plataforma.orders.servicioPedidos -> plataforma.orders.adaptadores "Reserva stock e inicia pago"
        plataforma.orders.servicioPedidos -> plataforma.orders.repoPedidos "Persiste"
        plataforma.orders.ctlIdempotencia -> plataforma.orders.repoPedidos "Guarda clave y hash"
        plataforma.orders.adaptadores -> plataforma.inventory "Reservas"
        plataforma.orders.adaptadores -> plataforma.payments "Pagos"
        plataforma.orders.repoPedidos -> plataforma.dbOrders "SQL"
    }

    views {
        systemContext plataforma "C1_Contexto" "C1 - Contexto del sistema" {
            include *
            autolayout lr
        }

        container plataforma "C2_Contenedores" "C2 - Contenedores" {
            include *
            autolayout lr
        }

        component plataforma.gateway "C3_ApiGateway" "C3 - API Gateway" {
            include *
            autolayout lr
        }

        component plataforma.auth "C3_Auth" "C3 - Auth Service" {
            include *
            autolayout lr
        }

        component plataforma.graphql "C3_GraphQL" "C3 - GraphQL Gateway" {
            include *
            autolayout lr
        }

        component plataforma.orders "C3_Orders" "C3 - Orders Service" {
            include *
            autolayout lr
        }

        dynamic plataforma "Dyn_Catalogo" "Consulta de catálogo (visitante)" {
            visitante -> plataforma.frontend "1. Abre la pantalla de catálogo"
            plataforma.frontend -> plataforma.gateway "2. GET /api/v1/products"
            plataforma.gateway -> plataforma.inventory "3. GET /products (token interno)"
            plataforma.inventory -> plataforma.dbInventory "4. SELECT productos y stock"
            autolayout lr
        }

        dynamic plataforma "Dyn_Compra" "Compra: crear pedido, reservar stock, pagar y confirmar" {
            cliente -> plataforma.frontend "1. Confirma el carrito"
            plataforma.frontend -> plataforma.gateway "2. POST /orders (Idempotency-Key, JWT)"
            plataforma.gateway -> plataforma.orders "3. POST /orders (identidad verificada)"
            plataforma.orders -> plataforma.inventory "4. Cotiza y reserva stock"
            plataforma.orders -> plataforma.dbOrders "5. Guarda pedido PENDING_PAYMENT"
            plataforma.frontend -> plataforma.gateway "6. POST /orders/{id}/pay"
            plataforma.gateway -> plataforma.orders "7. Inicia pago"
            plataforma.orders -> plataforma.payments "8. Crea pago (monto fijado por el servidor)"
            plataforma.payments -> proveedorPagos "9. Crea cobro"
            proveedorPagos -> plataforma.gateway "10. Webhook firmado HMAC"
            plataforma.gateway -> plataforma.payments "11. Entrega webhook"
            plataforma.payments -> plataforma.orders "12. Informa pago aprobado (PAID)"
            plataforma.orders -> plataforma.inventory "13. Confirma descuento de stock"
            autolayout lr
        }

        styles {
            element "Person" {
                shape Person
                background #1f7a4d
                color #ffffff
            }
            element "Software System" {
                background #2e9e6b
                color #ffffff
            }
            element "Externo" {
                background #8a8a8a
            }
            element "Container" {
                background #3fb27f
                color #ffffff
            }
            element "Component" {
                background #7fd1a8
                color #0b2e1d
            }
            element "Web Browser" {
                shape WebBrowser
            }
            element "Database" {
                shape Cylinder
            }
        }
    }
}
