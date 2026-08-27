# MercadoLibre como canal

Plan de implementación.

**Estado (2026-08-26):** backend implementado en `src/` — typecheck en verde.
Falta: correr `db/migrations/mercadolibre_channel.sql`, dar de alta la app en el
gestor de MercadoLibre (redirect URI + callback + tópicos `orders_v2` y `messages`),
completar las `MERCADOLIBRE_*` del `.env`, y la parte del dashboard (botón de conectar
+ campo de plantilla).

## Contexto

Hoy un agente de Tilegra atiende por WhatsApp (Evolution), los canales de Unipile y el
snippet web. El vínculo agente↔canal vive en `unipile_inboxes.workflow_id` y todo lo que
cuelga de ahí — facturación por usos, corte de ciclo de vida, envío saliente, bandeja del
dashboard — es agnóstico del proveedor.

Queremos sumar **MercadoLibre** con dos capacidades:

1. **Trigger de venta confirmada** → cuando una orden pasa a `paid`, mandarle un DM al
   comprador avisándole que salió todo bien.
2. **Responder los DMs entrantes** con el agente, igual que hoy con WhatsApp.

La apuesta de diseño es **no inventar un canal nuevo**: ML entra como una fila más de
`unipile_inboxes` con `source='mercadolibre'`, y reusa `outgoing-message.service` y
`dispatchToRuntime`. Todo lo que ya funciona (suspensión por impago, créditos, bandeja,
escalación a humano) queda gratis.

---

## Lo que MercadoLibre permite — y lo que NO

Esto condiciona el diseño entero, así que va primero.

| Restricción | Consecuencia |
|---|---|
| **El vendedor no puede iniciar una conversación** por `POST /messages/packs/…` — devuelve `blocked_by_conversation_started_by_seller`. | El aviso de venta confirmada **debe** salir por el *action guide*. |
| El action guide (`option_id: "OTHER"`) es texto libre pero de **350 caracteres** y con **cupo** (`cap_available`, normalmente 1 por conversación). | La plantilla se valida a 350 chars al guardarla, y se chequea el cupo antes de postear. |
| Los mensajes pasan por **moderación**. Un motivo de rechazo es literalmente `AUTOMATIC_MESSAGE`; otros: `PERSONAL_DATA`, `SOCIAL_NETWORK_LINK`, `LINK_MERCADOPAGO`. | El POST devuelve 200 con `status: "moderated"`. Hay que persistir ese estado y mostrarlo, no asumir que se entregó. |
| Desde el 20/01/2025 la opción `OTHER` **no está disponible si el envío ya figura "Entregado"** (por ahora MEC/MPE/MLU/MCO/MLM/MLC, se extiende a MLB y MLA). | Disparar el aviso en `paid`, temprano, no esperar al envío. |
| Mensajería **bloqueada en órdenes `cancelled`**, y en compras Full no entregadas. | Filtrar antes de intentar. |
| Desde el 02/02/2026 hay una **capa de agentes de IA** intermediando (MLB y MLC primero). El `to.user_id` deja de ser el comprador real y pasa a ser el ID del agente del país (MLA: `3037674934`). | Nunca hardcodear el destinatario: se toma del `from.user_id` del último entrante. Ver abajo. |
| **Una sola callback URL por aplicación** y ML **no firma** las notificaciones (a diferencia de MercadoPago, que manda `x-signature`). | Secreto en el path + validación de `application_id` y `user_id`. |
| Hay que responder **200 en menos de 500 ms** o ML da de baja el tópico. Reintenta 5 veces en 1 h; lo perdido queda en `GET /missed_feeds?app_id=…`. | El handler ACKea primero y procesa en `setImmediate`. |
| `access_token` dura 6 h y el `refresh_token` es **de un solo uso y rotativo**. | Refresh serializado por conexión; se persiste el nuevo refresh en la misma escritura. |
| Rate limits: 500 rpm compartido entre los GET de mensajería, 500 rpm entre los POST/PUT. | Suficiente para el volumen actual; no hace falta cola. |

**Decisiones tomadas:** el mensaje de venta confirmada es una **plantilla del cliente con
variables** (no generado por LLM — determinista contra el límite de 350 y menos riesgo de
moderación); el alcance de esta fase son **solo los DMs** (el tópico `questions`, las
preguntas pre-venta, queda para después); y el webhook se protege con **secreto en el path**.

