#!/usr/bin/env node
// test-jev-empfehlung.mjs — plan(action:'empfehlen'), experimentell (JEV-3).
//
//   1. Request-Form: EIN Jev-Aufruf fuer alle Tasks. Je Task: choice model_<i> ueber die
//      Modelle (eine Option je Kandidat), je Kandidat mit > 1 Stufe choice
//      effort_<i>_<modell> ueber dessen Stufen, noul langer_kontext_<i>. Fragen englisch.
//      Gewertet wird die Stufe des gewaehlten Modells. Fragen- und Tokenzahl im Ergebnis.
//   2. Kandidaten: Standard 'anthropic' (nur Claude-CLI, User-Entscheidung 29.09.2026), 'abos'/'codex'/
//      'google'/'alle' ausdruecklich waehlbar, Unbekanntes -> Fehler mit erlaubten Werten.
//      Jedes angefragte Modell kommt vor (keine Kappung, max_optionen nur auf Wunsch).
//   3. Nur Stufen aus criteria UND Registry (haiku ohne Effort, opus-4.6 ohne xhigh).
//      Nur eine Option: keine Frage, direkt gesetzt, Confidence 1.0, Vermerk einzige_option.
//   4. Confidence-Tor -> unsicher statt Empfehlung; Stufe unsicher -> effort_unsicher.
//   5. Key fehlt / Timeout / HTTP-Fehler -> saubere Meldung, kein Absturz, Key nie im Ergebnis.
//   6. Schreiben: nur das Feld empfehlung je Task, alle anderen Felder unveraendert.
//   7. wiederverwenden: idle Spezialist derselben Familie mit 1M.
//   8. Katalog = Kopie von JEV-Test daten/modellwahl_criteria.json (Drift-Pruefung), Texte der
//      Quelle in den Fragen; lage als Kategorien + Vorfilter; stakes/previous_attempt je Task.
//
// Ohne echte DB (pg.Pool.prototype.query ersetzt) und OHNE echten Jev-Aufruf (Fake-fetch).
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-jev-empfehlung.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
delete process.env.JEV_OPENROUTER_API_KEY;
delete process.env.JEV_API_URL;
delete process.env.JEV_MODELL;
delete process.env.JEV_TIMEOUT_MS;
delete process.env.JEV_CONFIDENCE_TOR;

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = requireFromCore('pg');

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`OK     ${name}`);
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Fake-DB: eine plans-Zeile im Speicher
// ---------------------------------------------------------------------------
const TEST_KEY = 'sk-or-test-GEHEIM-0123456789';
let planZeile;
let updates = [];
function frischerPlan() {
  planZeile = {
    id: 'plan-1', project: 'testprojekt', name: 'Testplan', description: 'Ein Plan zum Testen der Modellwahl.',
    goals: ['Ziel A'], architecture: 'Monorepo, TypeScript',
    tasks: [
      { id: 't1', title: 'Variable umbenennen', description: 'foo -> bar in einer Datei', status: 'todo', priority: 'low', createdAt: 'x', updatedAt: 'x', eigenesFeld: { a: 1 } },
      { id: 't2', title: 'Feature bauen', description: 'Neuer Endpunkt mit Tests', status: 'in_progress', priority: 'medium', createdAt: 'x', updatedAt: 'x', stakes: 'critical', previous_attempt: 'failed with a smaller model' },
      { id: 't3', title: 'Grosser Umbau', description: 'Schichtwechsel ueber 40 Module', status: 'todo', priority: 'high', createdAt: 'x', updatedAt: 'x', empfehlung: { alt: true }, stakes: 'hoch' },
      { id: 't4', title: 'Erledigt', description: 'schon fertig', status: 'done', priority: 'low', createdAt: 'x', updatedAt: 'x' },
    ],
  };
  updates = [];
}
frischerPlan();

