// Preguntas en publicaciones de MercadoLibre. Ver docs/mercadolibre-preguntas-plan.md.
//
// A diferencia de los DMs, una pregunta NO es un chat: se responde en público en la
// publicación y no pasa por la bandeja. Por eso no toca unipile_chats/messages y usa
// el agente sin los side-effects de runViaAgent (invokeAgent + recordAgentUse).
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { getOwnerEmail } from '../lib/owner-email';
import { invokeAgent, recordAgentUse } from './agent-runtime.service';
import { emailService, mercadolibreEmails } from './email.service';
import { MercadolibreApiError, MAX_ANSWER_LENGTH, mercadolibreApiService } from './mercadolibre-api.service';
import { buildAnswer, mercadolibreService } from './mercadolibre.service';
import type {
  MercadolibreItem,
  MercadolibreNotification,
  MercadolibreQuestion,
} from '../types/mercadolibre';

export const QUESTIONS_CHANNEL = 'mercadolibre_questions';

type QuestionStatus = 'pending' | 'answered' | 'needs_human' | 'auto_off' | 'failed' | 'closed';

type QuestionRow = {
  question_id: number;
  client_id: number;
  ml_user_id: number;
  item_id: string;
  item_title: string | null;
  buyer_id: number | null;
  buyer_nickname: string | null;
  question: string;
  status: QuestionStatus;
  answered_by: 'ai' | 'seller' | null;
  claimed_at: string | null;
};

type ProcessResult = { ok: true; skipped?: string; status?: QuestionStatus } | { ok: false; error: string };

/** Estados de ML en los que la pregunta ya no se puede responder. */
const ML_CLOSED = new Set(['CLOSED_UNANSWERED', 'BANNED', 'DELETED', 'DISABLED']);

/** Cuánto de la descripción de la publicación le pasamos al agente. */
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_ATTRIBUTES = 25;
const MAX_PREVIOUS_QUESTIONS = 3;

/** Un turno del agente (item + descripción + LLM + POST) no debería pasar de esto. */
const IN_FLIGHT_MARGIN_MS = 5 * 60_000;

// ---------- HELPERS ----------

/** Comprador: `buyer_id` en GET /questions/{id}, `from.id` en /questions/search. */
function buyerIdOf(question: MercadolibreQuestion): number | null {
  return question.buyer_id ?? question.from?.id ?? null;
}

/** `/questions/123` → `123`. También tolera el id pelado. */
function questionIdFrom(resource: string): string | null {
  const match = resource.trim().match(/(\d+)\/?$/);
  return match?.[1] ?? null;
}

