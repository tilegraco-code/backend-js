// Tests del evaluador de requisitos. Correr con `pnpm test`.
//
// Lo que se cuida: que "qué falta" salga de la configuración y los documentos, nunca de lo que
// supone el modelo. Un falso "está completo" hace que el liquidador reciba un reclamo sin la
// denuncia; un falso "falta algo" hace que el agente le pida al cliente lo que ya mandó.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCase, normalize, type EvaluableDocument } from './case-evaluator';
import { caseDefinitionSchema, caseRequirementsSchema, type CaseRequirements } from '../schemas/case-definition';

const catalog = {
  dni: { key: 'dni', label: 'DNI', description: 'Documento nacional de identidad', fields: [{ key: 'numero', label: 'Número', type: 'string' as const }] },
  cedula_verde: {
    key: 'cedula_verde',
    label: 'Cédula del vehículo',
    description: 'Cédula verde o azul',
    fields: [{ key: 'patente', label: 'Patente', type: 'string' as const }],
  },
  licencia: {
    key: 'licencia',
    label: 'Licencia de conducir',
    description: 'Carnet de conducir',
    fields: [{ key: 'vencimiento', label: 'Vencimiento', type: 'date' as const }],
  },
  denuncia_policial: { key: 'denuncia_policial', label: 'Denuncia policial', description: 'Denuncia', fields: [] },
  titulo: { key: 'titulo', label: 'Título del automotor', description: 'Título', fields: [] },
  foto_faltante: { key: 'foto_faltante', label: 'Fotos de lo robado', description: 'Fotos', fields: [] },
};

function robo(): CaseRequirements {
  return caseRequirementsSchema.parse({
    case_type: 'robo',
    label: 'Robo',
    catalog,
    definition: {
      data: [
        { key: 'patente', label: 'Patente' },
        { key: 'fecha_siniestro', label: 'Fecha del siniestro', type: 'date' },
        { key: 'alcance', label: 'Alcance del robo', type: 'enum', options: ['total', 'parcial'] },
        { key: 'comentarios', label: 'Comentarios', required: false },
      ],
      documents: [
        { type: 'denuncia_policial' },
        { type: 'dni', min: 2, hint: 'Frente y dorso' },
        { type: 'cedula_verde', checks: [{ field: 'patente', op: 'equals', value: 'data.patente' }] },
        { type: 'licencia', checks: [{ field: 'vencimiento', op: 'after', value: 'data.fecha_siniestro' }] },
        { type: 'titulo', when: [{ field: 'data.alcance', op: 'equals', value: 'total' }] },
        { type: 'foto_faltante', when: [{ field: 'data.alcance', op: 'equals', value: 'parcial' }] },
      ],
    },
  });
}

let nextId = 1;
function doc(doc_type: string, extra: Partial<EvaluableDocument> = {}): EvaluableDocument {
  return {
    id: nextId++,
    doc_type,
    status: 'ready',
    legible: true,
    issues: [],
    extracted: null,
    duplicate_of: null,
    ...extra,
  };
}

const datosCompletos = { patente: 'AB123CD', fecha_siniestro: '2026-09-10', alcance: 'total' };

function documentosCompletos(): EvaluableDocument[] {
  return [
    doc('denuncia_policial'),
    doc('dni'),
    doc('dni'),
    doc('cedula_verde', { extracted: { patente: 'AB 123 CD' } }),
    doc('licencia', { extracted: { vencimiento: '01/03/2027' } }),
    doc('titulo'),
  ];
}

