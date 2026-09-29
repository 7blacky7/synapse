#!/usr/bin/env node
// test-shell-channel-unterbrechung.mjs — shell(exec): Warten bei neuer Channel-Nachricht
// unterbrechen (Task b5b5304a).
//
//   1. waitForShellJob (REST-Weg) lauscht zusaetzlich auf synapse_channel. Eine fremde
//      Nachricht in einem Channel, in dem der Agent Mitglied ist, beendet das WARTEN sofort:
//      status 'running', id, tail, unterbrochen_durch, Hinweis
//      "Job laeuft weiter: shell(get|log, id) oder shell(cancel, id)". Der Job wird NICHT
//      abgebrochen (kein UPDATE, kein shell_job_cancel).
//   2. Eigene Posts, fremde Channels ohne Mitgliedschaft und kaputte Payloads unterbrechen nicht.
//   3. Ohne agent_id: altes Verhalten, kein LISTEN auf synapse_channel.
//   4. Job gerade fertig geworden: normales Endergebnis statt 'running'.
//   5. Abloesegrenze und done-Notify funktionieren unveraendert; LISTEN/UNLISTEN/release sauber.
//   6. MCP-stdio-Weg: warteAufChannelNachricht (eigener LISTEN-Client) liefert die Unterbrechung,
//      Abbruch per AbortSignal raeumt auf.
//
// Ohne echte DB: pg.Pool.prototype.query/connect ersetzt, NOTIFY wird vom Test gefeuert.
// Keine Sperren, keine Transaktionen.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-shell-channel-unterbrechung.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';

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
// Fake-DB
// ---------------------------------------------------------------------------
const JOB = '11111111-2222-3333-4444-555555555555';
const DONE_KANAL = `shell_job_done_${JOB.replace(/-/g, '_')}`;
let job;
let mitglieder; // Set "project/channel/agent"
let queries;
let clients;

function reset(status = 'running') {
  job = {
    id: JOB, project: 'p', agent_id: 'agent-a', command: 'pnpm build', status,
    exit_code: null, tail: null, error: null, message: null, stream_id: 'abcdef0123456789',
  };
  mitglieder = new Set(['p/team/agent-a']);
  queries = [];
  clients = [];
}

class FakeClient extends EventEmitter {
  constructor() { super(); this.listens = new Set(); this.released = false; }
  async query(sql, params = []) {
    const text = typeof sql === 'string' ? sql : sql.text;
    queries.push({ via: 'client', text, params });
    let m;
    if ((m = /^\s*LISTEN\s+"?([a-z0-9_]+)"?/i.exec(text))) { this.listens.add(m[1]); return { rows: [] }; }
    if ((m = /^\s*UNLISTEN\s+"?([a-z0-9_]+)"?/i.exec(text))) { this.listens.delete(m[1]); return { rows: [] }; }
    return antwort(text, params);
  }
  release() { this.released = true; }
  /** NOTIFY zustellen, wie pg es tut: nur wenn gelauscht wird */
  notify(channel, payload) {
    if (this.listens.has(channel)) this.emit('notification', { channel, payload });
  }
}

function antwort(text, params) {
  if (/FROM shell_jobs WHERE id = \$1/i.test(text)) return { rows: [structuredClone(job)], rowCount: 1 };
  if (/specialist_channel_members/i.test(text)) {
    const [project, channel, agent] = params;
    const da = mitglieder.has(`${project}/${channel}/${agent}`);
    return { rows: da ? [{ ok: 1 }] : [], rowCount: da ? 1 : 0 };
  }
  if (/shell_job_cancel|UPDATE shell_jobs/i.test(text)) throw new Error('Job darf nicht abgebrochen/geaendert werden');
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
}

pg.Pool.prototype.query = async function (sql, params = []) {
  const text = typeof sql === 'string' ? sql : sql.text;
  queries.push({ via: 'pool', text, params });
  return antwort(text, params);
};
pg.Pool.prototype.connect = async function () {
  const c = new FakeClient();
  clients.push(c);
  return c;
};

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const nachricht = (o) => JSON.stringify({ project: 'p', channel: 'team', sender: 'koordinator', id: 4711, ...o });

const core = await import('../packages/core/dist/index.js');
const { waitForShellJob, warteAufChannelNachricht } = core;

await pruefe('Export: waitForShellJob und warteAufChannelNachricht ueber @synapse/core', () => {
  assert.equal(typeof waitForShellJob, 'function');
  assert.equal(typeof warteAufChannelNachricht, 'function');
  assert.equal(typeof core.SHELL_UNTERBRECHUNG_HINWEIS, 'string');
});

// ---------------------------------------------------------------------------
// 1. Unterbrechung
// ---------------------------------------------------------------------------
await pruefe('REST: fremde Nachricht im Mitglieds-Channel -> sofort status running mit Hinweis, Job laeuft weiter', async () => {
  reset();
  job.tail = ['schritt 1', 'schritt 2'];
  const start = Date.now();
  const p = waitForShellJob(JOB, 5_000, { agentId: 'agent-a' });
  await warte(20);
  const c = clients[0];
  assert.ok(c.listens.has('synapse_channel'), 'LISTEN synapse_channel fehlt');
  assert.ok(c.listens.has(DONE_KANAL), 'LISTEN auf den done-Kanal fehlt');
  c.notify('synapse_channel', nachricht({}));
  const r = await p;
  assert.ok(Date.now() - start < 1_000, `zu langsam: ${Date.now() - start} ms`);
  assert.equal(r.status, 'running');
  assert.equal(r.id, JOB);
  assert.deepEqual(r.tail, ['schritt 1', 'schritt 2']);
  assert.deepEqual(r.unterbrochen_durch, { project: 'p', channel: 'team', sender: 'koordinator', message_id: 4711 });
  assert.match(r.message, /Job laeuft weiter: shell\(get\|log, id\) oder shell\(cancel, id\)/);
  assert.match(r.message, /team/);
  assert.ok(c.released, 'Client nicht freigegeben');
  assert.equal(c.listens.size, 0, `UNLISTEN fehlt: ${[...c.listens].join(',')}`);
  assert.ok(!queries.some((q) => /shell_job_cancel|UPDATE shell_jobs/i.test(q.text)), 'Job wurde angefasst');
});

