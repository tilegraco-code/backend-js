import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';

/**
 * Formato ÚNICO que recibe n8n, sin importar el provider (Unipile / Evolution).
 * Cada servicio normaliza su payload a esto antes de forwardear, así los flows
 * de n8n parsean siempre los mismos campos y no se rompen entre providers.
 */
export type N8nForwardPayload = {
  chat_id: string;
  nombre: string;
  question: string;
};

/**
 * Forwarder hacia el workflow n8n vinculado. POSTea el envelope normalizado.
 *
 * Solo resuelve `workflow.webhook_path` por id y hace el POST. La decisión
 * de SI forwardear (chat en estado `ia` + workflow asignado) la toma el servicio
 * que llama.
 *
 * Pensado para llamarse via setImmediate post-reply, así no bloquea el ACK.
 */
export async function forwardToN8n(
  payload: N8nForwardPayload,
  workflowId: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const n8nHost = process.env.N8N_DEFAULT_HOST;
  if (!n8nHost) {
    log.warn('N8N_DEFAULT_HOST no configurado — saltando forward');
    return;
  }

  const { data: workflow, error } = await supabase
    .from('workflow')
    .select('webhook_path')
    .eq('id', workflowId)
    .single();

  if (error || !workflow?.webhook_path) {
    log.warn({ workflowId, error }, 'workflow sin webhook_path');
    return;
  }

  const webhookUrl = `${n8nHost.replace(/\/$/, '')}/webhook/${workflow.webhook_path}`;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    log.error({ err: e, webhookUrl }, 'n8n forward error');
  }
}
