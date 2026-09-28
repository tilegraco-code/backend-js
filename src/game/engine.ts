// Motor del juego del stand. Todo puro: sin DB, sin reloj, sin azar propio (el azar entra
// por parámetro). Así los tests pueden recorrer todos los caminos de una campaña.
import { LETTERS, type Campaign, type GameVars, type Letter, type Scene } from './campaign.types';

export function initialVars(): GameVars {
  return {
    confianza: 0,
    invento: false,
    regalo: false,
    prometio: false,
    corrigio: false,
    devolucion: false,
    enredo: false,
    retiro: false,
    allBest: true,
  };
}

export type StepResult =
  | { vars: GameVars; next: string }
  | { vars: GameVars; end: string; early: boolean; rule?: number; byTrust?: boolean };

/** Aplica la opción elegida (letra canónica, no la que vio el jugador) a una escena. */
export function step(campaign: Campaign, sceneId: string, vars: GameVars, letter: Letter): StepResult {
  const scene = campaign.scenes[sceneId];
  if (!scene) throw new Error(`Escena desconocida: ${sceneId}`);
  const option = scene.options[letter];
  const v: GameVars = { ...vars };

  if (letter !== scene.best || scene.branch) v.allBest = false;
  if (option.confianza) v.confianza += option.confianza;
  if (option.set) Object.assign(v, option.set);

  if (option.end) return { vars: v, end: option.end, early: true };
  if (v.confianza <= campaign.trustFloor) {
    return { vars: v, end: campaign.trustEnding, early: true, byTrust: true };
  }
  if (sceneId === campaign.last) {
    const rule = campaign.rules.findIndex((r) => r.test(v));
    return { vars: v, end: campaign.rules[rule].end, early: false, rule };
  }

  const next = option.next ?? scene.route?.(v) ?? scene.next;
  if (!next) throw new Error(`La escena ${sceneId} no tiene siguiente`);
  return { vars: v, next };
}

export function optionText(scene: Scene, letter: Letter, vars: GameVars): string {
  return scene.dynamicText?.(letter, vars) ?? scene.options[letter].text ?? '';
}

/**
 * Orden en que se muestran las opciones: `order[i]` es la letra canónica que aparece como
 * LETTERS[i]. Se mezcla en cada escena para que memorizar "A A A A" no alcance.
 */
export function shuffledOrder(random: () => number): Letter[] {
  const order = [...LETTERS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Letra que mandó el jugador → letra que vio en pantalla. Null si no es una opción. */
export function parseChoice(text: string): Letter | null {
  const m = text
    .trim()
    .toLowerCase()
    .match(/^(?:opci[oó]n\s*)?([abc123])\s*[).!.\-]*$/);
  if (!m) return null;
  const c = m[1];
  if (c === 'a' || c === '1') return 'A';
  if (c === 'b' || c === '2') return 'B';
  return 'C';
}

export function renderScene(scene: Scene, order: Letter[], vars: GameVars): string {
  const who = scene.whoRole ? `${scene.who} (${scene.whoRole})` : scene.who;
  const lines = [`*${scene.label} · ${scene.title}*`, '', `💬 *${who}:* ${scene.message}`, ''];
  order.forEach((canonical, i) => {
    lines.push(`*${LETTERS[i]})* ${optionText(scene, canonical, vars)}`);
  });
  return lines.join('\n');
}

/**
 * Multiplicador de tiempo: continuo y estrictamente decreciente, sin mesetas donde empatar.
 * Arranca cerca de ×3, vale ×1,74 al minuto y tiende a ×1 sin llegar nunca.
 */
export function timeMultiplier(totalMs: number): number {
  return 1 + 2 * Math.exp(-Math.max(0, totalMs) / 60_000);
}

export function computeScore(campaign: Campaign, endingId: string, early: boolean, totalMs: number): number {
  const base = campaign.endings[endingId].base;
  return early ? base : Math.round(base * timeMultiplier(totalMs));
}
