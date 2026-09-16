// Sync de casos al Drive y al Sheet del cliente, vía Composio (toolkit googledrive).
// Ver docs/documentos-y-casos-plan.md, sección "Drive y Sheets".
//
// Supabase es la fuente de verdad: esto solo escribe hacia afuera, nunca lee el Sheet para
// decidir nada. Cada paso es idempotente para que un reintento a mitad de camino no duplique:
// - la carpeta se busca por número antes de crearla;
// - el nombre de cada archivo se fija ANTES de subirlo, y se busca por ese nombre antes de subir;
// - la fila del Sheet se encuentra por número de caso, no por posición.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { caseRequirementsSchema, type CaseRequirements } from '../schemas/case-definition';
import type { CaseEvaluation } from './case-evaluator';
import { MAX_ATTEMPTS } from './chat-documents.constants';
import {
  cellValue,
  columnLetter,
  defaultColumns,
  fileName,
  findRow,
  folderName,
  mapColumns,
  quoteTab,
  type SheetColumn,
} from './case-sync.format';
import { ComposioNotConnectedError, composioService } from './composio.service';

const TOOLKIT = 'googledrive';

/** Intentos antes de dejar de reintentar solo. Un cambio en el caso lo vuelve a intentar. */
const MAX_SYNC_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const SIGNED_URL_TTL_SECONDS = 900;
const BUCKET = 'chat-attachments';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

type Settings = {
  drive_parent_id: string | null;
  sheet_id: string | null;
  sheet_tab: string | null;
  sheet_columns: SheetColumn[] | null;
};

type CaseRow = {
  id: number;
  client_id: number;
  agent_id: number;
  number: string;
  status: string;
  data: Record<string, unknown>;
  requirements: unknown;
  evaluation: CaseEvaluation | null;
  opened_at: string;
  completed_at: string | null;
  updated_at: string;
  external_ref: { drive_folder_id?: string; drive_folder_url?: string } | null;
  sync_attempts: number;
};

type DocRow = {
  id: number;
  doc_type: string | null;
  kind: string;
  mime: string;
  status: string;
  storage_path: string;
  duplicate_of: number | null;
  created_at: string;
  external_ref: { drive_name?: string; drive_file_id?: string; drive_url?: string } | null;
};

/** Error con mensaje para mostrarle al cliente en el dashboard. */
class SyncError extends Error {}

export const caseSyncService = {
  /** Una pasada: toma los casos con sync pendiente y vencido, de a uno por vez. */
  async syncBatch(log: FastifyBaseLogger, limit = 5): Promise<{ claimed: number; synced: number }> {
    const { data, error } = await supabase
      .from('chat_cases')
      .select('id')
      .in('sync_status', ['pending', 'failed'])
      .lte('sync_next_attempt_at', new Date().toISOString())
      .order('sync_next_attempt_at', { ascending: true })
      .limit(limit);
    if (error) throw error;

    let claimed = 0;
    let synced = 0;
    // En serie: son varias llamadas a Google por caso y la cuota es por cuenta del cliente.
    for (const { id } of data ?? []) {
      const row = await claim(id as number);
      if (!row) continue;
      claimed += 1;
      if (await this.syncOne(row, log)) synced += 1;
    }
    return { claimed, synced };
  },

  async syncOne(row: CaseRow, log: FastifyBaseLogger): Promise<boolean> {
    const caseLog = log.child({ caseId: row.id, number: row.number });
    try {
      const { data: settings, error } = await supabase
        .from('agent_case_settings')
        .select('drive_parent_id, sheet_id, sheet_tab, sheet_columns')
        .eq('agent_id', row.agent_id)
        .maybeSingle();
      if (error) throw error;

      const s = settings as Settings | null;
      const wantsDrive = Boolean(s?.drive_parent_id);
      const wantsSheet = Boolean(s?.sheet_id && s?.sheet_tab);
      if (!s || (!wantsDrive && !wantsSheet)) {
        await finish(row, 'none', null);
        return true;
      }

      const requirements = caseRequirementsSchema.safeParse(row.requirements);
      if (!requirements.success) throw new SyncError('Los requisitos guardados del caso son inválidos.');

      const { connected } = await composioService.connectionStatus(row.client_id, TOOLKIT);
      if (!connected) throw new SyncError('Google Drive no está conectado. Conectalo desde Integraciones.');

      const exec = (slug: string, args: Record<string, unknown>) =>
        composioService.execute(row.client_id, TOOLKIT, slug, args, { skipConnectionCheck: true });

      let current = row;
      let pendingDocs = false;
      if (wantsDrive) {
        current = await ensureFolder(current, s.drive_parent_id!, requirements.data, exec, caseLog);
        pendingDocs = await uploadDocuments(current, exec, caseLog);
      }
      if (wantsSheet) {
        await writeSheetRow(current, s, requirements.data, exec);
      }

      // Documentos todavía en revisión: se suben cuando terminen (su reevaluación vuelve a
      // marcar el caso como pendiente).
      await finish(row, 'synced', null);
      if (pendingDocs) caseLog.info('case-sync: quedan documentos en revisión, se suben después');
      return true;
    } catch (err) {
      const message =
        err instanceof SyncError
          ? err.message
          : err instanceof ComposioNotConnectedError
            ? 'Google Drive no está conectado. Conectalo desde Integraciones.'
            : `Falló la sincronización con Google: ${err instanceof Error ? err.message : String(err)}`;
      caseLog.warn({ err: err instanceof Error ? err.message : err }, 'case-sync: falló');
      await fail(row, message.slice(0, 1000));
      return false;
    }
  },
};

