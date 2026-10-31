/**
 * P22-T229 (User 31.10.2026 ~14:55, Screenshot Hauptagent > Arbeitsraum > Agentennetzwerk; Testphase P22-T233):
 * "... ein oder mehrere Agenten mit Visum, dann erscheint auch sein Projekt als Sonne ... Und wenn das Visum abgelaufen ist und kein
 * Visums-Agent mehr im Projekt sucht, dann verschwindet die andere Projekt-Sonne wieder langsam."
 * Koordinator 31479: keine eigene Fenster-Einstellung, Sonne bis visum_bis (Ausweis-Fristen), neu nur fremd_sonne_ausblend_sekunden.
 * Umsetzung: thought 03565296 (Bestand 18516add); Daten P22-T232 (thought 6733c4f7).
 *   pnpm -C packages/core build   (dist frisch, P22-T233 Schritt 1)
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/web-ui/tests/visum-sonnen-p22-t229.test.mjs
 * A web-ui netzwerk/sonnen.ts: zielProjekt, sonnenWerte, sonnenSicht (Zugangsende, Rueckfall inaktiv_sekunden, lineares Ausblenden),
 *   fremdSonnen (Heimat aus Ereignissen und visa[], Main/eigene Agenten ausgenommen, abgelaufene weg, Gedaechtnis haelt bis zum Ende
 *   des Ausblendens, verlaengertes Visum), ohneHeimatAufrufe (Schalter AUS), sonnenFade = sonnenSicht, sonnenFarbe, sonnenDebug.
 * B web-ui netzwerk/nerven-szene.ts: Schalter AUS = Layout wie ohne die neuen Felder (heutiges Verhalten); EIN = Heimat-Sonne
 *   rolle 'sonne', Visum-Agent haengt an ihr, Sonne aussen hinter ihm, Bahn vom Kern, keine Randbeschriftung, Sonne nur aus visa[].
 * C core: Produkt-Schalter netzwerk_visum_sonnen im Katalog und nur ausdruecklich; Einstellung fremd_sonne_ausblend_sekunden;
 *   leseNetzwerkKonfiguration gegen synapse_test (privates Schema): Standard AUS, EIN ohne Datengrundlage -> letzter_fehler
 *   datengrundlage_aus, mit netzwerk_datengrundlage -> ohne Fehler.
 * D Agentennetzwerk.tsx (statisch): Impulsziel = Sonne des Zielprojekts, AUS filtert Heimat-Aufrufe, Ausblenden je Frame, Debug-Attribute;
 *   genau eine Sonnen-Datei (keine fremd-sonnen.ts).
 * E Fall-Skill-Seed (scripts/skills-seed-laden.mjs, vorhandener Ladeweg): fall-admin-agentennetzwerk nennt Einstellung und Schalter.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
const requireCore = createRequire(join(repo, 'packages/core/package.json'));
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log('OK ' + m); };
const nah = (a, b) => Math.abs(a - b) < 1e-6;

const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.port, '5433', 'nur synapse_test');
assert.equal(db.pathname, '/synapse_test', 'nur synapse_test');
for (const k of ['SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID']) delete process.env[k];
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '0', SYNAPSE_W1B_GATE_TTL_MS: '0', QDRANT_URL: 'http://127.0.0.1:1', OLLAMA_URL: 'http://127.0.0.1:1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' });
globalThis.fetch = async () => { throw Error('Testnetz gesperrt'); };

const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { Pool } = requireCore('pg');
const admin = new Pool({ connectionString: db.href });
const schema = 'p22_t229_' + process.pid + '_' + randomUUID().slice(0, 8);
let C, failure;
try {
 const F = await vite.ssrLoadModule('/src/components/netzwerk/sonnen.ts');
 const S = await vite.ssrLoadModule('/src/components/netzwerk/nerven-szene.ts');

 // ---------- Fixture ----------
 const jetzt = Date.now(), iso = (d = 0) => new Date(jetzt + d).toISOString(), MIN = 60_000;
 const werte = { aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8, ereignis_limit: 300, animation_limit: 80, animation_ms: 1800,
  plan_nachleuchten_sekunden: 3, plan_nachleuchten_auto_sekunden: 3, plan_mindestanzeige_sekunden: 3, abgleich_sekunden: 15, orbit_nebel: 1, an_user_animation: 1, fremd_sonne_ausblend_sekunden: 8 };
 const ag = (id, rolle, project = 'synapse', agent = id) => ({ id, agent, name: agent, rolle, project, identity_id: id, zuletzt_aktiv: iso(-1000), kanaele: [] });
 const ev = (id, agent, identity_id, extra = {}) => ({ id, zeit: iso(-500), project: 'synapse', agent, identity_id, lauf_id: null, tool: 'code_intel', action: 'search', ok: true,
  empfaenger: [], channel: null, interaktion: 'aufruf', quelle: 'tool_calls', routing: 'nicht_erfasst', ergebnis_art: 'erfolg', fehler_code: null, ...extra });
 const MOO_BIS = jetzt + 20 * MIN;
 const visum = { zugang: 'visum', visum_bis: new Date(MOO_BIS).toISOString() };
 const ereignisse = [
  ev('1', 'moo-a', 'id-moo-a', { heimat_projekt: 'moo', ziel_projekt: 'synapse', ...visum }),                      // Visum-Agent arbeitet in synapse
  ev('2', 'moo-a', 'id-moo-a', { project: 'moo', heimat_projekt: 'moo', ziel_projekt: 'moo', ...visum }),           // ... liest in seiner Heimat
  ev('3', 'synapse-hauptagent', 'main-id', { heimat_projekt: 'synapse-hauptagent', ziel_projekt: 'synapse', zugang: 'visum', visum_bis: iso(30 * MIN) }), // Main: nie Visum-Sonne
  ev('4', 'koord', 'koord', { heimat_projekt: 'synapse', ziel_projekt: 'synapse' }),                               // eigener Agent
  ev('5', 'baz-b', 'id-baz-b', { zeit: iso(-70_000), heimat_projekt: 'baz', ziel_projekt: 'synapse', zugang: 'visum', visum_bis: iso(-60_000) }), // Visum seit 60 s abgelaufen
  ev('6', 'moo-a', 'id-moo-a', { project: 'drittes', heimat_projekt: 'moo', ziel_projekt: 'drittes', ...visum }),   // Ziel ohne Sonne
 ];
 const visa = [
  { identity_id: 'id-qux-c', agent: 'qux-c', heimat_projekt: 'qux', zugang: 'arbeitsfreigabe', visum_bis: iso(60 * MIN) }, // gueltig, ohne Aufruf im Fenster
  { identity_id: 'id-alt', agent: 'alt-d', heimat_projekt: 'alt', zugang: 'visum', visum_bis: iso(-5 * MIN) },             // abgelaufen
  { identity_id: 'main-id', agent: 'synapse-hauptagent', heimat_projekt: 'synapse-hauptagent', zugang: 'visum', visum_bis: iso(30 * MIN) },
 ];
 const snap = (x = {}) => ({ version: 1, stand: iso(), project: 'synapse', schalter: { aktiv: true, quelle: 'test', bis: null, letzter_fehler: null }, werte, einstellungen: {},
  agenten: [ag('main-id', 'main', 'synapse-hauptagent', 'synapse-hauptagent'), ag('koord', 'koordinator')], ereignisse, channel_ereignisse: [], plaene: [], plaene_ende: [],
  begrenzt: 0, letzter_fehler: null, visa, visum_sonnen: { aktiv: true, quelle: 'test', letzter_fehler: null }, ...x });

 // ---------- A sonnen.ts ----------
 ok(F.zielProjekt({ project: 'synapse', ziel_projekt: 'moo' }) === 'moo' && F.zielProjekt({ project: 'synapse' }) === 'synapse' && F.zielProjekt({ project: 'synapse', ziel_projekt: null }) === 'synapse',
  'A zielProjekt: ziel_projekt (T232), sonst project (aeltere Server)');
 ok(F.heimatProjekt({ heimat_projekt: 'moo' }) === 'moo' && F.heimatProjekt({}) === null, 'A heimatProjekt: unbekannt = null');
 const w0 = F.sonnenWerte({}), w1 = F.sonnenWerte({ fremd_sonne_ausblend_sekunden: 20, inaktiv_sekunden: 60 });
 ok(w0.ausblendMs === 8000 && w0.inaktivMs === 120000 && w1.ausblendMs === 20000 && w1.inaktivMs === 60000, 'A sonnenWerte: Standard 8 s / inaktiv 120 s, sonst aus snapshot.werte (Sekunden)');
 const t0 = 1_000_000, bis = t0 + 30 * MIN;
 let s = F.sonnenSicht(t0, bis, t0 + MIN, w0);
 ok(s.fade === 1 && s.grund === 'zugang_gueltig' && s.ende === bis, 'A sonnenSicht: sichtbar bis zum Zugangsende (visum_bis), nicht nur im Aktivitaetsfenster');
 s = F.sonnenSicht(t0, bis, bis + 4000, w0);
 ok(nah(s.fade, 0.5) && s.grund === 'zugang_abgelaufen', 'A nach Visum-Ende linear ausblenden (4 von 8 s -> 50 %)');
 ok(F.sonnenSicht(t0, bis, bis + 8000, w0).fade === 0, 'A nach der Ausblenddauer weg');
 s = F.sonnenSicht(t0, null, t0 + 60_000, w0);
 ok(s.fade === 1 && s.grund === 'aktiv' && s.ende === t0 + 120_000, 'A ohne Zugangsende: Rueckfall letzte Aktivitaet + inaktiv_sekunden (kein neues Fenster)');
 s = F.sonnenSicht(t0, null, t0 + 124_000, w0);
 ok(nah(s.fade, 0.5) && s.grund === 'keine_aktivitaet', 'A ohne Zugangsende: danach ebenso ausblenden');
 ok(F.sonnenSicht(t0, t0 - MIN, t0 + 1, w0).ende === t0, 'A veraltetes Zugangsende vor der letzten Aktivitaet: Ende = letzte Aktivitaet');
 ok(F.sonnenSicht(t0, bis, bis + 1, { ausblendMs: 0, inaktivMs: 1 }).fade === 0, 'A Ausblenddauer 0: sofort weg');
 for (const d of [-1, 0, 2000, 4000, 7999, 9000]) {
  const sicht = F.sonnenSicht(t0, bis, bis + d, w0);
  if (!nah(F.sonnenFade({ ende: sicht.ende, ausblendMs: w0.ausblendMs }, bis + d), sicht.fade)) throw Error('sonnenFade weicht ab bei ' + d);
 }
 ok(true, 'A sonnenFade (je Frame) = sonnenSicht.fade an jeder Stelle');

 const st = F.fremdSonnen(snap(), jetzt);
 ok(JSON.stringify(st.sonnen.map(x => x.projekt)) === '["moo","qux"]', 'A fremdSonnen: moo (Ereignisse) und qux (nur visa[]); Main, eigene Agenten, abgelaufenes baz und alt fehlen');
 const moo = st.sonnen[0], qux = st.sonnen[1];
 ok(moo.agenten.join() === 'moo-a' && moo.aufrufe === 3 && moo.heimatAufrufe === 1 && moo.zugang === 'visum' && moo.zugangBis === MOO_BIS && moo.grund === 'zugang_gueltig' && moo.fade === 1,
  'A moo: Agent, 3 Aufrufe davon 1 im Heimatprojekt, Zugang visum bis visum_bis');
 ok(qux.agenten.join() === 'qux-c' && qux.zugang === 'arbeitsfreigabe' && qux.aufrufe === 0 && qux.fade === 1, 'A qux: Sonne aus gueltiger Arbeitsfreigabe ohne Aufruf im Fenster');
 ok(st.heimat.get('id-moo-a') === 'moo' && st.heimat.get('moo-a') === 'moo' && st.heimat.get('id-qux-c') === 'qux' && !st.heimat.has('id-baz-b') && !st.heimat.has('main-id') && !st.heimat.has('koord'),
  'A Heimat-Zuordnung nur fuer sichtbare Sonnen (Identitaet und Name)');
 ok(st.ohneSonne === 1, 'A Debug: 1 Aufruf mit Zielprojekt ohne Sonne (drittes)');
 const mitBaz = F.fremdSonnen(snap({ ereignisse: [...ereignisse.slice(0, 4), ev('5', 'baz-b', 'id-baz-b', { zeit: iso(-70_000), heimat_projekt: 'baz', ziel_projekt: 'synapse', zugang: 'visum', visum_bis: iso(-4000) })] }), jetzt);
 const baz = mitBaz.sonnen.find(x => x.projekt === 'baz');
 ok(baz && nah(baz.fade, 0.5) && baz.grund === 'zugang_abgelaufen', 'A baz 4 s nach Visum-Ende: blendet aus (50 %)');

 // Gedaechtnis: Sonne bleibt bis zum Ende des Ausblendens, auch ohne Daten im Snapshot.
 const ged = new Map();
 F.fremdSonnen(snap(), jetzt, ged);
 const leer = snap({ ereignisse: [], visa: [] });
 const spaeter = F.fremdSonnen(leer, MOO_BIS + 4000, ged);
 // Ohne Daten gibt es auch keinen Agenten-Knoten mehr; die Heimat-Zuordnung kommt nur aus frischen Ereignissen/visa[].
 ok(spaeter.sonnen.map(x => x.projekt).join() === 'moo,qux' && nah(spaeter.sonnen[0].fade, 0.5) && spaeter.sonnen[0].agenten.join() === 'moo-a' && spaeter.sonnen[1].fade === 1 && spaeter.heimat.size === 0,
  'A Gedaechtnis: ohne Daten bleibt moo bis zum Ende des Ausblendens (50 %, Agentenliste fuers Debug), qux bis zur Arbeitsfreigabe');
 const weg = F.fremdSonnen(leer, MOO_BIS + 9000, ged);
 ok(!weg.sonnen.some(x => x.projekt === 'moo') && !ged.has('moo') && ged.has('qux'), 'A Gedaechtnis: nach dem Ausblenden ist moo entfernt');
 const ged2 = new Map(); F.fremdSonnen(snap(), jetzt, ged2);
 const neuBis = jetzt + 50 * MIN;
 F.fremdSonnen(snap({ ereignisse: [ev('9', 'moo-a', 'id-moo-a', { heimat_projekt: 'moo', ziel_projekt: 'synapse', zugang: 'visum', visum_bis: new Date(neuBis).toISOString() })], visa: [] }), jetzt + 1000, ged2);
 ok(ged2.get('moo').zugangBis === neuBis && F.fremdSonnen(leer, MOO_BIS + 60_000, ged2).sonnen.find(x => x.projekt === 'moo')?.fade === 1, 'A verlaengertes Visum: neues Zugangsende gilt, Sonne bleibt');

 const roh = snap({ channel_ereignisse: [ev('7', 'moo-a', 'id-moo-a', { project: 'moo', heimat_projekt: 'moo', ziel_projekt: 'moo', tool: 'channel', action: 'feed', channel: 'moo-team' }), ev('8', 'koord', 'koord', { tool: 'channel', action: 'post', channel: 't' })] });
 const ohne = F.ohneHeimatAufrufe(roh);
 ok(ohne.ereignisse.map(e => e.id).join() === '1,3,4,5' && ohne.channel_ereignisse.map(e => e.id).join() === '8', 'A ohneHeimatAufrufe: nur Aufrufe fremder Agenten ausserhalb des Projekts fallen weg (auch Channel-Ereignisse)');
 const unveraendert = snap({ ereignisse: ereignisse.filter(e => e.project === 'synapse') });
 ok(F.ohneHeimatAufrufe(unveraendert) === unveraendert && roh.ereignisse.length === 6, 'A ohneHeimatAufrufe: ohne Heimat-Aufrufe derselbe Snapshot, Eingabe unveraendert');
 ok(F.sonnenFarbe('moo') === F.sonnenFarbe('moo') && /^#[0-9a-f]{6}$/.test(F.sonnenFarbe('qux')), 'A sonnenFarbe fest je Projektname');
 const dbg = F.sonnenDebug(moo, jetzt);
 ok(dbg.startsWith('moo (1 Agent, zugang_gueltig, visum') && dbg.includes('1/3 Aufrufe daheim') && F.sonnenDebug({ ...moo, ende: jetzt - 4000 }, jetzt).includes('blendet aus 50 %'), 'A sonnenDebug: Projekt, Agenten, Grund, Zugang, Ausblendstand');

 // ---------- B nerven-szene ----------
 const knotenBild = g => JSON.stringify(g.knoten.map(k => [k.id, k.rolle, k.project, Math.round(k.x), Math.round(k.y)]).sort());
 const ohneFelder = snap({ ereignisse: ereignisse.filter(e => e.project === 'synapse').map(({ heimat_projekt, ziel_projekt, zugang, visum_bis, ...e }) => e), visa: undefined, visum_sonnen: undefined });
 const aus = snap({ visum_sonnen: { aktiv: false, quelle: 'standard', letzter_fehler: null } });
 const gAus = S.netzwerkSzene(F.ohneHeimatAufrufe(aus), jetzt), gAlt = S.netzwerkSzene(ohneFelder, jetzt);
 ok(knotenBild(gAus) === knotenBild(gAlt) && gAus.fremd.length === 0 && !gAus.knoten.some(k => k.rolle === 'sonne'), 'B Schalter AUS: Szene identisch mit einem Snapshot ohne die neuen Felder (heutiges Verhalten)');
 ok(gAus.alias.get('id-moo-a')?.eltern === gAus.kern, 'B Schalter AUS: Visum-Agent haengt wie bisher am Projektkern');
 const ged3 = new Map(), gAn = S.netzwerkSzene(snap(), jetzt, ged3);
 const sMoo = gAn.alias.get('projekt:moo'), sQux = gAn.alias.get('projekt:qux'), vis = gAn.alias.get('id-moo-a');
 ok(sMoo?.rolle === 'sonne' && sMoo.sonne?.projekt === 'moo' && sMoo.fade === 1 && sMoo.farbe === F.sonnenFarbe('moo') && gAn.fremd.map(x => x.projekt).join() === 'moo,qux',
  'B Schalter EIN: Heimat-Sonne moo (rolle sonne, eigene Farbe), Szene.fremd fuer Debug');
 ok(vis && vis.eltern === sMoo && vis.zuordnung.startsWith('Heimat moo · visum in synapse'), 'B Visum-Agent haengt an SEINER Heimat-Sonne');
 ok(Math.hypot(sMoo.x, sMoo.y) > Math.hypot(vis.x, vis.y) + 40 && gAn.kanten.some(([a, b]) => a === gAn.kern && b === sMoo) && gAn.kanten.some(([a, b]) => a === sMoo && b === vis),
  'B Sonne abgesetzt aussen hinter ihrem Agenten, Bahn Kern -> Sonne -> Agent');
 ok(sQux?.rolle === 'sonne' && Math.hypot(sQux.x, sQux.y) > 0 && !gAn.knoten.some(k => k.eltern === sQux), 'B Sonne nur aus visa[] steht ohne Agenten (Zugang gilt)');
 ok(gAn.alias.get('synapse-hauptagent')?.rolle === 'main' && gAn.alias.get('synapse-hauptagent').eltern !== sMoo && !gAn.alias.has('projekt:synapse-hauptagent'), 'B Hauptagent bleibt am Kern, keine Hauptagent-Sonne');
 ok(!gAn.projekte.some(p => p.name === 'moo' || p.name === 'qux') && gAn.alias.get('projekt:synapse') === gAn.kern, 'B fremde Sonnen ohne Randbeschriftung, Kern bleibt das angezeigte Projekt');
 ok(gAn.radius >= Math.hypot(sMoo.x, sMoo.y) + 30, 'B Szenenradius umfasst die fremde Sonne (Einpassen)');
 const gSpaet = S.netzwerkSzene(snap({ ereignisse: [], visa: [] }), MOO_BIS + 4000, ged3);
 ok(gSpaet.alias.get('projekt:moo')?.rolle === 'sonne' && nah(gSpaet.alias.get('projekt:moo').fade, 0.5) && nah(F.sonnenFade(gSpaet.alias.get('projekt:moo').sonne, MOO_BIS + 6000), 0.25),
  'B nach Visum-Ende: Sonne blendet aus dem Gedaechtnis aus, sonnenFade laeuft je Frame weiter');
 ok(!S.netzwerkSzene(snap({ ereignisse: [], visa: [] }), MOO_BIS + 9000, ged3).alias.has('projekt:moo'), 'B nach dem Ausblenden ist die Sonne weg');

 // ---------- C core ----------
 C = await load('packages/core/dist/index.js');
 ok(C.PROFIL_PRODUKT_FUNKTIONEN.includes('netzwerk_visum_sonnen') && C.NUR_AUSDRUECKLICH.includes('netzwerk_visum_sonnen'), 'C Produkt-Schalter netzwerk_visum_sonnen im Katalog, nur ausdruecklich');
 const E = C.NETZWERK_EINSTELLUNGEN.fremd_sonne_ausblend_sekunden;
 ok(E && E.standard === F.SONNEN_STANDARD.fremd_sonne_ausblend_sekunden && E.min === 1 && E.max === 300 && C.netzwerkEinheit('fremd_sonne_ausblend_sekunden') === 's',
  'C Einstellung fremd_sonne_ausblend_sekunden (Standard 8 = Rueckfall in sonnen.ts, Sekunden)');
 ok(!Object.keys(C.NETZWERK_EINSTELLUNGEN).some(n => /fremd_sonne_fenster/.test(n)), 'C keine eigene Fenster-Einstellung (Koordinator 31479)');
 await admin.query('CREATE SCHEMA ' + schema);
 for (const { tablename } of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
  const q = '"' + tablename.replaceAll('"', '""') + '"';
  await admin.query('CREATE TABLE ' + schema + '.' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
 }
 db.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = db.href;
 const pool = C.getPool();
 const { AGENTENNETZWERK_SCHEMA_SQL } = await load('packages/core/dist/db/agentennetzwerk-schema.js');
 await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
 const P = 'p22-t229';
 const k0 = await C.leseNetzwerkKonfiguration(P);
 ok(k0.visum_sonnen && k0.visum_sonnen.aktiv === false && k0.visum_sonnen.letzter_fehler === null && k0.werte.fremd_sonne_ausblend_sekunden === 8, 'C Standard: visum_sonnen AUS, Ausblenden 8 s');
 const setze = (funktion, aktiv) => C.setzeProfilProduktSchalter({ ebene: 'projekt', project: P, funktion, aktiv, grund: 'Test P22-T229 Visum-Sonnen' }, { system: 'user' });
 await setze('netzwerk_visum_sonnen', true);
 const k1 = await C.leseNetzwerkKonfiguration(P);
 ok(k1.visum_sonnen.aktiv === true && k1.visum_sonnen.quelle !== 'standard' && k1.visum_sonnen.letzter_fehler === 'datengrundlage_aus', 'C EIN ohne netzwerk_datengrundlage: Debug letzter_fehler datengrundlage_aus');
 await setze('netzwerk_datengrundlage', true);
 const k2 = await C.leseNetzwerkKonfiguration(P);
 ok(k2.visum_sonnen.aktiv === true && k2.visum_sonnen.letzter_fehler === null && k2.daten_schalter.aktiv === true, 'C EIN mit Datengrundlage: ohne Fehler');
 ok((await C.leseNetzwerkKonfiguration('anderes-projekt')).visum_sonnen.aktiv === false, 'C Schalter je Projekt (anderes Projekt bleibt AUS)');

 // ---------- D Komponente (statisch) ----------
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(tsx.includes("zielK = zs?.rolle === 'sonne' ? zs : g.kern") && tsx.includes("if (ziel !== zielK && (ziel.rolle === 'sonne' || ziel === g.kern)) ziel = zielK;") && tsx.includes('nach: zielK.id'),
  'D Impuls endet an der Sonne des Zielprojekts; Visum-Agent im Gastprojekt direkt zum Kern');
 ok(tsx.includes('roh.visum_sonnen?.aktiv ? roh : ohneHeimatAufrufe(roh)') && tsx.includes('netzwerkSzene(s, jetzt, sonnenGedaechtnis.current)') && tsx.includes('if (k.sonne) k.fade = sonnenFade(k.sonne, jetzt);'),
  'D Schalter AUS filtert Heimat-Aufrufe, Gedaechtnis je Projekt, Ausblenden je Frame');
 ok(['dataset.fremdSonnen', 'dataset.sonnenZiel', 'dataset.visumSonnen', "Visum-Sonnen: {snapshot.visum_sonnen"].every(x => tsx.includes(x)), 'D Debug-Attribute und Debug-Zeile fuer die Abnahme');
 ok(existsSync(join(repo, 'packages/web-ui/src/components/netzwerk/sonnen.ts')) && !existsSync(join(repo, 'packages/web-ui/src/components/netzwerk/fremd-sonnen.ts')), 'D genau eine Sonnen-Datei (netzwerk/sonnen.ts, Koordinator 31483)');

 // ---------- E Seed ----------
 const { ladeSeed } = await load('scripts/skills-seed-laden.mjs');
 const seed = await ladeSeed(join(repo, 'skills', 'seed'));
 const sk = seed.skills.find(x => x.skill_name === 'fall-admin-agentennetzwerk'), text = sk?.sections.map(x => x.content).join('\n') ?? '';
 ok(seed.fehler.length === 0 && /\bfremd_sonne_ausblend_sekunden\b/.test(text) && /\bnetzwerk_visum_sonnen\b/.test(text), 'E Seed (vorhandener Ladeweg) gueltig; fall-admin-agentennetzwerk nennt Einstellung und Schalter');
 console.log('PASS P22-T229 Visum-Sonnen: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await vite.close();
 await C?.closePool?.().catch(() => {});
 await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await admin.end();
}
process.exit(failure ? 1 : 0);
