// Tests del esquema de configuración de casos y de las plantillas. Correr con `pnpm test`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { caseConfigSchema } from './case-config';
import { CASE_TEMPLATES } from './case-templates';

const base = () => ({
  settings: { enabled: true, number_prefix: 'sin', drive_parent_id: null, sheet_id: null, sheet_tab: null },
  document_types: [{ key: 'dni', label: 'DNI', description: 'Documento' }],
  case_types: [
    { key: 'robo', label: 'Robo', description: 'Robo', active: true, definition: { data: [], documents: [{ type: 'dni' }] } },
  ],
});

describe('caseConfigSchema', () => {
  test('las plantillas son válidas', () => {
    for (const t of CASE_TEMPLATES) {
      const r = caseConfigSchema.safeParse(t.config);
      assert.ok(r.success, `${t.key}: ${JSON.stringify(!r.success && r.error.issues)}`);
    }
  });

  test('normaliza el prefijo y extrae ids de las URLs de Google', () => {
    const config = base();
    config.settings = {
      ...config.settings,
      drive_parent_id: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing',
      sheet_id: 'https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLk_-9/edit#gid=0',
      sheet_tab: 'Reclamos',
    } as never;
    const parsed = caseConfigSchema.parse(config);
    assert.equal(parsed.settings.number_prefix, 'SIN');
    assert.equal(parsed.settings.drive_parent_id, '1AbCdEfGhIjKlMnOp');
    assert.equal(parsed.settings.sheet_id, '1ZyXwVuTsRqPoNmLk_-9');
  });

  test('rechaza un tipo de caso que pide un documento que no existe', () => {
    const config = base();
    config.case_types[0].definition.documents = [{ type: 'pasaporte' }];
    const r = caseConfigSchema.safeParse(config);
    assert.equal(r.success, false);
    assert.match(JSON.stringify(!r.success && r.error.issues), /no está en la lista de documentos/);
  });

  test('no se puede activar sin tipos activos, ni poner un Sheet sin pestaña, ni un link cualquiera', () => {
    const sinTipos = { ...base(), case_types: [] };
    assert.equal(caseConfigSchema.safeParse(sinTipos).success, false);

    const sinPestana = base();
    sinPestana.settings = { ...sinPestana.settings, sheet_id: '1ZyXwVuTsRqPoNmLk_-9' } as never;
    assert.equal(caseConfigSchema.safeParse(sinPestana).success, false);

    const linkRaro = base();
    linkRaro.settings = { ...linkRaro.settings, drive_parent_id: 'https://example.com/algo' } as never;
    assert.equal(caseConfigSchema.safeParse(linkRaro).success, false);
  });

  test('desactivado se puede guardar sin tipos de caso', () => {
    const config = { ...base(), case_types: [], settings: { ...base().settings, enabled: false } };
    assert.equal(caseConfigSchema.safeParse(config).success, true);
  });
});
