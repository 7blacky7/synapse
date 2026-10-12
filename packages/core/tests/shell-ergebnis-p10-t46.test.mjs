/** P10-T46: echte isolierte PG-Spielwiese, Fake-Jev, Antwort-Golden und Latenzgrenze. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 'sol3_t46_' + randomUUID().replaceAll('-', '');
const bootstrap = new pg.Pool({ connectionString: url.href });
await bootstrap.query('CREATE SCHEMA ' + schema);
const tables = ['agent_sessions','wrapper_status','hinweis_gesehen','hinweis_optionen','jev_schalter','jev_budget_stand','jev_aufrufe','jev_optionen','erklaerungen','erklaerung_faelle','erklaerung_ereignisse','projekt_datenbanken','code_files','error_pattern_seen','shell_jobs'];
for (const table of tables) await bootstrap.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING ALL)');
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.href;
Object.assign(process.env, {
  JEV_SCHALTER_CACHE_MS: '0', JEV_OPENROUTER_API_KEY: 'test-only-jev-key',
  FEHLERMUSTER_WARTE_MS: '0', QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
  SYNAPSE_SHELL_ERKLAERUNG_WARTE_MS: '2000',
});
const { getPool, closePool } = await import('../dist/db/client.js');
const { mitShellAusgabe } = await import('../dist/services/shell-maske.js');
const E = await import('../dist/services/erklaerungen.js');
const A = await import('../dist/services/fehlermuster-auslieferung.js');
const pool = getPool(), project = schema, agent = schema + '-agent';
let failures = 0, choice = 'a', confidence = 0.95, delay = 0, captured;
const calls = [];
const fake = async (_url, init) => {
  const body = JSON.parse(init.body); calls.push(body);
  captured = (await pool.query('SELECT * FROM erklaerung_ereignisse ORDER BY id DESC LIMIT 1')).rows[0];
  assert.ok(captured, 'Ereignis vor Jev persistent');
  assert.ok(!JSON.stringify(captured).includes('TOP_SECRET_T46_VALUE'), 'Persistenz vor Jev maskiert');
  assert.ok(!JSON.stringify(body).includes('TOP_SECRET_T46_VALUE'), 'Geheimnis vor Jev maskiert');
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  return new Response(JSON.stringify({ answers: { erklaerung: { choice, confidence } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }), { status: 200 });
};
globalThis.fetch = fake; // kein echter Netzaufruf, auch bei versehentlich fehlender Injection
E._setzeErklaerungDeps({ fetch: fake });
const raw = { success: true, id: 'test-job', status: 'done', exit_code: 0, tail: ['alles gruen'] };
const red = { ...raw, status: 'failed', exit_code: 1, tail: ['FAIL example.test.ts', 'Tests: 1 failed, 2 passed'] };
const call = (data = red, extra = {}) => mitShellAusgabe({ action: 'exec', project, agent_id: agent, command: 'pnpm test', ...extra }, async () => structuredClone(data));
const check = async (name, fn) => { try { await fn(); console.log('OK', name); } catch (e) { failures++; console.error('FAIL', name, e.stack); } };
const reset = async () => {
  await pool.query('DELETE FROM hinweis_gesehen WHERE project=$1', [project]);
  await pool.query('DELETE FROM erklaerung_faelle WHERE project=$1', [project]);
  E._setzeErklaerungDeps({ fetch: fake }); calls.length = 0; choice = 'a'; confidence = 0.95; delay = 0;
  await call(raw); // unveraenderten job_env-Hinweis vor dem jeweiligen Golden verbrauchen
};
const seeds = [];
try {
  await pool.query("INSERT INTO agent_sessions(id,project,model,status,sitzung_seit) VALUES($1,$2,'test-model','active',NOW())", [agent, project]);
  const kinds = ['test_rot','build_fehler','module_not_found','befehl_nicht_gefunden','zeitlimit'];
  seeds.push(...kinds.map(() => randomUUID()));
  await pool.query("INSERT INTO erklaerungen(id,kennung,familie,schluessel,lage_de,wieso_de,abhilfe_de,lage_en,wieso_en,abhilfe_en,status) SELECT id,kennung,familie,schluessel,'Fehler erkannt.','Die Ausfuehrung ist fehlgeschlagen.','Ursache klaeren oder als Befund melden.','Failure detected.','Execution failed.','Investigate the cause or report the finding.','verifiziert' FROM unnest($1::uuid[],$2::text[],$3::text[],$4::text[]) AS x(id,kennung,familie,schluessel)",
    [seeds, kinds.map(k => schema + '-' + k), kinds.map(k => 'shell-ergebnis:' + k), kinds.map(k => 'muster|shell-ergebnis:' + k + '|' + k)]);
  await reset();
  await check('Golden gruen exakt unveraendert und kein Jev', async () => {
    const result = await call(raw);
    console.log('GREEN_GOLDEN', JSON.stringify(result));
    assert.deepEqual(result, raw); assert.equal(calls.length, 0);
  });
  await check('roter Test erhaelt direkte Erklaerung', async () => {
    const before = performance.now(), result = await call();
    console.log('RED_LATENCY_MS', performance.now() - before);
    assert.equal(result.shell_hinweis?.erklaerung_id, seeds[0]);
    assert.equal(result.shell_hinweis.text, 'Ursache klaeren oder als Befund melden.');
    const { shell_hinweis, ...rest } = result; assert.deepEqual(rest, red);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].state.agent_modell.modell, 'test-model');
    assert.match(calls[0].questions.erklaerung.criteria.a, /Failure detected/);
    assert.match(calls[0].questions.erklaerung.criteria.keine, /None of/);
    assert.equal(await A.holeFehlermusterHinweise(agent), null, 'kein doppelter Folgehinweis');
  });
  await check('gleiche Familie und parallele Antworten gedrosselt', async () => {
    await reset();
    const results = await Promise.all(Array.from({ length: 6 }, () => call()));
    assert.equal(results.filter(r => r.shell_hinweis).length, 1);
    assert.equal(calls.length, 1);
    assert.equal((await call()).shell_hinweis, undefined);
  });
  await check('alle fuenf Arten plus unbekannt/gruen/laufend', async () => {
    const cases = [
      [red, 'pnpm test', 0],
      [{ ...red, tail: ['src/a.ts(1,1): error TS1005: expected token'] }, 'mise run build', 1],
      [{ ...red, tail: ["Error: Cannot find module 'missing'"] }, 'node app.js', 2],
      [{ ...red, exit_code: 127, tail: ['bash: abc: command not found'] }, 'abc', 3],
      [{ ...red, status: 'timeout', tail: ['Zeitlimit erreicht'] }, 'node app.js', 4],
    ];
    for (const [data, command, index] of cases) {
      await reset(); assert.equal((await call(data, { command })).shell_hinweis?.erklaerung_id, seeds[index]);
    }
    await reset();
    for (const data of [raw, { ...red, status: 'running', exit_code: null }, { ...red, tail: ['anderer Fehler'] }, { ...raw, tail: ['Test example failed in documentation'] }]) assert.deepEqual(await call(data, { command: 'echo anything' }), data);
    assert.equal(calls.length, 0);
  });
  await check('keine passt und unter Tor erzeugen offenen Fall', async () => {
    for (const mode of ['keine', 'unter_tor']) {
      await reset(); if (mode === 'keine') choice = 'keine'; else confidence = 0.2;
      const result = await call(); assert.ok(result.shell_hinweis?.fall_id);
      assert.equal(result.shell_hinweis.erklaerung_id, undefined);
      assert.equal((await pool.query('SELECT count(*) FROM erklaerung_faelle')).rows[0].count, '1');
    }
  });
  await check('Aus-Schalter und Hinweise-aus ohne Jev', async () => {
    await reset();
    await pool.query("INSERT INTO jev_schalter(project,funktion,aktiv) VALUES($1,'erklaerungstopf',false)", [project]);
    assert.deepEqual(await call(), red); assert.equal(calls.length, 0);
    await pool.query('DELETE FROM jev_schalter WHERE project=$1', [project]);
    await pool.query('INSERT INTO hinweis_optionen(project,aktiv) VALUES($1,false)', [project]);
    assert.deepEqual(await call(), red); assert.equal(calls.length, 0);
    await pool.query('DELETE FROM hinweis_optionen WHERE project=$1', [project]);
  });
  await check('Maskierung vor Jev auch bei rotem Kommando', async () => {
    await reset(); process.env.T46_API_TOKEN = 'TOP_SECRET_T46_VALUE';
    await call({ ...red, tail: [...red.tail, 'TOP_SECRET_T46_VALUE'] }, { command: 'pnpm test # TOP_SECRET_T46_VALUE', model: 'forged-model' });
    assert.equal(calls.length, 1); assert.ok(!JSON.stringify(calls[0]).includes('forged-model'));
    const states = await pool.query('SELECT schatten FROM erklaerung_faelle');
    assert.ok(!JSON.stringify(states.rows).includes('TOP_SECRET_T46_VALUE'));
  });
  await check('langsame Auswahl: Grenze und Nachlieferung nur an denselben Agenten', async () => {
    await reset(); process.env.SYNAPSE_SHELL_ERKLAERUNG_WARTE_MS = '40'; delay = 500;
    const start = performance.now(), result = await call(), elapsed = performance.now() - start;
    console.log('SLOW_RED_LATENCY_MS', elapsed);
    assert.deepEqual(result, red); assert.ok(elapsed < 350, 'Antwort wartet nicht auf 500ms Fake-Jev');
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(await A.holeFehlermusterHinweise(agent + '-fremd'), null);
    const pending = await A.holeFehlermusterHinweise(agent);
    assert.equal(pending?.treffer[0]?.erklaerung?.id, seeds[0]);
    assert.equal(await A.holeFehlermusterHinweise(agent), null);
    process.env.SYNAPSE_SHELL_ERKLAERUNG_WARTE_MS = '2000';
  });
  await check('Modell: Registrierung, passender Effort, konfigurierter Name, uneindeutig, unbekannt', async () => {
    const { shellAgentModell } = await import('../dist/services/shell-ergebnis-hinweis.js');
    await pool.query("INSERT INTO wrapper_status(agent_name,project,model,model_full_id,effort,status) VALUES($1,$2,'test-model','test-model-full','high','running')", [agent, project]);
    assert.deepEqual(await shellAgentModell(project, agent), { modell: 'test-model', effort: 'high', quelle: 'registrierung' });
    await pool.query("UPDATE wrapper_status SET model='other-model',model_full_id='other-full' WHERE agent_name=$1", [agent]);
    assert.equal((await shellAgentModell(project, agent)).effort, undefined);
    await pool.query('DELETE FROM wrapper_status WHERE agent_name=$1', [agent]);
    await pool.query('UPDATE agent_sessions SET model=NULL WHERE id=$1', [agent]);
    process.env.SYNAPSE_AGENT_MODELL_ZUORDNUNG = JSON.stringify([{ prefix: schema, modell: 'configured-model', effort: 'medium' }]);
    assert.deepEqual(await shellAgentModell(project, agent), { modell: 'configured-model', effort: 'medium', quelle: 'namenskonfiguration' });
    await reset(); await call(); assert.equal(calls[0].state.agent_modell.modell, 'configured-model');
    process.env.SYNAPSE_AGENT_MODELL_ZUORDNUNG = JSON.stringify([{ prefix: schema, modell: 'a' }, { prefix: 'sol3_', modell: 'b' }]);
    assert.equal(await shellAgentModell(project, agent), undefined);
    delete process.env.SYNAPSE_AGENT_MODELL_ZUORDNUNG;
    await reset(); await call(); assert.equal(calls[0].state.agent_modell, undefined);
    await pool.query("UPDATE agent_sessions SET model='test-model' WHERE id=$1", [agent]);
  });
  await check('Budget verbraucht: kein Jev, offener Fall', async () => {
    await reset();
    await pool.query('INSERT INTO jev_budget_stand(id,grenze_usd,reset_tag,monat,verbraucht_usd) VALUES(1,0,1,CURRENT_DATE,0)');
    const result = await call(); assert.ok(result.shell_hinweis?.fall_id); assert.equal(calls.length, 0);
    await pool.query('DELETE FROM jev_budget_stand');
  });
  await check('REST-get und stdio liefern identischen Hinweis ohne Logaenderung', async () => {
    await reset();
    const get = await call({ success: true, job: red }, { action: 'get', id: red.id });
    assert.equal(get.shell_hinweis?.erklaerung_id, seeds[0]); assert.deepEqual(get.job, red);
    await reset();
    const wrapped = await call({ content: [{ type: 'text', text: JSON.stringify(red) }] });
    assert.equal(JSON.parse(wrapped.content[0].text).shell_hinweis?.erklaerung_id, seeds[0]);
    await reset();
    const history = { success: true, jobs: [red] };
    assert.deepEqual(await call(history, { action: 'history' }), history); assert.equal(calls.length, 0);
  });
  await check('Neue Sitzung erlaubt Hinweis erneut', async () => {
    await reset(); assert.ok((await call()).shell_hinweis);
    await pool.query("UPDATE agent_sessions SET sitzung_seit=NOW()+interval '1 second' WHERE id=$1", [agent]);
    E._setzeErklaerungDeps({ fetch: fake });
    assert.ok((await call({ ...red, id: 'next-job' })).shell_hinweis);
  });
  await check('Gruener Zusatzpfad ohne Datenbank und ohne messbare Wartezeit', async () => {
    const { ergaenzeShellErgebnisHinweis } = await import('../dist/services/shell-ergebnis-hinweis.js');
    const original = pool.query;
    pool.query = () => { throw new Error('Gruener Zusatzpfad darf PG nicht fragen'); };
    try {
      const start = performance.now();
      for (let i = 0; i < 100; i++) assert.equal(await ergaenzeShellErgebnisHinweis({ action: 'exec', project, agent_id: agent }, raw), raw);
      console.log('GREEN_EXTRA_100_MS', performance.now() - start);
    } finally { pool.query = original; }
  });
  await check('Persistentes Ereignis nachholen: Modellkontext und deutscher Hinweis bleiben', async () => {
    await reset(); await call();
    assert.ok(captured?.schatten?.agent_modell);
    const saved = structuredClone(captured);
    await pool.query('INSERT INTO erklaerung_ereignisse(project,agent_id,datei,familie,schluessel,befund,bezug,schatten) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)',
      [saved.project,saved.agent_id,saved.datei,saved.familie,saved.schluessel,JSON.stringify(saved.befund),JSON.stringify(saved.bezug),JSON.stringify(saved.schatten)]);
    const r = await E.holeErklaerungsEreignisseNach({ fetch: fake });
    assert.equal(r.verarbeitet, 1);
    assert.equal(calls.at(-1).state.agent_modell.modell, 'test-model');
    const pending = await A.holeFehlermusterHinweise(agent);
    assert.equal(pending?.treffer[0]?.erklaerung?.id, seeds[0]);
    assert.match(pending.treffer[0].wie, /Ursache klaeren/);
    assert.equal((await pool.query('SELECT count(*) FROM erklaerung_ereignisse')).rows[0].count, '0');
  });
  await check('Jev-Netzfehler veraendert Shell-Ergebnis nicht und wird offener Fall', async () => {
    await reset();
    E._setzeErklaerungDeps({ fetch: async () => { throw new Error('fake network failure'); } });
    const result = await call();
    assert.ok(result.shell_hinweis?.fall_id);
    const { shell_hinweis, ...rest } = result; assert.deepEqual(rest, red);
  });
  await check('Seed fuer Shell zweisprachig und generisch', async () => {
    const seed = JSON.parse(await readFile(new URL('../data/erklaerungstopf-seed.json', import.meta.url), 'utf8'));
    const entries = seed.eintraege.filter(e => e.familie.startsWith('shell-ergebnis:'));
    assert.equal(entries.length, 5);
    for (const entry of entries) assert.deepEqual(E.pruefeSeedEintrag(entry, ['de','en']), []);
  });
} finally {
  await new Promise(resolve => setTimeout(resolve, 100));
  await E._erklaerungenLeerlauf();
  await closePool();
  await bootstrap.query('DROP SCHEMA ' + schema + ' CASCADE');
  await bootstrap.end();
}
console.log('FAILED', failures);
process.exitCode = failures ? 1 : 0;
