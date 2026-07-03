import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';

/** Usos incluidos por cada inbox NO-WEB del cliente. */
const INCLUDED_USES_PER_INBOX = Number(process.env.USAGE_INCLUDED_PER_INBOX ?? 1750);
/** Precio en ARS por cada uso por encima del allowance. */
const PRICE_PER_USE_ARS = Number(process.env.USAGE_PRICE_PER_USE_ARS ?? 14);

export type UsageBillingSummary = {
  period: string;
  clientsProcessed: number;
  clientsBillable: number;
  totalBillableUses: number;
  totalAmountArs: number;
  clientsSynced: number;
  skippedPaid: number;
  errors: number;
  dryRun: boolean;
};

type ComputedItem = {
  clientId: number;
  includedUses: number;
  totalUses: number;
  billableUses: number;
  amountArs: number;
};

function isDryRun(): boolean {
  return process.env.USAGE_BILLING_DRY_RUN === 'true';
}

/**
 * Cálculo puro del excedente de un cliente. Exportado para poder testearlo sin DB.
 *   allowance     = inboxCount * INCLUDED_USES_PER_INBOX
 *   billableUses  = max(0, totalUses - allowance)
 *   amountArs     = billableUses * PRICE_PER_USE_ARS
 */
export function computeOverage(
  totalUses: number,
  inboxCount: number,
): { includedUses: number; billableUses: number; amountArs: number } {
  const includedUses = Math.max(0, inboxCount) * INCLUDED_USES_PER_INBOX;
  const billableUses = Math.max(0, totalUses - includedUses);
  const amountArs = billableUses * PRICE_PER_USE_ARS;
  return { includedUses, billableUses, amountArs };
}

/**
 * Devuelve el período de facturación (mes calendario) inmediatamente anterior a
 * `ref` y su rango [from, to) en UTC. En el cron del día 1 esto es "el mes que
 * acaba de cerrar". `period` tiene formato 'YYYY-MM'.
 */
export function previousCalendarMonth(ref: Date = new Date()): {
  period: string;
  from: Date;
  to: Date;
} {
  const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
  const period = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
  return { period, from, to };
}

/** client_id → cantidad de inboxes NO-WEB (allowance base). */
async function getInboxAllowance(log: FastifyBaseLogger): Promise<Map<number, number>> {
  const { data, error } = await supabase.rpc('client_inbox_allowance');
  if (error) {
    log.error({ err: error }, 'client_inbox_allowance rpc error');
    return new Map();
  }
  const map = new Map<number, number>();
  for (const row of (data ?? []) as { client_id: number; inbox_count: number }[]) {
    map.set(row.client_id, Number(row.inbox_count));
  }
  return map;
}

/** client_id → usos en el rango [from, to). */
async function getUsageCounts(
  from: Date,
  to: Date,
  log: FastifyBaseLogger,
): Promise<Map<number, number>> {
  const { data, error } = await supabase.rpc('usage_counts_in_range', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) {
    log.error({ err: error }, 'usage_counts_in_range rpc error');
    return new Map();
  }
  const map = new Map<number, number>();
  for (const row of (data ?? []) as { client_id: number; uses: number }[]) {
    map.set(row.client_id, Number(row.uses));
  }
  return map;
}

/**
 * Dispara el recálculo del monto del preapproval en el dashboard (donde vive el
 * SDK de MercadoPago). Best-effort: si falla, el pending queda igual escrito y
 * se recuperará en la próxima corrida / evento.
 */
