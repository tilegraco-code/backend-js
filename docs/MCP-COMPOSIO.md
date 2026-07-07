# MCP-COMPOSIO — pasar de tools determinísticas a MCP/agentic

## Por qué (contexto)

El modelo actual obliga al usuario a **elegir la tool** y **configurar campos** (ej. para agregar una fila a un Sheet: elegir `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` en vez de `CREATE_SPREADSHEET_ROW`, y fijar `range`, `valueInputOption`, etc.). Eso es un modelo **de developer**. La app apunta a **usuarios SIN conocimiento técnico** → es inviable.

**Reframe:** el usuario dice **QUÉ** quiere en lenguaje natural ("cuando alguien deja sus datos, agregalos a mi planilla de leads") y **conecta las apps**. El agente resuelve el **CÓMO** (qué tool, qué formato de args). Para eso: conectar el agente al **MCP de Composio** scopeado a las apps conectadas del cliente, y que elija/ejecute tools dinámicamente.

**Lo que NO cambia (y no se tira):** `agent_tasks` + el endpoint de system message del backend (el "cerebro"/prompt del agente) y **Integraciones** (conectar cuentas por OAuth). Solo cambia la **capa de ejecución de tools**.

---

## Investigación — factibilidad (confirmada)

### 1. Composio expone MCP per-usuario ✅
- **Crear config de servidor MCP** (SDK `@composio/core`):
  ```ts
  const server = await composio.mcp.create("tilegra-mcp", {
    toolkits: [{ authConfigId: "ac_...", toolkit: "gmail" },
               { authConfigId: "ac_...", toolkit: "googlesheets" }],
    allowedTools: ["GMAIL_SEND_EMAIL", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", ...], // opcional
  });
  ```
- **Generar URL scopeada por usuario:**
  ```ts
  const instance = await composio.mcp.generate(String(clientId), server.id);
  // instance.url → https://backend.composio.dev/v3/mcp/<SERVER_ID>?user_id=<clientId>
  ```
- **Auth del MCP:** header **`x-api-key: <COMPOSIO_API_KEY>`** (requerido por defecto en orgs nuevas).
- **Scoping por cliente:** el `user_id` de la URL = nuestro `client_id` → ejecuta con las **cuentas conectadas de ese cliente** (las de Integraciones). Aislamiento por-cliente vía la URL.
- `allowedTools` limita qué tools se exponen.
- **Tool Router / sessions (patrón recomendado por Composio para acceso dinámico):** `composio.create(userId)` + meta-tool **`COMPOSIO_SEARCH_TOOLS`** → el agente **busca en el catálogo** y usa cualquier tool. Mejor "MCP experience" (context management del lado de ellos), pero la **persistencia de la URL** para un cliente externo (n8n) no está clara en la doc → a validar.

### 2. n8n tiene nodo MCP Client Tool ✅
- Nodo **`@n8n/n8n-nodes-langchain.toolmcp`** (MCP Client Tool): se conecta a un servidor MCP y **expone sus tools al AI Agent**, que las descubre e invoca durante su razonamiento.
- Transporte: **Streamable HTTP** (moderno, recomendado) + SSE (deprecado).
- Auth: soporta **headers custom / multi-header** (credencial) → sirve para el `x-api-key`.
- Se conecta al AI Agent igual que hoy conectamos los `tool__*` (como sub-nodo `ai_tool`).

### 3. Nuestra base ya encaja
- **Integraciones** ya conecta cuentas (OAuth) y ya resolvemos `authConfigId` por toolkit (`getOrCreateAuthConfig`). El `mcp.create` referencia esos `authConfigId`.
- `createWorkflow` ya inyecta placeholders (backend URL, agent_id) → podemos inyectar la **MCP URL del cliente** al crear el workflow.

---

## Arquitectura propuesta

```
Integraciones: el cliente conecta apps (OAuth)  ── ya existe
        │
        ▼
Backend: para el cliente, MCP server config (toolkits + authConfigId) → mcp.generate(client_id)
        → MCP URL estable, scopeada al cliente
        │
        ▼
n8n (template): AI Agent ── ai_tool ── [MCP Client node → MCP URL del cliente + x-api-key]
        │
        ▼
El agente ve TODAS las tools de las apps conectadas del cliente y elige/ejecuta.
Tareas = lenguaje natural. Cero configuración de tools por parte del usuario.
```

**Qué pasa con cada pieza actual:**
- **Se queda:** `agent_tasks` + `/api/agents/:id/system-message` (cerebro/prompt), Integraciones.
- **Se agrega:** `mcpService` en backend (crear config + generar URL por cliente) + nodo MCP Client en el template de n8n.
- **Se simplifica:** el árbol de Tareas deja de tener el **picker de tools de Composio**; las tareas pasan a ser **solo instrucciones en lenguaje natural**.
- **Se relega a "avanzado" (no se borra):** el flujo determinístico actual (nodos `tool__*`, picker, `presetArgs`, placeholders/coerce, `/api/composio/execute`) queda como **modo pin-tool** para casos que necesiten garantía. Se puede apagar del default.

