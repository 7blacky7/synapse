/**
 * P22-T153: fest codierte Darstellungszahlen des Agentennetzwerks live ueber admin(agentennetzwerk).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node --experimental-strip-types packages/rest-api/tests/agentennetzwerk-werte-p22-t153.test.mjs
 * A Katalog: jeder neue Name vorhanden, Ganzzahl, min <= Standard <= max; Standard = bisheriger Code-Wert (Web-UI-Konstanten,
 *   Rueckfallwerte in Agentennetzwerk.tsx, rest-api Cache-Konstanten); Milli-Einheiten ergeben exakt die alten Faktoren.
 * B admin gegen synapse_test (privates Schema): Abweisung ausserhalb min/max, Kommawert, unbekannter Name; Setzen mit Quelle
 *   'einstellung' und Einheit in status; Snapshot traegt die Werte; Index-Cache-Dauer folgt den Werten sofort.
 * C Web-UI-Logik: andere Werte -> anderer Stern, andere Trabanten- und Nebelzahl; ohne Werte wie bisher; Reaktionszeiten/Kappen.
 * D Formular: nur Geaendertes senden, unberuehrte Felder folgen dem Snapshot (Fehlerfix), Gruppen/Beschriftungen/Hilfetext.
 * E Kurztexte und Seed: admin netzwerk_modus/netzwerk_werte mit Kurztext, Seed-Skill fall-admin-agentennetzwerk nennt jeden Namen.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const requireCore = createRequire(join(repo, 'packages/core/package.json'));
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log('OK ' + m); };

const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.port, '5433', 'nur synapse_test');
assert.equal(db.pathname, '/synapse_test', 'nur synapse_test');
for (const k of ['SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID']) delete process.env[k];
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '0', QDRANT_URL: 'http://127.0.0.1:1', OLLAMA_URL: 'http://127.0.0.1:1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' });
globalThis.fetch = async () => { throw Error('Testnetz gesperrt'); };

const NEU = {
 stern_voll_dateien: 10000, stern_min_promille: 80, dateien_je_trabant: 100, trabanten_einzeln: 300, chunks_je_nebelpunkt: 100, nebel_max: 10000,
 nebel_treiben_x_promille: 25, nebel_treiben_y_promille: 20, nebel_treiben_x_mrad_s: 45, nebel_treiben_y_mrad_s: 37, nebel_drehung_mrad: 50, nebel_drehung_mrad_s: 21,
 nebel_puls_promille: 120, nebel_puls_mrad_s: 500, nebel_schimmer_mrad_s: 800,
 glanz_ms: 4300, glanz_anstieg_ms: 300, glanz_abkling_ms: 1300, verglimmen_ms: 1500, impuls_ms: 2200, impuls_abstand_ms: 1200, impulse_max: 2, glanz_max: 400, trabanten_impuls_reichweite: 40,
 commit_flug_ms: 1600, explosion_ms: 1900, kernwelle_ms: 1700, orbit_flare_ms: 800, trabanten_bahnen_max: 8, deko_sterne: 420,
 index_cache_ms: 30000, index_cache_schnell_ms: 10000, index_billig_ms: 100,
};

const { Pool } = requireCore('pg');
const admin = new Pool({ connectionString: db.href });
const schema = 'p22_t153_' + process.pid + '_' + randomUUID().slice(0, 8);
let C, failure;
try {
 // ---------- A Katalog ----------
 C = await load('packages/core/dist/index.js');
 const K = C.NETZWERK_EINSTELLUNGEN;
 for (const [name, std] of Object.entries(NEU)) ok(K[name] && K[name].standard === std, 'A ' + name + ' im Katalog, Standard ' + std + ' = bisheriger Code-Wert');
 ok(Object.values(K).every(d => [d.standard, d.min, d.max].every(Number.isInteger) && d.min <= d.standard && d.standard <= d.max), 'A alle Eintraege ganzzahlig, min <= Standard <= max');
 const I = await load('packages/web-ui/src/components/netzwerk/index-ebenen.ts');
 const R = await load('packages/web-ui/src/components/netzwerk/index-reaktion.ts');
 const F = await load('packages/web-ui/src/components/netzwerk/einstellungen-form.ts');
 ok(K.stern_voll_dateien.standard === I.STERN_VOLL_DATEIEN && K.stern_min_promille.standard / 1000 === I.STERN_MIN && K.dateien_je_trabant.standard === I.DATEIEN_JE_TRABANT
  && K.trabanten_einzeln.standard === I.TRABANTEN_EINZELN && K.chunks_je_nebelpunkt.standard === I.CHUNKS_JE_NEBELPUNKT && K.nebel_max.standard === I.NEBEL_MAX && K.nebel_max.max === I.NEBEL_HART,
  'A Index-Ebenen: Katalog-Standard = Web-UI-Konstanten (Rueckfall), nebel_max.max = harte Grenze');
 ok(K.glanz_ms.standard === R.GLANZ_MS && K.glanz_anstieg_ms.standard === R.GLANZ_ANSTIEG_MS && K.glanz_abkling_ms.standard === R.GLANZ_ABKLING_MS && K.verglimmen_ms.standard === R.VERGLIMMEN_MS
  && K.impuls_ms.standard === R.IMPULS_MS && K.impuls_abstand_ms.standard === R.IMPULS_ABSTAND_MS && K.impulse_max.standard === R.IMPULSE_MAX && K.glanz_max.standard === R.GLANZ_MAX,
  'A Index-Reaktion: Katalog-Standard = Web-UI-Konstanten');
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 const rueckfall = [...tsx.matchAll(/nwWert\([^,()]+, '(\w+)', (\d+)\)/g), ...tsx.matchAll(/milli\('(\w+)', (\d+)\)/g)].map(m => [m[1], Number(m[2])]);
 ok(rueckfall.length === 16 && rueckfall.every(([n, v]) => K[n]?.standard === v), 'A Rueckfallwerte in Agentennetzwerk.tsx = Katalog-Standard (' + rueckfall.length + ' Stellen)');
 ok(['trabanten_impuls_reichweite', 'commit_flug_ms', 'explosion_ms', 'kernwelle_ms', 'orbit_flare_ms', 'trabanten_bahnen_max', 'deko_sterne', 'nebel_schimmer_mrad_s'].every(n => rueckfall.some(([x]) => x === n)), 'A Agentennetzwerk.tsx liest Ablaeufe, Bahnen, Sternenstaub und Nebel aus snapshot.werte');
 ok(45 / 1000 === 0.045 && 25 / 1000 === 0.025 && 37 / 1000 === 0.037 && 20 / 1000 === 0.02 && 21 / 1000 === 0.021 && 50 / 1000 === 0.05 && 500 / 1000 === 0.5 && 800 / 1000 === 0.8 && 1 - 120 / 1000 === 0.88,
  'A Milli-Einheiten ergeben exakt die bisherigen Faktoren (0.045, 0.025, 0.037, 0.02, 0.021, 0.05, 0.5, 0.8, 0.88/0.12)');
 ok(/INDEX_CACHE_MS = 30_000, INDEX_CACHE_SCHNELL_MS = 10_000, INDEX_BILLIG_MS = 100/.test(lies('packages/rest-api/src/services/agentennetzwerk.ts')), 'A rest-api Cache-Rueckfall = Katalog-Standard 30000/10000/100');
 ok(C.netzwerkEinheit('nebel_puls_mrad_s').startsWith('mrad/s') && C.netzwerkEinheit('nebel_drehung_mrad') === 'mrad' && C.netzwerkEinheit('stern_min_promille') === 'Promille'
  && C.netzwerkEinheit('glanz_ms') === 'ms' && C.netzwerkEinheit('abgleich_sekunden') === 's' && C.netzwerkEinheit('nebel_max') === '', 'A Einheit aus dem Namen');

 // ---------- B admin / Snapshot / Cache gegen synapse_test ----------
 await admin.query('CREATE SCHEMA ' + schema);
 for (const { tablename } of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
  const q = '"' + tablename.replaceAll('"', '""') + '"';
  await admin.query('CREATE TABLE ' + schema + '.' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
 }
 db.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = db.href;
 const pool = C.getPool();
 const { AGENTENNETZWERK_SCHEMA_SQL } = await load('packages/core/dist/db/agentennetzwerk-schema.js');
 await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
 const P = 'p22-t153', user = { art: 'user' };
 const einstellen = (werte) => C.fuehreNetzwerkAdminAus({ project: P, netzwerk_modus: 'einstellen', netzwerk_werte: werte, grund: 'Test P22-T153' }, user);
 const s0 = await C.fuehreNetzwerkAdminAus({ project: P, netzwerk_modus: 'status' }, user);
 ok(s0.success && Object.keys(NEU).every(n => s0.werte[n] === NEU[n] && s0.einstellungen[n].quelle === 'standard'), 'B status: alle neuen Werte mit Quelle standard');
 ok(s0.einstellungen.nebel_treiben_x_mrad_s.einheit.startsWith('mrad/s') && s0.einstellungen.glanz_ms.einheit === 'ms' && !('einheit' in s0.einstellungen.nebel_max), 'B status nennt die Einheit');
 for (const [werte, was] of [[{ nebel_max: 20001 }, 'ueber max'], [{ glanz_ms: 499 }, 'unter min'], [{ stern_min_promille: 80.5 }, 'Kommawert'], [{ gibt_es_nicht: 1 }, 'unbekannter Name'], [{ stern_voll_dateien: 5000, nebel_max: -1 }, 'gemischt gueltig/ungueltig']]) {
  const r = await einstellen(werte);
  ok(!r.success && r.error === 'einstellung_ungueltig', 'B abgewiesen: ' + was);
 }
 ok((await C.leseNetzwerkKonfiguration(P)).werte.stern_voll_dateien === 10000, 'B abgewiesene Mischung schreibt nichts');
 const gesetzt = await einstellen({ stern_voll_dateien: 5000, nebel_treiben_x_mrad_s: 90, index_cache_schnell_ms: 2000 });
 ok(gesetzt.success && gesetzt.werte.stern_voll_dateien === 5000 && gesetzt.einstellungen.nebel_treiben_x_mrad_s.quelle === 'einstellung' && gesetzt.einstellungen.glanz_ms.quelle === 'standard', 'B gesetzt: Quelle einstellung, Rest bleibt standard');
 const A = await load('packages/rest-api/dist/services/agentennetzwerk.js');
 const snap = await A.ladeAgentennetzwerk(P);
 ok(snap.werte.stern_voll_dateien === 5000 && snap.werte.nebel_treiben_x_mrad_s === 90 && snap.werte.deko_sterne === 420 && snap.einstellungen.stern_voll_dateien.quelle === 'einstellung', 'B Snapshot traegt die Werte (ohne Deploy)');
 // Index-Cache: Dauer aus gemessener Zaehldauer und aktuellen Werten.
 const wert = { dateien: 1, chunks: 1, stand: '' };
 ok(A.indexCacheTtl({ dauer: 50, wert }) === 10000 && A.indexCacheTtl({ dauer: 150, wert }) === 30000 && A.indexCacheTtl({ dauer: 5, wert: null }) === 30000, 'B Cache ohne Werte wie P22-T152 (10 s / 30 s, Schwelle 100 ms)');
 ok(A.indexCacheTtl({ dauer: 50, wert }, { index_billig_ms: 40 }) === 30000 && A.indexCacheTtl({ dauer: 50, wert }, { index_cache_schnell_ms: 2000 }) === 2000 && A.indexCacheTtl({ dauer: 150, wert }, { index_cache_ms: 5000 }) === 5000, 'B Cache folgt index_billig_ms, index_cache_schnell_ms, index_cache_ms');
 for (let i = 0; i < 3; i++) await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) VALUES($1,$2,$3,$3,'ts')", ['t153f' + i, P, 'f' + i + '.ts']);
 A.vergissIndexGroesse(P);
 const kurz = { index_cache_ms: 1000, index_cache_schnell_ms: 1000 };
 ok((await A.ladeIndexGroesse(P, kurz)).dateien === 3, 'B Index-Groesse gezaehlt');
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) VALUES('t153f9',$1,'f9.ts','f9.ts','ts')", [P]);
 ok((await A.ladeIndexGroesse(P)).dateien === 3 && A.indexCacheDauer(P, { index_cache_schnell_ms: 1000, index_cache_ms: 1000 }) === 1000, 'B Standard haelt den Cache, Dauer mit Werten 1 s');
 await new Promise(r => setTimeout(r, 1100));
 ok((await A.ladeIndexGroesse(P, kurz)).dateien === 4, 'B geaenderte Cache-Dauer wirkt sofort beim naechsten Lesen (kein Neustart)');

 // ---------- C Web-UI-Logik ----------
 const index = { dateien: 5000, chunks: 22300, stand: '' };
 const basis = I.indexEbenen({ werte: {}, index }), mitStd = I.indexEbenen({ werte: { ...NEU, orbit_nebel: 1 }, index });
 ok(JSON.stringify(basis) === JSON.stringify(mitStd) && basis.stern === I.STERN_MIN + (1 - I.STERN_MIN) * 0.5 && basis.trabanten === 50 && basis.nebel === 223, 'C ohne Werte = mit Standardwerten = bisherige Darstellung');
 ok(I.indexEbenen({ werte: { stern_voll_dateien: 5000 }, index }).stern === 1 && I.indexEbenen({ werte: { stern_voll_dateien: 20000 }, index }).stern < basis.stern, 'C andere Sterngrenze -> anderer Stern');
 ok(I.indexEbenen({ werte: { stern_min_promille: 200 }, index: { dateien: 0, chunks: 0, stand: '' } }).stern === 0.2, 'C stern_min_promille 200 -> Mindestgroesse 0,2');
 const tr = I.indexEbenen({ werte: { dateien_je_trabant: 50, trabanten_einzeln: 60 }, index });
 ok(tr.trabanten === 100 && tr.einzeln === 60 && tr.dichte > 0 && tr.je_trabant === 50 && tr.einzeln_max === 60, 'C dateien_je_trabant 50 -> 100 Trabanten, einzeln 60, darueber dichter');
 ok(I.indexEbenen({ werte: { chunks_je_nebelpunkt: 50 }, index }).nebel === 446 && I.indexEbenen({ werte: { nebel_max: 100 }, index }).nebel === 100
  && I.indexEbenen({ werte: { nebel_max: 15000 }, index: { dateien: 1, chunks: 2e6, stand: '' } }).nebel === 15000, 'C andere Nebelzahl (je 50 Chunks, Deckel 100 bzw. 15.000)');
 ok(I.nebelPunkte(15000, 100, I.NEBEL_HART).length === 60000 && I.nebelPunkte(1e9, 100).length === I.NEBEL_MAX * 4 && I.nebelPunkte(1e9, 100, 1e9).length === I.NEBEL_HART * 4, 'C Nebelpunkte: Standard-Deckel 10.000, mit Parameter bis zur harten Grenze 20.000');
 ok(!I.indexEbenen({ werte: { orbit_nebel: 0, stern_voll_dateien: 5000 }, index }).aktiv, 'C orbit_nebel 0 bleibt Rueckfall');
 const p = R.reaktionsWerte({ glanz_ms: 1000, glanz_anstieg_ms: 100, impuls_ms: 1000, impuls_abstand_ms: 0, impulse_max: 1, glanz_max: 0 });
 ok(JSON.stringify(R.reaktionsWerte({})) === JSON.stringify(R.REAKTION_STANDARD) && JSON.stringify(R.reaktionsWerte(NEU)) === JSON.stringify(R.REAKTION_STANDARD), 'C Reaktion ohne bzw. mit Standardwerten = bisherige Konstanten');
 ok(R.glanzStaerke({ i: 0, start: 0, art: 'neu' }, 50, p) === 0.5 && R.glanzStaerke({ i: 0, start: 0, art: 'neu' }, 1000, p) === 0 && R.impulsLage(0, 500, p).u === 0.5, 'C Glanzdauer, Anstieg und Impulsdauer aus den Werten');
 let e = R.nimmAuf(R.leereEffekte(), { art: 'impuls' }, 0, p); e = R.nimmAuf(e, { art: 'impuls' }, 10, p);
 ok(e.impulse.length === 1 && e.impulse[0] === 10 && e.zaehler.gebuendelt === 0, 'C impuls_abstand_ms 0 buendelt nicht, impulse_max 1 behaelt den juengsten');
 ok(R.nimmAuf(R.leereEffekte(), { art: 'neu', von: 0, bis: 5 }, 0, p).glanz.length === 0, 'C glanz_max 0 = keine Leuchtpunkte (kein slice(-0)-Fehler)');
 ok(R.raeume(R.nimmAuf(R.leereEffekte(), { art: 'neu', von: 0, bis: 2 }, 0), 1000, p).glanz.length === 0 && R.raeume(R.nimmAuf(R.leereEffekte(), { art: 'neu', von: 0, bis: 2 }, 0), 1000).glanz.length === 2, 'C raeume folgt glanz_ms');

 // ---------- D Formular ----------
 const katalog = s0.einstellungen;
 ok(Object.keys(katalog).every(n => F.NETZWERK_LABELS[n]), 'D jeder Katalogname hat eine Beschriftung');
 const gruppen = F.gruppiereEinstellungen(katalog), namen = gruppen.flatMap(g => g.eintraege.map(([n]) => n));
 ok(namen.length === Object.keys(katalog).length && new Set(namen).size === namen.length && !gruppen.some(g => g.titel === 'Weitere'), 'D jeder Name genau einmal in einer festen Gruppe');
 ok(F.gruppiereEinstellungen({ ...katalog, neu_x: { wert: 1, quelle: 'standard', min: 0, max: 2 } }).at(-1).titel === 'Weitere', 'D unbekannter Name landet unter Weitere');
 ok(F.einstellungHilfe('nebel_treiben_x_mrad_s', {}, 45) === 'mrad/s ≈ Periode 140 s' && F.einstellungHilfe('nebel_puls_mrad_s', {}, 500).includes('12,6 s') && F.einstellungHilfe('nebel_puls_mrad_s', {}, 0).includes('steht still')
  && F.einstellungHilfe('glanz_ms', { einheit: 'ms' }, 4300) === 'ms', 'D Hilfetext: Einheit, bei mrad/s die Periode');
 // Fehlerfix: Formular wurde mit Snapshot 1 geoeffnet, admin setzt danach animation_ms; der User aendert nur abgleich_sekunden.
 const snap1 = { animation_ms: { wert: 1800 }, abgleich_sekunden: { wert: 15 }, nebel_max: { wert: 10000 } };
 const snap2 = { ...snap1, animation_ms: { wert: 2600 } };
 const eingaben = { abgleich_sekunden: 5 };
 ok(JSON.stringify(F.geaenderteNetzwerkWerte(eingaben, snap2)) === '{"abgleich_sekunden":5}', 'D nur das geaenderte Feld wird gesendet, die admin-Aenderung bleibt unberuehrt');
 ok(JSON.stringify(F.geaenderteNetzwerkWerte({ animation_ms: 2600, nebel_max: NaN, weg: 3, abgleich_sekunden: 15 }, snap2)) === '{}', 'D gleiche Werte, NaN und unbekannte Namen werden nicht gesendet');
 ok(!/if \(!vorher\) setWerte\(/.test(tsx) && tsx.includes('const diff = geaenderteNetzwerkWerte(werte, snapshot.einstellungen)') && tsx.includes('await stelleNetzwerkEin(project, diff); setWerte({});')
  && tsx.includes('value={werte[name] ?? e.wert}'), 'D Komponente: kein Vorbelegen, sendet nur diff, unberuehrte Felder zeigen den Snapshot-Wert');

 // ---------- E Kurztexte und Seed ----------
 ok(C.KURZ_BESCHREIBUNGEN.admin.p.netzwerk_modus.includes('fall-admin-agentennetzwerk') && typeof C.KURZ_BESCHREIBUNGEN.admin.p.netzwerk_werte === 'string', 'E admin: Kurztexte fuer netzwerk_modus und netzwerk_werte');
 ok(!C.NETZWERK_ADMIN_PARAMETER.netzwerk_werte.description.includes('aktivitaet_sekunden') && C.NETZWERK_ADMIN_PARAMETER.netzwerk_werte.description.length < 200, 'E Langtext ohne Namensliste, kurz');
 const { ladeSeed } = await load('scripts/skills-seed-laden.mjs');
 const seed = await ladeSeed(join(repo, 'skills', 'seed'));
 const sk = seed.skills.find(s => s.skill_name === 'fall-admin-agentennetzwerk'), fa = seed.skills.find(s => s.skill_name === 'fall-admin');
 const text = sk?.sections.map(x => x.content).join('\n') ?? '';
 ok(seed.fehler.length === 0 && sk?.weg === 'beide' && sk.sections.some(x => x.section === 'uebersicht'), 'E Seed-Skill fall-admin-agentennetzwerk gueltig (weg beide, uebersicht)');
 ok(Object.keys(K).every(n => new RegExp('\\b' + n + '\\b').test(text)), 'E Seed-Skill nennt jeden Katalognamen');
 ok(fa.sections.find(x => x.section === 'faelle').content.split('\n').filter(z => z.includes('fall-admin-agentennetzwerk')).length === 1, 'E genau eine Verweiszeile in fall-admin');
 console.log('PASS P22-T153: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await C?.closePool?.().catch(() => {});
 await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await admin.end();
}
process.exit(failure ? 1 : 0);
