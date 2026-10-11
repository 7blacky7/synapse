/**
 * P15-T12 (11.10.2026): WORKER-STEUERUNG IM PROZESS-SPEICHER + intern worker_*.
 *
 * ZUSAGEN:
 *   W1 pausieren ohne dauer_min/bis -> dauer_fehlt; ohne grund -> parameter_fehlt; beides -> dauer_mehrdeutig;
 *      unbekannter Worker -> unbekannter_worker (nichts pausiert)
 *   W2 pausieren wirkt: workerPausiert liefert die Pause (bis, grund, von); worker_status zeigt 'pausiert'
 *   W3 Kappung: dauer ueber SYNAPSE_WORKER_PAUSE_MAX_MIN -> auf die Obergrenze gekappt + hinweis
 *   W4 Ablauf: nach bis laeuft der Worker von selbst wieder (ohne fortsetzen)
 *   W5 fortsetzen: einzeln und 'alle'; 'alle' beim Pausieren laesst inAlle:false aus
 *   W6 laufender Stapel wird fertig: Pause waehrend eines Stapels -> Stapel endet normal, danach kein neuer
 *   W7 durchlauf: laeuft auch waehrend der Pause genau einmal, Pause bleibt danach bestehen; kein zweiter parallel
 *   W8 Neustart: frisch geladenes Modul kennt keine Pause (Zustand nur im Speicher, gewollt)
 *   W9 intern-Dispatch: worker_status / worker_pausieren / worker_fortsetzen / worker_durchlauf + Fehlercodes
 * Aufruf: node packages/core/tests/worker-steuerung.test.mjs (braucht gebautes dist; PG nur fuer pg_schalter in W9,
 *   ohne erreichbare DB steht dort ein fehler-Feld).
 */
import assert from 'node:assert/strict';

process.env.SYNAPSE_INTERN_TOOL = '1';
process.env.SYNAPSE_WORKER_PAUSE_MAX_MIN = '30';

const W = await import('../dist/services/worker-steuerung.js');
const T = await import('../dist/services/intern-tool.js');

