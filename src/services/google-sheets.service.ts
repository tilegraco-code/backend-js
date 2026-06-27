// Operaciones sobre Google Sheets (API v4) usando el cliente OAuth autorizado por
// client_id. Lectura/escritura. El client_id se resuelve en google-api.service.
import { google } from 'googleapis';
import { googleApiService } from './google-api.service';

/** Extrae el spreadsheetId de una URL de Google Sheets, o devuelve el input si ya es un id. */
export function extractSpreadsheetId(urlOrId: string): string {
  const m = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : urlOrId.trim();
}

async function sheetsClient(clientId: number) {
  const auth = await googleApiService.authorizedClient(clientId);
  return google.sheets({ version: 'v4', auth });
}

async function driveClient(clientId: number) {
  const auth = await googleApiService.authorizedClient(clientId);
  return google.drive({ version: 'v3', auth });
}

export const googleSheetsService = {
  /**
   * Lee un rango (ej "Hoja 1" entera, o "Hoja 1!A1:D10"). Devuelve las filas crudas
   * y también como objetos usando la primera fila como encabezado (útil para el agente).
   */
  async read(
    clientId: number,
    spreadsheetId: string,
    range: string,
  ): Promise<{ values: string[][]; rows: Record<string, string>[]; row_count: number }> {
    const sheets = await sheetsClient(clientId);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: extractSpreadsheetId(spreadsheetId),
      range,
    });
    const values = (res.data.values ?? []) as string[][];

    const [header, ...body] = values;
    const rows = header
      ? body.map((row) => {
          const obj: Record<string, string> = {};
          header.forEach((key, i) => {
            obj[String(key)] = row[i] ?? '';
          });
          return obj;
        })
      : [];

    return { values, rows, row_count: body.length };
  },

  /** Agrega una o más filas al final del rango/pestaña. */
  async append(
    clientId: number,
    spreadsheetId: string,
    range: string,
    values: (string | number)[][],
  ): Promise<{ updated_range: string | null; updated_rows: number }> {
    const sheets = await sheetsClient(clientId);
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: extractSpreadsheetId(spreadsheetId),
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    return {
      updated_range: res.data.updates?.updatedRange ?? null,
      updated_rows: res.data.updates?.updatedRows ?? 0,
    };
  },

  /** Sobrescribe celdas de un rango concreto (ej "Hoja 1!B2:C2"). */
  async update(
    clientId: number,
    spreadsheetId: string,
    range: string,
    values: (string | number)[][],
  ): Promise<{ updated_range: string | null; updated_cells: number }> {
    const sheets = await sheetsClient(clientId);
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId: extractSpreadsheetId(spreadsheetId),
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    return {
      updated_range: res.data.updatedRange ?? null,
      updated_cells: res.data.updatedCells ?? 0,
    };
  },

  /** Crea un spreadsheet nuevo y devuelve su id y URL. */
  async create(
    clientId: number,
    title: string,
  ): Promise<{ spreadsheet_id: string | null; spreadsheet_url: string | null }> {
    const sheets = await sheetsClient(clientId);
    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title } },
    });
    return {
      spreadsheet_id: res.data.spreadsheetId ?? null,
      spreadsheet_url: res.data.spreadsheetUrl ?? null,
    };
  },

  /**
   * Busca spreadsheets por nombre vía Drive. Con scope drive.file solo devuelve los
   * que la app creó/abrió.
   */
  async findByName(
    clientId: number,
    name: string,
  ): Promise<{ id: string; name: string; url: string | null }[]> {
    const drive = await driveClient(clientId);
    const safe = name.replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `name contains '${safe}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id,name,webViewLink)',
      pageSize: 20,
    });
    return (res.data.files ?? []).map((f) => ({
      id: f.id ?? '',
      name: f.name ?? '',
      url: f.webViewLink ?? null,
    }));
  },
};