async function triggerPreapprovalSync(clientId: number, log: FastifyBaseLogger): Promise<boolean> {
  const base = (process.env.DASHBOARD_URL ?? '').replace(/\/$/, '');
  const key = process.env.INTERNAL_API_KEY;
  if (!base || !key) {
    log.warn({ client_id: clientId }, 'triggerPreapprovalSync: falta DASHBOARD_URL/INTERNAL_API_KEY — skip');
    return false;
  }
  try {
    const res = await fetch(`${base}/api/billing/sync-preapproval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({ clientId }),
    });
    if (!res.ok) {
      log.error({ client_id: clientId, status: res.status }, 'triggerPreapprovalSync: respuesta no OK');
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err, client_id: clientId }, 'triggerPreapprovalSync: fetch error');
    return false;
  }
}

/**
 * Corre el batch de facturación de excedente para un período (por defecto, el
 * mes calendario anterior). Idempotente: no pisa items ya `paid`.
 */
export async function runUsageBillingBatch(
  log: FastifyBaseLogger,
  opts: { ref?: Date; period?: { period: string; from: Date; to: Date } } = {},
): Promise<UsageBillingSummary> {
  const dryRun = isDryRun();
  const { period, from, to } = opts.period ?? previousCalendarMonth(opts.ref);

  log.info(
    { period, from: from.toISOString(), to: to.toISOString(), dryRun, includedPerInbox: INCLUDED_USES_PER_INBOX, pricePerUse: PRICE_PER_USE_ARS },
    'usage-billing: batch iniciado',
  );

  const [allowanceMap, usageMap] = await Promise.all([
    getInboxAllowance(log),
    getUsageCounts(from, to, log),
  ]);

  // Items ya existentes para este período (para respetar los ya pagados).
  const { data: existing } = await supabase
    .from('usage_billing_items')
    .select('client_id, status')
    .eq('billing_period', period);
  const existingStatus = new Map<number, string>();
  for (const r of (existing ?? []) as { client_id: number; status: string }[]) {
    existingStatus.set(r.client_id, r.status);
  }

  const items: ComputedItem[] = [];
  let skippedPaid = 0;

  // Procesamos todo cliente que tuvo uso en el período (los que no usaron no
  // generan excedente ni fila).
  for (const [clientId, totalUses] of usageMap) {
    if (existingStatus.get(clientId) === 'paid') {
      skippedPaid++;
      continue;
    }
    const inboxCount = allowanceMap.get(clientId) ?? 0;
    const { includedUses, billableUses, amountArs } = computeOverage(totalUses, inboxCount);
    items.push({ clientId, includedUses, totalUses, billableUses, amountArs });
  }

  const billable = items.filter((i) => i.billableUses > 0);
  const summary: UsageBillingSummary = {
    period,
    clientsProcessed: items.length,
    clientsBillable: billable.length,
    totalBillableUses: billable.reduce((s, i) => s + i.billableUses, 0),
    totalAmountArs: billable.reduce((s, i) => s + i.amountArs, 0),
    clientsSynced: 0,
    skippedPaid,
    errors: 0,
    dryRun,
  };

  if (dryRun) {
    log.info(summary, 'usage-billing: batch terminado (dry-run, sin escribir)');
    return summary;
  }

  // Persistir items (upsert idempotente por client_id+billing_period).
  const nowIso = new Date().toISOString();
  const rows = items.map((i) => ({
    client_id: i.clientId,
    billing_period: period,
    included_uses: i.includedUses,
    total_uses: i.totalUses,
    billable_uses: i.billableUses,
    amount_ars: i.amountArs,
    status: i.billableUses > 0 ? 'pending' : 'free',
    updated_at: nowIso,
  }));

  if (rows.length > 0) {
    const { error: upsertErr } = await supabase
      .from('usage_billing_items')
      .upsert(rows, { onConflict: 'client_id,billing_period' });
    if (upsertErr) {
      log.error({ err: upsertErr }, 'usage-billing: upsert error');
      summary.errors++;
      return summary;
    }
  }

  // Re-sincronizar el preapproval de cada cliente con excedente.
  const clientsToSync = [...new Set(billable.map((i) => i.clientId))];
  let synced = 0;
  for (const clientId of clientsToSync) {
    const ok = await triggerPreapprovalSync(clientId, log);
    if (ok) synced++;
    else summary.errors++;
  }
  summary.clientsSynced = synced;

  log.info(summary, 'usage-billing: batch terminado');
  return summary;
}

export const usageBillingService = {
  runBatch: runUsageBillingBatch,
  computeOverage,
  previousCalendarMonth,
};
