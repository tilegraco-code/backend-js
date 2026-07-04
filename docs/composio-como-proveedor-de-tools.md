# Plan: Composio como proveedor de tools

## Contexto

Hoy cada integración nueva en Tilegra se buildea a mano: tipo nuevo en `AgentToolType`,
executor, OAuth completo por proveedor (tabla `*_connections`, refresh de tokens, rutas
connect/callback con state firmado), UI y descripciones curadas. La sección B del
[checklist](agregar-tool-checklist.md) (todo el plumbing de OAuth) es el costo real y se
repite por proveedor.

Composio es un proveedor gestionado de 1000+ tools estandarizadas: maneja la auth
multi-tenant (guarda y refresca los tokens del lado de ellos), expone cada tool con
JSON Schema tipado, y se ejecuta pasando un `userId` (= nuestro `client_id`).

**Objetivo:** agregar UN tipo de tool genérico `composio` que permita dar de alta
cualquier tool de Composio **sin deploy de código** — sólo elegir toolkit + slug en la
UI. Resultado: el long-tail de integraciones (Gmail, Slack, Notion, HubSpot…) deja de
requerir código; lo nativo sensible (Calendar, Sheets, TiendaNube, Cal.com) se queda como
está.

### Decisiones tomadas
1. **Integración:** por el flujo actual — n8n → `/api/tools/run` → `runTool` → backend ejecuta vía Composio SDK. Un solo camino, reusa toda la infra de `agent_tools`.
2. **Alcance:** *Composio primero* — toda integración nueva entra por Composio; nativo sólo si Composio no la tiene (ej. TiendaNube). Por eso el tipo es **genérico** (config = toolkit + slug), no un union de acciones hardcodeadas.
3. **Auth:** auth por defecto de Composio (sin BYO OAuth). Composio guarda los tokens → **no necesitamos tabla de tokens ni rutas callback propias**.

### Simplificaciones que habilitan las decisiones
- **Sin `composio_connections` con tokens** — Composio es el store. El `userId` de Composio = `String(client_id)`. El status se consulta a Composio.
- **Sin ruta `/oauth/callback` propia** — el callback lo maneja la página hosted de Composio (la del "Secured by Composio"). Nosotros sólo pedimos `redirectUrl` y consultamos status.
- **Sin spike de n8n** — el input tipado por campo ya está implementado (`toolPlaceholders` en `dashboard-tilegra/lib/n8n.ts`).
- **Env mínima:** sólo `COMPOSIO_API_KEY` (no hay OAuth creds por proveedor).

---

## Arquitectura del flujo

```
Alta (config, sin código):
  UI integraciones → browse toolkits/tools (proxy → backend → Composio)
   → conectar cuenta del cliente (redirectUrl hosted de Composio)
   → elegir slug → guarda agent_tool { type:"composio", config:{toolkit, slug, inputSchema} }

Ejecución (runtime):
  n8n AI Agent → tool__<name> (nodo con input tipado desde inputSchema)
   → POST app.tilegra.com/api/tools/run?tool_id=X
   → runTool() resuelve client_id (agent→project→client_id)
   → runComposio(config, args, clientId)
   → POST BACKEND_PUBLIC_URL/api/composio/execute { client_id, slug, arguments }
   → composio.tools.execute(slug, { userId: String(client_id), arguments })
   → texto de vuelta a n8n
```

---

## Cambios — Backend (`backend-js`)

### 1. SDK + env
- Dependencia: `@composio/core` (SDK TS v3).
- `.env` / `.env.example`: `COMPOSIO_API_KEY=`.

