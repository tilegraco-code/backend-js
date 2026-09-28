// Máquina de estados del juego del stand. Recibe cada mensaje entrante del inbox del juego
// (GAME_UNIPILE_ACCOUNT_ID) y contesta por el envío saliente de siempre. No pasa por el
// runtime de agentes, ni por agentuse (no consume créditos), ni por casos o escalación.
//
// Tiempo de cada respuesta = llegada del webhook con la letra − envío confirmado de la escena.
// Todo con el reloj del servidor en ms: el timestamp de WhatsApp viene en segundos y haría
// los empates mucho más probables.
import type { FastifyBaseLogger } from 'fastify';
import { outgoingMessageService } from '../services/outgoing-message.service';
import { unipileApiService } from '../services/unipile-api.service';
import { LETTERS, type Campaign, type Letter } from './campaign.types';
import { viernes2347 } from './campaigns/viernes-2347';
import { computeScore, initialVars, parseChoice, renderScene, shuffledOrder, step, timeMultiplier } from './engine';
import { gameStore, type GameEvent, type PathEntry, type Player, type Session } from './game.store';
import { isReady, localDay, parseEmail, parseName, phoneFromProviderId, text } from './messages';

const CAMPAIGN: Campaign = viernes2347;
/** Una partida que sigue abierta después de esto queda `abandoned` y no entra al ranking. */
export const SESSION_TIMEOUT_MS = 5 * 60_000;
/** Pausa entre mensajes seguidos, para que WhatsApp los muestre en orden. */
const PAUSE_MS = 700;
/** Mínimo de partidas del día para mostrar estadísticas al final. */
const MIN_FOR_STATS = 5;

export type GameIncoming = {
  clientId: number;
  chatId: string;
  providerId: string;
  /** Attendee de Unipile: de ahí sale el teléfono real cuando WhatsApp manda un LID. */
  attendeeId: string;
  senderName: string | null;
  text: string;
  /** Date.now() cuando llegó el webhook: el reloj de la respuesta para acá. */
  receivedAt: number;
};

// ─── Teléfono ───
// WhatsApp identifica a muchos contactos con un LID ("194776800465107@lid"), que no es el
// número. En ese caso se le pide el número a Unipile una vez y queda en memoria.
const lidPhones = new Map<string, string>();

async function resolvePhone(input: GameIncoming, log: FastifyBaseLogger): Promise<string> {
  if (!input.providerId.endsWith('@lid')) return phoneFromProviderId(input.providerId);

  const cached = lidPhones.get(input.providerId);
  if (cached) return cached;
  try {
    const phone = await unipileApiService.getAttendeePhone(input.attendeeId);
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      lidPhones.set(input.providerId, digits);
      return digits;
    }
  } catch (err) {
    log.error({ err, attendeeId: input.attendeeId }, 'juego: no se pudo resolver el teléfono del LID');
  }
  // Sin número: se identifica por el LID, que igual es estable para esa persona. No se
  // cachea, así el próximo mensaje vuelve a intentar.
  return phoneFromProviderId(input.providerId);
}

// ─── Cola por chat ───
// backend-js corre en una sola instancia. Si el jugador manda dos mensajes seguidos, los dos
// webhooks se procesan uno detrás del otro y nunca pisan el estado de la partida.
const queues = new Map<string, Promise<void>>();
function withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(chatId, tail);
  void tail.then(() => {
    if (queues.get(chatId) === tail) queues.delete(chatId);
  });
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Envía en orden. Devuelve cuándo quedó confirmado el último (arranque del reloj). */
async function sendAll(
  s: { clientId: number; chatId: string },
  messages: string[],
  log: FastifyBaseLogger,
): Promise<number> {
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(PAUSE_MS);
    const r = await outgoingMessageService.sendOutgoing(
      { clientId: s.clientId, chatId: s.chatId, text: messages[i] },
      log,
    );
    if (!r.ok) log.error({ chatId: s.chatId, err: r.error }, 'juego: envío falló');
  }
  return Date.now();
}

const session_ = (s: Session) => ({ clientId: s.client_id, chatId: s.chat_id });

function isTerminal(session: Session | null): boolean {
  return !session || session.status === 'finished' || session.status === 'abandoned';
}

async function newSession(
  event: GameEvent,
  player: Player,
  input: GameIncoming,
  status: Session['status'],
): Promise<Session> {
  return gameStore.createSession({
    event_id: event.id,
    player_id: player.id,
    chat_id: input.chatId,
    client_id: input.clientId,
    campaign: CAMPAIGN.id,
    campaign_version: CAMPAIGN.version,
    status,
    vars: initialVars(),
  });
}

// ─── Pasos ───

async function sendIntro(input: GameIncoming, log: FastifyBaseLogger): Promise<void> {
  await sendAll(input, CAMPAIGN.intro, log);
}

