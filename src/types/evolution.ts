// Tipos del payload de EvolutionAPI v2 (WhatsApp-Baileys).
// Evolution manda payloads muy variables; modelamos solo lo que consumimos.

export type EvolutionMessageKey = {
  remoteJid: string;
  fromMe?: boolean;
  id: string;
  participant?: string;
};

/** Lo que comparten los mensajes con archivo adjunto. Los bytes NO vienen acá. */
export type EvolutionMediaMessage = {
  caption?: string;
  mimetype?: string;
  fileName?: string;
  fileLength?: number | string;
};

export type EvolutionMessageContent = {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: EvolutionMediaMessage;
  videoMessage?: EvolutionMediaMessage;
  documentMessage?: EvolutionMediaMessage;
  // WhatsApp manda los PDF reenviados como documentWithCaptionMessage, con el
  // documentMessage real anidado adentro.
  documentWithCaptionMessage?: { message?: { documentMessage?: EvolutionMediaMessage } };
  audioMessage?: EvolutionMediaMessage;
  stickerMessage?: Record<string, unknown>;
  buttonsResponseMessage?: { selectedDisplayText?: string };
  listResponseMessage?: { title?: string };
  // ...y muchos más; los ignoramos como contenido vacío.
};

export type EvolutionMessageUpsertData = {
  key: EvolutionMessageKey;
  pushName?: string;
  message?: EvolutionMessageContent | null;
  messageTimestamp?: number | string;
  messageType?: string;
};

export type EvolutionConnectionUpdateData = {
  state?: 'open' | 'connecting' | 'close' | string;
  statusReason?: number;
};

export type EvolutionWebhookPayload = {
  event?: string;
  instance?: string;
  data?: unknown;
  date_time?: string;
  sender?: string;
  destination?: string;
};
