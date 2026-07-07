// Arma el BLOQUE ESTÁTICO del system message de un agente (todo lo que depende solo
// del agent_id, no de la conversación). Las partes dinámicas (Current Date, Contacto)
// las antepone n8n → este bloque es idéntico entre conversaciones y cacheable.
import { supabase } from '../lib/supabase';

type TaskRow = {
  node_key: string;
  kind: 'message' | 'task' | 'tool';
  condition: string | null;
  action: string | null;
  tool_id: number | null;
  sort_order: number;
};
type EdgeRow = { source_key: string; target_key: string };
type ToolRow = { id: number; name: string; description: string | null; enabled: boolean };

// Guía para usar las apps del cliente vía el Tool Router de Composio (MCP). Clave:
// el agente NO debe inventar slugs — tiene que buscarlos primero.
const MCP_GUIDANCE =
  'Tenés acceso a las apps que el cliente conectó (Gmail, Google Sheets, Google Calendar, etc.).\n' +
  '- Para hacer una acción, PRIMERO buscá la herramienta correcta con COMPOSIO_SEARCH_TOOLS y usá el slug EXACTO que devuelve. NUNCA inventes slugs ni campos.\n' +
  '- Si necesitás el detalle de los parámetros, usá COMPOSIO_GET_TOOL_SCHEMAS antes de ejecutar.\n' +
  '- Ejecutá con COMPOSIO_MULTI_EXECUTE_TOOL. Cada elemento del array `tools` debe tener ' +
  'ÚNICAMENTE `tool_slug` y `arguments`. NO agregues ningún otro campo (ni `thought`, ni ' +
  'notas, ni comentarios) — rompe la validación.\n' +
  '- Si una app no está conectada, pedile al usuario que la conecte; no inventes datos ni sigas.';

const TRANSFER_BLOCK =
  'Si no sabes una respuesta podes hacerle preguntas al usuario, en el caso de aun asi ' +
  'no poder responder usa la tool "transferir_conversacion" para relevarle la conversacion a un humano';

// jsonb que puede ser string o string[] → texto.
function asText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join('\n');
  return String(v);
}

// Renderiza el árbol (grafo) de tareas a texto. Graph-aware: cada nodo se lista una vez
// con sus predecesores (edges entrantes); un back-edge (loop) referencia un label previo.
function renderTasks(tasks: TaskRow[], edges: EdgeRow[], toolNameById: Map<number, string>): string {
  const ordered = [...tasks].sort((a, b) => a.sort_order - b.sort_order);

  // Label por nodo (keyed por node_key).
  const label = new Map<string, string>();
  let taskN = 0;
  let toolN = 0;
  let messageAction = '';
  for (const t of ordered) {
    if (t.kind === 'message') {
      label.set(t.node_key, 'inicio');
      messageAction = (t.action ?? '').trim();
    } else if (t.kind === 'tool') {
      label.set(t.node_key, `tool_${++toolN}`);
    } else {
      label.set(t.node_key, `tarea_${++taskN}`);
    }
  }

  // Predecesores (labels de los edges entrantes) por nodo.
  const prevLabels = new Map<string, string[]>();
  for (const e of edges) {
    const src = label.get(e.source_key);
    if (!src) continue;
    const arr = prevLabels.get(e.target_key) ?? [];
    arr.push(src);
    prevLabels.set(e.target_key, arr);
  }

  const out: string[] = [];
  if (messageAction) out.push(`Mensaje inicial: ${messageAction}`);

  for (const t of ordered) {
    if (t.kind === 'message') continue;
    const prev = prevLabels.get(t.node_key);
    const prevStr = prev && prev.length ? prev.join(', ') : 'inicio';
    const lines = [`Tarea: ${label.get(t.node_key)}`, `Tarea Previa: ${prevStr}`];
    const condition = (t.condition ?? '').replace(/\s*\n+\s*/g, ' ').trim();
    if (condition) lines.push(`Condición: ${condition}`);
    if (t.kind === 'tool') {
      const name = t.tool_id != null ? toolNameById.get(t.tool_id) : undefined;
      lines.push(`Acción: Usa ${name ?? '(herramienta sin configurar)'}`);
    } else {
      lines.push(`Acción: ${(t.action ?? '').trim()}`);
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

export const agentSystemMessageService = {
  async build(agentId: number): Promise<string> {
    const [propsRes, tasksRes, edgesRes, toolsRes] = await Promise.all([
      supabase.from('agentprops').select('rol, contexto, estilo, limits').eq('agent_id', agentId).maybeSingle(),
      supabase.from('agent_tasks').select('node_key, kind, condition, action, tool_id, sort_order').eq('agent_id', agentId),
      supabase.from('agent_task_edges').select('source_key, target_key').eq('agent_id', agentId),
      supabase.from('agent_tools').select('id, name, description, enabled').eq('agent_id', agentId),
    ]);
    if (propsRes.error) throw propsRes.error;
    if (tasksRes.error) throw tasksRes.error;
    if (edgesRes.error) throw edgesRes.error;
    if (toolsRes.error) throw toolsRes.error;

    const props = (propsRes.data ?? {}) as { rol?: string; contexto?: string; estilo?: string; limits?: unknown };
    const tasks = (tasksRes.data ?? []) as TaskRow[];
    const edges = (edgesRes.data ?? []) as EdgeRow[];
    const tools = (toolsRes.data ?? []) as ToolRow[];

    const toolNameById = new Map(tools.map((t) => [t.id, t.name]));
    const tareas = renderTasks(tasks, edges, toolNameById);
    const herramientas = tools
      .filter((t) => t.enabled)
      .map((t) => `Usa la herramienta ${t.name} cuando ${t.description ?? ''}`)
      .join('\n');

    return [
      '# Rol',
      asText(props.rol),
      '# Tarea',
      tareas,
      '# Herramientas',
      herramientas,
      '# Apps conectadas (Composio)',
      MCP_GUIDANCE,
      '# Contexto',
      asText(props.contexto),
      '# Estilo',
      asText(props.estilo),
      '# Limites',
      asText(props.limits),
      '#Transferir Conversiacion',
      TRANSFER_BLOCK,
    ].join('\n');
  },
};
