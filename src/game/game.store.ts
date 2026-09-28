// Acceso al schema `game`. Nada del juego vive en `public`.
import { supabase } from '../lib/supabase';
import type { GameVars, Letter } from './campaign.types';

const db = () => supabase.schema('game');

export type GameEvent = {
  id: number;
  name: string;
  timezone: string;
  prize_count: number;
};

export type Player = {
  id: number;
  phone: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  /** Partidas extra habilitadas a mano (reinicio desde el stand). Base: una por evento. */
  extra_plays: number;
};

export type SessionStatus =
  | 'registering_name'
  | 'registering_email'
  | 'intro'
  | 'playing'
  | 'finished'
  | 'abandoned';

export type PathEntry = { scene: string; shown: Letter; choice: Letter; ms: number };

export type Session = {
  id: string;
  event_id: number;
  player_id: number;
  chat_id: string;
  client_id: number;
  campaign: string;
  campaign_version: number;
  status: SessionStatus;
  node: string | null;
  vars: GameVars;
  option_order: Letter[] | null;
  scene_sent_at: string | null;
  path: PathEntry[];
  ending: string | null;
  early: boolean | null;
  score: number | null;
  total_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
};

export type LeaderboardRow = {
  player_id: number;
  display_name: string | null;
  session_id: string;
  ending: string;
  score: number;
  total_ms: number;
  rank: number;
};

function fail(what: string, error: { message: string }): never {
  throw new Error(`game.store ${what}: ${error.message}`);
}

export const gameStore = {
  async activeEvent(): Promise<GameEvent | null> {
    const { data, error } = await db()
      .from('events')
      .select('id, name, timezone, prize_count')
      .eq('active', true)
      .maybeSingle();
    if (error) fail('activeEvent', error);
    return data;
  },

  async findPlayer(phone: string): Promise<Player | null> {
    const { data, error } = await db()
      .from('players')
      .select('id, phone, name, display_name, email, extra_plays')
      .eq('phone', phone)
      .maybeSingle();
    if (error) fail('findPlayer', error);
    return data;
  },

  async createPlayer(phone: string, whatsappName: string | null): Promise<Player> {
    const { data, error } = await db()
      .from('players')
      .insert({ phone, whatsapp_name: whatsappName })
      .select('id, phone, name, display_name, email, extra_plays')
      .single();
    if (error) fail('createPlayer', error);
    return data;
  },

  async updatePlayer(id: number, patch: Record<string, unknown>): Promise<void> {
    const { error } = await db().from('players').update(patch).eq('id', id);
    if (error) fail('updatePlayer', error);
  },

  async latestSession(playerId: number): Promise<Session | null> {
    const { data, error } = await db()
      .from('sessions')
      .select('*')
      .eq('player_id', playerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail('latestSession', error);
    return data as Session | null;
  },

  async createSession(row: {
    event_id: number;
    player_id: number;
    chat_id: string;
    client_id: number;
    campaign: string;
    campaign_version: number;
    status: SessionStatus;
    vars: GameVars;
  }): Promise<Session> {
    const { data, error } = await db().from('sessions').insert(row).select('*').single();
    if (error) fail('createSession', error);
    return data as Session;
  },

  async updateSession(id: string, patch: Partial<Session>): Promise<void> {
    const { error } = await db().from('sessions').update(patch).eq('id', id);
    if (error) fail('updateSession', error);
  },

  /** Partidas jugadas (terminadas o vencidas) por el jugador en el evento. */
  async playedCount(playerId: number, eventId: number): Promise<number> {
    const { count, error } = await db()
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('player_id', playerId)
      .eq('event_id', eventId)
      .in('status', ['finished', 'abandoned']);
    if (error) fail('playedCount', error);
    return count ?? 0;
  },

  async leaderboard(eventId: number, day: string): Promise<LeaderboardRow[]> {
    const { data, error } = await db()
      .from('leaderboard')
      .select('player_id, display_name, session_id, ending, score, total_ms, rank')
      .eq('event_id', eventId)
      .eq('day', day)
      .order('rank', { ascending: true });
    if (error) fail('leaderboard', error);
    return data ?? [];
  },

  /** Partidas terminadas desde `since`, para las estadísticas del final. */
  async finishedSince(
    eventId: number,
    since: string,
  ): Promise<{ path: PathEntry[]; ending: string; ended_at: string }[]> {
    const { data, error } = await db()
      .from('sessions')
      .select('path, ending, ended_at')
      .eq('event_id', eventId)
      .eq('status', 'finished')
      .gte('ended_at', since);
    if (error) fail('finishedSince', error);
    return (data ?? []) as { path: PathEntry[]; ending: string; ended_at: string }[];
  },

  /** Partidas que siguen en juego y arrancaron antes de `before`. */
  async stalePlaying(before: string): Promise<Session[]> {
    const { data, error } = await db()
      .from('sessions')
      .select('*')
      .eq('status', 'playing')
      .lt('started_at', before)
      .limit(100);
    if (error) fail('stalePlaying', error);
    return (data ?? []) as Session[];
  },

};
