/** P7-T38: Rollenfilter, verlustfreies Verzeichnis und PG statt Index-Chunks. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
const rollen = await import('../dist/services/agent-rollen.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/onboarding-rollen-alt.json', import.meta.url)));
const duplicate = [{name:'grundregel',content:'Volltext',tags:['pflicht']},{name:'grundregel',content:'Volltext',tags:['pflicht']}];
assert.equal(rollen.baueOnboardingRegeln(duplicate).length,1,'eine Regel = ein Eintrag (Positivkontrolle am alten Stand)');
assert.equal(typeof rollen.baueOnboardingRegelwerk,'function');
const memories = [
  {name:'grundregel',content:'Volltext',category:'rules',tags:['pflicht','alle']},
  {name:'koord',content:'Nur Koordinator',category:'rules',tags:['coordinator-only']},
  {name:'sub',content:'Nur Subagent',category:'rules',tags:['subagent-only']},
  {name:'spec',content:'Nur Spezialist',category:'rules',tags:['specialist-only']},
  {name:'channel',content:'Nur Channelverwalter',category:'rules',tags:['channelverwalter-only']},
  {name:'wissen',content:'Keine Anweisung',category:'documentation',tags:['onboarding-wissen','pflicht']},
  {name:'alt',content:'Historie',category:'rules',tags:['ueberholt','pflicht']},
];
for(const role of ['koordinator','spezialist','subagent','channelverwalter']){
  const block=rollen.baueOnboardingRegelwerk([...memories,memories[0]],'rollen-test',role);
  const expected=['grundregel',({koordinator:'koord',spezialist:'spec',subagent:'sub',channelverwalter:'channel'})[role]].sort();
  assert.deepEqual(block.rules.map(m=>m.name).sort(),expected);
  assert.equal(block.regel_verzeichnis.eintraege.length,7);
  assert.equal(block.regel_verzeichnis.anzahl.wissen,1);
  assert.equal(block.regel_verzeichnis.anzahl.ueberholt,1);
  assert.equal(block.regel_verzeichnis.anzahl.nur_andere_rollen,3);
  assert.match(block.regel_verzeichnis.abruf,/memory/);
  assert.equal(block.regel_verzeichnis.eintraege.find(m=>m.name==='alt').status,'ueberholt');
  assert(!JSON.stringify(block.regel_verzeichnis).includes('Keine Anweisung'));
}
assert.equal(rollen.regelSichtbarFuer(['ueberholt','pflicht'],'koordinator'),false);
assert.equal(rollen.regelSichtbarFuer(['überholt'],'subagent'),false);
assert.equal(rollen.regelSichtbarFuer(['subagenten'],'koordinator'),true,'Thema ist keine Bindung');
const legacy=rollen.baueOnboardingRegelwerk([{name:'ungebunden',content:'Regel',category:'rules'}],'rollen-test','subagent');
assert.equal(legacy.rules.length,1,'Bestand anderer Projekte bleibt sichtbar');
const empty=rollen.baueOnboardingRegelwerk([memories[5],memories[6]],'rollen-test','subagent');
assert.equal(empty.rules.length,0);
assert.equal(empty.regel_verzeichnis.eintraege.length,2,'Verzeichnis auch ohne aktive Regeln');
assert.equal(new Set(fixture.memories.map(m=>m.name)).size,69);
assert.equal(fixture.approved_assignment.length,69);
const categories=Object.fromEntries(fixture.approved_assignment.map(m=>[m.name,m.category]));
assert.equal(categories['agenten-koennen-bilder-selbst-sehen'],'documentation');
assert.equal(categories['regel-deploy-schema-sql-probelauf'],'documentation');
assert.equal(categories['feedback-synapse-tools-statt-curl'],'rules');
for(const role of ['koordinator','spezialist','subagent','channelverwalter']){
  const simulated=fixture.approved_assignment.map(m=>({...m,content:'Erhaltener Volltext'}));
  const block=rollen.baueOnboardingRegelwerk(simulated,'rollen-test',role);
  assert.deepEqual(block.regel_verzeichnis.eintraege.map(m=>m.name).sort(),fixture.memories.map(m=>m.name).sort());
  assert.equal(block.regel_verzeichnis.anzahl.alle,26);
  assert.equal(block.regel_verzeichnis.anzahl.koordinator,23);
  assert.equal(block.regel_verzeichnis.anzahl.spezialist,1);
  assert.equal(block.regel_verzeichnis.anzahl.subagent,2);
  assert.equal(block.regel_verzeichnis.anzahl.channelverwalter,1);
  assert.equal(block.regel_verzeichnis.anzahl.wissen,15);
  assert.equal(block.regel_verzeichnis.anzahl.ueberholt,1);
  assert.equal(block.rules.length,26+({koordinator:23,spezialist:1,subagent:2,channelverwalter:1})[role]);
}
console.log('OK Rollenbindung, Dubletten, Sonderrolle, Verzeichnis 69/69, Wissen/überholt, leere Regeln');
if(process.argv.includes('--db')){
  if(!/:5433\/synapse_test(?:\?|$)/.test(process.env.DATABASE_URL??''))throw Error('Nur synapse_test auf Port 5433');
  let qdrantCalls=0;
  const server=http.createServer((req,res)=>{qdrantCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{points:[],next_page_offset:null}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  process.env.QDRANT_URL='http://127.0.0.1:'+server.address().port;
  const {getPool}=await import('../dist/db/client.js');
  const {getRulesForNewAgent,getOnboardingMemories,getMemoryByName,getMemoriesByNames}=await import('../dist/services/memory.js');
  const {randomUUID}=await import('node:crypto');
  const p=getPool();const project='sol-3-rollen-'+randomUUID();
  try{
    for(const m of memories)await p.query('INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,m.name,m.content,m.category,m.tags]);
    await p.query('INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,'normale-doku','Nicht im Regelverzeichnis','documentation',[]]);
    const catalog=await getOnboardingMemories(project);
    assert.equal(catalog.length,7);
    assert.equal((await getRulesForNewAgent(project)).length,6);
    assert.equal((await getMemoryByName(project,'wissen')).content,'Keine Anweisung');
    assert.equal((await getMemoryByName(project,'grundregel')).content,'Volltext');
    assert.equal(await getMemoryByName(project,'fehlend'),null);
    assert.equal((await getMemoriesByNames(project,['wissen','grundregel'])).length,2);
    assert.equal((await getMemoriesByNames(project,[])).length,0);
    assert.equal(qdrantCalls,0,'Existenz und Volltext kommen ausschließlich aus PG');
    console.log('OK PG-only: kein Qdrant-Aufruf; vollständiger Einzel-/Batch-Abruf; eigenes Testprojekt');
  }finally{await p.query('DELETE FROM memories WHERE project=$1',[project]);await p.end();await new Promise(r=>server.close(r));}
}

/** Execute actual adapter functions with only storage/lifecycle dependencies stubbed. */
const ts=(await import('typescript')).default;
function adapter(relative,name,catalog,extra={}){
  const source=readFileSync(new URL(relative,import.meta.url),'utf8');
  const parsed=ts.createSourceFile(relative,source,ts.ScriptTarget.Latest,true);
  const node=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert(node,'Adapter function anchor exists: '+name);
  const seen=new Set();
  const core={...rollen,
    registerAgent:async(project,id)=>{const key=project+':'+id;if(seen.has(key))return false;seen.add(key);return true;},
    getOnboardingMemories:async()=>catalog,
    getRulesForNewAgent:async()=>catalog.filter(m=>m.category==='rules'),
    ensureChannelverwalterRegel:async()=>{},
    baueChannelUebersicht:async()=>null,baueAbwesenheitsHinweis:async()=>null,
    erklaerungsFaelleZeile:async()=>null,entscheidungsDurchsichtZeile:async()=>null,
    planUebersicht:async()=>[],
  };
  const text=node.getText(parsed).replace(/^export\s+/,'').replaceAll("import('@synapse/core')","Promise.resolve(core)");
  const compiled=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const deps={core,...core,REST_INSTANCE_ID:'adapter-test',SERVER_INSTANCE_ID:'adapter-test',
    console:{error(){},warn(){}},getCachedProjectPath:()=>'/test',
    ermittleProjektStatus:async()=>({project:'rollen-test'}),getSetupPhase:async()=> 'ready',
    ensureHandoffRules:async()=>{},...extra,
  };
  return new Function('deps','const {'+Object.keys(deps).join(',')+'}=deps;'+compiled+';return '+name+';')(deps);
}
for(const catalog of [memories, [memories[5],memories[6]]]){
  for(const role of ['koordinator','spezialist','subagent','channelverwalter']){
    const rest=adapter('../../rest-api/src/routes/mcp.ts','attachRestOnboarding',catalog);
    const stdio=adapter('../../mcp-server/src/tools/onboarding.ts','checkAgentOnboarding',catalog);
    const args={project:'rollen-test',agent_id:'sol-3-adapter-'+role,role};
    const a=(await rest({success:true},args)).agentOnboarding;
    const b=await stdio(args.project,args.agent_id,'/test',role);
    assert(a&&b,'Both adapters emit onboarding');
    assert.deepEqual(a.rules,b.rules);
    assert.deepEqual(a.regel_verzeichnis,b.regel_verzeichnis);
    assert.equal(a.rolle,role);assert.equal(b.rolle,role);
    assert.equal((await rest({success:true},args)).agentOnboarding,undefined,'REST onboarding once');
    assert.equal((await stdio(args.project,args.agent_id,'/test',role)).isFirstVisit,false,'stdio onboarding once');
    assert.deepEqual(await rest([],args),[],'REST arrays unchanged');
  }
}
console.log('OK actual REST/stdio adapters: same roles/rules/directory, empty rules retained, emitted once');

