# Frontend `dashboard-tilegra` — UI de Follow-up

Lista de cambios a implementar para integrar el feature de follow-up al dashboard. El backend (cron, tablas, lógica) ya está hecho en `backend-js`.

---

## Recursos del backend que vas a consumir

- **Columna** `n8n_workflow.follow_up_enabled` (boolean) — controla si el cron toca ese workflow.
- **Columna** `unipile_chats.follow_up_sent_at` (timestamp) — marca que ya se envió.
- **Tabla** `unipile_follow_up_log` — registro por workflow por corrida. Columnas: `id, workflow_id, candidates, processed, deferred, sent, errors, dry_run, created_at`.

> **📌 Para vos:** estas tres piezas son la "API" interna entre el backend (que escribe) y el frontend (que va a leer/togglear). El frontend nunca le pega al cron ni al cron job; solo escribe `follow_up_enabled` en `n8n_workflow` y lee `unipile_follow_up_log`. Toda la magia del envío de mensajes vive en `backend-js`, el dashboard solo es la cara visible.

---

## 1) Endpoint `PATCH /api/workflows/[id]`

**Archivo:** [app/api/workflows/[id]/route.ts](../../Documents/dashboard-tilegra/app/api/workflows/[id]/route.ts)

Extender el body que acepta hoy para que también admita `follow_up_enabled`:
- Body actual: `{ active: boolean }`
- Body nuevo: `{ active?: boolean; follow_up_enabled?: boolean }`

Comportamiento:
- Si llega `active`, mantener lógica actual (toggle en n8n + update en DB).
- Si llega `follow_up_enabled`, actualizar la columna en `n8n_workflow` y nada más. No toca n8n.
- Si llegan ambos, aplicar ambos.
- Mantener la validación de ownership existente (`authorize`).

> **📌 Para vos:** estamos reusando el endpoint existente en vez de crear uno nuevo (`/api/workflows/[id]/follow-up`). Razón: ya tiene la validación de ownership lista y mantenerlo unificado evita duplicar auth. El "truco" es que ambos campos son opcionales — el frontend manda solo el campo que cambia, no todo el objeto. Si más adelante hay que tocar más flags del workflow, este mismo endpoint los va absorbiendo sin proliferar endpoints específicos.

---

## 2) Tab "Seguimiento" en `/dashboard/workflows/[id]`

**Archivos:**
- [app/dashboard/workflows/[id]/page.tsx](../../Documents/dashboard-tilegra/app/dashboard/workflows/[id]/page.tsx) — incluir `follow_up_enabled` en el select de `n8n_workflow` y pasar la prop al client component.
- [lib/client/workflowDetailPage.tsx](../../Documents/dashboard-tilegra/lib/client/workflowDetailPage.tsx) — agregar nuevo tab.

**Cambios:**
- Agregar un `TabsTrigger value="seguimiento"` después del de "test".
- Agregar el `TabsContent` correspondiente.
- Actualizar la interface `N8nWorkflow` para que incluya `follow_up_enabled: boolean`.

**Contenido del tab "Seguimiento":**

1. **Switch para activar/desactivar** el follow-up. Estado inicial: el valor actual de `follow_up_enabled` del workflow.
2. **Cuando el usuario hace toggle**, llamar a `PATCH /api/workflows/[id]` con `{ follow_up_enabled: <nuevo valor> }`.
3. **Deshabilitar el switch** si el usuario no tiene rol owner/admin (usar el prop `canManage` que ya está disponible).
4. **Mostrar feedback** (toast) al éxito/error del toggle.
5. **Texto explicativo** dividido en tres puntos:
   - **Cuándo se dispara**: una vez al día (11 AM Argentina), procesa chats con +24h sin actividad.
   - **Cómo se redacta**: una IA lee los últimos 10 mensajes del chat y genera un mensaje breve y contextual para retomar la conversación.
   - **Límite anti-baneo**: máximo 300 mensajes por workflow por día, con 20-30s entre cada envío. El sobrante se procesa al día siguiente.

> **📌 Para vos:**
> - **¿Por qué un tab y no un botón en la página principal del workflow?** Porque el follow-up es una capacidad opcional y avanzada — la mayoría de usuarios no la va a usar al principio. Esconderlo en un tab evita ensuciar la vista principal pero lo deja descubrible. Es el mismo patrón que usás para "tools" o "test".
> - **¿Por qué esos tres puntos explicativos?** Los usuarios al activar algo "automático que manda mensajes solo" típicamente preguntan: cuándo, qué dice, y cuánto. Si no respondés esas tres preguntas en el mismo tab, te van a abrir tickets o desactivar por miedo. El "límite anti-baneo" es especialmente importante para que el cliente confíe que no le vas a quemar su cuenta de WhatsApp.
> - **¿Por qué deshabilitar para usuarios no-admin?** Activar follow-up es un acto que afecta a clientes finales (les manda mensajes), no es solo configuración del bot. Tiene que estar atado a un rol con responsabilidad de cliente. Reusa el `canManage` que ya hay, no agregás permisos nuevos.
> - **Toast obligatorio**: sin feedback, un toggle silencioso es confuso. Si el PATCH falla, el switch tiene que volver al estado anterior (rollback) o el usuario va a creer que está activado cuando no.

