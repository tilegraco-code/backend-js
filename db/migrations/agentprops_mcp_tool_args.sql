-- Argumentos fijos de las tools de Composio del agente: { SLUG: { param: valor } }.
-- Los elige el dueño al configurar una acción (ej. qué planilla de Google Sheets lee el Buddy,
-- a qué canal de Slack avisa). El runtime los oculta del esquema que ve el LLM y los inyecta
-- al ejecutar (agente-tilegra/app/tools/composio.py). Lo escribe el dashboard (enableCapability).

alter table public.agentprops
  add column if not exists mcp_tool_args jsonb not null default '{}'::jsonb;
