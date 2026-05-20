# backend-js

Backend production-ready dockerizado: **Node.js 20 + TypeScript + Fastify + Supabase**, con cron jobs y API REST. Pensado para deploy en EasyPanel.

## Stack

- Node.js 20 LTS
- TypeScript 5
- Fastify 4 (con `@fastify/cors`, `@fastify/helmet`, logging vía Pino)
- `@supabase/supabase-js` v2
- `node-cron` para tareas programadas
- Zod para validación
- Docker multi-stage build

## Estructura

```
src/
├── index.ts                 # Entry point — arranca servidor + cron jobs
├── server.ts                # Fastify (plugins, CORS, helmet, error handler)
├── lib/supabase.ts          # Cliente Supabase singleton
├── routes/
│   ├── index.ts             # Registrador central
│   ├── health.route.ts      # GET /health
│   └── example.route.ts     # CRUD de ejemplo
├── services/example.service.ts
├── jobs/
│   ├── index.ts             # Bootstrap de cron jobs
│   └── example.job.ts       # Job de ejemplo (cada hora)
├── middlewares/auth.middleware.ts   # API Key opcional
└── types/index.ts
```

## Setup local

Requiere Node 20+ y [pnpm](https://pnpm.io) (`brew install pnpm` o `corepack enable`).

```bash
cp .env.example .env       # Completar SUPABASE_URL y SERVICE_ROLE_KEY
pnpm install
pnpm dev                   # ts-node-dev con hot reload
```

Servidor en `http://localhost:3000`.

- Healthcheck: `GET /health`
- Documentación interactiva (Swagger UI): [http://localhost:3000/docs](http://localhost:3000/docs)
- OpenAPI JSON: `GET /docs/json`

## Scripts

| Comando | Descripción |
|---|---|
| `pnpm dev` | Modo desarrollo con hot reload |
| `pnpm build` | Compila TS a `dist/` |
| `pnpm start` | Corre la build de producción |
| `pnpm typecheck` | Solo valida tipos |

## Variables de entorno

Ver `.env.example`. En producción se cargan desde la UI de EasyPanel.

| Variable | Requerida | Descripción |
|---|---|---|
| `PORT` | no (3000) | Puerto HTTP |
| `NODE_ENV` | no | `development` / `production` |
| `SUPABASE_URL` | **sí** | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | **sí** | Service role key (server-side only) |
| `INTERNAL_TOKEN` | **sí** | Token interno requerido por todas las rutas `/api/*` |
| `DISABLE_JOBS` | no | `true` desactiva los cron jobs |

### Autenticación

Todas las rutas bajo `/api/*` requieren el header:

```
x-internal-token: <INTERNAL_TOKEN>
```

o equivalentemente `Authorization: Bearer <INTERNAL_TOKEN>`. Las rutas `/health` y `/docs` quedan públicas (la primera para el healthcheck de EasyPanel; la segunda para la doc de Swagger).

En Swagger UI hacé click en **Authorize** y pegá el token — queda guardado entre recargas (`persistAuthorization: true`).

## Docker

```bash
docker compose up --build           # local
docker build -t backend-js .        # build standalone
docker run -p 3000:3000 --env-file .env backend-js
```

Imagen final ~150 MB (multi-stage, sin devDependencies).

## Deploy en EasyPanel

1. Push del repo a GitHub
2. EasyPanel → **New Service → App** → conectar repo
3. Detecta `Dockerfile` automáticamente
4. Cargar variables del `.env.example`
5. Healthcheck: `GET /health`
6. Deploy

## Cron jobs

Cada job vive en `src/jobs/*.job.ts` y se registra desde `src/jobs/index.ts`. Para agregar uno nuevo:

1. Crear `mi-tarea.job.ts` exportando `registerMiTareaJob(log)`
2. Agregarlo al array en `src/jobs/index.ts`

Setear `DISABLE_JOBS=true` para desactivarlos (útil cuando corren múltiples réplicas).
