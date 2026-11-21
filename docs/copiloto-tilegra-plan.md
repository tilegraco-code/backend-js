# Copiloto de Tilegra — plan

> Objetivo: que el cliente configure Tilegra **conversando**. Un agente (el "copiloto") que conoce todo lo que la plataforma puede hacer, sabe qué tiene conectado cada cliente y le dice qué se puede y qué no **antes** de prometer algo. La configuración manual sigue estando, a un click.
>
> Estado: plan (2026-11-21). Abarca los 3 repos: `dashboard-tilegra` (API + UI), `agente-tilegra` (grafo LangGraph del copiloto), `backend-js` (Composio, catálogo, jobs).

---

## 0. Principios

1. **Todo lo que hace la UI, lo hace un endpoint.** El copiloto no toca la base: llama a la misma API que la UI, con la sesión del usuario. Así hereda permisos (owner/admin), límites de plan y validaciones sin duplicar nada.
2. **El LLM decide qué decir; el código decide qué se hace.** El grafo tiene nodos deterministas para validar, resolver capacidades y aplicar cambios. El LLM interpreta y redacta. Nunca escribe en la plataforma sin pasar por un nodo determinista.
3. **Proponer → confirmar → aplicar.** Toda escritura pasa por una tarjeta de aprobación (`interrupt()` de LangGraph). Nada se crea "por las dudas".
4. **Honestidad sobre capacidades.** Si el usuario pide algo que el agente no puede hacer con lo que tiene conectado, el copiloto lo dice y propone el camino ("Para mandar emails necesito que conectes Gmail → [Conectar]"), o una alternativa ("No puedo llamar por teléfono; puedo derivar a un humano").
5. **Regla de mantenimiento:** una feature nueva en la UI no está terminada hasta que tenga endpoint + entrada en el registro de capacidades. Se suma a `docs/agregar-tool-checklist.md`.

---

## 1. Inventario: todo lo que se puede hacer desde la UI

Relevado del código del dashboard (páginas en `app/dashboard`, rutas en `app/api`, server actions).
Leyenda: ✅ endpoint listo · 🟡 existe pero hay que ajustarlo · ❌ falta endpoint (la página lee/escribe directo a la base o usa un server action).

### 1.1 Agentes (workflows)

| Acción en la UI | Dónde | Endpoint | Estado |
|---|---|---|---|
| Listar agentes | `/dashboard/workflows` | `GET /api/agents` | ✅ (la página lee `workflow`/`agent_route`/`documents` directo; usar el endpoint) |
| Crear agente | modal "Nuevo agente" | `POST /api/workflows` | ✅ |
| Crear agente desde plantilla | `/dashboard/templates`, quickstart | `POST /api/workflows` + 4 llamadas a `/api/agents/...` encadenadas en el cliente (`lib/client/templatesPage.tsx`) | 🟡 → endpoint compuesto `POST /api/agents/from-template` (atómico, idempotente) |
| Catálogo de plantillas | `/dashboard/templates` | hardcodeado en `lib/templates/agent-templates.ts` | ❌ → `GET /api/templates` |
| Wizard asistido (rol, tareas, contexto, estilo) | `agent-wizard-modal` | `POST /api/agents/wizard` (gpt-4o-mini) | ✅ (el copiloto lo reemplaza; se pueden reusar los prompts) |
| Ver detalle del agente | `/dashboard/workflows/[id]` | `GET /api/agents/[id]` | ✅ (la página lee `workflow`/`project`/`unipile_inboxes` directo) |
| Editar nombre / rol / contexto / estilo | tab Personalidad, Contexto | `PATCH /api/agents/[id]` | ✅ |
| Editar tareas | tab Tareas | `PUT /api/agents/[id]/tasks` | ✅ |
| Derivación (rutas a humanos) | tab Derivación | `PUT /api/agents/[id]/routes` | ✅ |
| Casos | tab Casos | `PUT /api/agents/[id]/casos` | ✅ |
| Aprendizajes | tab Aprendizaje | `GET/PATCH /api/agents/[id]/learnings` | ✅ |
| Toolkits de Composio del agente | panel de tools | `GET/PUT /api/agents/[id]/toolkits` | ✅ |
| Activar / pausar agente, follow-ups | detalle | `PATCH /api/workflows/[id]` | 🟡 todavía lee la fila de n8n; limpiar (n8n desvinculado) |
| Borrar agente | detalle | `DELETE /api/workflows/[id]` | ✅ |
| Uso del agente | detalle | `GET /api/agents/[id]/usage` | ✅ |
| Probar agente (chat de prueba) | `test-chat-panel` | `POST /api/test-agent` | ✅ |
| Editar props legacy (`agentprops`) | `lib/actions/agents/edit.ts` | server action | ❌ verificar si se usa; si no, borrar |

