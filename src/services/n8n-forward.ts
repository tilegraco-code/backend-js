import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';

/**
 * Forwarder genérico desde un webhook (Unipile o Evolution) hacia el workflow
 * n8n vinculado. POSTea el payload tal cual (crudo) al webhook del workflow.
 *
 * Es payload-agnóstico: solo resuelve `n8n_workflow.webhook_path` por id y hace
 * el POST. La decisión de SI forwardear (chat en estado `ia` + workflow asignado)
 * la toma el servicio que llama, igual que antes.
 *
 * Pensado para llamarse via setImmediate post-reply, así no bloquea el ACK.
 */
export async function forwardToN8n(
  payload: unknown,
  workflowId: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const n8nHost = process.env.N8N_DEFAULT_HOST;
  if (!n8nHost) {
    log.warn('N8N_DEFAULT_HOST no configurado — saltando forward');
    return;
  }

  const { data: workflow, error } = await supabase
    .from('n8n_workflow')
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