### 2. `src/services/composio.service.ts` (nuevo)
Wrapper del SDK `@composio/core` v3 (mismo estilo que `tiendanube-api.service.ts`). **Firmas reales confirmadas en la doc oficial:**
- `client()` → `new Composio({ apiKey: COMPOSIO_API_KEY })` (lazy, valida env como `getCreds()`).
- `getOrCreateAuthConfig(toolkit): Promise<string>` — resuelve el `authConfigId` (`"ac_..."`) del toolkit. **`initiate()` lo exige y hay uno por toolkit.** Con credenciales gestionadas: buscar el existente (`authConfigs.list`) o crearlo una vez (`authConfigs.create`, sin togglear "use your own credentials"). Cachear el map `toolkit→authConfigId` (memoria o tabla chica). Es **una vez por toolkit, no por cliente**.
- `listToolkits()` — para browse en UI.
- `listTools(toolkit, search?)` — `composio.tools.getRawComposioTools({ toolkits:[toolkit], limit })` (schema **sin** userId).
- `getTool(slug)` — `composio.tools.getRawComposioToolBySlug(slug)` → guardar su input schema en config.
- `initiateConnection(clientId, toolkit)` — `composio.connectedAccounts.initiate(String(clientId), authConfigId, { callbackUrl })` → `{ redirectUrl, id }`. `callbackUrl` = página del dashboard que cierra el popup.
- `connectionStatus(clientId, toolkit)` — `connectedAccounts.list({ userIds:[String(clientId)] })` filtrando por toolkit → `{ connected, account? }`.
- `disconnect(clientId, toolkit)`.
- `execute(clientId, slug, args)` — `composio.tools.execute(slug, { userId:String(clientId), arguments: args })` → `{ data }`. Serializar `data` a texto para n8n.
- `class ComposioNotConnectedError extends Error` (mapea a 409, como `GoogleNotConnectedError`).

> No hay capa DB de tokens (Composio es el store; `userId = String(client_id)`). Lo único que puede persistirse es el map `toolkit→authConfigId` si no queremos consultarlo cada vez.

> **Auth gestionada vs BYO:** con credenciales por defecto de Composio el consent dice "Composio" y se comparte cuota — OK para validar. Para producción con muchos clientes la doc recomienda **BYO OAuth** (tu propia app) por toolkit importante (Google sobre todo). Migrable después cambiando el authConfig; no bloquea el MVP.

### 3. `src/routes/composio.route.ts` (nuevo, scope PROTEGIDO `/api/composio`)
Registrar en `src/routes/index.ts` dentro del bloque con `internalTokenAuth` (como `googleRoutes`). Zod + el `handleError` 409/4xx/502 de `google.route.ts`:
- `GET /toolkits` → `listToolkits()`
- `GET /tools?toolkit=&search=` → `listTools()`
- `GET /tools/:slug` → `getTool()`
- `POST /connect` `{ client_id, toolkit }` → `{ redirectUrl, connectionId }`
- `GET /status?client_id=&toolkit=` → `{ connected, account }`
- `POST /disconnect` `{ client_id, toolkit }`
- `POST /execute` `{ client_id, slug, arguments }` → texto (lo llama `runComposio`)

> No hay `composio-oauth.route.ts` ni ruta pública: el callback OAuth lo absorbe la página hosted de Composio.

---

## Cambios — Dashboard (`dashboard-tilegra`)

### 4. `lib/definitions.ts`
- `AgentToolType` → agregar `"composio"`.
- Tipo nuevo:
  ```ts
  export type ComposioConfig = {
    toolkit: string;            // p.ej. "gmail"
    slug: string;               // p.ej. "GMAIL_SEND_EMAIL"
    inputSchema?: JSONSchema;   // snapshot del schema de Composio al crear la tool
  };
  ```

### 5. `lib/tools.ts`
- `runComposio(config: ComposioConfig, args, clientId)` → POST `BACKEND_PUBLIC_URL/api/composio/execute` con `Authorization: Bearer INTERNAL_API_KEY`, body `{ client_id, slug: config.slug, arguments: args }`. Devuelve texto.
- En `runTool` (`lib/tools.ts`, dispatch ~línea 632) agregar branch `composio` **antes** del throw final; resuelve `clientId` igual que los demás y pasa `args` (objeto tipado, no `inputStr`).

