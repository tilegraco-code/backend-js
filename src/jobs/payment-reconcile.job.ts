import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';

// Cada 3 horas. Recupera cobros de suscripción que el webhook de MercadoPago no
// registró: el primer cobro suele avisarse con el pago todavía en curso y, si MP
// no vuelve a avisar, quedaba sin factura. La lógica vive en el dashboard (donde
// está el token de MP); acá sólo se dispara.
const DEFAULT_SCHEDULE = '20 */3 * * *';

export function registerPaymentReconcileJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.PAYMENT_RECONCILE_CRON ?? DEFAULT_SCHEDULE;

  const task = cron.schedule(
    schedule,
    async () => {
      const jobLog = log.child({ job: 'payment-reconcile' });
      const base = (process.env.DASHBOARD_URL ?? '').replace(/\/$/, '');
      const key = process.env.INTERNAL_API_KEY;
      if (!base || !key) {
        jobLog.warn('falta DASHBOARD_URL/INTERNAL_API_KEY — skip');
        return;
      }
      try {
        const res = await fetch(`${base}/api/billing/reconcile-payments`, {
          method: 'POST',
          headers: { 'x-internal-key': key },
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          jobLog.error({ status: res.status, body }, 'payment-reconcile: respuesta no OK');
          return;
        }
        jobLog.info(body, 'payment-reconcile ok');
      } catch (err) {
        jobLog.error({ err }, 'payment-reconcile cron error');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'payment-reconcile', schedule }, 'payment-reconcile.job registrado');
  return task;
}
