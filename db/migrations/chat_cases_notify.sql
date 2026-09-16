-- Aviso proactivo cuando la revisión de un documento termina después del turno.
-- Ver docs/documentos-y-casos-plan.md, "Cuando el worker termina después del turno".
--
-- notify_requested_at se pisa solo si está vacío: agrupa los resultados que llegan juntos
-- (cinco fotos → un solo mensaje). notified_at limita a un aviso por chat cada 60 s.

alter table public.chat_cases
  add column if not exists notify_requested_at timestamptz,
  add column if not exists notified_at         timestamptz;

create index if not exists chat_cases_notify_idx
  on public.chat_cases (notify_requested_at)
  where notify_requested_at is not null;
