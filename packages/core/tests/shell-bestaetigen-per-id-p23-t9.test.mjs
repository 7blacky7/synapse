/**
 * P23-T9: Shell-Rueckfrage nur per ID bestaetigen. Der Aufruf liegt zur bestaetigung_id gespeichert,
 * shell(action:"bestaetigen", id, grund) fuehrt ihn aus, ohne den Befehl erneut zu senden.
 * Teil A rein (Huelle mit REST- und stdio-Antwortform), Teil B echter stdio-Pfad gegen synapse_test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mitShellAufrufPerId,gemerkteShellAufrufe,leereGemerkteShellAufrufe} from '../dist/services/shell-aufruf-per-id.js';
import {leereShellRueckfragen} from '../dist/services/shell-rueckfrage.js';
import {createTestFixtureCleanup} from './_helfer/test-fixture-cleanup.mjs';

const hier = path.dirname(fileURLToPath(import.meta.url));
let ok = 0;
const pass = (name) => { ok++; console.log('OK', name); };
const GRUND = 'Testlauf bewusst bestaetigt (P23-T9)';

// ── Teil A: Huelle ohne DB ───────────────────────────────────────────────────
{
  const aufrufe = [];
  let n = 0;
  // Spielt pruefeShellStart nach: ohne bestaetigung Rueckfrage, mit 'drift' im Grund neue Rueckfrage, sonst ausgefuehrt.
  const lauf = async (a) => {
    aufrufe.push(a);
    if (!a.bestaetigung || a.bestaetigung.grund.includes('drift'))
      return {success: false, status: 'rejected', stufe: 'rueckfrage', error: a.bestaetigung ? 'bestaetigung_veraltet' : 'shell_rueckfrage',
        bestaetigung_id: 'abcdef' + String(++n).padStart(4, '0'), gueltig_bis: 'z'};
    return {success: true, status: 'done', bekam: a};
  };
  const basis = {action: 'exec', project: 'owned-p23t9', command: 'rm -rf ./x', cwd_relative: 'sub', target: 'local', workspace: 'main', shell: 'bash', agent_id: 'sol-2'};
  const r = await mitShellAufrufPerId(basis, lauf);
  assert.equal(r.stufe, 'rueckfrage');
  assert.ok(r.bestaetigen.includes(`shell(action:"bestaetigen", id:"${r.bestaetigung_id}"`), r.bestaetigen);
  assert.equal(gemerkteShellAufrufe(), 1);
  pass('Rueckfrage: Aufruf gemerkt, Antwort nennt den kurzen Bestaetigungsaufruf');

  const fremd = await mitShellAufrufPerId({action: 'bestaetigen', id: r.bestaetigung_id, grund: GRUND, agent_id: 'sol-3'}, lauf);
  assert.equal(fremd.error, 'bestaetigung_fremder_agent');
  assert.equal(aufrufe.length, 1, 'fremder Agent fuehrt nichts aus');
  const kurz = await mitShellAufrufPerId({action: 'bestaetigen', id: r.bestaetigung_id, grund: 'kurz', agent_id: 'sol-2'}, lauf);
  assert.equal(kurz.error, 'bestaetigung_ungueltig');
  assert.equal(aufrufe.length, 1);
  pass('fremder Agent und zu kurzer Grund: abgewiesen, nichts ausgefuehrt, Aufruf bleibt gemerkt');

  const ja = await mitShellAufrufPerId({action: 'bestaetigen', id: r.bestaetigung_id.toUpperCase(), grund: GRUND, agent_id: 'sol-2'}, lauf);
  assert.equal(ja.status, 'done', JSON.stringify(ja));
  const {bestaetigung, ...rest} = ja.bekam;
  assert.deepEqual(rest, basis, 'gespeicherter Aufruf vollstaendig (command, cwd, target, workspace, shell)');
  assert.deepEqual(bestaetigung, {id: r.bestaetigung_id, grund: GRUND});
  const nochmal = await mitShellAufrufPerId({action: 'bestaetigen', id: r.bestaetigung_id, grund: GRUND, agent_id: 'sol-2'}, lauf);
  assert.equal(nochmal.error, 'bestaetigung_unbekannt');
  pass('bestaetigen + id + grund fuehrt den gespeicherten Aufruf aus, ID einmalig');

  const r2 = await mitShellAufrufPerId(basis, lauf);
  const ja2 = await mitShellAufrufPerId({project: 'owned-p23t9', agent_id: 'sol-2', bestaetigung: {id: r2.bestaetigung_id, grund: GRUND}}, lauf);
  assert.equal(ja2.bekam.command, 'rm -rf ./x');
  pass('exec nur mit bestaetigung (ohne command) fuehrt den gespeicherten Aufruf aus');

  const r3 = await mitShellAufrufPerId(basis, lauf);
  const drift = await mitShellAufrufPerId({action: 'bestaetigen', id: r3.bestaetigung_id, grund: 'drift: Lage geaendert', agent_id: 'sol-2'}, lauf);
  assert.equal(drift.stufe, 'rueckfrage');
  assert.notEqual(drift.bestaetigung_id, r3.bestaetigung_id);
  const nachDrift = await mitShellAufrufPerId({action: 'bestaetigen', id: drift.bestaetigung_id, grund: GRUND, agent_id: 'sol-2'}, lauf);
  assert.equal(nachDrift.bekam.command, 'rm -rf ./x');
  pass('Drift: neue Rueckfrage mit neuer ID, auch sie per ID bestaetigbar');

  const r4 = await mitShellAufrufPerId(basis, lauf);
  const alt = await mitShellAufrufPerId({...basis, bestaetigung: {id: r4.bestaetigung_id, grund: GRUND}}, lauf);
  assert.equal(alt.status, 'done');
  assert.equal((await mitShellAufrufPerId({action: 'bestaetigen', id: r4.bestaetigung_id, grund: GRUND, agent_id: 'sol-2'}, lauf)).error, 'bestaetigung_unbekannt');
  pass('alter Weg (Befehl erneut mit bestaetigung) bleibt und verbraucht die gemerkte Fassung');

  const laufText = async (a) => ({content: [{type: 'text', text: JSON.stringify(await lauf(a))}]});
  const t = JSON.parse((await mitShellAufrufPerId(basis, laufText)).content[0].text);
  assert.ok(t.bestaetigen.includes(t.bestaetigung_id));
  const tja = JSON.parse((await mitShellAufrufPerId({action: 'bestaetigen', id: t.bestaetigung_id, grund: GRUND, agent_id: 'sol-2'}, laufText)).content[0].text);
  assert.equal(tja.status, 'done');
  pass('stdio-Antwortform ({content:[{text}]}) gleich behandelt');

  const schlank = async (a) => ({...(await lauf(a)), bestaetigen: 'schlank mit detail:"full"'});
  const s = await mitShellAufrufPerId(basis, schlank);
  assert.equal(s.bestaetigen, 'schlank mit detail:"full"', 'schlanke Antwort behaelt ihren Hinweis');
  assert.equal((await mitShellAufrufPerId({action: 'bestaetigen', id: s.bestaetigung_id, grund: GRUND, agent_id: 'sol-2'}, lauf)).status, 'done');
  pass('schlanke Rueckfrage (P23-T3): gemerkt, Hinweistext bleibt');

  leereGemerkteShellAufrufe();
  const alteFrist = process.env.SYNAPSE_SHELL_RUECKFRAGE_SEK;
  process.env.SYNAPSE_SHELL_RUECKFRAGE_SEK = '0.2';
  const bald = await mitShellAufrufPerId(basis, lauf);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(gemerkteShellAufrufe(), 0, 'abgelaufen ohne Spur');
  const vorher = aufrufe.length;
  assert.equal((await mitShellAufrufPerId({action: 'bestaetigen', id: bald.bestaetigung_id, grund: GRUND, agent_id: 'sol-2'}, lauf)).error, 'bestaetigung_unbekannt');
  assert.equal(aufrufe.length, vorher);
  if (alteFrist === undefined) delete process.env.SYNAPSE_SHELL_RUECKFRAGE_SEK; else process.env.SYNAPSE_SHELL_RUECKFRAGE_SEK = alteFrist;
  leereGemerkteShellAufrufe();
  pass('Frist: nach Ablauf verworfen, keine Ausfuehrung');
}

// ── Teil B: echter stdio-Pfad gegen synapse_test ─────────────────────────────
const u = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(u.port, '5433');
assert.equal(u.pathname, '/synapse_test');
const cleanup = createTestFixtureCleanup();
const oldFetch = globalThis.fetch;
const projekt = 'test-p23t9-' + randomUUID();
const {getPool, closePool} = await import('../dist/db/client.js');
try {
  const pool = getPool();
  await pool.query(fs.readFileSync(path.join(hier, '../src/db/schema-sql/62_shell_demaskierungen.sql'), 'utf8'));
  const {shellTool} = await import('../../mcp-server/dist/tools/consolidated/shell.js');
  const pRoot = await cleanup.createRoot('synapse-p23t9-');
  cleanup.trackProject(projekt);
  const GEHEIM = 'supergeheimwert' + randomUUID().replace(/-/g, '').slice(0, 12);
  fs.writeFileSync(path.join(pRoot, '.env'), 'API_TOKEN=' + GEHEIM + '\n');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [projekt, 'test', pRoot]);
  globalThis.fetch = async () => new Response('{"enabled":true}', {status: 200});
  const call = async (args) => JSON.parse((await shellTool.handler({agent_id: 'sol-2', ...args})).content[0].text);
  const job = async (id) => (await pool.query('SELECT * FROM shell_jobs WHERE id=$1', [id])).rows[0];

  // B1: gefaehrlicher Befehl -> Rueckfrage; Bestaetigung nur per ID + Grund fuehrt aus.
  fs.mkdirSync(path.join(pRoot, 'wegdamit'));
  const rf = await call({action: 'exec', project: projekt, target: 'local', command: 'rm -rf ./wegdamit'});
  assert.equal(rf.stufe, 'rueckfrage');
  assert.ok(rf.bestaetigen?.includes(rf.bestaetigung_id), JSON.stringify(rf));
  assert.ok(rf.trotzdem.includes('shell(action:"bestaetigen"'), rf.trotzdem);
  assert.ok(fs.existsSync(path.join(pRoot, 'wegdamit')));
  const fremd = await call({action: 'bestaetigen', id: rf.bestaetigung_id, grund: GRUND, agent_id: 'sol-3'});
  assert.equal(fremd.error, 'bestaetigung_fremder_agent');
  assert.ok(fs.existsSync(path.join(pRoot, 'wegdamit')));
  const ja = await call({action: 'bestaetigen', id: rf.bestaetigung_id, grund: GRUND});
  assert.equal(ja.status, 'done', JSON.stringify(ja));
  assert.ok(!fs.existsSync(path.join(pRoot, 'wegdamit')));
  const jaJob = await job(ja.id);
  assert.equal(jaJob.command, 'rm -rf ./wegdamit');
  assert.equal(jaJob.sicherung.audit.entscheidung, 'bestaetigt');
  assert.equal(jaJob.sicherung.audit.grund, GRUND);
  pass('stdio: Rueckfrage, fremder Agent abgewiesen, bestaetigen per ID fuehrt den gespeicherten Befehl aus, Grund im Audit');

  // B2: exec nur mit bestaetigung (ohne command).
  fs.mkdirSync(path.join(pRoot, 'weg3'));
  const rf3 = await call({action: 'exec', project: projekt, target: 'local', command: 'rm -rf ./weg3'});
  const ja3 = await call({action: 'exec', bestaetigung: {id: rf3.bestaetigung_id, grund: GRUND}});
  assert.equal(ja3.status, 'done', JSON.stringify(ja3));
  assert.ok(!fs.existsSync(path.join(pRoot, 'weg3')));
  pass('stdio: exec nur mit bestaetigung fuehrt aus');

  // B3: Demaskieren exec per ID (mit eigener Frist).
  const dm = await call({action: 'exec', project: projekt, target: 'local', command: 'cat .env', maskierung: false});
  assert.equal(dm.art, 'demaskieren');
  assert.ok(dm.trotzdem.includes('shell(action:"bestaetigen"'), dm.trotzdem);
  const offen = await call({action: 'bestaetigen', bestaetigung: {id: dm.bestaetigung_id, grund: GRUND, frist_stunden: 1}});
  assert.equal(offen.status, 'done', JSON.stringify(offen));
  assert.ok(offen.tail.join('\n').includes(GEHEIM), 'unmaskierte Anzeige');
  const eintrag = (await pool.query('SELECT * FROM shell_demaskierungen WHERE job_id=$1', [offen.id])).rows[0];
  assert.ok(eintrag);
  const fristMs = new Date(eintrag.maskieren_bis).getTime() - Date.now();
  assert.ok(fristMs > 50 * 60_000 && fristMs <= 60 * 60_000 + 5000, 'frist_stunden kommt an');
  pass('stdio: Demaskieren exec per ID, frist_stunden ueber bestaetigung');

  // B4: Demaskieren get per ID.
  const gr = await call({action: 'get', id: offen.id, maskierung: false});
  assert.equal(gr.stufe, 'rueckfrage');
  const gja = await call({action: 'bestaetigen', id: gr.bestaetigung_id, grund: GRUND});
  assert.ok(JSON.stringify(gja).includes(GEHEIM));
  await call({action: 'maskieren', id: offen.id});
  pass('stdio: Demaskieren get per ID');

  // B5: gefaehrlich + demaskiert: zwei kurze Bestaetigungen.
  fs.mkdirSync(path.join(pRoot, 'weg2'));
  fs.writeFileSync(path.join(pRoot, 'weg2', 'x.txt'), GEHEIM);
  const k1 = await call({action: 'exec', project: projekt, target: 'local', command: 'rm -rfv ./weg2', maskierung: false});
  assert.equal(k1.art, 'demaskieren');
  const k2 = await call({action: 'bestaetigen', id: k1.bestaetigung_id, grund: GRUND});
  assert.equal(k2.stufe, 'rueckfrage', JSON.stringify(k2));
  assert.ok(fs.existsSync(path.join(pRoot, 'weg2')));
  const k3 = await call({action: 'bestaetigen', id: k2.bestaetigung_id, grund: GRUND});
  assert.equal(k3.status, 'done', JSON.stringify(k3));
  assert.ok(!fs.existsSync(path.join(pRoot, 'weg2')));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shell_demaskierungen WHERE job_id=$1', [k3.id])).rows[0].n, 1);
  await call({action: 'maskieren', id: k3.id});
  pass('stdio: gefaehrlich + demaskiert mit zwei kurzen Bestaetigungen');

  // B6: alter Weg bleibt.
  fs.mkdirSync(path.join(pRoot, 'weg4'));
  const rf4 = await call({action: 'exec', project: projekt, target: 'local', command: 'rm -rf ./weg4'});
  const alt = await call({action: 'exec', project: projekt, target: 'local', command: 'rm -rf ./weg4', bestaetigung: {id: rf4.bestaetigung_id, grund: GRUND}});
  assert.equal(alt.status, 'done', JSON.stringify(alt));
  assert.ok(!fs.existsSync(path.join(pRoot, 'weg4')));
  pass('stdio: alter Weg (Befehl erneut mit bestaetigung) bleibt kompatibel');

  console.log(`P23-T9: ${ok} Pruefungen gruen.`);
} finally {
  globalThis.fetch = oldFetch;
  leereShellRueckfragen();
  leereGemerkteShellAufrufe();
  try {
    const pool = getPool();
    const {rows} = await pool.query('SELECT stream_id FROM shell_jobs WHERE project=$1 AND stream_id IS NOT NULL', [projekt]);
    for (const row of rows) if (/^[a-zA-Z0-9_-]{1,128}$/.test(row.stream_id)) cleanup.trackStreamId(row.stream_id);
    await pool.query('DELETE FROM shell_jobs WHERE project=$1', [projekt]);
    await pool.query('DELETE FROM tool_calls WHERE project=$1', [projekt]);
    await pool.query('DELETE FROM projects WHERE name=$1', [projekt]);
  } finally {
    await closePool();
    await cleanup.cleanup();
    cleanup.dispose();
  }
}
