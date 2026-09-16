// Casos por chat: abrir, completar datos, cambiar de tipo, cancelar y reevaluar.
// Ver docs/documentos-y-casos-plan.md.
//
// Lo llaman las tools del agente (vía cases.route) y el worker de documentos cuando uno
// termina de procesarse. Cada operación que cambia algo devuelve la evaluación recalculada:
// el modelo contesta con el estado real, no con uno que dedujo.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import {
  caseDefinitionSchema,
  caseRequirementsSchema,
  documentTypeSchema,
  type CaseDefinition,
  type CaseRequirements,
  type DataField,
  type DocumentType,
} from '../schemas/case-definition';
import { evaluateCase, normalize, type CaseEvaluation, type EvaluableDocument } from './case-evaluator';
import { MAX_ATTEMPTS } from './chat-documents.constants';

export type CaseStatus = 'open' | 'complete' | 'closed' | 'cancelled';

type CaseRow = {
  id: number;
  client_id: number;
  agent_id: number;
  chat_id: string;
  number: string;
  case_type: string;
  status: CaseStatus;
  data: Record<string, unknown>;
  requirements: unknown;
  evaluation: CaseEvaluation | null;
  opened_at: string;
  completed_at: string | null;
};

/** Lo que ven el agente y el dashboard. */
export type CaseView = {
  id: number;
  number: string;
  case_type: string;
  label: string;
  status: CaseStatus;
  data: { key: string; label: string; value: unknown }[];
  evaluation: CaseEvaluation;
  opened_at: string;
  completed_at: string | null;
  /** Datos que el agente intentó guardar y no existen en este tipo de caso. */
  ignored_keys?: string[];
};

export type CaseErrorCode =
  | 'cases_disabled'
  | 'case_already_active'
  | 'invalid_case_type'
  | 'case_not_found'
  | 'case_not_active'
  | 'invalid_config';

/** Error de negocio con un mensaje apto para que el agente se lo explique al cliente. */
export class CaseError extends Error {
  constructor(
    public code: CaseErrorCode,
    message: string,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CaseError';
  }
}

const ACTIVE: CaseStatus[] = ['open', 'complete'];

