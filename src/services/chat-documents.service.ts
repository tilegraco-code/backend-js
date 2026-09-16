// Documentos recibidos por chat: registro, cola de revisión y consulta.
// Ver docs/documentos-y-casos-plan.md.
//
// La fila se crea en la ingesta, sin pasar por el modelo: si registrar un archivo dependiera
// de que el agente llame una tool, el día que no la llame el archivo se pierde.
//
// Solo se REVISAN los documentos que pertenecen a un caso: la revisión consume tokens y cada una
// se le cobra al cliente como un uso. Los demás quedan registrados (skipped) y, si después se
// abre un caso en el chat, vuelven a la cola.
import { createHash } from 'node:crypto';
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { caseRequirementsSchema } from '../schemas/case-definition';
// Solo tipos: attachment-ingest importa este servicio para registrar, y un import de valor en
// la otra dirección sería circular.
import type { StoredAttachment } from './attachment-ingest.service';
import { recordAgentUse, type InvokeResponse } from './agent-runtime.service';
import { casesService, type CaseView } from './cases.service';
import { MAX_ATTEMPTS } from './chat-documents.constants';

export { MAX_ATTEMPTS };

const BUCKET = 'chat-attachments';

/** Base del backoff: 30 s, 60 s, 2 min, 4 min… */
const BACKOFF_BASE_MS = 30_000;

/** Timeout de una llamada a /documents/process. */
const PROCESS_TIMEOUT_MS = 60_000;

/**
 * Cuánto espera la ingesta a que se revisen los documentos de un caso abierto antes de
 * despachar el turno. Con eso, en el caso normal el agente ya contesta sabiendo si la foto
 * sirve. Si se pasa, el turno sale igual y el resultado llega por un aviso proactivo.
 */
const INLINE_TIMEOUT_MS = Number(process.env.CHAT_DOCUMENTS_INLINE_TIMEOUT_MS ?? 12_000);

/** Vida de la URL que se le pasa al runtime. Alcanza con que dure la revisión. */
const SIGNED_URL_TTL_SECONDS = 600;

/** Lo que se puede revisar. Audio, video y otros se registran igual: son evidencia y van a Drive. */
const REVIEWABLE_KINDS = new Set(['image', 'document']);

/** Canal con el que queda la revisión en agentuse. */
const REVIEW_CHANNEL = 'document_review';

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
  legible: boolean | null;
  issues: string[] | null;
  status: ChatDocumentStatus;
  attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  last_error: string | null;
  duplicate_of: number | null;
  case_id: number | null;
  external_ref: { drive_name?: string; drive_file_id?: string; drive_url?: string } | null;
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
  usage?: InvokeResponse['usage'];
};

/**
 * Si la revisión corre dentro de la espera del turno, el agente ve el resultado al responder y
 * no hace falta avisar. Si terminó afuera (worker, o la espera venció), sí.
 */
type ProcessContext = { inTurn: boolean };

