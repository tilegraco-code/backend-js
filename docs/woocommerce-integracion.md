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

## Tools del agente

Criterio: el comprador consulta lo mismo que ve en la web de la tienda, más el estado de un
pedido. Nada de back-office (clientes, reportes, ajustes, webhooks).

| Acción | Endpoint backend-js | WooCommerce | Caché |
|---|---|---|---|
| `search_products` | `GET /products?query=` / `?product_id=` | `/products`, `/products/<id>/variations`, `/products/<id>` | catálogo 1h; la ficha va en vivo |
| `get_reviews` | `GET /reviews?product_id=` | `/products/reviews?product=&status=approved` | en vivo |
| `get_shipping_info` | `GET /shipping?state=&postcode=&country=` | `/shipping/zones` (+ locations y methods), `/data/countries/<c>`, `/settings/general/woocommerce_default_country` | 1h |
| `get_payment_methods` | `GET /payment-methods` | `/payment_gateways` (sólo activos) | 1h |
| `get_order_status` | `GET /orders?order_number=` y/o `&email=` | `/orders/<id>` o `/orders?search=`, `/orders/<id>/notes?type=customer` | en vivo |
| `create_checkout` | `POST /checkout` | `POST /orders` | — |

- **Envíos:** la zona se elige como WooCommerce (`matchShippingZone`): la primera por `order` cuyas
  regiones incluyan el destino y, si tiene CP, que coincida; si no, la zona 0. Si la respuesta
  depende de la provincia o del CP y no vino, se le pide al agente que lo pregunte. La API no cotiza
  carritos: tarifa plana y envío gratis salen exactos; fórmulas (`[qty]`) y métodos de plugins
  (Andreani, OCA) vuelven con `cost: null` y "se calcula al pagar".
- **Estado del pedido:** número **o** email de la compra (decisión de producto, 2026-10-14).
  Con el número devuelve ese pedido; con el email solo, los últimos 5 pedidos cuyo
  `billing.email` es exactamente ése; si vienen los dos, tienen que coincidir
  (`orderBelongsTo`) y si no, se responde como si el pedido no existiera. Trade-off aceptado:
  quien conozca un email ve las compras de esa persona, y el número solo se puede adivinar. Por
  eso `shapeOrderStatus` no devuelve nombre, email, teléfono ni dirección exacta (sólo la ciudad),
  y de las notas sólo las marcadas para el cliente. Se acepta un pedido sólo si su `number`
  coincide exacto (plugins de numeración secuencial hacen que `number` ≠ `id`).

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
