/**
 * P23-T6: Diagnose intern skill_probe. Eigenes Schema auf synapse_test:5433, Jev per Fake-fetch (kein Netz),
 * Vektorsuche per Fake-searchBatch.
 *   node packages/core/tests/skill-probe-p23-t6.test.mjs
 * A  Rechte: Subagent -> recht_fehlt (ueber den intern-Dispatcher), Koordinator/Legacy-Koordinator darf; Action gelistet
 * B  Probe ohne Jev: Kandidaten mit Score + Ergebnis, Schwellen mit Quelle, Jev-state (Tokens + Auszug je Teil),
 *    skill_rerank AUS sichtbar, KEIN Jev-Aufruf, NICHTS in Vorrat/Zustellungen geschrieben
 * C  Testwerte schwelle/abstand nur fuer die Probe (unter_schwelle, mehrdeutig), danach wieder Env-Werte
 * D  mit_jev:true bei skill_rerank AUS: echter (Fake-)Aufruf als skill_rerank_probe, Wert/Tor/Ergebnis je Kandidat,
 *    Kosten in jev_aufrufe, weiterhin nichts im Vorrat
 * E  Jev-Funktion skill_rerank_probe fuer das Projekt aus -> ergebnis grund aus, kein Aufruf
 * F  Hook unveraendert: bereiteSkillVorschlaegeVor legt wie bisher ab (Refactor ermittleSkillKandidaten)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 'p23_t6_' + process.pid + '_' + randomUUID().slice(0, 8);
const P = 'p23-t6-' + randomUUID().slice(0, 8);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.href;
Object.assign(process.env, {
  SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_AGENT_BEZUG_MODUS: 'alt',
  SYNAPSE_INTERN_TOOL: '1',
  JEV_SCHALTER_CACHE_MS: '0', SYNAPSE_INTERN_CACHE_MS: '0', JEV_OPENROUTER_API_KEY: 'test-only-jev-key',
  SCORE_SCHWELLE_CHANNEL_SKILL: '0.6', SCORE_SCHWELLE_CHANNEL_SKILL_ABSTAND: '0',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
});
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.JEV_TIMEOUT_MS;
delete process.env.CHANNEL_SKILL_MIN_SCORE;

// Jev-Fake: "gut-skill" hilft (0.9), alles andere nicht (0.1). Jeder Aufruf wird mitgeschrieben.
const jevAufrufe = [];
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  jevAufrufe.push(body);
  const answers = {};
  for (const k of Object.keys(body.questions)) {
    const i = Number(k.replace('skill_', ''));
    const s = body.state.skills.find((x) => x.i === i);
    answers[k] = { noul: s?.name === 'gut-skill' ? 0.9 : 0.1 };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 77, output_tokens: 4, cost: 0.0002 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const require = createRequire(new URL('../package.json', import.meta.url));
const { Pool } = require('pg');
await import('../dist/index.js');
const DB = await import('../dist/db/client.js');
const SH = await import('../dist/services/skill-hook.js');
const SP = await import('../dist/services/intern-skill-probe.js');
const IT = await import('../dist/services/intern-tool.js');
const JS = await import('../dist/services/jev-schalter.js');

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
const zeilen = async () => {
  const r = await q(`SELECT (SELECT count(*)::int FROM skill_hook_preparations) AS preps,
    (SELECT count(*)::int FROM agent_identitaet_skill_preparations) AS ipreps,
    (SELECT count(*)::int FROM skill_hook_deliveries) AS deliv`);
  return r.rows[0];
};

const ZWECK = 'Flottenplanung und Kampfsimulation fuer Browser-Strategiespiele: Schiffstypen, Rapidfire, Verteidigung.';
const ABSCHNITT = ('Langer Abschnitt ueber Flottenzusammenstellung. ').repeat(30).trim();
const hits = [treffer('gut-skill', 0.8, 'flotte', ABSCHNITT), treffer('schlecht-skill', 0.78, 'rezepte', 'Kochrezepte'), treffer('leise-skill', 0.4, 'x', 'leise')];
const probe = (args, agent = 'koordinator', h = hits) => SP.fuehreSkillProbeAus('skill_probe', { project: P, ...args }, agent, { searchBatch: fakeSuche(h) });

try {
  await q('CREATE SCHEMA ' + schema);
  for (const t of ['skill_names', 'skill_hook_preparations', 'skill_hook_deliveries', 'skill_hook_metrics', 'agent_identitaet_skill_preparations',
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
  await q(`INSERT INTO ${schema}.skill_names (skill_name, section_count) SELECT unnest($1::text[]), 2`, [['gut-skill', 'schlecht-skill', 'leise-skill', 'ogame-strategie']]);
  await q(`INSERT INTO ${schema}.skill_sections (punkt_id, skill_name, section, content, scope) VALUES
    (1, 'gut-skill', 'uebersicht', $1, 'global'), (2, 'gut-skill', 'flotte', $2, 'global'),
    (3, 'schlecht-skill', 'rezepte', 'Kochrezepte', 'global')`, [ZWECK, ABSCHNITT]);
  await pool.query('SELECT 1');
  console.log('PASS Schema ' + schema);

  // ---------------------------------------------------------------- A
  await pruefe('A Rechte: Action gelistet; Subagent -> recht_fehlt; ohne text -> parameter_fehlt', async () => {
    assert(IT.INTERN_ACTIONS.includes('skill_probe'));
    assert(IT.INTERN_DEFINITION.inputSchema.properties.mit_jev && IT.INTERN_DEFINITION.inputSchema.properties.empfaenger);
    assert.match(IT.INTERN_DEFINITION.description, /skill_probe/);
    const r = await IT.fuehreInternAus({ action: 'skill_probe', project: P, text: 'Rapidfire' }, 'agent-a');
    assert.equal(r.success, false); assert.equal(r.error, 'recht_fehlt', JSON.stringify(r));
    const r2 = await IT.fuehreInternAus({ action: 'skill_probe', project: P }, 'koordinator');
    assert.equal(r2.error, 'parameter_fehlt');
    const r3 = await probe({ text: 'x', schwelle: 2 });
    assert.equal(r3.error, 'parameter_ungueltig');
  });

  // ---------------------------------------------------------------- B
  await pruefe('B Probe ohne Jev: Kandidaten, Schwellen mit Quelle, Jev-state, skill_rerank AUS, nichts geschrieben', async () => {
    const vorher = await zeilen();
    const r = await probe({ text: 'Rapidfire im Kampfsimulator stimmt nicht, siehe ogame-strategie', empfaenger: ['agent-a', 'agent-b'] });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.geschrieben, false);
    assert.deepEqual(r.schwellen.channel_skill, { schwelle: 0.6, quelle: 'env:SCORE_SCHWELLE_CHANNEL_SKILL', test: null });
    assert.equal(r.schwellen.channel_skill_abstand.quelle, 'env:SCORE_SCHWELLE_CHANNEL_SKILL_ABSTAND');
    assert.deepEqual(r.namentlich_genannt, ['ogame-strategie']);
    assert.equal(r.je_empfaenger.length, 2);
    const a = r.je_empfaenger[0];
    const erg = Object.fromEntries(a.treffer.map((t) => [t.skill_name, t.ergebnis]));
    assert.deepEqual(erg, { 'ogame-strategie': 'namentlich', 'gut-skill': 'kandidat', 'schlecht-skill': 'kandidat', 'leise-skill': 'unter_schwelle' });
    assert.equal(a.treffer.find((t) => t.skill_name === 'gut-skill').score, 0.8);
    assert.deepEqual(r.sinnpruefung_kandidaten.sort(), ['gut-skill', 'ogame-strategie', 'schlecht-skill'], 'P23-T8: genannte gehen mit in die Sinnpruefung');
    assert.equal(r.jev.skill_rerank.an, false); assert.equal(r.jev.skill_rerank.ebene, 'standard');
    assert.equal(r.jev.ergebnis, undefined, 'ohne mit_jev kein Ergebnis');
    assert(r.jev.tokens.gesamt > 0 && r.jev.tokens.gesamt <= r.jev.budget_tokens);
    const gut = r.jev.teile.skills.find((s) => s.name === 'gut-skill');
    assert.equal(gut.zweck, ZWECK); assert.equal(gut.abschnitt_zeichen, ABSCHNITT.length);
    assert(gut.abschnitt.length <= 300 && gut.abschnitt.endsWith('…'), 'Auszug gekuerzt');
    assert(gut.tokens > 0); assert(r.jev.teile.text.tokens > 0);
    assert.equal(r.jev.teile.empfaenger.gruppen, 1);
    assert.equal(jevAufrufe.length, 0, 'kein Jev-Aufruf');
    assert.deepEqual(await zeilen(), vorher, 'nichts in Vorrat/Zustellungen');
  });

  // ---------------------------------------------------------------- C
  await pruefe('C Testwerte schwelle/abstand nur fuer die Probe', async () => {
    const r = await probe({ text: 'Rapidfire im Kampfsimulator stimmt nicht', schwelle: 0.79 });
    const t = Object.fromEntries(r.je_empfaenger[0].treffer.map((x) => [x.skill_name, x.ergebnis]));
    assert.equal(t['gut-skill'], 'kandidat'); assert.equal(t['schlecht-skill'], 'unter_schwelle');
    assert.equal(r.schwellen.channel_skill.test, 0.79); assert.equal(r.schwellen.wirksam.schwelle, 0.79); assert.equal(r.schwellen.wirksam.test, true);
    const m = await probe({ text: 'Rapidfire im Kampfsimulator stimmt nicht', abstand: 0.05 });
    const tm = Object.fromEntries(m.je_empfaenger[0].treffer.map((x) => [x.skill_name, x.ergebnis]));
    assert.equal(tm['gut-skill'], 'mehrdeutig'); assert.equal(tm['schlecht-skill'], 'mehrdeutig');
    assert.deepEqual(m.je_empfaenger[0].mehrdeutigkeit, { erster: 'gut-skill', zweiter: 'schlecht-skill', differenz: 0.02, abstand: 0.05 });
    assert.equal(m.jev.grund, 'keine_kandidaten');
    const n = await probe({ text: 'Rapidfire im Kampfsimulator stimmt nicht' });
    assert.equal(n.schwellen.wirksam.schwelle, 0.6); assert.equal(n.schwellen.wirksam.abstand, 0);
    const tn = Object.fromEntries(n.je_empfaenger[0].treffer.map((x) => [x.skill_name, x.ergebnis]));
    assert.equal(tn['gut-skill'], 'kandidat'); assert.equal(tn['schlecht-skill'], 'nicht_bester');
  });

  // ---------------------------------------------------------------- D
  await pruefe('D mit_jev bei skill_rerank AUS: echter Aufruf skill_rerank_probe, Wert/Tor/Ergebnis, Kosten, nichts im Vorrat', async () => {
    const vorher = await zeilen();
    assert.equal((await JS.jevWirksam(P, 'skill_rerank')).an, false);
    const r = await probe({ text: 'Rapidfire im Kampfsimulator stimmt nicht, siehe ogame-strategie', mit_jev: true });
    assert.equal(jevAufrufe.length, 1, 'genau ein Jev-Aufruf');
    const e = r.jev.ergebnis;
    assert.equal(e.gelaufen, true, JSON.stringify(r.jev)); assert.equal(e.funktion, 'skill_rerank_probe'); assert.equal(e.tor, 0.5);
    const je = Object.fromEntries(e.je_kandidat.map((k) => [k.skill_name, k]));
    assert.deepEqual(je['gut-skill'], { skill_name: 'gut-skill', art: 'semantisch', wert: 0.9, ergebnis: 'durchgelassen' });
    assert.deepEqual(je['schlecht-skill'], { skill_name: 'schlecht-skill', art: 'semantisch', wert: 0.1, ergebnis: 'verworfen' });
    assert.deepEqual(je['ogame-strategie'], { skill_name: 'ogame-strategie', art: 'namentlich', wert: 0.1, ergebnis: 'verworfen' }, 'P23-T8');
    assert.equal(e.input_tokens, 77); assert(e.usd > 0);
    assert.deepEqual(jevAufrufe[0].state.skills.map((s) => s.name).sort(), ['gut-skill', 'ogame-strategie', 'schlecht-skill'], 'P23-T8: genannte Skills gehen mit an Jev');
    assert.equal(jevAufrufe[0].state.quelle.art, 'probe');
    const z = (await q("SELECT funktion, ok, input_tokens FROM jev_aufrufe WHERE project=$1 ORDER BY id DESC LIMIT 1", [P])).rows[0];
    assert.deepEqual(z, { funktion: 'skill_rerank_probe', ok: true, input_tokens: 77 });
    assert.deepEqual(await zeilen(), vorher, 'nichts in Vorrat/Zustellungen');
  });

  // ---------------------------------------------------------------- E
  await pruefe('E skill_rerank_probe fuer das Projekt aus -> grund aus, kein Aufruf', async () => {
    await JS.setzeJevSchalter({ ebene: 'projekt', project: P, funktion: 'skill_rerank_probe', aktiv: false, grund: 'test', agent: 'koordinator' });
    const vorher = jevAufrufe.length;
    const r = await probe({ text: 'Rapidfire im Kampfsimulator stimmt nicht', mit_jev: true });
    assert.equal(r.jev.ergebnis.gelaufen, false); assert.equal(r.jev.ergebnis.grund, 'aus');
    assert.equal(jevAufrufe.length, vorher);
    await JS.setzeJevSchalter({ ebene: 'projekt', project: P, funktion: 'skill_rerank_probe', aktiv: true, grund: 'test', agent: 'koordinator' });
  });

  // ---------------------------------------------------------------- F
  await pruefe('F Hook unveraendert nach Refactor: legt genannte + semantische Kandidaten ab (Pruefung AUS)', async () => {
    const vorher = jevAufrufe.length;
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-f', 'Rapidfire im Kampfsimulator laut ogame-strategie', ['agent-a'], pool, fakeSuche(hits));
    const r = (await q('SELECT skill_name, reason FROM skill_hook_preparations WHERE agent_id=$1 AND source_id=$2 ORDER BY skill_name', ['agent-a', 'T-f'])).rows;
    assert.deepEqual(r.map((x) => x.skill_name), ['gut-skill', 'ogame-strategie', 'schlecht-skill']);
    assert.match(r.find((x) => x.skill_name === 'gut-skill').reason, /Semantischer Treffer \(Task, Score 0\.80\)/);
    assert.equal(jevAufrufe.length, vorher, 'skill_rerank AUS -> kein Jev');
  });
} finally {
  await q('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch((e) => console.error('Aufraeumen: ' + e.message));
  await raw.end();
  await DB.closePool?.().catch?.(() => undefined);
}
console.log(`ERGEBNIS ${checks} PASS, ${failed} FAIL, Jev-Fake-Aufrufe ${jevAufrufe.length}`);
process.exit(failed ? 1 : 0);
