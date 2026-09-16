// Documentos recibidos por chat: registro, cola de procesamiento y consulta.
// Ver docs/documentos-y-casos-plan.md.
//
// La fila se crea en la ingesta, sin pasar por el modelo: si registrar un archivo dependiera
// de que el agente llame una tool, el día que no la llame el archivo se pierde. El
// procesamiento (qué es, qué dice, si se lee) lo hace agente-tilegra; acá solo se orquesta.
import { createHash } from 'node:crypto';
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
// Solo tipos: attachment-ingest importa este servicio para registrar, y un import de valor en
// la otra dirección sería circular.
import type { StoredAttachment } from './attachment-ingest.service';

const BUCKET = 'chat-attachments';

/** Intentos antes de dejar un documento en failed para siempre. */
export const MAX_ATTEMPTS = 5;

/** Base del backoff: 30 s, 60 s, 2 min, 4 min… */
const BACKOFF_BASE_MS = 30_000;

/** Timeout de una llamada a /documents/process. Un PDF escaneado pasa por visión y tarda. */
const PROCESS_TIMEOUT_MS = 90_000;

/** Vida de la URL que se le pasa al runtime. Alcanza con que dure el procesamiento. */
const SIGNED_URL_TTL_SECONDS = 600;

/** Lo que el runtime no procesa. Se registran igual: son evidencia y se sincronizan a Drive. */
const SKIPPED_KINDS = new Set(['audio', 'video', 'other']);

export type ChatDocumentStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'skipped';

export type ChatDocumentRow = {
  id: number;
  client_id: number;
  chat_id: string;
  message_id: string;
  idx: number;
  storage_path: string;
  kind: StoredAttachment['kind'];
  mime: string;
  name: string | null;
  size: number | null;
  sha256: string;
  doc_type: string | null;
  confidence: number | null;
  summary: string | null;
  extracted: Record<string, unknown> | null;
  legible: boolean | null;
  issues: string[] | null;
  status: ChatDocumentStatus;
  attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  last_error: string | null;
  duplicate_of: number | null;
  created_at: string;
  updated_at: string;
};

/** Respuesta de agente-tilegra POST /documents/process. */
type ProcessResult = {
  summary: string;
  legible: boolean;
  issues?: string[];
  doc_type?: string | null;
  confidence?: number | null;
  extracted?: Record<string, unknown> | null;
};

/** Error que no vale la pena reintentar (archivo corrupto, formato no soportado). */
class PermanentProcessError extends Error {}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const chatDocumentsService = {
  /**
   * Registra un adjunto recién guardado en Storage.
   *
   * Idempotente por (message_id, idx): si el proveedor reintenta el webhook, no duplica.
   * Si el cliente ya había mandado el mismo archivo en este chat, la fila queda skipped
   * apuntando a la original, así no se procesa ni se sube dos veces.
   *
   * Nunca lanza: que falle el registro no puede cortar la ingesta ni el turno.
   */
  async register(
    input: {
      clientId: number;
      chatId: string;
      messageId: string;
      idx: number;
      stored: StoredAttachment;
      sha256: string;
    },
    log: FastifyBaseLogger,
  ): Promise<void> {
    const { clientId, chatId, messageId, idx, stored } = input;
    try {
      const { data: original } = await supabase
        .from('chat_documents')
        .select('id')
        .eq('chat_id', chatId)
        .eq('sha256', input.sha256)
        .is('duplicate_of', null)
        .not('message_id', 'eq', messageId)
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      const status: ChatDocumentStatus =
        original || SKIPPED_KINDS.has(stored.kind) ? 'skipped' : 'pending';

      const { error } = await supabase.from('chat_documents').upsert(
        {
          client_id: clientId,
          chat_id: chatId,
          message_id: messageId,
          idx,
          storage_path: stored.path,
          kind: stored.kind,
          mime: stored.mime,
          name: stored.name,
          size: stored.size,
          sha256: input.sha256,
          status,
          duplicate_of: original?.id ?? null,
        },
        { onConflict: 'message_id,idx', ignoreDuplicates: true },
      );
      if (error) throw error;
    } catch (err) {
      log.error({ err, messageId, idx }, 'chat-documents: no se pudo registrar el adjunto');
    }
  },

  /** Documentos de un chat, del más viejo al más nuevo. Scopeado por cliente. */
  async listForChat(clientId: number, chatId: string): Promise<ChatDocumentRow[]> {
    const { data, error } = await supabase
      .from('chat_documents')
      .select('*')
      .eq('client_id', clientId)
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .order('idx', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ChatDocumentRow[];
  },

  /**
   * Una pasada de la cola: toma lo vencido y lo procesa en paralelo.
   *
   * El claim es atómico (SKIP LOCKED en la función SQL), así que dos pasadas solapadas no
   * procesan la misma fila. Devuelve cuántas filas tomó y cuántas terminaron en ready.
   */
  async processBatch(log: FastifyBaseLogger, limit = 5): Promise<{ claimed: number; ready: number }> {
    const { data, error } = await supabase.rpc('claim_chat_documents', {
      p_limit: limit,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) throw error;

    const rows = (data ?? []) as ChatDocumentRow[];
    const results = await Promise.all(rows.map((row) => this.processOne(row, log)));
    return { claimed: rows.length, ready: results.filter(Boolean).length };
  },

  /** Procesa una fila ya tomada (status = processing). Devuelve true si quedó ready. */
  async processOne(row: ChatDocumentRow, log: FastifyBaseLogger): Promise<boolean> {
    try {
      const result = await callRuntime(row);
      const { error } = await supabase
        .from('chat_documents')
        .update({
          status: 'ready',
          summary: result.summary,
          legible: result.legible,
          issues: result.issues ?? [],
          doc_type: result.doc_type ?? null,
          confidence: result.confidence ?? null,
          extracted: result.extracted ?? null,
          locked_at: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;
      return true;
    } catch (err) {
      const permanent = err instanceof PermanentProcessError;
      const attempts = permanent ? MAX_ATTEMPTS : row.attempts;
      const delay = BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempts - 1);
      const message = err instanceof Error ? err.message : String(err);

      log.warn(
        { documentId: row.id, attempts, permanent, err: message },
        'chat-documents: procesamiento falló',
      );

      const { error } = await supabase
        .from('chat_documents')
        .update({
          status: 'failed',
          attempts,
          next_attempt_at: new Date(Date.now() + delay).toISOString(),
          locked_at: null,
          last_error: message.slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) log.error({ err: error, documentId: row.id }, 'chat-documents: no se pudo marcar failed');
      return false;
    }
  },
};

async function callRuntime(row: ChatDocumentRow): Promise<ProcessResult> {
  const base = process.env.AGENT_RUNTIME_URL;
  if (!base) throw new Error('AGENT_RUNTIME_URL no configurado');

  // Firmada en el momento: la de la ingesta ya puede estar vencida.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    throw new Error(`no se pudo firmar la URL del adjunto: ${signError?.message ?? 'sin URL'}`);
  }
  const url = signed.signedUrl;

  const res = await fetch(`${base.replace(/\/$/, '')}/documents/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.INTERNAL_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      document_id: row.id,
      url,
      kind: row.kind,
      mime: row.mime,
      name: row.name,
    }),
    signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
  });

  if (res.status === 422) {
    throw new PermanentProcessError(`runtime 422: ${(await res.text()).slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`runtime ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as ProcessResult;
}