type Exec = (slug: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

async function claim(id: number): Promise<CaseRow | null> {
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('chat_cases')
    .update({ sync_locked_at: new Date().toISOString() })
    .eq('id', id)
    .in('sync_status', ['pending', 'failed'])
    .or(`sync_locked_at.is.null,sync_locked_at.lt."${staleBefore}"`)
    .select('*');
  if (error) throw error;
  return (data?.[0] as CaseRow | undefined) ?? null;
}

/**
 * Marca el caso como sincronizado, pero solo si no cambió mientras tanto. Si cambió (llegó un
 * documento, se corrigió un dato), `reevaluate` ya lo dejó pendiente y la próxima pasada lo toma.
 */
async function finish(row: CaseRow, status: 'synced' | 'none', error: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('chat_cases')
    .update({
      sync_status: status,
      sync_attempts: 0,
      sync_error: error,
      sync_locked_at: null,
      synced_at: status === 'synced' ? now : null,
    })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .select('id');
  if (!data?.length) {
    await supabase.from('chat_cases').update({ sync_locked_at: null, sync_attempts: 0 }).eq('id', row.id);
  }
}

async function fail(row: CaseRow, message: string): Promise<void> {
  const attempts = row.sync_attempts + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
  await supabase
    .from('chat_cases')
    .update({
      sync_status: 'failed',
      sync_attempts: attempts,
      // Agotados los intentos, no se reintenta solo: lo destraba el próximo cambio del caso.
      sync_next_attempt_at: new Date(
        Date.now() + (attempts >= MAX_SYNC_ATTEMPTS ? 100 * 365 * 24 * 3600_000 : delay),
      ).toISOString(),
      sync_error: message,
      sync_locked_at: null,
    })
    .eq('id', row.id);
}

async function ensureFolder(
  row: CaseRow,
  parentId: string,
  requirements: CaseRequirements,
  exec: Exec,
  log: FastifyBaseLogger,
): Promise<CaseRow> {
  if (row.external_ref?.drive_folder_id) return row;

  // Idempotencia: si un intento anterior creó la carpeta y murió antes de guardar el id.
  const found = await exec('GOOGLEDRIVE_FIND_FILE', {
    q: `name contains '${row.number}' and mimeType = '${FOLDER_MIME}' and '${parentId}' in parents and trashed = false`,
    pageSize: 5,
  });
  const existing = (found.files as { id?: string; name?: string }[] | undefined)?.find((f) =>
    f.name?.startsWith(row.number),
  );

  let folderId = existing?.id;
  let folderUrl = folderId ? `https://drive.google.com/drive/folders/${folderId}` : undefined;
  if (!folderId) {
    const created = await exec('GOOGLEDRIVE_CREATE_FOLDER', {
      name: folderName(row.number, requirements.label),
      parent_id: parentId,
    });
    folderId = created.id as string | undefined;
    if (!folderId) throw new Error('Google no devolvió el id de la carpeta');
    // CREATE_FOLDER acepta un nombre como parent y cae en la raíz si no lo encuentra: se verifica.
    const parents = created.parents as string[] | undefined;
    if (parents && !parents.includes(parentId)) {
      throw new SyncError('La carpeta de destino configurada no existe o no es accesible con la cuenta conectada.');
    }
    folderUrl =
      (created.webViewLink as string | undefined) ??
      (created.display_url as string | undefined) ??
      `https://drive.google.com/drive/folders/${folderId}`;
    log.info({ folderId }, 'case-sync: carpeta creada');
  }

  const external_ref = { ...(row.external_ref ?? {}), drive_folder_id: folderId, drive_folder_url: folderUrl };
  const { error } = await supabase.from('chat_cases').update({ external_ref }).eq('id', row.id);
  if (error) throw error;
  return { ...row, external_ref };
}

/** Sube los documentos pendientes del caso. Devuelve true si quedaron documentos en revisión. */
async function uploadDocuments(row: CaseRow, exec: Exec, log: FastifyBaseLogger): Promise<boolean> {
  const folderId = row.external_ref?.drive_folder_id;
  if (!folderId) return false;

  const { data, error } = await supabase
    .from('chat_documents')
    .select('id, doc_type, kind, mime, status, storage_path, duplicate_of, created_at, external_ref, attempts, sync_status')
    .eq('case_id', row.id)
    .order('created_at', { ascending: true })
    .order('idx', { ascending: true });
  if (error) throw error;

  const docs = (data ?? []) as (DocRow & { attempts: number; sync_status: string })[];
  let inReview = false;

  for (const doc of docs) {
    if (doc.sync_status === 'synced' || doc.sync_status === 'none') continue;

    if (doc.duplicate_of != null) {
      await supabase.from('chat_documents').update({ sync_status: 'none' }).eq('id', doc.id);
      continue;
    }
    // Se espera a la clasificación para ponerle nombre. Un failed con reintentos también espera.
    const retrying = doc.status === 'failed' && doc.attempts < MAX_ATTEMPTS;
    if (doc.status === 'pending' || doc.status === 'processing' || retrying) {
      inReview = true;
      continue;
    }

    let ref = doc.external_ref ?? {};
    if (!ref.drive_name) {
      const sameType = docs.filter(
        (d) => d.id !== doc.id && d.doc_type === doc.doc_type && d.kind === doc.kind && d.external_ref?.drive_name,
      ).length;
      ref = { ...ref, drive_name: fileName(doc.doc_type, doc.kind, sameType + 1, doc.storage_path) };
      // El nombre se fija antes de subir: es la llave para no duplicar si el intento se corta.
      const { error: nameError } = await supabase.from('chat_documents').update({ external_ref: ref }).eq('id', doc.id);
      if (nameError) throw nameError;
      doc.external_ref = ref;
    }

    if (!ref.drive_file_id) {
      const found = await exec('GOOGLEDRIVE_FIND_FILE', {
        q: `name = '${ref.drive_name!.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`,
        pageSize: 1,
      });
      const existing = (found.files as { id?: string }[] | undefined)?.[0];

      let fileId = existing?.id;
      let url = fileId ? `https://drive.google.com/file/d/${fileId}/view` : undefined;
      if (!fileId) {
        const { data: signed, error: signError } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);
        if (signError || !signed?.signedUrl) throw new Error(`no se pudo firmar ${doc.storage_path}`);

        const uploaded = await exec('GOOGLEDRIVE_UPLOAD_FROM_URL', {
          name: ref.drive_name,
          source_url: signed.signedUrl,
          parent_folder_id: folderId,
          mime_type: doc.mime,
        });
        fileId = uploaded.id as string | undefined;
        if (!fileId) throw new Error('Google no devolvió el id del archivo subido');
        url =
          (uploaded.webViewLink as string | undefined) ??
          (uploaded.display_url as string | undefined) ??
          `https://drive.google.com/file/d/${fileId}/view`;
      }
      ref = { ...ref, drive_file_id: fileId, drive_url: url };
    }

    const { error: saveError } = await supabase
      .from('chat_documents')
      .update({ external_ref: ref, sync_status: 'synced' })
      .eq('id', doc.id);
    if (saveError) throw saveError;
    log.info({ documentId: doc.id, name: ref.drive_name }, 'case-sync: documento en Drive');
  }

  return inReview;
}

