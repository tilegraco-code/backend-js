import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { unipileApiService } from './unipile-api.service';
import { evolutionApiService } from './evolution-api.service';
import { mercadolibreService } from './mercadolibre.service';

type InboxRow = {
  id: number;
  account_id: string | null;
  provider: string | null;
  source: string | null;
  evolution_instance_name: string | null;
  suspended: boolean | null;
};

/**
 * Desconecta los canales de un cliente: destruye la sesión en el proveedor
 * (Unipile / Evolution) y deja la fila de `unipile_inboxes` marcada como
 * suspendida + desconectada, SIN borrarla. Usado tanto por trials vencidos como
 * por planes impagos.
 *
 * Por qué soft y no delete:
 * - El agente debe sobrevivir con su canal visible en estado "desconectado";
 *   el vínculo agente↔canal vive en `unipile_inboxes.workflow_id`, así que
 *   borrar la fila borra el vínculo y el canal desaparece del dashboard.
 * - `web_snippets` cuelga de `unipile_inboxes` con ON DELETE CASCADE: borrar la
 *   fila destruye el `public_key` del widget embebido en el sitio del cliente,
 *   que no se recupera al pagar.
 *
 * Lo que sí es irreversible: la cuenta en Unipile y la instancia en Evolution se
 * eliminan (ahí está el costo). Al reactivar hay que reconectar/re-escanear QR.
 *
 * Best-effort por canal: si la desconexión en el proveedor falla, se loguea pero
 * la fila igual se marca como desconectada. Devuelve cuántos canales tocó.
 */
export async function disconnectClientChannels(
  clientId: number,
  dryRun: boolean,
  log: FastifyBaseLogger,
): Promise<number> {
  const cLog = log.child({ client_id: clientId });

  const { data, error } = await supabase
    .from('unipile_inboxes')
    .select('id, account_id, provider, source, evolution_instance_name, suspended')
    .eq('client_id', clientId);

  if (error) {
    cLog.error({ err: error }, 'channel-disconnect: select inboxes error');
    throw error;
  }

  const all = (data ?? []) as InboxRow[];
  // Idempotencia: los ya suspendidos no se vuelven a tocar (evita pegarle de
  // nuevo al proveedor si el batch corre dos veces).
  const inboxes = all.filter((i) => i.suspended !== true);

  if (inboxes.length === 0) {
    cLog.info({ already_suspended: all.length }, 'channel-disconnect: sin canales activos que desconectar');
    return 0;
  }

  if (dryRun) {
    cLog.info({ count: inboxes.length }, 'DRY RUN — no se desconecta ningún canal');
    return inboxes.length;
  }

  let touched = 0;

  for (const inbox of inboxes) {
    try {
      if (inbox.source === 'evolution') {
        const instance = inbox.evolution_instance_name;
        if (instance) {
          // logout puede fallar si la sesión ya cerró; no es bloqueante.
          await evolutionApiService.logoutInstance(instance).catch((err) => {
            cLog.warn({ err, instance }, 'channel-disconnect: evolution logout falló (no bloqueante)');
          });
          await evolutionApiService.deleteInstance(instance);
        }
      } else if (inbox.source === 'mercadolibre') {
        // No hay cuenta que destruir del lado de ML: lo que hay es un grant OAuth.
        // Borrar la conexión nos deja sin tokens, que es el equivalente a cortar el
        // servicio. Al reactivar, el cliente vuelve a autorizar la app.
        if (inbox.account_id) {
          await mercadolibreService.deleteConnection(Number(inbox.account_id));
        }
      } else if (inbox.provider === 'WEB') {
        // El snippet web no tiene cuenta en ningún proveedor: su `account_id` es
        // el public_key del widget. Sólo se suspende (y al pagar se reactiva
        // solo, sin reconectar nada).
        cLog.info({ inbox_id: inbox.id }, 'channel-disconnect: snippet web — sólo se suspende');
      } else if (inbox.account_id) {
        await unipileApiService.deleteAccount(inbox.account_id);
      }
    } catch (err) {
      cLog.error(
        { err, inbox_id: inbox.id, source: inbox.source },
        'channel-disconnect: error desconectando en el proveedor (se marca desconectado igual)',
      );
    }

    // La instancia de Evolution ya no existe: limpiar el nombre evita que un
    // webhook tardío (o una instancia nueva con el mismo nombre) matchee esta fila.
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      suspended: true,
      // `lifecycle_cut` = la cuenta en el proveedor se destruyó. Lo distingue de
      // una pausa de MercadoPago, donde la cuenta sigue viva y se reactiva sola.
      suspended_reason: 'lifecycle_cut',
      suspended_at: now,
      status: 'inactive',
      account_status: 'disconnected',
      updated_at: now,
    };
    if (inbox.source === 'evolution') {
      patch.evolution_instance_name = null;
    }

    const { error: updateError } = await supabase
      .from('unipile_inboxes')
      .update(patch)
      .eq('id', inbox.id);

    if (updateError) {
      cLog.error({ err: updateError, inbox_id: inbox.id }, 'channel-disconnect: update error');
      throw updateError;
    }

    touched++;
  }

  cLog.info({ disconnected: touched }, 'channel-disconnect: canales desconectados (filas conservadas)');
  return touched;
}