### 1.2 Tools del agente

| Acción | Endpoint | Estado |
|---|---|---|
| Listar tools del agente | `GET /api/agents/[id]/tools` | ✅ |
| Crear tool (TiendaNube, Woo, ML, shipnow, Sheets, Calendar, Cal.com, HTTP, Composio) | `POST /api/agents/[id]/tools` | 🟡 `config` es libre; falta validar por tipo (zod) para que el copiloto no arme configs inválidas |
| Editar / habilitar / borrar tool | `PATCH/DELETE /api/tools/[id]` | ✅ |
| Probar tool HTTP | `POST /api/tools/http/test` | ✅ |
| Ejecutar tool (tester) | `POST /api/tools/run` | ✅ |
| **Catálogo de tipos y acciones** | hardcodeado en `components/workflows/agent-tools-panel.tsx` (`INTEGRATIONS` + `*_ACTION_LABELS`) | ❌ → mover a un catálogo compartido + `GET /api/catalog/tools` |

### 1.3 Integraciones (cuentas del cliente)

| Integración | connect | status | disconnect | Estado |
|---|---|---|---|---|
| Google (Sheets/Calendar) | `GET /api/auth/google/connect` | ✅ | ✅ | ✅ |
| TiendaNube | OAuth `GET .../connect` | ✅ | ✅ | ✅ |
| WooCommerce | `POST .../connect` (keys) | ✅ | ✅ | ✅ |
| MercadoLibre | OAuth `GET .../connect` | ✅ | ❌ | 🟡 falta disconnect |
| shipnow | `POST .../connect` (token) | ✅ | ✅ | ✅ |
| Cal.com | OAuth | ✅ | ❌ | 🟡 falta disconnect (y es legacy: hoy va por Composio) |
| Composio (cualquier toolkit) | `POST /api/auth/composio/connect` | ✅ | ✅ | ✅ |
| Toolkits de Composio | `GET /api/composio/toolkits` | — | — | ✅ |
| Tools de un toolkit | `GET /api/composio/tools?toolkit=` | — | — | ✅ |
| Conexiones activas | `GET /api/composio/connections` | — | — | ✅ |
| **Resumen de todo lo conectado** | la página `/dashboard/integrations` consulta cada status por separado | ❌ → `GET /api/integrations` (una sola respuesta con todo) |

### 1.4 Canales (inboxes)

| Acción | Endpoint | Estado |
|---|---|---|
| Listar inboxes | `GET /api/unipile/inboxes` | ✅ (la página `/connect` lee directo) |
| Conectar WhatsApp/IG/etc. (Unipile, link hosted) | `POST /api/unipile/inboxes/connect` | ✅ |
| Conectar WhatsApp por QR (Evolution) | `POST /api/evolution/inboxes/connect` + `GET .../qr` | ✅ |
| Reconectar / sincronizar estado | `POST .../reconnect`, `.../sync-status` | ✅ |
| Asignar agente al inbox, espera por canal | `PATCH /api/unipile/inboxes/[id]` (`workflow_id`, `response_delay_seconds`) | ✅ |
| Config MercadoLibre del inbox | `PATCH /api/unipile/inboxes/[id]/mercadolibre` | 🟡 falta GET (la página lee `mercadolibre_settings` directo) |
| Borrar inbox | `DELETE` (unipile / evolution) | ✅ |
| Widget web (snippets) | `GET/POST /api/web-snippets`, `PATCH/DELETE [id]` | ✅ |

