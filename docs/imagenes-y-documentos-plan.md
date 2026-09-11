# Imágenes y documentos en el agente

Plan de implementación.

**Estado (2026-09-11):** rama `imagenes` en `backend-js` y en `agente-tilegra`. Fases 1 y 2
implementadas (typecheck y tests en verde). Falta: correr `db/migrations/chat_attachments.sql`,
probar con una foto y un PDF reales, y medir el costo por turno con imagen. Las fases 3 a 6
(snippet web, Evolution, ML, dashboard) no están empezadas.

## Contexto

Hoy un mensaje entrante viaja como texto plano de punta a punta: el webhook lo persiste en
`unipile_messages.content`, `dispatchToRuntime` arma `{chat_id, nombre, question}` y
`agente-tilegra` construye un `HumanMessage` de puro texto. Si el cliente manda una foto o un
PDF, el agente no se entera.

Peor: hoy se pierde del todo. `unipile-webhook.service.ts` corta con `no_message_content`
cuando `message` viene vacío, así que **una foto sin caption ni siquiera se guarda**. El tipo
`UnipileWebhookPayload` ya declara `attachments` y el esquema Zod de la ruta ya los valida,
pero nadie los lee.

Queremos que el agente pueda **ver una imagen** (una captura de un error, un comprobante, la
foto de un producto) y **leer un documento** que manda el cliente por chat.

Fuera de alcance: que un PDF del cliente se sume a la base de conocimiento del negocio. Eso es
el flujo de ingesta a `document_chunks` y es otro problema.

---

## La división de responsabilidades

Es la decisión que ordena todo lo demás.

| Capa | Qué hace | Qué NO hace |
|---|---|---|
| **backend-js** | Consigue los bytes del proveedor, los sube a Storage, devuelve una URL firmada y la metadata. | No interpreta el archivo. No llama al modelo. |
| **agente-tilegra** | Arma el mensaje multimodal, extrae el texto de los PDFs, describe la imagen, poda el historial. | No toca el canal ni el proveedor. Sigue siendo caja negra. |

El motivo: **lo único que cambia por canal es cómo consigo los bytes.** Unipile los da por un
endpoint con API key, Evolution obliga a pedirlos aparte en base64, ML los baja con el token del
vendedor y el snippet web los sube él mismo. Todo lo que viene después es idéntico. Si la parte
semántica vive en el runtime, se escribe una vez y los cuatro canales la heredan, igual que hoy
`N8nForwardPayload` normaliza el texto entre proveedores.

---

## Lo que se persiste, y por qué no es lo que ve el modelo

`unipile_messages.content` guarda algo legible para un humano (`[imagen]`, el caption, o
`[documento: factura.pdf]`) y los adjuntos van en una columna `attachments` nueva. La bandeja
del dashboard renderiza el archivo desde ahí. **No** se guarda el texto extraído del PDF en
`content`: a quien mira la bandeja le sirve el archivo, no ocho mil caracteres de texto suelto.

---

## El punto crítico: la imagen vive un solo turno

El checkpointer reenvía **todo** el historial en cada turno. Si la imagen queda viva en la
conversación, cada turno posterior la vuelve a pagar y además rompe el prefijo estático que
`app/agent/prompt.py` cuida para el caching de OpenAI.

Entonces: el turno en que llega el adjunto ve la imagen de verdad, como bloque de entrada. Al
cerrar el turno, el runtime **pisa ese mismo `HumanMessage` en el checkpoint** (mismo `id`, vía
`aupdate_state`) dejando solo texto: el caption más una descripción densa de lo que se veía.

Esto hay que hacerlo desde el día uno. Cambiarlo después implica migrar historiales ya escritos.

Dos cosas lo hacen tolerable:

1. **La descripción es literal, no estilística.** Transcribe el texto visible, montos, códigos,
   fechas y estado de las cosas. No "una foto de un comprobante". Con eso alcanza para la
   enorme mayoría de las repreguntas.
2. **Una tool para volver a mirar.** El agente puede pedir que se le reinyecte el adjunto de un
   mensaje anterior. Paga tokens solo cuando la descripción se quedó corta.

### Routers

Al clasificador se le manda **solo texto**, nunca la imagen. Clasificar contra un enum cerrado
no la necesita, y el clasificador está afinado con razonamiento mínimo. La imagen entra recién
en la rama especialista.

---

