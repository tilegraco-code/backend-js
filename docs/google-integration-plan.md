# Plan: Integración profesional con Google (Sheets + Calendar + Drive)

> Estado: **propuesta / pre-implementación**
> Autor: equipo backend · Fecha: 2026-06-27
> Objetivo: mover la integración de Google del dashboard al backend, con OAuth por
> cliente, lectura/escritura y SDK oficial, reusando el patrón de TiendaNube.

---

## 1. Objetivo y alcance

Hoy la integración de Google vive en `dashboard-tilegra` y es mínima: solo **Google
Sheets públicos**, vía el export CSV `gviz`, **solo lectura**, con parseo de CSV a
mano y corriendo dentro del proceso de Next.js (ver [`lib/tools.ts`](../../dashboard-tilegra/lib/tools.ts)).

Queremos una integración **profesional alojada en el backend** (`backend-js`), que:

- Use **OAuth por cliente** (cada cliente conecta su propia cuenta de Google).
- Soporte **lectura y escritura**.
- Cubra **Google Sheets** y **Google Calendar** (Calendar convive con Cal.com, no lo reemplaza).
- Incluya **Google Drive** con scope mínimo (`drive.file`) para buscar/crear sheets y leer Docs.
- Sea consumida por los **agentes IA** como una tool más (mismo patrón que `tiendanube`).

### Fuera de alcance (por ahora)
- Escribir/editar Google Docs (usa `batchUpdate` por índices, es avanzado → fase futura).
- Gmail.
- Drive completo (`drive.readonly` / `drive`) — requiere verificación de seguridad CASA de Google.
- UI de dashboard para ver/editar datos de Google (el consumidor es el agente, no el usuario).

---

## 2. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Servicios | **Sheets + Calendar** (+ Drive `drive.file` de base, + leer Docs como bonus fase 3) |
| Auth | **OAuth por cliente** (no service account, no sheets públicos) |
| Operaciones | **Lectura + escritura** |
| Consumidor | **Agentes IA** (tools en n8n) |
| Calendar vs Cal.com | **Conviven** ambos; el cliente elige cuál usar |
| Scope de Drive | **`drive.file`** (solo archivos que la app crea/abre) |

---

## 3. Arquitectura general

No tocamos el patrón de n8n. n8n sigue invocando un único tool genérico
(`toolHttpRequest`) que pega a `/api/tools/run` del dashboard; el dashboard despacha
y **forwardea al backend**, donde vive toda la lógica de Google.

```
Agente n8n
  → toolHttpRequest node (genérico)
  → POST {dashboard}/api/tools/run?tool_id=X&input=...
  → runTool() despacha por type → runGoogleSheet() / runGoogleCalendar()
  → resuelve client_id (agent → project → client_id)
  → fetch {BACKEND_PUBLIC_URL}/api/google/*  (Authorization: Bearer INTERNAL_API_KEY)
  → backend: google-api.service resuelve OAuth (refresh si hace falta)
  → llama a la API oficial de Google (googleapis)
  → devuelve resultado al agente
```

### Responsabilidades por capa

| Capa | Qué hace | Qué NO hace |
|---|---|---|
| n8n | Invoca el tool genérico | No tiene lógica ni credenciales de Google |
| dashboard `runTool()` | Dispatcher + resuelve `client_id` + forward al backend | No habla con la API de Google |
| backend `/api/google/*` | **Toda** la lógica: OAuth, refresh de tokens, Sheets, Calendar, Drive | — |

Esto es **idéntico** a cómo funciona TiendaNube hoy
([`runTiendanube()` en lib/tools.ts:273](../../dashboard-tilegra/lib/tools.ts)).

---

## 4. Scopes de OAuth

| Scope | Para qué |
|---|---|
| `https://www.googleapis.com/auth/spreadsheets` | Sheets lectura/escritura |
| `https://www.googleapis.com/auth/calendar.events` | Calendar lectura/escritura de eventos |
| `https://www.googleapis.com/auth/drive.file` | Crear sheets, buscar por nombre, leer Docs creados/abiertos por la app |
| `openid email profile` | Identificar la cuenta conectada (guardar `google_email`) |

Pedimos `access_type=offline` y `prompt=consent` para obtener **refresh_token**.

> **Limitación de `drive.file`:** solo da acceso a archivos que la app **creó** o que el
> usuario **abrió explícitamente** (vía Google Picker). No alcanza para leer un archivo
> arbitrario por URL. Para sheets que el agente crea, o uno conectado una vez, funciona.
> Si más adelante hace falta leer cualquier archivo del Drive del cliente, hay que subir
> a `drive.readonly` (implica verificación CASA de Google).

---

## 5. Modelo de datos — tabla `google_connections`

Una fila por `client_id` (igual que `tiendanube_connections`).

