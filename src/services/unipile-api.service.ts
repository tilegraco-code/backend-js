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
   * Baja el binario de un adjunto de un mensaje.
   *
   * Va por este endpoint y NO por el `url` que viene en el webhook: ese apunta al
   * CDN del proveedor y en WhatsApp llega cifrado, así que no sirve para bajarlo
   * derecho. Acá Unipile lo devuelve ya descifrado.
   */
  async getMessageAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ bytes: Buffer; mime: string | null }> {
    const { dsn, apiKey } = getCreds();
    const url =
      `${dsn.replace(/\/$/, '')}/api/v1/messages/${encodeURIComponent(messageId)}` +
      `/attachments/${encodeURIComponent(attachmentId)}`;

    const res = await fetch(url, { headers: { 'X-API-KEY': apiKey } });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Unipile getMessageAttachment ${res.status}: ${errText}`);
    }

    // El webhook de WhatsApp no manda mime (sólo `attachment_type: "img"`), así que el
    // content-type de esta respuesta es la única fuente real del tipo de archivo.
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type'),
    };
  },

  /**
   * Baja un adjunto desde la URL que vino en el webhook.
   *
   * Plan B para cuando el adjunto no trae `id` y no se puede pedir por el endpoint de
   * mensajes. Manda la API key igual: algunas de esas URLs son del propio Unipile y la
   * piden, y a un CDN externo un header de más no le molesta.
   *
   * NOTE: no está verificado que la URL del webhook sea descargable en todos los
   * proveedores. Si acá vuelve basura en vez del archivo, el camino bueno es el del `id`.
   */
  async downloadAttachmentUrl(url: string): Promise<{ bytes: Buffer; mime: string | null }> {
    if (!url) throw new Error('Adjunto sin id ni url: no hay de dónde bajarlo');
    const { apiKey } = getCreds();

    const res = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Unipile downloadAttachmentUrl ${res.status}: ${errText}`);
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type'),
    };
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