let ok = 0;
async function pruefe(name, fn) {
  W.vergissAlleWorker();
  await fn();
  ok++;
  console.log('OK  ' + name);
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const fehlerCode = (fn) => {
  try { fn(); } catch (e) { return e.code; }
  return null;
};

await pruefe('W1 Pflichtangaben und unbekannte Worker', () => {
  W.registriereWorker({ name: 'a', beschreibung: 'A' });
  assert.equal(fehlerCode(() => W.pausiereWorker('a', { grund: 'x' })), 'dauer_fehlt');
  assert.equal(fehlerCode(() => W.pausiereWorker('a', { dauer_min: 5 })), 'parameter_fehlt');
  assert.equal(fehlerCode(() => W.pausiereWorker('a', { dauer_min: 5, bis: new Date(Date.now() + 60_000).toISOString(), grund: 'x' })), 'dauer_mehrdeutig');
  assert.equal(fehlerCode(() => W.pausiereWorker('a', { bis: new Date(Date.now() - 1000).toISOString(), grund: 'x' })), 'bis_vergangen');
  assert.equal(fehlerCode(() => W.pausiereWorker(['a', 'gibtsnicht'], { dauer_min: 5, grund: 'x' })), 'unbekannter_worker');
  assert.equal(W.workerPausiert('a'), null, 'nichts darf pausiert sein');
});

await pruefe('W2 Pause wirkt und ist sichtbar', () => {
  W.registriereWorker({ name: 'a', beschreibung: 'A' });
  const erg = W.pausiereWorker('a', { dauer_min: 10, grund: 'Messung', von: 'test' });
  assert.equal(erg.pausiert.length, 1);
  const p = W.workerPausiert('a');
  assert.ok(p, 'pausiert');
  assert.equal(p.grund, 'Messung');
  assert.equal(p.von, 'test');
  const s = W.workerStatus().find((x) => x.name === 'a');
  assert.equal(s.zustand, 'pausiert');
  assert.equal(s.uebersprungen_seit_pause, 1);
  assert.ok(s.rest_min >= 9 && s.rest_min <= 10, String(s.rest_min));
});

await pruefe('W3 Kappung auf SYNAPSE_WORKER_PAUSE_MAX_MIN', () => {
  W.registriereWorker({ name: 'a', beschreibung: 'A' });
  const erg = W.pausiereWorker('a', { dauer_min: 600, grund: 'lang' });
  assert.match(erg.hinweis ?? '', /gekappt/);
  const rest = Date.parse(erg.bis) - Date.now();
  assert.ok(rest <= 30 * 60_000 && rest > 29 * 60_000, String(rest));
});

await pruefe('W4 Ablauf: laeuft von selbst weiter', async () => {
  W.registriereWorker({ name: 'a', beschreibung: 'A' });
  W.pausiereWorker('a', { bis: new Date(Date.now() + 60).toISOString(), grund: 'kurz' });
  assert.ok(W.workerPausiert('a'));
  await warte(90);
  assert.equal(W.workerPausiert('a'), null);
  assert.equal(W.workerStatus()[0].zustand, 'laeuft');
});

await pruefe('W5 fortsetzen einzeln und alle; alle laesst inAlle:false aus', () => {
  W.registriereWorker({ name: 'a', beschreibung: 'A' });
  W.registriereWorker({ name: 'b', beschreibung: 'B' });
  W.registriereWorker({ name: 'shell', beschreibung: 'S', inAlle: false });
  const erg = W.pausiereWorker('alle', { dauer_min: 5, grund: 'alles' });
  assert.deepEqual(erg.pausiert.map((x) => x.name).sort(), ['a', 'b']);
  assert.equal(W.workerPausiert('shell'), null, 'shell nur ausdruecklich');
  const f1 = W.setzeWorkerFort('a');
  assert.deepEqual(f1.fortgesetzt, ['a']);
  assert.equal(W.workerPausiert('a'), null);
  assert.ok(W.workerPausiert('b'));
  const f2 = W.setzeWorkerFort('alle');
  assert.deepEqual(f2.fortgesetzt, ['b']);
  assert.equal(W.workerPausiert('b'), null);
});

await pruefe('W6 laufender Stapel wird fertig, danach nichts Neues', async () => {
  W.registriereWorker({ name: 'loop', beschreibung: 'L' });
  const geholt = [];
  const fertig = [];
  let stop = false;
  // Muster wie parser-worker.embeddingLoop: Pruefung VOR dem Holen, Stapel laeuft ungestoert zu Ende.
  const schleife = (async () => {
    let nr = 0;
    while (!stop) {
      if (W.workerPausiert('loop')) { await warte(5); continue; }
      const stapel = ++nr;
      geholt.push(stapel);
      await warte(40); // Stapel rechnet
      fertig.push(stapel);
    }
  })();
  await warte(10); // Stapel 1 laeuft
  W.pausiereWorker('loop', { dauer_min: 1, grund: 'mitten im Stapel' });
  await warte(150);
  stop = true;
  await schleife;
  assert.deepEqual(geholt, [1], 'nach der Pause kein neuer Stapel');
  assert.deepEqual(fertig, [1], 'der laufende Stapel wurde fertig');
});

await pruefe('W7 durchlauf trotz Pause, einmal, Pause bleibt', async () => {
  let laeufe = 0;
  let sahPause = 'unbekannt';
  W.registriereWorker({
    name: 'a',
    beschreibung: 'A',
    durchlauf: async () => { laeufe++; sahPause = W.workerPausiert('a'); await warte(30); return { n: laeufe }; },
  });
  W.pausiereWorker('a', { dauer_min: 5, grund: 'schrittweise' });
  const lauf = W.loeseWorkerDurchlaufAus('a');
  await assert.rejects(W.loeseWorkerDurchlaufAus('a'), (e) => e.code === 'durchlauf_laeuft');
  const erg = await lauf;
  assert.equal(erg.ok, true);
  assert.equal(erg.trotz_pause, true);
  assert.deepEqual(erg.ergebnis, { n: 1 });
  assert.equal(sahPause, null, 'im Durchlauf gilt die Pause nicht');
  assert.ok(W.workerPausiert('a'), 'Pause bleibt nach dem Durchlauf');
  W.registriereWorker({ name: 'ohne', beschreibung: 'O' });
  await assert.rejects(W.loeseWorkerDurchlaufAus('ohne'), (e) => e.code === 'kein_durchlauf');
});

await pruefe('W8 Neustart: frisches Modul kennt keine Pause', async () => {
  W.registriereWorker({ name: 'a', beschreibung: 'A' });
  W.pausiereWorker('a', { dauer_min: 5, grund: 'vor Neustart' });
  const frisch = await import('../dist/services/worker-steuerung.js?neustart=' + Date.now());
  frisch.registriereWorker({ name: 'a', beschreibung: 'A' });
  assert.equal(frisch.workerPausiert('a'), null);
  assert.ok(W.workerPausiert('a'), 'alter Prozess-Zustand unberuehrt');
});

await pruefe('W9 intern-Dispatch worker_*', async () => {
  W.registriereWorker({ name: 'parser', beschreibung: 'P', durchlauf: async () => ({ dateien: 0 }) });
  W.registriereWorker({ name: 'gpu_knoten', beschreibung: 'G' });
  let r = await T.fuehreInternAus({ action: 'worker_pausieren', worker: ['parser', 'gpu_knoten'], dauer_min: 3, grund: 'Test' }, 'tester');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.pausiert.length, 2);
  r = await T.fuehreInternAus({ action: 'worker_status' });
  assert.equal(r.success, true);
  assert.deepEqual(r.pausiert.sort(), ['gpu_knoten', 'parser']);
  assert.equal(r.worker.find((w) => w.name === 'parser').pause.von, 'tester');
  assert.ok('pg_schalter' in r);
  r = await T.fuehreInternAus({ action: 'worker_durchlauf', worker: 'parser' });
  assert.equal(r.success, true);
  assert.deepEqual(r.ergebnis, { dateien: 0 });
  r = await T.fuehreInternAus({ action: 'worker_fortsetzen', worker: '["parser"]' });
  assert.deepEqual(r.fortgesetzt, ['parser']);
  r = await T.fuehreInternAus({ action: 'worker_pausieren', worker: 'parser', grund: 'x' });
  assert.equal(r.success, false);
  assert.equal(r.error, 'dauer_fehlt');
  r = await T.fuehreInternAus({ action: 'worker_pausieren', worker: 'nix', dauer_min: 1, grund: 'x' });
  assert.equal(r.error, 'unbekannter_worker');
  r = await T.fuehreInternAus({ action: 'worker_durchlauf', worker: ['parser', 'gpu_knoten'] });
  assert.equal(r.error, 'parameter_ungueltig');
});

console.log(`ALLE PRUEFUNGEN GRUEN (${ok})`);
process.exit(0);
