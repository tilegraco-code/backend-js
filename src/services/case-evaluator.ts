// Evaluador de requisitos de un caso: qué datos y documentos faltan, qué no se lee y qué no
// coincide. Ver docs/documentos-y-casos-plan.md.
//
// Función PURA, sin I/O. Es la única implementación del sistema: el runtime y el dashboard
// reciben su resultado, no lo recalculan. Por eso vive aislada y con tests.
import {
  DATA_REF,
  type CaseRequirements,
  type Check,
  type Condition,
  type DataField,
  type DocumentRequirement,
} from '../schemas/case-definition';

/** Lo mínimo de un documento de `chat_documents` que necesita la evaluación. */
export type EvaluableDocument = {
  id: number;
  doc_type: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'skipped';
  legible: boolean | null;
  issues: string[] | null;
  extracted: Record<string, unknown> | null;
  duplicate_of: number | null;
  /** Un failed con reintentos pendientes todavía puede llegar a ready. */
  retrying?: boolean;
};

export type CaseEvaluation = {
  complete: boolean;
  missing_data: { key: string; label: string; hint?: string }[];
  invalid_data: { key: string; label: string; message: string }[];
  missing_documents: { type: string; label: string; hint?: string; have: number; need: number }[];
  illegible: { document_id: number; type: string; label: string; issues: string[] }[];
  failed_checks: { document_id: number; type: string; label: string; message: string }[];
  /** Checks que no se pueden evaluar porque falta el dato del caso contra el que se comparan. */
  pending_checks: { type: string; label: string; waiting_for: string }[];
  /** Documentos del chat que todavía se están procesando: pueden ser cualquier cosa. */
  processing: number;
};

type CheckOutcome = { result: 'pass' } | { result: 'fail'; message: string } | { result: 'pending'; waitingFor: string };

export function evaluateCase(
  requirements: CaseRequirements,
  data: Record<string, unknown>,
  documents: EvaluableDocument[],
): CaseEvaluation {
  const { definition, catalog } = requirements;
  const fields = new Map(definition.data.map((f) => [f.key, f]));

  const evaluation: CaseEvaluation = {
    complete: false,
    missing_data: [],
    invalid_data: [],
    missing_documents: [],
    illegible: [],
    failed_checks: [],
    pending_checks: [],
    processing: 0,
  };

  // 1. Datos ------------------------------------------------------------------------------------
  for (const field of definition.data) {
    const value = data[field.key];
    if (isEmpty(value)) {
      if (field.required) evaluation.missing_data.push({ key: field.key, label: field.label, hint: field.hint });
      continue;
    }
    const problem = validateValue(field, value);
    if (problem) evaluation.invalid_data.push({ key: field.key, label: field.label, message: problem });
  }

  // 2. Documentos -------------------------------------------------------------------------------
  const originals = documents.filter((d) => d.duplicate_of == null);
  evaluation.processing = originals.filter(
    (d) => d.status === 'pending' || d.status === 'processing' || (d.status === 'failed' && d.retrying),
  ).length;

  for (const req of definition.documents) {
    if (!req.when.every((c) => conditionHolds(c, data))) continue;

    const label = req.label ?? catalog[req.type]?.label ?? req.type;
    const ofType = originals.filter((d) => d.status === 'ready' && d.doc_type === req.type);
    const legible = ofType.filter((d) => d.legible !== false);

    for (const d of ofType) {
      if (d.legible === false) {
        evaluation.illegible.push({ document_id: d.id, type: req.type, label, issues: d.issues ?? [] });
      }
    }

    if (legible.length < req.min) {
      evaluation.missing_documents.push({
        type: req.type,
        label,
        hint: req.hint,
        have: legible.length,
        need: req.min,
      });
    }

    if (req.checks.length === 0 || legible.length === 0) continue;
    evaluateChecks(req, label, legible, data, fields, catalog, evaluation);
  }

  evaluation.complete =
    evaluation.missing_data.length === 0 &&
    evaluation.invalid_data.length === 0 &&
    evaluation.missing_documents.length === 0 &&
    evaluation.failed_checks.length === 0 &&
    evaluation.pending_checks.length === 0 &&
    evaluation.processing === 0;

  return evaluation;
}

/**
 * Alcanza con que UN documento del tipo pase todos los checks. Si ninguno pasa, se informan
 * las fallas de todos (el cliente puede haber mandado dos cédulas y solo una es la del auto).
 * Si alguno queda pendiente de un dato del caso, se informa eso en vez de una falla.
 */
function evaluateChecks(
  req: DocumentRequirement,
  label: string,
  docs: EvaluableDocument[],
  data: Record<string, unknown>,
  fields: Map<string, DataField>,
  catalog: CaseRequirements['catalog'],
  evaluation: CaseEvaluation,
): void {
  const failures: CaseEvaluation['failed_checks'] = [];
  const waiting = new Set<string>();

  for (const doc of docs) {
    const outcomes = req.checks.map((check) => runCheck(check, doc, data, fields, catalog[req.type], label));
    if (outcomes.every((o) => o.result === 'pass')) return;

    for (const o of outcomes) {
      if (o.result === 'fail') failures.push({ document_id: doc.id, type: req.type, label, message: o.message });
      if (o.result === 'pending') waiting.add(o.waitingFor);
    }
  }

  if (waiting.size > 0) {
    for (const w of waiting) evaluation.pending_checks.push({ type: req.type, label, waiting_for: w });
    return;
  }
  evaluation.failed_checks.push(...failures);
}

