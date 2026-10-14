// Resolución de la conexión de un proveedor (TiendaNube / WooCommerce / shipnow).
//
// Un cliente puede tener varias conexiones del mismo proveedor (una por tienda o
// cuenta) y cada tool del agente elige la suya en `agent_tools.config.connection_id`,
// que el runtime manda como `connection_id`. Ver docs/multi-conexion-integraciones-plan.md.
import { supabase } from './supabase';

export type ConnectionTable = 'tiendanube_connections' | 'woocommerce_connections' | 'shipnow_connections';

/**
 * - Con `connectionId`: esa conexión, sólo si es del cliente. Si no está devuelve null
 *   y NO cae a otra tienda: venderle al comprador del catálogo equivocado es peor que
 *   avisar que la tienda de la tool se desconectó.
 * - Sin `connectionId`: la principal, que es la más vieja. Es el caso de las tools
 *   creadas antes de que hubiera varias conexiones, y del dashboard viejo.
 */
export async function findConnection<T>(
  table: ConnectionTable,
  clientId: number,
  connectionId?: number | null,
): Promise<T | null> {
  const base = supabase.from(table).select('*').eq('client_id', clientId);
  const { data, error } = await (connectionId
    ? base.eq('id', connectionId)
    : base.order('id', { ascending: true }).limit(1)
  ).maybeSingle();
  if (error) throw error;
  return (data as T | null) ?? null;
}

/** Todas las conexiones del cliente, la principal primero. */
export async function listConnections<T>(table: ConnectionTable, clientId: number): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('client_id', clientId)
    .order('id', { ascending: true });
  if (error) throw error;
  return (data as T[] | null) ?? [];
}

/** Mensaje para el agente cuando no hay conexión. */
export function notConnectedMessage(provider: string, connectionId?: number | null): string {
  return connectionId
    ? `La cuenta de ${provider} asignada a esta herramienta ya no está conectada. Hay que reconectarla o elegir otra en la herramienta del agente.`
    : `Este workspace no tiene ${provider} conectado`;
}
