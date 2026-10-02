-- Secreto de una tool HTTP (token, API key o contraseña de Basic auth).
--
-- Va en una columna aparte, NO en `config`, porque `config` lo lee el navegador
-- (GET /api/agents/:id/tools del dashboard) y viaja al runtime en el
-- runtime-config. El secreto sólo lo lee backend-js al ejecutar la tool
-- (POST /api/tools/http/run): ni el dashboard ni el runtime lo reciben.

alter table public.agent_tools
  add column if not exists secret text;
