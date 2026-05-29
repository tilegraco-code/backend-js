import { Resend } from 'resend';
import type { FastifyBaseLogger } from 'fastify';

const FROM_DEFAULT = 'notificaciones@tilegra.com';
const APP_URL = 'https://app.tilegra.com';
const BRAND_GREEN = '#6fa417';

let client: Resend | null = null;

function getClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY no configurada');
  }
  if (!client) {
    client = new Resend(apiKey);
  }
  return client;
}

function getFrom(): string {
  return process.env.RESEND_FROM ?? FROM_DEFAULT;
}

/**
 * Layout base de los emails transaccionales de Tilegra.
 * `cta` es opcional: si se pasa, renderiza el botón verde.
 */
function layout(opts: {
  title: string;
  bodyHtml: string;
  cta?: { label: string; href: string };
}): string {
  const button = opts.cta
    ? `<a href="${opts.cta.href}" style="display:inline-block;margin-top:24px;padding:12px 24px;background-color:${BRAND_GREEN};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">${opts.cta.label}</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${opts.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <img src="${APP_URL}/Tilegra-Black-2d.svg" alt="Tilegra" width="140" style="margin-bottom:24px;" />
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;border:1px solid #ececec;">
          <tr>
            <td style="padding:48px 40px;">
              <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111111;">${opts.title}</h2>
              ${opts.bodyHtml}
              ${button}
            </td>
          </tr>
        </table>
        <p style="font-size:12px;color:#aaaaaa;margin-top:24px;">
          © 2026 Tilegra · <a href="${APP_URL}" style="color:#aaaaaa;">app.tilegra.com</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const p = (text: string): string =>
  `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#555555;">${text}</p>`;

export const accountLifecycleEmails = {
  trialWarning(): { subject: string; html: string } {
    return {
      subject: 'Tu prueba de Tilegra termina mañana',
      html: layout({
        title: 'Tu período de prueba está por terminar',
        bodyHtml:
          p('Tu prueba gratuita de Tilegra termina <strong>en las próximas 24 horas</strong>.') +
          p(
            'Para no perder tu canal de WhatsApp conectado ni tu configuración, elegí un plan antes de que finalice. Si no lo hacés, desvincularemos automáticamente el canal conectado.',
          ),
        cta: { label: 'Elegir un plan', href: `${APP_URL}/dashboard/billing` },
      }),
    };
  },

  trialCut(): { subject: string; html: string } {
    return {
      subject: 'Desvinculamos tu canal de Tilegra',
      html: layout({
        title: 'Tu prueba terminó y desvinculamos tu canal',
        bodyHtml:
          p(
            'Tu período de prueba finalizó hace más de 24 horas y no se activó ningún plan, así que <strong>desvinculamos el canal que tenías conectado</strong>.',
          ) +
          p('Cuando quieras volver, activá un plan y reconectá tu canal en minutos. Tus datos siguen disponibles.'),
        cta: { label: 'Reactivar mi cuenta', href: `${APP_URL}/dashboard/billing` },
      }),
    };
  },

  planWarning(): { subject: string; html: string } {
    return {
      subject: 'Tu pago de Tilegra vence mañana',
      html: layout({
        title: 'Tu próximo pago está por vencer',
        bodyHtml:
          p('El pago de tu suscripción a Tilegra vence <strong>en las próximas 24 horas</strong>.') +
          p(
            'Verificá que tu medio de pago esté al día. Si el pago no se procesa, desconectaremos automáticamente todos tus canales para evitar cargos en cuentas inactivas.',
          ),
        cta: { label: 'Revisar mi facturación', href: `${APP_URL}/dashboard/billing` },
      }),
    };
  },

  planCut(): { subject: string; html: string } {
    return {
      subject: 'Desconectamos tus canales por falta de pago',
      html: layout({
        title: 'Desconectamos tus canales',
        bodyHtml:
          p(
            'No registramos el pago de tu suscripción y pasaron más de 24 horas desde el vencimiento, así que <strong>desconectamos todos los canales asociados a tu cuenta</strong>.',
          ) +
          p('Regularizá tu pago para reactivar el servicio y volver a conectar tus canales.'),
        cta: { label: 'Regularizar mi pago', href: `${APP_URL}/dashboard/billing` },
      }),
    };
  },
};

export const emailService = {
  /**
   * Envía un email. Devuelve true si se envió, false si falló (no lanza:
   * un fallo de email no debe abortar el batch del CRON).
   */
  async send(
    to: string,
    subject: string,
    html: string,
    log: FastifyBaseLogger,
  ): Promise<boolean> {
    try {
      await getClient().emails.send({ from: getFrom(), to, subject, html });
      log.info({ to, subject }, 'email enviado');
      return true;
    } catch (err) {
      log.error({ err, to, subject }, 'email send error');
      return false;
    }
  },
};
