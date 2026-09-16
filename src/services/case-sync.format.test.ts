// Tests de las partes puras del sync a Drive y Sheets. Correr con `pnpm test`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellValue,
  columnLetter,
  defaultColumns,
  fileName,
  findRow,
  folderName,
  mapColumns,
  missingText,
  quoteTab,
  type SyncableCase,
} from './case-sync.format';
import { caseRequirementsSchema } from '../schemas/case-definition';

const requirements = caseRequirementsSchema.parse({
  case_type: 'robo_total',
  label: 'Robo total',
  catalog: {},
  definition: {
    data: [
      { key: 'patente', label: 'Patente' },
      { key: 'fecha_siniestro', label: 'Fecha del robo', type: 'date' },
      { key: 'hubo_heridos', label: 'Heridos', type: 'boolean' },
    ],
    documents: [],
  },
});

function caso(overrides: Partial<SyncableCase> = {}): SyncableCase {
  return {
    number: 'SIN-2026-000001',
    status: 'open',
    data: { patente: 'AB123CD', fecha_siniestro: '2026-09-10', hubo_heridos: false },
    evaluation: {
      complete: false,
      missing_data: [{ key: 'lugar', label: 'Lugar', type: 'string' }],
      invalid_data: [],
      missing_documents: [{ type: 'dni', label: 'DNI', have: 1, need: 2 }],
      illegible: [{ document_id: 1, type: 'licencia', label: 'Licencia', issues: [] }],
      failed_checks: [{ document_id: 2, type: 'cedula_verde', label: 'Cédula', message: 'x' }],
      pending_checks: [],
      processing: 1,
    },
    opened_at: '2026-09-16T17:05:00Z',
    completed_at: null,
    external_ref: { drive_folder_url: 'https://drive/f' },
    ...overrides,
  };
}

describe('Sheet', () => {
  test('columnas por default: fijas y un dato por columna', () => {
    assert.deepEqual(
      defaultColumns(requirements).map((c) => c.header),
      ['Número', 'Tipo', 'Estado', 'Abierto', 'Completado', 'Falta', 'Carpeta', 'Patente', 'Fecha del robo', 'Heridos'],
    );
  });

  test('valores de celda legibles para una persona', () => {
    const row = caso();
    assert.equal(cellValue('number', row, requirements), 'SIN-2026-000001');
    assert.equal(cellValue('case_type', row, requirements), 'Robo total');
    assert.equal(cellValue('status', row, requirements), 'Abierto');
    assert.equal(cellValue('opened_at', row, requirements), '16/09/2026, 14:05');
    assert.equal(cellValue('data.fecha_siniestro', row, requirements), '10/09/2026');
    assert.equal(cellValue('data.hubo_heridos', row, requirements), 'No');
    assert.equal(cellValue('data.inexistente', row, requirements), '');
    assert.equal(cellValue('drive_folder_url', row, requirements), 'https://drive/f');
  });

  test('falta en una línea', () => {
    assert.equal(
      missingText(caso()),
      'Lugar, DNI (1/2), Licencia (ilegible), Cédula (no coincide), 1 en revisión',
    );
    assert.equal(missingText(caso({ evaluation: { ...caso().evaluation!, complete: true } })), '—');
    assert.equal(missingText(caso({ status: 'cancelled' })), '');
  });

  test('las columnas se ubican por nombre y las que faltan van al final', () => {
    const { index, newHeaders } = mapColumns(
      ['Notas del liquidador', 'Estado', ' número '],
      [
        { header: 'Número', source: 'number' },
        { header: 'Estado', source: 'status' },
        { header: 'Patente', source: 'data.patente' },
      ],
    );
    assert.equal(index.get('number'), 2);
    assert.equal(index.get('status'), 1);
    assert.equal(index.get('data.patente'), 3);
    assert.deepEqual(newHeaders, [{ index: 3, header: 'Patente' }]);
  });

  test('la fila se encuentra por número, no por posición', () => {
    const rows = [['x', 'SIN-2026-000002'], [], ['y', 'SIN-2026-000001']];
    assert.equal(findRow(rows, 1, 'SIN-2026-000001'), 4); // fila 1 es el encabezado
    assert.equal(findRow(rows, 1, 'SIN-2026-000009'), 5); // nueva: después de la última
    assert.equal(findRow([], 0, 'SIN-2026-000009'), 2);
  });

  test('letras de columna y pestañas con espacios o comillas', () => {
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(25), 'Z');
    assert.equal(columnLetter(26), 'AA');
    assert.equal(columnLetter(701), 'ZZ');
    assert.equal(quoteTab("Reclamos d'autos"), "'Reclamos d''autos'");
  });
});

describe('Drive', () => {
  test('nombres de carpeta y archivos', () => {
    assert.equal(folderName('SIN-2026-000001', 'Robo total'), 'SIN-2026-000001 - Robo total');
    assert.equal(fileName('licencia', 'image', 2, '7/chat/msg/0.jpg'), 'licencia_2.jpg');
    assert.equal(fileName(null, 'image', 1, '7/chat/msg/0.jpg'), 'imagen_1.jpg');
    assert.equal(fileName(null, 'video', 1, '7/chat/msg/0.mp4'), 'video_1.mp4');
    assert.equal(folderName('SIN-1', 'Choque / granizo'), 'SIN-1 - Choque  granizo');
  });
});
