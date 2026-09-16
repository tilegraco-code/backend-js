// Lectura y guardado de la configuración de casos de un agente (tab "Casos" del dashboard).
// Ver docs/documentos-y-casos-plan.md y src/schemas/case-config.ts.
//
// Se guarda la configuración ENTERA: settings, catálogo y tipos de caso. Los casos abiertos no se
// ven afectados porque cada uno tiene su copia de los requisitos.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { caseConfigSchema, type CaseConfig } from '../schemas/case-config';
import { refreshAgentRuntimeCache } from './agent-runtime.service';

export const caseConfigService = {
  async get(agentId: number): Promise<CaseConfig & { has_config: boolean }> {
    const [settingsRes, docsRes, typesRes] = await Promise.all([
      supabase
        .from('agent_case_settings')
        .select('enabled, number_prefix, drive_parent_id, sheet_id, sheet_tab')
        .eq('agent_id', agentId)
        .maybeSingle(),
      supabase.from('agent_document_types').select('key, label, description').eq('agent_id', agentId).order('id'),
      supabase
        .from('agent_case_types')
        .select('key, label, description, active, definition')
        .eq('agent_id', agentId)
        .order('position'),
    ]);
    for (const r of [settingsRes, docsRes, typesRes]) if (r.error) throw r.error;

    return {
      has_config: Boolean(settingsRes.data),
      settings: (settingsRes.data as CaseConfig['settings'] | null) ?? {
        enabled: false,
        number_prefix: 'CASO',
        drive_parent_id: null,
        sheet_id: null,
        sheet_tab: null,
      },
      document_types: (docsRes.data ?? []) as CaseConfig['document_types'],
      case_types: (typesRes.data ?? []) as CaseConfig['case_types'],
    };
  },

  /**
   * Valida y guarda. Devuelve los problemas de validación en vez de lanzar, para que el
   * dashboard los muestre junto al campo.
   */
  async save(
    agentId: number,
    input: unknown,
    log: FastifyBaseLogger,
  ): Promise<{ ok: true; config: CaseConfig } | { ok: false; issues: { path: (string | number)[]; message: string }[] }> {
    const parsed = caseConfigSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) };
    }
    const config = parsed.data;
    const now = new Date().toISOString();

    // Orden pensado para no dejar referencias rotas si algo falla a mitad: primero lo que se
    // agrega o actualiza, después lo que se borra.
    const settings = await supabase
      .from('agent_case_settings')
      .upsert({ agent_id: agentId, ...config.settings, updated_at: now }, { onConflict: 'agent_id' });
    if (settings.error) throw settings.error;

    if (config.document_types.length) {
      const docs = await supabase.from('agent_document_types').upsert(
        config.document_types.map((d) => ({ agent_id: agentId, ...d, fields: [], updated_at: now })),
        { onConflict: 'agent_id,key' },
      );
      if (docs.error) throw docs.error;
    }

    if (config.case_types.length) {
      const types = await supabase.from('agent_case_types').upsert(
        config.case_types.map((c, position) => ({ agent_id: agentId, ...c, position, updated_at: now })),
        { onConflict: 'agent_id,key' },
      );
      if (types.error) throw types.error;
    }

    await deleteMissing('agent_case_types', agentId, config.case_types.map((c) => c.key));
    await deleteMissing('agent_document_types', agentId, config.document_types.map((d) => d.key));

    log.info(
      { agentId, enabled: config.settings.enabled, documents: config.document_types.length, caseTypes: config.case_types.length },
      'case-config: guardada',
    );
    // El runtime cachea las tools del agente: sin esto, abrir_caso tardaría el TTL en aparecer.
    await refreshAgentRuntimeCache(agentId, log);
    return { ok: true, config };
  },
};

async function deleteMissing(table: 'agent_case_types' | 'agent_document_types', agentId: number, keep: string[]) {
  let query = supabase.from(table).delete().eq('agent_id', agentId);
  if (keep.length) query = query.not('key', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`);
  const { error } = await query;
  if (error) throw error;
}