### 1.5 Conocimiento

| Acción | Endpoint | Estado |
|---|---|---|
| Subir archivo | `POST /api/upload?project_id=` | ✅ |
| Listar / borrar documentos | `GET /api/documents`, `DELETE [id]` | ✅ |
| Ver grafo de conocimiento | `GET /api/graph` | ✅ |
| **Cargar conocimiento desde una URL (la web del cliente)** | no existe | ❌ → `POST /api/knowledge/from-url` (clave para el onboarding) |
| **Cargar conocimiento desde texto pegado** | no existe | ❌ → `POST /api/knowledge/from-text` |

### 1.6 Inbox (conversaciones)

| Acción | Endpoint | Estado |
|---|---|---|
| Listar chats / ver mensajes / responder | `GET /api/unipile/chats`, `GET/POST .../messages` | ✅ |
| Pausar IA en un chat, marcar estado | `PATCH /api/unipile/chats/[id]` | ✅ |
| Ver caso del chat | `GET .../case` | ✅ |
| Preguntas de MercadoLibre | `GET /api/mercadolibre/questions`, `POST .../answer` | ✅ |

### 1.7 Cuenta, equipo, uso y facturación

| Acción | Endpoint | Estado |
|---|---|---|
| Editar mi nombre / nombre de la empresa | server actions en `account/page.tsx` | ❌ → `PATCH /api/account` |
| Listar usuarios del equipo | lectura directa en `teams/page.tsx` | ❌ → `GET /api/team` |
| Invitar / borrar usuario | server actions | ❌ → `POST/DELETE /api/team` |
| Uso del mes (todo el cliente) | lectura directa en `usage/page.tsx` | ❌ → `GET /api/usage` |
| Métricas del home | lectura directa en `dashboard/page.tsx` | ❌ → `GET /api/overview` |
| Plan actual / planes | `GET /api/plans` | ✅ |
| Estado de la suscripción, facturas | lectura directa en `billing/page.tsx` | ❌ → `GET /api/billing` |
| Suscribirse / pausar / cancelar / cambiar cupo | `POST /api/billing/*` | ✅ pero **fuera del alcance del copiloto** (solo lee y manda al link de billing) |

### 1.8 Fuera de alcance

`org-settings` (admin interno), webhooks, widget público, juego del stand, `sentry-example-api`, `provision-user`, `escalate` (lo usa el runtime).

### 1.9 Resumen de huecos

- **Endpoints nuevos (lectura):** templates, catálogo de tools, integraciones (resumen), usage, overview, billing, team, settings de ML.
- **Endpoints nuevos (escritura):** from-template, knowledge from-url / from-text, account, team, disconnect de ML y Cal.com.
- **Ajustes:** validación zod por tipo en `POST /api/agents/[id]/tools`; limpiar n8n en `PATCH /api/workflows/[id]`; pasar las páginas a leer de los endpoints (opcional, pero evita que la UI y el copiloto se desincronicen).
- **Auth:** hoy todos los endpoints usan cookie (`getUserWithClient`). Hay que aceptar también `Authorization: Bearer <JWT de Supabase>` para que el copiloto (que corre en agente-tilegra) llame en nombre del usuario. Ver §2.2.

---

### 1.10 Avance (2026-11-21, dashboard-tilegra, sin commitear)

Hecho:
- **Auth por Bearer.** `lib/auth/bearer.ts`. `proxy.ts` y `getServerUser()` aceptan `Authorization: Bearer <access_token de Supabase>` además de la cookie. La `INTERNAL_API_KEY` sigue funcionando igual.
- **Errores comunes** `{ error, code, hint }`: `lib/api/errors.ts` (`ApiError`, `apiError`, `zodError`, `toErrorResponse`).
- **Capa de servicios** `lib/services/`: `agents.ts` (createAgent, replaceAgentTasks, createAgentFromTemplate), `knowledge.ts` (ingestDocument / ingestText / ingestUrl), `integrations.ts`, `overview.ts`, `usage.ts`.
- **Endpoints nuevos:**
  - `GET /api/templates`, `GET /api/templates/[id]`
  - `POST /api/agents/from-template`: atómico, borra lo creado si algo falla. La página de plantillas y el modal "Nuevo agente" ya lo usan.
  - `GET /api/catalog/tools` (`?all=1` incluye las legacy)
  - `GET /api/integrations`: nativas + Composio conectadas, con cómo conectar cada una.
  - `POST /api/knowledge/from-url`: una página, con protección SSRF (bloquea IPs privadas y valida cada redirección).
  - `POST /api/knowledge/from-text`
  - `GET /api/overview`: totales + pasos del onboarding + `next_step`.
  - `GET /api/usage?month=YYYY-MM`
  - `GET /api/billing/summary`
  - `GET/PATCH /api/account`, `GET /api/team`
  - `GET /api/unipile/inboxes/[id]/mercadolibre`
