-- Segunda mitad de mercadolibre_questions.sql: la config del aviso de venta ya vive en
-- mercadolibre_settings.
--
-- CORRER RECIÉN CUANDO backend-js Y dashboard-tilegra NUEVOS ESTÉN DESPLEGADOS: las
-- versiones anteriores todavía leen estas columnas y fallarían al seleccionarlas.

alter table public.unipile_inboxes drop column if exists ml_sale_enabled;
alter table public.unipile_inboxes drop column if exists ml_sale_template;
