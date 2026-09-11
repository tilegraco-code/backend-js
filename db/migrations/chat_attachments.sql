-- Adjuntos en los mensajes del chat. Ver docs/imagenes-y-documentos-plan.md.
--
-- El contenido legible del mensaje sigue en `content` (el caption, o un placeholder
-- tipo `[imagen]`). Los archivos van acá, aparte, porque son otra cosa: el dashboard
-- los renderiza y el runtime los consume como entrada multimodal.
--
-- NO se guarda acá el texto extraído de un PDF. A quien mira la bandeja le sirve el
-- archivo, no ocho mil caracteres sueltos; el texto lo extrae el runtime en el turno.

-- 1. Columna ------------------------------------------------------------------
--
-- Cada item: { kind, mime, name, size, path }.
--
--   kind  image | document | audio | video | other
--   path  ubicación en el bucket, NO una URL. Las URLs firmadas vencen; el path no,
--         así que se firma recién en el momento en que se necesita.

alter table public.unipile_messages
  add column if not exists attachments jsonb;

-- 2. Bucket -------------------------------------------------------------------
--
-- Privado a propósito: son archivos de conversaciones de clientes. Lo escribe el
-- backend con la service role key y se lee solo por URL firmada de vida corta.

insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;
