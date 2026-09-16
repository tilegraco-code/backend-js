# Documentos recibidos y casos

Plan de implementación.

**Estado (2026-09-16):** rama `feature/documentos-y-casos` en `backend-js` y `agente-tilegra`.

- **Fase 1 (spike Composio): HECHA.** Ver "Drive y Sheets" más abajo: se sube con
  `GOOGLEDRIVE_UPLOAD_FROM_URL` y una sola conexión (`googledrive`) cubre también el Sheet.
- **Fase 2 (registro para todos): CÓDIGO HECHO, SIN PROBAR DE PUNTA A PUNTA.** Typecheck de
  backend-js y tests de agente-tilegra (54) en verde. Migración `chat_documents.sql` aplicada en el
  proyecto Dashboard y `claim_chat_documents` verificada (claim atómico, segundo claim vacío). Pendientes de la fase: registrar los adjuntos del widget (hoy llegan a `run-turn` ya
  firmados, sin `path`) y usar el render de PDFs escaneados también en el turno
  (`app/attachments.py`), no solo en `/documents/process`.
- **Fase 3 (casos): CÓDIGO HECHO, SIN PROBAR DE PUNTA A PUNTA.** Migración `chat_cases.sql`
  aplicada; numeración y "un caso activo por chat" verificados en la base. 24 tests en
  backend-js y 70 en agente-tilegra. Hay un seed con la configuración de la aseguradora en
  `db/seeds/aseguradora-casos.sql`. Ver "Implementación de la fase 3".
- **Fase 4 (sync a Drive y Sheets): CÓDIGO HECHO, SIN PROBAR CONTRA GOOGLE.** Migración
  `chat_cases_sync.sql` aplicada. 31 tests en backend-js (incluye nombres, columnas y filas del
  Sheet). Ver "Implementación de la fase 4".
- Fases 5 a 7: sin empezar.

Primer cliente: una aseguradora de autos que necesita que el agente tome reclamos, pida la
documentación según el tipo de siniestro, valide lo que llega, lo suba a una carpeta de Drive y
lleve un Google Sheet al día.

## Contexto

El soporte de imágenes y documentos ([imagenes-y-documentos-plan.md](imagenes-y-documentos-plan.md))
ya resuelve que el agente **vea** lo que manda el cliente. Pero lo ve durante un turno y nada
más: no queda registro de qué documentos llegaron, qué son, qué datos tienen ni si sirven. La
imagen se poda del historial y lo único que sobrevive es una descripción en texto.

Para un flujo de reclamos eso no alcanza. Hace falta:

1. Saber, en cualquier momento de la conversación, qué documentos mandó el cliente y qué son.
2. Validarlos: que sean lo que se pidió, que se lean, que los datos cierren entre sí.
3. Saber qué falta, según el tipo de caso.
4. Sacarlos del chat hacia donde trabaja el cliente (Drive, Sheets).

Lo primero sirve para cualquier agente. Lo demás es para los que trabajan por casos. El diseño
los separa en esas dos capas.

---

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Registro de documentos | Tabla `chat_documents`, una fila por archivo recibido, **para todos los agentes** |
| Casos | Tabla `chat_cases`, **opt-in** por agente |
| Qué pide cada caso | Tipos de caso configurables por agente (`agent_case_types`), con requisitos condicionales |
| Quién registra y sube | **El código, nunca el modelo.** El modelo clasifica el caso y conversa; el pipeline es determinístico |
| Cola de trabajo | La misma tabla (`status` + `FOR UPDATE SKIP LOCKED`). Sin Redis: backend-js corre una sola instancia |
| Qué falta | Se **calcula** (función pura sobre requisitos + datos + documentos), nunca se guarda a mano |
| Drive y Sheets | Composio, toolkit `googledrive` (incluye las tools de Sheets), sin OAuth nuevo |
| Fuente de verdad | Supabase. El Sheet es una **salida**, no se lee para decidir nada |
| Nombre | `chat_documents` y no `runtime_documents` ni `documents`: `documents` ya es la base de conocimiento (`document_chunks`, `match_documents`) y "runtime" es el nombre de un servicio, no del dato |

---

## La división de responsabilidades

Se mantiene la del plan de imágenes y se le suma la orquestación.

| Capa | Qué hace | Qué NO hace |
|---|---|---|
| **backend-js** | Crea la fila al ingerir, corre la cola, evalúa requisitos, asigna números, sincroniza con Drive y Sheets, expone la API de casos | No interpreta archivos. No llama a un modelo |
| **agente-tilegra** | `/documents/process`: clasifica, extrae datos y valida legibilidad. Tools del agente que leen y escriben casos a través de backend-js | No toca Supabase directo para casos. No sube a Drive |
| **dashboard-tilegra** | Editor de tipos de caso y catálogo de documentos. Vista de casos y documentos por chat | No evalúa requisitos |

Consecuencia importante: el evaluador de requisitos existe **una sola vez**, en backend-js. Las
tools del runtime que escriben un caso pegan a backend-js y reciben la evaluación recalculada en
la misma respuesta, así el modelo contesta con el estado real y no con uno que dedujo.

---

