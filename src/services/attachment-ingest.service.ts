// Ingesta de adjuntos: bytes del proveedor → Supabase Storage → URL firmada.
//
// Es la mitad de backend-js del soporte de imágenes y documentos (ver
// docs/imagenes-y-documentos-plan.md). Acá NO se interpreta el archivo: no hay
// llamadas al modelo, ni OCR, ni extracción de PDF. Eso vive en agente-tilegra, una
// sola vez, y lo heredan todos los canales.
//
// Lo único que cambia por canal es cómo se consiguen los bytes: Unipile los da por
// un endpoint con API key, Evolution obliga a pedirlos en base64, ML los baja con el
// token del vendedor y el snippet web los sube él mismo. Por eso el fetch es un
// parámetro (`FetchBytes`) y todo lo de abajo es común.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { chatDocumentsService, sha256 } from './chat-documents.service';

const BUCKET = 'chat-attachments';

/** Tope por archivo. Arriba de esto se descarta: no hay caso de uso legítimo en un
 *  chat de atención y sí un costo real de storage y de tokens. */
const MAX_BYTES = 20 * 1024 * 1024;

/** Tope por mensaje. Alguien que manda quince fotos de una es abuso, no una consulta. */
const MAX_PER_MESSAGE = 5;

/** Vida de la URL firmada. Solo tiene que durar el turno: el modelo baja la imagen
 *  durante la llamada y después no la necesita más (la imagen no queda en el historial). */
const SIGNED_URL_TTL_SECONDS = 600;

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video' | 'other';

/** Lo que se persiste en `unipile_messages.attachments`. Guarda el path, no la URL. */
export type StoredAttachment = {
  kind: AttachmentKind;
  mime: string;
  name: string | null;
  size: number | null;
  path: string;
};

/** Lo que viaja al runtime en `/invoke`. Acá sí va la URL, ya firmada. */
export type ForwardAttachment = {
  kind: AttachmentKind;
  mime: string;
  name: string | null;
  url: string;
};

/** Un adjunto anunciado por el proveedor, antes de tener los bytes. */
export type PendingAttachment = {
  /** Id del adjunto en el proveedor, para pedirle los bytes. Puede venir vacío. */
  providerId: string;
  mime: string;
  name: string | null;
  /**
   * URL directa al archivo, cuando el proveedor la manda.
   *
   * Es el plan B para bajarlo: no todos los proveedores mandan un id con el que pedirlo por
   * API, y exigirlo hacía que el adjunto se descartara sin dejar rastro.
   */
  url?: string | null;
};

/**
 * Cómo conseguir los bytes de UN adjunto. La implementa cada canal.
 *
 * Devuelve también el mime cuando el proveedor lo informa AL BAJAR el archivo, que suele
 * ser más confiable que lo que anuncia el webhook: WhatsApp vía Unipile, por ejemplo, no
 * manda ningún mime en el webhook y sólo dice "img".
 */
export type FetchedBytes = { bytes: Buffer; mime?: string | null };
export type FetchBytes = (attachment: PendingAttachment) => Promise<FetchedBytes>;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
};

/**
 * Clasifica el adjunto en las categorías que al runtime le cambian el tratamiento:
 * una imagen entra como bloque visual, un documento como texto extraído, un audio
 * como transcripción. `other` es lo que el agente no va a poder abrir, y saberlo
 * temprano le permite decirlo en vez de quedarse mudo.
 */
export function kindFromMime(mime: string): AttachmentKind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf' || m.startsWith('text/')) return 'document';
  return 'other';
}

/**
 * Texto del mensaje cuando el cliente mandó un archivo sin escribir nada.
 *
 * Es lo que se lee en la bandeja y lo que queda en `content`, así que se redacta como una
 * frase y no como una etiqueta de sistema: "Imagen recibida: foto.jpg" en vez de "[imagen]".
 *
 * El género acompaña al sustantivo (imagen recibidA, documento recibidO), por eso la frase
 * entera está en la tabla y no se arma pegando una palabra fija.
 */
export function describeForInbox(attachments: { kind: AttachmentKind; name: string | null }[]): string {
  if (attachments.length === 0) return '';
  const label: Record<AttachmentKind, string> = {
    image: 'Imagen recibida',
    document: 'Documento recibido',
    audio: 'Audio recibido',
    video: 'Video recibido',
    other: 'Archivo recibido',
  };
  const first = attachments[0];
  const base = first.name ? `${label[first.kind]}: ${first.name}` : label[first.kind];
  const rest = attachments.length - 1;
  return rest > 0 ? `${base} (+${rest})` : base;
}

/**
 * Normaliza el content-type de una respuesta HTTP: le saca el charset y descarta los
 * genéricos, que no dicen nada y taparían un mime mejor venido del webhook.
 */
