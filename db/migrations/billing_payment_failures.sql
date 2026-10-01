-- Cobros recurrentes rechazados.
--
-- client_billing.payment_failed_at → MercadoPago agotó los 4 reintentos de una
--   cuota (authorized_payment `processed` con el pago `rejected`). Lo escribe el
--   webhook del dashboard y lo limpia el próximo cobro aprobado. El cron de
--   account-lifecycle corta los canales cuando pasa la gracia desde acá.
--
-- invoice.notified_key → `<payment_id>:<payment_status>` del último email que se
--   le mandó al cliente por esa cuota. MP manda el mismo evento varias veces
--   (created/updated) y la cuota se reintenta con pagos nuevos: con esto se
--   avisa una vez por intento, no una vez por webhook.

alter table public.client_billing
  add column if not exists payment_failed_at timestamptz;

alter table public.invoice
  add column if not exists notified_key text;
