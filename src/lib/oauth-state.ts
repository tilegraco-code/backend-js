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

export function signState(clientId: number): string {
  const payload = b64url(JSON.stringify({ client_id: clientId, ts: Date.now() }));
  const sig = b64url(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Devuelve el client_id si el state es válido y no expiró; si no, null. */
export function verifyState(state: string): number | null {
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
    };
    if (!decoded.client_id || !decoded.ts) return null;
    if (Date.now() - decoded.ts > MAX_AGE_MS) return null;
    return decoded.client_id;
  } catch {
    return null;
  }
}
