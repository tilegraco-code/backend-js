# WooCommerce: catálogo + pedidos para pagar

Mismo scope que TiendaNube: el agente busca productos y arma un pedido que el comprador paga
desde un link. Cada cliente conecta su tienda desde **Integraciones** en el dashboard.

## Piezas

| Repo | Archivo | Qué hace |
|---|---|---|
| backend-js | `db/migrations/woocommerce_connections.sql` | `woocommerce_connections`, `woocommerce_cache`, tipo `woocommerce` en `agent_tools_type_check` |
| backend-js | `src/services/woocommerce-api.service.ts` | Cliente REST wc/v3. Todo request pasa por `safeLookup` (anti-SSRF de las tools HTTP) y sigue redirecciones hop por hop |
| backend-js | `src/services/woocommerce.service.ts` / `woocommerce.shape.ts` | Conexión, caché del catálogo (1h), búsqueda y creación del pedido |
| backend-js | `src/routes/woocommerce.route.ts` | `/api/woocommerce/{status,authorize-url,connect,disconnect,products,checkout}` (internas) |
| backend-js | `src/routes/woocommerce-oauth.route.ts` | `POST /api/woocommerce/oauth/callback` (público, lo llama el WordPress de la tienda) |
| dashboard-tilegra | `components/integrations/woocommerce-connect-dialog.tsx` + `app/api/auth/woocommerce/*` | Formulario de conexión |
| dashboard-tilegra | `components/workflows/tool-form-dialog.tsx` | Tool: acción + config de envío |
| agente-tilegra | `app/tools/api_tools.py` (`_woocommerce_tools`) | Tools con argumentos tipados |

## Conexión

1. El cliente escribe la URL de su tienda. `discoverStore` verifica `/wp-json/` (tiene que listar
   `wc/v3`), exige HTTPS y resuelve redirecciones (ej. sin www → con www).
2. **Botón "Ir a mi tienda"** → `/wc-auth/v1/authorize` de la tienda. `user_id` = state firmado con
   `client_id` + `store_url` (30 min de validez). WooCommerce le hace POST de las claves a
   `<PUBLIC_URL>/api/woocommerce/oauth/callback` y vuelve a `/dashboard/integrations?woocommerce=return&success=1`.
   El callback guarda sin pegarle a la tienda (WordPress está esperando nuestra respuesta en el
   mismo request) y valida a los 3 s en segundo plano.
3. **Carga manual** (si el hosting rompe el paso 2): consumer key `ck_…` + secret `cs_…`
   generadas en WooCommerce → Ajustes → Avanzado → REST API. Se validan antes de guardar y se prueba
   si tienen escritura.

Auth: header `Basic`; si la tienda lo rechaza se prueba por query string (hostings que se comen
`Authorization`) y se guarda en `auth_mode`.

## Checkout

Crea un pedido `pending` y devuelve `payment_url` (página de pago del pedido). WooCommerce
calcula precios e impuestos. **En esa página el comprador no elige envío**, por eso el envío se
configura en la tool:

- `shipping_mode: "none"`: sin envío (retiro / se coordina aparte).
- `shipping_mode: "flat"`: `shipping_title` + `shipping_cost` como `shipping_lines`; el agente
  tiene que mandar `address` (se valida calle y ciudad).

El runtime manda `tool_id` y backend-js lee la config de `agent_tools` (verificando que la tool
sea del cliente). Si el producto es variable y falta `variation_id`, el error le lista las
variantes al agente.

Pedidos creados por REST no se auto-cancelan como los del checkout de WooCommerce
(`created_via = rest-api`): quedan pendientes hasta que el comercio los cancele.

## Setup

- Aplicar `db/migrations/woocommerce_connections.sql`.
- `PUBLIC_URL` (HTTPS) y `DASHBOARD_URL` en backend-js. Sin `PUBLIC_URL` sólo funciona la carga manual.
- Opcional: `WOOCOMMERCE_CACHE_TTL_MINUTES` (default 60).
