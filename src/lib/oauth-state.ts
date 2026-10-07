// Firma/verificación del `state` del OAuth de TiendaNube.
// El dashboard (sesión autenticada) firma el client_id con INTERNAL_API_KEY y el
// backend lo verifica en connect/callback, evitando que se conecte una tienda a
// un client_id ajeno. Formato: base64url(payload) + "." + base64url(HMAC).
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 10 * 60_000; // 10 min de validez del state

function secret(): string {
  const s = process.env.INTERNAL_API_KEY;
  if (!s) throw new Error('INTERNAL_API_KEY no configurada (requerida para el state del OAuth)');
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * `extra` viaja firmado junto al client_id (ej. WooCommerce manda la URL de la
 * tienda, que no se puede deducir en el callback).
 */
export function signState(clientId: number, extra: Record<string, string> = {}): string {
  const payload = b64url(JSON.stringify({ ...extra, client_id: clientId, ts: Date.now() }));
  const sig = b64url(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Devuelve el contenido del state si es válido y no expiró; si no, null. */
export function verifyStateData(
  state: string,
  maxAgeMs = MAX_AGE_MS,
): ({ client_id: number } & Record<string, unknown>) | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;

  const expected = b64url(createHmac('sha256', secret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      client_id?: number;
      ts?: number;
    } & Record<string, unknown>;
    if (!decoded.client_id || !decoded.ts) return null;
    if (Date.now() - decoded.ts > maxAgeMs) return null;
    return decoded as { client_id: number } & Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Devuelve el client_id si el state es válido y no expiró; si no, null. */
export function verifyState(state: string): number | null {
  return verifyStateData(state)?.client_id ?? null;
}
