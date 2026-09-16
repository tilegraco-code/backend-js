// Tests de cuándo una revisión que terminó fuera del turno merece un aviso al cliente.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';

let worthNotifying: typeof import('./chat-documents.service').worthNotifying;
before(async () => {
  ({ worthNotifying } = await import('./chat-documents.service'));
});

const view = (status: 'open' | 'complete') => ({ status }) as Parameters<typeof worthNotifying>[2];
const ready = (doc_type: string | null, legible = true) =>
  ({ kind: 'ready', result: { summary: '', legible, doc_type } }) as const;

describe('worthNotifying', () => {
  const expected = ['licencia', 'dni'];

  test('un documento esperado que se lee no justifica un mensaje', () => {
    assert.equal(worthNotifying(ready('licencia'), expected, view('open')), false);
  });

  test('ilegible, "otro" o un documento que no se pidió: hay que avisar', () => {
    assert.equal(worthNotifying(ready('licencia', false), expected, view('open')), true);
    assert.equal(worthNotifying(ready('otro'), expected, view('open')), true);
    assert.equal(worthNotifying(ready('titulo'), expected, view('open')), true);
  });

  test('caso completo: siempre se avisa', () => {
    assert.equal(worthNotifying(ready('licencia'), expected, view('complete')), true);
  });

  test('falla: solo si es definitiva (si se reintenta, todavía puede salir bien)', () => {
    assert.equal(worthNotifying({ kind: 'failed', permanent: true }, expected, view('open')), true);
    assert.equal(worthNotifying({ kind: 'failed', permanent: false }, expected, view('open')), false);
  });
});