## Modelo de datos

Migración: `db/migrations/chat_documents_and_cases.sql`. Acá las tablas se presentan en orden de
lectura; en la migración `chat_cases` va antes que `chat_documents` por la foreign key.

### `chat_documents`

```sql
create table public.chat_documents (
  id              bigint generated always as identity primary key,
  client_id       bigint not null,
  agent_id        bigint,
  chat_id         text   not null,
  message_id      text   not null,
  idx             smallint not null,           -- posición del adjunto en el mensaje

  storage_path    text   not null,             -- bucket chat-attachments
  kind            text   not null,             -- image | document | audio | video | other
  mime            text   not null,
  name            text,
  size            integer,
  sha256          text   not null,

  -- Resultado del procesamiento
  doc_type        text,                        -- key del catálogo del agente, 'otro' o null
  confidence      real,
  summary         text,                        -- descripción literal / texto relevante
  extracted       jsonb,                       -- { patente: "AB123CD", vencimiento: "2027-03-01" }
  legible         boolean,
  issues          jsonb,                       -- ["reflejo sobre el número de documento"]

  -- Cola
  status          text not null default 'pending',  -- pending | processing | ready | failed | skipped
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  last_error      text,

  -- Caso y destino externo
  case_id         bigint references public.chat_cases(id) on delete set null,
  sync_status     text not null default 'none',     -- none | pending | synced | failed
  external_ref    jsonb,                             -- { drive_file_id, drive_url }

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (message_id, idx)
);

create index chat_documents_chat_idx  on public.chat_documents (chat_id, created_at);
create index chat_documents_queue_idx on public.chat_documents (next_attempt_at)
  where status in ('pending', 'failed') ;
create index chat_documents_sync_idx  on public.chat_documents (case_id)
  where sync_status = 'pending';
```

- `unique (message_id, idx)`: el mismo webhook dos veces no duplica. La ingesta hace
  `insert ... on conflict do nothing`.
- `sha256`: si el cliente reenvía la misma foto, se marca `skipped` apuntando a la original en
  vez de procesarla y subirla dos veces.
- `status = 'failed'` con `attempts < MAX` sigue en la cola; con `attempts >= MAX` queda a la
  vista del dashboard y no se reintenta más.
- Audio y video entran igual (`status = 'skipped'` para el procesamiento) porque **sí** tienen
  que subirse a Drive si pertenecen a un caso: un video del daño es evidencia aunque no se
  analice.

### `chat_cases`

```sql
create table public.chat_cases (
  id            bigint generated always as identity primary key,
  client_id     bigint not null,
  agent_id      bigint not null,
  chat_id       text   not null,
  number        text   not null,              -- "SIN-2026-000123"
  case_type     text   not null,              -- key de agent_case_types
  status        text   not null default 'open', -- open | complete | closed | cancelled
  data          jsonb  not null default '{}',
  requirements  jsonb  not null,              -- snapshot de la definición del tipo al abrir
  evaluation    jsonb,                        -- último resultado del evaluador
  sync_status   text   not null default 'pending',
  external_ref  jsonb,                        -- { drive_folder_id, drive_folder_url }
  opened_at     timestamptz not null default now(),
  completed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  unique (client_id, number)
);

-- Un solo caso abierto por chat. Si el cliente quiere reclamar otra cosa, se cierra o
-- cancela el anterior. Evita que un documento no sepa a qué caso pertenece.
create unique index chat_cases_one_open_per_chat
  on public.chat_cases (chat_id) where status = 'open';
```

`requirements` es una **copia** de la definición del tipo al momento de abrir. Si la aseguradora
cambia el checklist, los casos abiertos terminan con las reglas con las que empezaron.

### Numeración

```sql
create table public.case_counters (
  client_id   bigint primary key,
  last_number bigint not null default 0
);

create function public.next_case_number(p_client_id bigint) returns bigint
language sql as $$
  insert into public.case_counters (client_id, last_number) values (p_client_id, 1)
  on conflict (client_id) do update set last_number = case_counters.last_number + 1
  returning last_number;
$$;
```

Atómico y sin huecos por concurrencia. El formato (`SIN-2026-000123`) lo arma backend-js con el
prefijo de `agent_case_settings`. Nunca lo genera el modelo.

### Configuración por agente

```sql
create table public.agent_case_settings (
  agent_id          bigint primary key,
  enabled           boolean not null default false,
  number_prefix     text    not null default 'CASO',
  drive_parent_id   text,          -- carpeta raíz en el Drive del cliente; null = no sincroniza Drive
  sheet_id          text,          -- null = no sincroniza Sheets
  sheet_tab         text,
  sheet_columns     jsonb,         -- [{ header: "Patente", source: "data.patente" }, ...]
  updated_at        timestamptz not null default now()
);

create table public.agent_document_types (
  id          bigint generated always as identity primary key,
  agent_id    bigint not null,
  key         text   not null,     -- "licencia"
  label       text   not null,     -- "Licencia de conducir"
  description text   not null,     -- para clasificar: "Carnet de conducir argentino, frente o dorso"
  fields      jsonb  not null default '[]',  -- [{ key: "vencimiento", type: "date", label: "..." }]
  unique (agent_id, key)
);

create table public.agent_case_types (
  id          bigint generated always as identity primary key,
  agent_id    bigint not null,
  key         text   not null,
  label       text   not null,
  description text   not null,     -- para que el modelo elija el tipo
  definition  jsonb  not null,     -- data + documents, ver abajo
  active      boolean not null default true,
  position    smallint not null default 0,
  unique (agent_id, key)
);
```

