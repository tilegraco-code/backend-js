-- Integración con WooCommerce (catálogo + armado de pedidos para pagar).
--
-- Cada tienda WooCommerce vive en su propio WordPress, así que además de las claves
-- guardamos la URL de la tienda (la carga el cliente en el dashboard). Las claves
-- son las de la REST API de WooCommerce (consumer key / secret): no rotan ni vencen,
-- se revocan desde WooCommerce → Ajustes → Avanzado → REST API.
--
-- Se consiguen de dos formas (las dos terminan en esta tabla):
--  - botón "Conectar": endpoint /wc-auth/v1/authorize de la tienda, que le manda las
--    claves por POST a backend-js (/api/woocommerce/oauth/callback);
--  - pegándolas a mano en el dashboard (hostings que rompen el flujo anterior).

create table if not exists public.woocommerce_connections (
  id              bigint generated always as identity primary key,
  client_id       integer     not null unique references public.client(client_id) on delete cascade,
  store_url       text        not null,
  consumer_key    text        not null,
  consumer_secret text        not null,
  -- 'header' = Authorization: Basic. 'query' = consumer_key/secret en la query string,
  -- para hostings que se comen el header Authorization (se detecta al conectar).
  auth_mode       text        not null default 'header' check (auth_mode in ('header', 'query')),
  -- 'read' | 'write' | 'read_write'. Sin escritura no se pueden crear pedidos.
  key_permissions text,
  store_name      text,
  currency        text,
  connected_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.woocommerce_connections is
  'Claves de la REST API de WooCommerce por cliente. 1 fila por client_id: una tienda por workspace.';
comment on column public.woocommerce_connections.store_url is
  'URL base de la tienda (https, sin barra final), ya resuelta tras redirecciones al conectar.';

-- Caché read-through del catálogo (mismo esquema que tiendanube_cache): snapshot JSON
-- por (client_id, resource) con TTL. Bajar el catálogo de WooCommerce es caro (las
-- variaciones de cada producto variable van en un request aparte).
create table if not exists public.woocommerce_cache (
  id          bigint generated always as identity primary key,
  client_id   integer     not null references public.client(client_id) on delete cascade,
  resource    text        not null,
  payload     jsonb       not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  updated_at  timestamptz not null default now(),
  unique (client_id, resource)
);

-- Tipo de tool nuevo ---------------------------------------------------------
--
-- `agent_tools.type` tiene un CHECK con la lista de tipos permitidos: sin esto el
-- INSERT de la tool de WooCommerce falla con 500 desde el dashboard.

alter table public.agent_tools
  drop constraint if exists agent_tools_type_check;

alter table public.agent_tools
  add constraint agent_tools_type_check
  check (type in ('google_sheet', 'google_calendar', 'http', 'cal_com', 'tiendanube', 'shipnow', 'composio', 'woocommerce'));

-- RLS ------------------------------------------------------------------------
--
-- Habilitada y SIN policies, igual que shipnow_connections: sólo la service role key
-- (backend-js, y el dashboard server-side) llega a estas tablas. Las claves no pueden
-- quedar al alcance de anon / authenticated.

alter table public.woocommerce_connections enable row level security;
alter table public.woocommerce_cache enable row level security;
