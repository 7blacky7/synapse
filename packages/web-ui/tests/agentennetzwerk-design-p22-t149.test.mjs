/**
 * P22-T148/T149 Design-Welle Agentennetzwerk: Logik und Canvas-Grenzen ohne Browser.
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/web-ui/tests/agentennetzwerk-design-p22-t149.test.mjs
 * A core netzwerkEreignis: inbox_send an 'user' -> art an_user, kein Empfaenger 'user'; 'system' nie Empfaenger; artefakt(zeigen) -> art artefakt;
 *   Koordinator<->Arbeitsagent unveraendert. Einstellungen orbit_nebel/an_user_animation (Standard 1, 0..1).
 * B nerven-szene: kein Knoten fuer 'user'/'system' (neues und altes Snapshot-Format), ereignisArt-Rueckfall, beendete Plaene sind keine Knoten,
 *   Projektstern linear aus den Dateien.
 * C index-ebenen: Stern 0 -> Mindestgroesse, 25.000 -> 1 (Deckel), je 100 Dateien ein Trabant (auch ueber dem Deckel), Zeichengrenze 300,
 *   Nebel je 100 Chunks mit Deckel 10.000, Nebelpunkte deterministisch und innerhalb des Radius, Rueckfall bei orbit_nebel=0.
 * D Renderer 'Tinte auf Papier': helle Farben werden dunkel, Farbton bleibt, grosse Schleier treten zurueck.
 * E Komponente (statisch): Commit-Flug ohne Abklingen-Sperre, Farbe je Art, Flug beim Erstauftritt als committed, an_user-Animation endet am
 *   Netzrand und nie am Projekt, Nebel nur als vorgezeichnete Ebene (drawImage, keine Einzelanimation), Debug-Attribute.
 * F rest-api ladeIndexGroesse gegen synapse_test (privates Schema): zaehlt nur nicht geloeschte, nicht ignorierte Dateien, Chunks aus code_chunks, Cache.
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
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
const requireCore = createRequire(join(repo, 'packages/core/package.json'));
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log('OK ' + m); };

const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.port, '5433', 'nur synapse_test');
assert.equal(db.pathname, '/synapse_test', 'nur synapse_test');
for (const k of ['SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID']) delete process.env[k];
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '0', QDRANT_URL: 'http://127.0.0.1:1', OLLAMA_URL: 'http://127.0.0.1:1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' });

const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { Pool } = requireCore('pg');
const admin = new Pool({ connectionString: db.href });
const schema = 'p22_t149_' + process.pid + '_' + randomUUID().slice(0, 8);
let C, failure;
try {
 // ---------- A core ----------
 C = await load('packages/core/dist/index.js');
 const row = (tool, action, args, extra = {}) => ({ id: String(++row.n), ts: new Date().toISOString(), project: 'p', agent_id: 'koordinator', identity_id: null, lauf_id: null, source: 'cloud', tool_name: tool, action, args_preview: JSON.stringify(args), ok: true, ...extra });
 row.n = 0;
 const anUser = C.netzwerkEreignis(row('mcp__synapse-direkt__chat', 'inbox_send', { to_agent: 'user', content: '<html>…</html>' }));
 ok(anUser.art === 'an_user' && anUser.empfaenger.length === 0 && anUser.routing === 'vorhanden', 'A inbox_send an user: art an_user, kein Empfaenger user');
 const mehr = C.netzwerkEreignis(row('chat', 'send', { recipient_id: ['User', 'agent-b', 'system'] }));
 ok(mehr.art === 'an_user' && JSON.stringify(mehr.empfaenger) === '["agent-b"]', 'A Multicast: user/system entfernt, echter Empfaenger bleibt');
 const sys = C.netzwerkEreignis(row('chat', 'inbox_send', { to_agent: 'system' }));
 ok(!sys.art && sys.empfaenger.length === 0, 'A system: kein Empfaenger, keine Animation');
 const art = C.netzwerkEreignis(row('artefakt', 'zeigen', { html: 'x' }, { agent_id: 'hauptagent' }));
 ok(art.art === 'artefakt' && art.agent === 'hauptagent', 'A artefakt(zeigen): art artefakt, Urheber bleibt');
 const dm = C.netzwerkEreignis(row('chat', 'inbox_send', { to_agent: 'agent-b' }));
 ok(!('art' in dm) && dm.empfaenger[0] === 'agent-b', 'A Koordinator -> Arbeitsagent unveraendert (kein art-Feld)');
 ok(C.NETZWERK_EINSTELLUNGEN.orbit_nebel.standard === 1 && C.NETZWERK_EINSTELLUNGEN.orbit_nebel.min === 0 && C.NETZWERK_EINSTELLUNGEN.an_user_animation.standard === 1, 'A Schalter orbit_nebel/an_user_animation Standard 1, abschaltbar');

 // ---------- B/C/D Web-UI-Logik ----------
 const S = await vite.ssrLoadModule('/src/components/netzwerk/nerven-szene.ts');
 const I = await vite.ssrLoadModule('/src/components/netzwerk/index-ebenen.ts');
 const R = await vite.ssrLoadModule('/src/components/netzwerk/nerven-renderer.ts');
 const jetzt = Date.now(), iso = (d = 0) => new Date(jetzt - d).toISOString();
 const werte = { aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8, ereignis_limit: 300, animation_limit: 80, animation_ms: 1800, plan_nachleuchten_sekunden: 3, plan_nachleuchten_auto_sekunden: 3, plan_mindestanzeige_sekunden: 3, abgleich_sekunden: 15, orbit_nebel: 1, an_user_animation: 1 };
 const ag = (id, rolle) => ({ id, agent: id, name: id, rolle, project: 'p', identity_id: id, zuletzt_aktiv: iso(1000), kanaele: [] });
 const ev = (id, agent, tool, action, empfaenger = [], extra = {}) => ({ id, zeit: iso(500), project: 'p', agent, identity_id: null, lauf_id: null, tool, action, ok: true, empfaenger, channel: null, interaktion: ['send', 'inbox_send', 'post'].includes(action) ? 'senden' : 'aufruf', quelle: 'tool_calls', routing: 'vorhanden', ...extra });
 const plan = (id, status, auto = false) => ({ id, besitzer: 'koord', besitzer_name: 'koord', status, auto_commit: auto, coedit: false, erstellt: iso(5000), committed: status === 'committed' ? iso(100) : null, ops: 1, dateien: 1, dateien_beispiele: [], beitraege: ['koord'] });
 const snap = (x = {}) => ({ version: 1, stand: iso(), project: 'p', schalter: { aktiv: true, quelle: 'test', bis: null, letzter_fehler: null }, werte, einstellungen: {}, agenten: [ag('koord', 'koordinator'), ag('arbeiter', 'arbeitsagent')], ereignisse: [], plaene: [], plaene_ende: [], channel_ereignisse: [], begrenzt: 0, letzter_fehler: null, ...x });
 const neu = snap({ ereignisse: [ev('1', 'koord', 'chat', 'inbox_send', [], { art: 'an_user' }), ev('2', 'user', 'admin', 'profil_schalter_setzen'), ev('3', 'system', 'chat', 'send', ['koord'])] });
 const alt = snap({ ereignisse: [ev('4', 'koord', 'chat', 'inbox_send', ['user']), ev('5', 'koord', 'chat', 'send', ['System'])] });
 for (const [name, s] of [['neues Format', neu], ['altes Format', alt]]) {
  const g = S.netzwerkSzene(s, jetzt), ids = g.knoten.map(k => k.id.toLowerCase());
  ok(!ids.includes('user') && !ids.includes('system') && !g.alias.has('user'), 'B ' + name + ': kein Knoten fuer user/system');
 }
 ok(S.ereignisArt(alt.ereignisse[0]) === 'an_user' && S.ereignisArt(ev('6', 'hauptagent', 'mcp__synapse__artefakt', 'zeigen')) === 'artefakt' && S.ereignisArt(ev('7', 'koord', 'chat', 'send', ['arbeiter'])) === null, 'B ereignisArt erkennt auch Snapshots ohne art-Feld');
 const gp = S.netzwerkSzene(snap({ plaene: [plan('10', 'open'), plan('11', 'committed'), plan('12', 'committed', true)] }), jetzt);
 ok(gp.alias.has('plan:10') && !gp.alias.has('plan:11') && !gp.alias.has('plan:12') && gp.plaene === 1, 'B Fehlerfix T102: nur offene Plaene sind Knoten, committete fliegen als Abgang');
 const g0 = S.netzwerkSzene(snap({ index: { dateien: 0, chunks: 0, stand: iso() } }), jetzt), g60 = S.netzwerkSzene(snap({ index: { dateien: 90000, chunks: 1, stand: iso() } }), jetzt), gr = S.netzwerkSzene(snap(), jetzt);
 ok(g0.stern === I.STERN_MIN && g60.stern === 1 && gr.stern === 1 && g0.kern.radius >= 14, 'B Projektstern: 0 Dateien Mindestgroesse (Klickflaeche >= 14), Deckel 1, ohne Index Rueckfall 1');

 ok(Math.abs(I.sternFaktor(12500) - (I.STERN_MIN + (1 - I.STERN_MIN) * 0.5)) < 1e-9 && I.sternFaktor(1500) < I.sternFaktor(3000), 'C Stern linear (12.500 = Mitte, 1.500 < 3.000)');
 ok(I.trabantenZahl(99) === 0 && I.trabantenZahl(700) === 7 && I.trabantenZahl(2000) === 20 && I.trabantenZahl(58165) === 581 && I.trabantenZahl(120000) === 1200, 'C je 100 Dateien ein Trabant, auch ueber dem Deckel (datcom 7, synapse 20, parser-testkorpus 581)');
 const gross = I.indexEbenen({ werte, index: { dateien: 58165, chunks: 451100, stand: '' } });
 ok(gross.einzeln === I.TRABANTEN_EINZELN && gross.trabanten === 581 && gross.dichte > 0 && gross.dichte < 1, 'C Zeichengrenze 300 einzeln, darueber dichter (Dichte ' + gross.dichte.toFixed(2) + ')');
 ok(I.nebelZahl(22300) === 223 && I.nebelZahl(451100) === 4511 && I.nebelZahl(5e7) === I.NEBEL_MAX, 'C Nebel je 100 Chunks, Deckel 10.000');
 const np = I.nebelPunkte(5000, 600), np2 = I.nebelPunkte(5000, 600);
 let drin = true; for (let i = 0; i < 5000; i++) if (Math.hypot(np[i * 4], np[i * 4 + 1]) > 600.001 || np[i * 4 + 2] <= 0 || np[i * 4 + 3] <= 0 || np[i * 4 + 3] > 1) drin = false;
 ok(np.length === 20000 && drin && np.every((v, i) => v === np2[i]), 'C Nebelpunkte: innerhalb des Radius, gueltige Groesse/Deckkraft, deterministisch');
 ok(I.nebelPunkte(1e9, 100).length === I.NEBEL_MAX * 4, 'C Nebelpunkte hart auf 10.000 gedeckelt');
 const aus = I.indexEbenen({ werte: { ...werte, orbit_nebel: 0 }, index: { dateien: 5000, chunks: 9000, stand: '' } });
 ok(!aus.aktiv && aus.stern === 1 && aus.einzeln === 42 && aus.nebel === 0 && !I.indexEbenen({ werte, index: null }).aktiv, 'C Rueckfall: orbit_nebel=0 bzw. ohne Index feste Darstellung (42 Teilchen, kein Nebel)');

 const hell = Array.from(R.tinte(1, 0.83, 0.63, 0.9, 20));
 ok(0.3 * hell[0] + 0.59 * hell[1] + 0.11 * hell[2] < 0.4 && hell[0] > hell[2] && hell[3] > 0.9, 'D Tinte: helles Pfirsich wird dunkel, Farbton (rot > blau) bleibt, kleiner Kopf deckender');
 ok(R.tinte(1, 1, 1, 0.5, 200)[3] < 0.2 && Math.abs(R.tinte(1, 1, 1, 0.5, 4, 0.3)[3] - 0.3) < 1e-6, 'D Tinte: grosse Schleier treten zurueck, Parallaxe-Dekor gedaempft');
 const dunkelBleibt = Array.from(R.tinte(0.2, 0.1, 0.05, 0.5, 10));
 ok(dunkelBleibt[0] <= 0.31 && dunkelBleibt[0] > dunkelBleibt[2], 'D Tinte: bereits dunkle Farbe bleibt dunkel');

 // ---------- E Komponente statisch ----------
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(!tsx.includes('l.abklingen') && tsx.includes("startAbgang(st === 'committed' ? 'commit' : 'explosion'"), 'E Commit-Flug ohne Abklingen-Sperre (P22-T104) wiederhergestellt');
 ok(tsx.includes('auto ? COMMIT_BLAU : COMMIT_GRUEN') && tsx.includes('welle(zeit, fc); orbitFlare'), 'E Farbe je Commit-Art, Projektreaktion in derselben Farbe');
 ok(/p\.status !== 'committed' \|\| geflogen\.has\(p\.id\) \|\| bekanntePlaene\.has\(p\.id\)/.test(tsx) && tsx.includes('if (!planStart) { geflogen.add(p.id); continue; }'), 'E Erstauftritt als committed fliegt ab dem Besitzer, Initialhistorie nicht');
 ok(tsx.includes("nach: 'aussen'") && tsx.includes('g.radius * 1.15') && tsx.includes('w.an_user_animation === 0'), 'E an_user/artefakt endet ausserhalb des Netzrands, nie am Projekt; Schalter wirkt');
 ok((tsx.match(/nebelPunkte\(/g) || []).length === 1 && tsx.includes('ctx.drawImage(nb.bild') && tsx.includes("schluessel = n + ':' + rr"), 'E Nebel nur als vorgezeichnete Ebene (einmal gezeichnet, als Ganzes bewegt)');
 ok(['dataset.stern', 'dataset.trabanten', 'dataset.nebelPunkte', 'dataset.anUser', 'dataset.commitFarben'].every(s => tsx.includes(s)), 'E Debug-Attribute fuer die Browserabnahme');

 // ---------- F rest-api Index-Groesse ----------
 await admin.query('CREATE SCHEMA ' + schema);
 for (const t of ['code_files', 'code_chunks']) await admin.query('CREATE TABLE ' + schema + '.' + t + ' (LIKE public.' + t + ' INCLUDING ALL)');
 const P = 'p22-t149';
 for (let i = 0; i < 5; i++) await admin.query('INSERT INTO ' + schema + ".code_files(id,project,file_path,file_name,file_type,deleted_at,ignored) VALUES($1,$2,$3,$3,'ts',$4,$5)", [P + i, P, 'f' + i + '.ts', i === 3 ? new Date() : null, i === 4]);
 for (let i = 0; i < 7; i++) await admin.query('INSERT INTO ' + schema + ".code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) VALUES($1,$2,'f0.ts',$3,'x',1,1)", [P + 'c' + i, P, i]);
 db.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = db.href;
 const A = await load('packages/rest-api/dist/services/agentennetzwerk.js');
 const ix = await A.ladeIndexGroesse(P);
 ok(ix && ix.dateien === 3 && ix.chunks === 7, 'F Index-Groesse aus PG: 3 Dateien (ohne geloeschte/ignorierte), 7 Chunks');
 await admin.query('INSERT INTO ' + schema + ".code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) VALUES('neu',$1,'f0.ts',99,'x',1,1)", [P]);
 ok((await A.ladeIndexGroesse(P)).chunks === 7, 'F Cache: zweiter Aufruf innerhalb von 30 s ohne neue Abfrage');
 console.log('PASS P22-T148/T149 Design-Welle: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await vite.close();
 await C?.closePool?.().catch(() => {});
 await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await admin.end();
}
process.exit(failure ? 1 : 0);
