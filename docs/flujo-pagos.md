# Flujo de pagos completo (Tilegra)

Documento de referencia del sistema de cobros: suscripción base con **MercadoPago**, más dos add-ons medidos que se acumulan y se cobran junto con la suscripción — **documentos** (páginas de knowledge docs) y **uso/créditos** (interacciones humano/IA por encima del incluido).

> **TL;DR del monto que se cobra cada mes:**
> ```
> monto_preapproval = base_plan + documentos_pendientes + uso_pendiente
>
> base_plan          = precio_por_inbox(tier) × inbox_quota
> documentos_pending = Σ páginas facturables × $100 ARS   (10 páginas gratis por cliente)
> uso_pending        = Σ usos excedentes × $14 ARS        (1750 usos incluidos por inbox no-WEB)
> ```

---

## 1. Arquitectura (modelo híbrido)

La lógica está repartida entre dos repos por una razón concreta: **el SDK de MercadoPago y el access token viven en el dashboard**, así que toda escritura contra MP se hace desde ahí. El backend calcula y dispara, pero no habla directo con MP.

| Repo | Rol en pagos |
|------|--------------|
| **dashboard-tilegra** (Next.js) | SDK de MP, preapproval (suscripción), webhook de MP, rutas de billing (subscribe/quota/cancel/…), cálculo del monto (`syncPreapprovalAmount`), billing de documentos, UI de Plans y Usage. |
| **backend-js** (Fastify) | CRON mensual que calcula el excedente de **uso**, CRON diario de ciclo de vida (cortes por impago), y disparo del re-sync del preapproval vía HTTP al dashboard. |

El backend llama al dashboard con `POST {DASHBOARD_URL}/api/billing/sync-preapproval` autenticado con `INTERNAL_API_KEY` (header `x-internal-key`).

> **Fase 2 (pendiente):** migrar todo MP al backend para centralizar. Hoy es híbrido a propósito para no re-portear el SDK.

---

## 2. Modelo de datos

| Tabla | Campos clave para pagos |
|-------|-------------------------|
| `client` | `inbox_quota`, `plan_id`, `trial_ends_at`, `company` |
| `client_billing` | `mp_preapproval_id`, `status` (`authorized`/`pending`/`paused`/`cancelled`), `next_payment_date`, `last_amount_ars`, `payment_warning_sent_at`, `disconnected_at` |
| `plan` | `plan_id`, `name` (Lite/Standard/Pro), `min_inboxes`, `price_ars`, `maxworkflows`, **`included_credits`** (usos incluidos por inbox, default 1750) |
| `invoice` | `mp_payment_id`, `amount_ars`, `status`, `billing_period`, `description` |
| `document_billing_items` | `billing_batch`, `page_count`, `free_pages_applied`, `billable_pages`, `amount_ars`, `status` (`pending`/`paid`/`free`) |
| `usage_billing_items` | `client_id`, `billing_period` (`YYYY-MM`), `included_uses`, `total_uses`, `billable_uses`, `amount_ars`, `status` (`pending`/`paid`/`free`) |
| `unipile_inboxes` | `client_id`, `provider` (`WHATSAPP`/`INSTAGRAM`/`WEB`/…), `workflow_id`, `suspended` |
| `agentuse` | `agent_id`, `created_at` — 1 fila = 1 uso |

---

## 3. Componente A — Suscripción base (MercadoPago preapproval)

El cobro central es una **suscripción recurrente** (preapproval de MP) por cliente.

### Precio base
`base = precio_por_inbox(tier) × inbox_quota`, donde el tier se resuelve por cantidad de inboxes:

| Plan | min_inboxes | Precio/inbox (ARS) | Workflows |
|------|-------------|--------------------|-----------|
| Lite | 1 | 30.000 | 2 |
| Standard | 2 | 25.000 | 10 |
| Pro | 5 | 20.000 | ilimitados |

Código: `lib/billing/tierPricing.ts` (`getTierFromPlans`, `calcAmountFromPlans`) y `lib/billing/getBillingPlans.ts`.