async function startPlaying(session: Session, log: FastifyBaseLogger): Promise<void> {
  const order = shuffledOrder(Math.random);
  const vars = initialVars();
  const scene = CAMPAIGN.scenes[CAMPAIGN.start];
  const sentAt = await sendAll(session_(session), [renderScene(scene, order, vars)], log);
  const iso = new Date(sentAt).toISOString();
  await gameStore.updateSession(session.id, {
    status: 'playing',
    node: CAMPAIGN.start,
    vars,
    option_order: order,
    path: [],
    scene_sent_at: iso,
    started_at: iso,
  });
}


async function answer(event: GameEvent, session: Session, input: GameIncoming, log: FastifyBaseLogger): Promise<void> {
  const sentAt = session.scene_sent_at ? Date.parse(session.scene_sent_at) : NaN;
  const node = session.node;
  const order = session.option_order;
  if (!node || !order || Number.isNaN(sentAt)) {
    log.error({ sessionId: session.id }, 'juego: partida en juego sin escena');
    return;
  }

  // Llegó antes de que saliera la escena: no pudo haberla leído. Se ignora.
  if (input.receivedAt < sentAt) {
    log.info({ sessionId: session.id, node }, 'juego: respuesta anterior a la escena, ignorada');
    return;
  }

  if (session.started_at && input.receivedAt - Date.parse(session.started_at) > SESSION_TIMEOUT_MS) {
    await abandon(session, log);
    return;
  }

  const shown = parseChoice(input.text);
  if (!shown) {
    // El reloj de la pregunta sigue corriendo: no se toca scene_sent_at.
    await sendAll(session_(session), [text.invalidChoice], log);
    return;
  }

  const choice = order[LETTERS.indexOf(shown)];
  const ms = input.receivedAt - sentAt;
  const path: PathEntry[] = [...session.path, { scene: node, shown, choice, ms }];
  const scene = CAMPAIGN.scenes[node];
  const option = scene.options[choice];
  const r = step(CAMPAIGN, node, session.vars, choice);
  const before: string[] = option.remember ? [text.remember(option.remember)] : [];

  if ('end' in r) {
    if (r.byTrust) before.push(text.lostTrust);
    await finish(event, session, { path, vars: r.vars, ending: r.end, early: r.early }, before, log);
    return;
  }

  const nextOrder = shuffledOrder(Math.random);
  const nextScene = CAMPAIGN.scenes[r.next];
  const nextSentAt = await sendAll(session_(session), [...before, renderScene(nextScene, nextOrder, r.vars)], log);
  await gameStore.updateSession(session.id, {
    node: r.next,
    vars: r.vars,
    option_order: nextOrder,
    path,
    scene_sent_at: new Date(nextSentAt).toISOString(),
  });
}

async function finish(
  event: GameEvent,
  session: Session,
  result: { path: PathEntry[]; vars: Session['vars']; ending: string; early: boolean },
  before: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const totalMs = result.path.reduce((a, p) => a + p.ms, 0);
  const score = computeScore(CAMPAIGN, result.ending, result.early, totalMs);
  const endedAt = new Date();
  await gameStore.updateSession(session.id, {
    status: 'finished',
    node: null,
    option_order: null,
    vars: result.vars,
    path: result.path,
    ending: result.ending,
    early: result.early,
    score,
    total_ms: totalMs,
    ended_at: endedAt.toISOString(),
  });

  const ending = CAMPAIGN.endings[result.ending];
  const today = localDay(endedAt, event.timezone);
  const board = await gameStore.leaderboard(event.id, today).catch((err) => {
    log.error({ err }, 'juego: no se pudo leer el ranking');
    return [];
  });
  const rank = board.find((row) => row.player_id === session.player_id)?.rank ?? null;

  const messages = [
    ...before,
    text.ending(ending),
    text.score({ base: ending.base, early: result.early, totalMs, multiplier: timeMultiplier(totalMs), score, rank }),
    text.tilegra(ending),
  ];
  const stats = await dayStats(event, today).catch((err) => {
    log.error({ err }, 'juego: no se pudieron calcular las estadísticas');
    return null;
  });
  if (stats) messages.push(stats);

  const igUrl = process.env.GAME_INSTAGRAM_URL;
  if (igUrl) messages.push(text.instagram(igUrl));

  await sendAll(session_(session), messages, log);
}

/** Estadísticas del día sobre las partidas terminadas. Null si todavía hay pocas. */
async function dayStats(event: GameEvent, today: string): Promise<string | null> {
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const rows = (await gameStore.finishedSince(event.id, since)).filter(
    (r) => localDay(new Date(r.ended_at), event.timezone) === today,
  );
  if (rows.length < MIN_FOR_STATS) return null;

  const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;
  const reached = (scenes: string[]) => rows.filter((r) => r.path.some((p) => scenes.includes(p.scene)));
  const chose = (list: typeof rows, pairs: [string, Letter][]) =>
    list.filter((r) => r.path.some((p) => pairs.some(([s, l]) => p.scene === s && p.choice === l))).length;

  const items: string[] = [];
  const atQ3 = reached(['q3']);
  if (atQ3.length) items.push(`El ${pct(chose(atQ3, [['q3', 'B']]), atQ3.length)} le prometió el miércoles`);
  const atQ2 = reached(['q2', 'q2b']);
  if (atQ2.length) items.push(`El ${pct(chose(atQ2, [['q2', 'B'], ['q2b', 'C']]), atQ2.length)} le regaló el descuento`);
  const good = rows.filter((r) => r.ending === 'F1' || r.ending === 'F2').length;
  items.push(`Solo el ${pct(good, rows.length)} llegó a una venta perfecta`);
  return text.stats(items);
}

