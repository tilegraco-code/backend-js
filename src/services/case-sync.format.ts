// Partes puras del sync de casos: cómo se llama cada archivo y carpeta, qué columnas tiene el
// Sheet y qué va en cada celda. Sin I/O, para poder testearlas. Ver case-sync.service.ts.
import type { CaseEvaluation } from './case-evaluator';
import type { CaseRequirements } from '../schemas/case-definition';

export type SheetColumn = { header: string; source: string };

/** Fuentes fijas que acepta `agent_case_settings.sheet_columns`, además de `data.<clave>`. */
export const SHEET_SOURCES = [
  'number',
  'case_type',
  'status',
  'opened_at',
  'completed_at',
  'missing',
  'drive_folder_url',
] as const;

const STATUS_LABEL: Record<string, string> = {
  open: 'Abierto',
  complete: 'Completo',
  closed: 'Cerrado',
  cancelled: 'Cancelado',
};

export type SyncableCase = {
  number: string;
  status: string;
  data: Record<string, unknown>;
  evaluation: CaseEvaluation | null;
  opened_at: string;
  completed_at: string | null;
  external_ref: { drive_folder_url?: string } | null;
};

/** Columnas por default: las fijas y después un dato por columna, en el orden de la definición. */
export function defaultColumns(requirements: CaseRequirements): SheetColumn[] {
  return [
    { header: 'Número', source: 'number' },
    { header: 'Tipo', source: 'case_type' },
    { header: 'Estado', source: 'status' },
    { header: 'Abierto', source: 'opened_at' },
    { header: 'Completado', source: 'completed_at' },
    { header: 'Falta', source: 'missing' },
    { header: 'Carpeta', source: 'drive_folder_url' },
    ...requirements.definition.data.map((f) => ({ header: f.label, source: `data.${f.key}` })),
  ];
}

/**
 * Valor de una celda. Siempre texto: se escribe con RAW, así que un dato que empiece con "="
 * queda como texto y no se convierte en fórmula.
 */
export function cellValue(source: string, row: SyncableCase, requirements: CaseRequirements): string {
  if (source.startsWith('data.')) {
    const key = source.slice(5);
    const field = requirements.definition.data.find((f) => f.key === key);
    const value = row.data?.[key];
    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (field?.type === 'date' && typeof value === 'string') return formatDate(value);
    return String(value);
  }
  switch (source) {
    case 'number':
      return row.number;
    case 'case_type':
      return requirements.label;
    case 'status':
      return STATUS_LABEL[row.status] ?? row.status;
    case 'opened_at':
      return formatDateTime(row.opened_at);
    case 'completed_at':
      return row.completed_at ? formatDateTime(row.completed_at) : '';
    case 'missing':
      return missingText(row);
    case 'drive_folder_url':
      return row.external_ref?.drive_folder_url ?? '';
    default:
      return '';
  }
}

/** "Falta" en una línea, para quien mira el Sheet. */
export function missingText(row: SyncableCase): string {
  if (row.status === 'cancelled' || row.status === 'closed') return '';
  const ev = row.evaluation;
  if (!ev) return '';
  if (ev.complete) return '—';
  const parts = [
    ...ev.missing_data.map((d) => d.label),
    ...ev.invalid_data.map((d) => `${d.label} (inválido)`),
    ...ev.missing_documents.map((d) => (d.need > 1 ? `${d.label} (${d.have}/${d.need})` : d.label)),
    ...ev.illegible.map((d) => `${d.label} (ilegible)`),
    ...ev.failed_checks.map((d) => `${d.label} (no coincide)`),
  ];
  const unique = [...new Set(parts)];
  if (ev.processing > 0) unique.push(`${ev.processing} en revisión`);
  return unique.join(', ');
}

/**
 * Ubica las columnas en la fila de encabezados real del Sheet. Las personas mueven columnas: se
 * busca por nombre, no por posición. Las que no están se agregan al final.
 */
export function mapColumns(
  existingHeaders: string[],
  columns: SheetColumn[],
): { index: Map<string, number>; newHeaders: { index: number; header: string }[] } {
  const norm = (h: string) => h.trim().toLowerCase();
  const index = new Map<string, number>();
  const newHeaders: { index: number; header: string }[] = [];
  let next = existingHeaders.length;

  for (const col of columns) {
    const found = existingHeaders.findIndex((h) => norm(String(h ?? '')) === norm(col.header));
    if (found >= 0) {
      index.set(col.source, found);
    } else {
      index.set(col.source, next);
      newHeaders.push({ index: next, header: col.header });
      next += 1;
    }
  }
  return { index, newHeaders };
}

/**
 * Fila (1-based, contando el encabezado) donde va el caso: la que ya tiene su número o la
 * primera libre después de la última con datos.
 */
export function findRow(dataRows: unknown[][], numberColumn: number, number: string): number {
  const found = dataRows.findIndex((r) => String(r?.[numberColumn] ?? '').trim() === number);
  return found >= 0 ? found + 2 : dataRows.length + 2;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Nombre de pestaña citado para A1 ('Hoja 1'!A1). */
export function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export function folderName(number: string, label: string): string {
  return sanitizeName(`${number} - ${label}`);
}

/** "licencia_2.jpg". El número es el orden dentro del tipo, así el liquidador ve frente y dorso. */
export function fileName(docType: string | null, kind: string, n: number, storagePath: string): string {
  const ext = storagePath.includes('.') ? storagePath.split('.').pop() : null;
  const base = sanitizeName(docType ?? (kind === 'image' ? 'imagen' : kind === 'document' ? 'documento' : kind));
  return ext ? `${base}_${n}.${ext}` : `${base}_${n}`;
}

function sanitizeName(name: string): string {
  return name.replace(/[<>:'"/\\|?*]/g, '').trim();
}

const AR = 'America/Argentina/Buenos_Aires';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: AR,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}
