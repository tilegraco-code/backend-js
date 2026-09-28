// Textos fijos del bot y helpers puros (nombre para el ranking, email, formato de números).
// Todos los textos en un solo lugar para poder ajustar el tono rápido en el ensayo.
import type { Ending } from './campaign.types';

const nf = (n: number, digits = 0) =>
  n.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const text = {
  welcome: [
    '👋 ¡Hola! Bienvenido a *¿Podrías ser un chatbot?* de Tilegra.',
    '',
    'Vas a atender a una clienta difícil como si fueras un agente de IA. Al final sacás puntaje y entrás al ranking de la TV del stand.',
    '',
    '¿Cómo te llamás? Mandame *nombre y apellido*.',
  ].join('\n'),
  badName: 'Mandame tu *nombre y apellido*, así aparecés en el ranking 🙂',
  askEmail: (name: string) =>
    [
      `¡Genial, ${name}! ¿Cuál es tu *email*?`,
      '',
      '_Lo usamos para avisarte si ganás y para contarte novedades de Tilegra._',
    ].join('\n'),
  badEmail: 'Ese email no parece válido. Probá de nuevo 🙂',
  notReady: 'Mandá *listo* cuando quieras empezar. El reloj arranca con el primer mensaje de la clienta ⏱',
  invalidChoice: 'Respondé con *A*, *B* o *C* 🙂',
  remember: (who: string) => `_${who} va a recordar esto._`,
  lostTrust: '_Carla dejó de responder._',
  alreadyPlayed: 'Ya jugaste tu partida 🙌 Tu puntaje está en el ranking de la TV del stand. ¡Gracias por jugar!',
  noEvent: 'El juego no está activo en este momento. ¡Te esperamos en el stand de Tilegra!',
  timeout: '⏱ Se terminó el tiempo de la partida. Si tuviste algún problema, acercate al stand de Tilegra.',
  error: 'Uy, algo falló de nuestro lado 😅 Mandá tu respuesta de nuevo en un ratito.',

  ending: (e: Ending) => [`🏁 *Final: ${e.emoji} ${e.title}*`, '', e.story].join('\n'),

  score: (p: { base: number; early: boolean; totalMs: number; multiplier: number; score: number; rank: number | null }) => {
    const lines = [`⏱ Tardaste *${nf(p.totalMs / 1000, 3)} s* en total`];
    lines.push(
      p.early
        ? `*${nf(p.score)} pts* (los finales tempranos no multiplican)`
        : `${nf(p.base)} × ${nf(p.multiplier, 4)} = *${nf(p.score)} pts*`,
    );
    if (p.rank) lines.push('', `🏆 Tu mejor partida de hoy está en el *puesto #${p.rank}*`);
    return lines.join('\n');
  },

  tilegra: (e: Ending) => `🤖 *Así lo haría un agente de Tilegra:*\n${e.tilegra}`,

  stats: (items: string[]) => ['📊 *Hoy en el stand:*', ...items.map((i) => `• ${i}`)].join('\n'),

  instagram: (url: string) => `Si te gustó, seguinos en Instagram 👇\n${url}`,
};

export { nf as formatNumber };

// ─── Registro ───

const BAD_WORDS = [
  'puto', 'puta', 'pija', 'culo', 'verga', 'forro', 'boludo', 'pelotudo', 'mierda', 'poronga',
  'garcha', 'trolo', 'nazi', 'hitler', 'fuck', 'shit', 'dick', 'cock', 'pussy',
];

function titleCase(w: string): string {
  return w.charAt(0).toLocaleUpperCase('es-AR') + w.slice(1).toLocaleLowerCase('es-AR');
}

/**
 * Valida el nombre que mandó el jugador y arma lo que muestra la TV ("Sofía R.").
 * Null si no parece un nombre o tiene malas palabras.
 */
export function parseName(input: string): { name: string; display: string } | null {
  const clean = input.replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 40) return null;
  if (!/^[\p{L}' .-]+$/u.test(clean)) return null;
  const folded = clean.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (BAD_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(folded))) return null;

  const words = clean.split(' ').filter(Boolean).map(titleCase);
  const name = words.join(' ');
  const display = words.length > 1 ? `${words[0]} ${words[words.length - 1].charAt(0)}.` : words[0];
  return { name, display };
}

export function parseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) && email.length <= 120 ? email : null;
}

export function isReady(input: string): boolean {
  return /^(listo|lista|ya|dale|empezar|empecemos|start|go|arranquemos|vamos)\b/i.test(input.trim());
}

/** "5491122334455@s.whatsapp.net" → "5491122334455". */
export function phoneFromProviderId(providerId: string): string {
  return providerId.split('@')[0].replace(/\D/g, '');
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona horaria del evento. */
export function localDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}
