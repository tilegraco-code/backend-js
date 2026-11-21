-- 1) Consumo del copiloto: una fila por turno (mensaje o click en una tarjeta), con los
--    tokens reales de todas las llamadas al LLM de ese turno. Sirve para ver el uso por org
--    en /org-settings y, a futuro, cobrarlo o limitarlo.
--    Lo escribe el dashboard (service role) en POST /api/copilot. Sin políticas RLS: solo
--    se lee y escribe con service role.
--
-- 2) Avatar del agente: id de un "buddy" (ver dashboard-tilegra/lib/buddies.ts). Null = el
--    de por defecto.

begin;

create table if not exists public.copilot_usage (
  id                  bigserial primary key,
  client_id           integer not null references public.client(client_id) on delete cascade,
  user_id             uuid,
  conversation        text not null,
  kind                text not null check (kind in ('message', 'resume')),
  input_tokens        integer not null default 0,   -- input NO cacheado (igual que agentuse)
  input_cached_tokens integer not null default 0,
  output_tokens       integer not null default 0,
  llm_calls           integer not null default 0,
  model               text,
  agent_id            integer,                      -- el agente que armó (si ya existe)
  created_at          timestamptz not null default now()
);

create index if not exists copilot_usage_client_created_idx
  on public.copilot_usage (client_id, created_at desc);

alter table public.copilot_usage enable row level security;

alter table public.agentprops add column if not exists avatar text;

commit;