- **Catálogo de tools** `lib/catalog/tools.ts`: labels + acción → capacidad + integración requerida + `runtime_supported`. El panel de tools ya importa los labels de ahí.
- **Validación zod** del `config` en `POST /api/agents/[id]/tools` (`lib/api-contracts/agentTools.ts`).
- `/api/upload` usa el mismo servicio de ingesta (mantiene el 402 que espera la UI).
- Borrado `lib/actions/agents/edit.ts`: server action sin uso y sin chequeo de pertenencia.

Probado en local el 2026-11-21 con Bearer: 28/28 checks OK (lecturas + escrituras + limpieza).

Bug encontrado probando y arreglado:
- **Borrar un agente con conocimiento cargado daba 500**, también desde la UI: `documents` y `document_billing_items` apuntaban a `project` sin regla de borrado. Además la ruta borraba `workflow` antes y dejaba el agente a medio borrar.
- Se aplicó en prod la migración `db/migrations/project_delete_cascade_documents.sql`: `documents` cascadea; `document_billing_items.project_id` pasa a nullable con `ON DELETE SET NULL`, así el cobro se conserva.
- `DELETE /api/workflows/[id]` ahora hace un solo DELETE del proyecto.

Hallazgos:
- **Los documentos `.md`/`.html` vuelven del parser con `page_count = null`**, así que no se cobran ni descuentan páginas gratis. Pasa con los uploads de ese tipo y ahora también con `from-text`/`from-url`. **Decisión pendiente:** estimar páginas por tamaño o dejarlos gratis.
- **Google Sheets, Google Calendar y Cal.com nativos se pueden crear desde el panel, pero el runtime LangGraph los ignora** (`agente-tilegra/app/tools/api_tools.py`). Un cliente puede crearlas y el agente nunca las usa. En el catálogo quedan `runtime_supported: false`. **Decisión pendiente:** sacarlas del panel y mandar a Composio.
- `deleteUserAction` (`/dashboard/teams`) no chequea el rol de quien borra: un `member` podría borrar a otro usuario del cliente. Pendiente.

Decisiones:
- **Crear/borrar usuarios queda fuera del copiloto** (pide definir contraseñas). Solo `GET /api/team`.
- **Pagos fuera del copiloto:** solo lee `GET /api/billing/summary` y manda a `/dashboard/billing`.

Falta para cerrar la Fase 1:
- `openapi.json` generado de los contratos zod (hoy solo hay contratos de tools; sumar los del resto a `lib/api-contracts/`).
- `Idempotency-Key` en `from-template` y `knowledge/*` (necesita tabla; hacerlo junto con el grafo de la Fase 3).
- Disconnect de MercadoLibre y Cal.com. No bloquean el onboarding.
- Opcional: que las páginas lean de los endpoints nuevos en vez de ir directo a la base.
- Probar punta a punta con `pnpm dev` (no corrí el servidor).

## 2. Fase 1 — API completa y "llamable por un agente"

### 2.1 Qué hacer
1. Crear los endpoints de §1.9.
2. **Contrato por endpoint:** schema zod del body/query y de la respuesta en `lib/api-contracts/` del dashboard. De ahí se genera un `openapi.json` (con `zod-to-openapi`) y del openapi las tools del copiloto. Un solo lugar define qué acepta cada acción.
3. **Errores legibles para un LLM:** `{ error, code, hint }`. Ejemplo: `{ code: "PLAN_LIMIT", hint: "El plan Starter permite 1 agente; tiene 1." }`. El copiloto usa el `hint` para explicarle al usuario.
4. **Idempotencia** en las escrituras compuestas (`from-template`, `from-url`): header `Idempotency-Key` para que un reintento del grafo no cree dos agentes.

