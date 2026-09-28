// Tests de los helpers de registro del juego. Correr con `pnpm test`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isReady, isRematch, localDay, parseEmail, parseName, phoneFromProviderId } from './messages';

describe('registro del juego', () => {
  test('parseName arma el nombre del ranking', () => {
    assert.deepEqual(parseName('sofía  rodríguez'), { name: 'Sofía Rodríguez', display: 'Sofía R.' });
    assert.deepEqual(parseName('Ale'), { name: 'Ale', display: 'Ale' });
    assert.deepEqual(parseName("María José O'Neill"), { name: "María José O'neill", display: 'María O.' });
  });

  test('parseName rechaza lo que no es un nombre o es ofensivo', () => {
    for (const input of ['a', 'x'.repeat(41), 'juan123', '😎', 'Puto Amo', 'hitler']) {
      assert.equal(parseName(input), null, input);
    }
    // Apellidos reales que empiezan como una mala palabra no se rechazan.
    assert.ok(parseName('Lucía Culotta'));
  });

  test('parseEmail', () => {
    assert.equal(parseEmail(' Sofia@Mail.com '), 'sofia@mail.com');
    for (const input of ['sofia', 'sofia@mail', 'a b@c.com']) assert.equal(parseEmail(input), null, input);
  });

  test('isReady e isRematch', () => {
    assert.ok(isReady('Listo!'));
    assert.ok(isReady('dale'));
    assert.ok(!isReady('a'));
    assert.ok(isRematch('Revancha'));
    assert.ok(isRematch('Iniciar partida'));
    assert.ok(!isRematch('gracias'));
  });

  test('phoneFromProviderId y localDay', () => {
    assert.equal(phoneFromProviderId('5491122334455@s.whatsapp.net'), '5491122334455');
    // 01:30 UTC del 29 es todavía el 28 en Argentina.
    assert.equal(localDay(new Date('2026-09-29T01:30:00Z'), 'America/Argentina/Buenos_Aires'), '2026-09-28');
  });
});