El **catálogo de documentos** va aparte de los tipos de caso porque un mismo documento (DNI,
cédula) aparece en varios casos, y porque así se puede clasificar un documento **antes** de que
exista el caso.

### RLS

Las cinco tablas: escritura solo con service role. Lectura desde el dashboard por `client_id`
del usuario, igual que `unipile_messages`. Son datos personales (DNI, licencias): no se exponen
por ningún endpoint público.

---

## Definición de un tipo de caso

`agent_case_types.definition`:

```json
{
  "data": [
    { "key": "patente",         "label": "Patente",             "type": "string", "required": true },
    { "key": "fecha_siniestro", "label": "Fecha del siniestro", "type": "date",   "required": true },
    { "key": "alcance",         "label": "Alcance del robo",    "type": "enum",
      "options": ["total", "parcial"], "required": true }
  ],
  "documents": [
    { "type": "denuncia_policial", "min": 1,
      "checks": [{ "field": "patente", "op": "equals", "value": "data.patente" }] },
    { "type": "dni",           "min": 2, "hint": "Frente y dorso" },
    { "type": "cedula_verde",  "min": 1,
      "checks": [{ "field": "patente", "op": "equals", "value": "data.patente" }] },
    { "type": "titulo",        "min": 1, "when": [{ "field": "data.alcance", "op": "equals", "value": "total" }] },
    { "type": "foto_faltante", "min": 1, "when": [{ "field": "data.alcance", "op": "equals", "value": "parcial" }] },
    { "type": "licencia",      "min": 1,
      "checks": [{ "field": "vencimiento", "op": "after", "value": "data.fecha_siniestro" }] }
  ]
}
```

### Operadores

Un set **cerrado**. Nada de expresiones libres: una configuración no puede romper el evaluador y
cada falla se puede explicar en una frase.

| Operador | Uso | Ejemplo de falla que se le dice al cliente |
|---|---|---|
| `equals` | Igualdad normalizada (mayúsculas, sin espacios ni guiones) | "La patente de la cédula (AB123CD) no coincide con la que me pasaste (AC123CD)" |
| `not_equals` | | |
| `after` / `before` | Fechas | "La licencia venció el 01/03/2026, antes del siniestro" |
| `exists` | El dato se pudo extraer | "No se llega a leer el número de documento" |
| `in` | Contra una lista | |

`when` usa los mismos operadores y es un AND de condiciones. Si un cliente necesita OR, se
resuelve con dos entradas de documento. Si eso se vuelve frecuente, se agrega `any` más adelante.

`value` puede ser literal o una referencia (`data.x`). Si la referencia todavía no tiene valor,
el check queda **pendiente**, no fallido: no se le dice al cliente que algo no coincide contra un
dato que todavía no dio.

### Validación del esquema

Un solo esquema, escrito en Zod en backend-js (`src/schemas/case-definition.ts`) y exportado a
JSON Schema. El dashboard lo usa para validar antes de guardar. El runtime no necesita validarlo
porque nunca lee la definición directo: la recibe ya evaluada desde backend-js.

---

## El evaluador

`src/services/case-evaluator.ts`. **Función pura**, sin I/O, con tests unitarios exhaustivos.

```ts
evaluateCase(requirements, data, documents): CaseEvaluation
```

1. **Datos:** qué `data` requeridos faltan o tienen un tipo inválido.
2. **Condiciones:** filtra `documents` por `when` usando `data` actual.
3. **Conteo:** para cada requisito vigente, cuenta los `chat_documents` del caso con ese
   `doc_type`, `status = 'ready'` y `legible = true`. Los ilegibles cuentan aparte, para poder
   decir "llegó pero no se lee".
4. **Checks:** corre cada check contra cada documento de ese tipo. Alcanza con que uno pase.
5. **Pendientes:** documentos del caso todavía en `pending` o `processing`.

```json
{
  "complete": false,
  "missing_data": [{ "key": "alcance", "label": "Alcance del robo" }],
  "missing_documents": [{ "type": "dni", "label": "DNI del titular", "hint": "Frente y dorso", "have": 1, "need": 2 }],
  "illegible": [{ "document_id": 812, "type": "licencia", "issues": ["foto movida"] }],
  "failed_checks": [{ "document_id": 815, "type": "cedula_verde", "message": "La patente de la cédula (AB123CD) no coincide con la declarada (AC123CD)" }],
  "processing": 1
}
```

`complete = true` solo si no hay nada faltante, ilegible, fallido **ni en proceso**.

Se recalcula y persiste en `chat_cases.evaluation` cada vez que cambia algo: al abrir, al
actualizar datos, cuando un documento del caso pasa a `ready`. Al pasar a `complete` se guarda
`completed_at` y se marca `sync_status = 'pending'`.