---

## Modelo de datos

### 1. Migración: habilitar el source

`db/migrations/mercadolibre_channel.sql`

```sql
alter table unipile_inboxes drop constraint unipile_inboxes_source_check;
alter table unipile_inboxes add constraint unipile_inboxes_source_check
  check (source in ('unipile','evolution','mercadolibre'));
```

El inbox de ML queda así:

- `source = 'mercadolibre'`
- `provider = 'MERCADOLIBRE'` (sin CHECK, es texto libre — igual que `'WHATSAPP'` / `'WEB'`)
- `account_id = <ml_user_id>` (el seller id de ML) — el `UNIQUE (client_id, account_id)` que
  ya existe nos da la idempotencia al reconectar
- `display_name = <nickname de ML>`

Esto hace que `outgoing-message.service.ts:60-63` resuelva el inbox sin tocarlo: ya busca por
`account_id.eq.${chat.account_id}`.

### 2. Tabla nueva: `mercadolibre_connections`

Análoga a `tiendanube_connections` ([tiendanube.service.ts](src/services/tiendanube.service.ts)),
pero con la rotación de tokens que TiendaNube no tiene.

```sql
create table mercadolibre_connections (
  id            bigint generated always as identity primary key,
  client_id     integer not null references client(client_id) on delete cascade,
  ml_user_id    bigint  not null unique,        -- clave de resolución del webhook
  site_id       text    not null,               -- MLA, MLB, …
  nickname      text,
  access_token  text    not null,
  refresh_token text    not null,
  expires_at    timestamptz not null,
  scope         text,
  connected_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

`ml_user_id` es UNIQUE global porque la notificación solo trae `user_id`: es lo único que
tenemos para mapear notificación → cliente. Una cuenta de ML pertenece a un solo workspace.

### 3. Tabla nueva: `mercadolibre_orders`

Idempotencia del trigger. `orders_v2` dispara en **cada** cambio de la orden, no solo al
pagarse, así que sin esto mandamos el DM N veces.

```sql
create table mercadolibre_orders (
  order_id     bigint primary key,
  ml_user_id   bigint not null,
  client_id    integer not null references client(client_id) on delete cascade,
  pack_id      bigint,                -- null en órdenes simples → se usa order_id
  status       text   not null,
  buyer_id     bigint,
  buyer_name   text,
  greeted_at   timestamptz,           -- cuándo salió el DM de venta confirmada
  greet_status text,                  -- sent | moderated | blocked | no_cap | failed
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
```

El DM sale solo si `status='paid'` y `greeted_at is null`. La escritura de `greeted_at` va
**antes** del POST a ML (claim optimista) para que dos notificaciones concurrentes no lo
dupliquen; si el POST falla se marca `greet_status='failed'` y se puede reintentar a mano.

### 4. Plantilla del mensaje

Columna nueva en `unipile_inboxes` (es config del canal, no del agente):

```sql
alter table unipile_inboxes add column ml_sale_template text;
```

Variables soportadas: `{comprador}`, `{producto}`, `{orden}`, `{total}`. Se renderiza y se
valida ≤350 chars. Si está en `null`, el canal no manda nada al confirmarse la venta — el
trigger es opt-in.

### 5. Chats

Un chat por **pack** (una conversación de ML vive a nivel pack, no de orden):

- `chat_id = ml:{ml_user_id}:{pack_id}` — mismo criterio de prefijo que Evolution
  (`${instance}:${remoteJid}`), para que sea único global
- `account_id = {ml_user_id}` → resuelve el inbox
- `contact_handle = {pack_id}` → el saliente **no parsea el `chat_id`**, lee de acá el pack.
  Es exactamente el comentario que ya está en [outgoing-message.service.ts:88-91](src/services/outgoing-message.service.ts#L88-L91)
- `contact_name = {buyer nickname}` (ML no expone nombre y apellido por privacidad)
- `provider = 'MERCADOLIBRE'`

---

## Flujos

### A. OAuth (multi-tenant, un solo app de ML para todos los clientes)

Calcado de TiendaNube ([tiendanube-oauth.route.ts](src/routes/tiendanube-oauth.route.ts)),
reusando **tal cual** `signState` / `verifyState` de [oauth-state.ts](src/lib/oauth-state.ts).

```
dashboard (sesión) → firma state con INTERNAL_API_KEY
  GET /api/mercadolibre/oauth/connect?state=…
    → verifyState → re-firma → redirect a
      https://auth.mercadolibre.com.ar/authorization
        ?response_type=code&client_id=$APP_ID&redirect_uri=$STATIC&state=…
  GET /api/mercadolibre/oauth/callback?code=&state=
    → POST https://api.mercadolibre.com/oauth/token  (grant_type=authorization_code)
    → GET  https://api.mercadolibre.com/users/me     (nickname, site_id)
    → upsert mercadolibre_connections
    → upsert unipile_inboxes (source='mercadolibre', account_id=ml_user_id)
    → redirect a DASHBOARD_URL/dashboard/integrations?mercadolibre=connected
```

El `redirect_uri` **no puede tener información variable** (lo exige ML), por eso el
`client_id` viaja en el `state` firmado — igual que en TiendaNube y Google.

**Refresh de token.** El `refresh_token` es de un solo uso: dos requests concurrentes que
refresquen la misma conexión invalidan el token de la otra. Como backend-js corre **una sola
instancia** (ver `docs/` sobre la decisión de posponer Redis), alcanza un mutex en memoria
`Map<ml_user_id, Promise<string>>` dentro del servicio. Se refresca con 10 min de margen
sobre `expires_at`, no en cada llamada.

### B. Webhook de notificaciones

`POST /api/webhooks/mercadolibre/:secret` — plugin nuevo registrado dentro de
[webhooks/index.ts](src/routes/webhooks/index.ts), así hereda el patrón de webhooks públicos
que ya **no** pasan por `internalTokenAuth`.

```
1. :secret === MERCADOLIBRE_WEBHOOK_SECRET  → si no, 404 (no 401: no confirmamos la ruta)
2. body.application_id === MERCADOLIBRE_APP_ID → si no, 200 { skipped }
3. reply.send({ ok: true })            ← ACK ANTES de tocar la DB (presupuesto: 500 ms)
4. setImmediate(() => procesar(body))
```

Esto es distinto de [evolution.route.ts](src/routes/webhooks/evolution.route.ts), que hace todo
el trabajo de DB antes de responder. Evolution no tiene presupuesto de latencia; ML sí, y si
lo excedés te da de baja el tópico.

**Tópicos a suscribir en el gestor de aplicaciones de ML:** `orders_v2` y `messages`.

### C. Trigger: venta confirmada

```
topic orders_v2, resource "/orders/2195160686", user_id = seller
  → resolver conexión por ml_user_id  (si no existe → skip)
  → inbox suspendido? → skip           (mismo guard que evolution-webhook.service.ts:106)
  → GET /orders/{id}
  → status !== 'paid'  → upsert mercadolibre_orders y salir
  → ya greeted_at      → salir
  → inbox.ml_sale_template null → salir (opt-in)
  → GET /messages/action_guide/packs/{pack}?tag=post_sale
      · 400 blocked_by_excepted_case → esta orden NO usa action guide:
        se puede mandar por POST /messages/packs/… directo
      · options[OTHER].cap_available === 0 → greet_status='no_cap', salir
  → renderizar plantilla (≤350 chars)
  → claim: update greeted_at = now()
  → POST /messages/action_guide/packs/{pack}/option?tag=post_sale
      { "option_id": "OTHER", "text": "…" }
  → persistir el saliente: upsert unipile_chats + insert unipile_messages
    (direction='outgoing', message_id = el id que devuelve ML)
  → greet_status = response.status === 'moderated' ? 'moderated' : 'sent'
```

El chat queda creado **antes** de que el comprador conteste, así el mensaje aparece en la
bandeja del dashboard desde el minuto cero.

### D. DMs entrantes → agente

```
topic messages, actions ["created"], resource "<message_id>", user_id = seller
  → resolver conexión por ml_user_id
  → GET /messages/{message_id}?tag=post_sale
  → from.user_id === ml_user_id → skip (es nuestro propio eco)
  → pack_id sale de message_resources[] donde name === 'packs'
  → upsert unipile_chats + insert unipile_messages (direction='incoming')
      · el UNIQUE (message_id) dedupea los reintentos de ML: 23505 → ignorar,
        idéntico a lo que ya hace evolution-webhook.service.ts
  → increment_unipile_unread (RPC que ya existe)
  → si chat.state === 'ia' && chat.workflow_id:
      setImmediate → dispatchToRuntime(payload, workflow_id, 'mercadolibre', log)
```

`dispatchToRuntime` ([agent-runtime.service.ts:180](src/services/agent-runtime.service.ts#L180))
**no se toca**: ya recibe el canal como string y lo pasa en `context.channel` al runtime, y
después llama a `outgoingMessageService.sendOutgoing`, que es donde enganchamos el envío.

### E. Envío saliente

En [outgoing-message.service.ts](src/services/outgoing-message.service.ts), una rama más junto
a las de Evolution y Unipile:

```ts
} else if (inbox.source === 'mercadolibre') {
  const packId = chat.contact_handle;          // sin parsear chat_id
  const resp = await mercadolibreApiService.sendMessage({ mlUserId, packId, text });
  messageId = resp.id ?? randomUUID();
}
```

La lógica de **qué endpoint usar** vive en el api service:

```
¿hay algún unipile_messages con direction='incoming' en este chat?
  SÍ  → el comprador ya escribió → POST /messages/packs/{pack}/sellers/{seller}?tag=post_sale
        to.user_id = from.user_id del ÚLTIMO entrante   ← sobrevive a la capa de agentes de IA
  NO  → seller-initiated → POST /messages/action_guide/packs/{pack}/option  { option_id:"OTHER", text }
