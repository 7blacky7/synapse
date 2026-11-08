/**
 * P22-T312 (User 08.11.2026, memory persona-vorlage-user-generator-agent-hub): Persona-Generator nach der agent-hub-Vorlage.
 * Prueft packages/core/src/services/persona-generator.ts (ohne Netz: der Anbieterweg ist eine Attrappe ueber registrierePersonaGenerator):
 *   A Schema der Vorlage (lesePersonaJson/istPersonaDaten), Praxis-Skill-Name, System-Prompt mit Synapse-Kommunikation statt agent-hub
 *   B Schalter persona AUS -> funktion_aus, kein Generatoraufruf
 *   C User ohne Kostentraeger -> generator_identitaet_fehlt; mit ziel_identity_id: Generator bekommt PERSONA_GENERATOR_PROMPT,
 *     Standardmodell api-haiku; Vorschau speichert nichts; Speichern = neue Vorlage (Bibliothek, versioniert); zuweisen
 *   D ungueltiges Generator-JSON -> persona_json_ungueltig, nichts gespeichert
 *   E Startkontext personaStartTeil: Schalter EIN + Zuweisung -> System-Prompt; Schalter AUS -> null
 *   F Rechte: Koordinator ohne User-Auftrag abgelehnt (vor dem kostenpflichtigen Aufruf)
 * Aufruf (Repo-Root, nach Build von core):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/persona-generator-p22-t312.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P22-T312');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P22-T312: nur gegen synapse_test');
const schema = 'p22t312_' + randomUUID().replaceAll('-', '');
const P = 'p22-t312-' + randomUUID().slice(0, 6);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
Object.assign(process.env, {DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus', SYNAPSE_W1B_GATE_TTL_MS: '0',
  SYNAPSE_SKIP_EMBEDDINGS: '1', QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9'});
let pass = 0;
const ok = (cond, label, detail) => {
  if (!cond) console.error('DEBUG ' + label + ' | tatsaechlich: ' + JSON.stringify(detail ?? null).slice(0, 1500));
  assert.ok(cond, label);
  pass++; console.log('PASS ' + label);
};
const fehlerCode = async (fn) => { try { await fn(); return null; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
const PERSONA = {name: 'Mara', age: 41, gender: 'weiblich', mbti: 'ISTJ', profession: 'Bauleiterin', expertise: ['Statik', 'Terminplanung', 'Vergaberecht'],
  interests: ['Brueckenbau', 'Segeln'], communication_style: 'Knapp und direkt. Fragt nach Zahlen, bevor sie urteilt.',
  personality_traits: ['gruendlich', 'ungeduldig', 'loyal'], quirks: ['zaehlt Nieten', 'trinkt nur kalten Kaffee'],
  backstory: 'Sie hat auf drei Kontinenten gebaut. Ein eingestuerztes Geruest hat sie vorsichtig gemacht. Seitdem prueft sie alles doppelt.'};

let pool;
try {
  pool = (await load('packages/core/dist/db/client.js')).getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"');
  for (const {tablename} of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const q = '"' + tablename.replaceAll('"', '""') + '"';
    await pool.query('CREATE TABLE "' + schema + '".' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
  }
  const G = await load('packages/core/dist/services/persona-generator.js');
  const S = await load('packages/core/dist/services/agent-profil-schalter.js');
  const USER = {art: 'user'};

  // A Schema, Praxis-Skill, System-Prompt
  ok(G.istPersonaDaten(PERSONA) && !G.istPersonaDaten({...PERSONA, expertise: 'Statik'}), 'P22-T312 A Schema der Vorlage (Listen/Typen)');
  ok(JSON.stringify(G.lesePersonaJson('Hier: ' + JSON.stringify(PERSONA) + ' Ende')) === JSON.stringify(PERSONA), 'P22-T312 A JSON aus der Antwort wie in der Vorlage');
  ok(await fehlerCode(() => G.lesePersonaJson('kein json')) === 'persona_json_fehlt', 'P22-T312 A ohne JSON: persona_json_fehlt');
  ok(G.praxisSkillName('Luna Stern/1') === 'agent-luna-stern-1-praxis', 'P22-T312 A Praxis-Skill-Name wie Vorlage, Zeichen begrenzt');
  const sp = G.bauePersonaSystemPrompt(PERSONA, 'Pruefe Bauplaene', {agent_id: 'mara-1', project: P});
  ok(sp.startsWith('Du bist Mara, 41 Jahre alt, weiblich.') && sp.includes('## Aufgabe\nPruefe Bauplaene') && sp.includes('chat(action:"anmelden", agent_kennung)')
    && sp.includes('channel(action:"feed"') && sp.includes('skill_name:"agent-mara-1-praxis"') && sp.includes('[PRAXIS-FEEDBACK]')
    && !sp.includes('agent-hub') && sp.includes('Du bist NICHT Claude oder eine generische KI. Du bist Mara.'), 'P22-T312 A System-Prompt wie buildSystemPrompt mit Synapse-Kommunikation', sp.slice(0, 400));

  // Attrappe des Anbieterwegs
  const aufrufe = [];
  let antwortText = JSON.stringify(PERSONA);
  G.registrierePersonaGenerator(async (a) => { aufrufe.push(a); return {text: antwortText, kosten_usd: 0.0012}; });
  const ID = randomUUID();
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'mara-1','mara-1','subagent','test')", [ID, P]);
  const gen = (e, akteur = USER, auftrag = 'User 08.11.: Persona fuer Mara erzeugen') => G.generierePersona({project: P, beschreibung: 'Erfahrene Bauleiterin fuer Statikpruefung', ...e}, akteur, auftrag);

  // B Schalter AUS
  ok(await fehlerCode(() => gen({ziel_identity_id: ID})) === 'funktion_aus' && aufrufe.length === 0, 'P22-T312 B Schalter persona AUS: funktion_aus, kein Aufruf');
  await S.setzeProfilProduktSchalter({ebene: 'projekt', project: P, funktion: 'persona', aktiv: true, grund: 'P22-T312 Testlauf'}, {system: 'user'});

  // C Generator
  ok(await fehlerCode(() => gen({})) === 'generator_identitaet_fehlt' && aufrufe.length === 0, 'P22-T312 C User ohne Kostentraeger abgelehnt, kein Aufruf');
  const vor = await gen({ziel_identity_id: ID, vorschau: true});
  ok(aufrufe.length === 1 && aufrufe[0].system === G.PERSONA_GENERATOR_PROMPT && aufrufe[0].modell === 'api-haiku' && aufrufe[0].kontext.identity_id === ID
    && aufrufe[0].nachricht.includes('Erfahrene Bauleiterin'), 'P22-T312 C Generator: Vorlage-Prompt, Standardmodell api-haiku, Kostentraeger', aufrufe[0] && {...aufrufe[0], system: '…'});
  ok(vor.persona.name === 'Mara' && !vor.version && vor.system_prompt_vorschau.includes('agent-mara-1-praxis') && vor.generator.quelle.modell === 'standard',
    'P22-T312 C Vorschau: Persona + System-Prompt, nichts gespeichert', {version: vor.version, gen: vor.generator});
  ok((await pool.query('SELECT count(*)::int AS n FROM agent_persona_vorlagen')).rows[0].n === 0, 'P22-T312 C Vorschau legt keine Vorlage an');
  const gesp = await gen({ziel_identity_id: ID, zuweisen: true, aufgabe: 'Statik pruefen'});
  const v = (await pool.query('SELECT v.name, x.inhalt FROM agent_persona_vorlagen v JOIN agent_persona_versionen x ON x.vorlage_id=v.id')).rows;
  ok(gesp.version?.version === 1 && v.length === 1 && v[0].name === 'Mara (Bauleiterin)' && v[0].inhalt.aufgabe === 'Statik pruefen' && v[0].inhalt.mbti === 'ISTJ',
    'P22-T312 C gespeichert als Vorlage in der Bibliothek (Version 1, Schema + Aufgabe)', v);
  ok(gesp.zuweisung?.identity_id === ID && gesp.zuweisung.version === 1, 'P22-T312 C optional gleich zugewiesen', gesp.zuweisung);

  // D ungueltiges JSON
  antwortText = '{"name":"x"}';
  ok(await fehlerCode(() => gen({ziel_identity_id: ID, name: 'kaputt'})) === 'persona_json_ungueltig', 'P22-T312 D ungueltiges Generator-JSON abgelehnt');
  ok((await pool.query("SELECT count(*)::int AS n FROM agent_persona_vorlagen WHERE name='kaputt'")).rows[0].n === 0, 'P22-T312 D nichts gespeichert');

  // E Startkontext
  const st = await G.personaStartTeil(ID, 'mara-1', P);
  ok(st?.schema === 'vorlage' && st.name === 'Mara' && st.system_prompt.includes('## Aufgabe\nStatik pruefen') && st.praxis_skill === 'agent-mara-1-praxis',
    'P22-T312 E Startkontext: zugewiesene Persona als System-Prompt', st && {...st, system_prompt: st.system_prompt.slice(0, 120)});
  await S.setzeProfilProduktSchalter({ebene: 'projekt', project: P, funktion: 'persona', aktiv: false, grund: 'P22-T312 Testlauf'}, {system: 'user'});
  ok(await G.personaStartTeil(ID, 'mara-1', P) === null, 'P22-T312 E Schalter AUS: kein Persona-Teil');
  await S.setzeProfilProduktSchalter({ebene: 'projekt', project: P, funktion: 'persona', aktiv: true, grund: 'P22-T312 Testlauf'}, {system: 'user'});

  // F Rechte: Koordinator ohne User-Auftrag
  const KID = randomUUID();
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'t312-koord','t312-koord','koordinator','test')", [KID, P]);
  const koord = {art: 'identitaet', principal: {art: 'identity', project: P, agent_id: 't312-koord', identity_id: KID, rolle: 'koordinator', modell: null, context_epoch: 0, lauf_id: null}};
  antwortText = JSON.stringify(PERSONA);
  const vorher = aufrufe.length;
  const code = await fehlerCode(() => gen({vorschau: true}, koord, ''));
  ok(code !== null && aufrufe.length === vorher, 'P22-T312 F Koordinator ohne User-Auftrag abgelehnt, kein kostenpflichtiger Aufruf', code);

  // ---------------- G-J Gegenpruefung/Fortsetzung claude-eiche ----------------
  const ident = async (name) => { const id = randomUUID(); await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,$3,$3,'subagent','test')", [id, P, name]); return id; };
  // G Kostentraeger getrennt vom Ziel (User beim Erstellen: die neue Identitaet hat meist keine API-Freigabe)
  const TRAEGER = await ident('t312-traeger');
  let vorG = aufrufe.length;
  const g1 = await gen({ziel_identity_id: ID, kostentraeger_identity_id: TRAEGER, vorschau: true});
  ok(aufrufe.length === vorG + 1 && aufrufe.at(-1).kontext.identity_id === TRAEGER && g1.system_prompt_vorschau.includes('"mara-1"'),
    'P22-T312 G Kostentraeger getrennt vom Ziel (persona-generator.ts kostentraeger_identity_id)', aufrufe.at(-1)?.kontext);
  ok(aufrufe.at(-1).schalter_project === P, 'P22-T312 G Auftrag nennt das Schalter-Projekt (Anbieterweg prueft persona erneut, api-agent-transport.ts)', aufrufe.at(-1)?.schalter_project);
  // G Namensgleichheit: zweite Generierung derselben Persona ohne Namen -> Zaehler statt vorlage_name_belegt
  const g2 = await gen({ziel_identity_id: ID, kostentraeger_identity_id: TRAEGER});
  const name2 = (await pool.query('SELECT name FROM agent_persona_vorlagen WHERE id=$1', [g2.version?.vorlage_id])).rows[0]?.name;
  ok(name2 === 'Mara (Bauleiterin) 2', 'P22-T312 G gleicher Name in der Bibliothek: Zaehler angehaengt, bezahlte Generierung nicht verworfen', name2);
  ok(await fehlerCode(() => gen({ziel_identity_id: ID, kostentraeger_identity_id: TRAEGER, name: 'Mara (Bauleiterin)'})) === 'vorlage_name_belegt', 'P22-T312 G ausdruecklicher Name bleibt eindeutig Pflicht');

  // H SOLL 4: Persona an/aus beim Erstellen eines Agenten (pruefePersonaOption vorher, personaBeimErstellen danach)
  ok(await fehlerCode(() => G.pruefePersonaOption({}, P, USER, null)) === 'persona_option_ungueltig', 'P22-T312 H weder Beschreibung noch Vorlage: abgelehnt vor dem Anlegen');
  ok(await fehlerCode(() => G.pruefePersonaOption({beschreibung: 'Gruendliche Testerin', vorlage_id: 'x'}, P, USER, null)) === 'persona_option_ungueltig', 'P22-T312 H beides zugleich: abgelehnt');
  ok(await fehlerCode(() => G.pruefePersonaOption({beschreibung: 'Gruendliche Testerin'}, P, koord, '')) === 'user_auftrag_fehlt', 'P22-T312 H Koordinator ohne User-Auftrag: abgelehnt vor dem Anlegen (15b01fa5)');
  ok(await fehlerCode(() => G.pruefePersonaOption({beschreibung: 'Gruendliche Testerin'}, P, USER, null)) === null, 'P22-T312 H User mit Beschreibung: Option gueltig');
  const NEU1 = await ident('t312-neu1'), NEU2 = await ident('t312-neu2'), NEU3 = await ident('t312-neu3');
  vorG = aufrufe.length;
  const hv = await G.personaBeimErstellen({project: P, identity_id: NEU1, vorlage_id: gesp.version.vorlage_id}, USER, null);
  ok(hv.an === true && hv.quelle === 'vorlage' && hv.zuweisung?.version === 1 && hv.zuweisung.identity_id === NEU1 && aufrufe.length === vorG,
    'P22-T312 H Vorlage aus der Bibliothek: zugewiesen (aktuelle Version), kein Generatoraufruf', hv);
  const hg = await G.personaBeimErstellen({project: P, identity_id: NEU2, beschreibung: 'Gruendliche Testerin', kostentraeger_identity_id: TRAEGER}, USER, null);
  ok(hg.an === true && hg.quelle === 'generator' && hg.zuweisung?.identity_id === NEU2 && aufrufe.at(-1).kontext.identity_id === TRAEGER && hg.version?.version === 1,
    'P22-T312 H Beschreibung: Generator -> Bibliothek -> zugewiesen, Kostentraeger getrennt', {an: hg.an, quelle: hg.quelle, fehler: hg.fehler});
  antwortText = 'kaputt';
  const hf = await G.personaBeimErstellen({project: P, identity_id: NEU3, beschreibung: 'Gruendliche Testerin', kostentraeger_identity_id: TRAEGER}, USER, null);
  const zNeu3 = (await pool.query('SELECT 1 FROM agent_persona_zuweisungen WHERE identity_id=$1', [NEU3])).rows.length;
  ok(hf.an === false && hf.fehler === 'persona_json_fehlt' && zNeu3 === 0 && /Nachholen/.test(hf.hinweis), 'P22-T312 H Persona-Fehler wirft nicht (Agent bleibt, ohne Persona, nachholbar)', hf);
  antwortText = JSON.stringify(PERSONA);
  await S.setzeProfilProduktSchalter({ebene: 'projekt', project: P, funktion: 'persona', aktiv: false, grund: 'P22-T312 Testlauf H'}, {system: 'user'});
  ok(await fehlerCode(() => G.pruefePersonaOption({beschreibung: 'Gruendliche Testerin'}, P, USER, null)) === 'funktion_aus', 'P22-T312 H Schalter persona AUS: Option vor dem Anlegen abgelehnt');
  await S.setzeProfilProduktSchalter({ebene: 'projekt', project: P, funktion: 'persona', aktiv: true, grund: 'P22-T312 Testlauf H'}, {system: 'user'});

  // I SOLL 3: Praxis-Wissen (Synapse-Skill agent-<id>-praxis, scope agent) kommt im Startkontext mit
  await pool.query("INSERT INTO agent_identitaet_skill_sections (punkt_id, skill_name, section, content, scope, project, agent, identity_id) VALUES ($1,'agent-mara-1-praxis','korrekturen',$2,'agent',$3,'mara-1',$4)",
    [900000000 + Math.floor(Math.random() * 99999999), '- [08.11.2026] Statik: Lastannahmen immer gegen die Norm pruefen. Quelle: User', P, ID]);
  const stI = await G.personaStartTeil(ID, 'mara-1', P);
  ok(stI?.praxis_wissen?.includes('### korrekturen') && stI.praxis_wissen.includes('Lastannahmen'), 'P22-T312 I Praxis-Wissen im Startkontext (persona-generator.ts lesePraxisWissen)', stI && stI.praxis_wissen);

  // J Persona bleibt im minimalen Hinweis-Profil (hinweis-katalog.ts pflichtAnteil onboarding)
  const HK = await load('packages/core/dist/services/hinweis-katalog.js');
  const pa = HK.pflichtAnteil('onboarding', {isFirstVisit: true, project: P, rolle: 'subagent', rules: [{name: 'x', content: 'y', vollstaendig: false}], persona: stI});
  ok(pa?.persona?.name === 'Mara' && pa.nur_pflichtregeln === true, 'P22-T312 J Persona bleibt Pflichtanteil des Onboardings', pa && Object.keys(pa));
  ok(HK.pflichtAnteil('onboarding', {isFirstVisit: true, project: P, rules: []}) === undefined, 'P22-T312 J ohne Persona und Pflichtregeln weiterhin nichts');

  // K Gegenpruefung t245 (claude-birke): persona bleibt Ausnahme im Katalog - Standard aktiver Projekte schaltet sie nie ein (15b01fa5).
  const kp = S.schalterKatalogEintrag('persona');
  ok(kp.standard_aktive_projekte === false && typeof kp.ausnahme_grund === 'string' && kp.ausnahme_grund.length > 0,
    'P22-T312 K persona bleibt Ausnahme vom Standard aktiver Projekte (agent-profil-schalter.ts STANDARD_AKTIVE_PROJEKTE_AUSNAHMEN)', kp);

  console.log('TEST_GRUEN P22-T312 Persona-Generator checks=' + pass);
} finally {
  if (pool) {
    try { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); } catch (e) { console.error('DEBUG Schema-Rueckbau: ' + e.message); }
    await pool.end();
  }
}
