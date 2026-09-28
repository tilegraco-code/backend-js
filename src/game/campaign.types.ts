// Tipos de una campaña del juego del stand. La campaña es datos, no código: el motor
// (engine.ts) la recorre sin saber nada de zapatillas ni de Carla.

export type Letter = 'A' | 'B' | 'C';
export const LETTERS: readonly Letter[] = ['A', 'B', 'C'];

/** Estado de la partida que las decisiones van modificando. */
export type GameVars = {
  confianza: number;
  invento: boolean;
  regalo: boolean;
  prometio: boolean;
  corrigio: boolean;
  devolucion: boolean;
  enredo: boolean;
  retiro: boolean;
  /** Todas las respuestas fueron la ideal y no se pasó por ninguna rama. */
  allBest: boolean;
};

export type FlagName = Exclude<keyof GameVars, 'confianza' | 'allBest'>;

export type SceneOption = {
  /** Etiqueta corta para el diagrama y los logs. */
  short: string;
  /** Texto que ve el jugador. Si falta, lo arma `dynamicText` de la escena. */
  text?: string;
  /** Cambio de confianza de la clienta. */
  confianza?: number;
  set?: Partial<Record<FlagName, boolean>>;
  /** Salta a una escena distinta de la `next` de la escena. */
  next?: string;
  /** Termina la partida en este final (final temprano). */
  end?: string;
  /** Quién "va a recordar esto" después de elegir esta opción. */
  remember?: string;
};

export type Scene = {
  id: string;
  /** Rótulo visible: P1, P2b… */
  label: string;
  title: string;
  who: string;
  whoRole?: string;
  message: string;
  best: Letter;
  /** Las ramas reemplazan a una pregunta del camino principal. */
  branch?: boolean;
  /** Siguiente escena por defecto. Omitido en la última (van las reglas) y en las que deciden por estado. */
  next?: string;
  /** Siguiente escena según el estado (cuando no alcanza con `next`). */
  route?: (v: GameVars) => string;
  options: Record<Letter, SceneOption>;
  /** Texto de una opción que depende de lo pactado antes (ej. el resumen del pago). */
  dynamicText?: (letter: Letter, v: GameVars) => string | null;
};

export type Ending = {
  id: string;
  emoji: string;
  title: string;
  base: number;
  /** Los finales tempranos no llevan multiplicador de tiempo. */
  early?: boolean;
  secret?: boolean;
  /** Qué le pasó a la tienda. */
  story: string;
  /** Cómo lo habría resuelto un agente de Tilegra. */
  tilegra: string;
};

export type EndRule = {
  label: string;
  test: (v: GameVars) => boolean;
  end: string;
};

export type Campaign = {
  id: string;
  version: number;
  title: string;
  start: string;
  /** Escena después de la cual se evalúan las reglas. */
  last: string;
  /** Si la confianza llega a este valor, la partida termina en `trustEnding`. */
  trustFloor: number;
  trustEnding: string;
  intro: string[];
  scenes: Record<string, Scene>;
  endings: Record<string, Ending>;
  rules: EndRule[];
};