### 2.2 Auth del copiloto
- El dashboard le pasa al copiloto el `access_token` de Supabase del usuario (ya lo tiene la sesión).
- `getUserWithClient()` acepta cookie **o** `Authorization: Bearer`. Valida con `supabase.auth.getUser(token)`.
- El copiloto nunca usa la service key ni `INTERNAL_API_KEY` para escribir en nombre del cliente. Así los permisos por rol siguen valiendo solos.

### 2.3 Entregable
`openapi.json` del dashboard con todas las acciones de §1 en ✅, y un test de humo que recorre el onboarding completo por API (crear agente desde plantilla → cargar URL → agregar tool → asignar inbox → probar).

---

## 3. Fase 2 — Registro de capacidades ("qué puede y qué no puede hacer la IA")

Es lo que resuelve el caso "mi mamá pide que mande un email y no tiene Gmail conectado".

### 3.1 Modelo

**Capacidad** = algo que el agente final puede hacer en una conversación, en lenguaje de negocio:

```ts
type Capability = {
  id: "send_email" | "book_appointment" | "check_order_status" | "search_products" | ...;
  label: "Enviar emails";
  description: "Mandar un email a un cliente o al equipo";
  examples: ["mandá un mail con el presupuesto", "avisame por mail cuando..."];
  providers: Provider[];   // formas de cumplirla
};

type Provider =
  | { kind: "native"; tool_type: "tiendanube"; action: "order_status"; requires: ["tiendanube"] }
  | { kind: "composio"; toolkit: "gmail"; tool_slug: "GMAIL_SEND_EMAIL"; requires: ["composio:gmail"] }
  | { kind: "builtin"; feature: "escalate" }             // siempre disponible
  | { kind: "channel"; channel: "whatsapp" };            // depende de un canal conectado
```

También hay una lista explícita de **imposibles**, con una alternativa para cada una:
- llamar por teléfono → "derivar a un humano";
- escribirle primero a alguien que nunca habló (WhatsApp) → "follow-ups dentro de la ventana";
- pagos con tarjeta dentro del chat → "link de pago (TiendaNube / Woo / MercadoPago)";
- recordar entre clientes distintos.

### 3.2 De dónde salen
- **Nativas** (TiendaNube, Woo, ML, shipnow, HTTP, conocimiento, casos, documentos, derivación): las escribimos a mano. Son pocas y conviene curarlas. Viven en un archivo versionado (`capabilities.ts` en el dashboard) que también reemplaza al `INTEGRATIONS` hardcodeado del panel de tools.
- **Composio:** son cientos de toolkits y miles de tools, así que no entran en el contexto del LLM. Un job en backend-js sincroniza el catálogo a una tabla `composio_catalog (toolkit, tool_slug, name, description, input_schema, embedding)` una vez por día. Con eso hay **búsqueda semántica** (igual que `match_documents`): "mandar un email" → `GMAIL_SEND_EMAIL`, `OUTLOOK_SEND_EMAIL`, … Arrancar con una allow-list curada de ~30 toolkits relevantes para PyMEs (Gmail, Outlook, Calendar, Sheets, Drive, Calendly, HubSpot, Notion, Slack, Trello…) y abrir el resto después.

### 3.3 Resolver (determinista)
`POST /api/capabilities/resolve` con `{ capability_ids?: [], query?: "mandar mails" }` devuelve, para este cliente:

```json
{
  "capability": "send_email",
  "status": "needs_connection",            // available | needs_connection | needs_plan | impossible
  "options": [
    { "provider": "composio:gmail", "connected": false, "action": { "type": "connect", "url": "/api/auth/composio/connect", "toolkit": "gmail" } },
    { "provider": "composio:outlook", "connected": false, "action": { ... } }
  ],
  "alternative": null
}
```

