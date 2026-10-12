/**
 * P12-T10: Golden-Kontrolle vor dem Umbau. Ausschliesslich synapse_test;
 * Qdrant/Ollama sind lokale HTTP-Attrappen. Kurze Eintraege behalten IDs,
 * Dokumenttexte, Payloads und Suchresultate bytegenau.
 * Aufruf: node packages/core/tests/wissen-stuecke-p12-t10.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dbUrl = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(dbUrl.port, '5433', 'nur Test-Port');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur Test-DB');
const project = 'p12-t10-golden';
const stamp = '2026-01-01T00:00:00.000Z';
const mid = '11111111-1111-4111-8111-111111111111';
const tid = '22222222-2222-4222-8222-222222222222';
const points = new Map();
const embedInputs = [];
const requests = [];
let upserts = 0;
let failUpsertAfter = Infinity;
let duringEmbed;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', async () => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body });
    const reply = result => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ result, status: 'ok', time: 0 })); };
    if (path === '/') return res.end(JSON.stringify({ title: 'test', version: '1.15.0' }));
    if (path === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'p12-test', digest: 'a'.repeat(64) }] }));
    if (path === '/api/embed') {
      const list = Array.isArray(body.input) ? body.input : [body.input];
      embedInputs.push(...list);
      if (duringEmbed) { const fn = duringEmbed; duringEmbed = undefined; await fn(); }
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({ embeddings: list.map(() => [1,0,0,0]) }));
    }
    if (path === '/collections') return reply({ collections: [...points.keys()].map(name => ({ name })) });
    const col = decodeURIComponent(path.split('/')[2] ?? '');
    if (!points.has(col)) points.set(col, new Map());
    const entries = points.get(col);
    if (path.endsWith('/points/count')) return reply({count:entries.size});
    if (path.endsWith('/points/scroll')) return reply({points:[...entries.values()].map(x=>({id:x.id})),next_page_offset:null});
    if (req.method === 'DELETE' && /^\/collections\/[^/]+$/.test(path)) { points.delete(col); return reply(true); }
    if (path.endsWith('/points/search')) {
      const hits = [...entries.values()].map(p => ({ id:p.id, score:p.payload.wissen_stueck ? 0.95 : 0.8, payload:p.payload, version:0 }));
      hits.sort((a,b)=>b.score-a.score);
      return reply(hits.slice(body.offset ?? 0, (body.offset ?? 0) + body.limit));
    }
    if (path.endsWith('/points/delete')) {
      if (body.points) for (const id of body.points) entries.delete(id);
      if (body.filter) for (const [id,p] of entries) {
        if ((body.filter.must ?? []).every(f => f.match?.any ? f.match.any.includes(f.key.split('.').reduce((v,k)=>v?.[k],p.payload)) : f.key.split('.').reduce((v,k)=>v?.[k],p.payload) === f.match?.value)) entries.delete(id);
      }
      return reply({ status:'completed', operation_id:1 });
    }
    if (req.method === 'PUT' && path.endsWith('/points')) {
      if (++upserts > failUpsertAfter) { res.statusCode = 500; return res.end(JSON.stringify({status:{error:'geplanter Test-Ausfall'}})); }
      for (const p of body.points) entries.set(p.id,p);
      return reply({ status:'completed', operation_id:1 });
    }
    if (path.endsWith('/points')) return reply([...entries.values()].filter(p => body.ids?.includes(p.id)));
    return reply({ config: { params: { vectors:{size:4,distance:'Cosine'} } }, points_count:entries.size });
  });
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const fake = 'http://127.0.0.1:' + server.address().port;
Object.assign(process.env, {
  EMBEDDING_PROVIDER:'ollama', OLLAMA_URL:fake, OLLAMA_MODEL:'p12-test',
  EMBEDDING_TARGET_DIM:'4', EMBEDDING_PRAEFIXE:'aus', QDRANT_URL:fake,
  EMBEDDING_MAX_INPUT_CHARS:'100000', SYNAPSE_OLLAMA_MODEL_DIGEST:'a'.repeat(64),
});
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.P12_TEST_DIST ?? join(root,'dist');
const { getConfig } = await import(join(dist,'config.js'));
assert.equal(getConfig().qdrant.url,fake);
assert.equal(getConfig().database.url,process.env.DATABASE_URL);
assert.equal(getConfig().embeddings.ollama.url,fake);
const db = await import(join(dist,'db/client.js'));
const pool = db.getPool();
const memory = await import(join(dist,'services/memory.js'));
const thoughts = await import(join(dist,'services/thoughts.js'));
const nz = await import(join(dist,'services/embed-nachzug.js'));
const globalSearch = await import(join(dist,'services/global-search.js'));
try {
  const ddl = await readFile(join(root,'src/db/schema-sql/21_wissen_stuecke.sql'),'utf8');
  const schema = (await readFile(join(root,'src/db/schema.ts'),'utf8')).replaceAll('\r\n','\n');
  assert.ok(schema.includes(ddl),'eigener DDL-Block und Schema-Mirror stimmen exakt überein');
  await pool.query(ddl);
  await pool.query('DELETE FROM wissen_stueck_status WHERE project=$1 OR eintrag_id=$2',[project,'44444444-4444-4444-8444-444444444444']);
  await pool.query('DELETE FROM tech_docs WHERE id=$1',['44444444-4444-4444-8444-444444444444']);
  await pool.query('DELETE FROM memories WHERE project=$1',[project]);
  await pool.query('DELETE FROM thoughts WHERE project=$1',[project]);
  await pool.query('INSERT INTO memories(id,project,name,category,content,tags,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
    [mid,project,'kurz','note','Kurzer Memory-Inhalt',['golden'],stamp]);
  await pool.query('INSERT INTO thoughts(id,project,source,content,tags,timestamp) VALUES($1,$2,$3,$4,$5,$6)',
    [tid,project,'p12-test','Kurzer Thought-Inhalt',['golden'],stamp]);
  await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});
  await nz.betteStapelEin(thoughts.thoughtNachzug,[tid],{priority:'interactive'});
  const model = 'ollama:p12-test|digest:aaaaaaaaaaaa|dim:4|ohne-dokpraefix';
  const mp = {project,name:'kurz',content:'Kurzer Memory-Inhalt',category:'note',tags:['golden'],linkedPaths:[],createdAt:stamp,updatedAt:stamp,embedding_modell:model};
  const tp = {project,source:'p12-test',content:'Kurzer Thought-Inhalt',tags:['golden'],timestamp:stamp,embedding_modell:model};
  assert.deepEqual([...points.get('project_'+project+'_memories').values()], [{id:mid,vector:[1,0,0,0],payload:mp}]);
  assert.deepEqual([...points.get('project_'+project+'_thoughts').values()], [{id:tid,vector:[1,0,0,0],payload:tp}]);
  assert.deepEqual(embedInputs,['Kurzer Memory-Inhalt','synapse dimension detection','Kurzer Thought-Inhalt']);
  assert.deepEqual(await memory.searchMemories('finden',project,10),[{id:mid,score:0.8,payload:mp}]);
  assert.deepEqual(await thoughts.searchThoughts('finden',project,10),[{id:tid,score:0.8,payload:tp}]);
  const g = await globalSearch.globalSearch('finden',{types:['memories','thoughts'],projectFilter:[project],limit:10,minScore:0});
  assert.deepEqual(g.results,[{id:tid,type:'thoughts',project,score:0.8,content:tp.content,metadata:{type:'thoughts',source:'p12-test',tags:['golden'],timestamp:stamp}},
    {id:mid,type:'memories',project,score:0.8,content:mp.content,metadata:{type:'memories',name:'kurz',category:'note',tags:['golden'],updatedAt:stamp}}]);
  assert.deepEqual(g.counts,{code:0,thoughts:1,memories:1,total:2});
  assert.deepEqual(g.searchedProjects,[project]);
  assert.equal(typeof g.searchTimeMs,'number'); // einzig echte Laufzeit, kein semantisches Ergebnisfeld
  console.error('GOLDEN bestanden: kurze Texte, Punkt-IDs, Payloads, Memory-/Thought-/globale Suchausgaben exakt.');

  if (!process.argv.includes('--golden')) {
    const lang = 'Anfang '.repeat(500) + ' HINTEN: Schattenberechnung mit Tiefentextur ' + ' Ende'.repeat(500);
    await pool.query('UPDATE memories SET content=$1, updated_at=$2, embedded_at=NULL WHERE id=$3',[lang,'2026-01-02T00:00:00Z',mid]);
    await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});
    const stuecke = [...points.get('project_'+project+'_memories').values()].filter(p => p.payload.wissen_stueck?.eintrag_id === mid);
    assert.ok(stuecke.length >= 3, 'RED: langer Eintrag braucht separate persistierte Stückvektoren');
    assert.ok(stuecke.every(p => p.payload.wissen_stueck.inhalt.length <= 2000));
    assert.ok(stuecke.some(p => p.payload.wissen_stueck.inhalt.includes('HINTEN:')));
    const hits = await memory.searchMemories('finden',project,2);
    assert.equal(hits.length,1,'Stuecke ergeben genau einen Eintrag');
    assert.equal(hits[0].id,mid);
    assert.equal(hits[0].payload.content,lang);
    assert.ok(!Object.hasOwn(hits[0].payload,'wissen_stueck'),'Ausgabe bleibt auf Eintragsebene');
    console.error('STUECKE bestanden: getrennte Vektoren, hinterer Inhalt, ein Eintrag.');

    assert.equal(hits[0].score,0.95,'bestes Stück zählt, nicht der Gesamtvektor');
    const marker = await pool.query('SELECT * FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',['memories',mid]);
    assert.equal(marker.rows[0].abgeschlossen,true);
    const gs = await globalSearch.globalSearch('finden',{types:['memories'],projectFilter:[project],limit:2,minScore:0});
    assert.equal(gs.results.length,1);
    assert.equal(gs.results[0].id,mid);
    assert.equal(gs.results[0].score,0.95);

    // Mehr als ein Ergebnis: Stücke von Eintrag A verdrängen Eintrag B nicht.
    const mid2 = '33333333-3333-4333-8333-333333333333';
    await pool.query('INSERT INTO memories(id,project,name,content,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
      [mid2,project,'zweiter','Ein anderer kurzer Eintrag',stamp]);
    await nz.betteEinzelnEin(memory.memoryNachzug,mid2,{priority:'interactive'});
    assert.deepEqual((await memory.searchMemories('finden',project,2)).map(x=>x.id),[mid,mid2]);


    const {bestandAbgleich} = await import(join(dist,'services/intern-diagnose.js'));
    const abgleich = await bestandAbgleich({project,arten:['memories'],idsVergleichen:true,limit:20});
    assert.equal(abgleich.abweichend.anzahl,0,'RED: gültige Stücke sind keine verwaisten Punkte');
    assert.equal(abgleich.id_abgleich[0].verwaist_in_qdrant,0,'PG-Stück-IDs gehören zum erwarteten Index');

    // Eintrags-Update lang -> kurz räumt Zusatzpunkte/PG-Stückstand auf.
    await pool.query('UPDATE memories SET content=$1,updated_at=$2,embedded_at=NULL WHERE id=$3',['Wieder kurz','2026-01-03',mid]);
    await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});
    assert.equal([...points.get('project_'+project+'_memories').values()].filter(p=>p.payload.wissen_stueck).length,0);
    assert.equal((await pool.query('SELECT 1 FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',['memories',mid])).rowCount,0);

    // Bestehender langer Thought: embedded_at war schon gesetzt; Version-Nachzug holt ihn.
    await pool.query('UPDATE thoughts SET content=$1,embedded_at=NOW() WHERE id=$2',[lang,tid]);
    const backlog = await import(join(dist,'services/embed-backlog.js'));
    assert.equal((await backlog.zaehleOffeneEmbeddings(project)).thoughts,1);
    await backlog.embeddeOffeneEintraege(1,project,'thoughts');
    assert.equal((await backlog.zaehleOffeneEmbeddings(project)).thoughts,0);
    assert.equal((await thoughts.searchThoughts('finden',project,2))[0].id,tid);
    assert.equal((await thoughts.searchThoughts('finden',project,2))[0].score,0.95);

    // Versionswechsel wird erkannt, ohne fremde Einträge zu resetten.
    await pool.query("UPDATE wissen_stueck_status SET version='alt' WHERE quelle='thoughts' AND eintrag_id=$1",[tid]);
    assert.equal((await backlog.zaehleOffeneEmbeddings(project)).thoughts,1);
    await backlog.embeddeOffeneEintraege(1,project,'thoughts');
    assert.equal((await backlog.zaehleOffeneEmbeddings(project)).thoughts,0);

    // Mehr als eine Scheibe: Ausfall nach 32 Punkten, Wiederaufnahme rechnet nur offene.
    const gross = 'Wiederaufnahme '.repeat(6000);
    await pool.query('UPDATE memories SET content=$1,updated_at=$2,embedded_at=NULL WHERE id=$3',[gross,'2026-01-04',mid]);
    failUpsertAfter = upserts + 1;
    await assert.rejects(nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'}));
    const z = (await pool.query('SELECT count(*)::int AS n,count(embedded_at)::int AS fertig FROM wissen_stuecke WHERE quelle=$1 AND eintrag_id=$2',['memories',mid])).rows[0];
    assert.ok(z.fertig > 0 && z.fertig < z.n,'echter Teilfortschritt vor dem Abbruch');
    assert.equal((await pool.query('SELECT embedded_at FROM memories WHERE id=$1',[mid])).rows[0].embedded_at,null);
    failUpsertAfter = Infinity;
    const inputsVorher = embedInputs.length;
    await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});
    assert.equal(embedInputs.length-inputsVorher,z.n-z.fertig,'fertige Stücke werden nicht erneut eingebettet');


    // Reset waehrend eines teilweise fertigen Stücklaufs: alte ACKs dürfen
    // nach Collection-Verlust nicht als fertige Vektoren gelten.
    await pool.query('UPDATE memories SET content=$1,updated_at=$2,embedded_at=NULL WHERE id=$3',[gross+' reset','2026-01-04T01:00Z',mid]);
    failUpsertAfter = upserts + 1;
    await assert.rejects(nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'}));
    assert.ok((await pool.query('SELECT count(*)::int AS n FROM wissen_stuecke WHERE quelle=$1 AND eintrag_id=$2 AND embedded_at IS NOT NULL',['memories',mid])).rows[0].n>0);
    failUpsertAfter = Infinity;
    const {neuEinbetten} = await import(join(dist,'services/neu-einbetten.js'));
    await neuEinbetten({ausfuehren:true,arten:['memories']}); // nur Fake-Qdrant + synapse_test
    assert.equal((await pool.query('SELECT 1 FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',['memories',mid])).rowCount,0,
      'Reset verwirft auch den unvollständigen Stückfortschritt');
    const nachReset = embedInputs.length;
    await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});
    const alleReset = (await pool.query('SELECT count(*)::int AS n FROM wissen_stuecke WHERE quelle=$1 AND eintrag_id=$2',['memories',mid])).rows[0].n;
    assert.equal(embedInputs.length-nachReset,alleReset,'nach Reset werden ALLE Stücke wieder eingefügt');

    // Alte Snapshots schreiben nach einer Änderung während des Embeddings NICHT zurück.
    await pool.query('UPDATE memories SET content=$1,updated_at=$2,embedded_at=NULL WHERE id=$3',[lang,'2026-01-05',mid]);
    duringEmbed = () => pool.query('UPDATE memories SET content=$1,updated_at=$2,embedded_at=NULL WHERE id=$3',['Neuer Stand','2026-01-06',mid]);
    const putsVorher = upserts;
    await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});
    assert.equal(upserts,putsVorher,'veralteter Lauf macht keinen Qdrant-Upsert');
    assert.equal((await pool.query('SELECT embedded_at FROM memories WHERE id=$1',[mid])).rows[0].embedded_at,null);
    await nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'});


    // Zwei gleichzeitige Nachträge teilen die Claims, kein Stück wird doppelt gerechnet.
    await pool.query('UPDATE memories SET content=$1,updated_at=$2,embedded_at=NULL WHERE id=$3',[gross+' parallel','2026-01-07',mid]);
    const vorParallel = embedInputs.length;
    await Promise.all([nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'}),
      nz.betteEinzelnEin(memory.memoryNachzug,mid,{priority:'interactive'})]);
    const parallel = (await pool.query('SELECT count(*)::int AS n,count(embedded_at)::int AS fertig,count(claim_token)::int AS claims FROM wissen_stuecke WHERE quelle=$1 AND eintrag_id=$2',['memories',mid])).rows[0];
    assert.equal(embedInputs.length-vorParallel,parallel.n,'kein doppeltes Stück-Embedding zwischen zwei Nachträgen');
    assert.equal(parallel.fertig,parallel.n);
    assert.equal(parallel.claims,0);
    assert.ok((await pool.query('SELECT embedded_at FROM memories WHERE id=$1',[mid])).rows[0].embedded_at);

    // Löschen umfasst Grundvektor, alle Zusatzpunkte und PG-Stücke.
    await memory.deleteMemory(project,'zweiter');
    await thoughts.deleteThought(project,tid);
    assert.equal(points.get('project_'+project+'_thoughts').size,0);
    assert.equal((await pool.query('SELECT 1 FROM wissen_stueck_status WHERE eintrag_id=$1',[tid])).rowCount,0);
    const { teileWissen } = await import(join(dist,'services/wissen-stuecke.js'));
    const unicode = '🙂'.repeat(2100);
    const teile = teileWissen(unicode);
    assert.equal(teile[0] + Array.from(teile[1]).slice(200).join(''),unicode);
    assert.ok(teile.every(x=>Array.from(x).length<=2000),'2000 Unicode-Zeichen, keine geteilten Surrogate');

    // Weitere Text-Collection: globale TechDocs, mit unveränderter kurzer Suchantwort.
    const tech = await import(join(dist,'services/tech-docs.js'));
    const did = '44444444-4444-4444-8444-444444444444';
    await pool.query(`INSERT INTO tech_docs(id,framework,version,section,content,type,category,source,content_hash,indexed_at,project)
      VALUES($1,'p12-test','1','Abschnitt',$2,'feature','framework','context7',$3,$4,NULL)`,
      [did,'Kurzes Doc',createHash('sha256').update('Kurzes Doc').digest('hex'),stamp]);
    await nz.betteEinzelnEin(tech.techDocNachzug,did,{priority:'interactive'});
    assert.deepEqual(await tech.searchTechDocs('finden',{framework:'p12-test',scope:'global',ohneNachladen:true,limit:2}),
      [{id:did,score:0.8,framework:'p12-test',version:'1',section:'Abschnitt',content:'Kurzes Doc',type:'feature',source:'context7'}]);
    await pool.query('UPDATE tech_docs SET content=$1,content_hash=$2,embedded_at=NULL WHERE id=$3',
      [lang,createHash('sha256').update(lang).digest('hex'),did]);
    await nz.betteEinzelnEin(tech.techDocNachzug,did,{priority:'interactive'});
    assert.ok([...points.get('tech_docs_cache').values()].filter(p=>p.payload.wissen_stueck?.eintrag_id===did).length>1,
      'RED weitere Text-Collection: langes TechDoc bekommt Zusatzstücke');
    assert.deepEqual(await tech.searchTechDocs('finden',{framework:'p12-test',scope:'global',ohneNachladen:true,limit:2}),
      [{id:did,score:0.95,framework:'p12-test',version:'1',section:'Abschnitt',content:lang,type:'feature',source:'context7'}]);


    // Gleicher Doc-Inhalt, aber geaenderter Header waehrend des Embeddings:
    // auch dieser Snapshot muss als veraltet verworfen werden.
    await pool.query('UPDATE tech_docs SET embedded_at=NULL WHERE id=$1',[did]);
    duringEmbed = () => pool.query("UPDATE tech_docs SET section='Neuer Abschnitt',indexed_at=NOW(),embedded_at=NULL WHERE id=$1",[did]);
    const docPutsVorher = upserts;
    await nz.betteEinzelnEin(tech.techDocNachzug,did,{priority:'interactive'});
    assert.equal(upserts,docPutsVorher,'Header-Aenderung mit gleichem content_hash verhindert stale Upsert');
    assert.equal((await pool.query('SELECT embedded_at FROM tech_docs WHERE id=$1',[did])).rows[0].embedded_at,null);
    await nz.betteEinzelnEin(tech.techDocNachzug,did,{priority:'interactive'});
    assert.equal((await tech.searchTechDocs('finden',{framework:'p12-test',scope:'global',ohneNachladen:true,limit:2}))[0].section,'Neuer Abschnitt');

    console.error('KANTEN bestanden: Bestscore, volle Top-k, Shrink, Altbestand, Version, Wiederaufnahme, Snapshot-Race, Claims, Delete, Unicode.');

  }

} finally {
  await pool.query('DELETE FROM wissen_stueck_status WHERE project=$1',[project]);
  await pool.query('DELETE FROM memories WHERE project=$1',[project]);
  await pool.query('DELETE FROM thoughts WHERE project=$1',[project]);
  await db.closePool();
  await new Promise(r => server.close(r));
}
