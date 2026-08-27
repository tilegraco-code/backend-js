-- Canal de MercadoLibre. Ver docs/mercadolibre-canal-plan.md.
--
-- ML entra como una fila más de `unipile_inboxes` (source='mercadolibre') en vez
-- de ser un canal aparte, para heredar sin cambios la facturación por usos, el
-- corte de ciclo de vida, la bandeja del dashboard y el envío saliente.
--
--   unipile_inboxes.account_id = el user_id del vendedor en ML. El
--   UNIQUE (client_id, account_id) que ya existe nos da idempotencia al reconectar,
--   y `outgoing-message.service` resuelve el inbox por esa columna sin tocarse.

-- 1. Habilitar el source ------------------------------------------------------

alter table public.unipile_inboxes
  drop constraint if exists unipile_inboxes_source_check;

alter table public.unipile_inboxes
  add constraint unipile_inboxes_source_check
  check (source in ('unipile', 'evolution', 'mercadolibre'));

-- 2. Plantilla del aviso de venta confirmada ----------------------------------
--
-- Es config del canal, no del agente: el mismo agente puede atender WhatsApp (sin
-- plantilla) y ML (con plantilla). En null el trigger no manda nada — es opt-in.
--
-- El texto NO lo genera el LLM a propósito: el action guide de ML tiene un tope
-- duro de 350 caracteres y una moderación que rechaza por AUTOMATIC_MESSAGE, así
-- que conviene que sea determinista y validable antes de enviarse.

alter table public.unipile_inboxes
  add column if not exists ml_sale_template text;

comment on column public.unipile_inboxes.ml_sale_template is
  'Plantilla del DM que se manda al comprador cuando la orden pasa a paid. Variables: {comprador}, {producto}, {orden}, {total}. Máx 350 caracteres YA renderizada (límite del action guide de ML). En null, el canal no manda nada al confirmarse la venta.';

-- 3. Conexiones OAuth ---------------------------------------------------------
--
-- Análoga a tiendanube_connections, pero ML rota tokens: el access_token dura 6 h
-- y el refresh_token es DE UN SOLO USO (cada refresh devuelve uno nuevo). Por eso
-- guardamos refresh_token + expires_at, cosa que TiendaNube no necesita.

create table if not exists public.mercadolibre_connections (
  id            bigint generated always as identity primary key,
  client_id     integer     not null references public.client(client_id) on delete cascade,
  ml_user_id    bigint      not null unique,
  site_id       text        not null,
  nickname      text,
  access_token  text        not null,
  refresh_token text        not null,
  expires_at    timestamptz not null,
  scope         text,
  connected_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists mercadolibre_connections_client_id_idx
  on public.mercadolibre_connections (client_id);

comment on column public.mercadolibre_connections.ml_user_id is
  'user_id del vendedor en ML. UNIQUE global: las notificaciones de ML solo traen user_id, así que es lo único con lo que podemos mapear notificación → cliente.';
comment on column public.mercadolibre_connections.refresh_token is
  'De un solo uso: cada refresh lo invalida y devuelve uno nuevo. Dos refresh concurrentes sobre la misma fila se pisan, por eso el servicio los serializa con un mutex en memoria.';

-- 4. Órdenes vistas -----------------------------------------------------------
--
-- Idempotencia del trigger de venta confirmada. orders_v2 notifica en CADA cambio
-- de la orden, no solo al pagarse: sin esto le mandaríamos el DM al comprador una
-- vez por notificación.

create table if not exists public.mercadolibre_orders (
  order_id     bigint primary key,
  ml_user_id   bigint      not null,
  client_id    integer     not null references public.client(client_id) on delete cascade,
  pack_id      bigint,
  status       text        not null,
  buyer_id     bigint,
  buyer_name   text,
  greeted_at   timestamptz,
  greet_status text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.mercadolibre_orders
  drop constraint if exists mercadolibre_orders_greet_status_check;

alter table public.mercadolibre_orders
  add constraint mercadolibre_orders_greet_status_check
  check (greet_status is null or greet_status in ('sent', 'moderated', 'blocked', 'no_cap', 'failed'));

create index if not exists mercadolibre_orders_ml_user_id_idx
  on public.mercadolibre_orders (ml_user_id);

comment on column public.mercadolibre_orders.pack_id is
  'Pack al que pertenece la orden. Null en órdenes simples: ahí ML acepta el order_id en el mismo path /packs/{id}.';
comment on column public.mercadolibre_orders.greeted_at is
  'Se escribe ANTES de postear a ML (claim optimista) para que dos notificaciones concurrentes de la misma orden no dupliquen el DM.';
comment on column public.mercadolibre_orders.greet_status is
  'moderated = ML aceptó el POST (200) pero el moderador rechazó el mensaje y el comprador NUNCA lo vio. no_cap = se agotó el cap_available del action guide. blocked = ML no permite mensajería en esta orden (cancelada, Full sin entregar).';

-- 5. RLS ----------------------------------------------------------------------
--
-- Habilitada y SIN policies, igual que tiendanube_connections y el resto del
-- esquema: la tabla queda accesible solo con la service role key (que la
-- bypassea), que es como entra backend-js. Sin esto, las claves anon /
-- authenticated podrían leer los access_token y refresh_token.

alter table public.mercadolibre_connections enable row level security;
alter table public.mercadolibre_orders enable row level security;
