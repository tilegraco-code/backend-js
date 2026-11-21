// Helpers puros de Google Sheets (sin dependencias: se testean sin env).

/** Id de una planilla a partir del link (…/spreadsheets/d/<id>/…) o del id pelado. */
export function extractGoogleSheetId(value: string): string | null {
  const v = value.trim();
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(v) ? v : null;
}

// La respuesta de Composio puede venir envuelta (data / response_data): se busca adentro.
function unwrap(data: unknown): Record<string, unknown> {
  let cur = data as Record<string, unknown> | null;
  for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
    if ('sheets' in cur || 'properties' in cur) return cur;
    cur = (cur.response_data ?? cur.data ?? cur.spreadsheet) as Record<string, unknown> | null;
  }
  return (cur ?? {}) as Record<string, unknown>;
}

export function findSheetTitle(data: unknown): string | null {
  const props = unwrap(data).properties as { title?: unknown } | undefined;
  return typeof props?.title === 'string' ? props.title : null;
}

export function findSheetTabs(data: unknown): string[] {
  const sheets = unwrap(data).sheets;
  if (!Array.isArray(sheets)) return [];
  return sheets
    .map((s) => (s as { properties?: { title?: unknown } })?.properties?.title)
    .filter((t): t is string => typeof t === 'string');
}
