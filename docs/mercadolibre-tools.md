# Tools de MercadoLibre para el agente

Herramientas de **solo lectura** sobre la cuenta de MercadoLibre del cliente. Se agregan desde
Tareas como las de WooCommerce o shipnow. Sirven en **cualquier agente** del cliente: alcanza con
tener una cuenta de ML conectada, esté o no activo el canal de DMs o preguntas.

## Acciones

| Acción (`config.actions`) | Endpoint backend-js | API de ML |
|---|---|---|
| `search_products` | `GET /api/mercadolibre/tools/products?query=` | `/users/{id}/items/search?status=active&q=` + multiget `/items?ids=` |
| `get_product_detail` | `GET /api/mercadolibre/tools/product?item_id=` | `/items/{id}` + `/items/{id}/description` |
| `get_stock` | `GET /api/mercadolibre/tools/stock?item_id=` | `/items/{id}` (`variations[].available_quantity`) |
| `get_shipping_cost` | `GET /api/mercadolibre/tools/shipping-cost?item_id=&zip_code=` | `/items/{id}/shipping_options?zip_code=` |
| `get_shipment_status` | `GET /api/mercadolibre/tools/shipment?order_number=` | orden/pack → `/shipments/{id}` (`x-format-new`) |
| `get_order_status` | `GET /api/mercadolibre/tools/order?order_number=` | `/orders/{id}` o `/packs/{id}` |
| `get_invoice` | `GET /api/mercadolibre/tools/invoice?order_number=` | `/packs/{id}/fiscal_documents` |
| `get_payment_methods` | `GET /api/mercadolibre/tools/payment-methods` | `/sites/{site}/payment_methods` (caché 24 h en memoria) |

Todos reciben `client_id` y, opcional, `ml_user_id`.

## Decisiones

- **La cuenta se elige por `config.ml_user_id`, no por `connection_id`.** El corte por impago
  borra la fila de `mercadolibre_connections` y al reconectar la fila tiene otro id, pero el
  usuario de ML es el mismo. Es el mismo criterio que `mercadolibre_settings`. Sin `ml_user_id`
  se usa la cuenta conectada primero. Si el `ml_user_id` de la tool ya no es del cliente, se
  devuelve un error y no se cae a otra cuenta.
- **Solo publicaciones activas del propio vendedor.** Un item de otro vendedor o pausado responde
  "no es de esta cuenta o no está activa". Si no, el agente podría cotizar publicaciones ajenas.
- **Número de venta = order_id o pack_id.** ML le muestra al comprador uno u otro según si compró
  con carrito. Primero se prueba la orden; si no existe, el pack. Con un pack se devuelven todas
  sus órdenes. Las órdenes de otro vendedor se tratan como "no encontrada".
- **Sin verificación de identidad** (decisión de producto, igual que shipnow). Por eso el
  shaping no devuelve nombre, nickname, dirección, DNI ni teléfono del comprador: solo estado,
  productos, montos, fechas y ciudad/provincia.
- **Búsqueda con respaldo.** Si el filtro `q` de ML no trae nada, se recorren hasta 200
  publicaciones activas y se filtra el título localmente, tolerando acentos y plurales.
- **Factura.** Solo informa si está cargada. No se manda el archivo porque bajarlo pide el
  token del vendedor, y el comprador ya lo tiene en "Mis compras".

## Permisos de la app de ML

Las cuentas conectadas al 2026-10-31 tienen `publish-sync` (lectura) y `orders-shipments`
(lectura), así que todo debería andar sin reconectar, **salvo la factura**: no aparece un scope
de facturación. Si ML responde 403, la tool le dice al agente que falta un permiso. Para
habilitar la factura hay que agregar el permiso en el gestor de apps de ML, y después cada
cliente tiene que reconectar su cuenta.

## Pendiente de verificar contra una cuenta real

Se escribió sin poder llamar a la API (no hay tokens en local), así que el shaping es
defensivo. Hay que probar:

- que `q` en `/users/{id}/items/search` filtre por título;
- la forma de `shipping_options`, de `/shipments` con `x-format-new` (`lead_time`,
  `status_history`) y de `fiscal_documents`.

## Deploy

1. Migración `db/migrations/mercadolibre_agent_tools.sql`: suma `mercadolibre` al CHECK de
   `agent_tools.type`. Sin esto, crear la tool da 500. No es destructiva y se puede correr antes.
2. backend-js → agente-tilegra → dashboard-tilegra (rama `feature/mercadolibre-tools` en los tres).