```sql
create table public.google_connections (
  id            bigint generated always as identity primary key,
  client_id     bigint not null unique,
  google_email  text,
  access_token  text not null,
  refresh_token text not null,
  scope         text,
  token_type    text default 'Bearer',
  expiry_date   timestamptz,          -- cuándo vence el access_token
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on public.google_connections (client_id);
```

> Los tokens son secretos: la tabla solo se accede desde el backend con el
> **service role key** (RLS no aplica a service role). No exponer a clientes.
> Opcional a futuro: cifrar `refresh_token` at-rest.

(Opcional, fase posterior) tabla `google_cache` análoga a `tiendanube_cache` para
cachear lecturas de Sheets con TTL si hubiera volumen.

---

## 6. Backend — archivos nuevos

Siguiendo la estructura existente (`src/routes`, `src/services`, `src/lib`):

| Archivo | Rol |
|---|---|
| `src/routes/google-oauth.route.ts` | OAuth `connect`/`callback`, **público**, seguridad por `state` firmado |
| `src/routes/google.route.ts` | Endpoints REST autenticados bajo `/api/google/*` |
| `src/services/google-api.service.ts` | Cliente OAuth2 (`googleapis`), build de clients autorizados, refresh + persistencia de tokens |
| `src/services/google.service.ts` | Capa DB: `getConnection`, `saveConnection`, `updateTokens` |
| `src/services/google-sheets.service.ts` | `readRange`, `append`, `update`, `create`, `findByName` |
| `src/services/google-calendar.service.ts` | `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `freeBusy` |

### Dependencia nueva
```bash
pnpm add googleapis
```
El SDK oficial maneja el refresh de tokens y tipa todas las APIs.

### `google-api.service.ts` — núcleo de auth (boceto)

```ts
import { google } from 'googleapis';
import { googleService } from './google.service';

function oauthClient() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!id || !secret || !redirect) throw new Error('Google OAuth no configurado');
  return new google.auth.OAuth2(id, secret, redirect);
}

