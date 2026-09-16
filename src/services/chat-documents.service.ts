// Documentos recibidos por chat: registro, cola de procesamiento y consulta.
// Ver docs/documentos-y-casos-plan.md.
//
// La fila se crea en la ingesta, sin pasar por el modelo: si registrar un archivo dependiera
// de que el agente llame una tool, el día que no la llame el archivo se pierde. El
// procesamiento (qué es, qué dice, si se lee) lo hace agente-tilegra; acá solo se orquesta.
import { createHash } from 'node:crypto';
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { caseRequirementsSchema } from '../schemas/case-definition';
// Solo tipos: attachment-ingest importa este servicio para registrar, y un import de valor en
// la otra dirección sería circular.
import type { StoredAttachment } from './attachment-ingest.service';
import { casesService } from './cases.service';
import { MAX_ATTEMPTS } from './chat-documents.constants';

export { MAX_ATTEMPTS };

const BUCKET = 'chat-attachments';

/** Base del backoff: 30 s, 60 s, 2 min, 4 min… */
const BACKOFF_BASE_MS = 30_000;

/** Timeout de una llamada a /documents/process. Un PDF escaneado pasa por visión y tarda. */
const PROCESS_TIMEOUT_MS = 90_000;

/**
 * Cuánto espera la ingesta a que se procesen los documentos de un caso abierto antes de
 * despachar el turno. Con eso, en el caso normal el agente ya contesta sabiendo si la licencia
 * sirve. Si se pasa, el turno sale igual y el procesamiento termina solo.
 */
const INLINE_TIMEOUT_MS = Number(process.env.CHAT_DOCUMENTS_INLINE_TIMEOUT_MS ?? 12_000);

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
  case_id: number | null;
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
   * apuntando a la original, así no se procesa ni se sube dos veces. Si el chat tiene un caso
   * activo, el documento queda asociado a él.
   *
   * Devuelve el id cuando conviene procesarlo inline (quedó pending y pertenece a un caso).
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
  ): Promise<{ inlineId: number | null }> {
    const { clientId, chatId, messageId, idx, stored } = input;
    try {
      const [{ data: original }, activeCase] = await Promise.all([
        supabase
          .from('chat_documents')
          .select('id')
          .eq('chat_id', chatId)
          .eq('sha256', input.sha256)
          .is('duplicate_of', null)
          .not('message_id', 'eq', messageId)
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle(),
        casesService.getActiveRow(clientId, chatId),
      ]);

      const status: ChatDocumentStatus =
        original || SKIPPED_KINDS.has(stored.kind) ? 'skipped' : 'pending';

      const { data: inserted, error } = await supabase
        .from('chat_documents')
        .upsert(
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
            case_id: activeCase?.id ?? null,
            sync_status: activeCase ? 'pending' : 'none',
          },
          { onConflict: 'message_id,idx', ignoreDuplicates: true },
        )
        .select('id');
      if (error) throw error;

      const id = (inserted?.[0]?.id as number | undefined) ?? null;
      if (id == null || !activeCase) return { inlineId: null };

      // Un audio o un duplicado no se procesa, pero igual cambia la evaluación del caso
      // (p. ej. un duplicado que estaba en proceso). Reevaluar es barato.
      if (status !== 'pending') {
        await casesService.reevaluate(activeCase.id, log).catch((err) =>
          log.error({ err, caseId: activeCase.id }, 'chat-documents: reevaluación falló'),
        );
        return { inlineId: null };
      }
      return { inlineId: id };
    } catch (err) {
      log.error({ err, messageId, idx }, 'chat-documents: no se pudo registrar el adjunto');
      return { inlineId: null };
    }
  },

  /**
   * Procesa ya mismo los documentos de un caso, con un tope de espera.
   *
   * Toma cada fila con un update condicionado a status = pending: si el worker ya la había
   * tomado, acá no se toma y no se procesa dos veces. Lo que no termina a tiempo sigue
   * corriendo en background.
   */
  async processInline(ids: number[], log: FastifyBaseLogger): Promise<void> {
    if (ids.length === 0) return;
    const { data, error } = await supabase
      .from('chat_documents')
      .update({ status: 'processing', locked_at: new Date().toISOString(), attempts: 1, updated_at: new Date().toISOString() })
      .in('id', ids)
      .eq('status', 'pending')
      .eq('attempts', 0)
      .select('*');
    if (error) {
      log.error({ err: error, ids }, 'chat-documents: claim inline falló — queda para el worker');
      return;
    }

    const rows = (data ?? []) as ChatDocumentRow[];
    if (rows.length === 0) return;

    const all = Promise.all(rows.map((row) => this.processOne(row, log)));
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), INLINE_TIMEOUT_MS)),
    ]);
    if (timedOut) {
      log.warn({ ids, timeoutMs: INLINE_TIMEOUT_MS }, 'chat-documents: procesamiento inline no terminó a tiempo — sigue en background');
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
    let ready = false;
    try {
      const catalog = row.case_id ? await loadCaseCatalog(row.case_id) : null;
      const result = await callRuntime(row, catalog);

      // Guardado condicionado al caso con el que se procesó. Si mientras tanto se abrió un
      // caso (o cambió de tipo y se reencoló), este resultado se clasificó contra otro
      // catálogo: no se pisa, la fila ya volvió a la cola con el correcto.
      let query = supabase
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
        .eq('id', row.id)
        .eq('status', 'processing');
      query = row.case_id == null ? query.is('case_id', null) : query.eq('case_id', row.case_id);
      const { data: saved, error } = await query.select('id');
      if (error) throw error;

      if (!saved?.length) {
        await requeueStale(row, log);
      } else {
        ready = true;
      }
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
    }

    // El caso se entera tanto de un ready como de una falla definitiva: las dos cambian lo que falta.
    const { data: current } = await supabase.from('chat_documents').select('case_id').eq('id', row.id).maybeSingle();
    const caseId = (current?.case_id as number | null) ?? null;
    if (caseId != null) {
      await casesService.reevaluate(caseId, log).catch((err) =>
        log.error({ err, caseId }, 'chat-documents: reevaluación falló'),
      );
    }
    return ready;
  },
};