---

## El problema de "cuál recurso" (cuál planilla / calendario)

Alguien tiene que decir sobre qué recurso operar. Opciones (de más simple a más control):
1. **Lenguaje natural en la tarea** ("mi planilla Leads") + el agente lo resuelve con tools de búsqueda (`GOOGLESHEETS_...SEARCH` / `GET_SPREADSHEET_INFO`). Más natural para no-técnicos; depende de que el nombre sea único.
2. **Recurso por defecto por app** (elegido una vez con un picker amigable) inyectado en las llamadas. Más determinístico, pero **inyectar un default en llamadas MCP no es trivial** (las tools MCP toman args del agente) → requeriría una capa nuestra o el modo pin-tool.

Recomendación MVP: **(1) natural language + búsqueda**, y para lo que necesite exactitud, el **modo pin-tool avanzado** (con `presetArgs`, que ya existe).

---

## Preguntas a validar en un SPIKE (go/no-go antes de comprometerse)

1. **Scoping de toolkits:** ¿una config MCP global con todos los toolkits + `user_id` por cliente expone tools de apps que el cliente **NO** conectó (y falla al ejecutar), o Composio filtra por cuentas conectadas? Si expone de más → config **por-cliente** listando solo sus toolkits conectados (crear/actualizar al conectar/desconectar).
2. **Persistencia de la URL:** ¿`mcp.generate(server_id, user_id)` da una URL **estable** para hornear en n8n? (parece que sí; validar).
3. **n8n + Composio MCP end-to-end:** que el nodo MCP Client (Streamable HTTP + `x-api-key`) **descubra y ejecute** tools de Composio de verdad.
4. **Confiabilidad:** ¿el agente hace bien "agregá una fila a la planilla Leads" (elige `VALUES_APPEND`, resuelve el spreadsheet, arma el `values` 2D) **sin** que el usuario configure nada?
5. **Tool Router session vs MCP config estático:** cuál da mejor UX **y** una URL estable para n8n.
6. **Costo/latencia:** más tools en contexto = más tokens; medir.

**Spike concreto:** un cliente de prueba con Gmail + Google Sheets conectados → generar su MCP URL → nodo MCP Client en un workflow n8n → tarea en lenguaje natural ("agregá nombre/email a mi planilla X") → ver si el agente lo ejecuta bien. Eso responde 3, 4 y parte de 1/2.

### ✅ Spike parcial ejecutado (backend ↔ Composio)
- `mcp.create("tilegra-mcp", { toolkits:[{toolkit,authConfigId}] })` + `mcp.generate(String(clientId), serverId)` → URL `https://backend.composio.dev/v3.1/mcp/<server>?include_composio_helper_actions=true&user_id=<clientId>`, `type: streamable_http`.
- El endpoint hace **307 redirect** a `/v3/mcp/<server>/mcp?...` (el path real); el **handshake `initialize` MCP responde OK** (SSE, capabilities.tools). Header `x-api-key: <COMPOSIO_API_KEY>`.
- El server expuso **151 tools** (gmail+calendar+sheets) + helper actions (`COMPOSIO_SEARCH_TOOLS`) → el agente busca, no carga todo.
- **Falta validar en n8n:** que el nodo MCP Client siga el 307 y descubra/ejecute; y el scoping (si expone tools de apps no conectadas por el cliente).
- **Implementado:** `composioService.getUserMcpUrl(clientId)` + `GET /api/composio/mcp-url`.

### ✅ Spike n8n ejecutado — 2 hallazgos y sus fixes
1. **Transport:** el nodo `@n8n/n8n-nodes-langchain.mcpClientTool` en **typeVersion 1** es SSE-only (hace GET → Composio 405). Hay que usar **tv 1.1** con `serverTransport: "httpStreamable"` y la URL en **`endpointUrl`** (no `sseEndpoint`).
2. **Límite de 128 tools (OpenAI):** el MCP server estático exponía 156 tools → OpenAI rechaza (>128). **Solución = Tool Router:** `composio.create(clientId, { mcp:true, toolkits })` → session cuyo MCP expone **~6 meta-tools** (`COMPOSIO_SEARCH_TOOLS`, execute, manage connections). El agente **busca** la tool y la ejecuta. Escala a cualquier cantidad de apps.
   - `session.mcp.url` = `https://backend.composio.dev/tool_router/trs_.../mcp` (estable por `sessionId`, reusable con `sessions.use`).
   - `session.mcp.headers['x-api-key']` = `ak_...` (key MCP de la org, **la misma para todas las sessions** → credential n8n compartida).
