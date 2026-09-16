// Constantes de la cola de chat_documents compartidas entre servicios. Viven aparte para que
// cases.service y chat-documents.service puedan usarlas sin importarse entre sí.

/** Intentos antes de dejar un documento en failed para siempre. */
export const MAX_ATTEMPTS = 5;