/** El resultado llegó tarde (cambió el caso mientras se procesaba): vuelve a la cola. */
async function requeueStale(row: ChatDocumentRow, log: FastifyBaseLogger): Promise<void> {
  const { error } = await supabase
    .from('chat_documents')
    .update({
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'processing');
  if (error) log.error({ err: error, documentId: row.id }, 'chat-documents: no se pudo reencolar');
  else log.info({ documentId: row.id }, 'chat-documents: cambió el caso durante el procesamiento — reencolado');
}

type RuntimeCatalog = {
  catalog: { key: string; label: string; description: string; fields: { key: string; label: string; type: string }[] }[];
  expected: string[];
};

/** Catálogo con el que se clasifica: el que quedó copiado en el caso al abrirlo. */
async function loadCaseCatalog(caseId: number): Promise<RuntimeCatalog | null> {
  const { data } = await supabase.from('chat_cases').select('requirements').eq('id', caseId).maybeSingle();
  const parsed = caseRequirementsSchema.safeParse(data?.requirements);
  if (!parsed.success) return null;
  return {
    catalog: Object.values(parsed.data.catalog),
    expected: [...new Set(parsed.data.definition.documents.map((d) => d.type))],
  };
}

async function callRuntime(row: ChatDocumentRow, catalog: RuntimeCatalog | null): Promise<ProcessResult> {
  const base = process.env.AGENT_RUNTIME_URL;
  if (!base) throw new Error('AGENT_RUNTIME_URL no configurado');

  // Firmada en el momento: la de la ingesta ya puede estar vencida.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    throw new Error(`no se pudo firmar la URL del adjunto: ${signError?.message ?? 'sin URL'}`);
  }

  const res = await fetch(`${base.replace(/\/$/, '')}/documents/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.INTERNAL_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      document_id: row.id,
      url: signed.signedUrl,
      kind: row.kind,
      mime: row.mime,
      name: row.name,
      ...(catalog && catalog.catalog.length > 0 ? catalog : {}),
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
