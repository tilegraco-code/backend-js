# Cleanup pendiente en `dashboard-tilegra`

Archivos listos para borrar del repo `dashboard-tilegra` a medida que cada fase de la migración se confirma estable en producción. **No borrar todavía** — dejar el tiempo de observación correspondiente antes de cada cleanup.

---

## ✅ Fase 1a — Webhooks (cutover completado: 2026-05-20)

**Tráfico real de Unipile ya apunta a backend-js.** Estos archivos en Next.js son código muerto: Unipile no los está llamando más.

Listos para borrar:

- `app/api/webhooks/unipile/[client_id]/route.ts` — webhook principal de mensajes (`message_received`). Migrado a `POST /webhooks/unipile/:clientId` en backend-js.
- `app/api/webhooks/unipile/accounts/route.ts` — webhook de status de cuenta. Migrado a `POST /webhooks/unipile/accounts` en backend-js.

**Cuándo borrar:** después de ~48h confirmando que no hay regresiones (mensajes entrantes se guardan, status de cuenta se actualiza, n8n recibe los forwards correctamente).

**NO tocar todavía** (depende de Fase 1b):
- `app/api/webhooks/unipile/[client_id]/account-connected/route.ts` — sigue siendo el callback al que apunta `app/api/unipile/inboxes/connect`, que aún no se migró.
