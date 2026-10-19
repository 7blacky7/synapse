/**
 * P23-T1: Skill-Vorschlaege nach Sinn. Echte DB-Vertraege in eigenem Schema auf synapse_test:5433,
 * keine Modell-/Netzaufrufe (Jev per Fake-fetch, Vektorsuche per Fake-searchBatch).
 *   node packages/core/tests/skill-vorschlaege-sinn-p23-t1.test.mjs
 *   P23_BASE_ROOT=/tmp/synapse-basis-<sha>  (Positivkontrolle: dieselben Fehltreffer am alten Stand ROT)
 * A  Namensregel: nur voller Name mit Wortgrenze (Fragment/Trigramm zurueckgebaut)
 * B  Positivkontrolle: Basis liefert die Fehltreffer (ogame-strategie-erweitert, Trigramm), neu nicht
 * C  Vorrat: genannt 0,99, semantisch mit Score in der reason, kein Fragment-Treffer
 * D  Sinnpruefung skill_rerank: Standard AUS (kein Jev), an -> 1 Jev-Aufruf, Tor filtert, Kosten gebucht,
 *    global aus gewinnt, intern-Freigabe befristet, Einstellwerte in jev_optionen
 * E  99%-Kette: Skill-Abruf (verknuepfte Skills, Quellskill gesehen), Vorgabe, Erinnerung "noch N weitere"
 *    nur 0,99 an uebrigen Tools; unabhaengig von Namensanfang/Trigramm
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 'p23_t1_' + process.pid + '_' + randomUUID().slice(0, 8);
const P = 'p23-t1-' + randomUUID().slice(0, 8);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.href;
Object.assign(process.env, {
  SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_AGENT_BEZUG_MODUS: 'alt',
  JEV_SCHALTER_CACHE_MS: '0', SYNAPSE_INTERN_CACHE_MS: '0', SYNAPSE_INTERN_TOOL: '1', JEV_OPENROUTER_API_KEY: 'test-only-jev-key',
  SCORE_SCHWELLE_CHANNEL_SKILL: '0.6', SCORE_SCHWELLE_CHANNEL_SKILL_ABSTAND: '0',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
});
delete process.env.SYNAPSE_DATABASE_URL;

// Jev-Fake: "gut-skill" hilft (0.9), alles andere nicht (0.1). Jeder Aufruf wird mitgeschrieben.
const jevAufrufe = [];
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body);
  jevAufrufe.push(body);
  const answers = {};
  for (const [k] of Object.entries(body.questions)) {
    const i = Number(k.replace('skill_', ''));
    answers[k] = { noul: body.state.skills[i].name === 'gut-skill' ? 0.9 : 0.1 };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 42, output_tokens: 3, cost: 0.0001 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const require = createRequire(new URL('../package.json', import.meta.url));
const { Pool } = require('pg');
await import('../dist/index.js');
const DB = await import('../dist/db/client.js');
const SK = await import('../dist/services/skills.js');
const SH = await import('../dist/services/skill-hook.js');
const JS = await import('../dist/services/jev-schalter.js');
const JO = await import('../dist/services/jev-optionen.js');
const IS = await import('../dist/services/intern-schalter.js');

const raw = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const q = (s, v = []) => raw.query(s, v);
const pool = DB.getPool();
let checks = 0, failed = 0;
const pruefe = async (name, fn) => {
  try { await fn(); console.log('PASS ' + (++checks) + ' ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message + '\n' + String(e.stack).split('\n').slice(1, 3).join(' ')); }
};
const treffer = (name, score, content = '') => ({ skill_name: name, section: 's', score, content, tags: [], scope: 'global' });
const fakeSuche = (hits) => async (_q, _p, agents) => agents.map((agent) => ({ agent, hits: hits.map((h) => ({ ...h })) }));
const preps = async (agent, sourceId) => (await q(
  'SELECT skill_name, score, reason FROM skill_hook_preparations WHERE agent_id=$1 AND ($2::text IS NULL OR source_id=$2) ORDER BY skill_name', [agent, sourceId ?? null])).rows;
const SKILLS = ['ogame-strategie', 'ogame-strategie-erweitert', 'memory-leak-debugging', 'database-migration',
  'superpowers-brainstorming', 'superpowers-nutzen', 'fal-ai-image', 'gut-skill', 'schlecht-skill', 'ki-browser-standalone',
  'v1-skill', 'v2-skill', 'v3-skill', 'v4-skill', 'v5-skill'];

try {
  await q('CREATE SCHEMA ' + schema);
  for (const t of ['skill_names', 'skill_hook_preparations', 'skill_hook_deliveries', 'skill_hook_metrics',
    'jev_schalter', 'jev_optionen', 'jev_aufrufe', 'jev_budget_stand', 'intern_schalter']) {
    await q(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
  }
  // Eigene Sequenzen: keine gemeinsam genutzten public-Sequenzen.
  const seqs = (await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'", [schema])).rows;
  for (const [i, d] of seqs.entries()) {
    await q(`CREATE SEQUENCE ${schema}.p23_seq_${i}`);
    await q(`ALTER TABLE ${schema}.${d.table_name} ALTER COLUMN ${d.column_name} SET DEFAULT nextval('${schema}.p23_seq_${i}'::regclass)`);
  }
  await q(`INSERT INTO ${schema}.skill_names (skill_name, section_count) SELECT unnest($1::text[]), 1`, [SKILLS]);
  await pool.query('SELECT 1'); // Pool anwaermen (Hook-Abfragen haben 30 ms Frist)
  console.log('PASS Schema ' + schema);

  // ---------------------------------------------------------------- A
  await pruefe('A Namensregel: voller Name mit Wortgrenze, kein Fragment', async () => {
    const t = SK.istSkillNameImText;
    assert.equal(t('ogame-strategie', 'nutze ogame-strategie-erweitert'), false, 'kurzer Name in laengerem');
    assert.equal(t('ogame-strategie-erweitert', 'siehe ogame-strategie'), false, 'Namensanfang (Fragment)');
    assert.equal(t('ogame-strategie', 'siehe ogame-strategie.'), true, 'Satzende ist Grenze');
    assert.equal(t('ogame-strategie', 'skills/ogame-strategie/SKILL.md'), true, 'Pfad');
    assert.equal(t('ki-browser-standalone', 'siehe ki-browser hier'), false, 'Qwen-Notbehelf zurueckgebaut');
    assert.equal(t('memory-leak-debugging', 'ein memory leak beim debugging'), false);
    assert.equal(t('python-performance-optimization', 'wir nehmen python-testing-patterns'), false);
    assert.equal(t('codex:rescue', 'nimm codex:rescue jetzt'), true);
    assert.equal(t('codex', 'nimm codex:rescue jetzt'), false, 'Doppelpunkt mit Folgezeichen gehoert zum Namen');
    assert.equal(t('fal-ai-image', 'Bilder (fal-ai-image), fertig'), true);
    assert.equal(SH.istNamentlichGenannt('ogame-strategie', 'nutze ogame-strategie-erweitert'), false, 'skill-hook nutzt dieselbe Regel');
  });

  const fehlText = 'Flotte planen laut ogame-strategie; ausserdem ein Memory Leak Debugging und eine Database Migrations-Frage.';
  await pruefe('A findeSkillsNachName: nur ogame-strategie (kein Fragment, kein Trigramm)', async () => {
    assert.deepEqual((await SK.findeSkillsNachName(fehlText)).sort(), ['ogame-strategie']);
    assert.deepEqual((await SK.findeSkillsNachName('ogame-strategie-erweitert ist gemeint')).sort(), ['ogame-strategie-erweitert']);
  });

  // ---------------------------------------------------------------- B
  const basis = process.env.P23_BASE_ROOT ?? '/tmp/synapse-basis-1074d443';
  await pruefe('B Positivkontrolle: Basis ' + basis + ' liefert die Fehltreffer (rot)', async () => {
    const pfad = join(basis, 'packages/core/dist/services/skills.js');
    assert(existsSync(pfad), 'Basis-Build fehlt: ' + pfad);
    const BSK = await import(pathToFileURL(pfad).href);
    const BSH = await import(pathToFileURL(join(basis, 'packages/core/dist/services/skill-hook.js')).href);
    const alt = await BSK.findeSkillsNachName(fehlText);
    assert(alt.includes('ogame-strategie-erweitert'), 'Basis: Fragment-Fehltreffer erwartet, bekam ' + JSON.stringify(alt));
    assert.equal(BSH.istNamentlichGenannt('ogame-strategie', 'nutze ogame-strategie-erweitert'), true, 'Basis: includes ohne Grenze');
    assert.equal(BSH.istNamentlichGenannt('ki-browser-standalone', 'siehe ki-browser hier'), true, 'Basis: Fragment-Regel');
  });

  // ---------------------------------------------------------------- C
  const hits = [treffer('ogame-strategie-erweitert', 0.3), treffer('gut-skill', 0.8, 'Flottenplanung'), treffer('schlecht-skill', 0.7, 'Kochrezepte')];
  await pruefe('C Vorrat: genannt 0,99, semantisch mit Score, kein Fragment, Sinnpruefung AUS = kein Jev', async () => {
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-c', 'Plane mit ogame-strategie die Flotte', ['agent-c'], pool, fakeSuche(hits));
    const r = await preps('agent-c', 'T-c');
    assert.deepEqual(r.map((x) => x.skill_name), ['gut-skill', 'ogame-strategie', 'schlecht-skill']);
    const og = r.find((x) => x.skill_name === 'ogame-strategie');
    assert.equal(og.score, 0.99); assert.equal(og.reason, 'Skill-Name genannt (Task)');
    assert.equal(r.find((x) => x.skill_name === 'gut-skill').reason, 'Semantischer Treffer (Task, Score 0.80)');
    assert.equal(jevAufrufe.length, 0, 'Standard AUS: kein Jev-Aufruf');
    const w = await JS.jevWirksam(P, 'skill_rerank');
    assert.equal(w.an, false); assert.equal(w.ebene, 'standard');
  });

  // ---------------------------------------------------------------- D
  await pruefe('D Sinnpruefung an (Projekt-Schalter): 1 Jev-Aufruf, Tor filtert, Kosten gebucht, Debug in reason', async () => {
    await JS.setzeJevSchalter({ ebene: 'projekt', project: P, funktion: 'skill_rerank', aktiv: true, grund: 'test', agent: 'koordinator' });
    const w = await JS.jevWirksam(P, 'skill_rerank');
    assert.equal(w.an, true); assert.equal(w.quelle, 'produkt-schalter');
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-d', 'Plane mit ogame-strategie die Flotte', ['agent-d', 'agent-d2'], pool, fakeSuche(hits));
    assert.equal(jevAufrufe.length, 1, 'EIN Aufruf fuer alle Empfaenger');
    assert.deepEqual(jevAufrufe[0].state.skills.map((s) => s.name).sort(), ['gut-skill', 'schlecht-skill'], 'genannte Skills gehen nicht an Jev');
    const r = await preps('agent-d', 'T-d');
    assert.deepEqual(r.map((x) => x.skill_name), ['gut-skill', 'ogame-strategie']);
    assert.match(r[0].reason, /Jev-Sinnpruefung 0\.90 \(Tor 0\.5\)/);
    const kosten = (await q("SELECT funktion, ok, usd::float8 AS usd FROM jev_aufrufe WHERE project=$1", [P])).rows;
    assert.deepEqual(kosten.map((k) => [k.funktion, k.ok]), [['skill_rerank', true]]);
  });

  await pruefe('D Einstellwerte: skill_rerank_tor in jev_optionen wirkt, ungueltig abgelehnt', async () => {
    await JO.setzeJevOptionen({ skill_rerank_tor: 0.95, agent: 'koordinator' });
    assert.equal((await JO.leseJevOptionen()).skill_rerank_tor, 0.95);
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-d3', 'Plane mit ogame-strategie die Flotte', ['agent-d3'], pool, fakeSuche(hits));
    assert.deepEqual((await preps('agent-d3', 'T-d3')).map((x) => x.skill_name), ['ogame-strategie'], '0.9 < Tor 0.95');
    await assert.rejects(JO.setzeJevOptionen({ skill_rerank_tor: 1.5 }), (e) => e.code === 'skill_rerank_tor_ungueltig');
    await assert.rejects(JO.setzeJevOptionen({ skill_rerank_max: 0 }), (e) => e.code === 'skill_rerank_max_ungueltig');
    await JO.setzeJevOptionen({ skill_rerank_tor: 0.5, agent: 'koordinator' });
  });

  await pruefe('D global aus gewinnt ueber Projekt-an; intern-Freigabe befristet; Ablauf -> Standard AUS', async () => {
    await JS.setzeJevSchalter({ ebene: 'global', funktion: 'alle', aktiv: false, grund: 'test', agent: 'koordinator' });
    assert.equal((await JS.jevWirksam(P, 'skill_rerank')).an, false);
    const vorher = jevAufrufe.length;
    await SH.bereiteSkillVorschlaegeVor(P, 'task', 'T-d4', 'Plane mit ogame-strategie die Flotte', ['agent-d4'], pool, fakeSuche(hits));
    assert.equal(jevAufrufe.length, vorher, 'global aus: kein Jev');
    assert.deepEqual((await preps('agent-d4', 'T-d4')).map((x) => x.skill_name), ['gut-skill', 'ogame-strategie', 'schlecht-skill'], 'ohne Pruefung wie bisher');
    await q('DELETE FROM jev_schalter');
    assert.equal((await JS.jevWirksam(P, 'skill_rerank')).ebene, 'standard');
    await IS.setzeSchalter('skill_rerank', { aktiv: true, dauer_min: 5, grund: 'test', agent: 'koordinator' });
    const w = await JS.jevWirksam(P, 'skill_rerank');
    assert.equal(w.an, true); assert.equal(w.quelle, 'intern');
    await q("UPDATE intern_schalter SET bis = NOW() - interval '1 minute' WHERE name='skill_rerank'");
    assert.equal((await JS.jevWirksam(P, 'skill_rerank')).ebene, 'standard', 'abgelaufen -> Standard AUS');
    // andere Jev-Funktionen bleiben ohne Zeile an (Altverhalten)
    assert.equal((await JS.jevWirksam(P, 'plan_einordnen')).an, true);
  });

  // ---------------------------------------------------------------- E
  await pruefe('E Kette Skill-Abruf: woertlich genannte Skills 0,99, Quellskill gilt als gesehen', async () => {
    const n = await SH.bereiteVerknuepfteSkillsVor('', 'superpowers-nutzen',
      'Lade superpowers-brainstorming und fal-ai-image; superpowers-nutzen selbst; superpowers ist ein Thema.', 'agent-e', pool);
    assert.equal(n, 2);
    const r = await preps('agent-e');
    assert.deepEqual(r.map((x) => [x.skill_name, x.score, x.reason]), [
      ['fal-ai-image', 0.99, 'Verknuepft mit Skill superpowers-nutzen (Kette)'],
      ['superpowers-brainstorming', 0.99, 'Verknuepft mit Skill superpowers-nutzen (Kette)'],
    ]);
    const gesehen = (await q("SELECT skill_name, hook_name FROM skill_hook_deliveries WHERE agent_id='agent-e'")).rows;
    assert.deepEqual(gesehen, [{ skill_name: 'superpowers-nutzen', hook_name: 'skill_abruf' }]);
  });

  await pruefe('E Vorgabe + Erinnerung: je Abruf 3, "noch N weitere mit 99%", an uebrigen Tools nur die Kette', async () => {
    assert.equal(await SH.bereiteVorgabeSkillsVor(P, 'agent-v', ['v1-skill', 'v2-skill', 'v3-skill', 'v4-skill', 'v5-skill', 'v1-skill']), 5);
    await SH.legeSkillKandidatenAb(P, 'task', 'T-v', 'agent-v', [{ skill_name: 'schlecht-skill', score: 0.7, reason: 'Semantischer Treffer (Task, Score 0.70)' }], pool);
    const kette = { mindestScore: SH.KETTEN_SCORE };
    const a = await SH.holeOffeneSkillVorschlaege('agent-v', pool, 3, kette);
    assert.equal(a.suggestions[0].skills.length, 3);
    assert(a.suggestions[0].skills.every((s) => s.score === 0.99 && s.reason === 'Vorgabe (Profil, Kette)'));
    assert.equal(a.suggestions[0].weitere_mit_99, 2);
    assert.match(a.suggestions[0].message, /Es existieren noch 2 weitere Skills mit 99%/);
    const b = await SH.holeOffeneSkillVorschlaege('agent-v', pool, 3, kette);
    assert.equal(b.suggestions[0].skills.length, 2); assert.equal(b.suggestions[0].weitere_mit_99, undefined);
    assert.equal((await SH.holeOffeneSkillVorschlaege('agent-v', pool, 3, kette)).suggestions.length, 0, 'semantisch 0,7 nicht an uebrigen Tools');
    const c = await SH.holeOffeneSkillVorschlaege('agent-v', pool, 3);
    assert.deepEqual(c.suggestions[0].skills.map((s) => s.skill_name), ['schlecht-skill'], 'Normalabruf liefert auch Semantisches');
  });

  await pruefe('E Hinweisgeber (thought): genannter langer Name, nicht der kurze', async () => {
    await SH.verarbeiteSkillHinweisgeber('thought', 'add', { project: P, content: 'ogame-strategie-erweitert ist gemeint' }, { success: true, id: 'th-1' }, 'agent-h', pool, fakeSuche([]));
    assert.deepEqual((await preps('agent-h')).map((x) => [x.skill_name, x.reason]), [['ogame-strategie-erweitert', 'Skill-Name genannt (Gedanke)']]);
  });
} finally {
  await q('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch((e) => console.error('Aufraeumen: ' + e.message));
  await raw.end();
  await DB.closePool?.().catch?.(() => undefined);
}
console.log(`ERGEBNIS ${checks} PASS, ${failed} FAIL, Jev-Fake-Aufrufe ${jevAufrufe.length}`);
process.exit(failed ? 1 : 0);
