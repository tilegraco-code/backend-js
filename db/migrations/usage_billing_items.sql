-- usage_billing_items
-- Excedente de usos (créditos) por CLIENTE y período de facturación (mes calendario).
-- Espejo conceptual de document_billing_items: acumula el monto a cobrar como
-- `pending`, el dashboard lo suma al preapproval de MercadoPago (syncPreapprovalAmount)
-- y el webhook de authorized_payment lo marca `paid`.
--
-- Modelo (ver memoria project-credits-overage-billing):
--   included_uses = (inboxes NO-WEB del cliente) * 1750
--   total_uses    = filas de agentuse del cliente en el período
--   billable_uses = max(0, total_uses - included_uses)
--   amount_ars    = billable_uses * 14
--
-- Base-cliente (no por-agente-vía-workflow) porque los inboxes pertenecen al
-- client_id y el link inbox→workflow puede faltar; el preapproval de MP también
-- es por cliente. Con 1 agente por proyecto/cliente equivale a "por agente".

create table if not exists public.usage_billing_items (
  id             integer generated always as identity primary key,
  client_id      integer not null,
  billing_period text    not null,                 -- 'YYYY-MM' (mes calendario cerrado)
  included_uses  integer not null default 0,
  total_uses     integer not null default 0,
  billable_uses  integer not null default 0,
  amount_ars     numeric not null default 0,
  status         varchar not null default 'pending', -- 'pending' | 'paid' | 'free'
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  paid_at        timestamptz,
  constraint usage_billing_items_client_period_uniq unique (client_id, billing_period)
);

create index if not exists usage_billing_items_client_status_idx
  on public.usage_billing_items (client_id, status);

create index if not exists usage_billing_items_period_idx
  on public.usage_billing_items (billing_period);

-- RLS: mismo patrón que document_billing_items / client_billing. Los writes van
-- por service_role (cron backend + webhook) que bypassea RLS; la política sólo
-- habilita a los usuarios del cliente a LEER sus propias filas.
alter table public.usage_billing_items enable row level security;

drop policy if exists usage_billing_items_select_own on public.usage_billing_items;
create policy usage_billing_items_select_own
  on public.usage_billing_items
  for select
  to public
  using (
    client_id in (
      select "user".client_id from "user" where "user".user_id = auth.uid()
    )
  );

-- ── Helpers de agregación (solo lectura) ───────────────────────────────────
-- Usos por cliente en un rango [from, to). 1 fila de agentuse = 1 uso.
-- OJO: agentuse.client_id es un placeholder (0) inútil; resolvemos el cliente
-- real vía agent → project.
create or replace function public.usage_counts_in_range(p_from timestamptz, p_to timestamptz)
returns table(client_id integer, uses bigint)
language sql stable security invoker set search_path = '' as $$
  select p.client_id, count(*)::bigint
  from public.agentuse au
  join public.agent a on a.agent_id = au.agent_id
  join public.project p on p.project_id = a.project_id
  where au.created_at >= p_from and au.created_at < p_to
    and au.agent_id is not null
  group by p.client_id
$$;

-- Inboxes NO-WEB por cliente (allowance base). El inbox de websnippet
-- (provider='WEB') no aporta allowance. No depende del link inbox→workflow.
create or replace function public.client_inbox_allowance()
returns table(client_id integer, inbox_count bigint)
language sql stable security invoker set search_path = '' as $$
  select client_id, count(*)::bigint
  from public.unipile_inboxes
  where provider is distinct from 'WEB'
  group by client_id
$$;