### 6. `lib/n8n.ts` — input tipado
- En `toolPlaceholders` (`lib/n8n.ts` ~línea 272) agregar branch:
  ```ts
  if (tool.type === "composio") {
    const schema = tool.config?.inputSchema as JSONSchema | undefined;
    return schemaToPlaceholders(schema); // props → [{name, description, type:"string"}]
  }
  ```
- `schemaToPlaceholders(schema)`: mapea `schema.properties` a `Placeholder[]`. Mantener `type:"string"` (consistente con `jsonBodyFromPlaceholders`, que serializa todo como string). **Campos anidados (object/array):** declararlos como string con la descripción indicando "JSON" y que el backend los parsee. Anotar como caso a validar.

### 7. `app/api/tools/[id]/route.ts`
- Agregar `"composio"` al whitelist de tipos.

### 8. Migración Supabase — `agent_tools_type_check`
- `drop constraint agent_tools_type_check` + recrear con `'composio'` en el array (mismo paso que documenta el checklist para `google_calendar`).

### 9. UI
- **Proxy routes** (auth por sesión con `getUserWithClient`, reenvían al backend con `INTERNAL_API_KEY`):
  - `app/api/composio/toolkits/route.ts`, `app/api/composio/tools/route.ts` (browse/picker en vivo).
  - `app/api/auth/composio/{connect,status,disconnect}/route.ts` (mismo patrón que las cards OAuth existentes).
- **`components/workflows/agent-tools-panel.tsx`**: card "Composio" en `INTEGRATIONS` + `TYPE_META` (logo/label). En vez de acciones fijas, abre un browser de toolkits/tools.
- **`components/workflows/tool-form-dialog.tsx`**: flujo nuevo para `composio`:
  1. Elegir toolkit (de `/api/composio/toolkits`).
  2. Mostrar status de conexión (`/api/auth/composio/status`); si no conectado → botón "Conectar" que abre el `redirectUrl` hosted en popup y pollea status.
  3. Elegir tool/slug (de `/api/composio/tools?toolkit=`).
  4. Prefilear `name` (snake_case del slug) y `description` desde Composio (editable).
  5. `handleSave`: guardar `config = { toolkit, slug, inputSchema }` (snapshot del schema al momento) vía POST `/api/agents/{agentId}/tools`.

---

## Estado de implementación

- **Fase 1 (backend): COMPLETA y verificada** end-to-end en localhost (toolkits/tools/connect/status/execute con cuenta real).
- **Fase 2 (dashboard runtime): COMPLETA.** `definitions.ts` (`composio` + `ComposioConfig`), `runComposio` + branch en `runTool`, `composioPlaceholders` en `n8n.ts`, whitelist en `tools/[id]/route.ts`, entradas `composio` en los 3 mapas de UI por tipo. Typecheck limpio. **Migración `agent_tools_type_check` aplicada en prod** (proyecto Dashboard `mzfcauglytyerkxcqpgp`).
- **Fase 3 (UI): COMPLETA (piloto Gmail).** Proxy routes `/api/composio/{toolkits,tools}` + `/api/auth/composio/{status,connect,disconnect}`. Card "Composio" en el panel → `composio-tool-dialog.tsx`: flujo **search-first** (buscador de tools scope Gmail) → conectar cuenta (popup hosted + poll de status) → nombre/descripción editable → crear (tool `enabled:false`, se activa con el switch). Typecheck limpio. **Decisiones UX:** búsqueda global de tool + scope Gmail para validar.
  - **Pendientes menores:** (a) editar una tool composio con el lápiz abre el `ToolFormDialog` estándar que no conoce `composio` (por ahora usar toggle/borrar/recrear); (b) expandir de Gmail a selector de toolkit (el dialog tiene la constante `TOOLKIT`); (c) label de la tool en la lista muestra "Composio" genérico (se puede mostrar el slug).

## Orden de implementación

