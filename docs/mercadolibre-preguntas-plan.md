# MercadoLibre — Preguntas en publicaciones

Continúa [mercadolibre-canal-plan.md](./mercadolibre-canal-plan.md). La fase 1 cubrió los DMs
post-venta; esta agrega las **preguntas pre-venta** de las publicaciones, que se responden
en público en la publicación y NO pasan por la bandeja de chats.

## Decisiones

| Tema | Decisión |
|---|---|
| Config del canal | Sale de `unipile_inboxes` a una tabla propia, `mercadolibre_settings`. |
| Identidad | `(client_id, ml_user_id)`, **no** `mercadolibre_connections.id` (ver abajo). |
| Agente | A elección: cualquier agente (`workflow`) del cliente. Independiente del agente de los DMs. |
| Firma | Texto estático que se agrega después de la respuesta del agente. Sin links, teléfonos ni mails. |
| El agente no sabe | No se publica nada, queda `needs_human` y se manda un mail al owner. |
| Uso | Cada respuesta **publicada** inserta en `agentuse` (`channel='mercadolibre_questions'`). |
| Registro | Se guardan **todas** las preguntas, aunque la respuesta automática esté apagada. |
| Historial | Sin backfill: la tab arranca vacía y se llena con las que llegan. |
| Responder a mano | Desde la tab del Inbox, para las `needs_human` (y cualquier pendiente). |

### Por qué no colgar de `mercadolibre_connections`

El corte por impago / trial vencido **borra** la fila de `mercadolibre_connections`
(`channel-disconnect.service`): sin tokens no hay servicio. Al reactivar, el cliente
vuelve a autorizar y la fila se recrea con otro `id`. Un FK con cascade borraría la firma,
el agente elegido y todo el historial de preguntas en cada corte. `ml_user_id` es estable.

## Datos

- `mercadolibre_settings` — PK `(client_id, ml_user_id)`. Aviso de venta (`sale_enabled`,
  `sale_template`, migrados desde `unipile_inboxes`) + preguntas (`questions_enabled`,
  `questions_workflow_id`, `questions_signature`).
- `mercadolibre_questions` — PK `question_id`. Snapshot de la publicación, pregunta,
  respuesta, quién respondió y estado.

Migraciones:
1. `mercadolibre_questions.sql` — crea las dos tablas y copia `ml_sale_*`.
2. `mercadolibre_drop_inbox_sale_columns.sql` — borra `ml_sale_*` de `unipile_inboxes`.
   **Correr recién cuando backend-js y el dashboard nuevos estén desplegados.**

### Estados de `mercadolibre_questions.status`

| Estado | Significado |
|---|---|
| `pending` | Reservada, el agente está respondiendo. |
| `answered` | Publicada. `answered_by` = `ai` o `seller`. |
| `needs_human` | El agente escaló (o no devolvió texto). Mail enviado. |
| `auto_off` | Llegó con la respuesta automática apagada o sin agente. |
| `failed` | Falló el agente o el POST a ML. `error` tiene el detalle. |
| `closed` | ML la cerró, la borró o la baneó sin respuesta nuestra. |

Una pregunta `needs_human` / `auto_off` / `failed` que después aparece `ANSWERED` en ML
(la contestó el vendedor desde ML) pasa a `answered` con `answered_by='seller'`.

## Flujo (backend-js)

Tópico `questions` en el webhook → ACK inmediato → `processQuestion` en background:

1. `GET /questions/{id}?api_version=4`.
2. Resolver `mercadolibre_settings` por `ml_user_id` y la conexión. Sin conexión → skip.
3. Upsert de la fila con los datos de la pregunta (+ `GET /items/{id}` para título,
   miniatura y link; `GET /users/{id}` para el nickname, best-effort).
4. Si ML dice que ya no está `UNANSWERED` → sincronizar estado y terminar.
5. Si el inbox está `suspended`, o `questions_enabled` está apagado o sin agente → `auto_off`.
6. Claim atómico (`update … where claimed_at is null`) → `pending`.
7. `/invoke` con `chat_id = mlq:{seller}:{question_id}` y `context.instructions` con las
   reglas de respuesta pública, los datos de la publicación y las últimas preguntas del
   mismo comprador en esa publicación (sacadas de nuestra tabla). Un thread por pregunta
   y no por comprador: con un thread compartido, el debounce del runtime descartaría una
   de dos preguntas seguidas y esa quedaría sin responder en ML.
8. Escaló o vino vacío → `needs_human` + mail. Si no, `respuesta + "\n\n" + firma`,
   recortando la parte del agente a 2000 caracteres totales → `POST /answers`.
9. `agentuse` + `answered`.

`runViaAgent` se divide: `invokeAgent()` (solo la llamada) + los side-effects del chat.

## Runtime (agente-tilegra)

`format_user_message` antepone `context.instructions` al mensaje, igual que la fecha y
el contacto: queda fuera del system prompt para no romper el prompt caching.

## Dashboard

- `/dashboard/connect/mercadolibre/[inboxId]` — panel del canal: aviso de venta +
  preguntas (switch, agente, firma con preview y contador).
- `/dashboard/inbox` — tab **MercadoLibre** (si hay conexión): preguntas por fecha,
  filtros por estado, publicación, fechas, quién respondió y búsqueda. Responder a mano
  llama a `POST /api/mercadolibre/questions/:id/answer` del backend.

## Fuera del código

Activar el tópico `questions` en el gestor de aplicaciones de ML (es por aplicación, no
por vendedor: no hay que reconectar a nadie).