### Rutas de billing (dashboard)
- `POST /api/billing/subscribe` — crea el preapproval y la fila `client_billing`.
- `POST /api/billing/update-quota` — cambio de cantidad de inboxes; genera un **pago único** por la diferencia (external_reference `quota_upgrade:<clientId>:<newQuota>`) y luego re-sincroniza el preapproval.
- `POST /api/billing/cancel` · `pause` · `resume`.

### El monto se recalcula acá
`lib/billing/syncAmount.ts`:
- `calcBillingAmount(clientId)` y `syncPreapprovalAmount(clientId)` computan
  `monto = base + getPendingDocAmount() + getPendingUsageAmount()` y hacen `preApproval.update(...)` contra MP.
- `syncPreapprovalAmount` se dispara cada vez que cambia algo que afecta el monto: alta de inbox, upgrade de quota, alta de doc facturable, o el CRON de uso.

---

## 4. Componente B — Documentos (knowledge docs)

Cobro medido por páginas de documentos procesados por encima del free tier.

- **Gratis:** `FREE_PAGES_PER_CLIENT = 10` páginas por cliente.
- **Precio:** `PRICE_PER_PAGE_ARS = 100` ARS por página facturable.

Código: `lib/billing/documentBilling.ts`.

**Flujo:**
1. Se procesa un documento → `createDocumentBillingItem()` calcula páginas gratis vs facturables, inserta una fila en `document_billing_items` con `status='pending'` (o `'free'` si entra en las 10 gratis).
2. Si hay páginas facturables → llama a `syncPreapprovalAmount()` → el monto del preapproval sube.
3. `getPendingDocAmount()` suma los items `pending` de ese cliente (lo lee `syncAmount`).
4. Al cobrarse el ciclo, el webhook llama `markBatchAsPaid()` → los items pasan a `paid`.

---

## 5. Componente C — Uso / créditos (lo nuevo)

Cobro medido por **interacciones humano/IA** (`agentuse`) por encima del incluido.

- **Incluido:** `1750` usos **por inbox no-WEB** del cliente (viene de `plan.included_credits`, configurable).
- **Precio excedente:** `PRICE_PER_USE_ARS = 14` ARS por uso.
- **Reset:** mensual (mes calendario — **Opción A**).

### Fórmula (por cliente)
```
allowance     = (inboxes del cliente con provider != 'WEB') × 1750
total_uses    = filas de agentuse del cliente en el mes calendario
billable_uses = max(0, total_uses − allowance)
amount_ars    = billable_uses × 14
```

- El inbox de **websnippet** (`provider = 'WEB'`) **NO aporta** allowance, pero **sus usos SÍ cuentan**.
- Alcance **por cliente** (pool): con multi-agente se suman los usos de todos los agentes y las allowances de todos los inboxes; un solo cobro. Como hoy hay 1 agente por proyecto/cliente, equivale a "por agente".

### Piezas
**backend-js:**
- `src/services/usage-billing.service.ts` — `runUsageBillingBatch()` (cálculo + escritura + disparo del sync). Funciones puras `computeOverage()` y `previousCalendarMonth()`.
- `src/jobs/usage-billing.job.ts` — CRON `0 14 1 * *` (día 1, 11 AM ARG).
- `src/routes/admin/usage-billing.route.ts` — `POST /api/admin/usage-billing/run` (trigger manual, período opcional).
- `db/migrations/usage_billing_items.sql` — tabla + RLS + 2 funciones SQL de agregación.

**dashboard-tilegra:**
- `lib/billing/usageBilling.ts` — `getPendingUsageAmount()`, `markUsageBatchAsPaid()`, `getPendingUsageUnits()`.
- `app/api/billing/sync-preapproval/route.ts` — endpoint interno que el backend invoca.

