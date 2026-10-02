import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpRequest, isBlockedAddress, type HttpToolConfig } from './http-tool.request';

const base: HttpToolConfig = {
  url: 'https://api.ejemplo.com/orders/{numero}',
  method: 'POST',
  params: [
    { name: 'numero', type: 'string', description: '', required: true, location: 'path' },
    { name: 'estado', type: 'string', description: '', required: false, location: 'query' },
    { name: 'cantidad', type: 'number', description: '', required: false, location: 'body' },
  ],
};

test('path, query y body salen de los params', () => {
  const r = buildHttpRequest(
    { ...base, query_params: { lang: 'es' }, body_template: '{"fuente":"tilegra"}' },
    null,
    { numero: 'A 12', estado: 'pago', cantidad: '3' },
  );
  assert.equal(r.url.pathname, '/orders/A%2012');
  assert.equal(r.url.searchParams.get('estado'), 'pago');
  assert.equal(r.url.searchParams.get('lang'), 'es');
  assert.deepEqual(JSON.parse(r.body!), { fuente: 'tilegra', cantidad: 3 });
  assert.equal(r.headers['Content-Type'], 'application/json');
});

test('falta un obligatorio → error con el nombre', () => {
  assert.throws(() => buildHttpRequest(base, null, {}), /numero/);
});

test('número inválido → error', () => {
  assert.throws(() => buildHttpRequest(base, null, { numero: '1', cantidad: 'muchos' }), /cantidad/);
});

test('auth: bearer, header, query y basic', () => {
  const get = { url: 'https://api.x.com/a', method: 'GET' as const };
  assert.equal(
    buildHttpRequest({ ...get, auth: { type: 'bearer' } }, 'tok', {}).headers.Authorization,
    'Bearer tok',
  );
  assert.equal(
    buildHttpRequest({ ...get, auth: { type: 'header', name: 'X-API-Key' } }, 'k1', {}).headers['X-API-Key'],
    'k1',
  );
  assert.equal(
    buildHttpRequest({ ...get, auth: { type: 'query', name: 'api_key' } }, 'k2', {}).url.searchParams.get('api_key'),
    'k2',
  );
  assert.equal(
    buildHttpRequest({ ...get, auth: { type: 'basic', username: 'u' } }, 'p', {}).headers.Authorization,
    `Basic ${Buffer.from('u:p').toString('base64')}`,
  );
});

test('auth sin secreto cargado → error', () => {
  assert.throws(
    () => buildHttpRequest({ url: 'https://api.x.com', method: 'GET', auth: { type: 'bearer' } }, null, {}),
    /token/,
  );
});

test('GET no lleva body', () => {
  const r = buildHttpRequest(
    { url: 'https://api.x.com', method: 'GET', params: [{ name: 'q', type: 'string', description: '', required: false, location: 'body' }] },
    null,
    { q: 'x' },
  );
  assert.equal(r.body, undefined);
});

test('URL inválida, otro protocolo o con credenciales → error', () => {
  assert.throws(() => buildHttpRequest({ url: 'no es url', method: 'GET' }, null, {}), /válida/);
  assert.throws(() => buildHttpRequest({ url: 'file:///etc/passwd', method: 'GET' }, null, {}), /http/);
  assert.throws(() => buildHttpRequest({ url: 'https://u:p@api.x.com', method: 'GET' }, null, {}), /Autenticación/);
});

test('IP literal interna → bloqueada', () => {
  for (const url of ['http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://10.0.0.5', 'http://[::1]/']) {
    assert.throws(() => buildHttpRequest({ url, method: 'GET' }, null, {}), /red interna/, url);
  }
});

test('isBlockedAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});