async function abandon(session: Session, log: FastifyBaseLogger): Promise<void> {
  await gameStore.updateSession(session.id, {
    status: 'abandoned',
    node: null,
    option_order: null,
    ended_at: new Date().toISOString(),
  });
  await sendAll(session_(session), [text.timeout], log);
}

// ─── Entrada ───

async function handle(input: GameIncoming, log: FastifyBaseLogger): Promise<void> {
  const event = await gameStore.activeEvent();
  if (!event) {
    await sendAll(input, [text.noEvent], log);
    return;
  }

  const phone = await resolvePhone(input, log);
  let player = await gameStore.findPlayer(phone);

  // Jugador guardado con el LID (antes de resolverse el número, o porque Unipile no lo
  // devolvió): se le corrige el teléfono en vez de crear un jugador nuevo.
  const lidDigits = input.providerId.endsWith('@lid') ? phoneFromProviderId(input.providerId) : null;
  if (!player && lidDigits && lidDigits !== phone) {
    const byLid = await gameStore.findPlayer(lidDigits);
    if (byLid) {
      await gameStore.updatePlayer(byLid.id, { phone });
      player = { ...byLid, phone };
    }
  }

  if (!player) {
    player = await gameStore.createPlayer(phone, input.senderName);
    await newSession(event, player, input, 'registering_name');
    await sendAll(input, [text.welcome], log);
    return;
  }

  const session = await gameStore.latestSession(player.id);

  if (isTerminal(session) || session!.event_id !== event.id) {
    // Jugador conocido sin partida abierta.
    if (!player.name) {
      await newSession(event, player, input, 'registering_name');
      await sendAll(input, [text.welcome], log);
    } else if (!player.email) {
      await newSession(event, player, input, 'registering_email');
      await sendAll(input, [text.askEmail(player.name.split(' ')[0])], log);
    } else if ((await gameStore.playedCount(player.id, event.id)) < 1 + player.extra_plays) {
      // Una partida por persona y por evento. Desde el stand se puede habilitar otra
      // sumando `extra_plays` al jugador (ver docs/juego-stand-plan.md).
      await newSession(event, player, input, 'intro');
      await sendIntro(input, log);
    } else {
      await sendAll(input, [text.alreadyPlayed], log);
    }
    return;
  }

  const s = session!;
  switch (s.status) {
    case 'registering_name': {
      const parsed = parseName(input.text);
      if (!parsed) {
        await sendAll(input, [text.badName], log);
        return;
      }
      await gameStore.updatePlayer(player.id, { name: parsed.name, display_name: parsed.display });
      if (player.email) {
        await gameStore.updateSession(s.id, { status: 'intro' });
        await sendIntro(input, log);
      } else {
        await gameStore.updateSession(s.id, { status: 'registering_email' });
        await sendAll(input, [text.askEmail(parsed.name.split(' ')[0])], log);
      }
      return;
    }
    case 'registering_email': {
      const email = parseEmail(input.text);
      if (!email) {
        await sendAll(input, [text.badEmail], log);
        return;
      }
      await gameStore.updatePlayer(player.id, { email, consent_at: new Date().toISOString() });
      await gameStore.updateSession(s.id, { status: 'intro' });
      await sendIntro(input, log);
      return;
    }
    case 'intro':
      if (isReady(input.text)) await startPlaying(s, log);
      else await sendAll(input, [text.notReady], log);
      return;
    case 'playing':
      await answer(event, s, input, log);
      return;
  }
}

export const gameService = {
  isGameAccount(accountId: string): boolean {
    const id = process.env.GAME_UNIPILE_ACCOUNT_ID;
    return Boolean(id) && id === accountId;
  },

  /** Procesa un mensaje entrante del inbox del juego. Nunca tira: los errores se loguean. */
  handleIncoming(input: GameIncoming, log: FastifyBaseLogger): Promise<void> {
    const gameLog = log.child({ game: true, chatId: input.chatId });
    return withChatLock(input.chatId, async () => {
      try {
        await handle(input, gameLog);
      } catch (err) {
        gameLog.error({ err }, 'juego: error procesando mensaje');
        await sendAll(input, [text.error], gameLog).catch(() => undefined);
      }
    });
  },

  /** Cierra las partidas que pasaron el límite de tiempo. Lo llama el job. */
  async abandonStale(log: FastifyBaseLogger): Promise<number> {
    const before = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    const stale = await gameStore.stalePlaying(before);
    for (const s of stale) {
      await withChatLock(s.chat_id, async () => {
        // Releer adentro del lock: puede haber terminado mientras esperaba.
        const fresh = await gameStore.latestSession(s.player_id);
        if (fresh?.id === s.id && fresh.status === 'playing') await abandon(fresh, log);
      });
    }
    return stale.length;
  },
};
