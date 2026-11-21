import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGoogleSheetId, findSheetTabs, findSheetTitle } from '../lib/google-sheet';

test('extractGoogleSheetId: link, id pelado y basura', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
  assert.equal(extractGoogleSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(extractGoogleSheetId(`  ${id} `), id);
  assert.equal(extractGoogleSheetId('https://docs.google.com/document/d/xyz/edit'), null);
  assert.equal(extractGoogleSheetId('mi planilla de stock'), null);
});

test('findSheetTitle/Tabs: respuesta plana o envuelta', () => {
  const raw = { properties: { title: 'Stock' }, sheets: [{ properties: { title: 'Hoja 1' } }, { properties: { title: 'Precios' } }] };
  for (const data of [raw, { data: raw }, { response_data: raw }]) {
    assert.equal(findSheetTitle(data), 'Stock');
    assert.deepEqual(findSheetTabs(data), ['Hoja 1', 'Precios']);
  }
});