---

## El pipeline

```
Webhook (Unipile / Evolution / ML / widget)
  └─ ingestAttachments()                          ← ya existe
       └─ insert chat_documents (pending)         ← NUEVO, on conflict do nothing
            ├─ si el chat tiene caso abierto → case_id
            └─ si el agente tiene casos habilitados → procesar INLINE con timeout
                 └─ lo que no termine queda pending → worker
  └─ dispatch del turno (/invoke)                 ← ya existe

Job documents-process (cada 10 s)
  └─ toma hasta N pending/failed vencidos con FOR UPDATE SKIP LOCKED
       └─ POST agente-tilegra /documents/process
            ├─ ok    → ready + extracted, re-evalúa el caso si tiene
            └─ error → failed, attempts++, next_attempt_at con backoff

Job cases-sync (cada 30 s)
  └─ casos con sync_status = pending
       ├─ crea la carpeta si no existe
       ├─ sube documentos del caso con sync_status = pending
       └─ escribe la fila del Sheet
```

### Procesamiento inline vs worker

Para agentes **con** casos habilitados, la ingesta procesa inline con un tope de tiempo
(`PROCESS_INLINE_TIMEOUT_MS`, arranca en 12 s) antes de despachar el turno. Así, en el caso
normal, el agente ya contesta sabiendo si la licencia sirve o no. Si se pasa del tope, el turno
sale igual y el worker termina el trabajo.

Para agentes **sin** casos no se espera: el turno sale como hoy y el procesamiento corre en el
worker. No tiene sentido sumarle latencia a un agente que no valida nada.

### Cuando el worker termina después del turno

Si el documento se procesó después de que el agente ya contestó y el resultado cambia algo
(ilegible, check fallido o caso completo), hay que avisarle al cliente sin esperar a que escriba.
Se dispara un **turno proactivo** con un mensaje de sistema ("el documento X se procesó: …"),
con el mismo mecanismo que usan los follow-ups (`unipile-follow-up.job.ts`). Si el resultado es
simplemente "ok", no se dispara nada.

Rate limit: como mucho un turno proactivo por chat cada 60 s, agrupando los resultados. Un
cliente que manda cinco fotos no recibe cinco mensajes.

### Backoff

`next_attempt_at = now() + 30s * 2^attempts`, tope en 5 intentos. Errores que no vale la pena
reintentar (archivo corrupto, mime no soportado) van directo a `failed` con `attempts = MAX`.

`locked_at` + limpieza de filas `processing` con `locked_at` de más de 5 minutos: si el proceso
muere a mitad, la fila vuelve a la cola.

---

## agente-tilegra

### `POST /documents/process`

Entrada:

```json
{
  "document_id": 812,
  "url": "<firmada>",
  "kind": "image",
  "mime": "image/jpeg",
  "name": null,
  "catalog": [
    { "key": "licencia", "label": "Licencia de conducir", "description": "...",
      "fields": [{ "key": "vencimiento", "type": "date" }, { "key": "nombre", "type": "string" }] }
  ],
  "expected": ["licencia", "dni", "cedula_verde"]
}
```

Salida (structured output, Pydantic):

```json
{
  "doc_type": "licencia",
  "confidence": 0.93,
  "legible": true,
  "issues": [],
  "extracted": { "vencimiento": "2027-03-01", "nombre": "JUAN PÉREZ" },
  "summary": "Licencia de conducir de la Ciudad de Buenos Aires, clase B1, a nombre de ..."
}
```

- `doc_type` es un enum armado al vuelo con las keys del catálogo + `otro`. El modelo no puede
  devolver un tipo inexistente.
- `expected` no restringe, orienta: si el caso espera una licencia y llega un DNI, se clasifica
  como DNI.
- Sin catálogo (agentes sin casos): no hay `doc_type` ni `extracted`, solo `summary` y `legible`.
  Es lo que alimenta la tool de consulta para todos los agentes.
- Confianza baja (`< 0.6`) → `doc_type = 'otro'` y un issue "no se pudo identificar el
  documento". Mejor pedirlo de nuevo que contar un documento equivocado.
- Imágenes con `detail: "high"`. Un DNI o una licencia no se leen en `low`.
- Fechas normalizadas a ISO en la salida. Patentes y documentos sin espacios ni guiones.

### PDFs escaneados

Hoy `_pdf_text` devuelve vacío y el agente dice que no pudo leerlo. En este rubro es el caso
más común. Si el texto extraído está vacío o es casi vacío, se renderizan las primeras páginas a
imagen (`pypdfium2`, hasta 3 páginas) y van por visión. Se aprovecha también en
`attachments.py` para el turno normal.

### Tools del agente

Las tools reciben el `chat_id` desde `RunnableConfig` (`configurable.thread_id`), no como
argumento del modelo. El modelo no puede consultar ni escribir el caso de otro chat.