function limpiarMime(raw: string | null | undefined): string | null {
  const mime = (raw ?? '').split(';')[0]?.trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') return null;
  return mime;
}

function extensionFor(mime: string, name: string | null): string {
  const fromName = name?.includes('.') ? name.split('.').pop()?.toLowerCase() : null;
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXTENSION_BY_MIME[mime.toLowerCase()] ?? 'bin';
}

/** Los ids de chat traen `:`, `@` y demás; el path del bucket se queda con lo seguro. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Baja, sube y firma los adjuntos de un mensaje.
 *
 * Está pensada para correr en background (después del ACK del webhook): bajar un
 * archivo de varios MB y volver a subirlo no puede colgarse del request del
 * proveedor, que espera un 200 rápido.
 *
 * Tolera fallas parciales a propósito. Si un adjunto no se puede bajar, se loguea y
 * se sigue con los demás: perder una de tres fotos es mejor que perder el mensaje.
 */
export async function ingestAttachments(
  params: {
    clientId: number;
    chatId: string;
    messageId: string;
    attachments: PendingAttachment[];
    fetchBytes: FetchBytes;
  },
  log: FastifyBaseLogger,
): Promise<StoredAttachment[]> {
  const { clientId, chatId, messageId, attachments, fetchBytes } = params;
  const stored: StoredAttachment[] = [];

  const accepted = attachments.slice(0, MAX_PER_MESSAGE);
  if (attachments.length > accepted.length) {
    log.warn(
      { messageId, total: attachments.length, max: MAX_PER_MESSAGE },
      'adjuntos: mensaje con más adjuntos que el tope — se ignoran los sobrantes',
    );
  }

  for (const [index, attachment] of accepted.entries()) {
    try {
      const bajado = await fetchBytes(attachment);
      const bytes = bajado.bytes;
      // El mime de la descarga gana sobre el del webhook, que puede ser un placeholder.
      // Se normalizan los dos: WhatsApp manda las notas de voz como "audio/ogg; codecs=opus"
      // y ese parámetro rompe la búsqueda por extensión.
      const mime = limpiarMime(bajado.mime) ?? limpiarMime(attachment.mime) ?? attachment.mime;

      if (bytes.byteLength === 0) {
        log.warn({ messageId, providerId: attachment.providerId }, 'adjuntos: archivo vacío');
        continue;
      }
      if (bytes.byteLength > MAX_BYTES) {
        log.warn(
          { messageId, size: bytes.byteLength, max: MAX_BYTES },
          'adjuntos: archivo más grande que el tope — descartado',
        );
        continue;
      }

      const path =
        `${clientId}/${slug(chatId)}/${slug(messageId)}/` +
        `${index}.${extensionFor(mime, attachment.name)}`;

      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: mime,
        // Idempotencia: si Unipile reintenta el webhook, se pisa el mismo archivo en
        // vez de acumular copias con nombres distintos.
        upsert: true,
      });

      if (error) {
        log.error({ err: error, messageId, path }, 'adjuntos: upload a Storage falló');
        continue;
      }

      const item: StoredAttachment = {
        kind: kindFromMime(mime),
        mime,
        name: attachment.name,
        size: bytes.byteLength,
        path,
      };
      stored.push(item);

      // Registro para que el agente pueda consultarlo después del turno (ver
      // docs/documentos-y-casos-plan.md). Va acá y no en cada canal para que ninguno pueda
      // olvidarse. No lanza: un registro fallido no le quita el adjunto al turno.
      await chatDocumentsService.register(
        { clientId, chatId, messageId, idx: index, stored: item, sha256: sha256(bytes) },
        log,
      );
    } catch (e) {
      log.error({ err: e, messageId, providerId: attachment.providerId }, 'adjuntos: ingesta falló');
    }
  }

  return stored;
}

/**
 * Firma los adjuntos guardados para que el runtime pueda bajarlos.
 *
 * Se firma acá y no al guardar porque la URL vence: la que sirve es la que se emite
 * en el momento de usarla. Un adjunto que no se puede firmar se omite en vez de
 * viajar roto — el agente responde sin él, que es mejor que fallar el turno entero.
 */
export async function signAttachments(
  attachments: StoredAttachment[],
  log: FastifyBaseLogger,
): Promise<ForwardAttachment[]> {
  const signed: ForwardAttachment[] = [];

  for (const attachment of attachments) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(attachment.path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      log.error({ err: error, path: attachment.path }, 'adjuntos: no se pudo firmar la URL');
      continue;
    }

    signed.push({
      kind: attachment.kind,
      mime: attachment.mime,
      name: attachment.name,
      url: data.signedUrl,
    });
  }

  return signed;
}