function runCheck(
  check: Check,
  doc: EvaluableDocument,
  data: Record<string, unknown>,
  fields: Map<string, DataField>,
  docType: CaseRequirements['catalog'][string] | undefined,
  docLabel: string,
): CheckOutcome {
  const fieldLabel = docType?.fields.find((f) => f.key === check.field)?.label ?? check.field;
  const fieldType = docType?.fields.find((f) => f.key === check.field)?.type;
  const actual = doc.extracted?.[check.field];

  // El dato del caso contra el que se compara todavía no está: no es una falla.
  let expected: unknown = check.value;
  let expectedLabel = formatValue(check.value);
  const ref = typeof check.value === 'string' ? DATA_REF.exec(check.value) : null;
  if (ref) {
    const key = ref[1];
    expected = data[key];
    const refField = fields.get(key);
    if (isEmpty(expected)) return { result: 'pending', waitingFor: refField?.label ?? key };
    expectedLabel = `${formatValue(expected)}, ${refField ? `el dato «${refField.label}» del caso` : key}`;
  }

  if (isEmpty(actual)) {
    return {
      result: 'fail',
      message: check.message ?? `No se puede leer «${fieldLabel}» en ${quoted(docLabel)}`,
    };
  }
  if (check.op === 'exists') return { result: 'pass' };

  const fail = (message: string): CheckOutcome => ({ result: 'fail', message: check.message ?? message });

  switch (check.op) {
    case 'equals':
      return sameValue(actual, expected, fieldType)
        ? { result: 'pass' }
        : fail(`«${fieldLabel}» en ${quoted(docLabel)} es ${formatValue(actual)} y no coincide con ${expectedLabel}`);
    case 'not_equals':
      return !sameValue(actual, expected, fieldType)
        ? { result: 'pass' }
        : fail(`«${fieldLabel}» en ${quoted(docLabel)} no puede ser ${expectedLabel}`);
    case 'in': {
      const list = Array.isArray(expected) ? expected : [];
      return list.some((v) => sameValue(actual, v, fieldType))
        ? { result: 'pass' }
        : fail(`«${fieldLabel}» en ${quoted(docLabel)} es ${formatValue(actual)}, que no es un valor aceptado`);
    }
    case 'after':
    case 'before': {
      const a = toDate(actual);
      const b = toDate(expected);
      if (a == null) return fail(`No se puede leer la fecha «${fieldLabel}» en ${quoted(docLabel)}`);
      if (b == null) return fail(`La fecha contra la que se compara «${fieldLabel}» no es válida`);
      const ok = check.op === 'after' ? a > b : a < b;
      const word = check.op === 'after' ? 'posterior' : 'anterior';
      return ok
        ? { result: 'pass' }
        : fail(`«${fieldLabel}» en ${quoted(docLabel)} es ${formatDate(a)} y tiene que ser ${word} a ${formatDate(b)}`);
    }
  }
}

function conditionHolds(condition: Condition, data: Record<string, unknown>): boolean {
  const key = DATA_REF.exec(condition.field)?.[1];
  const value = key ? data[key] : undefined;
  switch (condition.op) {
    case 'exists':
      return !isEmpty(value);
    case 'equals':
      return !isEmpty(value) && sameValue(value, condition.value);
    case 'not_equals':
      // Sin el dato no se sabe: el requisito no aplica todavía (el dato ya figura como faltante).
      return !isEmpty(value) && !sameValue(value, condition.value);
    case 'in':
      return !isEmpty(value) && Array.isArray(condition.value) && condition.value.some((v) => sameValue(value, v));
  }
}

function validateValue(field: DataField, value: unknown): string | null {
  switch (field.type) {
    case 'date':
      return toDate(value) == null ? 'No es una fecha válida' : null;
    case 'number':
      return toNumber(value) == null ? 'No es un número' : null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Tiene que ser sí o no';
    case 'enum':
      return field.options?.some((o) => sameValue(value, o))
        ? null
        : `Tiene que ser uno de: ${field.options?.join(', ')}`;
    case 'string':
      return null;
  }
}

/**
 * Igualdad tolerante a cómo se escribe a mano o se lee de una foto: "AB 123 CD", "ab-123-cd" y
 * "AB123CD" son la misma patente; "12.345.678" y "12345678" el mismo documento.
 */
function sameValue(a: unknown, b: unknown, type?: string): boolean {
  if (type === 'date') {
    const da = toDate(a);
    const db = toDate(b);
    return da != null && db != null && da.getTime() === db.getTime();
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  if (type === 'number' && na != null && nb != null) return na === nb;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return normalize(a) === normalize(b);
}

export function normalize(value: unknown): string {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[\s.\-_/]/g, '');
}

function isEmpty(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

/** Acepta 1234.5, 1.234,5 y 1.234 (punto de miles, como se escribe acá). */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  let s = value.trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Acepta ISO (2026-09-10) y el formato local (10/09/2026). Devuelve la fecha a medianoche UTC. */
function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (local) [y, m, d] = [Number(local[3]), Number(local[2]), Number(local[1])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function formatDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  const date = toDate(value);
  return date ? formatDate(date) : String(value);
}

function quoted(label: string): string {
  return `«${label}»`;
}
