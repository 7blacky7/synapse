/** P10-T11: PG-Schreiben überlebt Qdrant-Ausfall; lokale Index-/Modellattrappen. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
const dbUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(dbUrl.port, '5433');
assert.equal(dbUrl.pathname, '/synapse_test');
let offline = true, qdrantErrors = 0;
const collections = new Set(), points = new Map();
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const body = raw ? JSON.parse(raw) : {};
    const reply = result => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({result,status:'ok',time:0})); };
    if (path === '/') return res.end(JSON.stringify({title:'test',version:'1.15.0'}));
    if (path === '/api/tags') return res.end(JSON.stringify({models:[{name:'p10-test',digest:'a'.repeat(64)}]}));
    if (path === '/api/embed') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return res.end(JSON.stringify({embeddings:inputs.map(() => [1,0,0,0])}));
    }
    if (offline) {
      qdrantErrors++;
      res.writeHead(503, {'content-type':'application/json'});
      return res.end(JSON.stringify({status:{error:'P10-T11 geplanter Indexausfall'},time:0}));
    }
    const collection = decodeURIComponent(path.split('/')[2] ?? '');
    collections.add(collection);
    if (req.method === 'PUT' && path.endsWith('/points')) {
      for (const point of body.points) points.set(String(point.id), point);
      return reply({status:'completed',operation_id:1});
    }
    if (req.method === 'GET') {
      res.writeHead(404, {'content-type':'application/json'});
      return res.end(JSON.stringify({status:{error:'Test-Collection muss angelegt werden'},time:0}));
    }
    return reply(true);
  });
});
await new Promise(resolve => fake.listen(0,'127.0.0.1',resolve));
const url = 'http://127.0.0.1:' + fake.address().port;
Object.assign(process.env, {
  QDRANT_URL:url, EMBEDDING_PROVIDER:'ollama', OLLAMA_URL:url, OLLAMA_MODEL:'p10-test',
  EMBEDDING_TARGET_DIM:'4', EMBEDDING_PRAEFIXE:'aus', SYNAPSE_OLLAMA_MODEL_DIGEST:'a'.repeat(64),
});
const {getConfig} = await import('../dist/config.js');
assert.equal(getConfig().qdrant.url, url);
assert.equal(getConfig().embeddings.ollama.url, url);
const {getPool,getHintergrundPool} = await import('../dist/db/client.js');
const pool = getPool(), originalQuery = pool.query.bind(pool);
const project = 'sol-3-write-' + randomUUID();
let failPg = false, pauseReads = 0;
// Nur in diesem Testprozess Hintergrund-Nachtrag pausieren; keine gemeinsamen DB-Schalter ändern.
pool.query = function(sql, values, ...rest) {
  if (typeof sql === 'string' && sql.includes('FROM intern_schalter') && values?.[0] === 'embedding') {
    pauseReads++;
    return Promise.resolve({rows:[{aktiv:true,bis:null,modus:null,grund:'Testprozess',gesetzt_von:'test',gesetzt_am:new Date()}]});
  }
  if (failPg && typeof sql === 'string' && /^INSERT INTO (memories|thoughts|proposals|plans)\b/.test(sql.trim()) && values?.includes(project)) {
    return Promise.reject(new Error('P10-T11 PG-INSERT fehlgeschlagen'));
  }
  return originalQuery(sql, values, ...rest);
};
const memory = await import('../dist/services/memory.js');
const thoughts = await import('../dist/services/thoughts.js');
const proposals = await import('../dist/services/proposals.js');
const plans = await import('../dist/services/plans.js');
const writers = [
  ['memory','memories',() => memory.writeMemory(project,'test','Memory-Inhalt'),memory.embeddeMemoryNach],
  ['thought','thoughts',() => thoughts.addThought(project,'sol-3','Thought-Inhalt'),thoughts.embeddeThoughtNach],
  ['thought_batch','thoughts',() => thoughts.addThoughtsBatch(project,'sol-3',[{content:'Batch eins'},{content:'Batch zwei'}]),thoughts.embeddeThoughtNach],
  ['proposal','proposals',() => proposals.createProposal(project,'test.ts','const ok = true;','Proposal-Inhalt','sol-3'),proposals.embeddeProposalNach],
];
const failures = [], saved = [];
try {
  for (const [label, table, write, backfill] of writers) {
    try {
      const result = await write();
      const entries = result.thoughts ?? [result];
      for (const entry of entries) {
        assert(entry.id);
        const rows = (await pool.query('SELECT id,embedded_at FROM ' + table + ' WHERE project=$1 AND id=$2',[project,entry.id])).rows;
        assert.equal(rows.length,1, label + ' ist wirklich gespeichert');
        assert.equal(rows[0].embedded_at,null, label + ' bleibt nachholbar');
        saved.push({entry,table,backfill});
      }
      console.log('OK PG zuerst trotz Qdrant-Ausfall: ' + label);
    } catch (error) { failures.push(label + ': ' + error.message); }
  }
  const plan = await plans.createPlan(project,'Plan','Plan-Inhalt');
  assert(plan.warning?.includes('Qdrant-Write fehlgeschlagen'), 'Indexfehler des Plans sichtbar');
  assert.equal((await plans.getPlan(project,plan.id)).name,'Plan');
  // Fehler im führenden Speicher müssen weiterhin hart scheitern, nie success=true.
  failPg = true;
  for (const [label,,write] of [...writers,['plan','plans',() => plans.createPlan(project,'Fehlerplan','Test')]]) {
    try { await assert.rejects(write, /P10-T11 PG-INSERT fehlgeschlagen/); }
    catch (error) { failures.push(label + ' PG-Fehler: ' + error.message); }
  }
  failPg = false;
  assert(qdrantErrors > 0, 'Positivkontrolle: Indexausfall wurde wirklich ausgelöst');
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.equal(saved.length,5);
  assert(pauseReads > 0, 'automatischer Hintergrund-Nachtrag gezielt isoliert');
  // Der vorhandene Nachzug muss die entfernte Vorab-Prüfung vollständig ersetzen.
  offline = false;
  for (const {entry,table,backfill} of saved) {
    await backfill(project,entry.id,{priority:'interactive'});
    assert(points.has(String(entry.id)), table + ' im Testindex nachgetragen');
    const row = (await pool.query('SELECT embedded_at FROM ' + table + ' WHERE id=$1',[entry.id])).rows[0];
    assert(row.embedded_at, table + ' nach erfolgreichem Upsert markiert');
  }
  console.log('PASS P10-T11: vier Schreibwege, harte PG-Fehler, Plan-Warnung und fünf Nachträge');
} finally {
  failPg = false;
  for (const table of ['memories','thoughts','proposals','plans']) await originalQuery('DELETE FROM ' + table + ' WHERE project=$1',[project]);
  if (collections.size) await originalQuery('DELETE FROM embedding_collections WHERE collection=ANY($1::text[])',[[...collections]]);
  pool.query = originalQuery;
  await getHintergrundPool().end();
  await pool.end();
  await new Promise(resolve => fake.close(resolve));
}
