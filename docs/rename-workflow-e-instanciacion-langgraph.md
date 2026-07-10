# Rename `n8n_workflow → workflow` + instanciación en agente-tilegra

Plan para (1) sacar el prefijo `n8n_` de la tabla de binding agente↔canal y (2) hacer que los
agentes nuevos nazcan en **agente-tilegra (LangGraph)** en vez de n8n.

Los dos van juntos porque tocan el mismo punto: la tabla `n8n_workflow` dejó de ser "el workflow
de n8n" y hoy es de facto la **tabla de ruteo** (el webhook resuelve `workflow_id → agent_id +
client_id` y recién ahí mira `agent.runtime`). El nombre `n8n_workflow` ya no la describe.

---

## 1. Estado actual (por qué hay acople)

- `agent.runtime` default = `'n8n'` (NOT NULL). **Ningún código setea `'langgraph'`** — el único
  agente LangGraph (agent 72) se flipeó a mano por SQL y aún tiene su workflow n8n colgado.
- `POST /api/workflows` (dashboard) siempre: crea `project` → `agent` → `agentprops` →
  **`createWorkflow` (POST real a n8n)** + insert en `n8n_workflow`.
- `n8n_workflow` es el ancla de ruteo:
  - FKs entrantes: `unipile_inboxes.workflow_id`, `unipile_chats.workflow_id` → `n8n_workflow.id`.
  - El webhook (Unipile/Evolution) → `dispatchToRuntime(payload, workflow_id)` → lee la tabla →
    `agent_id + client_id` → decide runtime. **Aunque sea LangGraph, el row hace falta.**

---

## 2. Decisiones de nombre

| Objeto | Antes | Después | Nota |
|---|---|---|---|
| Tabla | `n8n_workflow` | **`workflow`** | El rename principal. |
| Columna | `n8n_id` | *(se queda)* | Es legítimamente el id del workflow de n8n; para agentes LangGraph queda **NULL**. Pasa a ser **nullable**. |
| Policy RLS | `owner can manage n8n_workflow` | `owner can manage workflow` | Cosmético; sobrevive el rename igual. |
| Fn dashboard | `createWorkflow` | `provisionAgent` *(opcional)* | Deuda diferible; ver §7. |

> No renombramos `n8n_id` a otra cosa: cuando existe, **es** un id de n8n. La señal "esto corre en
> LangGraph" es `agent.runtime='langgraph'` + `workflow.n8n_id IS NULL`.

---

## 3. Migración DB

`workflow` no es palabra reservada en Postgres. El `RENAME` arrastra solo las FKs entrantes/salientes
y la policy (siguen funcionando, apuntando a la tabla renombrada).

```sql
-- 1. Rename de la tabla (FKs y policy la siguen automáticamente).
alter table public.n8n_workflow rename to workflow;

-- 2. n8n_id nullable → poder crear el ancla de ruteo sin workflow real de n8n.
alter table public.workflow alter column n8n_id drop not null;

-- 3. (Opcional, cosmético) renombrar la policy.
alter policy "owner can manage n8n_workflow" on public.workflow
  rename to "owner can manage workflow";