pg.Pool.prototype.query = async function (sql, params = []) {
  const text = typeof sql === 'string' ? sql : sql.text;
  if (/^\s*SELECT[\s\S]*FROM plans/i.test(text)) {
    if (params[0] !== planZeile.project) return { rows: [], rowCount: 0 };
    return { rows: [structuredClone(planZeile)], rowCount: 1 };
  }
  if (/^\s*UPDATE plans/i.test(text)) {
    const [neu, , id, alt] = params;
    updates.push({ text, params });
    if (id !== planZeile.id) return { rows: [], rowCount: 0 };
    if (JSON.stringify(JSON.parse(alt)) !== JSON.stringify(planZeile.tasks)) return { rows: [], rowCount: 0 };
    planZeile.tasks = JSON.parse(neu);
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

// ---------------------------------------------------------------------------
// Fakes fuer Registry, wrapper_status, Qdrant und fetch
// ---------------------------------------------------------------------------
const ALLE = ['low', 'medium', 'high', 'xhigh', 'max'];
const OHNE_XHIGH = ['low', 'medium', 'high', 'max'];
let registry;
function standardRegistry() {
  registry = [
    { alias: 'opus', effortStufen: ALLE }, { alias: 'opus[1m]', effortStufen: ALLE },
    { alias: 'sonnet', effortStufen: ALLE }, { alias: 'sonnet[1m]', effortStufen: ALLE },
    { alias: 'haiku', effortStufen: [] }, { alias: 'fable', effortStufen: ALLE },
    { alias: 'opus-4.6', effortStufen: OHNE_XHIGH }, { alias: 'opus-4.6[1m]', effortStufen: OHNE_XHIGH },
  ];
}
standardRegistry();
let wrapper = [];
let qdrantAufrufe = [];

let fetchAufrufe = [];
let antwortFuer = () => ({});
function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  fetchAufrufe.push({ url, init, body });
  return Promise.resolve(new Response(JSON.stringify({
    model: body.model,
    answers: antwortFuer(body),
    usage: { input_tokens: 1234, cost: 0.0000518 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

function wahl(q, soll, conf) {
  const labels = Object.keys(q.criteria);
  const w = labels.includes(soll) ? soll : labels[0];
  return { type: 'choice', choice: w, confidence: conf, probabilities: Object.fromEntries(labels.map((l) => [l, l === w ? 0.8 : 0.2 / (labels.length - 1)])) };
}

/** je[i] = { modell, effort | efforts: {<schluessel>: stufe}, conf, effConf, p } */
function antworten(je) {
  return (body) => {
    const a = {};
    for (const [name, q] of Object.entries(body.questions)) {
      let m;
      if ((m = /^model_(\d+)$/.exec(name))) {
        const s = je[m[1]] ?? {};
        a[name] = wahl(q, s.modell, s.conf ?? 0.9);
      } else if ((m = /^effort_(\d+)_(.+)$/.exec(name))) {
        const s = je[m[1]] ?? {};
        a[name] = wahl(q, s.efforts?.[m[2]] ?? s.effort, s.effConf ?? 0.9);
      } else if ((m = /^langer_kontext_(\d+)$/.exec(name))) {
        a[name] = { type: 'noul', noul: (je[m[1]] ?? {}).p ?? 0.1 };
      } else {
        throw new Error(`unerwartete Frage ${name}`);
      }
    }
    return a;
  };
}

const deps = () => ({
  fetch: fakeFetch,
  listModels: async () => registry,
  listWrapperStatus: async () => wrapper,
  qdrantSync: async (...args) => { qdrantAufrufe.push(args); },
});

function reset() {
  frischerPlan();
  standardRegistry();
  wrapper = [];
  qdrantAufrufe = [];
  fetchAufrufe = [];
  antwortFuer = antworten({});
  process.env.JEV_OPENROUTER_API_KEY = TEST_KEY;
  delete process.env.JEV_TIMEOUT_MS;
  delete process.env.JEV_CONFIDENCE_TOR;
}

const q = () => fetchAufrufe[0].body.questions;
const keys = (frage) => Object.keys(frage.criteria).sort();

const jev = await import('../packages/core/dist/services/jev-empfehlung.js');
const core = await import('../packages/core/dist/index.js');
const katalog = await import('../packages/core/dist/services/jev-criteria-katalog.js');
const QUELLE = '/home/blacky/dev/JEV-Test/daten/modellwahl_criteria.json';
const M = katalog.MODELLWAHL_CRITERIA.modelle;
/** task_id ist Pflicht (Channel 23092): die Tests nennen die offenen Tasks ausdruecklich. */
const OFFEN = ['t1', 't2', 't3'];
const empf = (projekt, opt = {}, d) => jev.empfehleFuerPlan(projekt, { task_ids: OFFEN, ...opt }, d);

const ABOS = ['fable', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'haiku', 'opus', 'sonnet'];
const CLAUDE = ['fable', 'haiku', 'opus', 'sonnet'];

await pruefe('Export: empfehleFuerPlan ist ueber @synapse/core erreichbar', () => {
  assert.equal(typeof core.empfehleFuerPlan, 'function');
  assert.equal(typeof core.loeseKandidatenAuf, 'function');
});

// ---------------------------------------------------------------------------
// 8. Katalog
// ---------------------------------------------------------------------------
await pruefe('Katalog: Kopie in synapse == JEV-Test-Quelle (sonst Kopie nachziehen)', () => {
  if (!existsSync(QUELLE)) { console.log('       (Quelle nicht lesbar, Vergleich uebersprungen)'); return; }
  const quelle = JSON.parse(readFileSync(QUELLE, 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(katalog.MODELLWAHL_CRITERIA)), quelle);
  assert.ok(katalog.KATALOG_STAND && katalog.KATALOG_QUELLE);
});

await pruefe('Katalog: Modell-Choice je Kandidat, Stufen-Choice mit den Texten der Quelle', async () => {
  reset();
  await empf('testprojekt', { kandidaten: 'alle', lage: { paid_api: 'allowed' }, schreiben: false }, deps());
  const f = q();
  assert.deepEqual(keys(f.model_0), [...ABOS, 'gemini-3.5-flash-lite', 'gemini-3.8-flash'].sort());
  assert.equal(f.model_0.criteria.haiku, M['claude-haiku-4-5'].stufen.default, 'Modell mit einer Stufe: deren Text');
  assert.equal(f.model_0.criteria.fable, M['claude-fable-5-1'].stufen.high);
  for (const t of Object.values(M['claude-opus-5-5'].stufen)) assert.ok(f.model_0.criteria.opus.includes(t), 'opus-Modelltext enthaelt jede Stufe');
  assert.equal(f.effort_0_sonnet.criteria.medium, M['claude-sonnet-5-5'].stufen.medium);
  assert.equal(f.effort_0_opus.criteria.xhigh, M['claude-opus-5-5'].stufen.xhigh);
  assert.equal(f.effort_0_gpt_5_6_luna.criteria.none, M['gpt-5.6-luna'].stufen.none);
  assert.deepEqual(keys(f.effort_0_gemini_3_8_flash), ['high', 'medium']);
  for (const ohne of ['effort_0_haiku', 'effort_0_fable', 'effort_0_gpt_5_6_sol', 'effort_0_gpt_5_6_terra', 'effort_0_gemini_3_5_flash_lite']) {
    assert.equal(f[ohne], undefined, `${ohne}: nur eine Stufe, keine Frage`);
  }
});

await pruefe('Katalog: nur Stufen aus criteria UND Registry (kein opus max, kein sonnet xhigh)', async () => {
  reset();
  await empf('testprojekt', { kandidaten: ['opus', 'sonnet'], schreiben: false }, deps());
  assert.deepEqual(keys(q().effort_0_opus), ['high', 'low', 'medium', 'xhigh']);
  assert.deepEqual(keys(q().effort_0_sonnet), ['high', 'low', 'max', 'medium']);
});

await pruefe('Katalog: Gruppennamen der Quelle (claude-abo, codex-abo, gemini-api) gelten wie anthropic/codex/google', () => {
  assert.deepEqual(jev.loeseKandidatenAuf('claude-abo').map((k) => k.alias), jev.loeseKandidatenAuf('anthropic').map((k) => k.alias));
  assert.deepEqual(jev.loeseKandidatenAuf('codex-abo').map((k) => k.alias), jev.loeseKandidatenAuf('codex').map((k) => k.alias));
  assert.deepEqual(jev.loeseKandidatenAuf('gemini-api').map((k) => k.alias), jev.loeseKandidatenAuf('google').map((k) => k.alias));
});

await pruefe('lage: im Zustand nur das Kontingent der angefragten Familien (Standard: nur claude_quota)', async () => {
  reset();
  let r = await empf('testprojekt', { schreiben: false }, deps());
  assert.deepEqual(fetchAufrufe[0].body.state.situation, { claude_quota: 'plenty' });
  assert.deepEqual(r.lage, { claude_quota: 'plenty', codex_quota: 'plenty', paid_api: 'not allowed' }, 'Ergebnis nennt die volle Lage');
  reset();
  await empf('testprojekt', { kandidaten: 'abos', lage: { codex_quota: 'low' }, schreiben: false }, deps());
  assert.deepEqual(fetchAufrufe[0].body.state.situation, { claude_quota: 'plenty', codex_quota: 'low' });
  reset();
  await empf('testprojekt', { kandidaten: 'alle', lage: { paid_api: 'allowed' }, schreiben: false }, deps());
  assert.deepEqual(fetchAufrufe[0].body.state.situation, { claude_quota: 'plenty', codex_quota: 'plenty', paid_api: 'allowed' });
  reset();
  await empf('testprojekt', { kandidaten: 'codex', schreiben: false }, deps());
  assert.deepEqual(fetchAufrufe[0].body.state.situation, { codex_quota: 'plenty' });
});

await pruefe('lage: claude_quota exhausted -> keine Claude-Modelle; paid_api not allowed -> kein Gemini (Hinweis)', async () => {
  reset();
  const r = await empf('testprojekt', { kandidaten: 'alle', lage: { claude_quota: 'exhausted' }, schreiben: false }, deps());
  assert.equal(r.success, true, r.message);
  assert.deepEqual(keys(q().model_0), ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra']);
  assert.ok(r.hinweise.some((h) => /claude_quota/.test(h)), JSON.stringify(r.hinweise));
  assert.ok(r.hinweise.some((h) => /paid_api/.test(h)), JSON.stringify(r.hinweise));
});

await pruefe('lage: ungueltiger Wert -> Fehler mit erlaubten Werten, kein fetch; alles vorgefiltert -> Fehler', async () => {
  reset();
  let r = await empf('testprojekt', { lage: { claude_quota: 'viel' } }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /plenty/);
  r = await empf('testprojekt', { kandidaten: 'google' }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /paid_api/);
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('Keine Kappung: abos bietet alle 8 Modelle an; max_optionen kappt nur die Modell-Choice (mit Hinweis)', async () => {
  reset();
  let r = await empf('testprojekt', { kandidaten: 'abos', schreiben: false }, deps());
  assert.deepEqual(keys(q().model_0), ABOS);
  assert.deepEqual(r.ausgelassen, []);
  reset();
  r = await empf('testprojekt', { kandidaten: 'abos', max_optionen: 3, schreiben: false }, deps());
  assert.equal(keys(q().model_0).length, 3);
  assert.equal(r.ausgelassen.length, 5);
  assert.ok(r.hinweise.some((h) => /max_optionen/.test(h)));
  const effortFragen = Object.keys(q()).filter((k) => k.startsWith('effort_0_'));
  for (const k of effortFragen) assert.ok(keys(q().model_0).some((mod) => k === `effort_0_${mod.replace(/[^a-z0-9]+/g, '_')}`), `${k} ohne Modell in der Choice`);
});

// ---------------------------------------------------------------------------
// 5a. Key fehlt
// ---------------------------------------------------------------------------
await pruefe('Key fehlt: klare Meldung "Jev nicht konfiguriert", kein fetch, kein Absturz', async () => {
  reset();
  delete process.env.JEV_OPENROUTER_API_KEY;
  const r = await empf('testprojekt', {}, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /Jev nicht konfiguriert/);
  assert.match(r.message, /JEV_OPENROUTER_API_KEY/);
  assert.equal(fetchAufrufe.length, 0);
  assert.equal(updates.length, 0);
});

// ---------------------------------------------------------------------------
// 1. Request-Form
// ---------------------------------------------------------------------------
await pruefe('Request: EIN Aufruf fuer alle offenen Tasks, Standard-URL/-Modell, Bearer-Key, Fragen/Tokens gemeldet', async () => {
  reset();
  const r = await empf('testprojekt', { schreiben: false }, deps());
  assert.equal(r.success, true, r.message);
  assert.equal(fetchAufrufe.length, 1);
  const { url, init, body } = fetchAufrufe[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.equal(body.model, 'typesafe/jev-1.13-20260917');
  // t1..t3 offen, t4 done -> 3 Tasks; Standard nur Claude: je Task model + langer_kontext + effort fuer opus, sonnet
  const erwartet = [];
  for (let i = 0; i < 3; i++) {
    erwartet.push(`model_${i}`, `langer_kontext_${i}`, `effort_${i}_opus`, `effort_${i}_sonnet`);
  }
  assert.deepEqual(Object.keys(body.questions).sort(), erwartet.sort());
  assert.deepEqual(keys(body.questions.model_0), CLAUDE);
  assert.equal(r.jev.fragen, 12);
  assert.equal(r.jev.input_tokens, 1234);
  assert.deepEqual(r.empfehlungen.map((e) => e.task_id), ['t1', 't2', 't3']);
});

await pruefe('Request: englische Anweisungen je Frage mit Tasknummer, Zustand mit Plan und Tasks', async () => {
  reset();
  await empf('testprojekt', { schreiben: false }, deps());
  const { body } = fetchAufrufe[0];
  for (const [name, frage] of Object.entries(body.questions)) {
    const i = /_(\d+)/.exec(name)[1];
    assert.equal(frage.type, name.startsWith('langer_kontext') ? 'noul' : 'choice', name);
    for (const t of [frage.instructions, ...Object.values(frage.criteria ?? {})]) {
      assert.match(t, /^[\x20-\x7e]+$/, `nicht-ASCII/Englisch: ${t}`);
      assert.doesNotMatch(t, /\b(der|die|das|und|nicht|Aufgabe)\b/, `deutsch: ${t}`);
    }
    assert.match(frage.instructions, new RegExp(`task ${i}\\b`, 'i'), name);
    if (name.startsWith('langer_kontext')) assert.match(frage.instructions, /200k/);
  }
  const zustand = JSON.stringify(body.state);
  assert.ok(zustand.includes('Testplan') && zustand.includes('Variable umbenennen') && zustand.includes('Grosser Umbau'));
  assert.ok(!zustand.includes('schon fertig'), 'erledigte Task gehoert nicht in den Zustand');
});

await pruefe('Request: stakes/previous_attempt je Task nur mit gueltigem Wert im Zustand', async () => {
  reset();
  const r = await empf('testprojekt', { schreiben: false }, deps());
  const t = fetchAufrufe[0].body.state.tasks;
  assert.equal(t[0].stakes, undefined);
  assert.equal(t[1].stakes, 'critical');
  assert.equal(t[1].previous_attempt, 'failed with a smaller model');
  assert.equal(t[2].stakes, undefined, 'ungueltiger Wert "hoch" darf nicht in den Zustand');
  assert.ok(r.hinweise.some((h) => /stakes/.test(h) && /hoch/.test(h)), JSON.stringify(r.hinweise));
});

await pruefe('Request: task_id waehlt einzelne Tasks, JEV_API_URL/JEV_MODELL ueberschreiben', async () => {
  reset();
  process.env.JEV_API_URL = 'https://beispiel.invalid/systemone';
  process.env.JEV_MODELL = 'jev-latest';
  try {
    const r = await empf('testprojekt', { task_ids: ['t3'], schreiben: false }, deps());
    assert.equal(r.success, true, r.message);
    assert.equal(fetchAufrufe[0].url, 'https://beispiel.invalid/systemone');
    assert.equal(fetchAufrufe[0].body.model, 'jev-latest');
    assert.ok(Object.keys(q()).every((k) => /_0($|_)/.test(k)), Object.keys(q()).join(','));
    assert.equal(r.empfehlungen[0].task_id, 't3');
  } finally {
    delete process.env.JEV_API_URL;
    delete process.env.JEV_MODELL;
  }
});

await pruefe('Request: ohne task_id -> klarer Fehler, kein fetch, nichts geschrieben (auch [] und undefined)', async () => {
  for (const ohne of [{}, { task_ids: [] }, { task_ids: undefined }]) {
    reset();
    const r = await jev.empfehleFuerPlan('testprojekt', ohne, deps());
    assert.equal(r.success, false, JSON.stringify(ohne));
    assert.match(r.message, /task_id/);
    assert.match(r.message, /Pflicht/);
    assert.equal(fetchAufrufe.length, 0);
    assert.equal(updates.length, 0);
  }
});

await pruefe('Request: ausdruecklich genannte erledigte Task wird bewertet', async () => {
  reset();
  const r = await empf('testprojekt', { task_ids: ['t4'], schreiben: false }, deps());
  assert.equal(r.success, true, r.message);
  assert.deepEqual(r.empfehlungen.map((e) => e.task_id), ['t4']);
});

await pruefe('Request: mehr als 50 task_id -> Fehler', async () => {
  reset();
  const viele = Array.from({ length: 51 }, (_, i) => `x${i}`);
  const r = await empf('testprojekt', { task_ids: viele }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /hoechstens 50 task_id/);
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('Request: unbekannte task_id -> Fehler, kein fetch', async () => {
  reset();
  const r = await empf('testprojekt', { task_ids: ['gibt-es-nicht'] }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /gibt-es-nicht/);
  assert.equal(fetchAufrufe.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Kandidaten
// ---------------------------------------------------------------------------
await pruefe('Kandidaten: Standard = nur Claude-CLI (anthropic), kein Codex/Gemini/Legacy; abos bleibt waehlbar', () => {
  assert.deepEqual(jev.loeseKandidatenAuf(undefined).map((x) => x.alias).sort(), CLAUDE);
  assert.deepEqual(jev.loeseKandidatenAuf([]).map((x) => x.alias).sort(), CLAUDE);
  assert.deepEqual(jev.loeseKandidatenAuf('abos').map((x) => x.alias).sort(), ABOS);
  assert.equal(core.JEV_STANDARD_KANDIDATEN, 'anthropic');
});

await pruefe('Kandidaten: Gruppen google/codex, Mischung aus Alias und Gruppe, Duplikate einmal', () => {
  assert.ok(jev.loeseKandidatenAuf('google').every((x) => x.familie === 'google'));
  assert.ok(jev.loeseKandidatenAuf(['codex']).every((x) => x.familie === 'codex'));
  const gemischt = jev.loeseKandidatenAuf(['haiku', 'anthropic']).map((x) => x.alias);
  assert.equal(gemischt.filter((a) => a === 'haiku').length, 1);
  assert.ok(gemischt.includes('opus'));
  const alle = jev.loeseKandidatenAuf('alle').map((x) => x.alias);
  assert.ok(alle.some((a) => a.startsWith('gemini')) && alle.includes('gpt-5.6-sol') && alle.includes('opus'));
});

await pruefe('Kandidaten: Unbekanntes -> Fehler mit erlaubten Werten; im Service success:false ohne fetch', async () => {
  assert.throws(() => jev.loeseKandidatenAuf(['opus', 'gpt-99']), (e) => /gpt-99/.test(e.message) && /abos/.test(e.message) && /alle/.test(e.message) && /opus/.test(e.message));
  reset();
  const r = await empf('testprojekt', { kandidaten: 'quatsch' }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /quatsch/);
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('Kandidaten: Codex-Empfehlung ist spawnbar:false, Claude spawnbar:true', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'gpt-5.6-luna', effort: 'xhigh' }, 1: { modell: 'sonnet', effort: 'medium' } });
  const r = await empf('testprojekt', { kandidaten: ['codex', 'sonnet'], schreiben: false }, deps());
  assert.equal(r.success, true, r.message);
  const [e0, e1] = r.empfehlungen.map((e) => e.empfehlung);
  assert.equal(e0.modell, 'gpt-5.6-luna');
  assert.equal(e0.effort, 'xhigh');
  assert.equal(e0.spawnbar, false);
  assert.equal(e1.modell, 'sonnet');
  assert.equal(e1.effort, 'medium');
  assert.equal(e1.spawnbar, true);
  assert.deepEqual(e1.kandidaten, r.kandidaten);
});

// ---------------------------------------------------------------------------
// 3. Stufen und einzige Option
// ---------------------------------------------------------------------------
await pruefe('Stufe: gewertet wird die Stufen-Frage des GEWAEHLTEN Modells', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'sonnet', efforts: { opus: 'low', sonnet: 'max' } } });
  const r = await empf('testprojekt', { kandidaten: ['opus', 'sonnet'], task_ids: ['t1'], schreiben: false }, deps());
  const e = r.empfehlungen[0].empfehlung;
  assert.equal(e.modell, 'sonnet');
  assert.equal(e.effort, 'max');
  assert.equal(e.effort_confidence, 0.9);
});

await pruefe('Stufe: haiku ohne Effort-Frage, Empfehlung effort null (einzige_option)', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'haiku' } });
  const r = await empf('testprojekt', { kandidaten: ['haiku', 'sonnet'], task_ids: ['t1'], schreiben: false }, deps());
  assert.equal(q().effort_0_haiku, undefined);
  const e = r.empfehlungen[0].empfehlung;
  assert.equal(e.modell, 'haiku');
  assert.equal(e.effort, null);
  assert.equal(e.effort_vermerk, 'einzige_option');
});

await pruefe('Stufe: opus-4.6 ohne xhigh (Registry) -> nur medium, keine Frage; opus behaelt xhigh', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'opus-4.6' } });
  const r = await empf('testprojekt', { kandidaten: ['opus-4.6', 'opus'], task_ids: ['t1'], schreiben: false }, deps());
  assert.equal(q().effort_0_opus_4_6, undefined);
  assert.ok(keys(q().effort_0_opus).includes('xhigh'));
  const e = r.empfehlungen[0].empfehlung;
  assert.equal(e.modell, 'opus-4.6');
  assert.equal(e.effort, 'medium');
  assert.equal(e.effort_vermerk, 'einzige_option');
});

await pruefe('Stufe: datengetrieben — ohne xhigh in der Registry keine xhigh-Option fuer opus', async () => {
  reset();
  registry = registry.map((m) => (m.alias === 'opus' ? { ...m, effortStufen: OHNE_XHIGH } : m));
  await empf('testprojekt', { kandidaten: ['opus', 'haiku'], schreiben: false }, deps());
  assert.deepEqual(keys(q().effort_0_opus), ['high', 'low', 'medium']);
});

await pruefe('Einzige Option: ein Kandidat mit einer Stufe -> keine Choice, Confidence 1.0, Vermerk einzige_option', async () => {
  reset();
  const r = await empf('testprojekt', { kandidaten: ['fable'], schreiben: false }, deps());
  assert.deepEqual(Object.keys(q()).sort(), ['langer_kontext_0', 'langer_kontext_1', 'langer_kontext_2']);
  const e = r.empfehlungen[0].empfehlung;
  assert.equal(e.modell, 'fable');
  assert.equal(e.effort, 'high');
  assert.equal(e.confidence, 1);
  assert.equal(e.vermerk, 'einzige_option');
  assert.equal(r.jev.fragen, 3);
});

// ---------------------------------------------------------------------------
// 4. Confidence-Tor und Kontext
// ---------------------------------------------------------------------------
await pruefe('Confidence-Tor: Modell unter 0.5 -> unsicher mit bester_vorschlag, darueber Empfehlung', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'haiku', conf: 0.3 }, 1: { modell: 'sonnet', effort: 'medium', conf: 0.8 } });
  const r = await empf('testprojekt', { schreiben: false }, deps());
  const [e0, e1] = r.empfehlungen.map((e) => e.empfehlung);
  assert.equal(e0.unsicher, true);
  assert.equal(e0.bester_vorschlag.modell, 'haiku');
  assert.equal(e0.confidence, 0.3);
  assert.equal(e0.modell, undefined, 'unsicher darf keine Empfehlung tragen');
  assert.equal(e1.unsicher, undefined);
  assert.equal(e1.modell, 'sonnet');
  assert.equal(e1.effort, 'medium');
  assert.equal(e1.quelle, 'cloud');
  assert.ok(!Number.isNaN(Date.parse(e1.stand)));
});

