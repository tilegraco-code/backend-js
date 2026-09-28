// Tests del motor y de la campaña "Viernes, 23:47". Correr con `pnpm test`.
// Recorren TODOS los caminos: si alguien edita una escena y deja una rama colgada o un
// final inalcanzable, se entera acá y no el día del evento.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LETTERS, type Campaign, type GameVars, type Letter } from './campaign.types';
import { computeScore, initialVars, parseChoice, renderScene, shuffledOrder, step, timeMultiplier } from './engine';
import { viernes2347 } from './campaigns/viernes-2347';

const c = viernes2347;

function play(choices: Partial<Record<string, Letter>>) {
  let node = c.start;
  let vars = initialVars();
  const path: string[] = [];
  for (;;) {
    const letter = choices[node] ?? c.scenes[node].best;
    path.push(`${c.scenes[node].label}·${letter}`);
    const r = step(c, node, vars, letter);
    vars = r.vars;
    if ('end' in r) return { ...r, path };
    node = r.next;
  }
}

function allPaths(campaign: Campaign) {
  const counts: Record<string, number> = {};
  const visited = new Set<string>();
  let total = 0;
  let maxDepth = 0;
  const walk = (node: string, vars: GameVars, depth: number) => {
    visited.add(node);
    for (const l of LETTERS) {
      const r = step(campaign, node, vars, l);
      if ('end' in r) {
        counts[r.end] = (counts[r.end] ?? 0) + 1;
        total++;
        if (!r.early) assert.equal(depth + 1, 8, `un camino terminó por reglas con ${depth + 1} preguntas`);
        maxDepth = Math.max(maxDepth, depth + 1);
      } else {
        walk(r.next, r.vars, depth + 1);
      }
    }
  };
  walk(campaign.start, initialVars(), 0);
  return { counts, visited, total, maxDepth };
}

describe('campaña viernes-2347: grafo', () => {
  test('toda opción apunta a una escena o a un final que existen', () => {
    for (const scene of Object.values(c.scenes)) {
      for (const l of LETTERS) {
        const o = scene.options[l];
        if (o.next) assert.ok(c.scenes[o.next], `${scene.id}.${l} → ${o.next} no existe`);
        if (o.end) assert.ok(c.endings[o.end], `${scene.id}.${l} → final ${o.end} no existe`);
      }
    }
    for (const r of c.rules) assert.ok(c.endings[r.end], `regla → final ${r.end} no existe`);
    assert.ok(c.endings[c.trustEnding]);
  });

  test('todas las escenas y los 12 finales se alcanzan; los caminos completos tienen 8 preguntas', () => {
    const { counts, visited, total, maxDepth } = allPaths(c);
    assert.deepEqual([...visited].sort(), Object.keys(c.scenes).sort());
    assert.deepEqual(Object.keys(counts).sort(), Object.keys(c.endings).sort());
    assert.equal(maxDepth, 8);
    assert.equal(total, 2999);
    assert.equal(counts.F1, 1, 'el final secreto tiene un solo camino');
  });

  test('toda opción tiene texto (salvo las dinámicas)', () => {
    for (const scene of Object.values(c.scenes)) {
      for (const l of LETTERS) {
        const text = scene.dynamicText?.(l, initialVars()) ?? scene.options[l].text;
        assert.ok(text && text.length > 0, `${scene.id}.${l} sin texto`);
      }
    }
  });
});

