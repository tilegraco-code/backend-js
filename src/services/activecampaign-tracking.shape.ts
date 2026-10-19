// Seguimiento de envíos guardado en ActiveCampaign: lógica pura (sin red) para poder
// testearla. Ver activecampaign-tracking.service.ts.
//
// Caso real (Café Delirante): cada pedido de la tienda es un deal y el envío vive en
// campos personalizados del deal ("Tracking URL", "Tracking Correo Argentino", "Estado
// Envío Andreani", "Último Evento Andreani"…), que también usan los mails de despacho.
// El deal no guarda el número de pedido, así que se vincula por email + fecha.

export type AcDeal = { id: string; cdate?: string | null; title?: string | null };
export type AcFieldMeta = { id: string; fieldLabel?: string | null; personalization?: string | null };
export type AcFieldValue = { customFieldId: string | number; fieldValue?: unknown };

export type AcTracking = {
  carrier: string | null;
  number: string | null;
  link: string | null;
  shipped: null;
  status: string | null;
  last_event: string | null;
  last_update: string | null;
  estimated_delivery: string | null;
};

/** Ventana alrededor de la fecha del pedido en la que buscamos su deal. */
const BEFORE_MS = 12 * 3_600_000;
const AFTER_MS = 72 * 3_600_000;

/**
 * El deal de un pedido: el creado más cerca de la fecha del pedido, dentro de la ventana
 * (la automatización lo crea al llegar el pedido; puede tardar o el reloj diferir un poco).
 */
export function pickDealForOrder(deals: AcDeal[], orderDate: string | null | undefined): AcDeal | null {
  const t = orderDate ? Date.parse(orderDate) : NaN;
  if (!Number.isFinite(t)) return null;
  let best: { deal: AcDeal; diff: number } | null = null;
  for (const d of deals) {
    const c = d.cdate ? Date.parse(d.cdate) : NaN;
    if (!Number.isFinite(c)) continue;
    const delta = c - t;
    if (delta < -BEFORE_MS || delta > AFTER_MS) continue;
    const diff = Math.abs(delta);
    if (!best || diff < best.diff) best = { deal: d, diff };
  }
  return best?.deal ?? null;
}

type Role = 'link' | 'number' | 'status' | 'last_event' | 'last_update' | 'estimated_delivery';

/** Qué representa un campo, por su nombre o su tag de personalización. */
export function fieldRole(meta: AcFieldMeta): Role | null {
  const label = `${meta.fieldLabel ?? ''} ${meta.personalization ?? ''}`.toLowerCase();
  const tracking = /track|seguim|rastreo/.test(label);
  if (tracking && /url|link|enlace/.test(label)) return 'link';
  if (/fecha estimada|entrega estimada|estimated/.test(label)) return 'estimated_delivery';
  if (/fecha/.test(label) && /(ultimo|último|ltimo).*estado|actualiz/.test(label)) return 'last_update';
  if (/evento/.test(label)) return 'last_event';
  if (/estado/.test(label) && /env|andreani|correo|oca|moova/.test(label)) return 'status';
  if (tracking) return 'number';
  return null;
}

function carrierOf(link: string | null, labels: string): string | null {
  const s = `${link ?? ''} ${labels}`.toLowerCase();
  if (s.includes('andreani')) return 'Andreani';
  if (s.includes('correoargentino') || s.includes('correo argentino')) return 'Correo Argentino';
  if (/\boca\b/.test(s)) return 'OCA';
  if (s.includes('moova')) return 'Moova';
  return null;
}

/** Traduce los campos del deal a seguimiento. null si no hay ni link ni número. */
export function mapDealTracking(values: AcFieldValue[], metas: AcFieldMeta[]): AcTracking | null {
  const byId = new Map(metas.map((m) => [String(m.id), m]));
  const out: Partial<Record<Role, string>> = {};
  const usedLabels: string[] = [];
  for (const v of values) {
    const meta = byId.get(String(v.customFieldId));
    if (!meta) continue;
    const role = fieldRole(meta);
    const value = typeof v.fieldValue === 'string' || typeof v.fieldValue === 'number' ? String(v.fieldValue).trim() : '';
    if (!role || !value || out[role]) continue;
    out[role] = value;
    usedLabels.push(meta.fieldLabel ?? '');
  }
  const link = out.link && /^https?:\/\//i.test(out.link) ? out.link : null;
  const number = out.number ?? null;
  if (!link && !number) return null;
  return {
    carrier: carrierOf(link, usedLabels.join(' ')),
    number,
    link,
    shipped: null,
    status: out.status ?? null,
    last_event: out.last_event ?? null,
    last_update: out.last_update ? out.last_update.slice(0, 10) : null,
    estimated_delivery: out.estimated_delivery ? out.estimated_delivery.slice(0, 10) : null,
  };
}