## Costo

Una imagen suma tokens de entrada. OpenAI la cuenta por parches según resolución y los modelos
mini aplican un multiplicador, así que **la cifra real hay que medirla con una foto de WhatsApp
verdadera** antes de asumir nada. Se mide con lo que ya existe: el `usage` vuelve inline por
turno y se escribe en `agentuse`, y los tokens de imagen caen solos dentro de `input_tokens`.

Palancas, de mayor a menor impacto:

| Palanca | Efecto |
|---|---|
| Podar la imagen del historial | Se paga una vez, no una vez por turno restante |
| Redimensionar antes de mandarla | Proporcional a la resolución |
| Descripción en detalle bajo | Costo fijo y chico por adjunto |
| PDF por texto extraído, nunca por visión | Evita el peor caso por lejos |
| Topes de tamaño, páginas y adjuntos por turno | Corta el abuso |

**Flag `vision` por agente.** Prendido, el agente recibe la imagen cruda además de la
descripción. Apagado, recibe solo la descripción y paga una sola pasada barata. Default
prendido, porque la poda acota el gasto y la calidad lo vale. El runtime ya lee el campo y
asume `true` si no viene; falta la columna en `agent`, mandarlo en `runtime-config` y el
control en el dashboard. Con el esquema de usos incluidos
por inbox y excedente por uso, conviene comparar el costo por uso de un cliente que manda fotos
contra uno que solo escribe antes de abrirlo a todos.

---

## Modelo de datos

### Migración

`db/migrations/chat_attachments.sql`

```sql
alter table public.unipile_messages
  add column if not exists attachments jsonb;
```

Cada item:

```json
{
  "kind": "image | document | audio | video | other",
  "mime": "image/jpeg",
  "name": "factura.pdf",
  "size": 184320,
  "path": "<client_id>/<chat_id>/<message_id>/<n>.jpg"
}
```

`path` es la ubicación en Storage, no una URL. Las URLs firmadas vencen; el path no. Se firma
en el momento en que se necesita.

### Bucket

`chat-attachments`, **privado**. Lo escribe el backend con la service role key. Nadie lee sin
URL firmada.

---

## Contrato `/invoke`

Campo nuevo, opcional, compatible hacia atrás:

```json
{
  "agent_id": 1, "chat_id": "...", "message": "mirá esto",
  "context": {...},
  "attachments": [
    { "kind": "image", "mime": "image/jpeg", "name": null, "url": "<firmada>" }
  ]
}
```

`url` es una URL firmada de vida corta. Alcanza con que dure el turno: OpenAI baja la imagen
durante la llamada.

---

## Fases

1. **Ingesta Unipile** en backend-js: migración, bucket, bajada del adjunto, subida a Storage,
   no descartar mensajes sin texto, mandar `attachments` en `/invoke`.
2. **Runtime multimodal** en agente-tilegra: contrato, armado del mensaje, extracción de PDF,
   descripción, poda del historial, topes, flag `vision`.
3. **Snippet web**: el widget sube directo a Storage con una URL de subida firmada. Se saltea
   el paso de bajar del proveedor, que es el caro. La ingesta del widget no está en backend-js,
   hay que ubicarla en el dashboard.
4. **Evolution**: los bytes no vienen en el webhook, hay que pedirlos con
   `getBase64FromMediaMessage`.
5. **MercadoLibre**: los mensajes post venta admiten adjuntos y el flujo ya trae el mensaje por
   API. Confirmar contra un payload real con adjunto antes de estimar.
6. **Dashboard**: render del adjunto en la bandeja. Independiente, va cuando quieras.

---

## Referencia de proveedores

### Unipile

El webhook `message_received` trae `attachments[]` con `id`, `type`, `mimetype`, `url`, `size`
(alto/ancho), `sticker` y `unavailable`.

La bajada va por el endpoint documentado, no por esa `url` (que apunta al CDN del proveedor y
para WhatsApp suele venir cifrada):

```
GET {dsn}/api/v1/messages/{message_id}/attachments/{attachment_id}
X-API-KEY: <api key>
```

Devuelve el binario.

### Evolution

El webhook no manda bytes. Hay que pedirlos con `POST /chat/getBase64FromMediaMessage/{instance}`.

### MercadoLibre

Adjuntos en mensajería post venta, se bajan con el token del vendedor. Pendiente de confirmar
contra un payload real.