export const casesService = {
  async open(
    input: { clientId: number; agentId: number; chatId: string; caseType: string; data?: Record<string, unknown> },
    log: FastifyBaseLogger,
  ): Promise<CaseView> {
    const { clientId, agentId, chatId } = input;

    const { data: settings } = await supabase
      .from('agent_case_settings')
      .select('enabled, number_prefix')
      .eq('agent_id', agentId)
      .maybeSingle();
    if (!settings?.enabled) {
      throw new CaseError('cases_disabled', 'Este agente no tiene casos habilitados.');
    }

    const existing = await this.getActiveRow(clientId, chatId);
    if (existing) {
      throw new CaseError(
        'case_already_active',
        `Ya hay un caso activo en esta conversación: ${existing.number}.`,
        { number: existing.number, id: existing.id },
      );
    }

    const requirements = await buildRequirements(agentId, input.caseType);
    const { data, ignored } = sanitizeData(requirements.definition, {}, input.data ?? {});

    const { data: seq, error: seqError } = await supabase.rpc('next_case_number', { p_client_id: clientId });
    if (seqError || seq == null) throw seqError ?? new Error('next_case_number no devolvió número');
    const number = formatNumber(settings.number_prefix as string, Number(seq));

    const { data: inserted, error } = await supabase
      .from('chat_cases')
      .insert({
        client_id: clientId,
        agent_id: agentId,
        chat_id: chatId,
        number,
        case_type: requirements.case_type,
        data,
        requirements,
      })
      .select('*')
      .single();

    if (error) {
      // Dos aperturas simultáneas en el mismo chat: el índice único deja pasar una sola.
      if (error.code === '23505') {
        const winner = await this.getActiveRow(clientId, chatId);
        throw new CaseError('case_already_active', `Ya hay un caso activo en esta conversación: ${winner?.number ?? ''}.`, {
          number: winner?.number,
          id: winner?.id,
        });
      }
      throw error;
    }

    const row = inserted as CaseRow;
    await attachChatDocuments(row, log);
    log.info({ caseId: row.id, number, chatId, caseType: row.case_type }, 'cases: caso abierto');

    const view = await this.reevaluate(row.id, log);
    return ignored.length ? { ...view, ignored_keys: ignored } : view;
  },

  /** Agrega o corrige datos. Un valor vacío o null borra el dato. */
  async updateData(
    input: { clientId: number; caseId: number; data: Record<string, unknown> },
    log: FastifyBaseLogger,
  ): Promise<CaseView> {
    const row = await this.getActiveById(input.clientId, input.caseId);
    const requirements = parseRequirements(row);
    const { data, ignored } = sanitizeData(requirements.definition, row.data, input.data);

    const { error } = await supabase
      .from('chat_cases')
      .update({ data, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) throw error;

    const view = await this.reevaluate(row.id, log);
    return ignored.length ? { ...view, ignored_keys: ignored } : view;
  },

  /**
   * Cambia el tipo de caso (el cliente aclara que no fue un choque sino un robo). Toma la
   * definición vigente del nuevo tipo y conserva los datos que existan en él. Los documentos
   * ya recibidos siguen asociados y cuentan si coinciden.
   */
  async changeType(
    input: { clientId: number; caseId: number; caseType: string },
    log: FastifyBaseLogger,
  ): Promise<CaseView> {
    const row = await this.getActiveById(input.clientId, input.caseId);
    const requirements = await buildRequirements(row.agent_id, input.caseType);
    const { data } = sanitizeData(requirements.definition, {}, row.data);

    const { error } = await supabase
      .from('chat_cases')
      .update({ case_type: requirements.case_type, requirements, data, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) throw error;

    // Los documentos se clasificaron contra el catálogo del tipo anterior: se reclasifican.
    await requeueForClassification(row.id, log);
    log.info({ caseId: row.id, from: row.case_type, to: requirements.case_type }, 'cases: cambio de tipo');
    return this.reevaluate(row.id, log);
  },

  async cancel(
    input: { clientId: number; caseId: number; reason?: string },
    log: FastifyBaseLogger,
  ): Promise<CaseView> {
    const row = await this.getActiveById(input.clientId, input.caseId);
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('chat_cases')
      .update({ status: 'cancelled', closed_at: now, updated_at: now, sync_status: 'pending', sync_next_attempt_at: now })
      .eq('id', row.id);
    if (error) throw error;
    log.info({ caseId: row.id, reason: input.reason }, 'cases: caso cancelado');
    return toView({ ...row, status: 'cancelled' }, row.evaluation ?? evaluateRow(row, []));
  },

  /**
   * Recalcula la evaluación con los documentos actuales y ajusta el estado:
   * open → complete cuando está todo; complete → open si algo dejó de cumplirse (llegó una
   * cédula de otro auto, se corrigió la patente). closed y cancelled no se tocan.
   *
   * NOTE: dos reevaluaciones concurrentes pueden escribir en cualquier orden. Cada una lee el
   * estado completo de la DB, así que la próxima que corra deja todo consistente.
   */
  async reevaluate(caseId: number, log: FastifyBaseLogger): Promise<CaseView> {
    const { data: found, error } = await supabase.from('chat_cases').select('*').eq('id', caseId).maybeSingle();
    if (error) throw error;
    if (!found) throw new CaseError('case_not_found', 'No encontré el caso.');
    const row = found as CaseRow;

    const { data: docs, error: docsError } = await supabase
      .from('chat_documents')
      .select('id, doc_type, status, legible, issues, extracted, duplicate_of, attempts')
      .eq('case_id', caseId);
    if (docsError) throw docsError;

    const evaluation = evaluateRow(
      row,
      (docs ?? []).map((d) => ({
        ...(d as EvaluableDocument),
        retrying: d.status === 'failed' && (d.attempts as number) < MAX_ATTEMPTS,
      })),
    );

    let status = row.status;
    let completed_at = row.completed_at;
    if (row.status === 'open' && evaluation.complete) {
      status = 'complete';
      completed_at = new Date().toISOString();
    } else if (row.status === 'complete' && !evaluation.complete) {
      status = 'open';
      completed_at = null;
    }

    const { error: updateError } = await supabase
      .from('chat_cases')
      // Un cambio siempre vuelve a habilitar el sync, aunque se hayan agotado los intentos.
      .update({
        evaluation,
        status,
        completed_at,
        sync_status: 'pending',
        sync_next_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId);
    if (updateError) throw updateError;

    if (status !== row.status) {
      log.info({ caseId, from: row.status, to: status }, 'cases: cambio de estado');
    }
    return toView({ ...row, status, completed_at }, evaluation);
  },

  /** Caso activo (open o complete) de un chat, o null. */
  async getActive(clientId: number, chatId: string): Promise<CaseView | null> {
    const row = await this.getActiveRow(clientId, chatId);
    if (!row) return null;
    return toView(row, row.evaluation ?? evaluateRow(row, []));
  },

  async getActiveRow(clientId: number, chatId: string): Promise<CaseRow | null> {
    const { data, error } = await supabase
      .from('chat_cases')
      .select('*')
      .eq('client_id', clientId)
      .eq('chat_id', chatId)
      .in('status', ACTIVE)
      .maybeSingle();
    if (error) throw error;
    return (data as CaseRow | null) ?? null;
  },

  async getActiveById(clientId: number, caseId: number): Promise<CaseRow> {
    const { data, error } = await supabase
      .from('chat_cases')
      .select('*')
      .eq('id', caseId)
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CaseError('case_not_found', 'No encontré el caso.');
    const row = data as CaseRow;
    if (!ACTIVE.includes(row.status)) {
      throw new CaseError('case_not_active', `El caso ${row.number} ya está ${statusLabel(row.status)}.`, {
        number: row.number,
        status: row.status,
      });
    }
    return row;
  },

  /** Tipos de caso activos de un agente, para el runtime-config. */
  async listActiveTypes(agentId: number): Promise<{ key: string; label: string; description: string }[]> {
    const { data: settings } = await supabase
      .from('agent_case_settings')
      .select('enabled')
      .eq('agent_id', agentId)
      .maybeSingle();
    if (!settings?.enabled) return [];

    const { data, error } = await supabase
      .from('agent_case_types')
      .select('key, label, description')
      .eq('agent_id', agentId)
      .eq('active', true)
      .order('position', { ascending: true });
    if (error) throw error;
    return (data ?? []) as { key: string; label: string; description: string }[];
  },
};

// --- Helpers --------------------------------------------------------------------------------

async function buildRequirements(agentId: number, caseType: string): Promise<CaseRequirements> {
  const { data: types, error } = await supabase
    .from('agent_case_types')
    .select('key, label, definition')
    .eq('agent_id', agentId)
    .eq('active', true)
    .order('position', { ascending: true });
  if (error) throw error;

  const type = (types ?? []).find((t) => t.key === caseType);
  if (!type) {
    const valid = (types ?? []).map((t) => t.key as string);
    throw new CaseError(
      'invalid_case_type',
      `No existe el tipo de caso "${caseType}". Tipos válidos: ${valid.join(', ') || 'ninguno'}.`,
      { valid },
    );
  }

  const parsed = caseDefinitionSchema.safeParse(type.definition);
  if (!parsed.success) {
    throw new CaseError('invalid_config', `La configuración del tipo de caso "${caseType}" es inválida.`, {
      issues: parsed.error.issues,
    });
  }

  const docTypes = [...new Set(parsed.data.documents.map((d) => d.type))];
  const catalog: Record<string, DocumentType> = {};
  if (docTypes.length > 0) {
    const { data: entries, error: catalogError } = await supabase
      .from('agent_document_types')
      .select('key, label, description, fields')
      .eq('agent_id', agentId)
      .in('key', docTypes);
    if (catalogError) throw catalogError;
    for (const entry of entries ?? []) {
      const doc = documentTypeSchema.safeParse(entry);
      if (doc.success) catalog[doc.data.key] = doc.data;
    }
  }

  return caseRequirementsSchema.parse({
    case_type: type.key,
    label: type.label,
    definition: parsed.data,
    catalog,
  });
}

function parseRequirements(row: CaseRow): CaseRequirements {
  const parsed = caseRequirementsSchema.safeParse(row.requirements);
  if (!parsed.success) {
    throw new CaseError('invalid_config', `Los requisitos guardados del caso ${row.number} son inválidos.`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function evaluateRow(row: CaseRow, docs: EvaluableDocument[]): CaseEvaluation {
  return evaluateCase(parseRequirements(row), row.data ?? {}, docs);
}

/**
 * Asocia al caso los documentos que el cliente mandó antes de abrirlo y los pone en cola de
 * revisión contra el catálogo del caso.
 */
async function attachChatDocuments(row: CaseRow, log: FastifyBaseLogger): Promise<void> {
  const { error } = await supabase
    .from('chat_documents')
    .update({ case_id: row.id, sync_status: 'pending', updated_at: new Date().toISOString() })
    .eq('client_id', row.client_id)
    .eq('chat_id', row.chat_id)
    .is('case_id', null)
    .is('duplicate_of', null);
  if (error) {
    log.error({ err: error, caseId: row.id }, 'cases: no se pudieron asociar los documentos previos');
    return;
  }
  await requeueForClassification(row.id, log);
}

/**
 * Pone en cola la revisión de los documentos del caso: los que llegaron antes de abrirlo (se
 * registraron sin revisar) y los ya revisados contra el catálogo de otro tipo de caso. Los
 * duplicados, audios y videos no se revisan.
 */
async function requeueForClassification(caseId: number, log: FastifyBaseLogger): Promise<void> {
  const { error } = await supabase
    .from('chat_documents')
    .update({
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      doc_type: null,
      confidence: null,
      legible: null,
      issues: null,
      summary: null,
      updated_at: new Date().toISOString(),
    })
    .eq('case_id', caseId)
    .is('duplicate_of', null)
    .in('kind', ['image', 'document'])
    .in('status', ['ready', 'failed', 'skipped']);
  if (error) log.error({ err: error, caseId }, 'cases: no se pudieron reencolar los documentos');
}

/**
 * Deja solo los datos que existen en la definición y los normaliza para que el evaluador y el
 * Sheet los vean siempre igual: fechas en ISO, enums con la opción exacta, números como número.
 * Lo que no se puede normalizar se guarda tal cual y el evaluador lo marca como inválido.
 */
export function sanitizeData(
  definition: CaseDefinition,
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { data: Record<string, unknown>; ignored: string[] } {
  const fields = new Map(definition.data.map((f) => [f.key, f]));
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (fields.has(key)) data[key] = value;
  }

  const ignored: string[] = [];
  for (const [key, value] of Object.entries(incoming ?? {})) {
    const field = fields.get(key);
    if (!field) {
      ignored.push(key);
      continue;
    }
    if (value == null || (typeof value === 'string' && value.trim() === '')) {
      delete data[key];
      continue;
    }
    data[key] = coerce(field, value);
  }
  return { data, ignored };
}

function coerce(field: DataField, value: unknown): unknown {
  const text = typeof value === 'string' ? value.trim() : value;
  switch (field.type) {
    case 'date': {
      if (typeof text !== 'string') return text;
      const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      if (local) return `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
      return text;
    }
    case 'enum':
      return field.options?.find((o) => normalize(o) === normalize(text)) ?? text;
    case 'boolean': {
      if (typeof text === 'boolean') return text;
      const n = normalize(text);
      if (['SI', 'TRUE', 'S'].includes(n)) return true;
      if (['NO', 'FALSE', 'N'].includes(n)) return false;
      return text;
    }
    case 'number': {
      if (typeof text === 'number') return text;
      const n = Number(String(text).replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : text;
    }
    case 'string':
      return typeof text === 'string' ? text : String(text);
  }
}

function formatNumber(prefix: string, seq: number): string {
  return `${prefix}-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
}

function toView(row: CaseRow, evaluation: CaseEvaluation): CaseView {
  const requirements = caseRequirementsSchema.safeParse(row.requirements);
  const fields = requirements.success ? requirements.data.definition.data : [];
  return {
    id: row.id,
    number: row.number,
    case_type: row.case_type,
    label: requirements.success ? requirements.data.label : row.case_type,
    status: row.status,
    data: fields
      .filter((f) => row.data?.[f.key] != null)
      .map((f) => ({ key: f.key, label: f.label, value: row.data[f.key] })),
    evaluation,
    opened_at: row.opened_at,
    completed_at: row.completed_at,
  };
}

function statusLabel(status: CaseStatus): string {
  return { open: 'abierto', complete: 'completo', closed: 'cerrado', cancelled: 'cancelado' }[status];
}
