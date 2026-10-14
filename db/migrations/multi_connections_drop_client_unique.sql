-- Varias conexiones por cliente (fase 2 de 2). Ver multi_connections.sql.
--
-- CORRER RECIÉN CUANDO backend-js NUEVO ESTÉ DESPLEGADO: el anterior hace upsert con
-- onConflict 'client_id' (conexiones) y 'client_id,resource' (caché), y sin estos
-- UNIQUE esos upserts fallan. Desde acá un cliente puede conectar una segunda tienda.

alter table public.tiendanube_connections  drop constraint if exists tiendanube_connections_client_id_key;
alter table public.woocommerce_connections drop constraint if exists woocommerce_connections_client_id_key;
alter table public.shipnow_connections     drop constraint if exists shipnow_connections_client_id_key;

alter table public.tiendanube_cache  drop constraint if exists tiendanube_cache_client_id_resource_key;
alter table public.woocommerce_cache drop constraint if exists woocommerce_cache_client_id_resource_key;

-- El puente de la fase 1 ya no hace falta (y con varias tiendas elegiría mal).
drop trigger if exists tiendanube_cache_fill_connection_id on public.tiendanube_cache;
drop trigger if exists woocommerce_cache_fill_connection_id on public.woocommerce_cache;
drop function if exists public.cache_fill_connection_id();

-- No debería haber (el trigger las completaba), pero el NOT NULL de abajo no perdona.
delete from public.tiendanube_cache  where connection_id is null;
delete from public.woocommerce_cache where connection_id is null;
alter table public.tiendanube_cache  alter column connection_id set not null;
alter table public.woocommerce_cache alter column connection_id set not null;

create index if not exists tiendanube_connections_client_id_idx  on public.tiendanube_connections (client_id);
create index if not exists woocommerce_connections_client_id_idx on public.woocommerce_connections (client_id);