const initMocks={
  checkAgentOnboarding:async(project,id)=>({...rollen.baueOnboardingRegelwerk(memories,project,'subagent'),isFirstVisit:true}),
  path:{basename:()=> 'rollen-test'},checkProjectRoot:()=>null,activeProjects:new Set(['rollen-test']),
  ensureProjectInDaemon:async()=>({state:'mock'}),ensureTray:()=>{},updateLastAccess:()=>{},
  ermittleProjektStatus:async()=>({status:'active'}),scrollVectors:async()=>[{id:'fixture'}],
  verifyProjectAgainstFilesystem:async()=>{},verifyAssetsAgainstFilesystem:async()=>{},
  cacheProjectPathBoth:()=>{},registerProject:async()=>{},
  heartbeatController:{reconnectAll:async()=>({connected:[],cleaned:[]})},
};
for(const name of ['initProjekt','tryReactivateProject']){
  const run=adapter('../../mcp-server/src/tools/init.ts',name,memories,initMocks);
  const b=name==='initProjekt'
    ?await run('/test','rollen-test',false,'sol-3-init')
    :await run('/test','rollen-test','sol-3-init');
  assert.deepEqual(b.rules.map(m=>m.name).sort(),['grundregel','sub'],'init must respect roles');
  assert.equal(b.regel_verzeichnis.eintraege.length,7,'init must retain directory');
}
const initSource=readFileSync(new URL('../../mcp-server/src/tools/init.ts',import.meta.url),'utf8');
const initAst=ts.createSourceFile('init.ts',initSource,ts.ScriptTarget.Latest,true);
let sharedCalls=0,legacyCalls=0;
function visit(n){
  if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)){
    if(n.expression.text==='checkAgentOnboarding')sharedCalls++;
    if(n.expression.text==='getRulesForNewAgent'||n.expression.text==='registerAgent')legacyCalls++;
  }
  ts.forEachChild(n,visit);
}
visit(initAst);
assert.equal(sharedCalls,3,'all three init routes share onboarding');
assert.equal(legacyCalls,0,'init has no unfiltered legacy route');
console.log('OK init fast path/reactivation: roles/directory; all three routes share onboarding (mock-only)');
