# Varias tiendas por cliente (TiendaNube / WooCommerce / shipnow)

## Problema

Las conexiones eran 1 por cliente (`unique(client_id)` en `*_connections`). Hay clientes con
más de una tienda (o cuenta de shipnow) que quieren asignar cada una a uno o varios agentes.

MercadoLibre queda afuera: ya es multi-cuenta (`ml_user_id` es la clave, y la config va por
`(client_id, ml_user_id)` en `mercadolibre_settings`). Google y Composio siguen a nivel cuenta.

## Diseño

- **La conexión es una tienda.** Un cliente puede tener N filas por proveedor. Su clave natural
  es `(client_id, store_id)` en TiendaNube, `(client_id, store_url)` en WooCommerce y
  `(client_id, api_token)` en shipnow. Reconectar la misma tienda actualiza la fila, así que el
  id no cambia y las tools no se rompen.
- **Cada tool elige su tienda** en `agent_tools.config.connection_id`. Va en `config` y no en
  una columna porque el dashboard ya lo edita y `runtime-config` ya se lo manda al runtime. Por
  eso `agent_tools` no se migra. "Una tienda para varios agentes" es simplemente que varias tools
  apunten al mismo id.
- **Sin `connection_id` se usa la principal (la conexión más vieja del cliente).** Es lo que
  mantiene funcionando las tools existentes, el runtime viejo y el dashboard viejo. Ver
  `src/lib/integration-connection.ts`.
- **Con un `connection_id` que no existe (o que es de otro cliente) se responde error y NO se
  cae a otra tienda.** Venderle al comprador del catálogo equivocado es peor que avisar.
- **El caché pasa a ser por tienda** (`connection_id, resource`), con FK y `on delete cascade`.
- En el checkout de WooCommerce manda la tienda que está en la config de la tool (ya se lee por
  el envío). Si la config no tiene tienda, se usa la que mande el runtime.

## Contrato de backend-js

- Todas las rutas de tools aceptan un `connection_id` opcional (query en los GET, body en los POST).
- `GET /status` (de los 3 proveedores) suma `connections: [...]` y mantiene los campos sueltos
  con la conexión principal.
- `POST /connect` (Woo / shipnow) devuelve el `id`. En shipnow, `connection_id` en el body
  reemplaza el token de esa cuenta.
- `POST /disconnect` (Woo / shipnow) acepta `connection_id`. Sin él borra la principal.

## Deploy (en este orden, cada paso es compatible con el anterior)

1. **`db/migrations/multi_connections.sql`**: es aditiva y deja el `unique(client_id)`. Agrega
   las claves naturales, `connection_id` en los cachés y un trigger que actúa de puente para las
   filas de caché que escriba el backend viejo.
2. **Deploy de backend-js.**
3. **`db/migrations/multi_connections_drop_client_unique.sql`**: saca `unique(client_id)` y el
   puente. Desde acá se puede conectar una segunda tienda.
   - Entre los pasos 2 y 3, conectar una tienda DISTINTA a la que el cliente ya tiene falla con
     error de unique, cuando antes la reemplazaba. Hay que correr el paso 3 enseguida.
4. **Deploy de agente-tilegra**: manda `config.connection_id` como `connection_id`. Puede ir en
   cualquier momento después del paso 2.
5. **Dashboard** (pendiente, ver abajo). Es el que le permite al cliente tener más de una tienda.

## Pendiente: dashboard-tilegra

Hay que hacerlo ANTES de dejar que un cliente conecte la segunda tienda, porque hoy el
dashboard asume que hay una sola conexión:

- `lib/tiendanube.ts`, `lib/woocommerce.ts` y `lib/shipnow.ts` leen `*_connections` con
  `.eq("client_id")`. Si usan `.single()` o `.maybeSingle()` revientan con 2 filas.
- `app/api/auth/tiendanube/disconnect` borra por `client_id` (se lleva todas las tiendas) y
  bloquea si hay CUALQUIER tool de TiendaNube. Tiene que pasar a desconectar por `connection_id`
  y bloquear solo si hay tools que apuntan a esa conexión, o tools sin `connection_id` cuando la
  que se borra es la principal. Revisar lo mismo en los disconnect de Woo y shipnow.
- Integraciones: listar las tiendas de cada proveedor y agregar un botón "Agregar otra tienda".
  En TiendaNube el OAuth agrega solo, por la clave natural.
- Editor de la tool (`lib/tools.ts`): un selector de tienda que guarde `config.connection_id`.
  Mostrarlo solo si el cliente tiene más de una, y mostrar "principal" cuando no hay id.
- `app/api/tiendanube/[resource]` (tester): pasar `connection_id`.
