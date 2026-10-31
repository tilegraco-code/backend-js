import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSellable,
  itemIdFrom,
  orderNumberFrom,
  shapeFiscalDocuments,
  shapeItemDetail,
  shapeOrders,
  shapePaymentMethods,
  shapeShipment,
  shapeShippingOptions,
  shapeStock,
} from './mercadolibre-tools.shape';
import type { MercadolibreItem } from '../types/mercadolibre';

const item: MercadolibreItem = {
  id: 'MLA123456789',
  seller_id: 99,
  status: 'active',
  title: 'Remera algodón',
  price: 9000,
  original_price: 12000,
  currency_id: 'ARS',
  available_quantity: 7,
  condition: 'new',
  permalink: 'https://articulo.mercadolibre.com.ar/MLA-123456789-remera',
  shipping: { free_shipping: true, logistic_type: 'fulfillment' },
  sale_terms: [
    { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
    { id: 'WARRANTY_TIME', value_name: '30 días' },
  ],
  attributes: [
    { name: 'Marca', value_name: 'Acme' },
    { name: 'Material', value_name: null },
  ],
  variations: [
    { id: 1, available_quantity: 3, attribute_combinations: [{ name: 'Talle', value_name: 'M' }] },
    { id: 2, available_quantity: 0, price: 9500, attribute_combinations: [{ name: 'Talle', value_name: 'L' }] },
  ],
};

test('itemIdFrom: id pelado, con guion o dentro del link', () => {
  assert.equal(itemIdFrom('MLA123456789'), 'MLA123456789');
  assert.equal(itemIdFrom('mla-123456789'), 'MLA123456789');
  assert.equal(itemIdFrom('https://articulo.mercadolibre.com.ar/MLA-123456789-remera-_JM'), 'MLA123456789');
  assert.equal(itemIdFrom('remera roja'), null);
});

test('orderNumberFrom: solo dígitos, rechaza números cortos', () => {
  assert.equal(orderNumberFrom('#2000 0123 4567'), '200001234567');
  assert.equal(orderNumberFrom('123'), null);
});

test('isSellable: activa y del vendedor', () => {
  assert.equal(isSellable(item, 99), true);
  assert.equal(isSellable(item, 100), false);
  assert.equal(isSellable({ ...item, status: 'paused' }, 99), false);
});

test('shapeItemDetail: garantía de sale_terms, envío traducido, atributos sin vacíos', () => {
  const d = shapeItemDetail(item, 'Descripción larga');
  assert.equal(d.warranty, 'Garantía del vendedor, 30 días');
  assert.equal(d.original_price, 12000);
  assert.equal(d.condition, 'nuevo');
  assert.deepEqual(d.shipping, { free_shipping: true, local_pick_up: false, type: 'Mercado Envíos Full' });
  assert.deepEqual(d.attributes, ['Marca: Acme']);
  assert.equal(d.variants?.[1].price, 9500);
  assert.equal(d.description, 'Descripción larga');
});

test('shapeStock: suma las variantes', () => {
  const s = shapeStock(item);
  assert.equal(s.stock, 3);
  assert.equal(s.available, true);
  assert.deepEqual(s.variants?.map((v) => v.stock), [3, 0]);
  assert.equal(shapeStock({ ...item, variations: [], available_quantity: 0 }).available, false);
});

test('shapeShippingOptions: gratis, fecha estimada y destino', () => {
  const s = shapeShippingOptions(item, '1414', {
    options: [{ name: 'Normal a domicilio', cost: 0, list_cost: 5000, currency_id: 'ARS', estimated_delivery_time: { date: '2026-11-04T00:00:00.000-03:00' } }],
    destination: { city: { name: 'Palermo' }, state: { name: 'Capital Federal' } },
  });
  assert.equal(s.ships, true);
  assert.deepEqual(s.options[0], {
    name: 'Normal a domicilio',
    cost: 0,
    list_cost: 5000,
    free: true,
    currency: 'ARS',
    estimated_delivery: '2026-11-04',
  });
  assert.equal(s.destination, 'Palermo, Capital Federal');
});

test('shapeOrders: pack con varias órdenes, sin datos del comprador', () => {
  const o = shapeOrders(
    [
      {
        id: 1, status: 'paid', currency_id: 'ARS', total_amount: 100, date_created: '2026-10-01T10:00:00Z',
        buyer: { id: 5, nickname: 'COMPRADOR' }, shipping: { id: 77 },
        order_items: [{ item: { title: 'A' }, quantity: 1, unit_price: 100 }],
        payments: [{ status: 'approved', payment_type: 'credit_card', installments: 3 }],
      },
      { id: 2, status: 'paid', total_amount: 50, order_items: [{ item: { title: 'B' }, quantity: 2, unit_price: 25 }] },
    ],
    2000123,
  );
  assert.equal(o.order_number, '2000123');
  assert.equal(o.status, 'Pagada');
  assert.equal(o.total, 150);
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.payment, { status: 'aprobado', method: 'Tarjeta de crédito', installments: 3 });
  assert.equal(JSON.stringify(o).includes('COMPRADOR'), false);
});

test('shapeShipment: traduce estado y subestado, sin fecha estimada si ya llegó', () => {
  const s = shapeShipment(
    {
      id: 77, status: 'shipped', substatus: 'out_for_delivery', tracking_number: 'AB1', tracking_method: 'Correo',
      logistic: { type: 'cross_docking' }, lead_time: { estimated_delivery_time: { date: '2026-11-02T00:00:00Z' } },
      status_history: { date_shipped: '2026-10-30T12:00:00Z' },
      destination: { shipping_address: { city: { name: 'Rosario' }, state: { name: 'Santa Fe' } } },
    },
    '2000123',
  );
  assert.equal(s.status, 'En camino');
  assert.equal(s.detail, 'salió a reparto');
  assert.equal(s.estimated_delivery, '2026-11-02');
  assert.deepEqual(s.dates, { shipped: '2026-10-30' });
  assert.equal(s.destination, 'Rosario, Santa Fe');
  assert.equal(shapeShipment({ id: 1, status: 'delivered', lead_time: { estimated_delivery_time: { date: '2026-11-02' } } }, '1').estimated_delivery, undefined);
});

test('shapeFiscalDocuments: acepta lista u objeto', () => {
  assert.equal(shapeFiscalDocuments([], '1').has_invoice, false);
  assert.equal(shapeFiscalDocuments({ fiscal_documents: [{ date: '2026-10-02T00:00:00Z' }] }, '1').has_invoice, true);
});

test('shapePaymentMethods: agrupa por tipo y saca los inactivos', () => {
  const p = shapePaymentMethods([
    { id: 'visa', name: 'Visa', payment_type_id: 'credit_card', status: 'active' },
    { id: 'master', name: 'Mastercard', payment_type_id: 'credit_card', status: 'active' },
    { id: 'old', name: 'Vieja', payment_type_id: 'credit_card', status: 'deactive' },
    { id: 'rapipago', name: 'Rapipago', payment_type_id: 'ticket', status: 'active' },
  ]);
  assert.deepEqual(p.payment_methods, [
    { type: 'Tarjeta de crédito', methods: ['Visa', 'Mastercard'] },
    { type: 'Efectivo (pago en puntos de cobranza)', methods: ['Rapipago'] },
  ]);
});
