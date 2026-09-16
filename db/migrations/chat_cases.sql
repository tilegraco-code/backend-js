-- Casos por chat y su configuración por agente. Ver docs/documentos-y-casos-plan.md.
--
-- Va después de chat_documents.sql. Opt-in: un agente sin agent_case_settings.enabled no
-- ve nada de esto y sus documentos se registran igual que siempre.

-- 1. Configuración por agente -------------------------------------------------

create table if not exists public.agent_case_settings (
  agent_id        integer     primary key references public.agent(agent_id) on delete cascade,
  enabled         boolean     not null default false,
  number_prefix   text        not null default 'CASO' check (number_prefix ~ '^[A-Z0-9]{1,10}$'),
  -- Destino. En null no se sincroniza (fase 4).
  drive_parent_id text,
  sheet_id        text,
  sheet_tab       text,
  sheet_columns   jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.agent_case_settings.sheet_columns is
  '[{ header, source }] con source en: number, case_type, status, opened_at, completed_at, missing, drive_folder_url, data.<clave>.';

-- Catálogo de documentos. Aparte de los tipos de caso porque un mismo documento (DNI,
-- cédula) aparece en varios, y porque un documento se clasifica antes de que exista el caso.
create table if not exists public.agent_document_types (
  id          bigint      generated always as identity primary key,
  agent_id    integer     not null references public.agent(agent_id) on delete cascade,
  key         text        not null check (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  label       text        not null,
  description text        not null,
  fields      jsonb       not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (agent_id, key)
);

create table if not exists public.agent_case_types (
  id          bigint      generated always as identity primary key,
  agent_id    integer     not null references public.agent(agent_id) on delete cascade,
  key         text        not null check (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  label       text        not null,
  description text        not null,
  definition  jsonb       not null,
  active      boolean     not null default true,
  position    smallint    not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (agent_id, key)
);

comment on column public.agent_case_types.definition is
  'Datos y documentos requeridos. Se valida con caseDefinitionSchema (backend-js/src/schemas/case-definition.ts).';

-- 2. Numeración ---------------------------------------------------------------
--
-- Un contador por cliente, atómico: el upsert toma el lock de la fila. Nunca lo genera el modelo.

create table if not exists public.case_counters (
  client_id   integer primary key references public.client(client_id) on delete cascade,
  last_number bigint  not null default 0
);

create or replace function public.next_case_number(p_client_id integer)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.case_counters as c (client_id, last_number)
  values (p_client_id, 1)
  on conflict (client_id) do update set last_number = c.last_number + 1
  returning last_number;
$$;

revoke all on function public.next_case_number(integer) from public, anon, authenticated;

-- 3. Casos --------------------------------------------------------------------

create table if not exists public.chat_cases (
  id            bigint      generated always as identity primary key,
  client_id     integer     not null references public.client(client_id) on delete cascade,
  agent_id      integer     not null references public.agent(agent_id) on delete cascade,
  chat_id       text        not null,
  number        text        not null,
  case_type     text        not null,
  status        text        not null default 'open'
                check (status in ('open', 'complete', 'closed', 'cancelled')),
  data          jsonb       not null default '{}',
  -- Copia de la definición del tipo y del catálogo al abrir. Ver caseRequirementsSchema.
  requirements  jsonb       not null,
  evaluation    jsonb,
  sync_status   text        not null default 'pending'
                check (sync_status in ('none', 'pending', 'synced', 'failed')),
  external_ref  jsonb,
  opened_at     timestamptz not null default now(),
  completed_at  timestamptz,
  closed_at     timestamptz,
  updated_at    timestamptz not null default now(),
  unique (client_id, number)
);

comment on column public.chat_cases.status is
  'open: juntando datos y documentos. complete: tiene todo (puede volver a open si llega algo que no pasa). closed: lo cerró un humano. cancelled: el cliente desistió o fue un error.';

-- Un solo caso activo por chat: así un documento nuevo sabe a qué caso pertenece.
create unique index if not exists chat_cases_one_active_per_chat
  on public.chat_cases (chat_id)
  where status in ('open', 'complete');

create index if not exists chat_cases_client_idx
  on public.chat_cases (client_id, opened_at desc);

-- 4. Documentos → caso ---------------------------------------------------------

alter table public.chat_documents
  add column if not exists case_id      bigint references public.chat_cases(id) on delete set null,
  add column if not exists sync_status  text not null default 'none'
    check (sync_status in ('none', 'pending', 'synced', 'failed')),
  add column if not exists external_ref jsonb;

create index if not exists chat_documents_case_idx
  on public.chat_documents (case_id)
  where case_id is not null;

-- 5. RLS ----------------------------------------------------------------------
--
-- Sin políticas: lee y escribe solo la service role key. El dashboard pasa por backend-js.

alter table public.agent_case_settings  enable row level security;
alter table public.agent_document_types enable row level security;
alter table public.agent_case_types     enable row level security;
alter table public.case_counters        enable row level security;
alter table public.chat_cases           enable row level security;