/** Error que no vale la pena reintentar (archivo corrupto, formato no soportado). */
class PermanentProcessError extends Error {}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const chatDocumentsService = {
  /**
   * Registra un adjunto recién guardado en Storage.
   *
   * Idempotente por (message_id, idx). Un archivo repetido en el mismo chat queda skipped
   * apuntando al original. Si el chat tiene un caso activo, queda asociado y en cola; si no,
   * queda registrado sin revisar.
   *
   * Devuelve el id cuando conviene revisarlo inline. Nunca lanza: que falle el registro no
   * puede cortar la ingesta ni el turno.
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

      const reviewable = Boolean(activeCase) && !original && REVIEWABLE_KINDS.has(stored.kind);
      const status: ChatDocumentStatus = reviewable ? 'pending' : 'skipped';

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
            sync_status: activeCase && !original ? 'pending' : 'none',
          },
          { onConflict: 'message_id,idx', ignoreDuplicates: true },
        )
        .select('id');
      if (error) throw error;

      const id = (inserted?.[0]?.id as number | undefined) ?? null;
      if (id == null || !activeCase) return { inlineId: null };
      if (reviewable) return { inlineId: id };

      // Un audio o un video del caso no se revisa, pero hay que subirlo a Drive: la
      // reevaluación marca el caso para sincronizar.
      await casesService.reevaluate(activeCase.id, log).catch((err) =>
        log.error({ err, caseId: activeCase.id }, 'chat-documents: reevaluación falló'),
      );
      return { inlineId: null };
    } catch (err) {
      log.error({ err, messageId, idx }, 'chat-documents: no se pudo registrar el adjunto');
      return { inlineId: null };
    }
  },

  /**
   * Revisa ya mismo los documentos de un caso, con un tope de espera.
   *
   * Toma cada fila con un update condicionado a status = pending: si el worker ya la había
   * tomado, acá no se toma y no se revisa dos veces. Lo que no termina a tiempo sigue corriendo
   * y, como ya no llega al turno, pide un aviso proactivo.
   */
  async processInline(ids: number[], log: FastifyBaseLogger): Promise<void> {
    if (ids.length === 0) return;
    const { data, error } = await supabase
      .from('chat_documents')
      .update({ status: 'processing', locked_at: new Date().toISOString(), attempts: 1, updated_at: new Date().toISOString() })
      .in('id', ids)
      .eq('status', 'pending')
      .select('*');
    if (error) {
      log.error({ err: error, ids }, 'chat-documents: claim inline falló — queda para el worker');
      return;
    }

    const rows = (data ?? []) as ChatDocumentRow[];
    if (rows.length === 0) return;

    const ctx: ProcessContext = { inTurn: true };
    const all = Promise.all(rows.map((row) => this.processOne(row, log, ctx)));
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), INLINE_TIMEOUT_MS)),
    ]);
    if (timedOut) {
      ctx.inTurn = false;
      log.warn({ ids, timeoutMs: INLINE_TIMEOUT_MS }, 'chat-documents: revisión inline no terminó a tiempo — sigue en background');
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
   * Una pasada de la cola: toma lo vencido y lo revisa en paralelo.
   *
   * El claim es atómico (SKIP LOCKED en la función SQL), así que dos pasadas solapadas no
   * revisan la misma fila. Devuelve cuántas filas tomó y cuántas terminaron en ready.
   */
  async processBatch(log: FastifyBaseLogger, limit = 5): Promise<{ claimed: number; ready: number }> {
    const { data, error } = await supabase.rpc('claim_chat_documents', {
      p_limit: limit,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) throw error;

    const rows = (data ?? []) as ChatDocumentRow[];
    const ctx: ProcessContext = { inTurn: false };
    const results = await Promise.all(rows.map((row) => this.processOne(row, log, ctx)));
    return { claimed: rows.length, ready: results.filter(Boolean).length };
  },

  /** Revisa una fila ya tomada (status = processing). Devuelve true si quedó ready. */
  async processOne(row: ChatDocumentRow, log: FastifyBaseLogger, ctx: ProcessContext): Promise<boolean> {
    const reviewCase = row.case_id ? await loadReviewCase(row.case_id) : null;
    if (!reviewCase) {
      // Sin caso no se revisa (p. ej. se canceló mientras estaba en cola).
      await supabase
        .from('chat_documents')
        .update({ status: 'skipped', locked_at: null, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'processing');
      return false;
    }

    let outcome: { kind: 'ready'; result: ProcessResult } | { kind: 'failed'; permanent: boolean } | { kind: 'stale' };
    try {
      const result = await callRuntime(row, reviewCase);

      // Se cobra apenas se gastaron tokens, antes de guardar: si el guardado falla o el
      // resultado llega tarde, la revisión igual se hizo.
      await chargeReview(row, reviewCase.agentId, result, log);

      // Guardado condicionado al caso con el que se revisó. Si mientras tanto el caso cambió de
      // tipo y el documento se reencoló, este resultado se hizo contra otro catálogo: no se pisa.
      const { data: saved, error } = await supabase
        .from('chat_documents')
        .update({
          status: 'ready',
          summary: result.summary,
          legible: result.legible,
          issues: result.issues ?? [],
          doc_type: result.doc_type ?? null,
          confidence: result.confidence ?? null,
          locked_at: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'processing')
        .eq('case_id', row.case_id!)
        .select('id');
      if (error) throw error;

      if (saved?.length) {
        outcome = { kind: 'ready', result };
      } else {
        await requeueStale(row, log);
        outcome = { kind: 'stale' };
      }
    } catch (err) {
      const permanent = err instanceof PermanentProcessError;
      const attempts = permanent ? MAX_ATTEMPTS : row.attempts;
      const delay = BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempts - 1);
      const message = err instanceof Error ? err.message : String(err);

      log.warn({ documentId: row.id, attempts, permanent, err: message }, 'chat-documents: revisión falló');

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
      outcome = { kind: 'failed', permanent: permanent || attempts >= MAX_ATTEMPTS };
    }

    if (outcome.kind === 'stale') return false;

    // El caso se entera tanto de un ready como de una falla: las dos cambian lo que falta.
    let view: CaseView | null = null;
    try {
      view = await casesService.reevaluate(row.case_id!, log);
    } catch (err) {
      log.error({ err, caseId: row.case_id }, 'chat-documents: reevaluación falló');
    }

    if (!ctx.inTurn && view && worthNotifying(outcome, reviewCase.expected, view)) {
      await requestNotify(row.case_id!, log);
    }
    return outcome.kind === 'ready';
  },
};

/**
 * ¿El cliente tiene que enterarse ya? Solo si hay algo que hacer (reenviar, mandar lo que
 * corresponde) o si el caso quedó completo. Un "llegó bien" no justifica un mensaje.
 */
export function worthNotifying(
  outcome: { kind: 'ready'; result: ProcessResult } | { kind: 'failed'; permanent: boolean },
  expected: string[],
  view: CaseView,
): boolean {
  if (view.status === 'complete') return true;
  if (outcome.kind === 'failed') return outcome.permanent;
  const { result } = outcome;
  return result.legible === false || !result.doc_type || !expected.includes(result.doc_type);
}

async function requestNotify(caseId: number, log: FastifyBaseLogger): Promise<void> {
  // Solo si no había uno pendiente: así varios resultados seguidos salen en un solo aviso.
  const { error } = await supabase
    .from('chat_cases')
    .update({ notify_requested_at: new Date().toISOString() })
    .eq('id', caseId)
    .is('notify_requested_at', null);
  if (error) log.error({ err: error, caseId }, 'chat-documents: no se pudo pedir el aviso');
}

/** Una revisión con tokens es un uso: queda en agentuse y entra en el cobro por uso. */
async function chargeReview(
  row: ChatDocumentRow,
  agentId: number,
  result: ProcessResult,
  log: FastifyBaseLogger,
): Promise<void> {
  const u = result.usage ?? {};
  const tokens = (u.input_tokens ?? 0) + (u.input_cached_tokens ?? 0) + (u.output_tokens ?? 0);
  if (tokens === 0) return;
  await recordAgentUse(
    {
      agentId,
      clientId: row.client_id,
      channel: REVIEW_CHANNEL,
      question: `[Revisión de documento #${row.id}] ${row.name ?? row.kind}`,
      response: `${result.doc_type ?? 'sin tipo'}${result.legible === false ? ' (no se lee)' : ''}`,
      usage: result.usage,
    },
    log,
  );
}

/** El resultado llegó tarde (cambió el caso mientras se revisaba): vuelve a la cola. */
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
  else log.info({ documentId: row.id }, 'chat-documents: cambió el caso durante la revisión — reencolado');
}

type ReviewCase = {
  agentId: number;
  catalog: { key: string; label: string; description: string }[];
  expected: string[];
};

/** Catálogo con el que se revisa: el que quedó copiado en el caso al abrirlo. Null si no está activo. */
async function loadReviewCase(caseId: number): Promise<ReviewCase | null> {
  const { data } = await supabase
    .from('chat_cases')
    .select('agent_id, status, requirements')
    .eq('id', caseId)
    .maybeSingle();
  if (!data || !['open', 'complete'].includes(data.status as string)) return null;
  const parsed = caseRequirementsSchema.safeParse(data.requirements);
  if (!parsed.success) return null;
  return {
    agentId: data.agent_id as number,
    catalog: Object.values(parsed.data.catalog).map((c) => ({ key: c.key, label: c.label, description: c.description })),
    expected: [...new Set(parsed.data.definition.documents.map((d) => d.type))],
  };
}

async function callRuntime(row: ChatDocumentRow, reviewCase: ReviewCase): Promise<ProcessResult> {
  const base = process.env.AGENT_RUNTIME_URL;
  if (!base) throw new Error('AGENT_RUNTIME_URL no configurado');
  if (reviewCase.catalog.length === 0) {
    throw new PermanentProcessError('el caso no tiene catálogo de documentos');
  }

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
      catalog: reviewCase.catalog,
      expected: reviewCase.expected,
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
