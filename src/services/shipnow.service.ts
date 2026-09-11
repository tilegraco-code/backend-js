// Conexión + consulta de estado de envíos en shipnow.
// - Conexión: tabla shipnow_connections (1 fila por client_id), token fijo sin OAuth.
// - Consulta: no cacheamos. A diferencia de los productos de TiendaNube, el estado
//   de un envío cambia durante el día y una respuesta vieja es peor que una lenta.
import { supabase } from '../lib/supabase';
import { shipnowApiService, ShipnowOrder } from './shipnow-api.service';

export type ShipnowConnection = {
  id: number;
  client_id: number;
  api_token: string;
  account_name: string | null;
  connected_at: string;
};

// Estados del pedido dentro de shipnow (preparación). Ver "Estados de pedidos"
// en la doc. El texto es el que va a terminar leyendo el comprador, así que
// está escrito en segunda persona y sin jerga de depósito.
const ORDER_STATUS: Record<string, { estado: string; detalle: string }> = {
  awaiting_payment: { estado: 'Esperando el pago', detalle: 'Todavía no se confirmó el pago, así que el pedido no empezó a prepararse.' },
  new: { estado: 'Pedido recibido', detalle: 'El pedido está confirmado y entra en preparación.' },
  ready_to_pick: { estado: 'En preparación', detalle: 'Ya se reservó el stock y está por empezar la preparación.' },
  picking_list: { estado: 'En preparación', detalle: 'Se están juntando los productos del pedido en el depósito.' },
  packing_slip: { estado: 'En preparación', detalle: 'El pedido se está embalando.' },
  ready_to_ship: { estado: 'Listo para despachar', detalle: 'El pedido está embalado y esperando que lo retire el correo.' },
  shipped: { estado: 'En camino', detalle: 'El pedido ya está en manos del correo.' },
  delivered: { estado: 'Entregado', detalle: 'El pedido se entregó.' },
  not_delivered: { estado: 'No entregado', detalle: 'El correo no pudo entregar el pedido.' },
  on_hold: { estado: 'Pausado', detalle: 'El pedido está pausado, normalmente por falta de stock de algún producto.' },
  cancelled: { estado: 'Cancelado', detalle: 'El pedido fue cancelado.' },
};

// Estados del envío (shipment): el detalle fino una vez que salió del depósito.
// Cuando existe, es más informativo que el `status` del pedido (que se queda en
// `shipped` todo el tramo del correo).
const SHIPMENT_STATUS: Record<string, { estado: string; detalle: string }> = {
  created: { estado: 'Preparado', detalle: 'La etiqueta está generada pero el pedido todavía no se despachó al correo.' },
  dispatched: { estado: 'Despachado', detalle: 'El pedido ya se despachó al correo.' },
  shipped: { estado: 'En camino', detalle: 'El pedido está en un centro de distribución del correo.' },
  in_post_office: { estado: 'En sucursal', detalle: 'El pedido llegó a la sucursal que hace la entrega. Si el envío es a sucursal, ya se puede retirar.' },
  out_for_delivery: { estado: 'En reparto', detalle: 'El pedido salió a la calle para entregarse hoy.' },
  on_hold: { estado: 'Guardado en sucursal', detalle: 'No se pudo entregar a domicilio y quedó en una sucursal para retirar.' },
  not_delivered: { estado: 'No entregado', detalle: 'La entrega falló y el pedido está volviendo a shipnow.' },
  returned: { estado: 'Devuelto', detalle: 'La entrega falló y el pedido ya volvió a shipnow.' },
  delivered: { estado: 'Entregado', detalle: 'El pedido se entregó.' },
};

// Razones de no entrega (shipment_visits[].not_delivered_reason).
const NOT_DELIVERED_REASON: Record<string, string> = {
  non_existent_address: 'la dirección no existe',
  incomplete_address: 'la dirección está incompleta',
  rejected: 'el destinatario rechazó el paquete',
  receiver_not_found: 'no había nadie para recibirlo',
  inoperable_area: 'la zona no es operativa para el correo',
  limited_timeframe: 'se pasó la franja horaria',
  lost_shipment: 'el paquete se extravió',
  operative: 'una razón operativa del correo',
  others: 'otra razón',
  unknown: 'una razón no informada',
};

type Visit = { status?: string | null; not_delivered_reason?: string | null; date?: string | null };

/** Última razón de no entrega informada por el correo, si la hay. */
function lastNotDeliveredReason(order: ShipnowOrder): string | null {
  const visits = (order.shipment?.visits as Visit[] | undefined) ?? [];
  for (let i = visits.length - 1; i >= 0; i--) {
    const reason = visits[i]?.not_delivered_reason;
    if (reason) return NOT_DELIVERED_REASON[reason] ?? reason;
  }
  return null;
}

/**
 * Achica la orden a lo que el agente necesita para contestar "¿dónde está mi pedido?".
 *
 * Deliberadamente NO devolvemos los datos personales del comprador (nombre, email,
 * teléfono, documento, dirección exacta) ni los precios: con el número de orden como
 * única credencial, cualquiera que lo adivine vería esos datos. Ciudad y provincia
 * alcanzan para que el agente confirme el destino.
 */
