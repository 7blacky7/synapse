/**
 * P8-T30 Fix "nicht-aktive Plaene lassen sich nicht oeffnen": Fastify.inject gegen die lesenden Plan-Routen
 * mit einem Testprojekt mit mehreren Plaenen (aktiv, inaktiv, zurueckgestellt, nur erledigte Tasks).
 * Nur synapse_test, eigenes Testprojekt je Lauf (wird am Ende wieder entfernt).
 * Voraussetzung: core und rest-api dist gebaut.
 *   node packages/rest-api/tests/projekt-plan-routen-p8-t30.test.mjs
 */
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const lade = (...teile) => import(pathToFileURL(join(repo, ...teile)).href);

let dbUrl;
try { dbUrl = new URL(process.env.DATABASE_URL || ''); } catch { throw new Error('ABBRUCH: DATABASE_URL fehlt/ungueltig'); }
if (decodeURIComponent(dbUrl.pathname.replace(/^\//, '')) !== 'synapse_test' || (dbUrl.port || '5432') === '5432') {
  throw new Error('ABBRUCH: erwartet synapse_test auf Port ungleich 5432');
}

const core = await lade('packages', 'core', 'dist', 'index.js');
const { default: Fastify } = await import(pathToFileURL(join(repo, 'packages', 'rest-api', 'node_modules', 'fastify', 'fastify.js')).href);
const { projektPlanRoutes } = await lade('packages', 'rest-api', 'dist', 'routes', 'projekt-plan-routen.js');

const project = 'p8_t30_plaene_' + process.pid + '_' + Date.now();
const pool = core.getPool();
let gruen = 0;
let rot = 0;
const pruefe = async (label, fn) => {
  try { await fn(); gruen++; console.log('OK      ' + label); } catch (e) { rot++; console.error('FEHLER  ' + label + ': ' + (e?.stack || e)); }
};

const app = Fastify();
await app.register(projektPlanRoutes);
await app.ready();
const get = async (url) => {
  const r = await app.inject({ method: 'GET', url: '/api/projects/' + project + url });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

try {
  // Plan A (aktiv, erster Plan), B (inaktiv), C (zurueckgestellt), D (nur erledigte Tasks)
  const a = await core.createPlan(project, 'Plan A aktiv', 'a', ['ziel a'], {});
  const b = await core.createPlan(project, 'Plan B inaktiv', 'b', [], {});
  const c = await core.createPlan(project, 'Plan C zurueckgestellt', 'c', [], {});
  const d = await core.createPlan(project, 'Plan D erledigt', 'd', [], {});
  const tasks = {};
  for (const [plan, anzahl] of [[a, 2], [b, 3], [c, 2], [d, 1]]) {
    tasks[plan.kurz_id] = [];
    for (let i = 0; i < anzahl; i++) {
      tasks[plan.kurz_id].push(await core.addTask(project, 'Task ' + plan.kurz_id + '-' + i, 'Beschreibung ' + i, 'medium', plan.kurz_id));
    }
  }
  await core.updateTask(project, tasks[d.kurz_id][0].id, { status: 'done' }, d.kurz_id);
  await core.zurueckstellePlan(project, c.kurz_id, { tage: 5 }, new Date());
  const plaene = { a, b, c, d };

  await pruefe('Liste zeigt alle vier Plaene mit Kurz-ID, genau einer aktiv', async () => {
    const r = await get('/plaene?alle=true');
    assert.equal(r.status, 200);
    assert.equal(r.body.plaene.length, 4);
    assert.ok(r.body.plaene.every((p) => /^P\d+$/.test(p.kurz_id ?? '')));
    assert.equal(r.body.plaene.filter((p) => p.aktiv).length, 1);
    const snooze = r.body.plaene.find((p) => p.name.startsWith('Plan C'));
    assert.equal(snooze.zurueckgestellt, true);
  });

  for (const [schluessel, plan] of Object.entries(plaene)) {
    await pruefe('plaene/:kurz-ID liefert alle Tasks von Plan ' + schluessel.toUpperCase(), async () => {
      const r = await get('/plaene/' + plan.kurz_id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.plan.kurz_id, plan.kurz_id);
      assert.equal(r.body.plan.tasks.length, tasks[plan.kurz_id].length);
    });
    await pruefe('plaene/:UUID liefert Plan ' + schluessel.toUpperCase(), async () => {
      const r = await get('/plaene/' + plan.id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.plan.tasks.length, tasks[plan.kurz_id].length);
    });
    await pruefe('plan-tasks/:kurz-ID loest Task aus Plan ' + schluessel.toUpperCase() + ' auf (Kurz-ID und UUID)', async () => {
      const t = tasks[plan.kurz_id][0];
      const r1 = await get('/plan-tasks/' + t.kurz_id);
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r1.body.task.id, t.id);
      assert.equal(r1.body.plan.kurz_id, plan.kurz_id);
      const r2 = await get('/plan-tasks/' + t.id);
      assert.equal(r2.status, 200);
      assert.equal(r2.body.task.kurz_id, t.kurz_id);
    });
  }

  await pruefe('unbekannter Plan -> 404 mit Meldung', async () => {
    const r = await get('/plaene/P9999');
    assert.equal(r.status, 404);
    assert.ok(r.body.error.message.length > 0);
  });
} finally {
  await pool.query('DELETE FROM plans WHERE project = $1', [project]).catch(() => undefined);
  await app.close();
  await pool.end().catch(() => undefined);
}

console.log('\nErgebnis: ' + gruen + ' OK, ' + rot + ' Fehler');
process.exit(rot ? 1 : 0);
