// Tipos del payload de EvolutionAPI v2 (WhatsApp-Baileys).
// Evolution manda payloads muy variables; modelamos solo lo que consumimos.

export type EvolutionMessageKey = {
  remoteJid: string;
  fromMe?: boolean;
  id: string;
  participant?: string;
};

export type EvolutionMessageContent = {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  documentMessage?: { caption?: string; fileName?: string };
  audioMessage?: Record<string, unknown>;
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
