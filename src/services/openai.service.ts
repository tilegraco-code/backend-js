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
};
