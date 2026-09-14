-- Preguntas en publicaciones de MercadoLibre. Ver docs/mercadolibre-preguntas-plan.md.
--
-- Además saca la config del canal de `unipile_inboxes` a una tabla propia. El inbox
-- sigue existiendo para los DMs (son conversaciones reales de la bandeja); la config
-- del canal y las preguntas no lo son.
--
-- Identidad: (client_id, ml_user_id) y NO un FK a mercadolibre_connections. El corte
-- por impago borra la conexión (sin tokens no hay servicio) y al reconectar la fila
-- vuelve con otro id: un cascade se llevaría la config y el historial en cada corte.

-- 1. Config del canal ---------------------------------------------------------

create table if not exists public.mercadolibre_settings (
  client_id             integer     not null references public.client(client_id) on delete cascade,
  ml_user_id            bigint      not null,
  -- Aviso de venta confirmada (antes unipile_inboxes.ml_sale_*).
  sale_enabled          boolean     not null default false,
  sale_template         text,
  -- Respuesta automática de preguntas.
  questions_enabled     boolean     not null default false,
  questions_workflow_id bigint      references public.workflow(id) on delete set null,
  questions_signature   text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (client_id, ml_user_id)
);

create index if not exists mercadolibre_settings_ml_user_id_idx
  on public.mercadolibre_settings (ml_user_id);

comment on column public.mercadolibre_settings.questions_workflow_id is
  'Agente (workflow del cliente) que responde las preguntas. Independiente del agente vinculado al inbox de DMs. En null no se responde nada.';
comment on column public.mercadolibre_settings.questions_signature is
  'Texto estático que se agrega después de la respuesta del agente. Sin links, teléfonos ni mails: ML modera la respuesta completa.';

-- Copia de la config existente. Idempotente: no pisa lo que ya se haya editado.
insert into public.mercadolibre_settings (client_id, ml_user_id, sale_enabled, sale_template)
select i.client_id, i.account_id::bigint, coalesce(i.ml_sale_enabled, false), i.ml_sale_template
from public.unipile_inboxes i
where i.source = 'mercadolibre'
  and i.account_id ~ '^[0-9]+$'
on conflict (client_id, ml_user_id) do nothing;

-- 2. Preguntas ----------------------------------------------------------------

create table if not exists public.mercadolibre_questions (
  question_id    bigint      primary key,
  client_id      integer     not null references public.client(client_id) on delete cascade,
  ml_user_id     bigint      not null,
  item_id        text        not null,
  item_title     text,
  item_thumbnail text,
  item_permalink text,
  buyer_id       bigint,
  buyer_nickname text,
  question       text        not null,
  asked_at       timestamptz not null,
  answer         text,
  answered_at    timestamptz,
  answered_by    text,
  workflow_id    bigint      references public.workflow(id) on delete set null,
  status         text        not null,
  error          text,
  claimed_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.mercadolibre_questions
  drop constraint if exists mercadolibre_questions_status_check;
alter table public.mercadolibre_questions
  add constraint mercadolibre_questions_status_check
  check (status in ('pending', 'answered', 'needs_human', 'auto_off', 'failed', 'closed'));

alter table public.mercadolibre_questions
  drop constraint if exists mercadolibre_questions_answered_by_check;
alter table public.mercadolibre_questions
  add constraint mercadolibre_questions_answered_by_check
  check (answered_by is null or answered_by in ('ai', 'seller'));

create index if not exists mercadolibre_questions_client_asked_idx
  on public.mercadolibre_questions (client_id, asked_at desc);
create index if not exists mercadolibre_questions_client_status_idx
  on public.mercadolibre_questions (client_id, status, asked_at desc);
create index if not exists mercadolibre_questions_client_item_idx
  on public.mercadolibre_questions (client_id, item_id);

comment on column public.mercadolibre_questions.status is
  'pending = el agente está respondiendo. answered = publicada (ver answered_by). needs_human = el agente no supo, se mandó mail. auto_off = llegó con la respuesta automática apagada. failed = falló el agente o ML (ver error). closed = ML la cerró/borró sin respuesta.';
comment on column public.mercadolibre_questions.claimed_at is
  'Claim optimista antes de invocar al agente: ML reintenta la notificación y sin esto se publicarían dos respuestas.';

-- 3. RLS ----------------------------------------------------------------------
-- settings: sin policies, solo la service role key (backend-js y las rutas server
-- del dashboard).
--
-- questions: lectura para los usuarios del mismo cliente, igual que unipile_chats /
-- unipile_messages. Hace falta para Realtime: la tab del Inbox escucha los cambios
-- con la clave anon + sesión, y Realtime aplica RLS a cada evento. Las escrituras
-- siguen siendo solo del service role.

alter table public.mercadolibre_settings enable row level security;
alter table public.mercadolibre_questions enable row level security;

drop policy if exists mercadolibre_questions_read on public.mercadolibre_questions;
create policy mercadolibre_questions_read on public.mercadolibre_questions
  for select
  using (client_id = (select "user".client_id from "user" where "user".user_id = auth.uid()));

-- 4. Realtime -----------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mercadolibre_questions'
  ) then
    alter publication supabase_realtime add table public.mercadolibre_questions;
  end if;
end $$;