| Tool | Cuándo se adjunta | Qué hace |
|---|---|---|
| `documentos_del_chat(tipo?)` | **Siempre** | `GET backend-js /api/chats/:chat_id/documents`. Lista tipo, resumen, datos, problemas y estado. Si hay caso abierto, incluye número, datos y evaluación |
| `abrir_caso(tipo, datos?)` | `agent_case_settings.enabled` | `POST /api/cases`. `tipo` es enum de los tipos activos. Asigna número, asocia los documentos previos del chat, devuelve la evaluación |
| `actualizar_datos_caso(datos)` | idem | `PATCH /api/cases/:id`. Valida contra `definition.data`, re-evalúa, devuelve la evaluación |
| `cambiar_tipo_caso(tipo)` | idem | Re-snapshot de requisitos, re-evalúa. Los documentos ya recibidos siguen contando si coinciden |

**Por qué `documentos_del_chat` va siempre y no solo cuando hay documentos:** el agente se
construye y cachea por `agent_id` (`get_agent` en `graph.py`), no por chat. Adjuntarla
condicionalmente obligaría a cachear dos variantes por agente. El schema de la tool es chico y
queda dentro del prefijo estático cacheado, así que el costo por turno es marginal.

Descripciones con reglas explícitas en el prompt de la tool:

- Nunca decir que un documento está bien si su estado es `processing`: decir que se está revisando.
- Nunca inventar un número de caso: solo el que devuelve `abrir_caso`.
- Pedir lo que falta usando `label` y `hint`, no las keys.

---

## backend-js

### Rutas (scope protegido, `internalTokenAuth`)

| Ruta | Uso |
|---|---|
| `GET  /api/chats/:chatId/documents` | Tool `documentos_del_chat` y bandeja del dashboard |
| `POST /api/cases` | `{ agent_id, chat_id, case_type, data? }` |
| `PATCH /api/cases/:id` | `{ data?, case_type?, status? }` |
| `GET  /api/cases/:id` | Dashboard |
| `POST /api/documents/:id/retry` | Dashboard, para un `failed` definitivo |

Todas validan que `chat_id` / `case_id` pertenezcan al `client_id` del agente.

### Servicios

- `chat-documents.service.ts`: insert desde la ingesta, claim de la cola, transición de estados.
- `case-evaluator.ts`: la función pura.
- `cases.service.ts`: abrir (número + snapshot + asociación de documentos previos), actualizar,
  re-evaluar, marcar para sync.
- `case-sync.service.ts`: Drive y Sheets vía `composioService.execute`.

### Jobs

`documents-process.job.ts` y `cases-sync.job.ts`, registrados en `src/jobs/index.ts`. Respetan
`DISABLE_JOBS`.

### Punto de enganche en la ingesta

`ingestAttachments()` ya devuelve los `StoredAttachment` con su `path`. Los tres webhooks
(`unipile-webhook`, `evolution-webhook`, `mercadolibre-webhook`) y la ruta del widget llaman a
`chatDocumentsService.register(...)` con ese resultado. Se hace en un solo lugar dentro de
`ingestAttachments` para que ningún canal pueda olvidarse. Calcular el `sha256` ahí es gratis:
los bytes ya están en memoria.

---

## Drive y Sheets

### Resultado del spike (fase 1)

Slugs y schemas verificados contra la API de Composio el 2026-09-16:

| Necesidad | Tool | Nota |
|---|---|---|
| Crear carpeta | `GOOGLEDRIVE_CREATE_FOLDER` (`name`, `parent_id`) | Drive permite nombres duplicados: guardar y reusar el id |
| Subir archivo | `GOOGLEDRIVE_UPLOAD_FROM_URL` (`name`, `source_url`, `parent_folder_id`, `mime_type`) | Composio baja la URL del lado de ellos. Sin staging y sin el tope de 5 MB |
| Buscar en carpeta | `GOOGLEDRIVE_FIND_FILE` (`folder_id`, `q`) | Para la idempotencia en reintentos |
| Leer el Sheet | `GOOGLEDRIVE_READ_SPREADSHEET_VALUES` | Del toolkit `googledrive`: no hace falta conectar `googlesheets` |
| Escribir el Sheet | `GOOGLEDRIVE_WRITE_SPREADSHEET_VALUES` | Idem |

Descartadas:
- `GOOGLEDRIVE_UPLOAD_FILE`: tope de **5 MB** (el nuestro es 20 MB) y si el `folder_to_upload_to`
  es inválido sube a la raíz **sin error**.
- `GOOGLESHEETS_UPSERT_ROWS`: hace justo el upsert por columna clave, pero exige conectar un segundo
  toolkit. La upsert propia son dos llamadas (leer la columna del número, escribir la fila).

SDK de TypeScript (`@composio/core` 0.13.1): los campos `file_uploadable` aceptan URL o `File` solo
con `dangerouslyAllowAutoUploadDownloadFiles`; si no, hay que stagear con `composio.files.upload()`.
Con `UPLOAD_FROM_URL` no se necesita ninguna de las dos cosas. Si alguna vez hace falta, el camino
es `files.upload({ file: new File([bytes], nombre) })`, no prender la subida automática.

**Conclusión: el sync vive en backend-js.**

### Drive

- **Carpeta:** `"<número> - <apellido o nombre>"` dentro de `drive_parent_id`. Se crea en el
  primer sync del caso y se guarda en `external_ref.drive_folder_id`.
