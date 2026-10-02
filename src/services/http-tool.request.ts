import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Tools HTTP configuradas por el cliente en el dashboard ("API personalizada").
 *
 * El runtime (agente-tilegra) no llama a la API del cliente directo: pasa por acá
 * con el tool_id. Así el secreto (token / API key / contraseña) nunca sale de
 * backend-js, y toda llamada saliente pasa por el mismo control anti-SSRF: la
 * URL la escribe un cliente, y sin ese control podría apuntar la tool a nuestra
 * red interna o al metadata service del proveedor de nube.
 */

export type HttpParamLocation = 'path' | 'query' | 'body';
export type HttpParam = {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  location: HttpParamLocation;
};
export type HttpAuth =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'header'; name: string }
  | { type: 'query'; name: string }
  | { type: 'basic'; username: string };

export type HttpToolConfig = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  /** JSON fijo que se mezcla con los params de body (los params pisan). */
  body_template?: string;
  params?: HttpParam[];
  auth?: HttpAuth;
};

export type HttpToolResult = { ok: boolean; status: number; body: string };

const TIMEOUT_MS = 15_000;
/** Se corta la descarga acá: la respuesta va entera al prompt del modelo. */
const MAX_DOWNLOAD_BYTES = 1_000_000;
/** Lo que se le devuelve al modelo. */
const MAX_RESULT_CHARS = 4_000;

export class HttpToolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ── Anti-SSRF ───────────────────────────────────────────────────────────────

/** IPs a las que una tool nunca puede llegar: loopback, redes privadas, link-local (metadata), etc. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reservadas
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') || // unique local
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') || // link-local
      lower.startsWith('ff') // multicast
    );
  }
  return true;
}

/**
 * `lookup` para http(s).request: valida la IP en el mismo momento en que se
 * conecta. Validar antes y conectar después deja abierto el DNS rebinding (el
 * dominio resuelve a una IP pública en el chequeo y a 127.0.0.1 en la conexión).
 */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((a) => isBlockedAddress(a.address));
    if (blocked || list.length === 0) {
      return callback(
        Object.assign(new Error(`Destino no permitido: ${hostname}`), { code: 'EBLOCKED' }),
        '',
        0,
      );
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

// ── Armado del request ──────────────────────────────────────────────────────

function coerce(param: HttpParam, value: unknown): unknown {
  if (value == null || value === '') return undefined;
  if (param.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new HttpToolError(`"${param.name}" tiene que ser un número.`);
    return n;
  }
  if (param.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export type BuiltRequest = {
  url: URL;
  method: HttpToolConfig['method'];
  headers: Record<string, string>;
  body?: string;
};

/** Arma el request final a partir de la config, el secreto y los argumentos del modelo. Puro: testeable sin red. */
export function buildHttpRequest(
  config: HttpToolConfig,
  secret: string | null,
  args: Record<string, unknown>,
): BuiltRequest {
  const params = config.params ?? [];
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const p of params) {
    const v = coerce(p, args[p.name]);
    if (v === undefined) {
      if (p.required) missing.push(p.name);
      continue;
    }
    values[p.name] = v;
  }
  if (missing.length) {
    throw new HttpToolError(`Faltan datos obligatorios: ${missing.join(', ')}.`);
  }

  // Path: {param} en la URL. Se reemplaza antes de parsear para que las llaves no se encodeen.
  let rawUrl = config.url.trim();
  for (const p of params.filter((x) => x.location === 'path')) {
    const v = values[p.name];
    rawUrl = rawUrl.split(`{${p.name}}`).join(v === undefined ? '' : encodeURIComponent(String(v)));
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpToolError('La URL de la herramienta no es válida.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpToolError('La URL tiene que empezar con http:// o https://.');
  }
  if (url.username || url.password) {
    throw new HttpToolError('Las credenciales van en Autenticación, no en la URL.');
  }
  // Con una IP literal Node no llama a `lookup`, así que safeLookup no la ve.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new HttpToolError('Esa URL apunta a una red interna y no está permitida.');
  }

  for (const [k, v] of Object.entries(config.query_params ?? {})) {
    if (k.trim()) url.searchParams.set(k, v);
  }
  for (const p of params.filter((x) => x.location === 'query')) {
    if (values[p.name] !== undefined) url.searchParams.set(p.name, String(values[p.name]));
  }

  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (k.trim()) headers[k.trim()] = v;
  }

  const auth = config.auth ?? { type: 'none' };
  if (auth.type !== 'none' && !secret) {
    throw new HttpToolError('La herramienta no tiene cargado el token / clave de autenticación.');
  }
  if (auth.type === 'bearer') headers.Authorization = `Bearer ${secret}`;
  if (auth.type === 'header') headers[auth.name.trim()] = secret!;
  if (auth.type === 'query') url.searchParams.set(auth.name.trim(), secret!);
  if (auth.type === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${secret}`).toString('base64')}`;
  }

  let body: string | undefined;
  if (config.method !== 'GET' && config.method !== 'DELETE') {
    let base: Record<string, unknown> = {};
    if (config.body_template?.trim()) {
      try {
        const parsed = JSON.parse(config.body_template);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
        else throw new Error();
      } catch {
        throw new HttpToolError('El body fijo tiene que ser un objeto JSON válido.');
      }
    }
    const bodyValues = Object.fromEntries(
      params
        .filter((p) => p.location === 'body' && values[p.name] !== undefined)
        .map((p) => [p.name, values[p.name]]),
    );
    const merged = { ...base, ...bodyValues };
    if (Object.keys(merged).length) {
      body = JSON.stringify(merged);
      headers['Content-Type'] = 'application/json';
    }
  }

  return { url, method: config.method, headers, body };
}

// ── Ejecución ───────────────────────────────────────────────────────────────

function send(req: BuiltRequest): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const mod = req.url.protocol === 'https:' ? https : http;
    const r = mod.request(
      req.url,
      { method: req.method, headers: req.headers, lookup: safeLookup, timeout: TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_DOWNLOAD_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('close', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new HttpToolError('La API tardó demasiado en responder.', 504)));
    r.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof HttpToolError) return reject(err);
      if (err.code === 'EBLOCKED') return reject(new HttpToolError('Esa URL apunta a una red interna y no está permitida.'));
      reject(new HttpToolError(`No se pudo conectar con la API: ${err.message}`, 502));
    });
    if (req.body) r.write(req.body);
    r.end();
  });
}

function formatBody(text: string): string {
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* texto plano */
  }
  return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n…(respuesta recortada)` : out;
}

export async function executeHttpTool(
  config: HttpToolConfig,
  secret: string | null,
  args: Record<string, unknown>,
): Promise<HttpToolResult> {
  const built = buildHttpRequest(config, secret, args);
  // Las redirecciones NO se siguen (http.request no lo hace): un 3xx hacia una IP
  // interna esquivaría el control. Se devuelve tal cual.
  const { status, text } = await send(built);
  return { ok: status >= 200 && status < 300, status, body: formatBody(text) };
}