El estado sale de cruzar: el registro, las conexiones del cliente (`GET /api/integrations`), los canales (`GET /api/unipile/inboxes`) y el plan (`GET /api/plans`). **No pasa por el LLM.**

### 3.3b Avance Fase 2A (2026-11-21, probado en local 21/21)

Hecho en dashboard-tilegra:
- `lib/catalog/capabilities.ts`: 29 capacidades + 3 imposibles (llamadas, cobrar con tarjeta en el chat, escribir primero a contactos nuevos).
  - Las nativas salen de `TOOL_CATALOG` (no se duplican).
  - Las de Composio usan slugs verificados contra la API.
  - Las de serie: derivación, conocimiento, documentos, casos, seguimiento.
- Búsqueda por palabras (`searchCapabilities`): ignora acentos y plurales y puntúa por palabras distintas. Probada con 10 pedidos reales.
- `lib/services/capabilities.ts`:
  - `resolveCapabilities`: estados enabled / available / needs_setup / needs_connection / impossible / unknown, más `summary` en castellano.
  - `enableCapability`: crea la tool nativa con el mismo nombre y descripción que la UI (`lib/catalog/toolDescriptions.ts`, extraído del formulario) o suma tools de Composio respetando `MAX_COMPOSIO_TOOLS`; después refresca el runtime.
- Endpoints: `GET /api/capabilities`, `GET /api/capabilities/search?q=`, `POST /api/capabilities/resolve`, `GET/POST /api/agents/[id]/capabilities`.

Hallazgo: `PATCH /api/tools/[id]` (prender/apagar una tool desde la UI) **no refresca el cache del runtime LangGraph**: el cambio entra recién cuando vence el cache. `enableCapability` sí refresca.

Pendiente (Fase 2B): sync del catálogo completo de Composio a una tabla con embeddings + búsqueda semántica para los pedidos que no matchean la lista curada.

### 3.4 Endpoints
- `GET /api/capabilities`: catálogo completo de nativas + imposibles.
- `GET /api/capabilities/search?q=`: búsqueda semántica (nativas + Composio).
- `POST /api/capabilities/resolve`: estado para este cliente.
- `GET /api/composio/toolkits/[slug]`: detalle de un toolkit con sus tools (ya casi existe vía `/api/composio/tools?toolkit=`).

---

## 4. Fase 3 — El grafo del copiloto (agente-tilegra, LangGraph)

Es un grafo **nuevo** e independiente del runtime de los agentes de los clientes: comparte el repo pero no el grafo. Tiene un `checkpointer` en Postgres y un `thread_id` por usuario y conversación (tabla `copilot_threads`).

### 4.1 Estado

```python
class CopilotState(TypedDict):
    client_id: int
    user_token: str                 # JWT, solo para llamar a la API
    phase: Literal["onboarding", "free"]
    business: BusinessProfile | None    # nombre, rubro, web, clientes, tono
    agent_id: int | None                # agente que se está configurando
    draft: AgentDraft | None            # lo que se va a aplicar (persona, tareas, tools, conocimiento)
    requested_capabilities: list[str]
    resolution: list[CapabilityResolution]
    pending_ui: list[UIEvent]           # tarjetas a mostrar (conectar, aprobar, probar)
    messages: Annotated[list, add_messages]
```

### 4.2 Flujo de onboarding (lo acota el grafo, no el LLM)

```
intake ──► scrape_site ──► pick_template ──► draft_persona ──► capability_check
  (LLM)       (det.)        (LLM elige de      (LLM, prompts      (LLM extrae → det. resuelve)
                             lista cerrada)     del wizard)              │
                                                                         ▼
           publish ◄── test ◄── connect_channel ◄── connect_integrations ◄── approve ──► apply
           (det.)    (sandbox)  (UI card +         (UI cards +              (interrupt)   (det.)
                                 interrupt)         interrupt)
```

