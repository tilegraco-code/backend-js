function getCreds(): { dsn: string; apiKey: string } {
  const dsn = process.env.UNIPILE_DEFAULT_DSN;
  const apiKey = process.env.UNIPILE_DEFAULT_API_KEY;
  if (!dsn || !apiKey) {
    throw new Error('UNIPILE_DEFAULT_DSN y/o UNIPILE_DEFAULT_API_KEY no configuradas');
  }
  return { dsn, apiKey };
}

export type UnipileSendMessageResponse = {
  id?: string;
  message_id?: string;
  [key: string]: unknown;
};

export const unipileApiService = {
  async sendMessage(chatId: string, text: string): Promise<UnipileSendMessageResponse> {
    const { dsn, apiKey } = getCreds();
    const form = new FormData();
    form.append('text', text);

    const url = `${dsn.replace(/\/$/, '')}/api/v1/chats/${encodeURIComponent(chatId)}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Unipile sendMessage ${res.status}: ${errText}`);
    }

    return (await res.json()) as UnipileSendMessageResponse;
  },

  /**
   * Desconecta y elimina una cuenta en Unipile. Idempotente desde el punto de
   * vista del CRON: un 404 (cuenta ya inexistente) se trata como éxito.
   */
  async deleteAccount(accountId: string): Promise<void> {
    const { dsn, apiKey } = getCreds();
    const url = `${dsn.replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(accountId)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-API-KEY': apiKey },
    });

    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      throw new Error(`Unipile deleteAccount ${res.status}: ${errText}`);
    }
  },
};
