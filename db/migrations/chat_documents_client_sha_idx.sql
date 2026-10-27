-- Dedupe de adjuntos por cliente.
--
-- La ingesta busca si el cliente ya tiene guardado un archivo con el mismo sha256 y,
-- si lo tiene, reusa ese path en vez de subirlo de nuevo. El índice existente es por
-- (chat_id, sha256) y no sirve para buscar en todos los chats del cliente.

create index if not exists chat_documents_client_sha_idx
  on public.chat_documents (client_id, sha256);