| Nodo | Tipo | Qué hace |
|---|---|---|
| `intake` | LLM, salida estructurada | Pide nombre, rubro, web/tienda, qué quiere que haga el agente. Se repite hasta tener lo mínimo (validación determinista de campos). |
| `scrape_site` | determinista | `POST /api/knowledge/from-url`. Si no hay web, sigue igual. |
| `pick_template` | LLM con opciones cerradas | Elige 1 de `GET /api/templates` (o "ninguna"). Un id fuera de la lista se rechaza y se reintenta. |
| `draft_persona` | LLM | Arma rol, tareas, contexto y estilo. Reusa los prompts de `/api/agents/wizard`. |
| `capability_check` | LLM + determinista | El LLM extrae de lo que pidió el usuario la lista de `capability_ids` (de un enum cerrado o vía `/capabilities/search`). El resolver de §3.3 devuelve el estado de cada una. |
| `approve` | `interrupt()` | Tarjeta: "Voy a crear *Mia* con esto: … Puede: ✅ consultar pedidos, ✅ responder con tu web. Necesita: 🔌 Gmail para mandar mails. No puede: ❌ llamar por teléfono (puede derivar a un humano)". Botones: Aprobar / Cambiar. |
| `apply` | determinista | `POST /api/agents/from-template` (o crear + PATCH), tareas, tools con config validada. Usa idempotency key. |
| `connect_integrations` | UI + `interrupt()` | Por cada capacidad `needs_connection`, una tarjeta "Conectar X". La UI hace el OAuth y avisa; el nodo verifica con `status` y, recién ahí, crea la tool correspondiente. Se puede saltear. |
| `connect_channel` | UI + `interrupt()` | Tarjeta para elegir canal (WhatsApp QR / Unipile / web widget / ML) y asignarle el agente (`PATCH inbox.workflow_id`). |
| `test` | UI | Abre el chat de prueba (`/api/test-agent`) con 2–3 preguntas sugeridas según el rubro. |
| `publish` | determinista | Activa el agente (`PATCH /api/workflows/[id]`), marca el onboarding como completo y pasa a `phase = "free"`. |

### 4.3 Modo libre (después del onboarding)

```
router (LLM: clasifica intención en enum cerrado)
  ├─ edit_persona     → draft → approve → apply
  ├─ add_capability   → capability_check → approve → connect → apply
  ├─ add_knowledge    → from-url / from-text / pedir archivo
  ├─ manage_channel   → tarjetas de canal
  ├─ explain / help   → responde leyendo GET endpoints (sin escribir)
  ├─ usage_billing    → solo lectura + link a /dashboard/billing
  └─ out_of_scope     → "eso no lo puedo hacer desde acá" + link a la pantalla manual
```

Cada rama es un subgrafo chico con el mismo patrón: **leer → proponer → confirmar → aplicar → verificar**.

### 4.4 Tools del copiloto
Se generan del `openapi.json` de la Fase 1, filtradas por nodo: cada nodo ve solo las tools que necesita. El router no ve ninguna tool de escritura, y `apply` no la decide el LLM.

### 4.5 Protocolo de UI
El grafo hace streaming por SSE de mensajes + eventos `ui`:

```json
{ "type": "ui", "component": "connect_integration", "props": { "provider": "composio:gmail" } }
{ "type": "ui", "component": "approval", "props": { "draft": { ... } } }
{ "type": "ui", "component": "test_chat", "props": { "agent_id": 12, "suggestions": [...] } }
```

La respuesta del usuario (click en Aprobar, OAuth terminado) vuelve como `Command(resume=...)`.

### 4.5b Avance Fase 3 (2026-11-21)

**Hecho:**
- `agente-tilegra` (rama `copiloto-fase-3`): `app/copilot/graph.py` con el flujo de onboarding de §4.2.
  - Hay diferencias con el plan original: `capabilities` corre antes de `pick_template`, no hay nodo `scrape_site` (la web se carga en `configure`, después de aprobar) y `connect_channel`/`test` se devuelven como tarjetas en `final.next`.
  - Endpoint `POST /copilot/turn` con bearer interno + `X-User-Token`.
  - 18 tests con LLM y API falsos: flujo completo, sin escrituras antes de aprobar, el agente se crea una sola vez, errores explicados con el hint, el token no queda en el checkpointer.