### Flujo del CRON de uso
1. **Día 1** → el cron calcula el excedente del **mes que cerró** por cliente y escribe `usage_billing_items` con `status='pending'` (o `'free'` si no hubo excedente).
2. Para cada cliente con excedente → `POST /api/billing/sync-preapproval` en el dashboard → `syncPreapprovalAmount()` sube el monto del preapproval.
3. El excedente se cobra en la **próxima `next_payment_date`** del cliente (Opción A: puede caer a mitad de mes → hay un pequeño desfase esperado entre el mes contado y la fecha de cobro).
4. El webhook marca el uso como `paid` y vuelve el preapproval al monto base.

**Idempotencia:** unique `(client_id, billing_period)`; el cron no pisa items ya `paid`.

---

## 6. El webhook de MercadoPago

`app/api/webhooks/mercadopago/route.ts` — valida firma (`x-signature`) y maneja:

| Evento MP | Qué hace |
|-----------|----------|
| `preapproval` | Actualiza `client_billing.status`. Si `authorized` → reactiva inboxes (`suspended=false`), limpia `trial_ends_at` y flags del CRON de ciclo de vida. Si `cancelled`/`paused` → suspende inboxes. |
| `payment` (pago único) | Upgrade de quota (`external_reference = quota_upgrade:...`): sube `inbox_quota`+`plan_id`, crea `invoice`, re-sincroniza el preapproval. |
| `payment.created` / `payment.updated` (authorized_payment = cobro recurrente) | Crea `invoice` con descripción (`Plan … · N inboxes + P páginas + U usos excedentes`), marca **documentos y uso** como `paid` (`markBatchAsPaid` + `markUsageBatchAsPaid`), actualiza `next_payment_date`, resetea flags de ciclo de vida, y **vuelve el preapproval al monto base** (docs+uso pending ahora en 0). |

---

## 7. Ciclo mensual completo (end-to-end)

```
 ┌─ Alta ────────────────────────────────────────────────────────────┐
 │ Cliente subscribe → preapproval AUTHORIZED, monto = base           │
 │ webhook limpia trial_ends_at, reactiva inboxes                     │
 └────────────────────────────────────────────────────────────────────┘
              │
              ▼  (durante el mes)
 ┌─ Acumulación ──────────────────────────────────────────────────────┐
 │ • Docs procesados > 10 pág  → document_billing_items (pending)      │
 │   → syncPreapprovalAmount() sube el monto                          │
 │ • Interacciones            → filas en agentuse (se cuentan al cierre)│
 └────────────────────────────────────────────────────────────────────┘
              │
              ▼  (día 1 del mes siguiente, CRON backend)
 ┌─ Cálculo de uso ───────────────────────────────────────────────────┐
 │ runUsageBillingBatch(mes cerrado)                                  │
 │   → usage_billing_items (pending)                                  │
 │   → POST /api/billing/sync-preapproval → sube el monto             │
 └────────────────────────────────────────────────────────────────────┘
              │
              ▼  (next_payment_date del cliente)
 ┌─ Cobro (MP) ───────────────────────────────────────────────────────┐
 │ MP cobra: base + docs_pending + uso_pending                        │
 │ webhook authorized_payment:                                        │
 │   • crea invoice (con descripción desglosada)                      │
 │   • marca docs + uso como PAID                                     │
 │   • actualiza next_payment_date                                    │
 │   • resetea preapproval al monto base                              │
 └────────────────────────────────────────────────────────────────────┘
              │
              ▼  (si el pago falla)
 ┌─ Cobranza / corte (CRON diario backend) ───────────────────────────┐
 │ account-lifecycle: aviso previo → tras la gracia, desconecta canales│
 └────────────────────────────────────────────────────────────────────┘
```

---

## 8. Ciclo de vida de cuentas (cortes)

`src/services/account-lifecycle.service.ts` + `src/jobs/account-lifecycle.job.ts` (CRON diario `0 13 * * *`).

- **Trials:** avisa a los que vencen dentro de la gracia; tras la gracia desconecta canales (salvo que tengan billing autorizado).
- **Planes:** avisa cuando `next_payment_date` está por vencer; tras la gracia sin renovar, desconecta canales y pone `status='paused'`.
- Config: `ACCOUNT_LIFECYCLE_CRON`, `ACCOUNT_LIFECYCLE_GRACE_HOURS`, `ACCOUNT_LIFECYCLE_DRY_RUN`.

