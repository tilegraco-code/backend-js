import type { FastifyBaseLogger } from 'fastify';
import { supabase } from './supabase';

/** Prioridad de a quién notificar cuando no hay un owner explícito. */
const ROLE_PRIORITY = ['owner', 'admin'] as const;

function rank(role: string | null): number {
  const i = ROLE_PRIORITY.indexOf((role ?? '') as (typeof ROLE_PRIORITY)[number]);
  return i === -1 ? ROLE_PRIORITY.length : i;
}

/**
 * Resuelve el email de contacto de un cliente.
 *
 * El email vive en Supabase Auth (`auth.users`), no en la tabla `user`.
 * Camino: client_id → tabla `user` → user_id → auth.users.email.
 *
 * No exige `role = 'owner'`: hay clientes cuyo único usuario quedó como
 * `admin` o `member` (altas por invitación, roles cambiados a mano), y
 * cortarles la cuenta sin avisar es peor que avisarle a un no-owner.
 * Se ordena owner → admin → resto y se toma el primero que resuelva email.
 *
 * Devuelve null si el cliente no tiene usuarios o ninguno resuelve email; el
 * caller decide si seguir igual (la desconexión no depende del email).
 */
export async function getOwnerEmail(
  clientId: number,
  log: FastifyBaseLogger,
): Promise<string | null> {
  const { data: rows, error } = await supabase
    .from('user')
    .select('user_id, role, created_at')
    .eq('client_id', clientId);

  if (error) {
    log.error({ err: error, client_id: clientId }, 'getOwnerEmail: query user error');
    return null;
  }

  const users = (rows ?? []).filter((r) => r.user_id);
  if (users.length === 0) {
    log.warn({ client_id: clientId }, 'getOwnerEmail: cliente sin usuarios');
    return null;
  }

  users.sort((a, b) => {
    const byRole = rank(a.role as string | null) - rank(b.role as string | null);
    if (byRole !== 0) return byRole;
    return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  });

  for (const u of users) {
    const { data: authData, error: authError } = await supabase.auth.admin.getUserById(
      u.user_id as string,
    );
    if (authError) {
      log.warn(
        { err: authError, client_id: clientId, user_id: u.user_id },
        'getOwnerEmail: auth getUserById error — pruebo el siguiente usuario',
      );
      continue;
    }
    const email = authData?.user?.email;
    if (email) {
      if (u.role !== 'owner') {
        log.info(
          { client_id: clientId, role: u.role },
          'getOwnerEmail: cliente sin owner — se notifica al usuario de mayor rango',
        );
      }
      return email;
    }
  }

  log.warn({ client_id: clientId }, 'getOwnerEmail: ningún usuario del cliente resolvió email');
  return null;
}
