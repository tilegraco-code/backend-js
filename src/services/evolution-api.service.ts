function getCreds(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('EVOLUTION_API_URL y/o EVOLUTION_API_KEY no configuradas');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

export type EvolutionSendTextParams = {
  instanceName: string;
  number: string; // E.164 sin +, p.ej. 5491155555555
  text: string;
};

export type EvolutionSendTextResponse = {
  key?: { id?: string };
  [key: string]: unknown;
};

export const evolutionApiService = {
  /**
   * Envía un mensaje de texto vía Evolution. El eco vuelve por el webhook como
   * send.message y queda persistido con direction='outgoing'.
   */
  async sendText({
    instanceName,
    number,
    text,
  }: EvolutionSendTextParams): Promise<EvolutionSendTextResponse> {
    const { baseUrl, apiKey } = getCreds();

    const url = `${baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ number, text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Evolution sendText ${res.status}: ${errText}`);
    }

    return (await res.json()) as EvolutionSendTextResponse;
  },

  /**
   * Cierra la sesión de WhatsApp de una instancia. No es bloqueante: puede
   * fallar si la sesión ya estaba cerrada (se ignora el error en el caller).
   */
  async logoutInstance(instanceName: string): Promise<void> {
    const { baseUrl, apiKey } = getCreds();
    const url = `${baseUrl}/instance/logout/${encodeURIComponent(instanceName)}`;
    const res = await fetch(url, { method: 'DELETE', headers: { apikey: apiKey } });
    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      throw new Error(`Evolution logout ${res.status}: ${errText}`);
    }
  },

  /**
   * Elimina por completo una instancia de Evolution. Un 404 (instancia ya
   * inexistente) se trata como éxito.
   */
  async deleteInstance(instanceName: string): Promise<void> {
    const { baseUrl, apiKey } = getCreds();
    const url = `${baseUrl}/instance/delete/${encodeURIComponent(instanceName)}`;
    const res = await fetch(url, { method: 'DELETE', headers: { apikey: apiKey } });
    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      throw new Error(`Evolution delete ${res.status}: ${errText}`);
    }
  },
};