---

## 9. Gotchas y decisiones

- **`agentuse.client_id` es un placeholder inútil (siempre 0).** El cliente real se resuelve vía `agent_id → agent.project_id → project.client_id`. La función SQL `usage_counts_in_range` ya hace ese join.
- **Allowance por inbox del cliente, NO por link inbox→workflow.** Se descartó el modelo por-workflow porque hay inboxes con `workflow_id` null (ej. INSTAGRAM sin asignar) que hacían sobre-cobrar. Se cuenta a nivel `client_id`.
- **Opción A (mes calendario):** el excedente del mes cerrado se cobra en la próxima fecha del cliente; puede haber desfase de días. Alternativa futura: Opción B (facturar por ciclo de cada cliente).
- **Inboxes suspendidos** hoy cuentan para el allowance (se cuentan todos los no-WEB). Si se quiere que un inbox suspendido no otorgue créditos, es una línea en `client_inbox_allowance()`.
- **El precio del excedente ($14)** vive en dos lugares: `USAGE_PRICE_PER_USE_ARS` (backend) y una constante en la UI de Usage. Hoy coinciden; conviene unificar en fase 2.

---

## 10. Variables de entorno

**backend-js:**
```bash
USAGE_BILLING_DRY_RUN=true        # arrancar en dry-run la primera corrida
USAGE_BILLING_CRON=0 14 1 * *     # opcional (default: día 1, 14:00 UTC)
# USAGE_INCLUDED_PER_INBOX=1750   # opcional override
# USAGE_PRICE_PER_USE_ARS=14      # opcional override
DASHBOARD_URL=https://app.tilegra.com   # requerido (a dónde pega el sync)
INTERNAL_API_KEY=...              # requerido, MISMO valor que el dashboard
SUPABASE_URL=... / SUPABASE_SERVICE_ROLE_KEY=...
DISABLE_JOBS=true                 # en todas las instancias menos una si hay >1
```

**dashboard-tilegra:** no requiere env nueva (reusa `INTERNAL_API_KEY` y las vars de MercadoPago existentes).

---

## 11. Cómo probar

**UI Plans** (`/dashboard/plans`): mover el slider → créditos incluidos se recalculan.

**UI Usage** (`/dashboard/usage`): barra de créditos `usados/tope`, dropdown "Todos los agentes" + por agente, navegación de meses.

**CRON de uso (dry-run):**
```bash
curl -X POST http://localhost:<PORT>/api/admin/usage-billing/run \
  -H "x-internal-token: $INTERNAL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"period":"2026-06"}'
```
Para forzar un excedente de prueba: `USAGE_INCLUDED_PER_INBOX=100` y volver a correr.

**Verificar resultados:**
```sql
select client_id, billing_period, total_uses, included_uses, billable_uses, amount_ars, status
from usage_billing_items order by created_at desc;
```

---

## 12. Índice de archivos

**dashboard-tilegra**
- `lib/mercadopago.ts`
- `lib/billing/syncAmount.ts` · `tierPricing.ts` · `getBillingPlans.ts`
- `lib/billing/documentBilling.ts` · `lib/billing/usageBilling.ts`
- `app/api/webhooks/mercadopago/route.ts`
- `app/api/billing/{subscribe,update-quota,cancel,pause,resume,sync-preapproval}/route.ts`
- `app/dashboard/plans/plan-calculator.tsx` · `app/dashboard/usage/page.tsx` · `lib/client/usagePage.tsx`

**backend-js**
- `src/services/usage-billing.service.ts` · `src/jobs/usage-billing.job.ts` · `src/routes/admin/usage-billing.route.ts`
- `src/services/account-lifecycle.service.ts` · `src/jobs/account-lifecycle.job.ts`
- `db/migrations/usage_billing_items.sql`
