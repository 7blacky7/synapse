/**
 * P22-T125: Anzeigestatus aus belegter Ende-Ursache, Laufgeneration, 'du selbst'. Rein, ohne DB.
 *   pnpm --filter @synapse/core build && node --test packages/core/tests/wrapper-status-ursache-p22-t125.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const m = await import(pathToFileURL(join(repo, 'packages/core/dist/services/runtime-agenten-uebersicht.js')).href);

const jetzt = Date.parse('2026-10-24T16:00:00Z');
const row = (x = {}) => ({ identityId: 'id-t107', agentName: 'koordinator-test-t107', project: 'synapse', wrapperPid: 1067, innerPid: 1070,
  socketPath: '/root/.synapse/agent-runs/x.sock', model: 'opus', modelFullId: null, provider: 'anthropic', status: 'crashed', busy: false,
  currentTask: null, contextCeiling: 1_000_000, tokensInput: 0, tokensOutput: 0, tokensPercent: 0, channels: [], connectedMcp: false,
  lastActivity: new Date(jetzt - 60_000), lastActivityExakt: new Date(jetzt - 60_000).toISOString(), heartbeatEnabled: true, heartbeatIntervalMs: null, effort: null,
  beendetUrsache: 'container_restart', beendetErkanntAm: new Date(jetzt - 30_000),
  beendetDetails: { wrapper_pid: 1067, letztes_lebenszeichen: new Date(jetzt - 60_000).toISOString(), ereignis: { id: '189' } }, ...x });

test('(1) belegter container_restart -> beendet_durch_neustart', () => {
  const a = m.wrapperEndeAnzeige(row());
  assert.equal(a.anzeige_status, 'beendet_durch_neustart');
  assert.equal(a.beendet.ursache, 'container_restart'); assert.equal(a.beendet.ereignis_id, '189');
  assert.equal(m.wrapperEndeAnzeige(row({ beendetUrsache: 'container_start' })).anzeige_status, 'beendet_durch_neustart');
});

test('(1) prozess_weg bzw. ohne Beleg -> crashed; stopped bleibt gestoppt', () => {
  assert.equal(m.wrapperEndeAnzeige(row({ beendetUrsache: 'prozess_weg' })).anzeige_status, 'crashed');
  assert.equal(m.wrapperEndeAnzeige(row({ beendetUrsache: null, beendetDetails: null })).anzeige_status, 'crashed');
  assert.equal(m.wrapperEndeAnzeige(row({ status: 'stopped' })).anzeige_status, 'stopped');
});

test('(2) Befund des Vorlaufs gilt nicht fuer den neuen Lauf', () => {
  const idle = m.wrapperEndeAnzeige(row({ status: 'idle' }));
  assert.equal(idle.anzeige_status, 'idle'); assert.equal(idle.beendet, null); assert.equal(idle.veraltet_verworfen, true);
  const neuePid = m.wrapperEndeAnzeige(row({ wrapperPid: 2000 }));
  assert.equal(neuePid.anzeige_status, 'crashed'); assert.equal(neuePid.beendet, null); assert.equal(neuePid.veraltet_verworfen, true);
  // R2 (rea4 27659184): Altbefund ohne Lebenszeichen ist KEINE belegte Ursache des (neuen) Laufs
  const alt = m.wrapperEndeAnzeige(row({ beendetDetails: {} }));
  assert.equal(alt.anzeige_status, 'crashed'); assert.equal(alt.beendet, null); assert.equal(alt.veraltet_verworfen, true);
  // R2: neuer Lauf mit WIEDERVERWENDETER PID, lief nach der Erkennung (last_activity neuer) und ist jetzt crashed -> Altbefund verworfen
  const neu = m.wrapperEndeAnzeige(row({ lastActivity: new Date(jetzt - 5_000), lastActivityExakt: new Date(jetzt - 5_000).toISOString() }));
  assert.equal(neu.anzeige_status, 'crashed'); assert.equal(neu.beendet, null); assert.equal(neu.veraltet_verworfen, true);
  // R2b (rea4 53a0593a): neue Generation mit gleicher PID 307 ms spaeter -> erbt die alte Ursache NICHT
  const ll = new Date(jetzt - 60_000);
  const g307 = m.wrapperEndeAnzeige(row({ lastActivity: new Date(ll.getTime() + 307), lastActivityExakt: new Date(ll.getTime() + 307).toISOString(), beendetErkanntAm: new Date(ll.getTime() + 600) }));
  assert.equal(g307.anzeige_status, 'crashed'); assert.equal(g307.beendet, null); assert.equal(g307.veraltet_verworfen, true);
  // auch 1 ms Abweichung reicht zum Verwerfen
  assert.equal(m.wrapperEndeAnzeige(row({ lastActivity: new Date(ll.getTime() + 1), lastActivityExakt: new Date(ll.getTime() + 1).toISOString() })).beendet, null);
  // ohne PID im Befund kein Beleg
  assert.equal(m.wrapperEndeAnzeige(row({ beendetDetails: { letztes_lebenszeichen: ll.toISOString() } })).beendet, null);
  // R2: Befund ohne Erkennungszeit -> nicht gebunden
  assert.equal(m.wrapperEndeAnzeige(row({ beendetErkanntAm: null })).beendet, null);
});

test('Uebersicht: Schalter AUS = Altverhalten (keine neuen Felder)', () => {
  const u = m.baueRuntimeUebersicht([row()], { jetzt, veraltetMs: 600_000, selbst_identity_id: 'id-t107' });
  const e = Object.values(u.orte)[0][0];
  assert.equal(e.status, 'crashed'); assert.equal(e.anzeige_status, undefined); assert.equal(e.du_selbst, undefined);
  assert.ok(e.warnungen.includes('crashed'));
});

test('R1: eigene Zeile aus anderem Projekt wird ebenfalls als du_selbst markiert', () => {
  // leseRuntimeUebersicht laedt die eigene Zeile nach; baueRuntimeUebersicht markiert sie unabhaengig vom Projekt der Zeile.
  const main = row({ identityId: 'id-main', agentName: 'hauptagent', project: 'synapse-hauptagent', status: 'idle', beendetUrsache: null, beendetDetails: null });
  const u = m.baueRuntimeUebersicht([row({ identityId: 'id-x' }), main], { jetzt, veraltetMs: 600_000, ursache: true, selbst_identity_id: 'id-main' });
  const alle = Object.values(u.orte).flat();
  assert.equal(alle.find(z => z.identity_id === 'id-main').du_selbst, true);
  assert.equal(alle.find(z => z.identity_id === 'id-x').du_selbst, false);
});

test('Uebersicht: Schalter EIN -> anzeige_status, Warnung, du_selbst nur fuer eigene identity_id', () => {
  const u = m.baueRuntimeUebersicht([row(), row({ identityId: 'id-andere', agentName: 'x', status: 'idle', beendetUrsache: null, beendetDetails: null })],
    { jetzt, veraltetMs: 600_000, ursache: true, selbst_identity_id: 'id-t107' });
  const alle = Object.values(u.orte).flat();
  const ich = alle.find(z => z.identity_id === 'id-t107'), andere = alle.find(z => z.identity_id === 'id-andere');
  assert.equal(ich.status, 'crashed', 'DB-Status bleibt fuer Altleser');
  assert.equal(ich.anzeige_status, 'beendet_durch_neustart');
  assert.ok(ich.warnungen.includes('beendet_durch_neustart') && !ich.warnungen.includes('crashed'));
  assert.equal(ich.du_selbst, true); assert.equal(andere.du_selbst, false);
  assert.equal(m.WRAPPER_STATUS_URSACHE_FUNKTION, 'wrapper_status_ursache');
});

test('R2c: fehlender PG-Text und alte ISO-Belege werden ohne Millisekunden-Fallback verworfen', () => {
  for (const r of [
    row({ lastActivityExakt: null }),
    row({ lastActivityExakt: undefined }),
    row({ beendetErkanntAm: new Date(jetzt - 60_001) }),
    row({ lastActivity: new Date(NaN) }),
    row({ lastActivityExakt: '2026-10-24 15:59:00+00' }),
  ]) {
    const a = m.wrapperEndeAnzeige(r);
    assert.equal(a.anzeige_status, 'crashed'); assert.equal(a.beendet, null); assert.equal(a.veraltet_verworfen, true);
  }
});

test('R2c PG: Mikrosekunden bleiben beim Lesen und Vermerken erhalten; gleiche ms sind keine gleiche Generation', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(pathToFileURL(join(repo, 'packages/core/package.json')));
  const { Pool } = require('pg');
  const u = new URL(process.env.DATABASE_URL);
  assert.equal(u.pathname, '/synapse_test'); assert.equal(u.port, '5433');
  const admin = new Pool({ connectionString: u.href });
  const schema = 't125_r2c_' + process.pid + '_' + Date.now();
  const vorher = { url: process.env.DATABASE_URL, modus: process.env.SYNAPSE_AGENT_BEZUG_MODUS, intern: process.env.SYNAPSE_INTERN_TOOL };
  let core;
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    for (const t of ['wrapper_status', 'agent_identitaet_wrapper_status']) {
      await admin.query('CREATE TABLE ' + schema + '.' + t + ' (LIKE public.' + t + ' INCLUDING ALL)');
    }
    u.searchParams.set('options', '-c search_path=' + schema + ',public');
    process.env.DATABASE_URL = u.href;
    process.env.SYNAPSE_AGENT_BEZUG_MODUS = 'beide'; process.env.SYNAPSE_INTERN_TOOL = '0';
    core = await import(pathToFileURL(join(repo, 'packages/core/dist/index.js')).href);
    const p = core.getPool(), project = 't125-r2c';
    const alt = '2026-10-24T18:00:00.123456Z', neu = '2026-10-24T18:00:00.123789Z';
    const raw = (await p.query('SELECT $1::timestamptz::text AS alt, $2::timestamptz::text AS neu, $1::timestamptz <> $2::timestamptz AS verschieden', [alt, neu])).rows[0];
    assert.equal(raw.verschieden, true); assert.notEqual(raw.alt, raw.neu);
    assert.equal(new Date(alt).getTime(), new Date(neu).getTime(), 'Gegenprobe unterscheidet ausschliesslich Mikrosekunden');
    for (const identity of [false, true]) {
      const name = identity ? 'identity-r2c' : 'legacy-r2c';
      const t = identity ? 'agent_identitaet_wrapper_status' : 'wrapper_status';
      const ziel = identity ? { art: 'identity', identity_id: name, agent_id: name, project } : { art: 'legacy', agent_id: name, project };
      await p.query('INSERT INTO ' + t + ' (' + (identity ? 'identity_id,' : '') +
        'agent_name,project,wrapper_pid,status,last_activity,socket_path) VALUES (' +
        (identity ? '$1,' : '') + "$1,$2,100,'crashed',$3::timestamptz,'/tmp/r2c.sock')", [name, project, alt]);
      const read = () => core.getWrapperStatus(ziel, project);
      assert.equal((await read()).lastActivityExakt, raw.alt);
      const vermerkt = await core.vermerkeWrapperEnde({ identity_id: identity ? name : null, project, agent_name: name,
        wrapper_pid: 100, last_activity: raw.alt, quelle: 'test-r2c' });
      assert.equal(vermerkt.geschrieben, true);
      const belegt = await read();
      assert.equal(belegt.beendetDetails.letztes_lebenszeichen, raw.alt, 'echter Schreibpfad speichert PG-Text statt ISO');
      assert.equal(core.wrapperEndeAnzeige(belegt).veraltet_verworfen, false);
      await p.query('UPDATE ' + t + " SET beendet_ursache='container_restart', beendet_details=beendet_details || $3::jsonb WHERE agent_name=$1 AND project=$2",
        [name, project, JSON.stringify({ ereignis: { id: 'r2c-exakt' } })]);
      assert.equal(core.wrapperEndeAnzeige(await read()).anzeige_status, 'beendet_durch_neustart');
      await p.query('UPDATE ' + t + ' SET last_activity=$3::timestamptz WHERE agent_name=$1 AND project=$2', [name, project, neu]);
      const nachher = await read();
      assert.equal(nachher.lastActivityExakt, raw.neu);
      assert.equal(nachher.lastActivity.getTime(), belegt.lastActivity.getTime());
      const a = core.wrapperEndeAnzeige(nachher);
      assert.equal(a.anzeige_status, 'crashed'); assert.equal(a.beendet, null); assert.equal(a.veraltet_verworfen, true);
      // Der bisherige 307-ms-Fall bleibt eine echte Differenz zwischen zwei lesbaren PG-Generationen.
      await p.query('UPDATE ' + t + " SET last_activity=$3::timestamptz + interval '307 milliseconds' WHERE agent_name=$1 AND project=$2", [name, project, alt]);
      assert.equal(core.wrapperEndeAnzeige(await read()).veraltet_verworfen, true);
    }
  } finally {
    if (core) await core.closePool();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
    for (const [k, v] of Object.entries({ DATABASE_URL: vorher.url, SYNAPSE_AGENT_BEZUG_MODUS: vorher.modus, SYNAPSE_INTERN_TOOL: vorher.intern })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

