/**
 * P22-T313 (Befunde Koordinator 08.11.2026).
 *   B1 core agent-onboarding.ts holeAgentOnboarding: Besucher MIT Ausweis (Principal-Projekt != Projekt) bekommt beim ersten Besuch
 *      EINE Zeile (Projekt, Koordinator, Regelnamen, Abrufzeile), nie den Regel-Volltext; beim zweiten Besuch nichts.
 *      hinweis-katalog: die Besuchszeile bleibt auch im minimalen Hinweis-Profil erhalten.
 *   B2 core verlauf-einbetten.ts leseVerlaufUmfeld: Nachlesen per verlauf_id ueber die Zifferngrenze (99 -> 100) findet die eigene
 *      Zeile (vorher ORDER BY auf id::text -> verlauf_id_unbekannt); fremde Identitaet bleibt unbekannt.
 * Aufruf (Repo-Root, nach Build von core):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/visum-verlauf-p22-t313.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P22-T313');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P22-T313: nur gegen synapse_test');
const schema = 'p22t313_' + randomUUID().replaceAll('-', '');
const HEIMAT = 'p22-t313-heimat-' + randomUUID().slice(0, 6);
const FREMD = 'p22-t313-fremd-' + randomUUID().slice(0, 6);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
Object.assign(process.env, {DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus', SYNAPSE_W1B_GATE_TTL_MS: '0',
  SYNAPSE_SKIP_EMBEDDINGS: '1', QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', EMBEDDING_BASE_URL: 'http://127.0.0.1:9'});

let pass = 0;
const ok = (cond, label, detail) => {
  if (!cond) console.error('DEBUG ' + label + ' | tatsaechlich: ' + JSON.stringify(detail ?? null).slice(0, 1500));
  assert.ok(cond, label);
  pass++; console.log('PASS ' + label);
};

let pool;
try {
  pool = (await load('packages/core/dist/db/client.js')).getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"');
  for (const {tablename} of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const q = '"' + tablename.replaceAll('"', '""') + '"';
    await pool.query('CREATE TABLE "' + schema + '".' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
  }
  const O = await load('packages/core/dist/services/agent-onboarding.js');
  const B = await load('packages/core/dist/services/agent-bezug.js');
  const S = await load('packages/core/dist/services/agent-profil-schalter.js');
  const V = await load('packages/core/dist/services/verlauf-einbetten.js');
  const H = await load('packages/core/dist/services/hinweis-katalog.js');

  // ---------------- B1 Besuch per Visum ----------------
  const ID = randomUUID();
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'t313-besuch','t313-besuch','koordinator','test')", [ID, HEIMAT]);
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'t313-koord','t313-koord','koordinator','test')", [randomUUID(), FREMD]);
  const GROSS = 'REGELTEXT-' + 'x'.repeat(50000);
  await pool.query("INSERT INTO memories (id, project, name, content, category, tags) VALUES ($1,$2,'regel-t313-gross',$3,'rules',ARRAY['pflicht'])", [randomUUID(), FREMD, GROSS]);
  const principal = {art: 'identity', project: HEIMAT, agent_id: 't313-besuch', identity_id: ID, rolle: 'koordinator', modell: null, context_epoch: 0, lauf_id: null};
  const alsBesucher = fn => B.mitAgentAufrufKontext({principal, bezug: {modus: 'beide'}}, fn);
  const erst = await alsBesucher(() => O.holeAgentOnboarding({project: FREMD, agentId: 't313-besuch', serverInstanceId: 't313'}));
  const text = JSON.stringify(erst ?? null);
  ok(erst && erst.besuch === true && erst.isFirstVisit === true && !('rules' in erst), 'P22-T313 B1 erster Besuch: Besuchszeile statt Regelblock', erst);
  ok(text.length < 3000 && !text.includes('xxxxxxxxxx'), 'P22-T313 B1 nie der Volltext (kurz, ohne Regelinhalt)', {laenge: text.length});
  ok(/t313-koord/.test(erst.message) && /regel-t313-gross/.test(erst.message) && /memory\(action:"read"/.test(erst.message) && erst.message.includes(FREMD),
    'P22-T313 B1 Zeile nennt Projekt, Koordinator, Regelnamen und Abrufzeile', erst.message);
  const zweit = await alsBesucher(() => O.holeAgentOnboarding({project: FREMD, agentId: 't313-besuch', serverInstanceId: 't313'}));
  ok(zweit === null, 'P22-T313 B1 zweiter Besuch: nichts mehr', zweit);
  const minimal = H.pflichtAnteil('onboarding', erst);
  ok(minimal?.besuch === true && minimal.message === erst.message, 'P22-T313 B1 Besuchszeile bleibt als Pflichtanteil (Hinweis-Profil aus)', minimal);
  // Gegenpruefung claude-buche (08.11.2026): im ECHTEN Visum-Weg (channel post in Projekt B mit Ausweis der Heimat A) ist der principal
  // 'legacy' im Projekt B, die Heimat steht in aufruf.fremdprojekt (P22-T44, agent-bezug.ts:32-33). Vorher kam dort das Voll-Onboarding.
  const visum = await B.mitAgentAufrufKontext({principal: {art: 'legacy', project: FREMD, agent_id: 't313-visum'}, bezug: {modus: 'beide'},
    fremdprojekt: {project: FREMD, heimat: HEIMAT, zugang: 'visum', identity_id: ID}},
    () => O.holeAgentOnboarding({project: FREMD, agentId: 't313-visum', serverInstanceId: 't313'}));
  const visumText = JSON.stringify(visum ?? null);
  ok(visum?.besuch === true && !('rules' in visum) && visumText.length < 3000 && visum.message.includes('Heimat ' + HEIMAT),
    'P22-T313 B1 echter Visum-Weg (principal legacy + fremdprojekt): Besuchszeile, kein Volltext (agent-onboarding.ts)', {laenge: visumText.length, visum});

  // ---------------- B2 Nachlesen per verlauf_id ----------------
  await S.setzeProfilProduktSchalter({ebene: 'global', funktion: 'verlauf_suche', aktiv: true, grund: 'P22-T313 Testlauf'}, {system: 'user'});
  const ANDERE = randomUUID();
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'t313-andere','t313-andere','subagent','test')", [ANDERE, HEIMAT]);
  for (let id = 95; id <= 105; id++) {
    await pool.query("INSERT INTO hauptagent_verlauf (id, identity_id, rolle, richtung, weg, text, lauf_id) VALUES ($1,$2,'user','ein','webui',$3,$4)",
      [id, ID, 'Zeile ' + id, id < 100 ? 'lauf-alt' : 'lauf-neu']);
  }
  await pool.query("INSERT INTO hauptagent_verlauf (id, identity_id, rolle, richtung, weg, text) VALUES (106,$1,'user','ein','webui','fremde Zeile')", [ANDERE]);
  const wer = {identity_id: ID, agent_id: 't313-besuch'};
  const u = await V.sucheVerlauf(wer, {verlauf_id: '100', umfeld: 2});
  ok(u.success === true && u.zeilen.map(z => z.id).join(',') === '98,99,100,101,102', 'P22-T313 B2 Umfeld ueber die Zifferngrenze numerisch (98..102)', u);
  const alt = await V.sucheVerlauf(wer, {verlauf_id: 96, umfeld: 1});
  ok(alt.success === true && alt.zeilen.some(z => z.id === '96' && z.lauf_id === 'lauf-alt'), 'P22-T313 B2 frueherer Lauf derselben Identitaet nachlesbar', alt);
  const fremd = await V.sucheVerlauf(wer, {verlauf_id: '106', umfeld: 1});
  ok(fremd.success === false && fremd.error === 'verlauf_id_unbekannt', 'P22-T313 B2 fremde Identitaet bleibt unbekannt', fremd);

  console.log('TEST_GRUEN P22-T313 checks=' + pass);
} finally {
  if (pool) {
    try { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); } catch (e) { console.error('DEBUG Schema-Rueckbau: ' + e.message); }
    await pool.end();
  }
}