- **Archivos:** `"<doc_type>_<n>.<ext>"` (`licencia_1.jpg`, `dni_2.jpg`). Los `otro` van como
  `otro_<n>`: también se suben, el liquidador decide.
- **Idempotencia:** antes de subir, si el documento ya tiene `drive_file_id` se saltea. Si el
  proceso murió entre subir y guardar el id, se busca por nombre en la carpeta antes de subir
  de nuevo. Es una llamada extra solo en el reintento.
- **Subida:** `GOOGLEDRIVE_UPLOAD_FROM_URL` con una URL firmada generada en el momento del sync.
- **A verificar con una cuenta real:** qué hace `UPLOAD_FROM_URL` si `parent_folder_id` es
  inválido. Si cae a la raíz en silencio como `UPLOAD_FILE`, validar la carpeta antes.

### Sheets

- Una fila por caso. Columnas definidas en `agent_case_settings.sheet_columns`, con fuentes
  fijas: `number`, `case_type`, `status`, `opened_at`, `data.<campo>`, `missing` (texto de lo que
  falta), `drive_folder_url`.
- **La fila se encuentra por número de caso, no por índice.** Las personas ordenan, filtran e
  insertan filas en el Sheet; un índice guardado se rompe al primer uso. En cada sync se lee la
  columna del número, se busca la fila y se reescribe completa. Si no está, se agrega al final.
- El Sheet nunca se lee para tomar decisiones. Si alguien edita a mano una celda, el próximo
  sync la pisa. Eso se documenta para el cliente.

### Conexión

Toolkit `googledrive` de Composio (cubre Drive y Sheets), conectado desde Integraciones con
`userId = client_id`. Si un agente tiene `drive_parent_id` o `sheet_id` configurado y la
conexión no está activa, el sync queda en `failed` con `last_error` legible y el dashboard lo
muestra. El agente sigue funcionando: la conversación y la validación no dependen del sync.

---

## dashboard-tilegra

1. **Configuración del agente → sección "Casos":**
   - Toggle de habilitación, prefijo de numeración.
   - Destino: elegir carpeta de Drive y Sheet (con las tools de listado de Composio) y mapear
     columnas.
   - Catálogo de documentos: lista editable (label, descripción, campos a extraer).
   - Tipos de caso: lista ordenable; por tipo, datos requeridos y documentos con cantidad,
     condiciones y checks en un formulario (selects de campo, operador, valor). No se edita JSON.
2. **Bandeja:** en el chat, panel lateral con el caso abierto (número, estado, lo que falta) y
   los documentos con su tipo y problemas. Botón de reintento para los `failed`.
3. **Plantilla "Aseguradora de autos"** en `/dashboard/templates`: catálogo (DNI, licencia,
   cédula verde, título, denuncia policial, fotos) y tipos (rotura de cristal, robo total, robo
   parcial, choque con terceros, choque sin terceros, granizo).

---

## Fases

1. **Spike de Composio — HECHA.** Slugs y decisión en "Resultado del spike".
2. **Registro para todos — CÓDIGO HECHO (ver Estado):** migración, `chat_documents`, enganche en `ingestAttachments`,
   `/documents/process` sin catálogo, job de procesamiento, `GET /api/chats/:id/documents`, tool
   `documentos_del_chat`, PDFs escaneados.
3. **Casos — CÓDIGO HECHO (ver Estado):** tablas de configuración, esquema Zod, evaluador con tests, `cases.service`, rutas,
   tools de escritura, procesamiento inline con timeout, clasificación con catálogo.
4. **Sync — CÓDIGO HECHO (ver Estado):** Drive y Sheets, job de sync, idempotencia.
5. **Turno proactivo** cuando el worker termina después del turno.
6. **Dashboard:** editor de casos, panel en la bandeja, plantilla.
7. **Piloto con la aseguradora:** cargar su configuración, probar con documentos reales de
   cada tipo de siniestro, medir costo por documento procesado.

Las fases 2 y 3 se pueden probar sin dashboard cargando la configuración a mano en la DB.

---

## Implementación de la fase 2

### backend-js

- `db/migrations/chat_documents.sql`: tabla, índices, RLS sin políticas (solo service role) y la
  función `claim_chat_documents(p_limit, p_max_attempts, p_stale_seconds)`. El claim marca
  `processing` e incrementa `attempts` en la misma transacción; una fila colgada que ya gastó sus
  intentos pasa a `failed` en vez de volver a la cola. **Sin FK a `unipile_chats` ni
  `unipile_messages`:** MercadoLibre ingiere antes de crear el chat y el chat de prueba del
  dashboard no tiene fila. `case_id` y `sync_status` se agregan en la migración de la fase 3.
- `src/services/chat-documents.service.ts`: `register` (idempotente por `message_id, idx`;
  duplicado por `sha256` en el mismo chat → `skipped` con `duplicate_of`; audio, video y otros →
  `skipped`; nunca lanza), `listForChat`, `processBatch` y `processOne` (backoff 30 s × 2^n,
  422 del runtime = permanente).