await pruefe('Confidence-Tor: unsichere Stufe -> Empfehlung bleibt, effort_unsicher markiert', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'opus', effort: 'high', conf: 0.9, effConf: 0.2 } });
  const r = await empf('testprojekt', { task_ids: ['t1'], schreiben: false }, deps());
  const e = r.empfehlungen[0].empfehlung;
  assert.equal(e.modell, 'opus');
  assert.equal(e.effort, 'high');
  assert.equal(e.effort_confidence, 0.2);
  assert.equal(e.effort_unsicher, true);
});

await pruefe('Confidence-Tor: konfigurierbar (Parameter und JEV_CONFIDENCE_TOR)', async () => {
  reset();
  antwortFuer = antworten({ 0: { modell: 'haiku', conf: 0.8 } });
  let r = await empf('testprojekt', { task_ids: ['t1'], confidence_tor: 0.9, schreiben: false }, deps());
  assert.equal(r.empfehlungen[0].empfehlung.unsicher, true);
  reset();
  antwortFuer = antworten({ 0: { modell: 'haiku', conf: 0.8 } });
  process.env.JEV_CONFIDENCE_TOR = '0.85';
  r = await empf('testprojekt', { task_ids: ['t1'], schreiben: false }, deps());
  assert.equal(r.empfehlungen[0].empfehlung.unsicher, true);
  assert.equal(r.confidence_tor, 0.85);
});