async function writeSheetRow(row: CaseRow, s: Settings, requirements: CaseRequirements, exec: Exec): Promise<void> {
  const tab = quoteTab(s.sheet_tab!);
  const columns = s.sheet_columns?.length ? s.sheet_columns : defaultColumns(requirements);
  if (!columns.some((c) => c.source === 'number')) {
    throw new SyncError('Las columnas del Sheet tienen que incluir el número de caso.');
  }

  const headerRead = await exec('GOOGLEDRIVE_READ_SPREADSHEET_VALUES', {
    spreadsheet_id: s.sheet_id,
    ranges: [`${tab}!1:1`],
  });
  const headers = ((headerRead.valueRanges as { values?: unknown[][] }[] | undefined)?.[0]?.values?.[0] ?? []).map(
    (h) => String(h ?? ''),
  );
  const { index, newHeaders } = mapColumns(headers, columns);
  const lastColumn = columnLetter(Math.max(...index.values()));

  const bodyRead = await exec('GOOGLEDRIVE_READ_SPREADSHEET_VALUES', {
    spreadsheet_id: s.sheet_id,
    ranges: [`${tab}!A2:${lastColumn}`],
  });
  const rows = (bodyRead.valueRanges as { values?: unknown[][] }[] | undefined)?.[0]?.values ?? [];
  const rowNumber = findRow(rows, index.get('number')!, row.number);

  const data = [
    ...newHeaders.map((h) => ({ range: `${tab}!${columnLetter(h.index)}1`, values: [[h.header]] })),
    ...columns.map((c) => ({
      range: `${tab}!${columnLetter(index.get(c.source)!)}${rowNumber}`,
      values: [[cellValue(c.source, row, requirements)]],
    })),
  ];

  await exec('GOOGLEDRIVE_BATCH_UPDATE_SPREADSHEET_VALUES', {
    spreadsheet_id: s.sheet_id,
    // RAW: un dato que empieza con "=" queda como texto, no se ejecuta como fórmula.
    value_input_option: 'RAW',
    data,
  });
}