function shapeOrder(order: ShipnowOrder): Record<string, unknown> {
  const shipmentStatus = order.shipment?.status ?? null;
  const orderStatus = order.status ?? null;

  // El estado del shipment gana cuando existe: el pedido se queda en `shipped`
  // todo el tramo del correo, mientras el shipment distingue en reparto / en
  // sucursal / no entregado.
  const resolved =
    (shipmentStatus ? SHIPMENT_STATUS[shipmentStatus] : null) ??
    (orderStatus ? ORDER_STATUS[orderStatus] : null) ??
    null;

  const ts = order.timestamps ?? {};
  const shipment = order.shipment ?? null;
  const shipTo = (order.ship_to ?? {}) as Record<string, unknown>;
  const reason = lastNotDeliveredReason(order);

  return {
    encontrado: true,
    numero_de_orden: order.external_reference ?? null,
    referencia_secundaria: order.external_reference_user ?? null,
    id_shipnow: order.id,
    tipo: order.type === 'return' ? 'devolución' : 'pedido',
    estado: resolved?.estado ?? orderStatus ?? 'desconocido',
    detalle: reason ? `${resolved?.detalle ?? ''} Motivo informado: ${reason}.`.trim() : (resolved?.detalle ?? null),
    // Códigos crudos por si el agente necesita desambiguar algo puntual.
    estado_pedido: orderStatus,
    estado_envio: shipmentStatus,
    correo: shipment?.carrier?.name ?? shipment?.carrier?.description ?? null,
    numero_de_seguimiento: shipment?.tracking_number ?? order.uid ?? null,
    link_de_seguimiento: order.tracking_url ?? shipment?.external_tracking_url ?? null,
    entrega_estimada: order.estimated_delivery ?? null,
    entrega_estimada_desde: order.minimum_delivery ?? null,
    entrega_estimada_hasta: order.maximum_delivery ?? null,
    fechas: {
      despachado: ts.shipped_at ?? shipment?.shipped_at ?? null,
      en_sucursal: shipment?.in_post_office_at ?? null,
      en_reparto: shipment?.out_for_delivery_at ?? null,
      entregado: ts.delivered_at ?? shipment?.delivered_at ?? null,
      no_entregado: ts.not_delivered_at ?? shipment?.not_delivered_at ?? null,
      ultima_actualizacion_del_correo: shipment?.last_update_carrier_at ?? null,
    },
    destino: {
      ciudad: (shipTo.city as string | null) ?? null,
      provincia: (shipTo.state as string | null) ?? null,
    },
  };
}

export const shipnowService = {
  async getConnection(clientId: number): Promise<ShipnowConnection | null> {
    const { data, error } = await supabase
      .from('shipnow_connections')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw error;
    return (data as ShipnowConnection | null) ?? null;
  },

  /** Valida el token contra shipnow y lo guarda. Lanza si shipnow lo rechaza. */
  async saveConnection(clientId: number, apiToken: string): Promise<{ account_name: string | null }> {
    const { accountName } = await shipnowApiService.validateToken(apiToken);

    const now = new Date().toISOString();
    const { error } = await supabase.from('shipnow_connections').upsert(
      {
        client_id: clientId,
        api_token: apiToken,
        account_name: accountName,
        connected_at: now,
        updated_at: now,
      },
      { onConflict: 'client_id' },
    );
    if (error) throw error;

    return { account_name: accountName };
  },

  async deleteConnection(clientId: number): Promise<void> {
    const { error } = await supabase.from('shipnow_connections').delete().eq('client_id', clientId);
    if (error) throw error;
  },

  /**
   * Busca un pedido por el número que tipeó el comprador y devuelve su estado.
   *
   * El comprador puede tirar dos números distintos y no sabe cuál tiene:
   *  1. el de su compra en la tienda → en shipnow es `external_reference`;
   *  2. el interno de shipnow → es el `id` del pedido.
   * Probamos en ese orden porque el primero es el que el comprador ve en el mail
   * de la tienda; el segundo sólo aparece en el tracking de shipnow.
   */
  async findOrder(
    clientId: number,
    orderNumber: string,
  ): Promise<{ encontrado: boolean; [key: string]: unknown }> {
    const conn = await this.getConnection(clientId);
    if (!conn) {
      throw new Error('Este workspace no tiene shipnow conectado');
    }

    const needle = orderNumber.trim().replace(/^#/, '');
    if (!needle) {
      return { encontrado: false, motivo: 'No me pasaste un número de orden.' };
    }

    const byRef = await shipnowApiService.findOrdersByExternalReference(conn.api_token, needle);
    if (byRef.length > 0) {
      return shapeOrder(byRef[0]) as { encontrado: boolean };
    }

    // Fallback: puede ser el ID interno de shipnow. Sólo tiene sentido si es numérico.
    if (/^\d+$/.test(needle)) {
      const byId = await shipnowApiService.getOrder(conn.api_token, Number(needle));
      if (byId) return shapeOrder(byId) as { encontrado: boolean };
    }

    return {
      encontrado: false,
      motivo: `No encontré ningún pedido con el número ${needle} en shipnow. Puede que el número esté mal, que el pedido todavía no se haya despachado o que corresponda a otra tienda.`,
    };
  },
};
