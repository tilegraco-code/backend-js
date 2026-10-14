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

## dashboard-tilegra

- `lib/{tiendanube,woocommerce,shipnow}.ts`: `listConnections` (la principal primero, sin
  credenciales) + `toStoreOption`. `getConnection` devuelve la principal (ya no `maybeSingle`).
- `/api/auth/*/status` suma `stores: StoreOption[]`.
- `/api/auth/*/disconnect` recibe `{ connection_id }` y desconecta solo esa tienda. Bloquea
  (409) si hay tools que la usan: las que la apuntan por id y, si es la principal, también las
  que no tienen id (si no, pasarían en silencio a usar otra tienda). Ver
  `lib/integration-connections.ts`.
- Integraciones: cada proveedor lista sus tiendas, con "Desconectar" en cada una y un botón
  "Agregar otra". Para sumar otra tienda de TiendaNube hay que estar logueado en ESA tienda
  dentro de TiendaNube, porque su OAuth autoriza la tienda de la sesión.
- Editor de la tool: con más de una tienda aparece el selector "Tienda". `config.connection_id`
  se guarda siempre, aunque haya una sola tienda, así una tienda nueva no cambia lo que ya existe.
- Con más de una tienda, el nombre de la tool lleva un sufijo con la tienda
  (`tiendanube_buscar_productos_mayorista`) y la descripción arranca con `Tienda "X".`. Dos tools
  con el mismo nombre en un agente rompen la llamada al modelo.
