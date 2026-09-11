# shipnow: estado de envíos por número de orden

Integración con [shipnow](https://shipnow.com.ar) (logística para ecommerce) para que el
agente conteste "¿dónde está mi pedido?" a partir del número de orden.

Doc oficial de la API: <https://shipnow.stoplight.io/docs/shipnow-api>

## Por qué es más simple que TiendaNube / MercadoLibre

**No hay OAuth.** La cuenta se identifica con un token fijo que el dueño pide por mail a
`developers@shipnow.com.ar` y pega en el dashboard. No rota, no vence, no hay callback ni
`state` firmado. Por eso:

- no hay `shipnow-oauth.route.ts` ni envs nuevas (`SHIPNOW_API_BASE` es opcional);
- la tabla `shipnow_connections` no tiene `refresh_token` ni `expires_at`;
- para probar contra el ambiente de test de shipnow no se cambia la URL: se pide un token
  de una cuenta de test (mismo host, otra cuenta).

El token va en cada request como `Authorization: Bearer <token>` contra
`https://api.shipnow.com.ar`.

## Los dos números de orden

El comprador puede tirar cualquiera de estos dos y no sabe cuál tiene:

| Número | Dónde vive en shipnow | Cómo se busca |
|---|---|---|
| El de la tienda (TiendaNube, Shopify, ERP) | `order.external_reference` | `GET /orders?external_reference=<n>` |
| El interno de shipnow | `order.id` | `GET /orders/<id>` |

`shipnowService.findOrder()` prueba en ese orden: primero la referencia externa (es la que
el comprador tiene en el mail de la tienda) y, si no hay resultados y el valor es numérico,
cae al ID interno. Así la misma tool sirve para los dos casos sin preguntarle al comprador
de dónde sacó el número.

> `external_reference_user` (referencia secundaria, string) **no** es filtrable en
> `GET /orders`, así que hoy no se busca por ese campo.

## Estado: pedido vs. envío

Son dos estados distintos y el segundo es el que importa una vez despachado:

- `order.status` — la preparación dentro de shipnow (`new`, `packing_slip`, `ready_to_ship`,
  `shipped`, `delivered`, …). Se queda en `shipped` **todo** el tramo del correo.
- `shipment.status` — el envío en manos del correo (`dispatched`, `in_post_office`,
  `out_for_delivery`, `not_delivered`, `returned`, `delivered`, …).

`shapeOrder()` resuelve el estado que ve el agente dando prioridad al del shipment cuando
existe, y lo traduce a un par `estado` + `detalle` en castellano (los mapas
`ORDER_STATUS` / `SHIPMENT_STATUS` en `shipnow.service.ts`). Si el correo informó una razón
de no entrega (`shipment.visits[].not_delivered_reason`) se agrega al detalle.

## Privacidad

**La única credencial es el número de orden**: no se verifica identidad antes de responder
(decisión de producto, 2026-09-11). Como los números de orden son secuenciales y adivinables,
`shapeOrder()` devuelve deliberadamente **sólo ciudad y provincia** del destino: nada de
nombre, email, teléfono, documento, dirección exacta ni precios.

Si en algún momento se quiere endurecer esto, el cambio es pedirle al comprador un segundo
dato (email o DNI) y matchearlo contra `ship_to` antes de devolver el estado.

## Mapa de archivos

**backend-js**
- `db/migrations/shipnow_connections.sql` — tabla de conexión (RLS on, sin policies) + el
  tipo `shipnow` en el CHECK de `agent_tools.type`.
- `src/services/shipnow-api.service.ts` — cliente HTTP crudo (Bearer + 404 → null).
- `src/services/shipnow.service.ts` — conexión por `client_id`, búsqueda del pedido y shaping.
- `src/routes/shipnow.route.ts` — `/status`, `/connect`, `/disconnect` y `/orders`
  (este último es el que consume la tool).

**agente-tilegra** (runtime LangGraph)
- `app/tools/api_tools.py` — builder `_shipnow_tool`, tipo `shipnow`, acción
  `get_shipment_status`, argumento `numero_de_orden`.

**dashboard-tilegra**
- `lib/shipnow.ts` + `app/api/auth/shipnow/{connect,status,disconnect}` — el `api_token`
  nunca se persiste ni se lee desde el dashboard: se reenvía al backend.
- `app/dashboard/integrations/` — card con el diálogo para pegar el token.
- `components/workflows/tool-form-dialog.tsx`, `agent-tools-panel.tsx`,
  `components/agents/tabs/task-wheel-dialog.tsx` — alta de la tool.

No se tocó `lib/tools.ts` (el ejecutor de n8n): n8n ya no se usa, el único runtime es
LangGraph.

## Deploy

1. Correr `db/migrations/shipnow_connections.sql` en Supabase (incluye el CHECK de
   `agent_tools.type`: sin eso, crear la tool devuelve 500).
2. Deployar backend-js y dashboard-tilegra.
3. En el dashboard: Integraciones → shipnow → pegar el token (se valida contra la API al
   guardar) → en el agente, agregar la tarea "Estado del envío" y activarla.