await pruefe('Kontext: P(langer Kontext) >= 0.5 -> 1m mit spawn_alias opus[1m], sonst 200k', async () => {
  reset();
  antwortFuer = antworten({ 0: { effort: 'xhigh', p: 0.8 }, 1: { effort: 'medium', p: 0.2 } });
  const r = await empf('testprojekt', { kandidaten: ['opus'], schreiben: false }, deps());
  assert.equal(q().model_0, undefined, 'ein Kandidat: keine Modell-Frage');
  const [e0, e1] = r.empfehlungen.map((e) => e.empfehlung);
  assert.equal(e0.modell, 'opus');
  assert.equal(e0.kontext, '1m');
  assert.equal(e0.spawn_alias, 'opus[1m]');
  assert.equal(e0.effort, 'xhigh');
  assert.equal(e1.kontext, '200k');
  assert.equal(e1.spawn_alias, 'opus');
});

// ---------------------------------------------------------------------------
// 7. wiederverwenden
// ---------------------------------------------------------------------------
await pruefe('wiederverwenden: idle opus[1m]-Spezialist wird fuer opus genannt, busy/200k/andere Familie nicht', async () => {
  reset();
  wrapper = [
    { agentName: 'beschaeftigt', model: 'opus[1m]', status: 'idle', busy: true },
    { agentName: 'klein', model: 'opus', status: 'idle', busy: false },
    { agentName: 'sonett', model: 'sonnet[1m]', status: 'idle', busy: false },
    { agentName: 'opus-kollege', model: 'opus[1m]', status: 'idle', busy: false },
  ];
  antwortFuer = antworten({ 0: { modell: 'opus', effort: 'medium' }, 1: { modell: 'haiku' } });
  const r = await empf('testprojekt', { schreiben: false }, deps());
  const [e0, e1] = r.empfehlungen.map((e) => e.empfehlung);
  assert.equal(e0.wiederverwenden, 'opus-kollege');
  assert.equal(e1.wiederverwenden, null);
});

