// Búsqueda de texto tolerante para catálogos (TiendaNube, WooCommerce): sin acentos,
// tolerante a plurales, y todas las palabras de la query tienen que aparecer.

// Normaliza para buscar: minúsculas + sin acentos.
export function normalizeText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Variantes de un token para tolerar plurales (es/s) en ambos sentidos.
function tokenVariants(tok: string): string[] {
  const v = [tok];
  if (tok.endsWith('es') && tok.length > 4) v.push(tok.slice(0, -2));
  if (tok.endsWith('s') && tok.length > 3) v.push(tok.slice(0, -1));
  return v;
}

// Filtro por tokens: sin acentos, tolerante a plural. Matchea si TODAS las
// palabras de la query aparecen (alguna de sus variantes) en el texto del item.
export function filterByQuery<T>(items: T[], query?: string): T[] {
  if (!query || !query.trim()) return items;
  const tokens = normalizeText(query)
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return items;

  return items.filter((it) => {
    const text = normalizeText(JSON.stringify(it));
    return tokens.every((tok) => tokenVariants(tok).some((v) => text.includes(v)));
  });
}