- `attachment-ingest.service.ts`: `ingestAttachments` registra cada adjunto después de subirlo.
  Cubre Unipile, Evolution y MercadoLibre sin tocar los canales.
- `src/jobs/chat-documents-process.job.ts`: cada 10 s (`CHAT_DOCUMENTS_CRON`), lotes de 5.
- `GET /api/chats/:chatId/documents?client_id=`: no expone el path ni campos de cola. Un `failed`
  con reintentos pendientes se informa como `processing`, así el agente no le pide al cliente que
  reenvíe algo que se va a procesar solo.

### agente-tilegra

- `app/documents.py` + `POST /documents/process`: imagen → visión en detalle alto con salida
  estructurada (`summary`, `legible`, `issues`); PDF con texto → el texto, sin modelo; PDF
  escaneado (menos de 80 caracteres) → hasta 3 páginas renderizadas con `pypdfium2` por visión;
  HEIC, audio, video o archivo roto → 422.
- `app/tools/documents.py`: `documentos_del_chat`, adjuntada a todos los agentes en
  `build_react_agent` (y por lo tanto a cada rama de un router). Sin argumentos: el chat sale de
  `thread_id` y el cliente de la config.
- Dependencias nuevas: `pypdfium2`, `pillow`.
- `tests/test_documents.py`.

### Para probarlo

1. ~~Aplicar `db/migrations/chat_documents.sql`~~ (hecho 2026-09-16).
2. Levantar los dos servicios con `AGENT_RUNTIME_URL` apuntando al runtime.
3. Mandar por WhatsApp una foto, un PDF con texto, un PDF escaneado y la misma foto otra vez.
4. Verificar en `chat_documents`: cuatro filas, la repetida en `skipped`, las demás en `ready`
   en menos de ~30 s. Preguntarle al agente "¿qué documentos te mandé?".
5. Medir el costo por imagen en detalle alto (no pasa por `agentuse`: mirarlo en el uso de OpenAI
   o en LangSmith).

---

## Implementación de la fase 3

Cambios respecto del diseño original, todos para no depender de que el modelo haga algo:

- **El estado del caso va en el contexto de CADA turno.** `runViaAgent` busca el caso activo del
  chat y lo manda en `context.case`; el runtime lo antepone al mensaje (`app/cases.py`). El agente
  ve qué falta, qué no se lee y qué no coincide sin tener que consultar. `documentos_del_chat`
  queda para ver el contenido de los archivos.
- **"Activo" es `open` o `complete`.** El índice único cubre los dos: un documento que llega
  después de completar el caso se asocia a él, y si no pasa la validación el caso vuelve a
  `open`.
- **Los documentos previos al caso se reclasifican.** Al abrir (y al cambiar de tipo) se asocian
  los documentos del chat y los ya procesados vuelven a la cola para clasificarse contra el
  catálogo del caso. Si un resultado llega después de ese cambio, no se guarda: se reencola
  (`requeueStale`).
- **Procesamiento inline solo con caso abierto.** Sin caso no hay nada que validar en el turno,
  así que no se suma latencia.

### backend-js

- `db/migrations/chat_cases.sql`: `agent_case_settings`, `agent_document_types`,
  `agent_case_types`, `case_counters` + `next_case_number()`, `chat_cases` y las columnas
  `case_id`, `sync_status`, `external_ref` en `chat_documents`.
- `src/schemas/case-definition.ts`: esquema Zod de la definición, el catálogo y el snapshot de
  requisitos.
- `src/services/case-evaluator.ts` (+ test): la función pura.
- `src/services/cases.service.ts` (+ test de `sanitizeData`): abrir, `updateData`, `changeType`,
  `cancel`, `reevaluate`, `getActive`, `listActiveTypes`. Normaliza los datos al guardar (fechas
  locales a ISO, enums a la opción exacta, "sí" a `true`, "1.250.000,50" a número).
- `src/routes/cases.route.ts`: `POST /api/cases`, `GET /api/cases/active`, `PATCH /api/cases/:id`
  (una operación por llamada). Un `CaseError` sale con su mensaje para que el agente lo explique.
- `runtime-config` devuelve `case_types` (vacío si el agente no tiene casos).
- `chat-documents.service.ts`: asocia al caso activo, clasifica con el catálogo copiado en el
  caso, reevalúa tras cada `ready` o falla, procesa inline con tope
  (`CHAT_DOCUMENTS_INLINE_TIMEOUT_MS`, 12 s).
- `pnpm test` (`tsx --test`, `node:test`).

### agente-tilegra

- `app/tools/cases.py`: `abrir_caso(tipo, datos?)`, `actualizar_datos_caso(datos)`,
  `cambiar_tipo_caso(tipo)`, `cancelar_caso(motivo)`. Solo si `case_types` no está vacío. `tipo`
  es un enum; chat, cliente y agente salen del turno y la config.
- `app/cases.py`: el texto del estado, compartido por el prompt y las tools.
- `app/documents.py`: con catálogo, salida estructurada armada al vuelo (`doc_type` enum + `otro`,
  `confidence`, `extracted` con los campos del catálogo). Confianza menor a 0.6 → `otro`. Se
  descartan los campos que no son del tipo elegido. Un PDF con texto se clasifica por texto.

