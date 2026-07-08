import OpenAI from 'openai';

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

const FOLLOW_UP_SYSTEM_PROMPT = `Sos un asistente que redacta mensajes cortos de seguimiento en español rioplatense (Argentina).
Recibís los últimos mensajes de una conversación entre nuestra empresa y un cliente que dejó de responder.
Tarea: redactar UN SOLO mensaje breve (máx 200 caracteres) para retomar la conversación, refiriéndote a algo específico del último intercambio.
Tono: amable, casual, no insistente. Sin emoticones a menos que el contexto los pida.
Devolvé SOLO el texto del mensaje, sin comillas, sin explicaciones, sin firma.`;

export type FollowUpMessage = {
  direction: 'incoming' | 'outgoing';
  content: string;
  created_at: string;
};

export const openaiService = {
  async generateFollowUp(
    messages: FollowUpMessage[],
    contactName: string | null,
  ): Promise<string> {
    const conversation = messages
      .map((m) => `${m.direction === 'incoming' ? 'CLIENTE' : 'BOT'}: ${m.content}`)
      .join('\n');

    const userPrompt = `Cliente: ${contactName ?? 'desconocido'}\n\nÚltimos mensajes:\n${conversation}\n\nEscribí un mensaje de seguimiento.`;

    const res = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: FOLLOW_UP_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const text = res.choices[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('OpenAI devolvió respuesta vacía');
    return text.slice(0, 500);
  },

  /**
   * Traduce un error técnico (de n8n / una tool) a una explicación breve en español
   * simple y accionable para el dueño de un negocio sin conocimiento técnico.
   * gpt-5-mini (razonamiento) → sin `temperature` custom.
   */
  async summarizeError(raw: string, context?: string): Promise<string> {
    const userPrompt =
      `Error técnico:\n${raw}\n` +
      (context ? `\nDónde ocurrió: ${context}\n` : '') +
      `\nExplicá en español rioplatense, en máximo 2 frases, qué pasó y qué habría que ` +
      `ajustar para que no vuelva a fallar. Sin jerga técnica, sin nombres de variables ` +
      `internas. Devolvé SOLO la explicación.`;

    const res = await getClient().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content:
            'Sos un asistente que le explica a un dueño de negocio SIN conocimiento técnico ' +
            'por qué falló su agente de IA. Claro, concreto y accionable.',
        },
        { role: 'user', content: userPrompt },
      ],
    });

    const text = res.choices[0]?.message?.content?.trim() ?? '';
    return text.slice(0, 600) || 'No se pudo generar un resumen del error.';
  },
};
