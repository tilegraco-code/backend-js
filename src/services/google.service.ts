// Conexión OAuth de Google por cliente.
// Tabla google_connections (1 fila por client_id). Solo accesible con service role.
// A diferencia de TiendaNube, el access_token EXPIRA (~1h): guardamos refresh_token
// y expiry_date para refrescar. El refresh lo maneja google-api.service via el SDK.
import { supabase } from '../lib/supabase';

export type GoogleConnection = {
  id: number;
  client_id: number;
  google_email: string | null;
  access_token: string;
  refresh_token: string;
  scope: string | null;
  token_type: string | null;
  expiry_date: string | null; // ISO; cuándo vence el access_token
  connected_at: string;
  updated_at: string;
};

// Subset de credenciales que devuelve el SDK de googleapis (evento 'tokens').
export type GoogleTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null; // epoch ms
};

function expiryToIso(expiry?: number | null): string | null {
  return expiry ? new Date(expiry).toISOString() : null;
}

export const googleService = {
  async getConnection(clientId: number): Promise<GoogleConnection | null> {
    const { data, error } = await supabase
      .from('google_connections')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw error;
    return (data as GoogleConnection | null) ?? null;
  },

  /** Upsert tras el OAuth callback. Requiere refresh_token (access_type=offline). */
  async saveConnection(input: {
    clientId: number;
    googleEmail: string | null;
    accessToken: string;
    refreshToken: string;
    scope: string | null;
    tokenType: string | null;
    expiryDate: number | null;
  }): Promise<void> {
    const { error } = await supabase.from('google_connections').upsert(
      {
        client_id: input.clientId,
        google_email: input.googleEmail,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        scope: input.scope,
        token_type: input.tokenType ?? 'Bearer',
        expiry_date: expiryToIso(input.expiryDate),
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' },
    );
    if (error) throw error;
  },

  /**
   * Persiste tokens refrescados por el SDK. El refresh_token solo viene la primera
   * vez; si no llega, NO lo pisamos (mantenemos el existente).
   */
  async updateTokens(clientId: number, tokens: GoogleTokens): Promise<void> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (tokens.access_token) patch.access_token = tokens.access_token;
    if (tokens.refresh_token) patch.refresh_token = tokens.refresh_token;
    if (tokens.scope) patch.scope = tokens.scope;
    if (tokens.token_type) patch.token_type = tokens.token_type;
    if (tokens.expiry_date) patch.expiry_date = expiryToIso(tokens.expiry_date);

    const { error } = await supabase
      .from('google_connections')
      .update(patch)
      .eq('client_id', clientId);
    if (error) throw error;
  },

  async deleteConnection(clientId: number): Promise<void> {
    const { error } = await supabase
      .from('google_connections')
      .delete()
      .eq('client_id', clientId);
    if (error) throw error;
  },
};