### Para probarlo

1. Correr `db/seeds/aseguradora-casos.sql` con el `agent_id` del agente de prueba y refrescar el
   runtime (`POST /api/agents/:id/refresh-runtime`).
2. Escribirle "me robaron el auto" → tiene que abrir `robo_total` y pedir patente, fecha, lugar y
   los documentos, con el número `SIN-2026-000001`.
3. Mandar una foto de una cédula con otra patente → el turno siguiente tiene que decir que no
   coincide.
4. Mandar todo lo que falta → `chat_cases.status = complete` y el agente avisa.

---

## Implementación de la fase 4

- `db/migrations/chat_cases_sync.sql`: `sync_attempts`, `sync_next_attempt_at`, `sync_locked_at`,
  `sync_error`, `synced_at` en `chat_cases`.
- `src/services/case-sync.service.ts` + `src/jobs/cases-sync.job.ts` (cada 30 s,
  `CASES_SYNC_CRON`). Casos de a uno y en serie: la cuota de Google es por cuenta del cliente.
- `src/services/case-sync.format.ts` (+ test): nombres, columnas y valores del Sheet, sin I/O.
- `composioService.execute` acepta `skipConnectionCheck`: la conexión se verifica una vez por caso.

Cómo se cuida cada paso:

| Paso | Idempotencia y control |
|---|---|
| Claim | `sync_locked_at` con update condicionado; el lock vence a los 10 min |
| Terminar | `synced` solo si `updated_at` no cambió durante el sync; si cambió, queda pendiente |
| Carpeta | Se busca por número en la carpeta padre antes de crear. Si `CREATE_FOLDER` devuelve otro padre (id inválido), falla con mensaje en vez de dejarla en la raíz |
| Archivo | El nombre (`licencia_2.jpg`) se guarda ANTES de subir; antes de subir se busca por ese nombre |
| Documentos en revisión | No se suben hasta que terminan (necesitan su tipo para el nombre); su reevaluación vuelve a disparar el sync |
| Duplicados | No se suben (`sync_status = none`) |
| Sheet | Encabezados por nombre (las columnas que faltan se agregan al final); fila por número; escritura celda por celda con `RAW` (sin fórmulas) y sin tocar otras columnas |
| Fallas | Backoff de 1 min × 2^n hasta 1 h; a los 8 intentos para, y cualquier cambio del caso lo rehabilita. `sync_error` queda legible para el dashboard |

Limitación conocida: si un documento ya subido se reclasifica (cambio de tipo de caso), en Drive
conserva el nombre anterior.

### Para probarlo

1. Cliente con Google Drive conectado en Integraciones.
2. Configurar destino con el bloque 4 de `db/seeds/aseguradora-casos.sql` (carpeta y Sheet de
   prueba, con una pestaña creada).
3. Abrir un caso y mandar documentos. En ≤ 30 s: carpeta `SIN-2026-00000N - <tipo>`, archivos
   nombrados por tipo y una fila en el Sheet. Mover columnas u ordenar el Sheet y mandar otro
   documento: tiene que actualizar la misma fila.
4. Desconectar Google: `chat_cases.sync_status = failed` con `sync_error` legible. Reconectar y
   mandar un dato: se sincroniza.

---

## Riesgos y a validar

- ~~SDK de Composio en TypeScript y archivos por URL.~~ Resuelto en la fase 1: se usa
  `GOOGLEDRIVE_UPLOAD_FROM_URL` y el sync queda en backend-js.
- **Costo por documento.** Cada adjunto suma una llamada de visión en `detail: "high"` además de
  la del turno. Medirlo en el piloto con `agentuse`. Optimización posible para agentes sin casos:
  reusar la descripción que ya genera `describe_images` en vez de procesar dos veces.
- **Calidad de extracción** en documentos argentinos reales (licencias de distintas
  jurisdicciones, cédulas viejas, denuncias escritas a mano). El umbral de confianza y los
  `description` del catálogo se ajustan en el piloto.
- **Auth gestionada de Composio:** el consent de Google dice "Composio". Aceptable para el piloto;
  para producción con más aseguradoras, OAuth propio por toolkit.
- **Turno proactivo en canales con ventana:** WhatsApp Business cierra la ventana de 24 h.
  Verificar que el mecanismo de follow-ups lo respeta para este caso.
- **Datos personales:** DNI y licencias quedan en Storage, en la tabla y en el Drive del cliente.
  Definir retención en `chat-attachments` para casos cerrados antes de abrirlo a más clientes.

## Fuera de alcance

- Verificar autenticidad de documentos. El sistema detecta inconsistencias, no falsificaciones.
- Analizar audio o video (se suben, no se interpretan).
- Que el modelo vuelva a mirar una imagen desde `documentos_del_chat`. La API de chat de OpenAI
  no acepta imágenes dentro de un mensaje de tool; se evalúa después si `summary` + `extracted`
  se quedan cortos.
- Varios casos abiertos en el mismo chat.
- Leer cambios hechos a mano en el Sheet.
