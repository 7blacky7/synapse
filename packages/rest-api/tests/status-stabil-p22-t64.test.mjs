/**
 * P22-T64 Testphase: stabile Bewertung des Runtime-Status (status-stabil.ts, Befund thought 1a233265).
 *  A klassifiziereLauf: eindeutig (ok, ausgeloggt, container_aus, nicht_installiert) vs. unklar (timeout, fehler)
 *  B Schalter EIN: gut -> Timeout behaelt guten Stand (haengt, Alter) -> Abmeldung 1/2 behaelt, 2/2 schaltet um
 *  C Schalter EIN: guter Stand zu alt -> frisch; Container aus -> sofort frisch, guter Stand verworfen
 *  D Schalter AUS: ungefiltert, Debugfeld pruefung trotzdem da; Schalter nicht lesbar -> AUS
 *  E Produkt-Schalter im Katalog, nur ausdruecklich (core)
 * Keine DB, kein Docker, kein Netz (Schalter per Fake).
 *   node packages/rest-api/tests/status-stabil-p22-t64.test.mjs
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
let network = 0;
globalThis.fetch = async () => { network++; throw Error('Testnetz gesperrt'); };
const failures = []; let checks = 0;
function check(ok, label) { checks++; if (!ok) { failures.push(label); console.error('FAIL ' + label); } }
async function section(name, fn) { try { await fn(); console.log('ABSCHNITT ' + name + ' durchlaufen'); } catch (e) { failures.push(name + ': ' + e.message); console.error('FAIL Abschnitt ' + name + ': ' + e.stack); } }

const S = await load('packages/rest-api/dist/services/agent-runtime/status-stabil.js');
const status = (o = {}) => ({ runtime: 'claude', role: 'main', configured: true, installed: true, rootPath: '/r', image: 'i', model: null,
  container: { name: 'c', id: '1', status: 'running' }, authentication: { status: 'authenticated', method: 'claude.ai' }, version: '2.1', lastError: null,
  assignedToMain: true, ...o });
const timeout = () => status({ installed: false, authentication: { status: 'unknown' }, version: null, lastError: 'x',
  diagnostic: { code: 'probe_timeout', message: 'Runtime-Pruefung nach 5000ms abgebrochen' } });
const ausgeloggt = () => status({ authentication: { status: 'not_authenticated' } });
const ein = (o = {}) => async () => ({ aktiv: true, quelle: 'produkt-schalter', negativ_bestaetigung: 2, guter_stand_minuten: 10, letzter_fehler: null, ...o });

await section('A klassifiziereLauf', async () => {
  const k = (s, e = true) => S.klassifiziereLauf(s, e);
  check(k(status()).ergebnis === 'ok' && k(status()).eindeutig, 'ok eindeutig');
  check(k(timeout()).ergebnis === 'timeout' && !k(timeout()).eindeutig, 'probe_timeout unklar');
  check(k(status({ diagnostic: { code: 'pid_limit', message: 'x' } })).ergebnis === 'fehler', 'pid_limit -> fehler (unklar)');
  check(k(status({ container: { name: 'c', id: null, status: 'stopped' } })).ergebnis === 'container_aus', 'Container gestoppt eindeutig');
  check(k(status({ container: { name: 'c', id: null, status: 'error' } })).eindeutig === false, 'Container-Fehler unklar');
  check(k(status({ installed: false, authentication: { status: 'unknown' } })).ergebnis === 'nicht_installiert', 'nicht installiert eindeutig');
  check(k(ausgeloggt(), true).ergebnis === 'ausgeloggt' && k(ausgeloggt(), false).ergebnis === 'fehler', 'not_authenticated nur mit lesbarer Ausgabe eindeutig');
  check(k(status({ authentication: { status: 'unknown' } })).ergebnis === 'fehler', 'unknown unklar');
});

await section('B Schalter EIN: Timeout und Abmeldung', async () => {
  let t = 1_000_000;
  const st = new S.StatusStabilisierer(ein(), () => t);
  const r1 = await st.bewerte(status(), true, 300);
  check(r1.authentication.status === 'authenticated' && r1.pruefung.quelle === 'frisch' && r1.pruefung.letzter_lauf.ergebnis === 'ok' && r1.pruefung.haengt === false, 'gut -> frisch');
  t += 40_000;
  const r2 = await st.bewerte(timeout(), false, 5200);
  check(r2.authentication.status === 'authenticated' && r2.installed === true && r2.pruefung.quelle === 'letzter_guter_stand' && r2.pruefung.haengt === true, 'Timeout -> guter Stand bleibt, haengt');
  check(r2.pruefung.alter_sekunden === 40 && r2.pruefung.letzter_lauf.dauer_ms === 5200 && /Pruefung haengt/.test(r2.pruefung.hinweis) && /vor 40 s/.test(r2.pruefung.hinweis), 'Alter und Hinweis');
  check(r2.pruefung.schalter.aktiv === true && r2.pruefung.schalter.quelle === 'produkt-schalter', 'Schalterquelle sichtbar');
  t += 5_000;
  const r3 = await st.bewerte(ausgeloggt(), true, 400);
  check(r3.authentication.status === 'authenticated' && r3.pruefung.negativ_in_folge === 1 && /1\/2/.test(r3.pruefung.hinweis) && r3.pruefung.haengt === false, 'Abmeldung 1/2 -> guter Stand mit Hinweis');
  t += 5_000;
  const r4 = await st.bewerte(ausgeloggt(), true, 400);
  check(r4.authentication.status === 'not_authenticated' && r4.pruefung.quelle === 'frisch' && /2x in Folge/.test(r4.pruefung.hinweis), 'Abmeldung 2/2 -> umgeschaltet');
  t += 5_000;
  const r5 = await st.bewerte(timeout(), false, 5100);
  check(r5.authentication.status === 'unknown' && r5.pruefung.quelle === 'frisch', 'nach bestaetigter Abmeldung kein alter guter Stand mehr');
  t += 5_000;
  const r6 = await st.bewerte(status(), true, 200);
  check(r6.pruefung.negativ_in_folge === 0 && r6.authentication.status === 'authenticated', 'wieder gut -> Zaehler 0');
  const st3 = new S.StatusStabilisierer(ein({ negativ_bestaetigung: 3 }), () => t);
  await st3.bewerte(status(), true, 1);
  await st3.bewerte(ausgeloggt(), true, 1);
  const n2 = await st3.bewerte(ausgeloggt(), true, 1);
  check(n2.authentication.status === 'authenticated' && /2\/3/.test(n2.pruefung.hinweis), 'Einstellwert status_negativ_bestaetigung wirkt (3)');
});

await section('C Alter und Container aus', async () => {
  let t = 0;
  const st = new S.StatusStabilisierer(ein({ guter_stand_minuten: 1 }), () => t);
  await st.bewerte(status(), true, 1);
  t += 61_000;
  const r = await st.bewerte(timeout(), false, 5000);
  check(r.authentication.status === 'unknown' && r.pruefung.quelle === 'frisch' && /aelter als 1 min/.test(r.pruefung.hinweis ?? ''), 'guter Stand zu alt -> frisch mit Hinweis');
  const st2 = new S.StatusStabilisierer(ein(), () => t);
  await st2.bewerte(status(), true, 1);
  const aus = await st2.bewerte(status({ container: { name: 'c', id: null, status: 'stopped' } }), true, 50);
  check(aus.container.status === 'stopped' && aus.pruefung.quelle === 'frisch' && aus.pruefung.bestaetigt_am === null, 'Container aus -> sofort, guter Stand verworfen');
  const danach = await st2.bewerte(timeout(), false, 5000);
  check(danach.pruefung.quelle === 'frisch', 'danach kein guter Stand mehr');
});

await section('D Schalter AUS: ungefiltert', async () => {
  const st = new S.StatusStabilisierer(async () => ({ aktiv: false, quelle: 'standard', negativ_bestaetigung: 2, guter_stand_minuten: 10, letzter_fehler: null }), () => 0);
  await st.bewerte(status(), true, 1);
  const r = await st.bewerte(timeout(), false, 5200);
  check(r.authentication.status === 'unknown' && r.installed === false && r.pruefung.quelle === 'frisch' && r.pruefung.schalter.aktiv === false, 'Timeout ungefiltert');
  check(/Schalter runtime_status_stabil AUS/.test(r.pruefung.hinweis ?? ''), 'Hinweis Schalter AUS');
  const ohneDebug = { ...r }; delete ohneDebug.pruefung;
  check(JSON.stringify(ohneDebug) === JSON.stringify(timeout()), 'ohne pruefung byte-gleich zum frischen Status');
  const st2 = new S.StatusStabilisierer(async () => { throw new Error('PG weg'); }, () => 0);
  await st2.bewerte(status(), true, 1);
  const r2 = await st2.bewerte(timeout(), false, 1);
  check(r2.authentication.status === 'unknown' && r2.pruefung.schalter.aktiv === false, 'Schalter nicht lesbar -> AUS');
});

await section('E Produkt-Schalter im Katalog', async () => {
  const sch = await load('packages/core/dist/services/agent-profil-schalter.js');
  check(sch.PROFIL_PRODUKT_FUNKTIONEN.includes('runtime_status_stabil'), 'runtime_status_stabil im Katalog');
  const u = await load('packages/core/dist/services/runtime-ueberwachung.js');
  const e = u.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN;
  check(e.status_negativ_bestaetigung?.standard === 2 && e.status_guter_stand_minuten?.standard === 10, 'Einstellwerte mit Code-Standard');
});

check(network === 0, 'keine Netzwerkaufrufe');
console.log('P22-T64: ' + checks + ' Pruefungen, ' + failures.length + ' Fehler');
process.exit(failures.length ? 1 : 0);
