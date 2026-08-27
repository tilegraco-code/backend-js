-- Interruptor del aviso de venta confirmada, separado de la plantilla.
--
-- Antes el trigger se activaba con `ml_sale_template is not null`, lo que obligaba
-- a borrar el texto para apagarlo: al volver a encenderlo el cliente perdía la
-- plantilla que había elegido. Con un flag aparte, el texto sobrevive apagado.
--
-- Default false: el aviso es opt-in. Un canal recién conectado no le escribe a
-- nadie hasta que el cliente lo active explícitamente.

alter table public.unipile_inboxes
  add column if not exists ml_sale_enabled boolean not null default false;

comment on column public.unipile_inboxes.ml_sale_enabled is
  'Si está en true Y ml_sale_template tiene texto, se manda el DM al comprador cuando la orden pasa a paid. Separado de la plantilla para poder apagar el aviso sin perder el texto elegido.';