---

## 3) Sección de Seguimiento en `/dashboard/usage`

**Archivos:**
- [app/dashboard/usage/page.tsx](../../Documents/dashboard-tilegra/app/dashboard/usage/page.tsx) — fetch de los stats desde Supabase.
- [lib/client/usagePage.tsx](../../Documents/dashboard-tilegra/lib/client/usagePage.tsx) — render.

**Datos a traer del server**:
- Filas de `unipile_follow_up_log` de los últimos 30 días, donde `dry_run = false`, filtradas por workflows que pertenecen al `client_id` del usuario logueado.
- Join con `n8n_workflow` para obtener el nombre del workflow.

**Qué tiene que mostrar la sección:**

1. **KPI cards** (totales de los últimos 30 días para el cliente):
   - Follow-ups enviados.
   - Follow-ups con error.
   - Cantidad de workflows con seguimiento activo.

2. **Tabla por workflow** con columnas:
   - Nombre del workflow.
   - Seguimiento activo (sí/no, según `follow_up_enabled`).
   - Enviados (suma de `sent` de los últimos 30 días).
   - Errores (suma de `errors`).
   - Deferred (suma de `deferred`).

3. **Filtro por rango de fechas** (opcional, default: últimos 30 días).

> **📌 Para vos:**
> - **¿Por qué `dry_run = false`?** Cuando estás probando localmente con `FOLLOW_UP_DRY_RUN=true`, igual se guarda fila en `unipile_follow_up_log` (para auditar las pruebas), pero no se mandó nada. El usuario final no debe ver esas filas mezcladas con las reales.
> - **¿Por qué 30 días?** Es el horizonte estándar para "uso reciente" en dashboards SaaS — corto suficiente para que importe, largo suficiente para detectar tendencia. Si después querés ofrecer "este mes", "este año", agregás el filtro en el paso 3.
> - **¿Por qué esos 3 KPIs?**
>   - **Enviados** es la métrica de output principal (lo que el cliente paga indirectamente).
>   - **Errores** te alerta de problemas (cuenta de Unipile caída, OpenAI sin créditos, etc.).
>   - **Workflows con seguimiento activo** te da contexto: si tenés 100 enviados pero solo 1 workflow activo, es probable que ese workflow esté saturado.
> - **¿Por qué la columna "Deferred"?** Si un workflow consistentemente tiene deferred > 0, significa que el cap de 300/día se está alcanzando y hay chats que esperan días. Es un indicador de que ese cliente necesita aumentar el cap (vos negociás con él el upgrade) o reducir su universo de chats elegibles.
> - **¿Por qué traer los datos en el server y no por API?** El usage ya es una página server-side rendered. Fetchear en el server es más simple (no necesitás endpoint extra) y más seguro (no exponés un endpoint que devuelva stats de todos los workflows). Mantenés el patrón existente.

---

## Checklist

- [ ] Extender el body que acepta `PATCH /api/workflows/[id]`.
- [ ] Incluir `follow_up_enabled` en el select del workflow en `page.tsx`.
- [ ] Agregar tab "Seguimiento" en `workflowDetailPage.tsx` con el switch + texto explicativo.
- [ ] Verificar end-to-end que el toggle persiste el cambio en `n8n_workflow.follow_up_enabled`.
- [ ] Agregar fetch de `unipile_follow_up_log` en `usage/page.tsx`.
- [ ] Agregar sección de Seguimiento en `usagePage.tsx` (KPI cards + tabla).
- [ ] Verificar contra datos reales después de una corrida del cron en producción.

---

## Notas

- **Ownership**: el endpoint `PATCH /api/workflows/[id]` ya valida que el usuario sea owner/admin del cliente dueño del proyecto. No se agrega auth nueva.
- **Relación `active` vs `follow_up_enabled`**: hoy el cron procesa el workflow si `follow_up_enabled=true`, sin importar si el workflow está `active` o no. Si más adelante quisieras que también requiera `active=true`, es un cambio en la query del backend (no en el frontend).

> **📌 Para vos sobre la nota de `active` vs `follow_up_enabled`:** la decisión hoy de desacoplarlos es a propósito. Permite el caso de uso: "tengo un workflow viejo pausado (`active=false`), pero quiero seguir mandando follow-ups a los chats que quedaron sin responder". Si los acoplás, pausar un workflow también mata su follow-up — eso podría ser deseable o no. Es una decisión de producto que conviene discutir con el cliente antes de tocar.
