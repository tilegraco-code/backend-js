import { supabase } from '../lib/supabase';
import { HttpToolError, type HttpToolConfig } from './http-tool.request';

export * from './http-tool.request';

/** Carga una tool HTTP verificando que pertenezca al cliente. Devuelve también el secreto. */
export async function loadHttpTool(
  toolId: number,
  clientId: number,
): Promise<{ config: HttpToolConfig; secret: string | null; enabled: boolean }> {
  const { data, error } = await supabase
    .from('agent_tools')
    .select('type, config, secret, enabled, agent:agent_id(project:project_id(client_id))')
    .eq('id', toolId)
    .maybeSingle();
  if (error) throw new HttpToolError('Error leyendo la herramienta.', 500);
  const owner = (data?.agent as unknown as { project?: { client_id?: number } } | null)?.project?.client_id;
  if (!data || owner !== clientId) throw new HttpToolError('Herramienta no encontrada.', 404);
  if (data.type !== 'http') throw new HttpToolError('La herramienta no es de tipo HTTP.');
  return {
    config: data.config as HttpToolConfig,
    secret: (data.secret as string | null) ?? null,
    enabled: Boolean(data.enabled),
  };
}

