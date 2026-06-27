// Núcleo de auth de Google. Construye el cliente OAuth2 (SDK googleapis), arma la
// URL de consentimiento, intercambia el code y entrega clientes autorizados por
// client_id (con refresh automático + persistencia de tokens). Patrón getCreds()
// igual que el resto de *-api.service.ts.
import { google, Auth } from 'googleapis';
import { googleService } from './google.service';

// Scopes que pide la app. Mantener en sync con el OAuth consent screen de Google.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.events',
  // drive.file: acceso solo a los archivos que el usuario elige vía Google Picker.
  // Es scope "sensitive" (NO restricted) → no requiere CASA, solo verificación estándar.
  // La discovery de archivos la hace el Picker en el browser, no nosotros.
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile',
];

// Error tipado para "este cliente no conectó Google" → las rutas devuelven 409.
export class GoogleNotConnectedError extends Error {
  constructor(clientId: number) {
    super(`El cliente ${clientId} no tiene Google conectado`);
    this.name = 'GoogleNotConnectedError';
  }
}

function getCreds(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET y/o GOOGLE_OAUTH_REDIRECT_URI no configuradas',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function oauthClient(): Auth.OAuth2Client {
  const { clientId, clientSecret, redirectUri } = getCreds();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export const googleApiService = {
  /** URL del consent screen de Google (usada en /oauth/connect). */
  authUrl(state: string): string {
    return oauthClient().generateAuthUrl({
      access_type: 'offline', // pide refresh_token
      prompt: 'consent', // fuerza refresh_token aunque ya haya consentido antes
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state,
    });
  },

  /**
   * Intercambia el authorization code por tokens y resuelve el email de la cuenta.
   * Devuelve los tokens crudos (incluye refresh_token) + el email para guardar.
   */
  async exchangeCode(code: string): Promise<{ tokens: Auth.Credentials; email: string | null }> {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    let email: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const me = await oauth2.userinfo.get();
      email = me.data.email ?? null;
    } catch {
      // best-effort: si falla igual guardamos la conexión sin email.
    }

    return { tokens, email };
  },

  /**
   * Cliente OAuth2 autorizado para un client_id. Setea credenciales desde la DB y
   * deja que el SDK refresque solo cuando el access_token vence; persistimos los
   * tokens nuevos vía el evento 'tokens'. Lanza GoogleNotConnectedError si no hay conexión.
   */
  async authorizedClient(clientId: number): Promise<Auth.OAuth2Client> {
    const conn = await googleService.getConnection(clientId);
    if (!conn) throw new GoogleNotConnectedError(clientId);

    const client = oauthClient();
    client.setCredentials({
      access_token: conn.access_token,
      refresh_token: conn.refresh_token,
      expiry_date: conn.expiry_date ? Date.parse(conn.expiry_date) : undefined,
    });

    client.on('tokens', (tokens) => {
      void googleService.updateTokens(clientId, tokens).catch(() => {
        /* no romper el request si falla la persistencia del refresh */
      });
    });

    return client;
  },

  /**
   * Devuelve un access_token vigente (refresca si hace falta) para que el Google
   * Picker corra en el navegador. Token de vida corta (~1h). Lanza GoogleNotConnectedError.
   */
  async accessToken(clientId: number): Promise<{ token: string; expiry_date: number | null }> {
    const client = await this.authorizedClient(clientId);
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('No se pudo obtener un access token de Google');
    return { token, expiry_date: client.credentials.expiry_date ?? null };
  },

  /** Revoca el token en Google (best-effort, para desconectar). */
  async revoke(token: string): Promise<void> {
    try {
      await oauthClient().revokeToken(token);
    } catch {
      /* best-effort */
    }
  },
};