fallback: si el POST directo devuelve blocked_by_conversation_started_by_seller → reintentar por action guide
```

Tomar el `to.user_id` del último entrante es lo que hace que la migración de febrero 2026 (donde
el destinatario pasa a ser el agente de IA de ML y no el comprador) no nos rompa: si ML nos habla
a través del agente, le contestamos al agente. La tabla de IDs por país queda solo como fallback
para el caso raro de un chat sin entrantes.

**Los 350 chars:** `sendOutgoing` trunca y loguea. Además hay que pasarle el límite al runtime —
`agente-tilegra` ya recibe `context.channel`, así que la instrucción "máximo 350 caracteres,
sin links ni datos de contacto" se agrega ahí, no acá.

---

## Archivos

**Nuevos**

| Archivo | Qué hace |
|---|---|
| `src/services/mercadolibre-api.service.ts` | Cliente HTTP puro de la API de ML: `exchangeCode`, `refreshToken`, `fetchMe`, `fetchOrder`, `fetchMessage`, `fetchActionGuide`, `sendActionGuideMessage`, `sendPackMessage`. Espejo de [tiendanube-api.service.ts](src/services/tiendanube-api.service.ts). |
| `src/services/mercadolibre.service.ts` | Conexiones + tokens + mutex de refresh + `getValidToken(mlUserId)`. Espejo de [tiendanube.service.ts](src/services/tiendanube.service.ts). |
| `src/services/mercadolibre-webhook.service.ts` | `processOrder` y `processMessage`. Espejo de [evolution-webhook.service.ts](src/services/evolution-webhook.service.ts). |
| `src/routes/mercadolibre-oauth.route.ts` | `/connect` y `/callback`, públicos. Espejo de [tiendanube-oauth.route.ts](src/routes/tiendanube-oauth.route.ts). |
| `src/routes/webhooks/mercadolibre.route.ts` | El callback único de ML. |
| `src/types/mercadolibre.ts` | Tipos de los payloads. |
| `db/migrations/mercadolibre_channel.sql` | Las 4 migraciones de arriba. |

**Modificados**

| Archivo | Cambio |
|---|---|
| [src/routes/index.ts](src/routes/index.ts) | Registrar `mercadolibreOauthRoutes` bajo `/api/mercadolibre`, fuera del scope `/api` autenticado (lo pega el navegador). |
| [src/routes/webhooks/index.ts](src/routes/webhooks/index.ts) | Registrar el plugin del webhook. |
| [src/services/outgoing-message.service.ts](src/services/outgoing-message.service.ts) | La rama `source === 'mercadolibre'`. |
| [src/services/channel-disconnect.service.ts](src/services/channel-disconnect.service.ts) | Rama de ML: **no** hay cuenta que destruir en el proveedor; se borra la fila de `mercadolibre_connections` (revoca el acceso) y se suspende el inbox. |
| `.env.example` | Las variables de abajo, documentadas como el resto. |

**Del lado del dashboard** (fuera de este repo): botón "Conectar MercadoLibre" en
`/dashboard/integrations` que firma el state y redirige, y el campo de plantilla en la config
del canal con contador de 350 chars.

---

## Variables de entorno

```bash
# MercadoLibre. OAuth multi-tenant con refresh rotativo (access_token 6 h, refresh de un
# solo uso). APP_ID y CLIENT_SECRET vienen del gestor de aplicaciones de ML. REDIRECT_URI
# debe matchear EXACTO el registrado y no puede tener información variable — el client_id
# viaja en el `state` firmado con INTERNAL_API_KEY.
MERCADOLIBRE_APP_ID=
MERCADOLIBRE_CLIENT_SECRET=
MERCADOLIBRE_REDIRECT_URI=
# Dominio del authorize según el país del vendedor (default MLA).
MERCADOLIBRE_AUTH_DOMAIN=https://auth.mercadolibre.com.ar
# ML no firma las notificaciones: el secreto va en el path de la callback, que se configura
# en el gestor de aplicaciones como <PUBLIC_URL>/api/webhooks/mercadolibre/<este valor>.
MERCADOLIBRE_WEBHOOK_SECRET=
```

---

## Verificación

ML tiene **usuarios de test**, que es la única forma sensata de probar esto sin vender algo real.

1. `POST /users/test_user` con el token de la app → crea vendedor y comprador de prueba.
2. **OAuth:** entrar a `/api/mercadolibre/oauth/connect?state=…` con el vendedor de test,
   confirmar que se crean la fila en `mercadolibre_connections` y el inbox en
   `unipile_inboxes` con `source='mercadolibre'`.
3. **Refresh:** forzar `expires_at` al pasado en la DB y hacer cualquier llamada; verificar que
   el `refresh_token` rota y que la fila queda con el nuevo.
4. **Webhook:** `curl -X POST` contra `/api/webhooks/mercadolibre/<secret>` con un payload de
   `orders_v2` armado a mano. Verificar en los logs que el ACK sale antes del procesamiento.
   Con secret incorrecto: 404.
5. **Trigger:** publicar un ítem barato con el vendedor de test, comprarlo con el comprador de
   test, y ver el DM llegar. Chequear `mercadolibre_orders.greet_status` y que una segunda
   notificación de la misma orden **no** dispare un segundo mensaje.
6. **Entrantes:** contestar desde el comprador de test → el chat aparece en la bandeja, el
   agente responde, y `agentuse` registra el uso con `channel='mercadolibre'`.
7. **Moderación:** mandar a propósito una plantilla con un teléfono adentro y confirmar que
   vuelve `status: "moderated"` y que lo persistimos como tal en vez de cantar éxito.

`pnpm typecheck` y `pnpm lint` en cada paso. El server lo levantás vos con `pnpm dev`.

---

## Riesgos

- **Moderación silenciosa.** El POST devuelve 200 aunque el mensaje sea rechazado; el comprador
  nunca lo ve. Sin persistir `message_moderation.status` el cliente cree que avisó y no avisó.
- **`cap_available` agotado.** Si el vendedor ya usó su cupo desde la app de ML, nuestro DM no
  sale. Es esperable, no es un bug: hay que mostrarlo en el dashboard.
- **Un solo `redirect_uri` por app, y por dominio de país.** El `authorize` es
  `auth.mercadolibre.com.ar` para MLA, `.com.br` para MLB, etc. Con MERCADOLIBRE_AUTH_DOMAIN
  cubrimos Argentina; multi-país necesita elegir el dominio antes del redirect.
- **La capa de agentes de IA de ML (feb 2026).** Está anunciada para MLB y MLC pero la tabla de
  IDs ya incluye MLA. Derivar el `to.user_id` del último entrante nos cubre; hardcodear el
  comprador, no.
- **Notificaciones perdidas.** Si el backend está caído más de 1 h, ML deja de reintentar. Si
  esto pasa a importar, un cron que barra `GET /missed_feeds?app_id=…` lo resuelve — no entra
  en esta fase.
- **4 meses sin usar la API invalidan el grant.** Un cliente con el canal conectado pero inactivo
  pierde el token en silencio. Detectable por el 403 en el primer envío.
