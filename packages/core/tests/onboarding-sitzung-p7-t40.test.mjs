/** P7-T40: explicit onboarding refresh, session state and bindings; synapse_test only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const db=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(db.pathname,'/synapse_test');assert.equal(db.port,'5433');
process.env.SYNAPSE_ONBOARDING_RUHE_MIN='0';
const C=await import('../dist/services/chat.js');
const S=await import('../dist/services/project-status.js');
const R=await import('../dist/services/project-registry.js');
const E=await import('../dist/services/events.js');
const CH=await import('../dist/services/channels.js');
const B=await import('../dist/services/file-batch.js');
const F=await import('../dist/services/file-reservations.js');
const {getPool}=await import('../dist/db/client.js');
const p=getPool();
const project='sol-3-t40-'+randomUUID();const agent=project+'-a',other=project+'-b';
const root='/home/blacky/dev/synapse/coedit-test/'+project;
const role='subagent';
const refresh=(id=agent)=>C.wendeSitzungsSignalAn({project,agentId:id,role,sitzung:'fortsetzung',onboarding:true,serverInstanceId:'t40-explicit'});
let n=0;const ok=(message)=>console.log('OK '+(++n)+' '+message);
async function cleanup(){
  await p.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)',[project]);
  await p.query('DELETE FROM specialist_channel_members WHERE channel_id IN (SELECT id FROM specialist_channels WHERE project=$1)',[project]);
  await p.query('DELETE FROM specialist_channel_messages WHERE channel_id IN (SELECT id FROM specialist_channels WHERE project=$1)',[project]);
  await p.query('DELETE FROM specialist_channels WHERE project=$1',[project]);
  for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls','agent_onboardings','memories','agent_sessions'])
    await p.query('DELETE FROM '+t+' WHERE project=$1',[project]);
  await p.query('DELETE FROM projects WHERE name=$1',[project]);
}
try{
  await C.registerAgent(agent,project);await C.registerAgent(other,project);
  await p.query('INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,'grundregel','Vollständiger Inhalt','rules',['alle','pflicht']]);
  assert.equal(await S.registerAgent(project,agent,'t40-old',role,'angegeben'),true);
  const before=(await p.query('SELECT aktiv_seit FROM agent_sessions WHERE id=$1',[agent])).rows[0].aktiv_seit.toISOString();
  const refreshed=await refresh();
  assert.equal(refreshed.onboarding_erneut,true,'Positivkontrolle: fortsetzung+onboarding fordert Regeln an');
  assert.equal(refreshed.agentOnboarding?.rules[0].content,'Vollständiger Inhalt');
  assert.equal(refreshed.agentOnboarding.rolle,role);
  assert.equal(refreshed.project,project);
  assert.equal((await p.query('SELECT aktiv_seit FROM agent_sessions WHERE id=$1',[agent])).rows[0].aktiv_seit.toISOString(),before);
  assert.equal(await S.registerAgent(project,agent,'t40-next-server',role,'angegeben'),false,'Bloßer Prozessneustart liefert keine Regeln');
  ok('Refresh same agent: rules delivered in response, life phase unchanged, next process quiet');
  const plain=await C.wendeSitzungsSignalAn({project,agentId:agent,sitzung:'fortsetzung'});
  assert.equal(plain.agentOnboarding,undefined);
  for(const extra of [{sitzung:undefined},{role:undefined},{agentId:undefined},{project:''}]){
    await assert.rejects(()=>C.wendeSitzungsSignalAn({project,agentId:agent,role,sitzung:'fortsetzung',onboarding:true,...extra}));
  }
  await assert.rejects(()=>C.wendeSitzungsSignalAn({project,agentId:agent,role:'guess',sitzung:'fortsetzung',onboarding:true}));
  ok('Legacy fortsetzung quiet; incomplete/invalid refresh rejected');
  // Binding state is compared exactly, including cursors and deferred contribution.
  await CH.createChannel(project,'t40','Test',agent);await CH.joinChannel(project,'t40',agent);
  await CH.postChannelMessage(project,'t40',other,'offener Beitrag');
  const create=await B.planBatch({project,agent_id:agent,ops:[{file_path:'src/shared.ts',action:'create',content:'one\ntwo\n'}]});
  assert.equal((await B.commitBatch({plan_id:create.plan_id,agent_id:agent})).success,true);
  await F.addFileReservations({project,agentId:other,filePaths:['src/shared.ts']});
  const deferred={file_path:'src/shared.ts',action:'search_replace',search:'two',replace:'TWO'};
  const waiting=await B.planBatch({project,agent_id:agent,ops:[deferred]});
  const owner=await B.planBatch({project,agent_id:other,ops:[{file_path:'src/shared.ts',action:'search_replace',search:'one',replace:'ONE'}]});
  const token=waiting.coedit_waits[0].wait_token;
  assert.equal((await B.addCoeditContribution({project,plan_id:owner.plan_id,agent_id:agent,wait_token:token,ops:[deferred]})).success,true);
  const state=async()=>({
    members:(await p.query('SELECT m.* FROM specialist_channel_members m JOIN specialist_channels c ON c.id=m.channel_id WHERE c.project=$1',[project])).rows,
    reservations:(await p.query('SELECT * FROM file_reservations WHERE project=$1 ORDER BY id',[project])).rows,
    waits:(await p.query('SELECT * FROM file_batch_waits WHERE project=$1 ORDER BY wait_token',[project])).rows,
    plans:(await p.query('SELECT * FROM file_batch_plans WHERE project=$1 ORDER BY id',[project])).rows,
    acks:(await p.query('SELECT a.* FROM agent_event_acks a JOIN agent_events e ON e.id=a.event_id WHERE e.project=$1 ORDER BY a.event_id',[project])).rows,
  });
  const broadcast=await E.emitEvent(project,'ANNOUNCEMENT','normal','all',other,'offen',true);
  const direct=await E.emitEvent(project,'PLAN_CHANGED','normal','agent:'+agent,other,'offen',true);
  const acked=await E.emitEvent(project,'PLAN_READY','normal','agent:'+agent,other,'quittiert',true);
  await E.acknowledgeEvent(acked.id,agent,'verstanden');
  const snapshot=await state();assert(snapshot.waits.length>0);assert(snapshot.acks.length>0);
  const pendingBefore=await E.getPendingEvents(project,agent);
  await refresh();assert.deepEqual(await state(),snapshot);
  assert.deepEqual((await E.getPendingEvents(project,agent)).map(e=>e.id),pendingBefore.map(e=>e.id));
  assert.equal((await (await import('../dist/services/channel-unread.js')).claimUnreadChannelHints(agent)).some(h=>h.project===project&&h.channel==='t40'),true);
  ok('Membership/cursors, reservation, linked wait, contribution, ACKs and open events retained');
  const hints=await import('../dist/services/plan-hints.js');
  const now=Date.now();
  assert(await hints.claimOpenPlanHints(project,agent,now,true));
  assert.equal(await hints.claimOpenPlanHints(project,agent,now+16*60_000),null);
  assert(await hints.claimOpenPlanHints(project,agent,now+16*60_000,true));
  const beforeNeu=await state(); // claimUnreadChannelHints legitimately advanced its own delivery cursor.
  const freshSession=await C.wendeSitzungsSignalAn({project,agentId:agent,role,sitzung:'neu'});
  assert(freshSession.agentOnboarding);assert.equal(freshSession.onboarding_erneut,true);
  const afterNeu=(await E.getPendingEvents(project,agent)).map(e=>e.id);
  assert(!afterNeu.includes(broadcast.id));assert(afterNeu.includes(direct.id));assert(!afterNeu.includes(acked.id));
  assert.deepEqual(await state(),beforeNeu);
  ok('Unchanged plans do not repeat after 16 minutes; refresh repeats once; neu preserves direct events/ACKs and bindings');
  // Two ordinary transports racing for a brand-new agent claim one delivery only.
  const O=await import('../dist/services/agent-onboarding.js');
  const fresh=project+'-fresh';
  const initial=await Promise.all(['server-a','server-b'].map(serverInstanceId=>O.holeAgentOnboarding({project,agentId:fresh,role,serverInstanceId})));
  assert.equal(initial.filter(Boolean).length,1);
  const concurrent=await Promise.all([refresh(fresh),O.holeAgentOnboarding({project,agentId:fresh,role,serverInstanceId:'server-c'})]);
  assert(concurrent[0].agentOnboarding);assert.equal(concurrent[1],null);
  ok('Concurrent first visits one delivery; explicit response cannot be consumed by ordinary call');
  const failed=project+'-failed';
  await assert.rejects(()=>O.holeAgentOnboarding({project,agentId:failed,role,serverInstanceId:'fail',vorbereiten:async()=>{throw Error('simulierte Ladefehler');}}));
  assert.equal((await p.query('SELECT count(*)::int n FROM agent_onboardings WHERE agent_id=$1',[failed])).rows[0].n,0);
  assert(await O.holeAgentOnboarding({project,agentId:failed,role,serverInstanceId:'retry'}));
  ok('Preparation failure leaves no delivered marker, retry succeeds');
  await p.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t40-test',root]);
  assert.equal((await R.ermittleProjektAusPfad(root+'/packages/core')).project,project);
  assert.equal((await R.ermittleProjektAusPfad(root)).project,project);
  await assert.rejects(()=>R.ermittleProjektAusPfad(root+'-unbekannt'));
  await p.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project+'-mehrdeutig','t40-test',root]);
  await assert.rejects(()=>R.ermittleProjektAusPfad(root+'/src'));
  await p.query('DELETE FROM projects WHERE name=$1',[project+'-mehrdeutig']);
  ok('Project from registered root/subdirectory; unknown and ambiguous paths rejected');
  // Execute actual admin case bodies without starting servers or changing real files.
  const ts=(await import('typescript')).default;
  for(const relative of ['../../mcp-server/src/tools/consolidated/admin.ts','../../rest-api/src/routes/mcp.ts']){
    const src=readFileSync(new URL(relative,import.meta.url),'utf8'),ast=ts.createSourceFile(relative,src,ts.ScriptTarget.Latest,true);
    const cases=[];function visit(n){if(ts.isCaseClause(n)&&n.expression?.text==='index_stats')cases.push(n);ts.forEachChild(n,visit);}visit(ast);
    assert.equal(cases.length,1,'admin index_stats case anchor');
    const body=cases[0].statements.map(n=>n.getText(ast)).join('\n');
    const js=ts.transpileModule('async function invoke(args){'+body+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const deps={wendeSitzungsSignalAn:C.wendeSitzungsSignalAn,reqStr:(a,k)=>{if(!a[k])throw Error(k);return a[k];},str:(a,k)=>typeof a[k]==='string'?a[k]:undefined,
      bool:(a,k)=>a[k]===true||a[k]==='true'?true:a[k]===false||a[k]==='false'?false:undefined,
      getIndexStats:async()=>({success:true}),getProjectStats:async()=>({fileCount:0,chunkCount:0}),
      getCollectionStats:async()=>({pointsCount:0}),COLLECTIONS:{projectThoughts:()=>'',projectMemories:()=>'',projectMedia:()=>''}};
    const invoke=new Function('deps','const {'+Object.keys(deps).join(',')+'}=deps;'+js+';return invoke')(deps);
    const r=await invoke({project,agent_id:agent,role,sitzung:'fortsetzung',onboarding:'true'});
    assert.equal(r.sitzung.onboarding_erneut,true);assert.equal(r.agentOnboarding.rolle,role);
  }
  ok('Actual REST/stdio admin cases deliver explicit onboarding, including connector string true');

  // Execute the actual Jev hint deduplicator with a deterministic switch state.
  const hintSrc=readFileSync(new URL('../src/services/jev-modus-hinweis.ts',import.meta.url),'utf8');
  const hintAst=ts.createSourceFile('hint.ts',hintSrc,ts.ScriptTarget.Latest,true);
  const hintFn=hintAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='holeJevSitzungsHinweis');
  const hintJs=ts.transpileModule(hintFn.getText(hintAst).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let switchState='an';
  const makeHint=()=>new Function('holeJevModusHinweis','const agentModus=new Map();'+hintJs+';return holeJevSitzungsHinweis')(async()=>switchState);
  const hint=makeHint();
  assert.equal(await hint(project,agent,true),'an');
  assert.equal(await hint(project,agent),null);
  assert.equal(await makeHint()(project,agent),null,'process restart alone is quiet');
  switchState=null;assert.equal(await hint(project,agent),null);
  switchState='an';assert.equal(await hint(project,agent),'an','real switch change delivered');
  assert.equal(await hint(project,agent),null);
  assert.equal(await hint(project,agent,true),'an','explicit refresh delivered');
  ok('Jev static hint once, restart quiet, actual changes and refresh delivered');

}finally{await p.query('DELETE FROM projects WHERE name=$1',[project+'-mehrdeutig']);await cleanup();await p.end();}
console.log('P7-T40 PASS '+n+' checks; own test project cleaned');
// Channel posting starts unrelated background skill work; assertions and cleanup are complete.
process.exit(0);
