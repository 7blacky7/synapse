/**
 * P22-T288 W5 (Analyse efbe02f1): Startkontext auf dem Altweg (docker exec je Turn). Reine Teile mit eingespeisten Quellen, ohne DB/Docker:
 *  - neue Sitzung (kein runtimeSessionId) der Main-Identitaet -> Text + runtime-Ereignis startkontext {weg altweg, zuege, tokens}
 *  - Fortsetzung (runtimeSessionId) / andere Identitaet / ohne Identitaet -> null, keine Abfrage
 *  - leer bzw. Schalter aus -> null mit grund; Fehler der Quelle -> null mit grund fehler (wirft nie)
 *  - mitStartkontext: Kontext vor die Nachricht, ohne Kontext byte-gleich
 *   pnpm --filter @synapse/rest-api build && node --test packages/rest-api/tests/altweg-startkontext-p22-t288.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import(new URL('../dist/services/agent-runtime/altweg-startkontext.js', import.meta.url).href);
const MAIN = 'id-main';
const quellen = (sk, gerufen) => ({ mainId: async () => MAIN, startkontext: async (id) => { gerufen.push(id); if (sk instanceof Error) throw sk; return sk; } });

test('(1) neue Sitzung der Main-Identitaet: Text und Debug-Ereignis', async () => {
  const ev = [], gerufen = [];
  const t = await m.altwegStartkontext({ runtimeSessionId: null, identityId: MAIN }, (e) => ev.push(e), quellen({ text: '## GEDAECHTNIS x', zuege: 3, tokens: 120 }, gerufen));
  assert.equal(t, '## GEDAECHTNIS x');
  assert.deepEqual(gerufen, [MAIN]);
  assert.deepEqual(ev, [{ event: 'runtime', data: { startkontext: { weg: 'altweg', zuege: 3, tokens: 120 } } }]);
});

test('(2) Fortsetzung, fremde oder fehlende Identitaet: nichts', async () => {
  for (const s of [{ runtimeSessionId: 'abc', identityId: MAIN }, { runtimeSessionId: null, identityId: 'andere' }, { runtimeSessionId: null, identityId: null }]) {
    const ev = [], gerufen = [];
    assert.equal(await m.altwegStartkontext(s, (e) => ev.push(e), quellen({ text: 'x', zuege: 1, tokens: 1 }, gerufen)), null);
    assert.deepEqual(gerufen, []);
    assert.deepEqual(ev, []);
  }
});

test('(3) leer bzw. Schalter aus und Fehler: null mit Grund, wirft nie', async () => {
  const ev = [];
  assert.equal(await m.altwegStartkontext({ runtimeSessionId: null, identityId: MAIN }, (e) => ev.push(e), quellen(null, [])), null);
  assert.equal(ev[0].data.startkontext.grund, 'leer_oder_schalter_aus');
  const ev2 = [];
  assert.equal(await m.altwegStartkontext({ runtimeSessionId: null, identityId: MAIN }, (e) => ev2.push(e), quellen(new Error('pg weg'), [])), null);
  assert.equal(ev2[0].data.startkontext.grund, 'fehler');
});

test('(4) mitStartkontext: vor die Nachricht, ohne Kontext unveraendert', () => {
  assert.equal(m.mitStartkontext('hallo', null), 'hallo');
  const t = m.mitStartkontext('hallo', '## GEDAECHTNIS');
  assert.ok(t.startsWith('## GEDAECHTNIS') && t.endsWith('hallo'));
});
