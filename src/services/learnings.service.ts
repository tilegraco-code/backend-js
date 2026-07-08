// Ingesta de "aprendizajes" de errores para la tab Aprendizaje.
// Recorre los workflows de n8n, trae las ejecuciones FALLIDAS de cada agente, resume el
// error en lenguaje natural (LLM barato) y lo guarda en agent_learnings (idempotente por
// execution_id). Las escalaciones se guardan aparte, desde /api/escalate del dashboard.
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { openaiService } from './openai.service';

const n8nHost = () => (process.env.N8N_DEFAULT_HOST ?? '').replace(/\/$/, '');
const n8nKey = () => process.env.N8N_DEFAULT_API_KEY ?? '';

// Cuántas ejecuciones fallidas recientes miramos por workflow en cada corrida.
const MAX_ERRORS_PER_WORKFLOW = 15;

async function n8nGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${n8nHost()}/api/v1${path}`, {
    headers: { 'X-N8N-API-KEY': n8nKey() },
  });
  if (!res.ok) throw new Error(`n8n ${res.status} en ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

type WorkflowRow = { agent_id: number; client_id: number | null; n8n_id: string };

export async function runLearningsIngestion(
  log: FastifyBaseLogger,
): Promise<{ created: number }> {
  if (!n8nHost() || !n8nKey()) {
    log.warn('learnings: faltan N8N_DEFAULT_HOST / N8N_DEFAULT_API_KEY — salteo');
    return { created: 0 };
  }

  const { data: workflows, error } = await supabase
    .from('n8n_workflow')
    .select('agent_id, client_id, n8n_id')
    .not('n8n_id', 'is', null);
  if (error) throw error;

  let created = 0;
  for (const wf of (workflows ?? []) as WorkflowRow[]) {
    if (!wf.agent_id || !wf.n8n_id) continue;
    try {
      created += await ingestWorkflowErrors(wf, log);
    } catch (err) {
      log.error({ err, agentId: wf.agent_id }, 'learnings: fallo al ingerir workflow');
    }
  }
  return { created };
}

async function ingestWorkflowErrors(wf: WorkflowRow, log: FastifyBaseLogger): Promise<number> {
  const list = await n8nGet(
    `/executions?workflowId=${wf.n8n_id}&status=error&limit=${MAX_ERRORS_PER_WORKFLOW}`,
  );
  const execs = ((list.data ?? []) as { id: number | string }[]).filter((e) => e?.id != null);
  if (execs.length === 0) return 0;

  // Idempotencia: no re-procesamos ejecuciones ya guardadas.
  const refs = execs.map((e) => String(e.id));
  const { data: existing } = await supabase
    .from('agent_learnings')
    .select('ref')
    .eq('agent_id', wf.agent_id)
    .eq('type', 'error')
    .in('ref', refs);
  const seen = new Set((existing ?? []).map((r) => (r as { ref: string }).ref));

  let created = 0;
  for (const e of execs) {
    const ref = String(e.id);
    if (seen.has(ref)) continue;

    let raw = 'La ejecución falló sin un mensaje de error específico.';
    let node: string | null = null;
    let startedAt: string | null = null;
    try {
      const detail = await n8nGet(`/executions/${ref}?includeData=true`);
      const data = (detail.data ?? {}) as Record<string, unknown>;
      const rd = (data.resultData ?? {}) as Record<string, unknown>;
      const errObj = (rd.error ?? {}) as { message?: string; description?: string };
      raw = errObj.message ?? errObj.description ?? raw;
      node = (rd.lastNodeExecuted as string) ?? null;
      startedAt = (detail.startedAt as string) ?? null;
    } catch (err) {
      log.error({ err, ref }, 'learnings: no pude traer el detalle de la ejecución');
    }

    let summary: string;
    try {
      summary = await openaiService.summarizeError(String(raw), node ? `nodo "${node}"` : undefined);
    } catch (err) {
      log.error({ err, ref }, 'learnings: fallo el resumen LLM');
      summary = String(raw).slice(0, 300);
    }

    const { error: insErr } = await supabase.from('agent_learnings').insert({
      agent_id: wf.agent_id,
      client_id: wf.client_id,
      type: 'error',
      source: 'n8n',
      ref,
      raw: String(raw).slice(0, 4000),
      summary,
      context: { execution_id: ref, node, started_at: startedAt },
    });
    if (insErr) {
      if (insErr.code !== '23505') log.error({ insErr, ref }, 'learnings: insert');
      continue;
    }
    created++;
  }
  return created;
}
