import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0';

/** Normaliza (trim + lowercase) y hashea a SHA-256 como exige Meta. Vacío → undefined. */
function hash(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

/** Teléfono: solo dígitos (con código de país), luego SHA-256. */
function hashPhone(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return undefined;
  return createHash('sha256').update(digits).digest('hex');
}

export interface CapiUserData {
  email?: string;
  phone?: string;
  /** Nuestro ID interno (client_id de Supabase). Se hashea. Mejora el matching. */
  externalId?: string | number;
  clientIpAddress?: string;
  clientUserAgent?: string;
  fbp?: string; // cookie _fbp (se manda SIN hashear)
  fbc?: string; // cookie _fbc (se manda SIN hashear)
}

export interface CapiEvent {
  eventName: string; // 'Subscribe' | 'StartTrial' | 'Agent_Drafted' | ...
  eventId: string; // el MISMO uuid que viajó al dataLayer (deduplicación)
  eventSourceUrl?: string; // URL donde ocurrió (mejora el matching)
  actionSource?: 'website' | 'app' | 'system_generated';
  user: CapiUserData;
  customData?: Record<string, unknown>;
  eventTime?: number; // epoch en segundos; default = ahora
}

function buildUserData(u: CapiUserData): Record<string, unknown> {
  const em = hash(u.email);
  const ph = hashPhone(u.phone);
  const externalId = hash(u.externalId != null ? String(u.externalId) : undefined);
  return {
    ...(em ? { em: [em] } : {}),
    ...(ph ? { ph: [ph] } : {}),
    ...(externalId ? { external_id: [externalId] } : {}),
    ...(u.clientIpAddress ? { client_ip_address: u.clientIpAddress } : {}),
    ...(u.clientUserAgent ? { client_user_agent: u.clientUserAgent } : {}),
    ...(u.fbp ? { fbp: u.fbp } : {}),
    ...(u.fbc ? { fbc: u.fbc } : {}),
  };
}

/**
 * Manda un evento a la Conversions API de Meta. No lanza si falla: loguea y
 * devuelve false, para que el tracking nunca rompa el flujo de negocio.
 */
export async function sendCapiEvent(
  event: CapiEvent,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) {
    log.warn('META_PIXEL_ID/META_CAPI_TOKEN no configurados — CAPI deshabilitada');
    return false;
  }

  const payload = {
    data: [
      {
        event_name: event.eventName,
        event_time: event.eventTime ?? Math.floor(Date.now() / 1000),
        action_source: event.actionSource ?? 'website',
        event_id: event.eventId,
        ...(event.eventSourceUrl ? { event_source_url: event.eventSourceUrl } : {}),
        user_data: buildUserData(event.user),
        ...(event.customData ? { custom_data: event.customData } : {}),
      },
    ],
    // Solo en pruebas: apunta el evento a "Test Events" del Events Manager.
    ...(process.env.META_TEST_EVENT_CODE
      ? { test_event_code: process.env.META_TEST_EVENT_CODE }
      : {}),
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      log.error({ status: res.status, body, event: event.eventName }, 'CAPI error');
      return false;
    }
    log.info({ event: event.eventName, eventId: event.eventId }, 'CAPI enviado');
    return true;
  } catch (err) {
    log.error({ err, event: event.eventName }, 'CAPI fetch falló');
    return false;
  }
}
