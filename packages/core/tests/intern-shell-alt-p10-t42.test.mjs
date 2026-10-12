/**
 * P10-T42 (12.10.2026): intern shell_altbestand_maskieren.
 * ZUSAGEN (nur synapse_test, eigenes Testprojekt, Aufraeumen in finally):
 *   S1 Vorschau zaehlt die betroffenen Zeilen und schreibt nichts.
 *   S2 ausfuehren:true als Agent ohne Koordinator-/User-Rolle -> nicht_erlaubt, nichts geschrieben.
 *   S3 ausfuehren:true als Koordinator: URL-Passwort, Bearer, API_KEY= und sshpass -p sind in fertigen
 *      Jobs und Shell-tool_calls weg (auch im JSONB-tail und in args_preview).
 *   S4 Laufender Job, harmlose Zeile und Nicht-Shell-tool_call bleiben bytegleich.
 *   S5 Zweiter Lauf aendert 0 Zeilen.
 */
import assert from 'node:assert/strict';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(url.port, '5433', 'nur Test-Instanz');

const { getPool, closePool } = await import('../dist/db/client.js');
const { fuehreShellAltAus } = await import('../dist/services/intern-shell-alt.js');

const P = 'test-p10-t42-altmaske-' + Date.now();
const GEHEIM = [
  'Verbinde postgresql://admin:Sup3rGeh31m!x@db.local:5432/app',
  'Authorization: Bearer abcDEF123456ghiJKL7890',
  'API_KEY=sk-test-9f8e7d6c5b4a39281',
  'sshpass -p Wa1dmeister77 ssh root@host',
].join('\n');
const KLAR = ['Sup3rGeh31m', 'abcDEF123456', 'sk-test-9f8e', 'Wa1dmeister77'];
const pool = getPool();

async function lese() {
  const jobs = (await pool.query('SELECT command,status,output,tail::text AS tail FROM shell_jobs WHERE project=$1 ORDER BY command', [P])).rows;
  const calls = (await pool.query('SELECT tool_name,args_preview,result FROM tool_calls WHERE project=$1 ORDER BY tool_name', [P])).rows;
  return { jobs, calls };
}

try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query("INSERT INTO shell_jobs(project,command,status,output,tail) VALUES ($1,'a-fertig','done',$2,$3)", [P, GEHEIM, JSON.stringify(GEHEIM.split('\n'))]);
  await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES ($1,'b-laufend','running',$2)", [P, GEHEIM]);
  await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES ($1,'c-harmlos','done','Build ok, 42 Dateien, Port 5433')", [P]);
  await pool.query("INSERT INTO tool_calls(project,tool_name,args_preview,result) VALUES ($1,'shell',$2,$3)",
    [P, JSON.stringify({ command: 'sshpass -p Wa1dmeister77 ssh x' }), JSON.stringify({ output: GEHEIM })]);
  await pool.query("INSERT INTO tool_calls(project,tool_name,result) VALUES ($1,'memory',$2)", [P, GEHEIM]);
  const vorher = await lese();

  // S1
  const v = await fuehreShellAltAus('shell_altbestand_maskieren', { project: P }, 'koordinator');
  assert.equal(v.success, true, JSON.stringify(v));
  assert.equal(v.modus, 'vorschau');
  assert.equal(v.tabellen.shell_jobs.zu_aendern, 1, 'nur der fertige Job');
  assert.equal(v.tabellen.shell_jobs.laufend, 1, 'laufender Job gezaehlt, nicht geaendert');
  assert.equal(v.tabellen.tool_calls.zu_aendern, 1, 'nur der Shell-tool_call');
  assert.deepEqual(await lese(), vorher, 'Vorschau schreibt nichts');

  // S2
  const n = await fuehreShellAltAus('shell_altbestand_maskieren', { project: P, ausfuehren: true }, 'sol-1');
  assert.equal(n.success, false);
  assert.equal(n.error, 'nicht_erlaubt');
  assert.deepEqual(await lese(), vorher, 'ohne Rolle nichts geschrieben');

  // S3
  const a = await fuehreShellAltAus('shell_altbestand_maskieren', { project: P, ausfuehren: true }, 'koordinator');
  assert.equal(a.success, true, JSON.stringify(a));
  assert.equal(a.tabellen.shell_jobs.geschrieben, 1);
  assert.equal(a.tabellen.tool_calls.geschrieben, 1);
  assert.equal(a.offen_danach, 0);
  const nach = await lese();
  const fertig = nach.jobs.find((j) => j.command === 'a-fertig');
  const shellCall = nach.calls.find((c) => c.tool_name === 'shell');
  const gemaskt = fertig.output + fertig.tail + shellCall.args_preview + shellCall.result;
  for (const s of KLAR) assert.equal(gemaskt.includes(s), false, 'Klartext noch da: ' + s);
  assert.ok(gemaskt.includes('[WERT]'), 'Platzhalter gesetzt');

  // S4
  assert.deepEqual(nach.jobs.find((j) => j.command === 'b-laufend'), vorher.jobs.find((j) => j.command === 'b-laufend'));
  assert.deepEqual(nach.jobs.find((j) => j.command === 'c-harmlos'), vorher.jobs.find((j) => j.command === 'c-harmlos'));
  assert.deepEqual(nach.calls.find((c) => c.tool_name === 'memory'), vorher.calls.find((c) => c.tool_name === 'memory'));

  // S5
  const b = await fuehreShellAltAus('shell_altbestand_maskieren', { project: P, ausfuehren: true }, 'koordinator');
  assert.equal(b.tabellen.shell_jobs.geschrieben + b.tabellen.tool_calls.geschrieben, 0, 'zweiter Lauf aendert nichts');
  assert.deepEqual(await lese(), nach);
  console.log('OK P10-T42 shell_altbestand_maskieren: S1-S5 gruen');
} finally {
  await pool.query('DELETE FROM shell_jobs WHERE project=$1', [P]).catch(() => {});
  await pool.query('DELETE FROM tool_calls WHERE project=$1', [P]).catch(() => {});
  await closePool();
}
