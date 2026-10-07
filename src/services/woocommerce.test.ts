import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseOf, normalizeStoreUrl, WooError } from './woocommerce-api.service';
import { shapeProduct } from './woocommerce.shape';

test('normalizeStoreUrl: agrega https, saca barra final, query y /wp-admin', () => {
  assert.equal(baseOf(normalizeStoreUrl('mitienda.com.ar/')), 'https://mitienda.com.ar');
  assert.equal(baseOf(normalizeStoreUrl('https://mitienda.com/shop/?utm=x#a')), 'https://mitienda.com/shop');
  assert.equal(baseOf(normalizeStoreUrl('https://mitienda.com/wp-admin/admin.php')), 'https://mitienda.com');
  assert.equal(baseOf(normalizeStoreUrl('https://mitienda.com/wp-json/wc/v3')), 'https://mitienda.com');
});

test('normalizeStoreUrl: rechaza http, credenciales e IPs internas', () => {
  assert.throws(() => normalizeStoreUrl('http://mitienda.com'), /HTTPS/);
  assert.throws(() => normalizeStoreUrl('https://user:pass@mitienda.com'), WooError);
  assert.throws(() => normalizeStoreUrl('https://127.0.0.1'), /red interna/);
  assert.throws(() => normalizeStoreUrl('https://169.254.169.254'), /red interna/);
  assert.throws(() => normalizeStoreUrl('ftp://mitienda.com'), WooError);
});

test('shapeProduct: producto simple aplana precio y stock', () => {
  const p = shapeProduct(
    {
      id: 10,
      name: 'Remera',
      type: 'simple',
      purchasable: true,
      price: '9000',
      regular_price: '12000',
      manage_stock: true,
      stock_quantity: 4,
      short_description: '<p>Algodón&nbsp;peinado</p>',
      categories: [{ name: 'Ropa' }],
    },
    [],
  );
  assert.deepEqual(p, {
    product_id: 10,
    name: 'Remera',
    url: null,
    categories: ['Ropa'],
    description: 'Algodón peinado',
    purchasable: true,
    price: '9000',
    regular_price: '12000',
    stock: 4,
  });
});

test('shapeProduct: variable lista variantes y hereda stock del padre', () => {
  const p = shapeProduct(
    { id: 20, name: 'Buzo', type: 'variable', purchasable: true, stock_status: 'instock', variations: [21, 22, 23] },
    [
      { id: 21, price: '20000', regular_price: '20000', attributes: [{ name: 'Talle', option: 'M' }], manage_stock: 'parent' },
      { id: 22, price: '20000', attributes: [{ name: 'Talle', option: 'L' }], stock_status: 'outofstock' },
      { id: 23, price: '', purchasable: false, attributes: [{ name: 'Talle', option: 'XL' }] },
    ],
  );
  assert.equal(p.price, undefined);
  assert.deepEqual(p.variants, [
    { variation_id: 21, options: ['Talle: M'], price: '20000', stock: 'disponible' },
    { variation_id: 22, options: ['Talle: L'], price: '20000', stock: 0 },
  ]);
});

test('shapeProduct: grouped / external no son comprables', () => {
  assert.equal(shapeProduct({ id: 1, type: 'external', purchasable: true }, []).purchasable, false);
  assert.equal(shapeProduct({ id: 2, type: 'grouped', purchasable: true }, []).purchasable, false);
});