```

Las FKs mantienen su **nombre** (`unipile_inboxes_workflow_id_fkey`, `unipile_chats_workflow_id_fkey`)
pero ya apuntan a `workflow`. No hace falta tocarlas.

### Estrategia de deploy (evitar la ventana de error)

El `RENAME` rompe al instante todo código deployado que consulte `n8n_workflow`, y dashboard/
backend-js deployan por separado. Dos caminos:

- **A — Coordinado (recomendado por escala).** backend-js corre 1 instancia y hay pocos agentes:
  correr la migración y deployar los dos apps casi juntos. Ventana de error de segundos. Simple,
  sin deuda.
- **B — View puente (zero-downtime).** Tras el rename, `create view n8n_workflow as select * from
  workflow;` (view simple = updatable → inserts/updates del código viejo siguen andando). Deployás
  los apps y después `drop view n8n_workflow`. **Caveat:** el embed PostgREST `n8n_workflow!inner`
  (§4, follow-up) NO resuelve contra una view (no tiene FKs); si vas por B, deployá backend-js junto
  con la migración o migrá ese query primero.

---

## 4. Cambios de código — checklist

`agente-tilegra` **no toca la tabla** (recibe `agent_id` vía `runtime-config`) → **0 cambios** ahí.

### backend-js (4 archivos, 6 refs) — `.from('n8n_workflow')` → `.from('workflow')`
- [ ] `src/services/agent-runtime.service.ts:155`
- [ ] `src/services/learnings.service.ts:34`
- [ ] `src/services/n8n-forward.ts:36` (+ comentario línea 18)
- [ ] `src/services/unipile-follow-up.service.ts` — **⚠ el delicado**: es un embed relacional.
  - `:52` `n8n_workflow!inner ( follow_up_enabled )` → `workflow!inner ( follow_up_enabled )`
  - `:59` `.eq('n8n_workflow.follow_up_enabled', true)` → `.eq('workflow.follow_up_enabled', true)`

### dashboard-tilegra (13 archivos, 19 refs) — `.from("n8n_workflow")` → `.from("workflow")`
- [ ] `app/api/workflows/route.ts:90` (creación — ver §5)
- [ ] `app/api/workflows/[id]/route.ts:31,46,72,95` (activar/borrar — ver §6)
- [ ] `app/api/escalate/route.ts:46`
- [ ] `app/api/tools/[id]/route.ts:39,79`
- [ ] `app/api/agents/[id]/toolkits/route.ts:29`
- [ ] `app/api/test-agent/route.ts:22`
- [ ] `app/api/widget/[public_key]/messages/route.ts:159`
- [ ] `app/org-settings/actions.ts:44`
- [ ] `app/dashboard/page.tsx:47`
- [ ] `app/dashboard/usage/page.tsx:75`
- [ ] `app/dashboard/workflows/page.tsx:46` (+ comentario línea 44)
- [ ] `app/dashboard/workflows/[id]/page.tsx:65`
- [ ] `lib/db/checkPlanLimits.ts:81`

> Ninguno de los del dashboard usa embed; son todos `.from(...)` planos → find & replace directo.

---

## 5. Instanciación en agente-tilegra (`POST /api/workflows`)

Objetivo: agentes nuevos nacen LangGraph, sin crear nada en n8n.

- [ ] Paso 2 — crear `agent` con **`runtime: 'langgraph'`** explícito (no depender del default de la
      columna).
- [ ] Paso 4 — **no** llamar `createWorkflow`. Igual insertar el row de `workflow` como ancla:
      `{ client_id, project_id, agent_id, name, webhook_path: crypto.randomUUID(), active: true,
      n8n_id: null }`.
- [ ] Sacar el `import { createWorkflow }` si queda sin uso.

Todo el downstream ya ramifica por `runtime` y no necesita cambios:
- `agent-system-message.service` → `DIRECT_TOOLS_GUIDANCE` vs MCP.
- guardado de tools/toolkits → `refreshAgentRuntimeCache` (langgraph) vs regenerar nodo MCP (n8n).
- `learnings.job` → saltea `n8n_id IS NULL`.
- `/api/escalate` → ya arreglado (guarda el learning).

> Si en algún momento se quiere que **absolutamente todo** sea LangGraph, se puede cambiar el default
> de la columna a `'langgraph'`. No lo hacemos ahora: preferimos el `runtime` explícito en el insert
> para no alterar filas/flujos viejos por efecto colateral.

---

## 6. Guards en paths de edición (n8n-only)

Para un agente LangGraph no hay workflow de n8n que activar/borrar. Hoy estos llaman a n8n a ciegas:

- [ ] `app/api/workflows/[id]/route.ts` — activar/desactivar/borrar: envolver las llamadas a
      `activateWorkflow` / `deactivateWorkflow` / `deleteWorkflow` en `if (n8n_id) { ... }`
      (o `if runtime==='n8n'`). Si `n8n_id` es null → skip, no error.
- [ ] Revisar `app/api/tools/[id]` y `app/api/agents/[id]/toolkits` por si regeneran el workflow n8n
      sin chequear runtime (deberían ya branchear; confirmar).

---

## 7. Fuera de alcance / deuda diferida

- Rename `createWorkflow → provisionAgent` y `lib/n8n.ts → lib/agentProvisioning.ts`: cosmético, se
  puede hacer después sin bloquear esto.
- Rename de la variable/param `workflowId`/`workflow_id` en firmas: ya se llama `workflow_id`, queda bien.
- Migrar el agente 72 existente: opcionalmente `update workflow set n8n_id=null` y borrar su workflow
  en n8n una vez validado que LangGraph lo cubre 100%.

---

## 8. Testing

1. **Migración en rama/preview** primero; correr `pnpm typecheck` en backend-js y `tsc`/build en el
   dashboard tras el find & replace.
2. Crear un agente nuevo desde el dashboard → verificar: `agent.runtime='langgraph'`, row en
   `workflow` con `n8n_id=null`, y **nada** creado en n8n.
3. Conectar un canal a ese agente → mandar un mensaje → debe rutear por `runViaAgent` (LangSmith lo
   confirma) y responder.
4. Forzar una escalación → fila nueva en `agent_learnings` (type='escalation').
5. Regresión n8n: un agente `runtime='n8n'` existente sigue andando (activar/desactivar incluido).
6. `unipile-follow-up` job corre sin romper (validar el embed renombrado).

---

## Resumen de esfuerzo

| Bloque | Tamaño |
|---|---|
| Migración DB (rename + nullable + policy) | 3 líneas SQL |
| backend-js (6 refs, 1 embed) | chico |
| dashboard (19 refs, find & replace) | chico |
| Instanciación (`POST /api/workflows`) | chico |
| Guards edición (`workflows/[id]`) | chico |

El 90% es un find & replace mecánico; el riesgo real está en (a) el embed de follow-up y (b) el
orden de deploy vs el rename.
