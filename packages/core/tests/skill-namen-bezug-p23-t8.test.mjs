/**
 * P23-T8: Skill-Vorschlaege ohne Fremdtreffer aus der Namens-Erkennung. Eigenes Schema auf synapse_test:5433,
 * Jev per Fake-fetch (kein Netz), Vektorsuche per Fake-searchBatch.
 *   node packages/core/tests/skill-namen-bezug-p23-t8.test.mjs
 * A  Kette = nur Vorgabe/Skill-Abruf: ein Namenstreffer aus einer fremden Quelle kommt an uebrigen Tools NICHT
 *    (Befund 20.10.2026: admin(task_bindung_festlegen) -> unraid-base 0,99)
 * B  Normalabruf ohne Bezug: semantisch ja, Namenstreffer nein, Altbestand (unscharf / alte Namensregel) nie
 * C  Mit Bezug (Quelle des Aufrufs): Namenstreffer kommt, und zwar vor allem anderen
 * D  holeSkillVorschlaegeFuerAufruf: ein Aufruf ohne Namen liefert nicht den Rest einer frueher gelesenen Quelle
 *    (Befund: memory(read) -> memory-leak-debugging, ogame-strategie); erneutes Lesen der Quelle liefert ihn
 * E  Sinnpruefung an: genannte Skills gehen an Jev; verworfen = nicht im Vorrat, bestanden = Marke + Jev-Wert
 * F  skill_probe: namentlich_erkannt mit Regel, Fundstellen (nur voller Name), Sinnpruefung, Zustellregeln
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 'p23_t8_' + process.pid + '_' + randomUUID().slice(0, 8);
const P = 'p23-t8-' + randomUUID().slice(0, 8);
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
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 50, output_tokens: 3, cost: 0.0001 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const require = createRequire(new URL('../package.json', import.meta.url));
const { Pool } = require('pg');
await import('../dist/index.js');
const DB = await import('../dist/db/client.js');
const SH = await import('../dist/services/skill-hook.js');
const SP = await import('../dist/services/intern-skill-probe.js');
const JS = await import('../dist/services/jev-schalter.js');

const raw = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const q = (s, v = []) => raw.query(s, v);
const pool = DB.getPool();
let checks = 0, failed = 0;
const pruefe = async (name, fn) => {
  try { await fn(); console.log('PASS ' + (++checks) + ' ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message + '\n' + String(e.stack).split('\n').slice(1, 3).join(' ')); }
};
const fakeSuche = (hits) => async (_q, _p, agents) => agents.map((agent) => ({ agent, hits: hits.map((h) => ({ ...h })) }));
const namen = (ergebnis) => (ergebnis.suggestions[0]?.skills ?? []).map((s) => s.skill_name);
const preps = async (agent, sourceId) => (await q(
  'SELECT skill_name, score, reason FROM skill_hook_preparations WHERE agent_id=$1 AND ($2::text IS NULL OR source_id=$2) ORDER BY skill_name', [agent, sourceId ?? null])).rows;
const genannt = (quelle) => `Skill-Name genannt (${quelle}, voller Name)`;
const SKILLS = ['ogame-strategie', 'unraid-base', 'memory-leak-debugging', 'fal-ai-image', 'gut-skill', 'schlecht-skill', 'v1-skill'];

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
  await q(`INSERT INTO ${schema}.skill_names (skill_name, section_count) SELECT unnest($1::text[]), 1`, [SKILLS]);
  await pool.query('SELECT 1'); // Pool anwaermen (Hook-Abfragen haben 30 ms Frist)
  console.log('PASS Schema ' + schema);

  // Vorrat wie im Befund: Vorgabe (Kette), Namenstreffer aus einer FREMDEN Task, Altbestand, ein semantischer Treffer.
  const vorrat = async (agent) => {
    await SH.bereiteVorgabeSkillsVor(P, agent, ['v1-skill'], pool);
    await SH.legeSkillKandidatenAb(P, 'task', 'T-fremd', agent, [{ skill_name: 'unraid-base', score: 0.99, reason: genannt('Task') }], pool);
    await SH.legeSkillKandidatenAb(P, 'thought', 'G-alt', agent, [
      { skill_name: 'memory-leak-debugging', score: 0.99, reason: 'Skill-Name genannt (Gedanke)' },
      { skill_name: 'ogame-strategie', score: 0.95, reason: 'Name unscharf erkannt (Memory)' },
    ], pool);
    await SH.legeSkillKandidatenAb(P, 'memory', 'M-sem', agent, [{ skill_name: 'gut-skill', score: 0.7, reason: 'Semantischer Treffer (Memory, Score 0.70)' }], pool);
  };
  const kette = { mindestScore: SH.KETTEN_SCORE };

  // ---------------------------------------------------------------- A
  await pruefe('A Kette nur Vorgabe/Skill-Abruf: fremder Namenstreffer kommt an uebrigen Tools nicht', async () => {
    assert.deepEqual([...SH.KETTEN_QUELLEN], ['vorgabe', 'skill']);
    await vorrat('agent-a');
    const a = await SH.holeOffeneSkillVorschlaege('agent-a', pool, 3, kette);
    assert.deepEqual(namen(a), ['v1-skill'], JSON.stringify(a));
    assert.equal(a.suggestions[0].weitere_mit_99, undefined, 'unraid-base zaehlt nicht als Kette');
    assert.equal((await SH.holeOffeneSkillVorschlaege('agent-a', pool, 3, kette)).suggestions.length, 0, 'kein Nachschlag ohne Bezug');
  });

  // ---------------------------------------------------------------- B
  await pruefe('B Normalabruf ohne Bezug: semantisch ja, Namenstreffer nein, Altbestand nie', async () => {
    await vorrat('agent-b');
    const b = await SH.holeOffeneSkillVorschlaege('agent-b', pool, 5);
    assert.deepEqual(namen(b).sort(), ['gut-skill', 'v1-skill'], JSON.stringify(b));
    assert.equal((await SH.holeOffeneSkillVorschlaege('agent-b', pool, 5)).suggestions.length, 0);
    const altBezug = await SH.holeOffeneSkillVorschlaege('agent-b', pool, 5, { quellen: [{ source_type: 'thought', source_id: 'G-alt' }] });
    assert.equal(altBezug.suggestions.length, 0, 'Altbestand auch mit Bezug nie');
  });

  // ---------------------------------------------------------------- C
  await pruefe('C Mit Bezug: Namenstreffer der Quelle des Aufrufs kommt, vor allem anderen', async () => {
    await vorrat('agent-c');
    await SH.legeSkillKandidatenAb(P, 'memory', 'M-hoch', 'agent-c', [{ skill_name: 'schlecht-skill', score: 0.995, reason: 'Semantischer Treffer (Memory, Score 0.995)' }], pool);
    const c = await SH.holeOffeneSkillVorschlaege('agent-c', pool, 1, { quellen: [{ source_type: 'task', source_id: 'T-fremd' }] });
    assert.deepEqual(namen(c), ['unraid-base'], 'mit Bezug zuerst, auch vor hoeherem Score');
    assert.equal(c.suggestions[0].reason, genannt('Task'));
  });

  // ---------------------------------------------------------------- D
  await pruefe('D Aufruf ohne Namen liefert nicht den Rest einer frueher gelesenen Quelle', async () => {
    const vier = 'Notiz: ogame-strategie, unraid-base, memory-leak-debugging und fal-ai-image.';
    const lies = (id, content) => SH.holeSkillVorschlaegeFuerAufruf('memory', 'read', { project: P, name: id },
      { success: true, memory: { name: id, content } }, 'agent-d', pool, fakeSuche([]));
    const erst = await lies('M-vier', vier);
    assert.equal(namen(erst).length, 3, JSON.stringify(erst));
    assert(erst.suggestions[0].skills.every((s) => s.reason === genannt('Memory')));
    const andere = await SH.holeSkillVorschlaegeFuerAufruf('thought', 'get', { project: P },
      { thoughts: [{ id: 'G-leer', content: 'Ein Gedanke ganz ohne Skill-Namen.' }] }, 'agent-d', pool, fakeSuche([]));
    assert.equal(andere.suggestions.length, 0, 'der vierte Name bleibt bei seiner Quelle: ' + JSON.stringify(andere));
    const nochmal = await lies('M-vier', vier);
    const alle = [...namen(erst), ...namen(nochmal)].sort();
    assert.deepEqual(alle, ['fal-ai-image', 'memory-leak-debugging', 'ogame-strategie', 'unraid-base'], 'erneutes Lesen liefert den Rest');
  });

  // ---------------------------------------------------------------- E
  await pruefe('E Sinnpruefung an: genannte Skills an Jev, verworfen nicht im Vorrat, bestanden mit Marke + Jev-Wert', async () => {
    await JS.setzeJevSchalter({ ebene: 'projekt', project: P, funktion: 'skill_rerank', aktiv: true, grund: 'test', agent: 'koordinator' });
    const vorher = jevAufrufe.length;
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-e', 'Plane mit gut-skill; Beispiel eines Fehlers: ogame-strategie', ['agent-e'], pool, fakeSuche([]));
    assert.equal(jevAufrufe.length, vorher + 1, 'ein Jev-Aufruf');
    assert.deepEqual(jevAufrufe.at(-1).state.skills.map((s) => s.name).sort(), ['gut-skill', 'ogame-strategie']);
    const r = await preps('agent-e', 'T-e');
    assert.deepEqual(r.map((x) => x.skill_name), ['gut-skill'], 'ogame-strategie (0.1) verworfen');
    assert.equal(r[0].reason, 'Skill-Name genannt (Task, voller Name, Jev-Sinnpruefung 0.90 (Tor 0.5))');
    await q('DELETE FROM jev_schalter');
  });

  // ---------------------------------------------------------------- F
  await pruefe('F skill_probe: namentlich_erkannt mit Fundstellen, Sinnpruefung, Zustellregeln', async () => {
    const r = await SP.fuehreSkillProbeAus('skill_probe',
      { project: P, text: 'siehe ogame-strategie, ogame-strategie-erweitert und ogame-strategie.' }, 'koordinator', { searchBatch: fakeSuche([]) });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.namentlich_erkannt.length, 1);
    const n = r.namentlich_erkannt[0];
    assert.equal(n.skill_name, 'ogame-strategie'); assert.equal(n.quelle, 'namensliste'); assert.equal(n.score, 0.99);
    assert.equal(n.fundstellen.length, 2, 'ogame-strategie-erweitert ist keine Fundstelle: ' + JSON.stringify(n.fundstellen));
    assert.deepEqual(n.fundstellen.map((f) => f.position), [6, 53]);
    assert.equal(n.sinnpruefung, true);
    assert.match(n.zustellung, /keine Kette/);
    assert.deepEqual(r.zustellung_regeln.kette_quellen, ['vorgabe', 'skill']);
    assert.match(r.zustellung_regeln.altbestand, /Name unscharf erkannt/);
    assert.deepEqual(r.sinnpruefung_kandidaten, ['ogame-strategie']);
  });
} finally {
  await q('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch((e) => console.error('Aufraeumen: ' + e.message));
  await raw.end();
  await DB.closePool?.().catch?.(() => undefined);
}
console.log(`ERGEBNIS ${checks} PASS, ${failed} FAIL, Jev-Fake-Aufrufe ${jevAufrufe.length}`);
process.exit(failed ? 1 : 0);
