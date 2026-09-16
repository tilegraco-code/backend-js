-- Documentos recibidos por chat. Ver docs/documentos-y-casos-plan.md.
--
-- Una fila por archivo que manda un cliente, en cualquier canal y para cualquier agente.
-- `unipile_messages.attachments` sigue siendo lo que renderiza la bandeja; esta tabla es lo
-- que el agente puede consultar después del turno en que llegó el archivo: qué es, qué dice,
-- si se lee.
--
-- Es también la cola de procesamiento (status + next_attempt_at + claim con SKIP LOCKED).
--
-- Sin FK a unipile_chats ni a unipile_messages a propósito: MercadoLibre ingiere los
-- adjuntos ANTES de crear el chat y el mensaje, y el chat de prueba del dashboard no tiene
-- fila en unipile_chats. La identidad es (message_id, idx).

-- 1. Tabla --------------------------------------------------------------------

create table if not exists public.chat_documents (
  id              bigint      generated always as identity primary key,
  client_id       integer     not null references public.client(client_id) on delete cascade,
  chat_id         text        not null,
  message_id      text        not null,
  idx             smallint    not null,

  storage_path    text        not null,
  kind            text        not null check (kind in ('image', 'document', 'audio', 'video', 'other')),
  mime            text        not null,
  name            text,
  size            integer,
  sha256          text        not null,

  -- Resultado del procesamiento
  doc_type        text,
  confidence      real,
  summary         text,
  extracted       jsonb,
  legible         boolean,
  issues          jsonb,

  -- Cola
  status          text        not null default 'pending'
                  check (status in ('pending', 'processing', 'ready', 'failed', 'skipped')),
  attempts        smallint    not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  last_error      text,
  duplicate_of    bigint      references public.chat_documents(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (message_id, idx)
);

comment on table public.chat_documents is
  'Archivos recibidos por chat, con su clasificación y datos extraídos. Es también la cola de procesamiento. Ver backend-js/docs/documentos-y-casos-plan.md.';
comment on column public.chat_documents.status is
  'pending: en cola. processing: tomado por el worker (locked_at). ready: procesado. failed: falló; se reintenta mientras attempts < tope. skipped: no se procesa (audio, video, duplicado).';
comment on column public.chat_documents.duplicate_of is
  'Si el cliente reenvió el mismo archivo (mismo sha256 en el mismo chat), apunta al original y la fila queda skipped.';

create index if not exists chat_documents_chat_idx
  on public.chat_documents (chat_id, created_at);

create index if not exists chat_documents_queue_idx
  on public.chat_documents (next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists chat_documents_sha_idx
  on public.chat_documents (chat_id, sha256);

-- 2. RLS ----------------------------------------------------------------------
--
-- Datos personales (DNI, licencias). Sin políticas: solo la service role key (backend-js)
-- lee y escribe. El dashboard los consulta a través del backend.

alter table public.chat_documents enable row level security;

-- 3. Claim de la cola ---------------------------------------------------------
--
-- supabase-js no puede hacer SELECT ... FOR UPDATE SKIP LOCKED, así que el claim es una
-- función. Toma hasta p_limit filas vencidas, las marca processing y las devuelve en la
-- misma transacción: dos workers nunca se llevan la misma fila.
--
-- También recupera las filas que quedaron en processing por un proceso que murió a mitad
-- (locked_at más viejo que p_stale_seconds).

create or replace function public.claim_chat_documents(
  p_limit integer default 10,
  p_max_attempts integer default 5,
  p_stale_seconds integer default 300
)
returns setof public.chat_documents
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Una fila colgada que ya gastó sus intentos no vuelve a la cola: queda failed, a la vista.
  update public.chat_documents
  set status = 'failed',
      locked_at = null,
      last_error = coalesce(last_error, 'el procesamiento quedó colgado'),
      updated_at = now()
  where status = 'processing'
    and locked_at < now() - make_interval(secs => p_stale_seconds)
    and attempts >= p_max_attempts;

  return query
  with picked as (
    select id
    from public.chat_documents
    where attempts < p_max_attempts
      and (
        (status in ('pending', 'failed') and next_attempt_at <= now())
        or (status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds))
      )
    order by next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.chat_documents d
    set status = 'processing',
        locked_at = now(),
        attempts = d.attempts + 1,
        updated_at = now()
    from picked
    where d.id = picked.id
    returning d.*
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_chat_documents(integer, integer, integer) from public, anon, authenticated;
