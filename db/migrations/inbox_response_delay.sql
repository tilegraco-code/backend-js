-- Espera antes de que responda la IA, configurable por canal.
--
-- Hasta acá era un único valor para todo el sistema (DEBOUNCE_SECONDS en
-- agente-tilegra). El debounce junta los mensajes que el usuario manda seguidos
-- y responde una sola vez: en WhatsApp conviene esperar (la gente escribe en
-- ráfagas), en el snippet web o en MercadoLibre no tanto.
--
-- NULL = usar el default global del runtime. El tope de 60s viene del TTL de
-- 120s de las claves del debounce en Redis.

alter table public.unipile_inboxes
  add column if not exists response_delay_seconds smallint;

alter table public.unipile_inboxes
  drop constraint if exists unipile_inboxes_response_delay_seconds_check;

alter table public.unipile_inboxes
  add constraint unipile_inboxes_response_delay_seconds_check
  check (response_delay_seconds is null or response_delay_seconds between 0 and 60);

comment on column public.unipile_inboxes.response_delay_seconds is
  'Segundos que espera la IA antes de responder, para juntar mensajes seguidos (0 = responde al toque). NULL = default global del runtime (DEBOUNCE_SECONDS).';