await pruefe('REST: Mitgliedschaft wird fuer genau diesen Agenten und Channel geprueft', async () => {
  reset();
  const p = waitForShellJob(JOB, 5_000, { agentId: 'agent-a' });
  await warte(20);
  clients[0].notify('synapse_channel', nachricht({}));
  await p;
  const q = queries.find((x) => /specialist_channel_members/i.test(x.text));
  assert.ok(q, 'keine Mitgliedschaftsabfrage');
  assert.deepEqual(q.params, ['p', 'team', 'agent-a']);
});

// ---------------------------------------------------------------------------
// 2. Keine Unterbrechung
// ---------------------------------------------------------------------------
await pruefe('REST: eigener Post, Channel ohne Mitgliedschaft und kaputte Payload unterbrechen NICHT', async () => {
  reset('running');
  const p = waitForShellJob(JOB, 5_000, { agentId: 'agent-a' });
  let fertig = false;
  p.then(() => { fertig = true; });
  await warte(20);
  const c = clients[0];
  c.notify('synapse_channel', nachricht({ sender: 'agent-a' }));
  c.notify('synapse_channel', nachricht({ channel: 'fremd' }));
  c.notify('synapse_channel', 'kein json');
  c.notify('synapse_channel', JSON.stringify({ project: 'p' }));
  await warte(80);
  assert.equal(fertig, false, 'Warten wurde unterbrochen');
  // Kontrolle: der Job endet normal ueber den done-Kanal
  job.status = 'done'; job.exit_code = 0; job.tail = ['fertig'];
  c.notify(DONE_KANAL, 'done');
  const r = await p;
  assert.equal(r.status, 'done');
  assert.equal(r.unterbrochen_durch, undefined);
});

// ---------------------------------------------------------------------------
// 3. Ohne agent_id
// ---------------------------------------------------------------------------
await pruefe('REST: ohne agentId altes Verhalten (kein LISTEN synapse_channel, Aufruf mit zwei Argumenten)', async () => {
  reset();
  const p = waitForShellJob(JOB, 5_000);
  await warte(20);
  const c = clients[0];
  assert.ok(!c.listens.has('synapse_channel'));
  job.status = 'done'; job.exit_code = 0;
  c.notify(DONE_KANAL, 'done');
  const r = await p;
  assert.equal(r.status, 'done');
});

// ---------------------------------------------------------------------------
// 4. Job gerade fertig
// ---------------------------------------------------------------------------
await pruefe('REST: Nachricht kommt, Job ist aber schon fertig -> normales Endergebnis', async () => {
  reset();
  const start = Date.now();
  const p = waitForShellJob(JOB, 5_000, { agentId: 'agent-a' });
  await warte(20);
  job.status = 'failed'; job.exit_code = 2; job.error = 'x';
  clients[0].notify('synapse_channel', nachricht({}));
  const r = await p;
  assert.ok(Date.now() - start < 1_000, `nicht durch die Nachricht beendet (${Date.now() - start} ms)`);
  assert.equal(r.status, 'failed');
  assert.equal(r.exit_code, 2);
});

// ---------------------------------------------------------------------------
// 5. Abloesegrenze unveraendert
// ---------------------------------------------------------------------------
await pruefe('REST: Abloesegrenze ohne Nachricht -> running_background wie bisher, sauber aufgeraeumt', async () => {
  reset();
  const r = await waitForShellJob(JOB, 60, { agentId: 'agent-a' });
  assert.equal(r.status, 'running_background');
  assert.equal(r.unterbrochen_durch, undefined);
  assert.ok(clients[0].released);
  assert.equal(clients[0].listens.size, 0);
});

// ---------------------------------------------------------------------------
// 6. MCP-stdio-Weg
// ---------------------------------------------------------------------------
await pruefe('stdio: warteAufChannelNachricht liefert die erste fremde Mitglieds-Nachricht und raeumt auf', async () => {
  reset();
  const ctrl = new AbortController();
  const p = warteAufChannelNachricht('agent-a', ctrl.signal);
  await warte(20);
  const c = clients[0];
  assert.ok(c.listens.has('synapse_channel'));
  c.notify('synapse_channel', nachricht({ sender: 'agent-a' }));
  c.notify('synapse_channel', nachricht({ channel: 'fremd' }));
  c.notify('synapse_channel', nachricht({ id: 9 }));
  const u = await p;
  assert.deepEqual(u, { project: 'p', channel: 'team', sender: 'koordinator', message_id: 9 });
  await warte(10);
  assert.ok(c.released);
  assert.equal(c.listens.size, 0);
});

await pruefe('stdio: Abbruch per AbortSignal -> null, Client freigegeben', async () => {
  reset();
  const ctrl = new AbortController();
  const p = warteAufChannelNachricht('agent-a', ctrl.signal);
  await warte(20);
  ctrl.abort();
  const u = await p;
  assert.equal(u, null);
  await warte(10);
  assert.ok(clients[0].released);
  assert.equal(clients[0].listens.size, 0);
});

await pruefe('stdio: ohne agentId sofort null, keine Verbindung', async () => {
  reset();
  const u = await warteAufChannelNachricht('', new AbortController().signal);
  assert.equal(u, null);
  assert.equal(clients.length, 0);
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
