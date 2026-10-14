-- Varias conexiones por cliente en TiendaNube / WooCommerce / shipnow (fase 1 de 2).
-- Ver docs/multi-conexion-integraciones-plan.md.
--
-- Antes: 1 fila por client_id (una tienda por workspace). Ahora la conexión es "una
-- tienda" y cada tool del agente elige la suya en `agent_tools.config.connection_id`.
-- Una tool sin connection_id (todas las creadas antes de esto) usa la conexión más
-- vieja del cliente, que para quien tiene una sola tienda es exactamente lo de hoy.
--
-- Esta fase es ADITIVA y compatible con el backend-js anterior: no saca el
-- UNIQUE (client_id), que es el `onConflict` de los upserts viejos. Correrla ANTES de
-- desplegar backend-js. La fase 2 (multi_connections_drop_client_unique.sql) es la que
-- habilita la segunda tienda.

-- 1. Clave natural de cada conexión -------------------------------------------
--
-- Es el `onConflict` del backend nuevo: reconectar la MISMA tienda actualiza su fila
-- (el id no cambia y las tools que la apuntan siguen andando); otra tienda inserta.
-- Mientras siga el UNIQUE (client_id) son redundantes, por eso no rompen nada.

alter table public.tiendanube_connections
  add constraint tiendanube_connections_client_store_key unique (client_id, store_id);

alter table public.woocommerce_connections
  add constraint woocommerce_connections_client_store_key unique (client_id, store_url);

-- shipnow no devuelve un id de cuenta estable al validar el token: la clave es el
-- token. Cambiar el token de una cuenta ya conectada se hace por connection_id.
alter table public.shipnow_connections
  add constraint shipnow_connections_client_token_key unique (client_id, api_token);

-- 2. Caché por conexión ---------------------------------------------------------
--
-- El snapshot pasa a ser por tienda. Nullable en esta fase porque el backend viejo
-- sigue escribiendo filas sin connection_id (las completa el trigger de abajo).

alter table public.tiendanube_cache
  add column if not exists connection_id bigint
  references public.tiendanube_connections(id) on delete cascade;
alter table public.tiendanube_cache
  add constraint tiendanube_cache_connection_resource_key unique (connection_id, resource);

alter table public.woocommerce_cache
  add column if not exists connection_id bigint
  references public.woocommerce_connections(id) on delete cascade;
alter table public.woocommerce_cache
  add constraint woocommerce_cache_connection_resource_key unique (connection_id, resource);

-- Las filas que ya están son de la única conexión que tiene cada cliente hoy.
update public.tiendanube_cache c
   set connection_id = t.id
  from public.tiendanube_connections t
 where t.client_id = c.client_id and c.connection_id is null;
update public.woocommerce_cache c
   set connection_id = w.id
  from public.woocommerce_connections w
 where w.client_id = c.client_id and c.connection_id is null;

-- Puente mientras conviven los dos backends: el viejo escribe sin connection_id y la
-- fila quedaría invisible para el nuevo, pero ocupando el UNIQUE (client_id, resource)
-- que todavía existe, así que el upsert del nuevo chocaría. El trigger le pone la
-- conexión del cliente (hay una sola hasta la fase 2, que lo borra).
create or replace function public.cache_fill_connection_id() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.connection_id is null then
    execute format('select id from public.%I where client_id = $1 order by id limit 1', tg_argv[0])
      into new.connection_id
      using new.client_id;
  end if;
  return new;
end $$;

create trigger tiendanube_cache_fill_connection_id
  before insert or update on public.tiendanube_cache
  for each row execute function public.cache_fill_connection_id('tiendanube_connections');

create trigger woocommerce_cache_fill_connection_id
  before insert or update on public.woocommerce_cache
  for each row execute function public.cache_fill_connection_id('woocommerce_connections');

comment on table public.tiendanube_connections is
  'Tiendas de TiendaNube por cliente (puede haber varias). Las tools eligen una con agent_tools.config.connection_id; sin eso, la más vieja del cliente.';
comment on table public.woocommerce_connections is
  'Claves de la REST API de WooCommerce por tienda (puede haber varias por cliente). Las tools eligen una con agent_tools.config.connection_id; sin eso, la más vieja del cliente.';
comment on table public.shipnow_connections is
  'Tokens de API de shipnow por cuenta (puede haber varias por cliente). Las tools eligen una con agent_tools.config.connection_id; sin eso, la más vieja del cliente.';