3. **n8n:** credential `httpHeaderAuth` (`x-api-key` = `ak_...`), compartida (id `rXJrVQFQmTOxfoC9`). Nodo `Composio Apps` (tv 1.1, httpStreamable, `endpointUrl` inyectado por `createWorkflow`) → `ai_tool` → AI Agent. Validado: el tool-router responde el handshake MCP.
4. **`sync_response_to_workbench` required (fix):** la meta-tool `COMPOSIO_MULTI_EXECUTE_TOOL` traía un campo required de la feature workbench/sandbox que el modelo no completaba → n8n rechazaba. **Solución: crear la session con `sandbox: { enable: false }`** → quedan **4 meta-tools** (search, multi-execute [required solo `tools`], get-schemas, manage-connections), sin code-execution ni el campo workbench.
5. **"No active connection in this session" (fix):** la session no veía la conexión ACTIVE del cliente porque agarraba un authConfig distinto (hay >1 authConfig gestionado por toolkit). **Solución:** derivar el mapa `authConfigs: { toolkit → authConfigId }` de las **conexiones ACTIVE reales del usuario** (`connectedAccounts.list`) y pasarlo al `create`, habilitando `toolkits = soportados ∪ conectados` (los overrides solo pueden referenciar toolkits habilitados). Verificado: todas las apps del cliente 57 pasan a `connection.isActive: true`.
6. **El agente inventa slugs (`SPREADSHEET_ADD_ROW`):** `gpt-4o-mini` no seguía el "buscá primero" y alucinaba el slug. **Mitigaciones:** (a) guía en el system message (`# Apps conectadas`: usar `COMPOSIO_SEARCH_TOOLS` y el slug exacto, nunca inventar); (b) **subir el modelo a `gpt-4o`** (mini es muy flojo para el razonamiento search→get-schema→execute).
   - **A validar aún:** el end-to-end con gpt-4o + guía; y la persistencia de las sessions (si expiran, regenerar la URL baked en n8n).

---

## Plan de migración por fases

- **Fase 0 — Spike** (arriba). Go/no-go.
- **Fase 1 — Backend `mcpService`:** `getOrCreateMcpServer(toolkits)` + `getUserMcpUrl(clientId)` (crea/reusa la config y genera la URL). Env: reusar `COMPOSIO_API_KEY`.
- **Fase 2 — n8n template:** agregar nodo MCP Client conectado al AI Agent; inyectar la MCP URL del cliente + `x-api-key` en `createWorkflow` (nuevo placeholder, como el `AGENT_ID_PLACEHOLDER`). Decidir si se **quitan** los `tool__*` de composio del sync o se dejan para el modo avanzado.
- **Fase 3 — Dashboard UX:** Tareas = solo lenguaje natural por default; sacar/relegar el picker de Composio del árbol. Integraciones queda igual.
- **Fase 4 — Limpieza/decisión:** deprecar (o dejar como avanzado) la plomería determinística de composio (picker, presets, placeholders, coerce, `/execute`).

---

## Riesgos / trade-offs (honestos)

- **Menos determinismo:** el agente puede elegir mal la tool o llenar mal los args. Mitigación: scopear toolkits, buenas instrucciones, y el **modo pin-tool** para lo crítico.
- **"Cuál recurso"** no desaparece: se resuelve por lenguaje natural + búsqueda (o pin-tool).
- **Dependencia del nodo MCP de n8n** con Composio (madurez, auth por header) — el punto #3 del spike.
- **Costo/latencia** mayores.
- **Lo bueno:** enorme simplificación de UX (el usuario solo conecta apps + escribe en castellano), y se elimina un montón de plomería nuestra.

---

## Recomendación

**Ir al modelo MCP/agentic como default**, dejando el determinístico actual como modo avanzado. Pero **no comprometerse sin la Fase 0 (spike)**, porque el riesgo real es técnico (nodo MCP de n8n + Composio + scoping por cliente), no de diseño.

---

## Fuentes
- Composio — [MCP Quickstart](https://docs.composio.dev/docs/mcp-quickstart) · [Generate MCP URL](https://docs.composio.dev/reference/api-reference/mcp/postMcpServersGenerate) · [Server management](https://docs.composio.dev/docs/mcp-server-management) · [Configuring sessions](https://docs.composio.dev/docs/configuring-sessions)
- SDK `@composio/core`: `composio.mcp.create()` / `composio.mcp.generate(userId, serverId)` / Tool Router `composio.create(userId)` + `COMPOSIO_SEARCH_TOOLS`.
- n8n — [MCP Client Tool node](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp) (Streamable HTTP + headers custom).
