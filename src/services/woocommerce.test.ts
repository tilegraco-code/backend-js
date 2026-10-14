import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseOf, normalizeStoreUrl, WooError } from './woocommerce-api.service';
import {
  matchShippingZone,
  orderBelongsTo,
  postcodeMatches,
  resolveStateCode,
  shapeOrderStatus,
  shapeProduct,
  shapeReview,
  shapeShippingMethod,
  type ZoneWithRules,
} from './woocommerce.shape';

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

// ── Envíos ──

const zone = (id: number, order: number, locations: ZoneWithRules['locations']): ZoneWithRules => ({
  id, name: `zona ${id}`, order, locations, methods: [],
});

const ZONES: ZoneWithRules[] = [
  zone(1, 0, [{ type: 'state', code: 'AR:C' }]), // CABA
  zone(2, 1, [{ type: 'country', code: 'AR' }, { type: 'postcode', code: '5000...5999' }]), // Córdoba por CP
  zone(3, 2, [{ type: 'country', code: 'AR' }]), // resto del país
  zone(0, 99, []), // resto del mundo
];

test('postcodeMatches: exacto, comodín y rango', () => {
  assert.equal(postcodeMatches('1425', '1425'), true);
  assert.equal(postcodeMatches('14*', '1425'), true);
  assert.equal(postcodeMatches('5000...5999', '5010'), true);
  assert.equal(postcodeMatches('5000...5999', 'X5010'), true);
  assert.equal(postcodeMatches('5000...5999', '6000'), false);
});

test('matchShippingZone: elige la primera zona que aplica, como WooCommerce', () => {
  assert.equal((matchShippingZone(ZONES, { country: 'AR', state: 'C', postcode: '1425' }) as ZoneWithRules).id, 1);
  assert.equal((matchShippingZone(ZONES, { country: 'AR', state: 'X', postcode: '5010' }) as ZoneWithRules).id, 2);
  assert.equal((matchShippingZone(ZONES, { country: 'AR', state: 'S', postcode: '2000' }) as ZoneWithRules).id, 3);
  assert.equal((matchShippingZone(ZONES, { country: 'UY', state: null }) as ZoneWithRules).id, 0);
});

test('matchShippingZone: pide provincia o CP cuando la respuesta depende de eso', () => {
  assert.equal(matchShippingZone(ZONES, { country: 'AR' }), 'needs_state');
  assert.equal(matchShippingZone(ZONES, { country: 'AR', state: 'X' }), 'needs_postcode');
});

test('resolveStateCode: por nombre sin acentos, código o alias', () => {
  const ar = { code: 'AR', states: [{ code: 'C', name: 'Ciudad Autónoma de Buenos Aires' }, { code: 'B', name: 'Buenos Aires' }, { code: 'X', name: 'Córdoba' }] };
  assert.equal(resolveStateCode(ar, 'cordoba'), 'X');
  assert.equal(resolveStateCode(ar, 'x'), 'X');
  assert.equal(resolveStateCode(ar, 'CABA'), 'C');
  assert.equal(resolveStateCode(ar, 'Buenos Aires'), 'B');
  assert.equal(resolveStateCode(ar, 'Mendoza'), null);
});

test('shapeShippingMethod: gratis con mínimo, tarifa plana y fórmulas', () => {
  assert.deepEqual(
    shapeShippingMethod({ method_id: 'free_shipping', title: 'Gratis', settings: { requires: { value: 'min_amount' }, min_amount: { value: '50000' } } }),
    { method: 'Gratis', type: 'envío gratis', cost: '0', condition: 'compra mínima de 50000' },
  );
  assert.deepEqual(shapeShippingMethod({ method_id: 'flat_rate', title: 'Correo', settings: { cost: { value: '3500' } } }), {
    method: 'Correo', type: 'tarifa plana', cost: '3500',
  });
  assert.equal(shapeShippingMethod({ method_id: 'flat_rate', settings: { cost: { value: '1000 * [qty]' } } }).cost, null);
  assert.equal(shapeShippingMethod({ method_id: 'andreani', title: 'Andreani' }).type, 'cotizado por la tienda');
});

// ── Reseñas y pedidos ──

test('shapeReview: sólo el nombre de pila y texto sin HTML', () => {
  assert.deepEqual(
    shapeReview({ id: 1, reviewer: 'Ana García', review: '<p>Muy buena</p>', rating: 5, verified: true, date_created: '2026-10-01T10:00:00' }),
    { rating: 5, review: 'Muy buena', author: 'Ana', verified_buyer: true, date: '2026-10-01' },
  );
});

test('shapeOrderStatus: estado en castellano y sin datos personales', () => {
  const order = {
    id: 77,
    number: '1077',
    status: 'processing',
    total: '25000',
    currency: 'ARS',
    date_created: '2026-10-10T12:00:00',
    date_paid: '2026-10-10T12:05:00',
    payment_method_title: 'Transferencia',
    payment_url: 'https://t.com/pagar',
    line_items: [{ name: 'Buzo - M', quantity: 1, total: '21500' }],
    shipping_lines: [{ method_title: 'Correo', total: '3500' }],
    shipping: { city: 'Córdoba', state: 'X', country: 'AR' },
    billing: { first_name: 'Ana', last_name: 'García', email: 'ana@mail.com', phone: '351555', address_1: 'Calle 123' } as never,
    refunds: [],
  };
  const out = shapeOrderStatus(order, [{ id: 1, note: 'Sale mañana', customer_note: true, date_created: '2026-10-11T09:00:00' }]);
  assert.equal(out.status, 'En preparación');
  assert.equal(out.order_number, '1077');
  assert.deepEqual(out.shipping, { method: 'Correo', cost: '3500', city: 'Córdoba' });
  assert.deepEqual(out.notes_from_store, [{ date: '2026-10-11', note: 'Sale mañana' }]);
  // Ya pagado: no se manda link de pago.
  assert.equal('payment_url' in out, false);
  const text = JSON.stringify(out);
  for (const pii of ['ana@mail.com', 'García', '351555', 'Calle 123']) assert.equal(text.includes(pii), false, pii);
});

test('shapeOrderStatus: pendiente de pago incluye el link para pagar', () => {
  const out = shapeOrderStatus({ id: 1, status: 'pending', payment_url: 'https://t.com/pagar' }, []);
  assert.equal(out.status, 'Pendiente de pago');
  assert.equal(out.payment_url, 'https://t.com/pagar');
});

test('orderBelongsTo: el email tiene que coincidir (sin importar mayúsculas ni espacios)', () => {
  const order = { id: 1, billing: { email: 'Ana@Mail.com' } };
  assert.equal(orderBelongsTo(order, ' ana@mail.com '), true);
  assert.equal(orderBelongsTo(order, 'otra@mail.com'), false);
  // Pedido sin email cargado: no se le muestra a nadie.
  assert.equal(orderBelongsTo({ id: 2 }, ''), false);
  assert.equal(orderBelongsTo({ id: 2, billing: { email: '' } }, ''), false);
});
