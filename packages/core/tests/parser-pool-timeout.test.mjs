/**
 * P15-T19 (11.10.2026): PARSER-POOL OHNE DOPPELTEN NEUSTART NACH TIMEOUT.
 *
 * Ablauf nachgestellt aus thought 07ac26de (PTZ-24): Poolgroesse 1, PARSER_TIMEOUT_MS klein fuer
 * eine grosse Datei, dazwischen erfolgreiche kleine Parses, Threadzahl ueber /proc/self/task
 * (NICHT slots.length - der Fehler war gerade ein Worker, den der Pool nicht mehr kennt).
 *
 * ZUSAGEN:
 *   A1 je Timeout: ParseTimeoutError, Threadzahl bleibt auf dem Stand nach init (kein ungetrackter Worker)
 *   A2 Folgeauftrag nach JEDEM Timeout (auch nach dem 4. und 5.) wird erledigt, Queue leer, Slot nicht stillgelegt
 *   A3 nach shutdown: Threadzahl wieder wie vor dem Pool, kein exit ausstehend
 *   C1 echter Absturz (Worker stirbt ohne Zutun des Pools): Neustart, Retry-Zaehler zaehlt hoch
 *   C2 Erfolg setzt den Zaehler WIRKLICH zurueck: 3 Abstuerze, Erfolg, 3 Abstuerze -> Slot lebt
 *   C3 4 Abstuerze ohne Erfolg dazwischen -> stillgelegt: laufender Auftrag 'parser worker failed',
 *      wartender und neue Auftraege sofort ParserPoolStillgelegtError statt ewig pending
 *   C4 nach PARSER_POOL_WIEDERBELEBUNG_MS: naechster Auftrag belebt den Slot wieder, Erfolg
 *
 * METHODIK (Falle aus 07ac26de): Worker erben execArgv. Jedes Szenario laeuft deshalb in einem
 * eigenen Kindprozess ohne execArgv, Skript als CommonJS ueber stdin, Modul per dynamic import.
 * Aufruf: node packages/core/tests/parser-pool-timeout.test.mjs (braucht gebautes dist).
 *   SZ_DIST_DIR=<pfad zu einem dist> prueft einen anderen Stand (Positivkontrolle gegen den alten Code).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const hier = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.SZ_DIST_DIR ? path.resolve(process.env.SZ_DIST_DIR) : path.join(hier, '..', 'dist');
const poolUrl = pathToFileURL(path.join(distDir, 'parser', 'worker-pool.js')).href;

const GEMEINSAM = `
const fs = require('fs');
const threads = () => fs.readdirSync('/proc/self/task').length;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const mitFrist = (p, ms) => Promise.race([
  p.then(() => ({ st: 'ok' }), (e) => ({ st: 'fehler', name: e && e.name, msg: e && e.message })),
  warte(ms).then(() => ({ st: 'pending' })),
]);
const klein = { filePath: 'k.ts', fileType: 'ts', content: 'export const a = 1;\\n' };
const gross = { filePath: 'g.ts', fileType: 'ts', content: 'export const x = 1;\\n'.repeat(200000) };
const fertig = (out) => { console.log('ERGEBNIS ' + JSON.stringify(out)); process.exit(0); };
const fehler = (e) => fertig({ absturz: String((e && e.stack) || e) });
`;

const SZENARIO_TIMEOUT = GEMEINSAM + `
(async () => {
  const WP = await import(process.env.SZ_URL);
  const out = { schritte: [] };
  out.basis = threads();
  const pool = new WP.ParserWorkerPool(1);
  pool.init();
  process.env.PARSER_TIMEOUT_MS = '60000';
  out.init = (await mitFrist(pool.parse(klein), 20000)).st;
  await warte(200);
  out.nachInit = threads();
  for (let i = 1; i <= 5; i++) {
    process.env.PARSER_TIMEOUT_MS = '5';
    const t = await mitFrist(pool.parse(gross), 5000);
    process.env.PARSER_TIMEOUT_MS = '60000';
    await warte(400);
    const thr = threads();
    const z = pool.slotZustand().slots[0];
    const f = await mitFrist(pool.parse(klein), 5000);
    out.schritte.push({
      i, timeout: t.name || t.st, threads: thr, retries: z.retries, stillgelegt: z.stillgelegt,
      folge: f.st, folgeFehler: f.msg || null, queue: pool.warteschlange(),
      retriesNachErfolg: pool.slotZustand().slots[0].retries,
    });
  }
  await warte(300);
  out.threadsEnde = threads();
  const z = pool.slotZustand();
  out.beendetGesamt = z.beendet_gesamt;
  out.exitAusstehend = z.beendet_exit_ausstehend;
  await pool.shutdown();
  await warte(500);
  out.nachShutdown = threads();
  fertig(out);
})().catch(fehler);
`;

const SZENARIO_ABSTURZ = GEMEINSAM + `
(async () => {
  process.env.PARSER_POOL_WIEDERBELEBUNG_MS = '500';
  process.env.PARSER_TIMEOUT_MS = '60000';
  const WP = await import(process.env.SZ_URL);
  const out = {};
  out.basis = threads();
  const pool = new WP.ParserWorkerPool(1);
  pool.init();
  out.init = (await mitFrist(pool.parse(klein), 20000)).st;
  await warte(200);
  out.nachInit = threads();
  // Absturz von aussen: der Pool hat den Worker NICHT selbst beendet (kein beende()).
  const stuerze = async () => { await pool.slots[0].worker.terminate(); await warte(300); };
  const retries = () => pool.slotZustand().slots[0].retries;
  for (let i = 0; i < 3; i++) await stuerze();
  out.r1Retries = retries();
  out.r1Threads = threads();
  out.r1Erfolg = (await mitFrist(pool.parse(klein), 5000)).st;
  out.r1RetriesNachErfolg = retries();
  for (let i = 0; i < 3; i++) await stuerze();
  out.r2Retries = retries();
  out.r2Erfolg = (await mitFrist(pool.parse(klein), 5000)).st;
  out.r2Threads = threads();
  // Runde 3: vier Abstuerze ohne Erfolg; beim vierten laeuft ein Auftrag und einer wartet.
  for (let i = 0; i < 3; i++) await stuerze();
  const laufend = mitFrist(pool.parse(gross), 5000);
  const wartend = mitFrist(pool.parse(klein), 5000);
  out.queueVorAbsturz = pool.warteschlange();
  await stuerze();
  out.r3Laufend = await laufend;
  out.r3Wartend = await wartend;
  out.r3Stillgelegt = pool.slotZustand().slots[0].stillgelegt;
  out.r3Neu = await mitFrist(pool.parse(klein), 1000);
  out.r3Queue = pool.warteschlange();
  await warte(700);
  out.r4Neu = (await mitFrist(pool.parse(klein), 5000)).st;
  out.r4Retries = retries();
  out.r4Stillgelegt = pool.slotZustand().slots[0].stillgelegt;
  await warte(200);
  out.r4Threads = threads();
  await pool.shutdown();
  await warte(500);
  out.nachShutdown = threads();
  fertig(out);
})().catch(fehler);
`;

function szenario(skript) {
  return new Promise((resolve, reject) => {
    const kind = spawn(process.execPath, ['-'], {
      env: { ...process.env, SZ_URL: poolUrl, PARSER_WORKER_THREADS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let aus = '';
    let err = '';
    const frist = setTimeout(() => { kind.kill('SIGKILL'); }, 120_000);
    kind.stdout.on('data', (d) => { aus += d; });
    kind.stderr.on('data', (d) => { err += d; });
    kind.on('error', reject);
    kind.on('close', () => {
      clearTimeout(frist);
      const zeile = aus.split('\n').find((z) => z.startsWith('ERGEBNIS '));
      if (!zeile) return reject(new Error(`kein Ergebnis. stdout=${aus.slice(-2000)} stderr=${err.slice(-2000)}`));
      resolve({ ergebnis: JSON.parse(zeile.slice('ERGEBNIS '.length)), stderr: err });
    });
    kind.stdin.end(skript);
  });
}

let ok = 0;
let fehlgeschlagen = 0;
function pruefe(bedingung, name, beleg) {
  if (bedingung) { ok++; console.log('OK    ' + name); }
  else { fehlgeschlagen++; console.log('FEHLER ' + name + (beleg === undefined ? '' : ' ' + JSON.stringify(beleg))); }
}

console.log(`dist: ${distDir}`);

const a = (await szenario(SZENARIO_TIMEOUT)).ergebnis;
console.log('MESSUNG A ' + JSON.stringify(a));
pruefe(!a.absturz && a.init === 'ok', 'A0 Pool startet, erster Parse ok', a);
for (const s of a.schritte ?? []) {
  pruefe(s.timeout === 'ParseTimeoutError' && s.threads === a.nachInit,
    `A1 Timeout ${s.i}: ParseTimeoutError, Threads ${s.threads} = ${a.nachInit} nach init`, s);
  pruefe(s.folge === 'ok' && s.queue === 0 && !s.stillgelegt && s.retriesNachErfolg === 0,
    `A2 Folgeauftrag nach Timeout ${s.i} erledigt (Slot lebt, Queue leer)`, s);
}
pruefe(a.threadsEnde === a.nachInit && a.exitAusstehend === 0 && a.nachShutdown === a.basis,
  `A3 Threads Ende ${a.threadsEnde}=${a.nachInit}, nach shutdown ${a.nachShutdown}=${a.basis}, exit ausstehend 0`, a);

const c = (await szenario(SZENARIO_ABSTURZ)).ergebnis;
console.log('MESSUNG C ' + JSON.stringify(c));
pruefe(!c.absturz && c.init === 'ok', 'C0 Pool startet, erster Parse ok', c);
pruefe(c.r1Retries === 3 && c.r1Threads === c.nachInit && c.r1Erfolg === 'ok' && c.r1RetriesNachErfolg === 0,
  'C1 drei echte Abstuerze: je ein Neustart, Zaehler 3, Threads konstant, danach Erfolg mit Zaehler 0', c);
pruefe(c.r2Retries === 3 && c.r2Erfolg === 'ok' && c.r2Threads === c.nachInit,
  'C2 Erfolg setzt den Zaehler wirklich zurueck: nochmals drei Abstuerze, Slot lebt', c);
pruefe(c.queueVorAbsturz === 1 && c.r3Laufend?.st === 'fehler' && /parser worker failed/.test(c.r3Laufend?.msg ?? '')
  && c.r3Wartend?.name === 'ParserPoolStillgelegtError' && c.r3Stillgelegt === true
  && c.r3Neu?.name === 'ParserPoolStillgelegtError' && c.r3Queue === 0,
  'C3 vierter Absturz in Folge: stillgelegt, wartender und neuer Auftrag sofort abgelehnt statt pending', c);
pruefe(c.r4Neu === 'ok' && c.r4Retries === 0 && c.r4Stillgelegt === false && c.r4Threads === c.nachInit && c.nachShutdown === c.basis,
  'C4 nach der Pause wiederbelebt: Erfolg, Threads wie nach init, nach shutdown wie vorher', c);

console.log(`\n${ok} OK, ${fehlgeschlagen} FEHLER`);
process.exit(fehlgeschlagen === 0 ? 0 : 1);
