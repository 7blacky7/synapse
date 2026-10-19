/**
 * P23-T4: Skill-Sinnpruefung mit mehr Kontext fuer Jev. Eigenes Schema auf synapse_test:5433,
 * Jev per Fake-fetch (kein Netz), Vektorsuche per Fake-searchBatch.
 *   node packages/core/tests/skill-vorschlaege-sinn-p23-t4.test.mjs
 * A  Einstellwerte skill_rerank_budget_tokens (Standard 10000, 1000..60000) / skill_rerank_timeout_ms (Standard 20000)
 * B  state-Inhalt: quelle, ganzer Abschnitt + Titel, Zweck (Uebersicht), Scope, Abschnittsliste, Empfaenger nach Task gruppiert
 * C  Empfaenger mit Ausweis: Rolle/Typ aus dem Profil, gebundene Task mit Beschreibung
 * D  Budgetkuerzung: Zweck/Aufgabe nie, zuerst Abschnitt, dann Quelltext, dann Kandidaten; Ergebnis <= Budget
 * E  Timeout aus jev_optionen wirkt (1 s statt 10 s), Pruefung aus = kein Kontextladen
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 'p23_t4_' + process.pid + '_' + randomUUID().slice(0, 8);
const P = 'p23-t4-' + randomUUID().slice(0, 8);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.href;
Object.assign(process.env, {
  SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_AGENT_BEZUG_MODUS: 'alt',
  JEV_SCHALTER_CACHE_MS: '0', SYNAPSE_INTERN_CACHE_MS: '0', JEV_OPENROUTER_API_KEY: 'test-only-jev-key',
  SCORE_SCHWELLE_CHANNEL_SKILL: '0.6', SCORE_SCHWELLE_CHANNEL_SKILL_ABSTAND: '0',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
});
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.JEV_TIMEOUT_MS;

// Jev-Fake: "gut-skill" hilft (0.9), alles andere nicht (0.1). verzoegerung_ms > 0 simuliert einen langsamen Jev.
const jevAufrufe = [];
let verzoegerungMs = 0;
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  jevAufrufe.push(body);
  if (verzoegerungMs > 0) {
    await new Promise((ok, fehler) => {
      const t = setTimeout(ok, verzoegerungMs);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); fehler(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  }
  const answers = {};
  for (const [k] of Object.entries(body.questions)) {
    const i = Number(k.replace('skill_', ''));
    const s = body.state.skills.find((x) => x.i === i);
    answers[k] = { noul: s?.name === 'gut-skill' ? 0.9 : 0.1 };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 42, output_tokens: 3, cost: 0.0001 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const require = createRequire(new URL('../package.json', import.meta.url));
const { Pool } = require('pg');
await import('../dist/index.js');
const DB = await import('../dist/db/client.js');
const SH = await import('../dist/services/skill-hook.js');
const SR = await import('../dist/services/skill-rerank.js');
const JS = await import('../dist/services/jev-schalter.js');
const JO = await import('../dist/services/jev-optionen.js');

const raw = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const q = (s, v = []) => raw.query(s, v);
const pool = DB.getPool();
let checks = 0, failed = 0;
const pruefe = async (name, fn) => {
  try { await fn(); console.log('PASS ' + (++checks) + ' ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message + '\n' + String(e.stack).split('\n').slice(1, 3).join(' ')); }
};
const treffer = (name, score, section, content, scope = 'global', project = null) => ({ skill_name: name, section, score, content, tags: [], scope, project });
const fakeSuche = (hits) => async (_q, _p, agents) => agents.map((agent) => ({ agent, hits: hits.map((h) => ({ ...h })) }));
const preps = async (agent, sourceId) => (await q(
  'SELECT skill_name, score, reason FROM skill_hook_preparations WHERE agent_id=$1 AND source_id=$2 ORDER BY skill_name', [agent, sourceId])).rows;

const ZWECK = 'Flottenplanung und Kampfsimulation fuer Browser-Strategiespiele: Schiffstypen, Rapidfire, Verteidigung.';
const ABSCHNITT = ('Langer Abschnitt ueber Flottenzusammenstellung. ').repeat(30).trim(); // > 1000 Zeichen
const TASK_BESCHREIBUNG = 'Kampfsimulator bauen: Rapidfire korrekt rechnen, Verluste je Runde ausgeben, gegen Referenzwerte pruefen.';
const T1 = randomUUID(), T2 = randomUUID();
const IDENT = randomUUID(), TYP = randomUUID();

try {
  await q('CREATE SCHEMA ' + schema);
  for (const t of ['skill_names', 'skill_hook_preparations', 'skill_hook_deliveries', 'skill_hook_metrics',
    'jev_schalter', 'jev_optionen', 'jev_aufrufe', 'jev_budget_stand', 'intern_schalter',
    'skill_sections', 'agent_identitaet_skill_sections', 'plan_tasks', 'plan_task_bindungen',
    'agent_identitaeten', 'agent_typen', 'agent_typ_revisionen']) {
    await q(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
  }
  const seqs = (await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'", [schema])).rows;
  for (const [i, d] of seqs.entries()) {
    await q(`CREATE SEQUENCE ${schema}.p23_seq_${i}`);
    await q(`ALTER TABLE ${schema}.${d.table_name} ALTER COLUMN ${d.column_name} SET DEFAULT nextval('${schema}.p23_seq_${i}'::regclass)`);
  }
  await q(`INSERT INTO ${schema}.skill_names (skill_name, section_count) SELECT unnest($1::text[]), 2`, [['gut-skill', 'schlecht-skill', 'ogame-strategie']]);
  await q(`INSERT INTO ${schema}.skill_sections (punkt_id, skill_name, section, content, scope) VALUES
    (1, 'gut-skill', 'uebersicht', $1, 'global'), (2, 'gut-skill', 'flotte', $2, 'global'),
    (3, 'schlecht-skill', 'rezepte', 'Kochrezepte', 'global'),
    (4, 'fremd-skill', 'uebersicht', 'gehoert einem anderen Projekt', 'project')`, [ZWECK, ABSCHNITT]);
  await q(`UPDATE ${schema}.skill_sections SET project='anderes-projekt' WHERE punkt_id=4`);
  await q(`INSERT INTO ${schema}.plan_tasks (id, project, plan_id, task, updated_at) VALUES
    ($1, $3, 'plan-x', $4::jsonb, NOW()), ($2, $3, 'plan-x', $5::jsonb, NOW())`, [T1, T2, P,
    JSON.stringify({ id: T1, kurz_id: 'P99-T1', title: 'Kampfsimulator', description: TASK_BESCHREIBUNG, status: 'in_progress',
      beteiligte: [{ agent_id: 'agent-a' }, { agent_id: 'agent-b' }] }),
    JSON.stringify({ id: T2, kurz_id: 'P99-T2', title: 'Deploy vorbereiten', description: 'Container bauen und auf den Server bringen.', status: 'todo' })]);
  await q(`INSERT INTO ${schema}.agent_typen (id, scope, schluessel, erstellt_von) VALUES ($1, 'global', 'claude-subagent', 'test')`, [TYP]);
  await q(`UPDATE ${schema}.agent_typen SET aktuelle_revision=1 WHERE id=$1`, [TYP]);
  await q(`INSERT INTO ${schema}.agent_typ_revisionen (typ_id, revision, inhalt, wer) VALUES ($1, 1, '{}'::jsonb, 'test')`, [TYP]);
  await q(`INSERT INTO ${schema}.agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von, typ_id) VALUES ($1, $2, 'ident-x', 'ident-x', 'subagent', 'test', $3)`, [IDENT, P, TYP]);
  await q(`INSERT INTO ${schema}.plan_task_bindungen (project, task_id, art, identity_ids, gesetzt_von) VALUES ($1, 'P99-T2', 'identitaet', ARRAY[$2]::text[], 'test')`, [P, IDENT]);
  await pool.query('SELECT 1');
  console.log('PASS Schema ' + schema);

  // ---------------------------------------------------------------- A
  await pruefe('A Einstellwerte: Standard 10000/20000, setzbar, Grenzen (Budget <= 60000 < 64k)', async () => {
    const o = await JO.leseJevOptionen();
    assert.equal(o.skill_rerank_budget_tokens, 10000); assert.equal(o.skill_rerank_timeout_ms, 20000);
    assert.equal(JO.SKILL_RERANK_BUDGET_GRENZE, 60000);
    const n = await JO.setzeJevOptionen({ skill_rerank_budget_tokens: 5000, skill_rerank_timeout_ms: 30000, agent: 'koordinator' });
    assert.equal(n.skill_rerank_budget_tokens, 5000); assert.equal(n.skill_rerank_timeout_ms, 30000);
    await assert.rejects(JO.setzeJevOptionen({ skill_rerank_budget_tokens: 64000 }), (e) => e.code === 'skill_rerank_budget_tokens_ungueltig');
    await assert.rejects(JO.setzeJevOptionen({ skill_rerank_budget_tokens: 999 }), (e) => e.code === 'skill_rerank_budget_tokens_ungueltig');
    await assert.rejects(JO.setzeJevOptionen({ skill_rerank_timeout_ms: 500 }), (e) => e.code === 'skill_rerank_timeout_ms_ungueltig');
    await JO.setzeJevOptionen({ skill_rerank_budget_tokens: 10000, skill_rerank_timeout_ms: 20000, agent: 'koordinator' });
  });

  // ---------------------------------------------------------------- E (aus)
  const hits = [treffer('gut-skill', 0.8, 'flotte', ABSCHNITT), treffer('schlecht-skill', 0.7, 'rezepte', 'Kochrezepte')];
  await pruefe('E Pruefung aus (Standard): kein Jev, kein Kontextladen noetig, Treffer wie bisher', async () => {
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-aus', 'Rapidfire im Kampfsimulator laut ogame-strategie', ['agent-a'], pool, fakeSuche(hits));
    assert.equal(jevAufrufe.length, 0);
    assert.deepEqual((await preps('agent-a', 'T-aus')).map((x) => x.skill_name), ['gut-skill', 'ogame-strategie', 'schlecht-skill']);
  });

  // ---------------------------------------------------------------- B
  await JS.setzeJevSchalter({ ebene: 'projekt', project: P, funktion: 'skill_rerank', aktiv: true, grund: 'test', agent: 'koordinator' });
  await pruefe('B state: quelle, ganzer Abschnitt + Titel, Zweck, Scope, Abschnittsliste, Empfaenger nach Task gruppiert', async () => {
    const vorher = jevAufrufe.length;
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-b', 'Rapidfire im Kampfsimulator stimmt nicht, siehe ogame-strategie', ['agent-a', 'agent-b', 'agent-c'], pool, fakeSuche(hits));
    assert.equal(jevAufrufe.length, vorher + 1, 'EIN Jev-Aufruf fuer alle Empfaenger');
    const s = jevAufrufe.at(-1).state;
    assert.deepEqual(s.quelle, { art: 'task', klartext: 'Task', id: 'T-b' });
    assert.equal(s.text, 'Rapidfire im Kampfsimulator stimmt nicht, siehe ogame-strategie');
    assert.deepEqual(s.skills.map((x) => x.name).sort(), ['gut-skill', 'schlecht-skill'], 'genannte Skills gehen nicht an Jev');
    const gut = s.skills.find((x) => x.name === 'gut-skill');
    assert.equal(gut.zweck, ZWECK, 'Zweck aus dem Uebersichts-Abschnitt');
    assert.equal(gut.abschnitt, ABSCHNITT, 'GANZER Abschnitt (vorher 300 Zeichen)');
    assert(gut.abschnitt.length > 1000);
    assert.equal(gut.abschnitt_titel, 'flotte'); assert.equal(gut.scope, 'global');
    assert.deepEqual(gut.abschnitte, ['flotte', 'uebersicht']);
    assert.equal(s.skills.find((x) => x.name === 'schlecht-skill').zweck, null, 'kein Uebersichts-Abschnitt -> kein Zweck');
    // Gruppen: agent-a + agent-b an P99-T1 (eine Gruppe, anzahl 2), agent-c ohne Task
    const mitTask = s.empfaenger.find((g) => g.aufgaben.length === 1);
    assert.deepEqual(mitTask.aufgaben, ['P99-T1']); assert.equal(mitTask.anzahl, 2);
    assert.equal(s.empfaenger.find((g) => g.aufgaben.length === 0).anzahl, 1);
    assert.equal(s.empfaenger.length, 2, 'nach Task gruppiert, nicht je Empfaenger');
    assert.deepEqual(s.aufgaben, [{ id: 'P99-T1', titel: 'Kampfsimulator', beschreibung: TASK_BESCHREIBUNG, status: 'in_progress' }]);
    assert.deepEqual((await preps('agent-a', 'T-b')).map((x) => x.skill_name), ['gut-skill', 'ogame-strategie'], 'Tor filtert weiter');
    assert.match(jevAufrufe.at(-1).questions.skill_0.instructions, /state\.aufgaben/);
  });

  // ---------------------------------------------------------------- C
  await pruefe('C Empfaenger mit Ausweis: Rolle/Typ aus dem Profil, gebundene Task mit Beschreibung', async () => {
    const k = await SR.ladeEmpfaengerKontext(P, [{ identity_id: IDENT, agent_id: 'ident-x' }, { agent_id: 'agent-a' }]);
    const g = k.gruppen.find((x) => x.aufgaben.includes('P99-T2'));
    assert(g, 'gebundene Task P99-T2 erwartet: ' + JSON.stringify(k));
    assert.deepEqual(g.rollen, ['subagent']); assert.deepEqual(g.typen, ['claude-subagent']);
    assert.equal(k.aufgaben.find((a) => a.id === 'P99-T2').beschreibung, 'Container bauen und auf den Server bringen.');
    assert.equal(k.gruppen.length, 2);
  });

  // ---------------------------------------------------------------- D
  await pruefe('D Budgetkuerzung: Abschnitt zuerst, Zweck/Aufgabe/Quelltext unberuehrt, Ergebnis <= Budget', async () => {
    const st = {
      text: 'Q'.repeat(3000),
      aufgaben: [{ id: 'P1', beschreibung: 'A'.repeat(3000) }],
      skills: [0, 1, 2].map((i) => ({ i, name: 's' + i, zweck: 'Z'.repeat(1500), abschnitt: 'X'.repeat(8000), abschnitte: [] })),
    };
    const b = SR.kuerzeAufBudget(st, () => ({}), 6000);
    assert(b.tokens_geschaetzt <= 6000, JSON.stringify(b));
    assert(b.abschnitte_gedeckelt_auf > 0 && b.abschnitte_gedeckelt_auf < 8000);
    assert.equal(b.quelltext_gekuerzt_auf, undefined, 'Quelltext erst nach dem Abschnitt');
    assert.equal(st.text.length, 3000);
    assert(st.skills.every((s) => s.zweck.length === 1500)); assert.equal(st.aufgaben[0].beschreibung.length, 3000);
  });

  await pruefe('D Budgetkuerzung: Abschnitt 0 reicht nicht -> Quelltext (>= 300), dann Kandidaten vom Ende', async () => {
    const st = {
      text: 'Q'.repeat(6000),
      aufgaben: [{ id: 'P1', beschreibung: 'A'.repeat(1500) }],
      skills: [0, 1, 2].map((i) => ({ i, name: 's' + i, zweck: 'Z'.repeat(1500), abschnitt: 'X'.repeat(2000), abschnitte: [] })),
    };
    const b = SR.kuerzeAufBudget(st, () => ({}), 3000);
    assert.equal(b.abschnitte_gedeckelt_auf, 0);
    assert(b.quelltext_gekuerzt_auf >= 300 && b.quelltext_gekuerzt_auf < 6000, JSON.stringify(b));
    assert(b.tokens_geschaetzt <= 3000);
    assert.equal(b.kandidaten_entfallen, undefined);
    const st2 = {
      text: 'Q'.repeat(2000), aufgaben: [{ id: 'P1', beschreibung: 'A'.repeat(3000) }],
      skills: [0, 1, 2].map((i) => ({ i, name: 's' + i, zweck: 'Z'.repeat(1500), abschnitt: 'X'.repeat(500), abschnitte: [] })),
    };
    const b2 = SR.kuerzeAufBudget(st2, () => ({}), 2000);
    assert.deepEqual(b2.kandidaten_entfallen, ['s1', 's2'], 'niedrigster Score (Ende) zuerst');
    assert.equal(st2.text.length, 300); assert.equal(st2.skills[0].zweck.length, 1500, 'Zweck nie gekuerzt');
    assert.equal(st2.aufgaben[0].beschreibung.length, 3000, 'Aufgabe nie gekuerzt');
  });

  await pruefe('D Budget im Hook: skill_rerank_budget_tokens 1000 -> state an Jev <= Budget, Debug-Bericht', async () => {
    await JO.setzeJevOptionen({ skill_rerank_budget_tokens: 1000, agent: 'koordinator' });
    const sinn = await SR.pruefeSkillTrefferSinn({
      project: P, text: 'Rapidfire '.repeat(300),
      kandidaten: [{ skill_name: 'gut-skill', inhalt: ABSCHNITT, abschnitt: 'flotte', scope: 'global' }],
      quelle: { art: 'thought', klartext: 'Gedanke', id: 'th-1' }, empfaenger: [{ agent_id: 'agent-a' }],
    });
    assert.equal(sinn.gelaufen, true);
    const gesendet = jevAufrufe.at(-1);
    const geschaetzt = SR.schaetzeTokens(gesendet.state) + SR.schaetzeTokens(gesendet.questions);
    assert(geschaetzt <= 1000, 'gesendet ' + geschaetzt);
    assert.equal(gesendet.state.skills[0].zweck, ZWECK, 'Zweck vollstaendig');
    assert.equal(gesendet.state.aufgaben[0].beschreibung, TASK_BESCHREIBUNG, 'Aufgabe vollstaendig');
    assert(gesendet.state.skills[0].abschnitt.length < ABSCHNITT.length, 'Abschnitt gekuerzt');
    assert.equal(sinn.budget.budget_tokens, 1000); assert(sinn.budget.abschnitte_gedeckelt_auf !== undefined);
    await JO.setzeJevOptionen({ skill_rerank_budget_tokens: 10000, agent: 'koordinator' });
  });

  // ---------------------------------------------------------------- E (Timeout)
  await pruefe('E Timeout aus jev_optionen: 1000 ms bei langsamem Jev -> ausgefallen (timeout), Treffer ungeprueft', async () => {
    await JO.setzeJevOptionen({ skill_rerank_timeout_ms: 1000, agent: 'koordinator' });
    verzoegerungMs = 3000;
    const start = Date.now();
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-e', 'Rapidfire im Kampfsimulator laut ogame-strategie', ['agent-a'], pool, fakeSuche(hits));
    const dauer = Date.now() - start;
    verzoegerungMs = 0;
    assert(dauer < 2900, 'Timeout 1 s griff nicht (' + dauer + ' ms)');
    const r = await preps('agent-a', 'T-e');
    assert.deepEqual(r.map((x) => x.skill_name), ['gut-skill', 'ogame-strategie', 'schlecht-skill']);
    assert.match(r[0].reason, /Jev-Sinnpruefung ausgefallen \(timeout\)/);
    const z = (await q("SELECT ok, fehler FROM jev_aufrufe WHERE project=$1 ORDER BY id DESC LIMIT 1", [P])).rows[0];
    assert.equal(z.ok, false); assert.equal(z.fehler, 'timeout');
    await JO.setzeJevOptionen({ skill_rerank_timeout_ms: 20000, agent: 'koordinator' });
  });
} finally {
  await q('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch((e) => console.error('Aufraeumen: ' + e.message));
  await raw.end();
  await DB.closePool?.().catch?.(() => undefined);
}
console.log(`ERGEBNIS ${checks} PASS, ${failed} FAIL, Jev-Fake-Aufrufe ${jevAufrufe.length}`);
process.exit(failed ? 1 : 0);
