-- Tools de solo lectura de MercadoLibre para el agente (productos, stock, envíos,
-- estado de la venta, factura y medios de pago). Ver docs/mercadolibre-tools.md.
--
-- No hay tabla nueva: la cuenta sale de mercadolibre_connections y la tool la elige en
-- agent_tools.config.ml_user_id. Solo hay que permitir el tipo nuevo: sin esto, crear
-- la tool desde el dashboard da 500.

alter table public.agent_tools
  drop constraint if exists agent_tools_type_check;

alter table public.agent_tools
  add constraint agent_tools_type_check
  check (type in ('google_sheet', 'google_calendar', 'http', 'cal_com', 'tiendanube', 'shipnow', 'composio', 'woocommerce', 'mercadolibre'));