export const googleApiService = {
  // Usado en /oauth/connect
  authUrl(state: string): string {
    return oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: SCOPES,
      state,
    });
  },

  // Usado en /oauth/callback
  async exchangeCode(code: string) {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    return tokens; // access_token, refresh_token, expiry_date, scope
  },

  // Devuelve un OAuth2 client autorizado para un client_id; auto-refresca y
  // persiste tokens nuevos vía el evento 'tokens'.
  async authorizedClient(clientId: number) {
    const conn = await googleService.getConnection(clientId);
    if (!conn) throw new Error('GOOGLE_NOT_CONNECTED');
    const client = oauthClient();
    client.setCredentials({
      access_token: conn.access_token,
      refresh_token: conn.refresh_token,
      expiry_date: conn.expiry_date ? Date.parse(conn.expiry_date) : undefined,
    });
    client.on('tokens', (t) => {
      // refresh_token solo viene la primera vez; preservar el existente.
      void googleService.updateTokens(clientId, t);
    });
    return client;
  },
};
```

---

## 7. Flujo OAuth detallado

Mismo esquema que TiendaNube ([`oauth-state.ts`](../src/lib/oauth-state.ts) +
[`tiendanube-oauth.route.ts`](../src/routes/tiendanube-oauth.route.ts)):

1. **Dashboard** (sesión autenticada) firma el `client_id` con `signState(clientId)`
   (HMAC con `INTERNAL_API_KEY`, validez 10 min) y manda al navegador a
   `{BACKEND}/api/google/oauth/connect?state=...`.
2. **`GET /api/google/oauth/connect`** (público): `verifyState(state)` → si es válido,
   re-firma el state (refresca `ts`) y redirige a `googleApiService.authUrl(state)`
   (consent screen de Google).
3. El cliente acepta en Google → Google redirige a
   **`GET /api/google/oauth/callback?code=&state=`** (público).
4. El callback: `verifyState(state)` → `exchangeCode(code)` → obtiene metadata de la
   cuenta (`google_email` vía `oauth2.userinfo`) → `googleService.saveConnection(...)`
   (upsert `onConflict: client_id`) → redirige a
   `{DASHBOARD_URL}/dashboard/integrations?google=connected` (o `=error`).

> Importante: el `redirect_uri` registrado en Google Cloud debe ser **exactamente**
> `{GOOGLE_OAUTH_REDIRECT_URI}` = `{PUBLIC_URL}/api/google/oauth/callback`.

---

## 8. Estrategia de refresh de tokens

- El `access_token` dura ~1h; el `refresh_token` es de larga vida (lo guardamos en DB).
- Con `googleapis`, al setear credenciales con `refresh_token` el cliente **refresca
  solo** cuando el access_token está vencido, y emite el evento `'tokens'`.
- En ese evento persistimos el nuevo `access_token` + `expiry_date` (y `refresh_token`
  si vino) con `googleService.updateTokens()`.
- Si el refresh falla con `invalid_grant` (cliente revocó el acceso), marcamos la
  conexión como inválida y devolvemos un error claro al agente
  (`"La cuenta de Google se desconectó, hay que reconectarla"`).

---

## 9. Endpoints REST del backend

Todos bajo `/api/google/*`, con `internalTokenAuth` (Bearer `INTERNAL_API_KEY`),
salvo los de OAuth que son públicos. `client_id` siempre como query param.

### OAuth (públicos)
| Método | Path | Descripción |
|---|---|---|
| GET | `/api/google/oauth/connect?state=` | Redirige al consent de Google |
| GET | `/api/google/oauth/callback?code=&state=` | Intercambia code, guarda conexión, vuelve al dashboard |

### Estado
| Método | Path | Descripción |
|---|---|---|
| GET | `/api/google/status?client_id=` | `{ connected: bool, google_email, scopes }` |
| DELETE | `/api/google/connection?client_id=` | Desconectar (borra fila + revoca token) |

### Sheets
| Método | Path | Descripción |
|---|---|---|
| GET | `/api/google/sheets/read?client_id=&spreadsheet_id=&range=` | Lee un rango (o pestaña entera) |
| POST | `/api/google/sheets/append` | Agrega fila(s) al final |
| POST | `/api/google/sheets/update` | Actualiza celdas de un rango |
| POST | `/api/google/sheets/create` | Crea un spreadsheet nuevo |
| GET | `/api/google/sheets/find?client_id=&name=` | Busca un sheet por nombre (vía Drive) |

### Calendar
| Método | Path | Descripción |
|---|---|---|
| GET | `/api/google/calendar/events?client_id=&time_min=&time_max=` | Lista eventos en un rango |
| POST | `/api/google/calendar/events` | Crea un evento |
| PATCH | `/api/google/calendar/events/:id?client_id=` | Modifica un evento |
| DELETE | `/api/google/calendar/events/:id?client_id=` | Borra un evento |
| GET | `/api/google/calendar/freebusy?client_id=&time_min=&time_max=` | Disponibilidad |

Todas las rutas validan con Zod (`fastify-type-provider-zod`), como el resto del backend.

---

## 10. Contrato de la tool (lo que ve el agente)

Igual que TiendaNube: **cada tool es de acción única**. El agente manda `input` en
texto/JSON y el dashboard lo interpreta. Tipos de tool nuevos:

### `google_sheet` (upgrade del actual)
Config:
```jsonc
{
  "spreadsheet_id": "1AbC...",   // o sheet_url, se extrae el id
  "sheet_name": "Hoja 1",
  "actions": ["read_rows"]        // read_rows | append_row | update_cells | create_sheet
}
```

### `google_calendar` (nuevo)
Config:
```jsonc
{
  "calendar_id": "primary",
  "timezone": "America/Argentina/Buenos_Aires",
  "actions": ["list_events"]      // list_events | create_event | update_event | delete_event | check_availability
}
```

El dispatcher valida que la `action` esté habilitada (igual que `runTiendanube`
chequea `config.actions`).

---

## 11. Cambios en el dashboard (`dashboard-tilegra`)

| Archivo | Cambio |
|---|---|
| [`lib/definitions.ts`](../../dashboard-tilegra/lib/definitions.ts) | Tipos `GoogleSheetConfig` (ampliado) y `GoogleCalendarConfig`; agregar `google_calendar` a `AgentToolType` |
| [`lib/tools.ts`](../../dashboard-tilegra/lib/tools.ts) | `runGoogleSheet` ahora **forwardea al backend** (como `runTiendanube`); nuevo `runGoogleCalendar`; ambos cases en `runTool()` resolviendo `client_id` |
| `components/workflows/tool-form-dialog.tsx` | Habilitar acciones de escritura de Sheets + form de Calendar |
| Pantalla de integraciones | Botón **"Conectar Google"** → abre `{BACKEND}/api/google/oauth/connect?state=signState(clientId)` |
| `lib/n8n.ts` (`syncAgentTools`) | Sin cambios estructurales: las nuevas tools usan el mismo `toolHttpRequest` genérico |

### Back-compat
El `google_sheet` con sheet **público** (modo `gviz` actual) puede seguir funcionando
como fallback cuando **no hay** `google_connections` para ese cliente. Así no rompemos
las tools existentes. Plan: detectar conexión → si existe, usar backend OAuth; si no,
fallback a CSV público (con deprecation warning).

---

## 12. Variables de entorno nuevas (backend)

```bash
# Google OAuth (de Google Cloud Console)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=${PUBLIC_URL}/api/google/oauth/callback

# Opcional
GOOGLE_CACHE_TTL_MINUTES=60   # solo si agregamos google_cache
```

En el dashboard ya existen `BACKEND_PUBLIC_URL` e `INTERNAL_API_KEY` (los usa TiendaNube).

---

## 13. Setup en Google Cloud Console (lo hace el usuario)

1. Crear/seleccionar un proyecto en <https://console.cloud.google.com>.
2. **APIs & Services → Enabled APIs** → habilitar: **Google Sheets API**,
   **Google Calendar API**, **Google Drive API**.
3. **OAuth consent screen**: tipo *External*, completar app name, support email,
   logo, dominios autorizados. Agregar los scopes de la sección 4.
   - Mientras esté en *Testing* solo funciona con usuarios de prueba agregados a mano.
   - Para producción hay que **publicar** la app (Google revisa los scopes; `drive.file`
     y `calendar.events` no son "restricted", así que la revisión es liviana).
4. **Credentials → Create Credentials → OAuth client ID → Web application**:
   - Authorized redirect URI: `{PUBLIC_URL}/api/google/oauth/callback`
   - Copiar **Client ID** y **Client Secret** → a las env del backend.

---

## 14. Plan de implementación por fases

### Fase 1 — Infra OAuth + Sheets RW
- [ ] Crear tabla `google_connections` en Supabase
- [ ] `pnpm add googleapis`
- [ ] Env nuevas + setup en Google Cloud Console
- [ ] `src/services/google.service.ts` (get/save/updateTokens)
- [ ] `src/services/google-api.service.ts` (OAuth client, authUrl, exchangeCode, authorizedClient)
- [ ] `src/routes/google-oauth.route.ts` (connect/callback) + registrar como ruta pública
- [ ] `src/services/google-sheets.service.ts` (read/append/update/create)
- [ ] `src/routes/google.route.ts` (status + sheets endpoints) + registrar en scope autenticado
- [ ] Dashboard: botón "Conectar Google" + `runGoogleSheet` forward al backend
- [ ] Probar end-to-end: conectar cuenta → tool lee y escribe un sheet privado

### Fase 2 — Calendar RW
- [ ] `src/services/google-calendar.service.ts`
- [ ] Endpoints de calendar en `google.route.ts`
- [ ] Dashboard: tipo `google_calendar` + form + `runGoogleCalendar`
- [ ] Probar: agente crea/lee eventos en el calendario del cliente

### Fase 3 — Bonus (Drive + Docs)
- [ ] `findByName` / `create` de Sheets vía Drive
- [ ] Leer Docs vía `Drive.files.export` (text/plain)
- [ ] (Evaluar) push notifications de Drive reusando el patrón de webhooks

---

## 15. Riesgos y consideraciones

- **`drive.file` limita** qué archivos se ven (solo creados/abiertos por la app).
  Si el caso de uso requiere leer cualquier sheet/doc del Drive del cliente, subir a
  `drive.readonly` (revisión CASA de Google, más costosa).
- **Verificación de Google**: con la app en *Testing* solo andan usuarios de prueba.
  Para clientes reales hay que publicar la app. Planificar tiempos.
- **Revocación de tokens**: el cliente puede revocar desde su cuenta Google → manejar
  `invalid_grant` y pedir reconexión.
- **Rate limits** de las APIs de Google (cuotas por proyecto). Considerar caché
  read-through para lecturas frecuentes (tabla `google_cache`).
- **Seguridad de tokens**: viven en `google_connections`, accesible solo con service
  role. Evaluar cifrado at-rest del `refresh_token`.
- **Multi-cuenta por cliente**: el diseño asume **una** cuenta de Google por `client_id`
  (unique). Si un cliente necesitara varias, habría que cambiar la PK por
  `(client_id, google_email)` y que la tool indique cuál usar.

---

## 16. Referencias en el código (patrón a copiar)

- OAuth state firmado: [`src/lib/oauth-state.ts`](../src/lib/oauth-state.ts)
- Rutas OAuth: [`src/routes/tiendanube-oauth.route.ts`](../src/routes/tiendanube-oauth.route.ts)
- Servicio conexión + caché: [`src/services/tiendanube.service.ts`](../src/services/tiendanube.service.ts)
- Cliente API de bajo nivel: [`src/services/tiendanube-api.service.ts`](../src/services/tiendanube-api.service.ts)
- Registro de rutas (público vs autenticado): [`src/routes/index.ts`](../src/routes/index.ts)
- Cliente Supabase: [`src/lib/supabase.ts`](../src/lib/supabase.ts)
- Forward desde el dashboard: [`lib/tools.ts` → `runTiendanube`](../../dashboard-tilegra/lib/tools.ts)
- Dispatcher de tools: [`lib/tools.ts` → `runTool`](../../dashboard-tilegra/lib/tools.ts)
```
