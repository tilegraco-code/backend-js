-- Control del sync de casos a Drive y Sheets. Ver docs/documentos-y-casos-plan.md.
--
-- Va después de chat_cases.sql. La cola es la misma tabla: sync_status + sync_next_attempt_at.
-- sync_locked_at evita que dos pasadas sincronicen el mismo caso a la vez; si el proceso muere a
-- mitad, el lock vence solo.

alter table public.chat_cases
  add column if not exists sync_attempts        smallint    not null default 0,
  add column if not exists sync_next_attempt_at timestamptz not null default now(),
  add column if not exists sync_locked_at       timestamptz,
  add column if not exists sync_error           text,
  add column if not exists synced_at            timestamptz;

comment on column public.chat_cases.sync_error is
  'Último error del sync, legible para mostrar en el dashboard (p. ej. "Google Drive no está conectado").';

create index if not exists chat_cases_sync_queue_idx
  on public.chat_cases (sync_next_attempt_at)
  where sync_status in ('pending', 'failed');
