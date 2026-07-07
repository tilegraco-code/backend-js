// Integración con Composio (proveedor de tools multi-tenant).
// A diferencia de Google/TiendaNube NO guardamos tokens: Composio es el store de las
// cuentas conectadas. El multi-tenant se mapea con userId = String(client_id).
//
// Auth GESTIONADA por Composio (sin BYO OAuth): cada toolkit necesita un authConfig
// (uno por toolkit, no por cliente). `getOrCreateAuthConfig` lo resuelve la 1ra vez
// (busca el gestionado existente o lo crea) y lo cachea en memoria del proceso.
import { Composio } from '@composio/core';
import { supabase } from '../lib/supabase';

export class ComposioNotConnectedError extends Error {
  constructor(clientId: number, toolkit: string) {
    super(`El cliente ${clientId} no tiene "${toolkit}" conectado en Composio`);
    this.name = 'ComposioNotConnectedError';
  }
}

// Cliente lazy: valida env recién al primer uso (como getCreds() de google-api).
let _client: Composio | null = null;
function client(): Composio {
  if (_client) return _client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error('Falta COMPOSIO_API_KEY en el entorno');
  _client = new Composio({ apiKey });
  return _client;
}

const uid = (clientId: number): string => String(clientId);
const tk = (toolkit: string): string => toolkit.toLowerCase();

// toolkit → authConfigId (gestionado). Cache de proceso; se repuebla al reiniciar.
const authConfigCache = new Map<string, string>();

async function getOrCreateAuthConfig(toolkit: string): Promise<string> {
  const key = tk(toolkit);
  const cached = authConfigCache.get(key);
  if (cached) return cached;

  // 1) Reusar un authConfig gestionado ya existente para el toolkit.
  const existing = await client().authConfigs.list({ toolkit: key, isComposioManaged: true, limit: 1 });
  const found = existing.items?.[0]?.id;
  if (found) {
    authConfigCache.set(key, found);
    return found;
  }

  // 2) Crear uno gestionado (sin credenciales propias → consent muestra "Composio").
  const created = await client().authConfigs.create(key, { type: 'use_composio_managed_auth' });
  authConfigCache.set(key, created.id);
  return created.id;
}

// ── MCP (nuevo flujo agentic) ────────────────────────────────────────────────
// Usamos el Tool Router (session): expone ~6 meta-tools (buscar + ejecutar) en vez de
// las 150+ tools individuales → no revienta el límite de 128 tools de OpenAI, y el
// agente busca dinámicamente la tool que necesita. userId = client_id → scopeado a las
// cuentas conectadas del cliente.
const MCP_TOOLKITS = ['gmail', 'googlecalendar', 'googlesheets', 'googledrive', 'slack', 'notion'];

export type ConnectedToolkit = { slug: string; name: string; logo: string | null };

// Cache en proceso del catálogo de toolkits (slug → nombre/logo) para enriquecer las
// conexiones sin re-pegarle a Composio en cada request. Se repuebla al reiniciar.
let _toolkitMeta: Map<string, { name: string; logo: string | null }> | null = null;
async function toolkitMetaMap(): Promise<Map<string, { name: string; logo: string | null }>> {
  if (_toolkitMeta) return _toolkitMeta;
  const list = await client().toolkits.get();
  const m = new Map<string, { name: string; logo: string | null }>();
  for (const t of list) {
    m.set(t.slug.toLowerCase(), { name: t.name, logo: t.meta?.logo ?? null });
  }
  _toolkitMeta = m;
  return m;
}

// Metadata "liviana" de una tool para la UI / el snapshot que guardamos en config.
export type ComposioToolMeta = {
  slug: string;
  name: string;
  description: string | null;
  toolkit: string | null;
  inputSchema: Record<string, unknown> | null; // JSON Schema (inputParameters)
};

function toMeta(tool: {
  slug: string;
  name: string;
  description?: string;
  toolkit?: { slug?: string } | null;
  inputParameters?: Record<string, unknown>;
}): ComposioToolMeta {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description ?? null,
    toolkit: tool.toolkit?.slug ?? null,
    inputSchema: tool.inputParameters ?? null,
  };
}