- Probado con `gpt-5-mini` real + API falsa: pregunta lo que falta, entiende el pedido, aplica cambios de estilo, crea y configura.
- La prueba con el modelo real encontró dos problemas, ya arreglados:
  - El borrador prometía un imposible ("gestiono llamados"). Ahora recibe `Puede hacer` / `No puede hacer` del resolver.
  - El modelo sumaba capacidades que nadie pidió (CRM). Se ajustó el prompt.
- `dashboard-tilegra`: proxy `POST /api/copilot`. El `thread_id` sale de la sesión y se reenvía el access_token.

**Contrato de un turno** (`/api/copilot` → `/copilot/turn`):
- Request: `{ message?, resume?, conversation? }`.
  - `resume` responde a la tarjeta pendiente: `{approved, feedback}` en la aprobación o `{connected, provider}` en conectar.
  - Si viene `message` mientras hay una pausa, se usa como respuesta (en la aprobación = pedido de cambios).
- Response: `{ messages: string[], waiting: {type: question|approval|connect, ...} | null, done, final }`.

**Variables nuevas:**
- dashboard: `AGENT_RUNTIME_URL`.
- agente-tilegra: `DASHBOARD_URL` y, opcional, `COPILOT_MODEL`.

**Falta:**
- Modo libre (router de §4.3) para editar un agente ya creado.
- UI chat-first (Fase 4).
- Prueba punta a punta con los dos servidores levantados.

### 4.6 Modelo y costo
- Un modelo bueno para `intake`/`draft`/`router` y uno chico para extracción y clasificación.
- Loguear tokens por thread. El uso del copiloto **no** descuenta créditos del cliente (es costo de adquisición).

---

## 5. Fase 4 — Dashboard chat-first

- `/dashboard` pasa a ser el copiloto: chat a pantalla completa para clientes sin agentes y layout con el chat + resumen (agentes, canales, uso) para los que ya tienen.
- Un botón **"Configuración manual"** en el header lleva a las pantallas actuales, que no cambian.
- **Panel lateral del copiloto** en cada pantalla manual (`/workflows/[id]`, `/integrations`, `/connect`), con el contexto de la pantalla (`agent_id`, etc.): "¿Qué querés cambiar de este agente?".
- Componentes: `CopilotChat`, `ApprovalCard`, `ConnectIntegrationCard`, `ChannelPickerCard`, `TestChatCard`, `CapabilityBadge` (✅/🔌/❌).
- Rollout con feature flag por cliente: primero clientes nuevos y después los existentes.

---

## 6. Fase 5 — MCP (opcional, casi gratis)

Con la Fase 1 terminada, el MCP es exponer las mismas tools del `openapi.json` por MCP remoto con OAuth sobre Supabase. Sirve para power users y agencias. No es prioridad.

---

## 7. Orden y estimación

| Fase | Repo | Estimación |
|---|---|---|
| 0. Métricas de embudo (baseline: registro → agente → conocimiento → canal → 1er mensaje) | dashboard / SQL | 1–2 días |
| 1. API completa + Bearer auth + contratos zod/openapi | dashboard | 1,5–2 semanas |
| 2. Registro de capacidades + sync/búsqueda de Composio + resolver | dashboard + backend-js | 1–1,5 semanas |
| 3. Grafo del copiloto (onboarding primero, modo libre después) | agente-tilegra | 2–3 semanas |
| 4. Dashboard chat-first + tarjetas | dashboard | 1,5–2 semanas |
| 5. MCP | dashboard / backend-js | 1 semana (opcional) |

Las fases 2 y 3 se pueden solapar: el grafo puede arrancar con un registro mínimo de capacidades (solo nativas) mientras se indexa Composio.

---

## 8. Preguntas abiertas

1. ¿El copiloto reemplaza al wizard actual (`/api/agents/wizard`) o conviven un tiempo?
2. ¿El chat-first es para todos o solo para los clientes nuevos al principio?
3. Allow-list inicial de toolkits de Composio: ¿cuáles priorizamos?
4. ¿Qué modelo usamos para el copiloto? (el wizard hoy usa gpt-4o-mini)
5. ¿Las pantallas manuales pasan a leer de los endpoints nuevos (más trabajo, una sola fuente de verdad) o siguen leyendo directo de la base?
