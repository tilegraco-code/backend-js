import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldRole, mapDealTracking, pickDealForOrder } from './activecampaign-tracking.shape';
import { shapeOrderStatus } from './woocommerce.shape';

// Campos de deal tal como los tiene Café Delirante en ActiveCampaign.
const METAS = [
  { id: '1', fieldLabel: 'Fecha de cierre prevista', personalization: 'DEAL_FORECASTED_CLOSE_DATE' },
  { id: '2', fieldLabel: 'Tracking Correo Argentino', personalization: 'DEAL_TRACKING_CORREO_ARGENTINO' },
  { id: '6', fieldLabel: 'Fecha Estimada de Entrega', personalization: 'DEAL_FECHA_ESTIMADA_DE_ENTREGA' },
  { id: '8', fieldLabel: 'Informacion Privada', personalization: 'DEAL_INFORMACION_PRIVADA' },
  { id: '15', fieldLabel: 'Estado Envío Andreani', personalization: 'DEAL_ESTADO_ENVO_ANDREANI' },
  { id: '16', fieldLabel: 'Fecha Último Estado Andreani', personalization: 'DEAL_FECHA_LTIMO_ESTADO_ANDREANI' },
  { id: '17', fieldLabel: 'Último Evento Andreani', personalization: 'DEAL_LTIMO_EVENTO_ANDREANI' },
  { id: '18', fieldLabel: ' Tracking URL', personalization: 'DEAL_TRACKING_URL' },
];

test('fieldRole: reconoce los campos de envío por nombre', () => {
  const roles = Object.fromEntries(METAS.map((m) => [m.id, fieldRole(m)]));
  assert.deepEqual(roles, {
    '1': null, '2': 'number', '6': 'estimated_delivery', '8': null,
    '15': 'status', '16': 'last_update', '17': 'last_event', '18': 'link',
  });
});

test('mapDealTracking: deal real del pedido 40783', () => {
  const values = [
    { customFieldId: 2, fieldValue: '360003130325840' },
    { customFieldId: 6, fieldValue: '2026-10-20' },
    { customFieldId: 8, fieldValue: 'nota interna' },
    { customFieldId: 15, fieldValue: 'entregado' },
    { customFieldId: 16, fieldValue: '2026-10-17 10:09:21' },
    { customFieldId: 17, fieldValue: 'Tu envío de CAFE DELIRANTE fue entregado' },
    { customFieldId: 18, fieldValue: 'https://www.andreani.com/envio/360003130325840' },
  ];
  assert.deepEqual(mapDealTracking(values, METAS), {
    carrier: 'Andreani',
    number: '360003130325840',
    link: 'https://www.andreani.com/envio/360003130325840',
    shipped: null,
    status: 'entregado',
    last_event: 'Tu envío de CAFE DELIRANTE fue entregado',
    last_update: '2026-10-17',
    estimated_delivery: '2026-10-20',
  });
});

test('mapDealTracking: sin link ni número no hay seguimiento (y no se filtra info privada)', () => {
  assert.equal(mapDealTracking([{ customFieldId: 8, fieldValue: 'nota interna' }, { customFieldId: 6, fieldValue: '2026-10-20' }], METAS), null);
  assert.equal(mapDealTracking([{ customFieldId: 18, fieldValue: 'no es un link' }], METAS), null);
});

test('pickDealForOrder: el deal creado más cerca del pedido, dentro de la ventana', () => {
  const deals = [
    { id: '23926', cdate: '2026-02-13T09:50:30-06:00' },
    { id: '26847', cdate: '2026-10-13T23:02:14-05:00' }, // = 04:02 UTC del 14/10
    { id: '99999', cdate: '2026-10-25T10:00:00-05:00' }, // otro pedido, 11 días después
  ];
  assert.equal(pickDealForOrder(deals, '2026-10-14T04:01:00Z')?.id, '26847');
  // Un pedido sin deal cercano no toma uno de otra compra.
  assert.equal(pickDealForOrder(deals, '2026-06-01T12:00:00Z'), null);
  assert.equal(pickDealForOrder(deals, null), null);
});

test('shapeOrderStatus: usa el seguimiento externo si la tienda no tiene', () => {
  const ext = mapDealTracking([{ customFieldId: 18, fieldValue: 'https://www.andreani.com/envio/1' }], METAS)!;
  const out = shapeOrderStatus({ id: 1, status: 'completed' }, [], [], [ext]);
  assert.deepEqual((out.tracking as { link: string }[])[0].link, 'https://www.andreani.com/envio/1');
  // Lo de la tienda gana sobre lo externo.
  const own = shapeOrderStatus({ id: 1, status: 'completed' }, [], [{ tracking_number: 'X1', tracking_link: 'https://t/x1' }], [ext]);
  assert.equal((own.tracking as { link: string }[])[0].link, 'https://t/x1');
});

test('extractTracking: ignora las marcas de analítica del pedido ("tracked" = "1")', () => {
  const meta = [
    { key: '_gtmkit_order_tracked', value: '1' },
    { key: '_meta_purchase_tracked_browser', value: '1' },
    { key: '_meta_purchase_tracked_server', value: '1' },
  ];
  const ext = mapDealTracking([{ customFieldId: 18, fieldValue: 'https://www.andreani.com/envio/360003130325840' }], METAS)!;
  const out = shapeOrderStatus({ id: 40783, status: 'completed', meta_data: meta }, [], [], [ext]);
  assert.equal((out.tracking as { link: string }[])[0].link, 'https://www.andreani.com/envio/360003130325840');
  // Un campo de seguimiento real del pedido sí se toma.
  const own = shapeOrderStatus({ id: 1, status: 'completed', meta_data: [{ key: '_tracking_number', value: 'AB123456' }] }, []);
  assert.equal((own.tracking as { number: string }[])[0].number, 'AB123456');
});