export const composioService = {
  /** Toolkits disponibles (para el browse en la UI). Devuelve un array. */
  async listToolkits() {
    return await client().toolkits.get();
  },

  /**
   * Tools de un toolkit (schema sin userId). `search` hace búsqueda semántica.
   * `important: false` → trae TODAS las tools del toolkit, no solo las "importantes"
   * (por defecto Composio recorta y deja afuera acciones como create_event).
   */
  async listTools(toolkit: string, search?: string, limit = 100): Promise<ComposioToolMeta[]> {
    const tools = await client().tools.getRawComposioTools({
      toolkits: [tk(toolkit)],
      important: false,
      ...(search ? { search } : {}),
      limit,
    });
    return tools.map(toMeta);
  },

  /** Una tool por slug → se guarda su inputSchema en config al crear la agent_tool. */
  async getTool(slug: string): Promise<ComposioToolMeta> {
    const tool = await client().tools.getRawComposioToolBySlug(slug);
    return toMeta(tool);
  },

  /**
   * Inicia la conexión OAuth de un toolkit para un cliente. Devuelve la redirectUrl
   * (página hosted de Composio) que el dashboard abre en popup.
   */
  async initiateConnection(
    clientId: number,
    toolkit: string,
    callbackUrl?: string,
  ): Promise<{ redirectUrl: string | null; connectionId: string }> {
    const authConfigId = await getOrCreateAuthConfig(toolkit);
    // `link` (no `initiate`): initiate quedó retirado para auth GESTIONADA por Composio.
    const req = await client().connectedAccounts.link(uid(clientId), authConfigId, {
      ...(callbackUrl ? { callbackUrl } : {}),
    });
    return { redirectUrl: req.redirectUrl ?? null, connectionId: req.id };
  },

  /**
   * Toolkits con una cuenta ACTIVE para el cliente, con nombre + logo (para el catálogo
   * y la lista del árbol). La cuenta conectada solo trae el slug → cruzamos con el
   * catálogo de toolkits (cacheado en proceso) para el nombre/logo.
   */
  async listConnectedToolkits(clientId: number): Promise<ConnectedToolkit[]> {
    const res = await client().connectedAccounts.list({
      userIds: [uid(clientId)],
      statuses: ['ACTIVE'],
    });
    const slugs = new Set<string>();
    for (const acc of (res.items ?? []) as { toolkit?: { slug?: string } | string }[]) {
      const slug = typeof acc.toolkit === 'string' ? acc.toolkit : acc.toolkit?.slug;
      if (slug) slugs.add(slug.toLowerCase());
    }
    const meta = await toolkitMetaMap();
    return [...slugs].map((slug) => ({
      slug,
      name: meta.get(slug)?.name ?? slug,
      logo: meta.get(slug)?.logo ?? null,
    }));
  },

  /**
   * URL del MCP scopeada a un cliente (nuevo flujo agentic). El agente de n8n se
   * conecta acá y ve/ejecuta las tools de las apps conectadas del cliente.
   * Devuelve la URL (streamable_http) + la api key que va en el header `x-api-key`.
   *
   * `allowedTools` = allow-list del agente (`agentprops.mcp_toolkits`, mapa
   * `{ toolkit: [tool_slug,...] }`). Si se pasa, el agente solo ve ESAS tools de las apps
   * conectadas (el Tool Router se scopea con el param `tools`). Si el mapa queda vacío
   * (no eligió ninguna, o la app no está conectada) devolvemos `{ url:'', apiKey:'' }` →
   * el agente queda SIN MCP (menos tools = menos tokens). Si es `undefined` (compat con
   * llamadas viejas) caemos al comportamiento anterior: todas las apps activas del cliente.
   */
  async getUserMcpUrl(
    clientId: number,
    allowedTools?: Record<string, string[]>,
  ): Promise<{ url: string; apiKey: string }> {
    // Pinneamos el authConfig de CADA toolkit al de la conexión ACTIVE real del usuario.
    // Sin esto, la session agarra otro authConfig y no "ve" la conexión ("no active
    // connection in this session"), aunque exista.
    const accounts = await client().connectedAccounts.list({
      userIds: [uid(clientId)],
      statuses: ['ACTIVE'],
    });
    const authConfigs: Record<string, string> = {};
    const connected = new Set<string>();
    for (const acc of (accounts.items ?? []) as {
      toolkit?: { slug?: string } | string;
      authConfig?: { id?: string };
    }[]) {
      const slug = (typeof acc.toolkit === 'string' ? acc.toolkit : acc.toolkit?.slug)?.toLowerCase();
      const acId = acc.authConfig?.id;
      if (slug && acId) {
        authConfigs[slug] = acId;
        connected.add(slug);
      }
    }

    // Allow-list del agente ∩ apps conectadas. Sin allow-list (undefined) → todas las
    // conectadas (comportamiento previo). Con allow-list → solo las tools elegidas.
    let toolkits: string[];
    let toolsParam: Record<string, string[]> | undefined;
    if (allowedTools === undefined) {
      toolkits = connected.size > 0 ? [...connected] : MCP_TOOLKITS;
    } else {
      // Solo apps conectadas que tengan ≥1 tool elegida.
      const entries = Object.entries(allowedTools)
        .map(([tk, slugs]) => [tk.toLowerCase(), (slugs ?? []).filter(Boolean)] as const)
        .filter(([tk, slugs]) => connected.has(tk) && slugs.length > 0);
      // El agente no habilitó ninguna tool (o su app no está conectada) → sin MCP.
      if (entries.length === 0) return { url: '', apiKey: '' };
      toolkits = entries.map(([tk]) => tk);
      toolsParam = {};
      for (const [tk, slugs] of entries) toolsParam[tk] = slugs;
      // Filtramos authConfigs a las apps elegidas para no arrastrar cuentas ajenas.
      for (const slug of Object.keys(authConfigs)) {
        if (!toolkits.includes(slug)) delete authConfigs[slug];
      }
    }

    // sandbox:false → saca las tools de code-execution y el campo required
    // `sync_response_to_workbench` de MULTI_EXECUTE (que hacía fallar la validación de n8n).
    // `tools` (mapa toolkit→slugs) restringe el Tool Router a esas tools puntuales.
    const session = await client().create(uid(clientId), {
      mcp: true,
      toolkits,
      ...(toolsParam ? { tools: toolsParam } : {}),
      authConfigs,
      sandbox: { enable: false },
    });
    const headers = (session.mcp?.headers ?? {}) as Record<string, string>;
    return { url: session.mcp?.url ?? '', apiKey: headers['x-api-key'] ?? '' };
  },

  /**
   * Allow-list de tools de un agente: mapa `{ toolkit: [tool_slug,...] }` guardado en
   * `agentprops.mcp_toolkits` (jsonb). `{}` si no seleccionó ninguna. Tolera el formato
   * viejo (array) tratándolo como vacío.
   */
  async getAgentMcpTools(agentId: number): Promise<Record<string, string[]>> {
    const { data, error } = await supabase
      .from('agentprops')
      .select('mcp_toolkits')
      .eq('agent_id', agentId)
      .maybeSingle();
    if (error) throw error;
    const raw = data?.mcp_toolkits as unknown;
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [tk, slugs] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(slugs) && slugs.length) out[tk.toLowerCase()] = slugs.map(String);
    }
    return out;
  },

  /** ¿El cliente tiene una cuenta ACTIVE para el toolkit? */
  async connectionStatus(
    clientId: number,
    toolkit: string,
  ): Promise<{ connected: boolean; accountId: string | null }> {
    const res = await client().connectedAccounts.list({
      userIds: [uid(clientId)],
      toolkitSlugs: [tk(toolkit)],
      statuses: ['ACTIVE'],
    });
    const account = res.items?.[0] as { id?: string } | undefined;
    return { connected: Boolean(account), accountId: account?.id ?? null };
  },

  /** Desconecta (borra) todas las cuentas del cliente para el toolkit. */
  async disconnect(clientId: number, toolkit: string): Promise<void> {
    const res = await client().connectedAccounts.list({
      userIds: [uid(clientId)],
      toolkitSlugs: [tk(toolkit)],
    });
    for (const acc of (res.items ?? []) as { id?: string }[]) {
      if (acc.id) await client().connectedAccounts.delete(acc.id);
    }
  },

  /** Registra un fallo de ejecución (best-effort; no rompe la request). */
  async logExecutionError(input: {
    clientId: number;
    toolkit: string;
    slug: string;
    args: Record<string, unknown>;
    error: string;
  }): Promise<void> {
    try {
      await supabase.from('composio_execution_logs').insert({
        client_id: input.clientId,
        toolkit: input.toolkit,
        slug: input.slug,
        arguments: input.args,
        error: input.error,
      });
    } catch {
      // logging best-effort
    }
  },

  /**
   * Ejecuta una tool para un cliente. Lanza ComposioNotConnectedError si no hay cuenta
   * conectada, o Error con el detalle si Composio devuelve `successful: false`.
   */
  async execute(
    clientId: number,
    toolkit: string,
    slug: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { connected } = await this.connectionStatus(clientId, toolkit);
    if (!connected) throw new ComposioNotConnectedError(clientId, toolkit);

    const res = await client().tools.execute(slug, {
      userId: uid(clientId),
      arguments: args,
      // Ejecuta la versión "latest" del toolkit. Para un proveedor genérico sobre
      // 1000+ toolkits no pinneamos versión por tool (TODO producción: guardar la
      // versión en config al crear la tool y pasarla acá para reproducibilidad).
      dangerouslySkipVersionCheck: true,
    });
    if (!res.successful) {
      throw new Error(res.error ?? `Falló la ejecución de ${slug}`);
    }
    return res.data;
  },
};