describe('evaluateCase', () => {
  test('completo cuando están todos los datos y documentos y los checks pasan', () => {
    const ev = evaluateCase(robo(), datosCompletos, documentosCompletos());
    assert.equal(ev.complete, true, JSON.stringify(ev, null, 2));
  });

  test('un caso recién abierto pide los datos y los documentos que no dependen de datos', () => {
    const ev = evaluateCase(robo(), {}, []);

    assert.equal(ev.complete, false);
    assert.deepEqual(ev.missing_data.map((d) => d.key), ['patente', 'fecha_siniestro', 'alcance']);
    // título y fotos dependen del alcance: todavía no se piden
    assert.deepEqual(ev.missing_documents.map((d) => d.type), ['denuncia_policial', 'dni', 'cedula_verde', 'licencia']);
  });

  test('los requisitos condicionales siguen al dato', () => {
    const total = evaluateCase(robo(), datosCompletos, []);
    const parcial = evaluateCase(robo(), { ...datosCompletos, alcance: 'parcial' }, []);

    const tipos = (ev: typeof total) => ev.missing_documents.map((d) => d.type);
    assert.ok(tipos(total).includes('titulo'));
    assert.ok(!tipos(total).includes('foto_faltante'));
    assert.ok(tipos(parcial).includes('foto_faltante'));
    assert.ok(!tipos(parcial).includes('titulo'));
  });

  test('cuenta la cantidad mínima', () => {
    const docs = documentosCompletos().filter((d) => d.doc_type !== 'dni').concat(doc('dni'));
    const ev = evaluateCase(robo(), datosCompletos, docs);

    assert.deepEqual(ev.missing_documents, [
      { type: 'dni', label: 'DNI', hint: 'Frente y dorso', have: 1, need: 2 },
    ]);
  });

  test('un documento ilegible no cuenta y se informa con sus problemas', () => {
    const docs = documentosCompletos().filter((d) => d.doc_type !== 'denuncia_policial');
    const borrosa = doc('denuncia_policial', { legible: false, issues: ['la foto está movida'] });
    const ev = evaluateCase(robo(), datosCompletos, [...docs, borrosa]);

    assert.equal(ev.complete, false);
    assert.equal(ev.missing_documents[0].type, 'denuncia_policial');
    assert.deepEqual(ev.illegible, [
      { document_id: borrosa.id, type: 'denuncia_policial', label: 'Denuncia policial', issues: ['la foto está movida'] },
    ]);
  });

  test('un duplicado no suma: dos veces la misma foto del DNI no son frente y dorso', () => {
    const docs = documentosCompletos().filter((d) => d.doc_type !== 'dni');
    const frente = doc('dni');
    const ev = evaluateCase(robo(), datosCompletos, [...docs, frente, doc('dni', { duplicate_of: frente.id })]);

    assert.equal(ev.missing_documents[0]?.type, 'dni');
    assert.equal(ev.missing_documents[0]?.have, 1);
  });

  test('check que no coincide: mensaje con los dos valores', () => {
    const docs = documentosCompletos().map((d) =>
      d.doc_type === 'cedula_verde' ? { ...d, extracted: { patente: 'AC123CD' } } : d,
    );
    const ev = evaluateCase(robo(), datosCompletos, docs);

    assert.equal(ev.complete, false);
    assert.equal(ev.failed_checks.length, 1);
    assert.match(ev.failed_checks[0].message, /AC123CD/);
    assert.match(ev.failed_checks[0].message, /AB123CD/);
  });

  test('alcanza con que uno de los documentos del tipo pase los checks', () => {
    const otraCedula = doc('cedula_verde', { extracted: { patente: 'ZZ999ZZ' } });
    const ev = evaluateCase(robo(), datosCompletos, [...documentosCompletos(), otraCedula]);

    assert.equal(ev.complete, true, JSON.stringify(ev.failed_checks));
  });

  test('check de fecha: licencia vencida antes del siniestro', () => {
    const docs = documentosCompletos().map((d) =>
      d.doc_type === 'licencia' ? { ...d, extracted: { vencimiento: '2026-03-01' } } : d,
    );
    const ev = evaluateCase(robo(), datosCompletos, docs);

    assert.equal(ev.failed_checks.length, 1);
    assert.match(ev.failed_checks[0].message, /01\/03\/2026/);
    assert.match(ev.failed_checks[0].message, /posterior a 10\/09\/2026/);
  });

  test('sin el dato del caso, el check queda pendiente y NO es una falla', () => {
    const { patente: _, ...sinPatente } = datosCompletos;
    const ev = evaluateCase(robo(), sinPatente, documentosCompletos());

    assert.equal(ev.failed_checks.length, 0);
    assert.deepEqual(ev.pending_checks, [{ type: 'cedula_verde', label: 'Cédula del vehículo', waiting_for: 'Patente' }]);
    assert.equal(ev.complete, false);
  });

  test('si el documento no trae el dato extraído, es una falla legible', () => {
    const docs = documentosCompletos().map((d) => (d.doc_type === 'cedula_verde' ? { ...d, extracted: {} } : d));
    const ev = evaluateCase(robo(), datosCompletos, docs);

    assert.equal(ev.failed_checks.length, 1);
    assert.match(ev.failed_checks[0].message, /No se puede leer «Patente»/);
  });

  test('el mensaje configurado reemplaza al generado', () => {
    const req = robo();
    req.definition.documents[2].checks[0].message = 'La cédula no es del auto del reclamo';
    const docs = documentosCompletos().map((d) =>
      d.doc_type === 'cedula_verde' ? { ...d, extracted: { patente: 'AC123CD' } } : d,
    );
    const ev = evaluateCase(req, datosCompletos, docs);

    assert.equal(ev.failed_checks[0].message, 'La cédula no es del auto del reclamo');
  });

  test('un documento en proceso impide dar el caso por completo', () => {
    const ev = evaluateCase(robo(), datosCompletos, [...documentosCompletos(), doc('', { doc_type: null, status: 'processing' })]);
    assert.equal(ev.processing, 1);
    assert.equal(ev.complete, false);
  });

  test('un failed con reintentos cuenta como en proceso; uno definitivo no', () => {
    const reintentando = doc('dni', { status: 'failed', retrying: true });
    const definitivo = doc('dni', { status: 'failed', retrying: false });

    assert.equal(evaluateCase(robo(), datosCompletos, [...documentosCompletos(), reintentando]).processing, 1);
    assert.equal(evaluateCase(robo(), datosCompletos, [...documentosCompletos(), definitivo]).complete, true);
  });

  test('datos inválidos', () => {
    const ev = evaluateCase(robo(), { ...datosCompletos, fecha_siniestro: '31/02/2026', alcance: 'robo de rueda' }, documentosCompletos());

    assert.deepEqual(ev.invalid_data.map((d) => d.key), ['fecha_siniestro', 'alcance']);
    assert.equal(ev.complete, false);
  });

  test('los opcionales no se piden', () => {
    const ev = evaluateCase(robo(), datosCompletos, documentosCompletos());
    assert.ok(!ev.missing_data.some((d) => d.key === 'comentarios'));
  });
});

