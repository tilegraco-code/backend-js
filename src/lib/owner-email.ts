import type { FastifyBaseLogger } from 'fastify';
import { supabase } from './supabase';

/**
 * Resuelve el email del owner de un cliente.
 *
 * El email vive en Supabase Auth (`auth.users`), no en la tabla `user`.
 * Camino: client_id → tabla `user` (role='owner') → user_id → auth.users.email.
 *
 * Devuelve null si no hay owner o no se pudo resolver el email; el caller
 * decide si seguir igual (la desconexión no depende del email).
 */
export async function getOwnerEmail(
  clientId: number,
  log: FastifyBaseLogger,
): Promise<string | null> {
  const { data: ownerRow, error } = await supabase
    .from('user')
    .select('user_id')
    .eq('client_id', clientId)
    .eq('role', 'owner')
    .maybeSingle();

  if (error) {
    log.error({ err: error, client_id: clientId }, 'getOwnerEmail: query user error');
    return null;
  }

  if (!ownerRow?.user_id) {
    log.warn({ client_id: clientId }, 'getOwnerEmail: cliente sin owner');
    return null;
  }

  const { data: authData, error: authError } = await supabase.auth.admin.getUserById(
    ownerRow.user_id as string,
  );

  if (authError || !authData?.user?.email) {
    log.error({ err: authError, client_id: clientId }, 'getOwnerEmail: auth getUserById error');
    return null;
  }

  return authData.user.email;
}