// ---------------------------------------------------------------------------
// 5b. Timeout / HTTP-Fehler
// ---------------------------------------------------------------------------
await pruefe('Timeout: saubere Meldung, nichts geschrieben, Key nicht im Ergebnis', async () => {
  reset();
  process.env.JEV_TIMEOUT_MS = '50';
  const haengt = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
  const r = await empf('testprojekt', {}, { ...deps(), fetch: haengt });
  assert.equal(r.success, false);
  assert.match(r.message, /Timeout/);
  assert.equal(updates.length, 0);
  assert.ok(!JSON.stringify(r).includes(TEST_KEY));
});

await pruefe('HTTP-Fehler: Status in der Meldung, nichts geschrieben, Key nicht im Ergebnis', async () => {
  reset();
  const kaputt = async () => new Response('{"error":{"message":"Upstream kaputt"}}', { status: 502 });
  const r = await empf('testprojekt', {}, { ...deps(), fetch: kaputt });
  assert.equal(r.success, false);
  assert.match(r.message, /HTTP 502/);
  assert.equal(updates.length, 0);
  assert.ok(!JSON.stringify(r).includes(TEST_KEY));
});

await pruefe('Netzfehler: saubere Meldung', async () => {
  reset();
  const weg = async () => { throw new TypeError('fetch failed'); };
  const r = await empf('testprojekt', {}, { ...deps(), fetch: weg });
  assert.equal(r.success, false);
  assert.match(r.message, /fetch failed/);
});