describe('normalize', () => {
  test('patentes y documentos escritos de distintas formas', () => {
    assert.equal(normalize('ab-123 cd'), normalize('AB123CD'));
    assert.equal(normalize('12.345.678'), normalize('12345678'));
    assert.equal(normalize('Pérez'), normalize('PEREZ'));
  });
});

describe('caseDefinitionSchema', () => {
  test('rechaza referencias a datos que no existen', () => {
    const r = caseDefinitionSchema.safeParse({
      data: [{ key: 'patente', label: 'Patente' }],
      documents: [{ type: 'cedula_verde', checks: [{ field: 'patente', op: 'equals', value: 'data.dominio' }] }],
    });
    assert.equal(r.success, false);
  });

  test('rechaza datos repetidos, enum sin opciones e in sin lista', () => {
    assert.equal(
      caseDefinitionSchema.safeParse({ data: [{ key: 'a', label: 'A' }, { key: 'a', label: 'A2' }] }).success,
      false,
    );
    assert.equal(caseDefinitionSchema.safeParse({ data: [{ key: 'a', label: 'A', type: 'enum' }] }).success, false);
    assert.equal(
      caseDefinitionSchema.safeParse({
        data: [{ key: 'a', label: 'A' }],
        documents: [{ type: 'x', when: [{ field: 'data.a', op: 'in', value: 'no-es-lista' }] }],
      }).success,
      false,
    );
  });

  test('aplica defaults: requerido, min 1, sin condiciones ni checks', () => {
    const def = caseDefinitionSchema.parse({ data: [{ key: 'a', label: 'A' }], documents: [{ type: 'x' }] });
    assert.equal(def.data[0].required, true);
    assert.equal(def.data[0].type, 'string');
    assert.deepEqual(def.documents[0], { type: 'x', min: 1, when: [], checks: [] });
  });
});
