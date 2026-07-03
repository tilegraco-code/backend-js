# Checklist: agregar una Tool nueva (de cero)

> Procedimiento basado en cómo agregamos la tool de Google Sheets "Agregar fila".
> Aplica a `dashboard-tilegra` (donde corren/entran las tools) + `backend-js` (lógica pesada).

## Conceptos base (no olvidar)

- **Las tools entran por el dashboard.** n8n siempre pega a `app.tilegra.com/api/tools/run` → `runTool()` en [`lib/tools.ts`](../../dashboard-tilegra/lib/tools.ts). El nodo de n8n es genérico y "tonto".
- **Modelo de acción única:** cada acción = su propia tool, con nombre y descripción autogenerados (como TiendaNube/Cal.com). Nada de tools multi-acción.
- **Dónde va la lógica:** `http`/`cal_com` corren en el dashboard; `tiendanube`/`google_sheet` **reenvían al backend** (`BACKEND_PUBLIC_URL/api/...`).
- **n8n se sincroniza solo:** no se toca el workflow a mano. Pero ojo: las tools se crean **deshabilitadas** y la sync corre **al activarlas** (el switch). Si falla, el error queda en los logs del server (se traga con `.catch`).

---

## A) Nueva ACCIÓN de una integración existente (caso más común)

### Dashboard
- [ ] **`lib/definitions.ts`** → agregar la acción al union (ej. `GoogleSheetAction`) y, si hace falta, campos nuevos en su `Config`.
- [ ] **`lib/tools.ts`** → en `runGoogleSheet`/`runX` agregar el branch de la acción. Si reenvía al backend: `fetch(BACKEND_PUBLIC_URL/api/.../...)` con `Authorization: Bearer INTERNAL_API_KEY`. Resolver `client_id` desde `agent → project → client_id`.
- [ ] **`components/workflows/tool-form-dialog.tsx`** → UI de la acción:
  - `resolvedXAction` (de `tool.config.actions[0]` o `initialAction`).
  - sumar a `autoNamed` si es write/auto.
  - `buildXName()` + `buildXDescription()` (la descripción es lo que ve el LLM: explicá QUÉ hace y el FORMATO de input exacto).
  - bloque de render condicionado a la acción.
  - validaciones + `finalName`/`finalDescription`/`config` en `handleSave`.
- [ ] **`components/workflows/agent-tools-panel.tsx`** → sumar la acción al menú (labels + entry en `INTEGRATIONS` + label en la lista de tools).
- [ ] (Si el form necesita datos en vivo, ej. columnas/archivos) → ruta proxy en `app/api/.../route.ts` (auth por sesión con `getUserWithClient`, reenvía al backend con `INTERNAL_API_KEY`).

### Backend (solo si la acción reenvía al backend)
- [ ] **`src/services/<integracion>.service.ts`** → método nuevo.
- [ ] **`src/routes/<integracion>.route.ts`** → endpoint bajo el scope autenticado (`/api/...`), validado con Zod.

---

## B) Integración NUEVA (desde cero, con OAuth)

Todo lo de (A), más:

### Backend
- [ ] Tabla de conexión en Supabase (`<x>_connections`, 1 fila por `client_id`, RLS on). Ver `google_connections`.
- [ ] `src/services/<x>-api.service.ts` → cliente OAuth (authUrl, exchangeCode, authorizedClient con refresh).
- [ ] `src/services/<x>.service.ts` → capa DB (getConnection/saveConnection/updateTokens).
- [ ] `src/routes/<x>-oauth.route.ts` → `connect`/`callback` con `state` firmado ([`oauth-state.ts`](../src/lib/oauth-state.ts)). Registrar como ruta **pública** en [`routes/index.ts`](../src/routes/index.ts).
- [ ] `src/routes/<x>.route.ts` → endpoints `/api/<x>/*`. Registrar en el scope autenticado.
- [ ] Env nuevas en `.env` y `.env.example` (`<X>_OAUTH_CLIENT_ID`, etc.).

### Base de datos (si el `type` de la tool es nuevo)
- [ ] La columna `agent_tools.type` tiene un CHECK constraint con la lista de tipos
  permitidos. Un tipo nuevo (ej. `google_calendar`) **falla el INSERT con 500** hasta
  que se agrega. Migración: `drop constraint agent_tools_type_check` + recrearlo con
  el tipo nuevo en el array. (También actualizar el whitelist en `app/api/tools/[id]/route.ts`.)

### Dashboard
- [ ] `lib/<x>.ts` → `getConnection(clientId)`.
- [ ] `app/api/auth/<x>/{connect,status,disconnect}/route.ts` (reutilizar `signState`).
- [ ] Card en `app/dashboard/integrations/` (page + client) con conectar/desconectar.
- [ ] Agregar el tipo a `AgentToolType` y al `INTEGRATIONS` del panel.

### Setup externo (lo hace el usuario)
- [ ] Crear credenciales OAuth en la consola del proveedor; `REDIRECT_URI` = `<PUBLIC_URL>/api/<x>/oauth/callback` (exacto).
- [ ] Scopes: elegir los **menos invasivos**. (Aprendizaje Google: `drive.readonly` es *restricted* → verificación CASA paga; usar **Google Picker + `drive.file`** para browsear archivos sin CASA.)

---

## Cierre (siempre)

- [ ] **Typecheck:** backend `pnpm typecheck` · dashboard `npx tsc --noEmit`.
- [ ] **Deploy AMBOS:**
  - Dashboard → `app.tilegra.com` (¡es el que ejecuta las tools! sin esto, n8n corre código viejo).
  - Backend → easypanel.
  - Cargar las env nuevas en prod (incluidas las `NEXT_PUBLIC_*` en el dashboard).
- [ ] **Probar:** crear tool → **activarla** (switch) → verificar que aparezca el nodo `tool__<name>` conectado al "AI Agent" en n8n → que el agente la ejecute OK.

> Si el nodo no aparece: revisar logs del server al activar (la sync se traga el error). Si el agente la ejecuta y falla con algo raro tipo `undefined.match`: casi seguro el **dashboard de prod está desactualizado** → deployar.
