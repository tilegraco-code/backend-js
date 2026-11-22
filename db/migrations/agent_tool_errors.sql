-- Fallas de las herramientas de un Buddy (Composio, HTTP propias, nativas), registradas por el
-- runtime (agente-tilegra) al terminar cada turno. Las lee el copiloto para poder avisar
-- "la acción de Pipedrive falló 3 veces ayer". Solo service role (sin políticas RLS).

create table if not exists public.agent_tool_errors (
  id         bigserial primary key,
  agent_id   integer not null references public.agent(agent_id) on delete cascade,
  client_id  integer,
  tool       text not null,
  source     text,                 -- composio | http | native | other
  error      text not null,
  created_at timestamptz not null default now()
);

create index if not exists agent_tool_errors_agent_created_idx
  on public.agent_tool_errors (agent_id, created_at desc);

alter table public.agent_tool_errors enable row level security;
