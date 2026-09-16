// Tests de la normalización de datos del caso. Correr con `pnpm test`.
//
// Lo que manda el modelo llega en cualquier formato ("10/09/2026", "Total", "si"). Se normaliza
// al guardar para que el evaluador, el Sheet y el dashboard vean siempre lo mismo.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { caseDefinitionSchema } from '../schemas/case-definition';

// cases.service importa el cliente de Supabase, que exige estas variables al cargarse.
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';

let sanitizeData: typeof import('./cases.service').sanitizeData;
before(async () => {
  ({ sanitizeData } = await import('./cases.service'));
});

const definition = caseDefinitionSchema.parse({
  data: [
    { key: 'patente', label: 'Patente' },
    { key: 'fecha_siniestro', label: 'Fecha', type: 'date' },
    { key: 'alcance', label: 'Alcance', type: 'enum', options: ['total', 'parcial'] },
    { key: 'hubo_heridos', label: 'Heridos', type: 'boolean' },
    { key: 'monto', label: 'Monto', type: 'number' },
  ],
});

describe('sanitizeData', () => {
  test('normaliza fechas locales, enums, booleanos y números', () => {
    const { data, ignored } = sanitizeData(definition, {}, {
      patente: '  AB123CD ',
      fecha_siniestro: '1/9/2026',
      alcance: 'TOTAL',
      hubo_heridos: 'Sí',
      monto: '1.250.000,50',
    });

    assert.deepEqual(data, {
      patente: 'AB123CD',
      fecha_siniestro: '2026-09-01',
      alcance: 'total',
      hubo_heridos: true,
      monto: 1250000.5,
    });
    assert.deepEqual(ignored, []);
  });

  test('ignora claves que no existen y lo informa', () => {
    const { data, ignored } = sanitizeData(definition, {}, { color: 'rojo', patente: 'AB123CD' });
    assert.deepEqual(data, { patente: 'AB123CD' });
    assert.deepEqual(ignored, ['color']);
  });

  test('mezcla con lo actual y borra con null o vacío', () => {
    const { data } = sanitizeData(
      definition,
      { patente: 'AB123CD', alcance: 'total', viejo: 'x' },
      { alcance: null, fecha_siniestro: '' , monto: 10 },
    );
    // `viejo` no existe en la definición (p. ej. tras cambiar de tipo): se descarta
    assert.deepEqual(data, { patente: 'AB123CD', monto: 10 });
  });

  test('lo que no se puede normalizar se guarda tal cual para que el evaluador lo marque', () => {
    const { data } = sanitizeData(definition, {}, { alcance: 'robo de rueda', fecha_siniestro: 'ayer' });
    assert.deepEqual(data, { alcance: 'robo de rueda', fecha_siniestro: 'ayer' });
  });
});
