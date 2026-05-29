import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { unipileApiService } from './unipile-api.service';
import { evolutionApiService } from './evolution-api.service';

type InboxRow = {
  id: number;
  account_id: string | null;
  source: string | null;
  evolution_instance_name: string | null;
};

/**
 * Desconecta en el proveedor (Unipile / Evolution) y luego hard-deletea todos
 * los inboxes de un cliente. Usado tanto por trials vencidos como por planes
 * impagos: la idea es no dejar "cuentas muertas" generando costo.
 *
 * Best-effort por canal: si la desconexión en el proveedor falla, se loguea
 * pero igual se borra la fila (la cuenta quedará huérfana en el proveedor, pero
 * preferimos no bloquear la limpieza del resto). Devuelve cuántas filas borró.
 */
export async function disconnectAndDeleteClientChannels(
  clientId: number,
  dryRun: boolean,
  log: FastifyBaseLogger,
): Promise<number> {
  const cLog = log.child({ client_id: clientId });

  const { data, error } = await supabase
    .from('unipile_inboxes')
    .select('id, account_id, source, evolution_instance_name')
    .eq('client_id', clientId);

  if (error) {
    cLog.error({ err: error }, 'channel-disconnect: select inboxes error');
    throw error;
  }

  const inboxes = (data ?? []) as InboxRow[];
  if (inboxes.length === 0) {
    cLog.info('channel-disconnect: cliente sin canales conectados');
    return 0;
  }

  if (dryRun) {
    cLog.info({ count: inboxes.length }, 'DRY RUN — no se desconecta ni borra ningún canal');
    return inboxes.length;
  }

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
      } else if (inbox.account_id) {
        await unipileApiService.deleteAccount(inbox.account_id);
      }
    } catch (err) {
      cLog.error(
        { err, inbox_id: inbox.id, source: inbox.source },
        'channel-disconnect: error desconectando en el proveedor (se borra la fila igual)',
      );
    }
  }

  const { error: deleteError, count } = await supabase
    .from('unipile_inboxes')
    .delete({ count: 'exact' })
    .eq('client_id', clientId);

  if (deleteError) {
    cLog.error({ err: deleteError }, 'channel-disconnect: hard delete error');
    throw deleteError;
  }

  const deleted = count ?? inboxes.length;
  cLog.info({ deleted }, 'channel-disconnect: canales desconectados y eliminados');
  return deleted;
}
