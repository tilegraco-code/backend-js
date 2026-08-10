-- Distingue por qué un inbox quedó suspendido, para saber cómo reactivarlo.
--
--   lifecycle_cut  → el cron de account-lifecycle (trial vencido / impago tras
--                    la gracia) destruyó la cuenta en Unipile o la instancia en
--                    Evolution. La fila ya no apunta a nada: hay que reconectar.
--   billing_paused → MercadoPago pausó o canceló la suscripción, pero la cuenta
--                    del proveedor sigue viva. Al autorizar de nuevo se
--                    reactiva sola, sin reconectar.
--
-- Sin esta distinción, la reactivación no puede decidir entre "reactivar la
-- fila" y "borrarla para que el cliente reconecte limpio".

alter table public.unipile_inboxes
  add column if not exists suspended_reason text,
  add column if not exists suspended_at timestamptz;

alter table public.unipile_inboxes
  drop constraint if exists unipile_inboxes_suspended_reason_check;

alter table public.unipile_inboxes
  add constraint unipile_inboxes_suspended_reason_check
  check (suspended_reason is null or suspended_reason in ('lifecycle_cut', 'billing_paused'));

comment on column public.unipile_inboxes.suspended_reason is
  'Por qué está suspendido. lifecycle_cut = el cron de account-lifecycle destruyó la cuenta/instancia en el proveedor (hay que reconectar de cero). billing_paused = MercadoPago pausó/canceló la suscripción pero la cuenta del proveedor sigue viva (se reactiva sola al pagar).';
