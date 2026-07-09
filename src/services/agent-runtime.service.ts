// Ruteo de ejecución del agente: n8n (flujo actual) vs agente-tilegra (LangGraph).
// El backend recibe el mensaje, decide el runtime por `agent.runtime`, y en el caso
// LangGraph orquesta él mismo TODO lo que antes hacía n8n al final: enviar la respuesta
// al canal, escribir agentuse (con los tokens que ya vienen inline) y escalar si hace falta.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { outgoingMessageService } from './outgoing-message.service';
import { forwardToN8n, N8nForwardPayload } from './n8n-forward';

type InvokeResponse = {
  response?: string | null;
  escalated?: boolean;
  escalation_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  skipped?: boolean;
};

// Fecha de hoy (YYYY-MM-DD) en horario de Argentina — lo que hacía el nodo Date&Time de n8n.
function currentDateAr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
}

/**
 * Ejecuta el turno vía agente-tilegra y se hace cargo de los side-effects.
 */
export async function runViaAgent(
  payload: N8nForwardPayload,
  agentId: number,
  clientId: number,
  channel: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const url = process.env.AGENT_RUNTIME_URL;
  const internalKey = process.env.INTERNAL_API_KEY ?? '';
  if (!url) {
    log.warn('AGENT_RUNTIME_URL no configurado — no puedo ejecutar el flujo LangGraph');
    return;
  }

  // 1. Invocar al agente (caja negra).
  let result: InvokeResponse;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalKey}` },
      body: JSON.stringify({
        agent_id: agentId,
        chat_id: payload.chat_id,
        message: payload.question,
        context: { sender_name: payload.nombre, current_date: currentDateAr(), channel },
      }),
    });
    if (!res.ok) {
      log.error({ status: res.status, agentId }, 'agente-tilegra /invoke no-2xx');
      return;
    }
    result = (await res.json()) as InvokeResponse;
  } catch (e) {
    log.error({ err: e, agentId }, 'agente-tilegra /invoke error');
    return;
  }

  // Debounce descartó este turno (llegó un mensaje más nuevo).
  if (result.skipped) return;

  const response = (result.response ?? '').trim();

  // 2. Enviar la respuesta al canal (reusa el envío saliente del backend).
  if (response) {
    const sent = await outgoingMessageService.sendOutgoing(
      { clientId, chatId: payload.chat_id, text: response },
      log,
    );
    if (!sent.ok) log.error({ agentId, chatId: payload.chat_id, err: sent.error }, 'envío falló');
  }

  // 3. agentuse — con los tokens INLINE (no necesita el backfill).
  const usage = result.usage ?? {};
  const { error: useErr } = await supabase.from('agentuse').insert({
    agent_id: agentId,
    client_id: clientId,
    channel,
    question: payload.question,
    response,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    tokens_synced: true,
  });
  if (useErr) log.error({ useErr, agentId }, 'agentuse insert falló');

  // 4. Escalación (si el agente decidió pasar a humano) — reusa el /api/escalate del dashboard.
  if (result.escalated) {
    const dashboardUrl = process.env.DASHBOARD_URL;
    if (dashboardUrl) {
      try {
        await fetch(`${dashboardUrl.replace(/\/$/, '')}/api/escalate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey },
          body: JSON.stringify({ chat_id: payload.chat_id, reason: result.escalation_reason }),
        });
      } catch (e) {
        log.error({ err: e, agentId }, 'escalación falló');
      }
    }
  }
}

/**
 * Decide el runtime del agente vinculado al workflow y ejecuta por el camino que corresponda.
 * Reemplaza la llamada directa a `forwardToN8n` en los webhooks.
 */
export async function dispatchToRuntime(
  payload: N8nForwardPayload,
  workflowId: number,
  channel: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const { data: wf } = await supabase
    .from('n8n_workflow')
    .select('agent_id, client_id')
    .eq('id', workflowId)
    .single();

  if (!wf?.agent_id) {
    // Sin agente resuelto → comportamiento actual (n8n).
    await forwardToN8n(payload, workflowId, log);
    return;
  }

  const { data: agent } = await supabase
    .from('agent')
    .select('runtime')
    .eq('agent_id', wf.agent_id)
    .maybeSingle();

  if ((agent?.runtime ?? 'n8n') === 'langgraph') {
    await runViaAgent(payload, wf.agent_id, wf.client_id ?? 0, channel, log);
  } else {
    await forwardToN8n(payload, workflowId, log);
  }
}
