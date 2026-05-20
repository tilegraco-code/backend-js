# Plan: Backend Dockerizado con Node.js + TypeScript + Fastify + Supabase

## Objetivo

Construir un backend production-ready, dockerizado y deployable en EasyPanel.
Stack: **Node.js + TypeScript + Fastify**, con integración a **Supabase**, soporte de **Cron Jobs** y exposición de **API REST**.

---

## Stack Tecnológico

| Capa | Tecnología | Versión |
|---|---|---|
| Runtime | Node.js | 20 LTS |
| Lenguaje | TypeScript | ^5.x |
| Framework HTTP | Fastify | ^4.x |
| Cron Jobs | node-cron | ^3.x |
| Supabase Client | @supabase/supabase-js | ^2.x |
| Validación de schemas | Zod | ^3.x |
| Variables de entorno | dotenv | ^16.x |
| Containerización | Docker + Docker Compose | - |

---

## Estructura del Proyecto

```
backend/
├── src/
│   ├── index.ts                  # Entry point — inicializa Fastify y registra todo
│   ├── server.ts                 # Configuración de Fastify (plugins, CORS, hooks)
│   ├── lib/
│   │   └── supabase.ts           # Cliente Supabase singleton
│   ├── routes/
│   │   ├── index.ts              # Registrador central de rutas
│   │   ├── health.route.ts       # GET /health — healthcheck para EasyPanel
│   │   └── example.route.ts     # Ejemplo de ruta REST
│   ├── services/
│   │   └── example.service.ts   # Lógica de negocio desacoplada de las rutas
│   ├── jobs/
│   │   ├── index.ts              # Inicializa y registra todos los cron jobs
│   │   └── example.job.ts       # Ejemplo de cron job
│   ├── middlewares/
│   │   └── auth.middleware.ts    # Validación de API Key o JWT (opcional)
│   └── types/
│       └── index.ts              # Tipos e interfaces globales
├── .env                          # Variables locales (no commitear)
├── .env.example                  # Template de variables de entorno
├── .dockerignore
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
└── package.json
```

---

## Archivos Clave a Generar

### `src/index.ts`
- Importa y arranca el servidor Fastify
- Inicializa los cron jobs
- Maneja errores de arranque

### `src/server.ts`
- Registra plugins: `@fastify/cors`, `@fastify/helmet`
- Registra todas las rutas desde `routes/index.ts`
- Configura logging con `pino` (incluido en Fastify)

### `src/lib/supabase.ts`
- Exporta un cliente Supabase singleton
- Lee `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` desde `.env`

### `src/routes/health.route.ts`
- `GET /health` → responde `{ status: "ok", timestamp }` 
- Necesario para el healthcheck de EasyPanel/Docker

### `src/routes/example.route.ts`
- Ejemplo de CRUD básico contra Supabase
- Usa Zod para validar el body del request
- Llama a `example.service.ts` para la lógica

### `src/jobs/example.job.ts`
- Cron job con `node-cron`
- Ejemplo: se ejecuta cada 1 hora, hace una query a Supabase

---

## Variables de Entorno

**En producción** las variables se setean directamente desde la UI de EasyPanel — no se necesita `.env` en el servidor.

**En desarrollo local** crear un `.env` en la raíz (no commitear):

```env
PORT=3000
NODE_ENV=development

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Seguridad (opcional)
API_SECRET_KEY=tu-api-key-interna
```

> El `.env.example` sí se commitea como referencia, sin valores reales.

---

## Dockerfile

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

> Multi-stage build: imagen final liviana (~150MB), sin devDependencies ni código TypeScript.

---

## docker-compose.yml (para desarrollo local)

```yaml
version: '3.8'
services:
  backend:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./src:/app/src    # Hot reload en desarrollo
    restart: unless-stopped
```

---

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Scripts en `package.json`

```json
{
  "scripts": {
    "dev": "ts-node-dev --respawn src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src/**/*.ts"
  }
}
```

---

## Deploy en EasyPanel

1. Pushear el repo a GitHub
2. En EasyPanel → **New Service → App**
3. Conectar el repo
4. EasyPanel detecta el `Dockerfile` automáticamente
5. Agregar las variables de entorno desde `.env.example`
6. Configurar el healthcheck en `GET /health`
7. Deploy 🚀

---

## Orden de Implementación Sugerido

1. `package.json` + `tsconfig.json` — base del proyecto
2. `Dockerfile` + `docker-compose.yml` — containerización
3. `.env.example` — variables
4. `src/lib/supabase.ts` — cliente Supabase
5. `src/server.ts` + `src/index.ts` — servidor base
6. `src/routes/health.route.ts` — healthcheck
7. `src/routes/example.route.ts` + `src/services/example.service.ts` — primera ruta funcional
8. `src/jobs/example.job.ts` — primer cron job
9. Build Docker local → test → push a EasyPanel
