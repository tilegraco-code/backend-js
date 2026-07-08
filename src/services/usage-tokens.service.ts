// Backfill de tokens en agentuse (Camino B). Los tokenUsage viven en el sub-nodo del
// modelo (conexión ai_languageModel, ~1 corrida por llamada del Tool Router) y NO son
// accesibles desde una expresión de n8n. El nodo Store Interaction guarda el execution_id;
// este job pega a la API de n8n, suma las llamadas y completa input_tokens/output_tokens.
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';

const n8nHost = () => (process.env.N8N_DEFAULT_HOST ?? '').replace(/\/$/, '');
const n8nKey = () => process.env.N8N_DEFAULT_API_KEY ?? '';

// Cuántas filas pendientes procesamos por corrida y hasta qué antigüedad las intentamos
// (después de eso n8n puede haber podado la ejecución → dejamos de reintentar).
const MAX_ROWS_PER_RUN = 60;
const MAX_AGE_HOURS = 48;

async function n8nGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${n8nHost()}/api/v1${path}`, {
    headers: { 'X-N8N-API-KEY': n8nKey() },
  });
  if (!res.ok) throw new Error(`n8n ${res.status} en ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

// Suma promptTokens/completionTokens de TODAS las llamadas al modelo de la ejecución.
// Robusto al nombre del nodo: recorre runData buscando la salida ai_languageModel.
function sumExecutionTokens(detail: Record<string, unknown>): { input: number; output: number } {
  const data = (detail.data ?? {}) as Record<string, unknown>;
  const runData = ((data.resultData ?? {}) as Record<string, unknown>).runData ?? {};
  let input = 0;
  let output = 0;
  for (const runs of Object.values(runData as Record<string, unknown>)) {
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      const lm = (run as { data?: { ai_languageModel?: unknown } })?.data?.ai_languageModel;
      if (!Array.isArray(lm)) continue;
      for (const branch of lm) {
        if (!Array.isArray(branch)) continue;
        for (const item of branch) {
          const tu = (item as { json?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } } })
            ?.json?.tokenUsage;
          if (tu) {
            input += tu.promptTokens ?? 0;
            output += tu.completionTokens ?? 0;
          }
        }
      }
    }
  }
  return { input, output };
}

type PendingRow = { log_id: number; execution_id: string };

export async function runTokenBackfill(log: FastifyBaseLogger): Promise<{ updated: number }> {
  if (!n8nHost() || !n8nKey()) {
    log.warn('token-backfill: faltan N8N_DEFAULT_HOST / N8N_DEFAULT_API_KEY — salteo');
    return { updated: 0 };
  }

  const since = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from('agentuse')
    .select('log_id, execution_id')
    .not('execution_id', 'is', null)
    .eq('tokens_synced', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS_PER_RUN);
  if (error) throw error;

  let updated = 0;
  for (const row of (rows ?? []) as PendingRow[]) {
    try {
      const detail = await n8nGet(`/executions/${row.execution_id}?includeData=true`);
      const { input, output } = sumExecutionTokens(detail);
      // total_tokens es una columna generada (input + output) → se recalcula sola.
      const { error: upErr } = await supabase
        .from('agentuse')
        .update({ input_tokens: input, output_tokens: output, tokens_synced: true })
        .eq('log_id', row.log_id);
      if (upErr) {
        log.error({ upErr, logId: row.log_id }, 'token-backfill: update');
        continue;
      }
      updated++;
    } catch (err) {
      // Ejecución todavía no disponible / error transitorio → queda pendiente para el próximo tick.
      log.error({ err, execId: row.execution_id }, 'token-backfill: fallo la ejecución');
    }
  }
  return { updated };
}