async function patchQuestion(questionId: number, patch: Record<string, unknown>): Promise<void> {
  await supabase
    .from('mercadolibre_questions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('question_id', questionId);
}

/** Datos de la publicación en texto plano para el agente. Best-effort por partes. */
function describeItem(item: MercadolibreItem | null, description: string | null): string {
  if (!item) return 'No se pudieron obtener los datos de la publicación.';

  const lines: string[] = [];
  if (item.title) lines.push(`Título: ${item.title}`);
  if (item.price != null) lines.push(`Precio: ${item.currency_id ?? ''} ${item.price}`.trim());
  if (item.available_quantity != null) lines.push(`Stock disponible: ${item.available_quantity}`);
  if (item.condition) lines.push(`Condición: ${item.condition === 'new' ? 'nuevo' : item.condition === 'used' ? 'usado' : item.condition}`);
  if (item.shipping?.free_shipping != null) lines.push(`Envío gratis: ${item.shipping.free_shipping ? 'sí' : 'no'}`);
  if (item.shipping?.local_pick_up != null) lines.push(`Retiro en persona: ${item.shipping.local_pick_up ? 'sí' : 'no'}`);
  if (item.warranty) lines.push(`Garantía: ${item.warranty}`);
  if (item.status && item.status !== 'active') lines.push(`Estado de la publicación: ${item.status}`);

  const attrs = (item.attributes ?? [])
    .filter((a) => a.name && a.value_name)
    .slice(0, MAX_ATTRIBUTES)
    .map((a) => `- ${a.name}: ${a.value_name}`);
  if (attrs.length) lines.push(`Características:\n${attrs.join('\n')}`);

  const variations = (item.variations ?? [])
    .map((v) => {
      const combo = (v.attribute_combinations ?? [])
        .filter((c) => c.value_name)
        .map((c) => `${c.name}: ${c.value_name}`)
        .join(', ');
      return combo ? `- ${combo} (stock ${v.available_quantity ?? '?'})` : null;
    })
    .filter(Boolean);
  if (variations.length) lines.push(`Variantes:\n${variations.join('\n')}`);

  if (description) {
    const d = description.length > MAX_DESCRIPTION_CHARS
      ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`
      : description;
    lines.push(`Descripción:\n${d}`);
  }
  return lines.join('\n');
}

/**
 * Reglas + contexto para el agente. Va como `context.instructions` (antepuesto al
 * mensaje por el runtime), no en el system prompt: es por pregunta y no debe romper
 * el prompt caching del bloque estático del agente.
 */
function buildInstructions(input: {
  itemText: string;
  previous: { question: string; answer: string | null }[];
  hasSignature: boolean;
}): string {
  const reglas = [
    'Estás respondiendo una PREGUNTA PÚBLICA en una publicación de MercadoLibre. La respuesta la ven todos los compradores, no solo quien preguntó.',
    'Respondé en un solo mensaje, breve y directo (idealmente menos de 500 caracteres), en español neutro y amable.',
    'PROHIBIDO por MercadoLibre: links, teléfonos, emails, redes sociales, nombres de otros sitios, o invitar a comprar/hablar fuera de MercadoLibre. Una respuesta con eso es rechazada.',
    'No inventes datos: basate en la información de la publicación y en tu conocimiento. Si no tenés la información para responder con seguridad, usá la herramienta transferir_conversacion en lugar de responder.',
    input.hasSignature
      ? 'No agregues saludo de despedida ni firma: se agrega automáticamente al final.'
      : 'No agregues firma.',
  ];

  const bloques = [
    `[Reglas]\n${reglas.map((r) => `- ${r}`).join('\n')}`,
    `[Publicación]\n${input.itemText}`,
  ];

  if (input.previous.length) {
    const prev = input.previous
      .map((p) => `P: ${p.question}\nR: ${p.answer ?? '(sin responder)'}`)
      .join('\n\n');
    bloques.push(`[Preguntas anteriores de este comprador en esta publicación]\n${prev}`);
  }

  return bloques.join('\n\n');
}

/**
 * Sincroniza nuestra fila con una pregunta que en ML ya no está UNANSWERED.
 * Un ANSWERED que no publicamos nosotros lo respondió el vendedor desde ML.
 */
async function syncClosed(
  row: QuestionRow,
  question: MercadolibreQuestion,
  log: FastifyBaseLogger,
): Promise<ProcessResult> {
  if (question.status === 'ANSWERED') {
    if (row.answered_by) return { ok: true, skipped: 'already_answered' };
    // Turno del agente en vuelo: ML notifica el ANSWERED de NUESTRA respuesta apenas
    // la publicamos, y puede llegar antes de que el turno guarde answered_by='ai'.
    // Pasado el margen, un pending es un turno que murió (reinicio) y sí sincronizamos.
    if (
      row.status === 'pending' &&
      row.claimed_at &&
      Date.now() - Date.parse(row.claimed_at) < IN_FLIGHT_MARGIN_MS
    ) {
      return { ok: true, skipped: 'agent_in_flight' };
    }
    await patchQuestion(row.question_id, {
      status: 'answered',
      answered_by: 'seller',
      answer: question.answer?.text ?? null,
      answered_at: question.answer?.date_created ?? new Date().toISOString(),
      error: null,
    });
    log.info({ questionId: row.question_id }, 'mercadolibre: pregunta respondida por el vendedor desde ML');
    return { ok: true, status: 'answered' };
  }

  if (ML_CLOSED.has(question.status) && row.status !== 'answered') {
    await patchQuestion(row.question_id, { status: 'closed' });
    return { ok: true, status: 'closed' };
  }

  return { ok: true, skipped: `ml_status:${question.status}` };
}

/**
 * ¿Hay que responder en automático? Devuelve el agent_id o el motivo por el que no.
 * El workflow se valida contra el cliente: la config puede apuntar a uno que se
 * reasignó o borró.
 */
async function resolveAutoAnswer(
  clientId: number,
  mlUserId: number,
): Promise<
  | { on: true; agentId: number; workflowId: number; signature: string | null }
  | { on: false; reason: string }
> {
  const { data: inbox } = await supabase
    .from('unipile_inboxes')
    .select('suspended')
    .eq('client_id', clientId)
    .eq('account_id', String(mlUserId))
    .eq('source', 'mercadolibre')
    .maybeSingle();
  if (!inbox) return { on: false, reason: 'no_inbox' };
  if (inbox.suspended === true) return { on: false, reason: 'inbox_suspended' };

  const settings = await mercadolibreService.getSettings(clientId, mlUserId);
  if (!settings.questions_enabled) return { on: false, reason: 'questions_off' };
  if (!settings.questions_workflow_id) return { on: false, reason: 'no_agent' };

  const { data: wf } = await supabase
    .from('workflow')
    .select('id, agent_id, client_id')
    .eq('id', settings.questions_workflow_id)
    .maybeSingle();
  if (!wf?.agent_id || wf.client_id !== clientId) return { on: false, reason: 'agent_not_found' };

  return {
    on: true,
    agentId: wf.agent_id as number,
    workflowId: wf.id as number,
    signature: settings.questions_signature,
  };
}

// ---------- SERVICIO ----------

export const mercadolibreQuestionsService = {
  /**
   * Notificación del tópico `questions`. ML notifica al crearse la pregunta y en
   * cada cambio (incluida nuestra propia respuesta), así que el estado de ML y el
   * claim deciden si hay algo que hacer.
   */
  async processQuestion(
    notification: MercadolibreNotification,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult> {
    const questionIdRaw = questionIdFrom(notification.resource);
    if (!questionIdRaw) return { ok: true, skipped: 'no_question_id' };
    const questionId = Number(questionIdRaw);

    const mlUserId = notification.user_id;
    const conn = await mercadolibreService.getConnection(mlUserId);
    if (!conn) return { ok: true, skipped: 'unknown_seller' };
    const clientId = conn.client_id;

    let token: string;
    let question: MercadolibreQuestion;
    try {
      token = await mercadolibreService.getValidToken(mlUserId);
      question = await mercadolibreApiService.fetchQuestion(questionId, token);
    } catch (err) {
      log.error({ err, questionId, mlUserId }, 'mercadolibre: no se pudo traer la pregunta');
      return { ok: false, error: 'question_fetch_failed' };
    }

    const { data: existing } = await supabase
      .from('mercadolibre_questions')
      .select('question_id, client_id, ml_user_id, item_id, item_title, buyer_id, buyer_nickname, question, status, answered_by, claimed_at')
      .eq('question_id', questionId)
      .maybeSingle();
    let row = existing as QuestionRow | null;

    // Una pregunta que vemos por primera vez ya cerrada (o en moderación) no
    // aporta nada a la tab: la registramos solo si llega UNANSWERED o ANSWERED.
    if (!row && question.status !== 'UNANSWERED' && question.status !== 'ANSWERED') {
      return { ok: true, skipped: `ml_status:${question.status}` };
    }

    const auto = question.status === 'UNANSWERED'
      ? await resolveAutoAnswer(clientId, mlUserId)
      : ({ on: false, reason: 'not_unanswered' } as const);

    // Datos de la publicación: los necesita la fila (tab) y el agente.
    let item: MercadolibreItem | null = null;
    let description: string | null = null;
    if (!row || auto.on) {
      try {
        item = await mercadolibreApiService.fetchItem(question.item_id, token);
      } catch (err) {
        log.warn({ err, itemId: question.item_id }, 'mercadolibre: no se pudo traer la publicación');
      }
      if (auto.on) {
        try {
          description = await mercadolibreApiService.fetchItemDescription(question.item_id, token);
        } catch {
          /* muchas publicaciones no tienen descripción: 404 esperado */
        }
      }
    }

    const buyerId = buyerIdOf(question);

    if (!row) {
      let buyerNickname: string | null = null;
      if (buyerId != null) {
        try {
          const buyer = await mercadolibreApiService.fetchUser(buyerId, token);
          buyerNickname = buyer.nickname ?? null;
        } catch {
          /* best-effort: la tab muestra "Comprador" */
        }
      }

      const nuevo = {
        question_id: questionId,
        client_id: clientId,
        ml_user_id: mlUserId,
        item_id: question.item_id,
        item_title: item?.title ?? null,
        item_thumbnail: item?.secure_thumbnail ?? item?.thumbnail ?? null,
        item_permalink: item?.permalink ?? null,
        buyer_id: buyerId,
        buyer_nickname: buyerNickname,
        question: question.text,
        asked_at: question.date_created ?? new Date().toISOString(),
        status: (auto.on ? 'pending' : 'auto_off') as QuestionStatus,
      };
      const { error } = await supabase.from('mercadolibre_questions').insert(nuevo);
      // 23505 = otra notificación de la misma pregunta la insertó en paralelo; el
      // claim de más abajo decide quién responde.
      if (error && error.code !== '23505') {
        log.error({ err: error, questionId }, 'mercadolibre: insert de pregunta falló');
        return { ok: false, error: 'db_error' };
      }
      row = { ...nuevo, answered_by: null, claimed_at: null };
    }

    if (question.status !== 'UNANSWERED') return syncClosed(row, question, log);

    if (!auto.on) {
      // Solo marcamos auto_off si nadie la tomó todavía (no pisar needs_human/failed).
      if (row.status === 'pending' && !row.claimed_at) {
        await patchQuestion(questionId, { status: 'auto_off' });
      }
      return { ok: true, skipped: auto.reason, status: 'auto_off' };
    }

    // Claim atómico: ML reintenta y además notifica cambios; sin esto se
    // publicarían dos respuestas a la misma pregunta.
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from('mercadolibre_questions')
      .update({ claimed_at: nowIso, status: 'pending', workflow_id: auto.workflowId, updated_at: nowIso })
      .eq('question_id', questionId)
      .is('claimed_at', null)
      .select('question_id');
    if (claimError) {
      log.error({ err: claimError, questionId }, 'mercadolibre: claim de pregunta falló');
      return { ok: false, error: 'db_error' };
    }
    if (!claimed?.length) return { ok: true, skipped: 'already_claimed' };

    const { data: previousRows } = buyerId != null
      ? await supabase
          .from('mercadolibre_questions')
          .select('question, answer')
          .eq('client_id', clientId)
          .eq('item_id', question.item_id)
          .eq('buyer_id', buyerId)
          .neq('question_id', questionId)
          .order('asked_at', { ascending: false })
          .limit(MAX_PREVIOUS_QUESTIONS)
      : { data: [] };

    const buyerName = row.buyer_nickname ?? 'Comprador';
    const result = await invokeAgent(
      {
        agentId: auto.agentId,
        // Un thread por pregunta: compartirlo por comprador haría que el debounce del
        // runtime descarte una de dos preguntas seguidas, y esa quedaría sin respuesta
        // en ML. El historial relevante va en las instrucciones.
        chatId: `mlq:${mlUserId}:${questionId}`,
        message: question.text,
        senderName: buyerName,
        channel: QUESTIONS_CHANNEL,
        extraContext: {
          instructions: buildInstructions({
            itemText: describeItem(item, description),
            previous: ((previousRows ?? []) as { question: string; answer: string | null }[]).reverse(),
            hasSignature: Boolean(auto.signature?.trim()),
          }),
        },
      },
      log,
    );

    if (!result || result.skipped) {
      await patchQuestion(questionId, { status: 'failed', error: result ? 'agent_skipped' : 'agent_error' });
      return { ok: false, error: 'agent_error' };
    }

    const agentText = (result.response ?? '').trim();
    if (result.escalated || !agentText) {
      const reason = result.escalation_reason ?? (agentText ? null : 'El agente no devolvió respuesta');
      await patchQuestion(questionId, { status: 'needs_human', error: reason });

      const email = await getOwnerEmail(clientId, log);
      if (email) {
        const { subject, html } = mercadolibreEmails.questionNeedsHuman({
          itemTitle: row.item_title ?? item?.title ?? null,
          question: question.text,
          buyer: row.buyer_nickname,
          reason,
        });
        await emailService.send(email, subject, html, log);
      }
      return { ok: true, status: 'needs_human' };
    }

    const answer = buildAnswer(agentText, auto.signature, log);
    try {
      await mercadolibreApiService.postAnswer(questionId, token, answer);
    } catch (err) {
      return this.handleAnswerError(row, err, token, log);
    }

    await patchQuestion(questionId, {
      status: 'answered',
      answered_by: 'ai',
      answer,
      answered_at: new Date().toISOString(),
      error: null,
    });
    await recordAgentUse(
      {
        agentId: auto.agentId,
        clientId,
        channel: QUESTIONS_CHANNEL,
        question: question.text,
        response: answer,
        usage: result.usage,
      },
      log,
    );

    log.info({ questionId, itemId: question.item_id }, 'mercadolibre: pregunta respondida por el agente');
    return { ok: true, status: 'answered' };
  },

  /**
   * Un POST /answers fallido. El caso típico no es un error: el vendedor la
   * respondió desde ML mientras el agente pensaba. Releemos para distinguirlo.
   */
  async handleAnswerError(
    row: QuestionRow,
    err: unknown,
    token: string,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult> {
    try {
      const fresh = await mercadolibreApiService.fetchQuestion(row.question_id, token);
      if (fresh.status !== 'UNANSWERED') return syncClosed(row, fresh, log);
    } catch {
      /* si tampoco se puede releer, queda como failed */
    }

    const detail = err instanceof MercadolibreApiError ? `${err.status} ${err.cause ?? err.body.slice(0, 200)}` : String(err);
    log.error({ err, questionId: row.question_id }, 'mercadolibre: no se pudo publicar la respuesta');
    await patchQuestion(row.question_id, { status: 'failed', error: detail });
    return { ok: false, error: 'answer_failed' };
  },

  /**
   * Respuesta manual desde la tab del Inbox. Lleva la misma firma que las
   * automáticas: es la firma del canal, no del agente. No cuenta como uso.
   */
  async answerManually(
    input: { clientId: number; questionId: number; text: string },
    log: FastifyBaseLogger,
  ): Promise<{ ok: true; answer: string } | { ok: false; status: number; error: string }> {
    const { data } = await supabase
      .from('mercadolibre_questions')
      .select('question_id, client_id, ml_user_id, item_id, item_title, buyer_id, buyer_nickname, question, status, answered_by, claimed_at')
      .eq('question_id', input.questionId)
      .eq('client_id', input.clientId)
      .maybeSingle();
    const row = data as QuestionRow | null;
    if (!row) return { ok: false, status: 404, error: 'Pregunta no encontrada' };
    if (row.status === 'answered') return { ok: false, status: 409, error: 'La pregunta ya fue respondida' };
    if (row.status === 'closed') return { ok: false, status: 409, error: 'MercadoLibre ya cerró esta pregunta' };

    const conn = await mercadolibreService.getConnection(row.ml_user_id);
    if (!conn || conn.client_id !== input.clientId) {
      return { ok: false, status: 409, error: 'La cuenta de MercadoLibre no está conectada' };
    }

    if (!input.text.trim()) return { ok: false, status: 400, error: 'La respuesta está vacía' };

    const settings = await mercadolibreService.getSettings(input.clientId, row.ml_user_id);
    const firma = settings.questions_signature?.trim() ?? '';
    // Acá no truncamos en silencio como con el agente: el vendedor puede acortarla.
    if (input.text.trim().length + (firma ? firma.length + 2 : 0) > MAX_ANSWER_LENGTH) {
      return { ok: false, status: 400, error: `Con la firma, la respuesta supera los ${MAX_ANSWER_LENGTH} caracteres` };
    }
    const answer = buildAnswer(input.text, settings.questions_signature, log);

    let token: string;
    try {
      token = await mercadolibreService.getValidToken(row.ml_user_id);
    } catch (err) {
      log.error({ err, questionId: row.question_id }, 'mercadolibre: sin token para responder a mano');
      return { ok: false, status: 502, error: 'No se pudo conectar con MercadoLibre' };
    }

    try {
      await mercadolibreApiService.postAnswer(row.question_id, token, answer);
    } catch (err) {
      // A diferencia del camino automático, un fallo manual NO cambia el estado de la
      // fila: la pregunta sigue pendiente y el vendedor puede reintentar.
      log.error({ err, questionId: row.question_id }, 'mercadolibre: falló la respuesta manual');
      try {
        const fresh = await mercadolibreApiService.fetchQuestion(row.question_id, token);
        if (fresh.status !== 'UNANSWERED') {
          const synced = await syncClosed(row, fresh, log);
          const closed = synced.ok && synced.status === 'closed';
          return {
            ok: false,
            status: 409,
            error: closed ? 'MercadoLibre ya cerró esta pregunta' : 'La pregunta ya fue respondida desde MercadoLibre',
          };
        }
      } catch {
        /* sin poder releer, devolvemos el error genérico */
      }
      return { ok: false, status: 502, error: 'MercadoLibre rechazó la respuesta' };
    }

    await patchQuestion(row.question_id, {
      status: 'answered',
      answered_by: 'seller',
      answer,
      answered_at: new Date().toISOString(),
      error: null,
    });
    return { ok: true, answer };
  },
};