1. **Backend service + `/execute` + `/tools` + `/connect`/`/status`** (núcleo). Probar `/execute` con un slug (ej. `GMAIL_SEND_EMAIL`) y un `client_id` conectado a mano desde la consola de Composio.
2. **Dashboard runtime:** `definitions.ts` + `runComposio` + branch en `runTool` + whitelist + migración constraint + branch en `toolPlaceholders`. (Permite crear una tool composio "a mano" en DB y que el agente la ejecute.)
3. **UI:** proxies + card + form (browse/connect/pick). Cierra el "sin código".
4. **Deploy AMBOS** (dashboard ejecuta las tools; backend en easypanel) + cargar `COMPOSIO_API_KEY` en prod.

---

## Verificación (end-to-end)

1. **Backend aislado:** conectar un `client_id` de prueba a Gmail desde la consola/SDK de Composio → `POST /api/composio/execute { client_id, slug:"GMAIL_SEND_EMAIL", arguments:{...} }` devuelve OK. `typecheck`: `pnpm typecheck`.
2. **Conexión multi-tenant:** desde la UI, card Composio → Conectar Gmail → aparece la página hosted ("Successfully connected… Secured by Composio") → status pasa a conectado para ese `client_id`.
3. **Alta sin código:** elegir slug `GMAIL_SEND_EMAIL` → guardar tool → **activarla** (switch) → verificar en n8n que aparece el nodo `tool__<name>` con input **tipado** (placeholderDefinitions, no `input` string) conectado al "AI Agent".
4. **Ejecución real:** el agente invoca la tool → llega a `/api/tools/run` → `runComposio` → Composio ejecuta con el token del cliente → respuesta vuelve al agente.
5. Dashboard `npx tsc --noEmit`.

**Riesgos / a validar:**
- **(a) authConfig por toolkit (confirmado, resuelto en el plan):** `initiate()` exige `authConfigId` y hay uno por toolkit — hay que crearlo una vez (dashboard o `authConfigs.create` por SDK). Es setup por-toolkit (no por-cliente); `getOrCreateAuthConfig` lo absorbe. Confirmar el nombre exacto de `authConfigs.create/list` en el SDK al implementar.
- **(b) campos anidados (object/array)** en el input schema → confirmar que el modelo los completa bien como string-JSON y el backend los parsea.
- **(c) toolkits sin OAuth (API key / no-auth)** → el flujo de `connect` asume OAuth; manejar el caso "no requiere conexión".
- **(d) `callbackUrl` del popup** → definir una página del dashboard que cierre el popup y dispare el re-poll de status.

**Firmas SDK v3 verificadas (`@composio/core@0.13.1`, probado en localhost):** `new Composio({apiKey})` · `tools.execute(slug,{userId,arguments})→{data,error,successful}` · `tools.getRawComposioToolBySlug(slug)` / `getRawComposioTools({toolkits,search,limit})` (array, sin userId; el schema viene en `inputParameters`) · `toolkits.get()`→array · `authConfigs.list({toolkit,isComposioManaged})` / `authConfigs.create(toolkit,{type:'use_composio_managed_auth'})` · **`connectedAccounts.link(userId,authConfigId,{callbackUrl})→{redirectUrl,id}`** · `connectedAccounts.list({userIds,toolkitSlugs,statuses})→{items}`.

> **⚠️ Corrección verificada:** para auth GESTIONADA por Composio, `connectedAccounts.initiate()` está **retirado** (error 600 "no longer supported"). Hay que usar **`connectedAccounts.link()`** — misma firma y retorno (`redirectUrl`). El service ya usa `link`.

**Estado (verificado end-to-end en localhost con cuenta real conectada):** `/toolkits`, `/tools`, `/tools/:slug`, `/connect` (getOrCreateAuthConfig gestionado + link → redirectUrl hosted), `/status`, **`/execute`** (GMAIL_FETCH_EMAILS devolvió mails reales) ✅. **Fase 1 (backend) COMPLETA.**

> **Version check (verificado):** la ejecución manual exige versión de toolkit; el service pasa `dangerouslySkipVersionCheck: true` (= "latest"). **TODO producción:** guardar la versión del toolkit en `config` al crear la tool y pasarla en execute, para reproducibilidad.