await pruefe('Kein Plan: saubere Meldung, kein fetch', async () => {
  reset();
  const r = await empf('anderes-projekt', {}, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /Kein Plan/);
  assert.equal(fetchAufrufe.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Schreiben
// ---------------------------------------------------------------------------
await pruefe('Schreiben: nur empfehlung je bewerteter Task, alle anderen Felder und Tasks unveraendert', async () => {
  reset();
  const vorher = structuredClone(planZeile.tasks);
  antwortFuer = antworten({ 0: { modell: 'haiku' }, 1: { modell: 'sonnet', effort: 'medium' }, 2: { modell: 'opus', effort: 'xhigh', p: 0.9 } });
  const r = await empf('testprojekt', {}, deps());
  assert.equal(r.success, true, r.message);
  assert.equal(r.geschrieben, 3);
  assert.equal(updates.length, 1);
  assert.match(updates[0].text, /WHERE id = \$3 AND tasks = \$4::jsonb/);
  const nachher = planZeile.tasks;
  assert.equal(nachher.length, vorher.length);
  for (let i = 0; i < vorher.length; i++) {
    const { empfehlung: _alt, ...restVorher } = vorher[i];
    const { empfehlung: neu, ...restNachher } = nachher[i];
    assert.deepEqual(restNachher, restVorher, `Task ${vorher[i].id} ausserhalb von empfehlung veraendert`);
    if (vorher[i].id === 't4') assert.equal(neu, undefined, 'erledigte Task darf nichts bekommen');
    else assert.equal(neu.quelle, 'cloud');
  }
  assert.equal(nachher[2].empfehlung.modell, 'opus');
  assert.equal(nachher[2].empfehlung.alt, undefined, 'alte Empfehlung wird ersetzt, nicht gemischt');
  assert.equal(qdrantAufrufe.length, 1);
  assert.deepEqual(qdrantAufrufe[0][2], nachher);
});

await pruefe('Schreiben: schreiben:false aendert nichts', async () => {
  reset();
  const vorher = structuredClone(planZeile.tasks);
  const r = await empf('testprojekt', { schreiben: false }, deps());
  assert.equal(r.success, true);
  assert.equal(r.geschrieben, 0);
  assert.equal(updates.length, 0);
  assert.deepEqual(planZeile.tasks, vorher);
  assert.equal(qdrantAufrufe.length, 0);
});

await pruefe('Schreiben: gleichzeitige Aenderung der Tasks -> neu gelesen, fremde Aenderung bleibt erhalten', async () => {
  reset();
  let erstesMal = true;
  const origQuery = pg.Pool.prototype.query;
  pg.Pool.prototype.query = async function (sql, params) {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (erstesMal && /^\s*UPDATE plans/i.test(text)) {
      erstesMal = false;
      planZeile.tasks[1] = { ...planZeile.tasks[1], status: 'done', vonAnderen: true };
    }
    return origQuery.call(this, sql, params);
  };
  try {
    const r = await empf('testprojekt', {}, deps());
    assert.equal(r.success, true, r.message);
    assert.equal(planZeile.tasks[1].vonAnderen, true);
    assert.equal(planZeile.tasks[1].status, 'done');
    assert.equal(planZeile.tasks[1].empfehlung.quelle, 'cloud');
  } finally {
    pg.Pool.prototype.query = origQuery;
  }
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
