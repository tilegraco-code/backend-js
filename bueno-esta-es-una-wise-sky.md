# Migración a backend dedicado — Inventario de módulos

## Context

`dashboard-tilegra` mezcla UI con ~5,000+ LOC de lógica de negocio (44 endpoints `/api`, integraciones externas, webhooks). Vamos a separarlo en un backend Node + TypeScript dedicado, en un repo nuevo desplegado en Easypanel.

**Reglas del juego:**
- Backend nuevo = **único escritor** de Supabase. Next.js solo lee.
- Stack del backend: **Node + TypeScript** (framework y queue a definir aparte).
- `backend-rag` (Python) **no se toca**.
- Migración **módulo por módulo, al 100%** antes de pasar al siguiente.

---

## Módulos a migrar (en orden de prioridad)

### 🔴 PRIORIDAD 1 — Unipile (multi-canal inbox)
Webhooks entrantes + CRUD de inboxes/chats/mensajes + envío saliente.

**Por qué primero:** los webhooks de Unipile son los que más sufren timeouts hoy, y es el corazón operativo del producto (mensajería en vivo con clientes).

---

### 🔴 PRIORIDAD 2 — MercadoPago / Billing
Suscripciones, webhooks de pago, invoices, cuotas, sync de PreApproval.

**Por qué segundo:** lógica fragmentada entre 7 endpoints + webhook + libs. Acoplada al estado de docs y de inboxes. Una vez Unipile esté afuera, billing es el siguiente nudo más complejo.

---

### 🟡 PRIORIDAD 3 — n8n + Tools
Orquestación de workflows, sync de tools (Google Sheets, HTTP, Cal.com), ejecutor de tools que n8n llama.

**Por qué tercero:** el endpoint `/api/tools/run` lo llama n8n dentro del loop del agente — latencia importa. Pero hoy funciona, no es bloqueante.

---

### 🟡 PRIORIDAD 4 — Cal.com
OAuth + token refresh + API wrapper (event-types, slots, bookings).

**Por qué cuarto:** standalone, no bloquea nada hoy, pero el token refresh on-demand sí agrega latencia al runtime del agente.

---

### 🟢 PRIORIDAD 5 — Agentes (CRUD + wizard)
Endpoints de agents/agentprops/agent_tools, server actions de edición, wizard con OpenAI.

**Por qué quinto:** es CRUD limpio. Migra cuando el backend nuevo ya esté maduro y queramos cerrar el ownership de Supabase.

---

### 🟢 PRIORIDAD 6 — Documentos / RAG (gates + billing)
Auth + ownership + free-tier gate + creación de `document_billing_items`.
**El parser (`backend-rag`) ya escribe `documents` y chunks** — solo migran los gates y el billing item. Una vez Unipile y MercadoPago estén afuera, el frontend puede subir directo al parser y este llama al backend nuevo para los gates + billing.

---

### 🟢 PRIORIDAD 7 — Web snippets / Widget público
CRUD de configs + endpoint público que dispara workflow n8n.

---

### 🟢 PRIORIDAD 8 — Escalación / email
`POST /api/escalate` que manda mail vía Resend.

---

### 🟢 PRIORIDAD 9 — Provisión de usuarios
`POST /api/provision-user` que se llama al signup.

---

### 🟢 PRIORIDAD 10 — Helpers de escritura DB
Los `lib/db/update*.ts`, `lib/db/create*.ts`, `lib/db/delete*.ts` y server actions de `lib/actions/`. Migran al final, cuando todo lo demás ya pasa por el backend.

---

## Lo que se queda en Next.js (definitivo)

- UI completa: `app/` con páginas, layouts, componentes.
- Supabase Auth client-side (signup, login, logout, recovery).
- Lecturas de Supabase para SSR: `lib/db/get*.ts`.
- Middleware `proxy.ts` (simplificado, sin `INTERNAL_API_KEY` porque ese tráfico ya no pasa por Next.js).
- Server actions de UI pura (preferencias, navegación) que NO tocan negocio.

---

## Cómo se migra cada módulo (proceso uniforme)

Para cada módulo se hace **una pasada completa** antes de pasar al siguiente:

1. **Replicar endpoints** en el backend nuevo (mismo contrato HTTP).
2. **Mover la lógica**: handler, libs, helpers de DB de escritura.
3. **Apuntar webhooks externos** (MP, Unipile, n8n) al nuevo dominio.
4. **Actualizar el frontend** para que las mutaciones llamen al backend nuevo (Bearer token con JWT de Supabase).
5. **Apagar los endpoints viejos** en Next.js (borrar archivos).
6. **Verificar end-to-end** en producción antes de pasar al siguiente módulo.

---

## Próximos pasos

Cuando se confirme este orden, abrimos un plan específico para **Unipile** (Prioridad 1) con detalle a nivel de archivo: endpoints exactos, tablas, contratos, plan de cutover de webhooks.
