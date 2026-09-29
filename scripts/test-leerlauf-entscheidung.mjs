#!/usr/bin/env node
// test-leerlauf-entscheidung.mjs — P7-T18: Heartbeat im Leerlauf kostet keinen Kontext mehr.
// Reine Zustandslogik (packages/agents/src/leerlauf-entscheidung.ts), ohne DB und ohne Prozess.
//   - zwei Leer-Antworten (HEARTBEAT_OK) auf Leer-Weckrufe hintereinander -> Pause
//   - eine echte Antwort setzt den Zaehler zurueck
//   - jeder echte Anlass beendet die Pause; Datei-Aenderungen der Pause kommen als EINE Zeile
//   - Schwelle 0 = Verhalten wie bisher (nie Pause)
//   - wrapper.ts ist angeschlossen (Quelltext-Pruefung)
// Aufruf: node scripts/test-leerlauf-entscheidung.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const mod = await import('../packages/agents/dist/leerlauf-entscheidung.js');

await pruefe('istLeerlaufAntwort erkennt HEARTBEAT_OK-Varianten und leere Antworten', () => {
  for (const s of ['HEARTBEAT_OK', '  HEARTBEAT_OK\n', 'HEARTBEAT_OK.', '`HEARTBEAT_OK`', '', '   ']) {
    assert.equal(mod.istLeerlaufAntwort(s), true, JSON.stringify(s));
  }
});
await pruefe('istLeerlaufAntwort: echte Antworten sind keine Leer-Antwort', () => {
  for (const s of ['Ich mache weiter mit Task P7-T18.', 'HEARTBEAT_OK aber ich habe noch eine lange Frage an den Koordinator zur Aufgabe', 'Fertig.']) {
    assert.equal(mod.istLeerlaufAntwort(s), false, JSON.stringify(s));
  }
  assert.equal(mod.istLeerlaufAntwort(undefined), true);
});

await pruefe('Schwelle aus Env: Standard 2, 0 = aus, Unsinn -> Standard', () => {
  assert.equal(mod.leseLeerlaufSchwelle({}), 2);
  assert.equal(mod.leseLeerlaufSchwelle({ SYNAPSE_LEERLAUF_PAUSE_NACH: '0' }), 0);
  assert.equal(mod.leseLeerlaufSchwelle({ SYNAPSE_LEERLAUF_PAUSE_NACH: '5' }), 5);
  assert.equal(mod.leseLeerlaufSchwelle({ SYNAPSE_LEERLAUF_PAUSE_NACH: 'abc' }), 2);
  assert.equal(mod.leseLeerlaufSchwelle({ SYNAPSE_LEERLAUF_PAUSE_NACH: '-3' }), 2);
});

await pruefe('Anfangszustand: keine Pause', () => {
  const z = mod.neuerLeerlaufZustand();
  assert.equal(mod.istInPause(z, 2), false);
});
await pruefe('zwei Leer-Antworten -> Pause, eine nicht', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 2), false);
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 2), true);
});
await pruefe('echte Antwort dazwischen setzt den Zaehler zurueck', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'Ich habe X getan und poste es im Channel.');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 2), false);
});
await pruefe('Schwelle 0 -> nie Pause (Verhalten wie bisher)', () => {
  const z = mod.neuerLeerlaufZustand();
  for (let i = 0; i < 20; i++) mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 0), false);
});
await pruefe('Schwelle 1: schon nach einer Leer-Antwort Pause', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 1), true);
});

await pruefe('echter Anlass beendet die Pause und setzt den Zaehler zurueck', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 2), true);
  const r = mod.beiEchtemAnlass(z, 2);
  assert.equal(r.warPause, true);
  assert.equal(mod.istInPause(z, 2), false);
  // danach wieder zwei Leer-Antworten bis zur naechsten Pause
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.istInPause(z, 2), false);
});
await pruefe('ohne Pause: kein Hinweis, warPause false', () => {
  const z = mod.neuerLeerlaufZustand();
  const r = mod.beiEchtemAnlass(z, 2);
  assert.equal(r.warPause, false);
  assert.equal(r.hinweis, null);
});
await pruefe('Datei-Aenderungen in der Pause: gemerkt, beim naechsten echten Anlass EINE Zeile', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.merkeDateiAenderungen(z, 3);
  mod.merkeDateiAenderungen(z, 4);
  const r = mod.beiEchtemAnlass(z, 2);
  assert.equal(r.hinweis, '7 Datei-Änderungen während der Leerlauf-Pause, Details: files history');
  assert.equal(r.hinweis.split('\n').length, 1);
  // nur einmal
  assert.equal(mod.beiEchtemAnlass(z, 2).hinweis, null);
});
await pruefe('Datei-Aenderungen ausserhalb der Pause werden nicht gemerkt', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.merkeDateiAenderungen(z, 5, 2);
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.beiEchtemAnlass(z, 2).hinweis, null);
});
await pruefe('Datei-Aenderungen: 1 -> Singular', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.merkeDateiAenderungen(z, 1);
  assert.equal(mod.beiEchtemAnlass(z, 2).hinweis, '1 Datei-Änderung während der Leerlauf-Pause, Details: files history');
});
await pruefe('pauseMeldung: nur einmal je Pause', () => {
  const z = mod.neuerLeerlaufZustand();
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.pauseNochNichtGemeldet(z), true);
  assert.equal(mod.pauseNochNichtGemeldet(z), false);
  mod.beiEchtemAnlass(z, 2);
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  mod.nachLeerlaufWake(z, 'HEARTBEAT_OK');
  assert.equal(mod.pauseNochNichtGemeldet(z), true);
});

// Anschluss im Wrapper (Quelltext, weil wrapper.ts nicht ohne Prozess ladbar ist)
const wrapper = await readFile(new URL('../packages/agents/src/wrapper.ts', import.meta.url), 'utf8');
await pruefe('wrapper importiert leerlauf-entscheidung', () => {
  assert.match(wrapper, /from '\.\/leerlauf-entscheidung\.js'/);
});
await pruefe('wrapper: keepAlive-Wake nur ausserhalb der Pause', () => {
  assert.match(wrapper, /istInPause\(/);
  assert.match(wrapper, /merkeDateiAenderungen\(/);
});
await pruefe('wrapper: wakeAgent setzt bei echtem Anlass zurueck, Leer-Weckruf markiert', () => {
  assert.match(wrapper, /beiEchtemAnlass\(/);
  assert.match(wrapper, /nachLeerlaufWake\(/);
  assert.match(wrapper, /leerlaufWake/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
