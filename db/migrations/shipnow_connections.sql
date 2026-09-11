-- Integración con shipnow (logística para ecommerce, https://api.shipnow.com.ar).
--
-- A diferencia de TiendaNube y MercadoLibre, shipnow NO tiene OAuth: la cuenta se
-- identifica con un token fijo que el dueño de la cuenta pide por mail a
-- developers@shipnow.com.ar y pega en el dashboard. Por eso acá no hay
-- refresh_token ni expires_at: el token no rota y no vence.
--
-- El token va en cada request como `Authorization: Bearer <token>`.

create table if not exists public.shipnow_connections (
  id           bigint generated always as identity primary key,
  client_id    integer     not null unique references public.client(client_id) on delete cascade,
  api_token    text        not null,
  account_name text,
  connected_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists shipnow_connections_client_id_idx
  on public.shipnow_connections (client_id);

comment on table public.shipnow_connections is
  'Token de API de shipnow por cliente. 1 fila por client_id: una cuenta de shipnow por workspace.';
comment on column public.shipnow_connections.api_token is
  'Token permanente de shipnow (no rota, no vence). Se manda como Authorization: Bearer. Se revoca pidiéndolo a shipnow, no hay endpoint de revocación.';
comment on column public.shipnow_connections.account_name is
  'Nombre del punto de venta que devolvió shipnow al validar el token (order.store.name). Sólo para mostrar en el dashboard.';

-- Tipo de tool nuevo ---------------------------------------------------------
--
-- `agent_tools.type` tiene un CHECK con la lista de tipos permitidos: sin esto el
-- INSERT de la tool de shipnow falla con 500 desde el dashboard.

alter table public.agent_tools
  drop constraint if exists agent_tools_type_check;

alter table public.agent_tools
  add constraint agent_tools_type_check
  check (type in ('google_sheet', 'google_calendar', 'http', 'cal_com', 'tiendanube', 'shipnow', 'composio'));

-- RLS ------------------------------------------------------------------------
--
-- Habilitada y SIN policies, igual que tiendanube_connections / mercadolibre_connections:
-- la tabla queda accesible sólo con la service role key (que la bypassea), que es
-- como entra backend-js. Sin esto, las claves anon / authenticated podrían leer el token.

alter table public.shipnow_connections enable row level security;
