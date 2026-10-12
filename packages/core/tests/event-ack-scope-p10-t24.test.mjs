/** P10-T24: ACK-Scope gegen echte Test-DB; keine Laufzeitdateien im Projekt. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port, '5433');
assert.equal(db.pathname, '/synapse_test');
const {getPool} = await import('../dist/db/client.js');
const E = await import('../dist/services/events.js');
const {mitUserHerkunft} = await import('../dist/services/user-herkunft.js');
const pool = getPool();
const project = 'sol-3-ack-' + randomUUID();
const a = project + '-a', b = project + '-b';
let checks = 0;
const ok = message => console.log('OK ' + (++checks) + ' ' + message);
const emit = (scope, type = 'WORK_STOP') => E.emitEvent(project, type, 'high', scope, a, 'ACK-Scope-Test', true);
const rows = async id => (await pool.query('SELECT agent_id, reaction FROM agent_event_acks WHERE event_id=$1 ORDER BY agent_id', [id])).rows;

try {
  await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$3,'active'),($2,$3,'active')", [a, b, project]);
  const direct = await emit('agent:' + a);
  assert((await E.getPendingEvents(project, a)).some(e => e.id === direct.id));
  assert(!(await E.getPendingEvents(project, b)).some(e => e.id === direct.id));
  const own = await E.acknowledgeEvent(direct.id, a, 'verstanden');
  assert.equal(own.agentId, a);
  assert.equal((await E.acknowledgeEvent(direct.id, a)).reaction, 'verstanden');
  assert.equal((await E.acknowledgeEvent(direct.id, a, 'erledigt')).reaction, 'erledigt');
  assert.deepEqual(await rows(direct.id), [{agent_id: a, reaction: 'erledigt'}]);
  assert(!(await E.getPendingEvents(project, a)).some(e => e.id === direct.id));
  ok('Eigener Scope: ACK, Wiederholung und Reaktion bleiben korrekt');

  const broadcast = await emit('all', 'ANNOUNCEMENT');
  await E.acknowledgeEvent(broadcast.id, a);
  assert((await E.getPendingEvents(project, b)).some(e => e.id === broadcast.id));
  await E.acknowledgeEvent(broadcast.id, b);
  assert.equal((await rows(broadcast.id)).length, 2);
  ok('Broadcast ist von beiden Agenten unabhängig quittierbar');

  const forbidden = await emit('agent:' + a);
  let rejected = false;
  try { await E.acknowledgeEvent(forbidden.id, b, 'fremd'); }
  catch (error) { rejected = true; assert.match(String(error), /nicht gefunden|nicht quittieren/); }
  assert((await E.getPendingEvents(project, a)).some(e => e.id === forbidden.id),
    'Fremder ACK darf das Event für A nicht entfernen');
  console.log('Fremd-ACK: rejected=' + rejected + ', rows=' + (await rows(forbidden.id)).length + ', fuer A weiterhin offen');
  assert.equal(rejected, true, 'Agent B darf agent:A nicht quittieren');
  assert.deepEqual(await rows(forbidden.id), []);
  await E.acknowledgeEvent(forbidden.id, a);
  ok('Fremder Scope verweigert ohne ACK-Zeile; Empfänger kann danach quittieren');

  // Privilegierte Stellvertretung braucht einen Grund und schließt beim Empfänger.
  const proxy = await emit('agent:' + a);
  await assert.rejects(() => E.acknowledgeEvent(proxy.id, 'koordinator'), /Grund|nicht quittieren/);
  await assert.rejects(() => E.acknowledgeEvent(proxy.id, 'koordinator', '   '), /Grund|nicht quittieren/);
  assert.deepEqual(await rows(proxy.id), []);
  const delegated = await E.acknowledgeEvent(proxy.id, 'koordinator', 'vom User erledigt');
  assert.equal(delegated.agentId, a);
  assert.match(delegated.reaction, /stellvertretend.*koordinator.*vom User erledigt/);
  assert(!(await E.getPendingEvents(project, a)).some(e => e.id === proxy.id));
  assert.deepEqual(await rows(proxy.id), [{agent_id: a, reaction: delegated.reaction}]);
  const userEvent = await emit('agent:' + a);
  await assert.rejects(() => E.acknowledgeEvent(userEvent.id, 'user', 'falscher User'), /nicht quittieren/);
  for (const kanal of ['tray', 'web-ui-chat']) {
    const result = await mitUserHerkunft(kanal, () => E.acknowledgeEvent(userEvent.id, 'user', 'im UI erledigt'));
    assert.equal(result.agentId, a);
    assert.match(result.reaction, /stellvertretend.*user.*im UI erledigt/);
  }
  ok('Koordinator und echter User schließen für Empfänger mit Pflichtgrund; bloßer Username abgelehnt');
  const plan = await emit('agent:' + a, 'PLAN_READY');
  await assert.rejects(() => E.acknowledgeEvent(plan.id, b), /nicht gefunden|nicht quittieren/);
  await E.acknowledgeEvent(plan.id, a);
  ok('PLAN_READY schützt aktive fremde Empfänger');

  // Auch ein Alt-ACK aus dem früher ungeschützten Pfad darf nicht aktualisiert werden.
  await pool.query('INSERT INTO agent_event_acks(event_id,agent_id,reaction) VALUES($1,$2,$3)', [plan.id, b, 'alt']);
  const before = (await pool.query('SELECT * FROM agent_event_acks WHERE event_id=$1 AND agent_id=$2', [plan.id, b])).rows;
  await assert.rejects(() => E.acknowledgeEvent(plan.id, b, 'überschrieben'), /nicht gefunden|nicht quittieren/);
  assert.deepEqual((await pool.query('SELECT * FROM agent_event_acks WHERE event_id=$1 AND agent_id=$2', [plan.id, b])).rows, before);
  await assert.rejects(() => E.acknowledgeEvent(-1, a), /nicht gefunden|nicht quittieren/);
  ok('Fremde Alt-ACKs unverändert; unbekannte Event-ID sauber abgelehnt');
  const orphan = await emit('agent:' + a);
  await pool.query("UPDATE agent_sessions SET status='stopped' WHERE id=$1 AND project=$2", [a, project]);
  await assert.rejects(() => E.acknowledgeEvent(orphan.id, b), /Grund|nicht quittieren/);
  const closed = await E.acknowledgeEvent(orphan.id, b, 'Agent abgemeldet');
  assert.equal(closed.agentId, a);
  assert.match(closed.reaction, /stellvertretend/);
  assert(closed.reaction.includes(b));
  assert(closed.reaction.includes('Agent abgemeldet'));
  assert(!(await E.getPendingEvents(project, a)).some(e => e.id === orphan.id));
  await pool.query("UPDATE agent_sessions SET status='active' WHERE id=$1 AND project=$2", [a, project]);
  assert(!(await E.getPendingEvents(project, a)).some(e => e.id === orphan.id), 'Auch nach Rückkehr geschlossen');
  const activeAgain = await emit('agent:' + a);
  await assert.rejects(() => E.acknowledgeEvent(activeAgain.id, b, 'wieder aktiv'), /nicht quittieren/);
  await pool.query('DELETE FROM agent_sessions WHERE id=$1 AND project=$2', [a, project]);
  const unknown = await emit('agent:' + a);
  assert.equal((await E.acknowledgeEvent(unknown.id, b, 'Empfänger unbekannt')).agentId, a);
  assert(!(await E.getPendingEvents(project, a)).some(e => e.id === unknown.id));
  ok('Inaktive/unbekannte Empfänger stellvertretend mit Grund schließbar; Rückkehr öffnet nicht erneut');
  console.log('PASS P10-T24: ' + checks + ' Prüfgruppen');
} finally {
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]);
  await pool.query('DELETE FROM agent_events WHERE project=$1', [project]);
  await pool.query('DELETE FROM agent_sessions WHERE project=$1', [project]);
  await pool.end();
}