describe('campaña viernes-2347: caminos conocidos', () => {
  test('las 8 ideales → final secreto', () => {
    const r = play({});
    assert.equal(r.end, 'F1');
    assert.equal(r.early, false);
    assert.equal(r.path.length, 8);
  });

  test('un paso frío sin errores → Venta perfecta', () => assert.equal(play({ q1: 'C' }).end, 'F2'));
  test('inventar la oferta y corregir ante el dueño → Venta salvada', () => assert.equal(play({ q1: 'B', q2b: 'A' }).end, 'F3'));
  test('prometer el miércoles y admitirlo en P7b → Venta salvada', () => assert.equal(play({ q3: 'B', q7b: 'A' }).end, 'F3'));
  test('sostener la mentira en P7b → Una estrella', () => assert.equal(play({ q3: 'B', q7b: 'B' }).end, 'F8'));
  test('cerrar solo con el link → Venta con enredo', () => assert.equal(play({ q8: 'C' }).end, 'F4'));
  test('regalar el descuento → Vendiste a pérdida', () => assert.equal(play({ q2: 'B' }).end, 'F5'));
  test('poca confianza al pagar → Carrito abandonado', () => assert.equal(play({ q1: 'C', q3: 'C', q4: 'C' }).end, 'F6'));
  test('tres respuestas frías seguidas → se va temprano', () => {
    const r = play({ q1: 'C', q2: 'C', q3: 'C' });
    assert.equal(r.end, 'F7');
    assert.equal(r.early, true);
    assert.equal(r.path.length, 3);
  });
  test('prometer devolver la plata le gana a las demás reglas', () => assert.equal(play({ q5: 'B', q4: 'B' }).end, 'F9'));
  test('dar el cupón → final temprano', () => assert.equal(play({ q6: 'B' }).end, 'F10'));
  test('pedir la tarjeta → F11', () => assert.equal(play({ q8: 'B' }).end, 'F11'));
  test('culpar a la clienta ante el dueño → desconectado', () => assert.equal(play({ q1: 'B', q2b: 'B' }).end, 'F12'));
});

describe('puntaje', () => {
  test('el multiplicador es continuo y siempre baja', () => {
    let prev = Infinity;
    for (let ms = 0; ms <= 600_000; ms += 250) {
      const m = timeMultiplier(ms);
      assert.ok(m < prev, `no baja en ${ms} ms`);
      assert.ok(m > 1 && m <= 3);
      prev = m;
    }
    assert.equal(timeMultiplier(60_000).toFixed(4), '1.7358');
  });

  test('un milisegundo de diferencia cambia el puntaje en la zona rápida', () => {
    const a = computeScore(c, 'F1', false, 20_000);
    const b = computeScore(c, 'F1', false, 20_010);
    assert.ok(a > b);
  });

  test('los finales tempranos no multiplican', () => {
    assert.equal(computeScore(c, 'F7', true, 1_000), 1500);
    assert.equal(computeScore(c, 'F10', true, 1_000), 0);
  });
});

describe('interacción', () => {
  test('parseChoice acepta letras, números y variantes comunes', () => {
    for (const [input, out] of [['a', 'A'], [' B ', 'B'], ['c)', 'C'], ['1', 'A'], ['2.', 'B'], ['Opción c', 'C'], ['b!', 'B']] as const) {
      assert.equal(parseChoice(input), out, input);
    }
    for (const input of ['d', 'hola', 'ab', '', 'a b', 'listo']) assert.equal(parseChoice(input), null, input);
  });

  test('shuffledOrder es una permutación de A, B y C', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 50; i++) assert.deepEqual([...shuffledOrder(rnd)].sort(), ['A', 'B', 'C']);
  });

  test('la escena muestra las opciones en el orden mezclado', () => {
    const txt = renderScene(c.scenes.q1, ['C', 'A', 'B'], initialVars());
    assert.match(txt, /\*A\)\* Pasame tu mail/);
    assert.match(txt, /\*B\)\* Salen \$80\.000/);
    assert.match(txt, /\*C\)\* ¡Hoy están en oferta/);
  });

  test('el resumen del pago repite lo pactado', () => {
    const v = { ...initialVars(), regalo: true, retiro: false };
    assert.match(renderScene(c.scenes.q8, ['A', 'B', 'C'], v), /\$60\.000 por transferencia y te llegan por envío/);
  });
});
