/**
 * P22-T198 / User-Fälle thought 4c753909 (26.10.2026), Zusatz Fall 6:
 * file-batch.ts planBatch/replanBatch/addCoeditContribution/Ready/commit/cancel und
 * REST mcp.ts handleToolCall: Fehlbedienung WÄHREND 100 Protokollakteure 100000 Zeilen bearbeiten.
 * Soll ausschließlich aus CE1..CE8 (7d9b9f86), Runde3 (46ccab5b) und genannten Funktionen.
 * synapse_test:5433, eigener Projektbereich, kein Browser/LLM/Prod/Dateisystem-Write.
 * Fall 6 misst tatsächlich 300 s Standard-Inaktivität ohne Zeitstempel-Manipulation.
 * Tabellenzeilen enthalten erwartet/ist, Plan-IDs, Dauer und parallelen Laststand.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
const inheritedWindow=process.env.SYNAPSE_COEDIT_AKTIV_MIN;
delete process.env.SYNAPSE_COEDIT_AKTIV_MIN; // eigens gemessener Code-Standard, kein globaler Schalter-Write
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1'});
const B=await import('../dist/services/file-batch.js');
const R=await import('../dist/services/file-reservations.js');
const D=await import('../dist/db/client.js'),pool=D.getPool();
const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
const Fastify=createRequire(new URL('../../rest-api/package.json',import.meta.url))('fastify');
const app=Fastify({logger:false});await app.register(mcpRoutes);await app.ready();
let rpcId=0;
async function rpc(a,args){
 const res=await app.inject({method:'POST',url:'/mcp/messages',payload:{jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name:'files',arguments:{project,agent_id:a,...args}}}});
 const body=res.json();if(body.error)return {success:false,error:body.error.message};
 const r=body.result;return r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
}
const project='p22-t198-fehler-'+randomUUID(),rows=[];
let errors=0,checks=0,seq=0,loadDone=0,loadRunning=false,releaseLoad,signalLoad;
const loadStarted=new Promise(r=>signalLoad=r),casesFinished=new Promise(r=>releaseLoad=r);
const short=x=>JSON.stringify(x)?.slice(0,2400);
const evidence=x=>console.log('BELEG P22-T198 '+short(x));
function ok(v,label,ist){checks++;assert.ok(v,'P22-T198 file-batch.ts '+label+' erwartet=true ist='+short(ist??v));}
async function attempt(fn){try{return await fn();}catch(e){return {success:false,error:e.message,plan_id:e.plan_id};}}
const plan=(a,ops)=>B.planBatch({project,agent_id:a,ops});
const commit=(p,a,wait_seconds)=>B.commitBatch({plan_id:p,agent_id:a,wait_seconds});
const add=(p,a,ops,extra={})=>B.addCoeditContribution({project,plan_id:p,agent_id:a,ops,...extra});
const ready=(p,a)=>B.markCoeditReady({project,plan_id:p,agent_id:a});
const sr=(f,search,replace)=>({file_path:f,action:'search_replace',search,replace});
const read=async f=>(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[project,f])).rows[0]?.content;
const state=async p=>(await pool.query('SELECT id::text, status::text, ops, owner_agent_id FROM file_batch_plans WHERE id=$1::bigint AND project=$2',[p,project])).rows[0];
const active=async a=>(await pool.query("INSERT INTO tool_calls(project,tool_name,action,agent_id,ts) VALUES($1,'files','plan_status',$2,clock_timestamp()) RETURNING ts",[project,a])).rows[0].ts;
const occurrences=(text,marker)=>text.split(marker).length-1;
async function seed(f,text='OBEN\nMITTE\nUNTEN\nFUSS\n'){
 const a=project+'seed',p=await plan(a,[{file_path:f,action:'create',content:text}]);ok((await commit(p.plan_id,a)).success,'Fixture '+f);
}
async function scenario(){
 const n=++seq,f='fall-'+n+'.txt',o=project+'o'+n,w=project+'w'+n;await seed(f);
 const p=await plan(o,[sr(f,'OBEN','[OWNER-'+n+']')]),op=sr(f,'UNTEN','[BEITRAG-'+n+']'),c=await plan(w,[op]);
 ok(!!c.coedit_waits?.length,'Overlap erzeugt Träger/Wait',c);
 return {n,f,o,w,p,c,op,token:c.coedit_waits[0].wait_token};
}
async function finish(s){
 const a=await add(s.p.plan_id,s.w,[s.op]);ok(a.success,'korrekter Beitrag',a);
 ok((await ready(s.p.plan_id,s.w)).success,'korrektes Ready');
 const cm=await commit(s.p.plan_id,s.o);ok(cm.success,'korrekter Commit',cm);
 const text=await read(s.f);for(const marker of ['[OWNER-'+s.n+']','[BEITRAG-'+s.n+']'])ok(occurrences(text,marker)===1,'Fallmarke genau einmal '+marker,text);
 return cm;
}
async function test(fall,expected,fn){
 const start=Date.now(),load_at_start=loadDone,load_running_at_start=loadRunning;
 try{
  const actual=await fn();
  const row={fall,expected,actual,verdict:'PASS',ms:Date.now()-start,load_at_start,load_at_end:loadDone,loadRunning:load_running_at_start};
  rows.push(row);console.log('TABELLE '+JSON.stringify(row));
 }catch(e){
  errors++;const row={fall,expected,actual:e.stack,verdict:'FAIL',ms:Date.now()-start,load_at_start,load_at_end:loadDone,loadRunning:load_running_at_start};
  rows.push(row);console.error('TABELLE '+JSON.stringify(row));
 }
}
// 46ccab5b: eigener Owner ohne Aktivität, echte PG-Konkurrenz, keine exklusiven Reservierungen.
async function load(){
 const f='last-100000.txt',owner=project+'load-owner',N=100;
 await seed(f,Array.from({length:100000},(_,i)=>'ZEILE-'+String(i).padStart(6,'0')).join('\n')+'\n');
 const p=await plan(owner,[sr(f,'ZEILE-000000','[LAST-OWNER]')]);
 loadRunning=true;signalLoad();const start=Date.now();
 try{
  for(let i=0;i<N;i+=5)await Promise.all(Array.from({length:5},(_,j)=>i+j).map(async k=>{
   const a=project+'last-'+k,op=sr(f,'ZEILE-'+String((k+1)*900).padStart(6,'0'),'[LAST-'+k+']');
   const c=await plan(a,[op]);ok(!!c.coedit_waits?.length,'Last Wait '+k,c);
   const z=await add(p.plan_id,a,[op]);ok(z.success&&!z.overlap_warnings?.length,'Last disjunkt '+k,z);
   ok((await ready(p.plan_id,a)).success,'Last Ready '+k);loadDone++;
  }));
  await casesFinished;
  const cm=await commit(p.plan_id,project+'last-0');ok(cm.success,'Last Owner-Absturz blockiert nicht',cm);
  const text=await read(f);for(const m of ['[LAST-OWNER]',...Array.from({length:N},(_,i)=>'[LAST-'+i+']')])ok(occurrences(text,m)===1,'Last Marke genau einmal '+m);
  ok(text.split('\n').length===100001,'Last 100000 Zeilen erhalten');
  rows.push({fall:'100 Beitragende / 100000 Zeilen',expected:'101 Marken genau einmal, Owner-Absturz blockiert nicht',actual:{plan_id:p.plan_id,markers:101,actors:N,lines:100000},verdict:'PASS',ms:Date.now()-start});
 }catch(e){errors++;evidence({fall:'LAST FEHLER',error:e.stack,plan_id:p.plan_id});}
 finally{loadRunning=false;}
}
let loadJob,crashJob;
try{
 ok((await pool.query('SELECT current_database() db')).rows[0].db==='synapse_test','DB-Ziel');
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t198-agentenfehler','/tmp']);
 loadJob=load();await loadStarted;
 // User-Zusatz Fall6: echte Standard-Zeit, SQL-Zeitstempel nur lesen, kein Zurückdatieren.
 if(process.env.T198_300S_REFERENZ_JOB)console.log('REFERENZ P22-T198 unveränderte 300s-Grenze bereits real gemessen in Job '+process.env.T198_300S_REFERENZ_JOB);
 else crashJob=test('6b Beitragender stürzt vor Ready ab; volle Standardfrist',
  '300 s seit letzter Tool-Aktivität; davor begrenzte Warteantwort; danach beide Marken erhalten',async()=>{
   const s=await scenario();ok((await add(s.p.plan_id,s.w,[s.op])).success,'Absturz-Beitrag eingereicht');
   const ts=await active(s.w),started=Date.now();
   const first=await commit(s.p.plan_id,s.o,2),firstMs=Date.now()-started;
   ok(first.status==='waiting_for_contributors'&&firstMs<6000,'vor Ablauf keine endlose Anfrage',{first,firstMs});
   const gate=first.commit_wartet_auf??first.waiting_for??[];
   evidence({fall:'6b erste Warteantwort',plan_id:s.p.plan_id,last_activity:ts,firstMs,reply:first});
   const unrelated='andere-datei.txt';await seed(unrelated,'UNABHAENGIG\n');
   ok(await read(unrelated)==='UNABHAENGIG\n','andere Datei während Gate nutzbar');
   const deadline=new Date(ts).getTime()+300000;
   await new Promise(r=>setTimeout(r,Math.max(0,deadline-Date.now()-2000)));
   const before=await commit(s.p.plan_id,s.o);
   ok(before.status==='waiting_for_contributors','Gate kurz vor 300 s noch zu',before);
   await new Promise(r=>setTimeout(r,Math.max(0,deadline-Date.now()+100)));
   const cm=await commit(s.p.plan_id,s.o),text=await read(s.f),elapsed=Date.now()-new Date(ts).getTime();
   ok(cm.success&&elapsed>=300000&&elapsed<310000,'Gate nach realen 300 s offen',{cm,elapsed});
   for(const m of ['[OWNER-'+s.n+']','[BEITRAG-'+s.n+']'])ok(occurrences(text,m)===1,'Absturz-Beitrag mitcommittet '+m,text);
   return {plan_id:s.p.plan_id,setting:'SYNAPSE_COEDIT_AKTIV_MIN',source:'Code-Standard ohne Env; keine PG-Lesestelle',default_minutes:5,last_activity:ts,elapsed_ms:elapsed,first_wait_ms:firstMs,before:before.status,after:cm.status??cm.success,contribution:'mitcommittet genau einmal',other_file:'sofort nutzbar',gate};
  });
 await test('1 alte plan_id nach plan_update',
  'neue ID zuerst; alte ID lesbar als ersetzt/geschlossen und nicht committbar',async()=>{
   const f='alte-id.txt',a=project+'alte';await seed(f,'ALT\n');
   const old=await attempt(()=>plan(a,[sr(f,'NICHT-DA','X')]));
   // P6-T51: ganzen Entwurf ohne op_index ersetzen nur noch ausdruecklich (ersetzen_alle).
   const p=await B.replanBatch({project,plan_id:old.plan_id,agent_id:a,ersetzen_alle:true,ops:[sr(f,'ALT','[NEUE-ID]')]});
   ok(p.plan_id!==old.plan_id&&p.message.startsWith('NEUE plan_id '+p.plan_id),'Folge-ID eindeutig',p);
   const oldRead=await B.getBatchPlan(old.plan_id),oldCommit=await attempt(()=>commit(old.plan_id,a));
   ok(oldRead.status!=='open'&&!oldCommit.success,'alte ID verweigert',{oldRead:oldRead.status,oldCommit});
   ok((await commit(p.plan_id,a)).success&&occurrences(await read(f),'[NEUE-ID]')===1,'neue ID schreibt einmal');
   return {old:old.plan_id,current:p.plan_id,oldStatus:oldRead.status,oldCommit,message:p.message};
  });
 await test('2a fehlende/leere ops, falscher Index, fremder Token',
  'klare Abweisung ohne Mutation; korrekter Beitrag bleibt möglich',async()=>{
   const s=await scenario(),answers=[];
   for(const [label,ops,extra] of [['ohne ops',undefined,{}],['leere ops',[],{}],['falscher Index',[s.op],{op_index:999}],['fremder Token',[s.op],{wait_token:randomUUID()}]]){
    const z=await attempt(()=>add(s.p.plan_id,s.w,ops,extra));ok(!z.success&&!!z.error&&!/Cannot read|TypeError/.test(z.error),label,z);
    const wire=await rpc(s.w,{action:'coedit_add',plan_id:s.p.plan_id,...(ops===undefined?{}:{ops}),...extra});
    ok(!wire.success&&!!wire.error&&!/Cannot read|TypeError/.test(wire.error),'REST '+label,wire);answers.push({label,error:z.error,rest_error:wire.error,skills:wire.skill_suggestions});
   }
   ok((await state(s.p.plan_id)).ops.length===1,'abgewiesene Aufrufe mutieren nicht');await finish(s);
   return {plan_id:s.p.plan_id,answers};
  });
 await test('2b abgelaufener fertiger Token; gebundener Wait bleibt gültig',
  'ready-Token nach Frist abgewiesen; waiting/linked bleiben gemäß Vertrag trotz Frist gültig',async()=>{
   const s=await scenario();
   await pool.query("UPDATE file_batch_waits SET expires_at=now()-interval '1 second' WHERE wait_token=$1::uuid",[s.token]);
   const bound=await add(s.p.plan_id,s.w,[s.op]);ok(bound.success,'gebundener waiting-Token über Frist gültig',bound);
   await ready(s.p.plan_id,s.w);
   await pool.query("UPDATE file_batch_waits SET expires_at=now()-interval '1 second' WHERE wait_token=$1::uuid",[s.token]);
   const expired=await attempt(()=>add(s.p.plan_id,s.w,[s.op],{wait_token:s.token}));ok(!expired.success,'fertiger abgelaufener Token abgewiesen',expired);
   ok((await commit(s.p.plan_id,s.o)).success,'gebundener Beitrag committed');
   ok(occurrences(await read(s.f),'[BEITRAG-'+s.n+']')===1,'Tokenfall genau einmal');
   return {plan_id:s.p.plan_id,bound:bound.success,expired};
  });
 await test('3 Owner coedit_add',
  'Owner-Rolle und plan_update statt Selbstbeitrag benannt',async()=>{
   const s=await scenario(),z=await attempt(()=>add(s.p.plan_id,s.o,[sr(s.f,'MITTE','X')]));
   ok(!z.success&&/Owner.*plan_update/.test(z.error),'Owner-Hilfe',z);await finish(s);return {plan_id:s.p.plan_id,error:z.error};
  });
 await test('4 task_id fehlt oder weicht ab',
  'deferred-Task-UUID bleibt unverändert; beide Abweichungen abgewiesen',async()=>{
   const s=await scenario(),t1=randomUUID(),t2=randomUUID(),pid=randomUUID();
   // Frische Quelle: alte Träger-Ops explizit zurückziehen, dann Aufgabe binden.
   await B.cancelBatch(s.c.plan_id,s.w);
   await pool.query('INSERT INTO plans(id,project,name,tasks) VALUES($1,$2,$3,$4::jsonb)',[pid,project,'Fehlerfälle',JSON.stringify([{id:t1,kurz_id:'P1-T1',title:'eins',status:'todo'},{id:t2,kurz_id:'P1-T2',title:'zwei',status:'todo'}])]);
   s.op={...s.op,task_id:t2};await plan(s.w,[s.op]);const answers=[];
   for(const op of [{...s.op,task_id:undefined},{...s.op,task_id:t1}]){
    const z=await attempt(()=>add(s.p.plan_id,s.w,[op]));ok(!z.success&&/task_id/.test(z.error),'Taskabweichung erklärt',z);answers.push(z.error);
   }
   await finish(s);return {plan_id:s.p.plan_id,expected_task:t2,answers};
  });
 await test('5 ready ohne Beitrag, no_changes außerhalb, doppeltes ready',
  'unvollständiger Beitrag abgewiesen, fremde Datei abgewiesen, Ready-Wiederholung idempotent',async()=>{
   const s=await scenario(),early=await attempt(()=>ready(s.p.plan_id,s.w));
   ok(!early.success&&early.remaining_files?.includes(s.f),'Ready ohne Beitrag zeigt Rest',early);
   const outside=await attempt(()=>B.markCoeditNoChanges({project,plan_id:s.p.plan_id,agent_id:s.w,files:['ausserhalb.txt']}));
   ok(!outside.success,'no_changes außerhalb Ziel verweigert',outside);
   ok((await add(s.p.plan_id,s.w,[s.op])).success,'Beitrag nach Fehlbedienung');const r1=await ready(s.p.plan_id,s.w),r2=await ready(s.p.plan_id,s.w);
   ok(r1.success&&r2.success,'Ready doppelt idempotent',{r1,r2});
   ok((await commit(s.p.plan_id,s.o)).success,'danach Commit');ok(occurrences(await read(s.f),'[BEITRAG-'+s.n+']')===1,'Ready doppelt keine doppelte Marke');
   return {plan_id:s.p.plan_id,early,outside,doubleReady:r2.success};
  });
 await test('6a Owner cancel mitten im Sammeln',
  'nur eigene Ops zurückziehen; fremder Beitrag und neuer Owner bleiben erhalten',async()=>{
   const s=await scenario();await add(s.p.plan_id,s.w,[s.op]);
   const z=await B.cancelBatch(s.p.plan_id,s.o),st=await state(s.p.plan_id);
   ok(z.mode==='withdrawn'&&st.owner_agent_id===s.w,'Ownerwechsel statt Fremdverlust',{z,st});
   ok((await commit(s.p.plan_id,s.w)).success,'neuer Owner kann committen');
   const text=await read(s.f);ok(occurrences(text,'[BEITRAG-'+s.n+']')===1&&occurrences(text,'[OWNER-'+s.n+']')===0,'nur explizit zurückgezogene Marke entfällt',text);
   return {plan_id:s.p.plan_id,cancel:z,newOwner:st.owner_agent_id};
  });
 await test('6c Owner cancelt vor erstem Beitrag',
  'Wait und Träger geschlossen; Beitrag kann neu geplant werden',async()=>{
   const s=await scenario(),z=await B.cancelBatch(s.p.plan_id,s.o),carrier=await state(s.c.plan_id);
   ok(z.mode==='cancelled'&&carrier.status!=='open','Zielcancel schließt leeren Träger',{z,carrier});
   const p=await plan(s.w,[s.op]);ok((await commit(p.plan_id,s.w)).success,'Neuplan ohne Hängen');
   ok(occurrences(await read(s.f),'[BEITRAG-'+s.n+']')===1,'neu geplanter Beitrag einmal');
   return {old:s.p.plan_id,carrier:carrier.status,current:p.plan_id};
  });
 await test('7 Träger nach Overlap canceln und neu planen',
  'alter Token ungültig, keine Wait-Leiche; neuer Beitrag genau einmal',async()=>{
   const s=await scenario(),z=await B.cancelBatch(s.c.plan_id,s.w);
   const old=await attempt(()=>add(s.p.plan_id,s.w,[s.op],{wait_token:s.token}));ok(!old.success,'geschlossener Token verweigert',old);
   const c=await plan(s.w,[s.op]);ok(c.coedit_waits?.length,'Neuplan bindet wieder',c);await finish(s);
   return {plan_id:s.p.plan_id,oldCarrier:s.c.plan_id,newCarrier:c.plan_id,cancel:z,oldToken:old.error};
  });
 // CE3/Runde3: gleicher Einfügeanker allein ist KEIN Konflikt, beide Marken bleiben.
 await test('8a gleicher Einfügeanker ohne Bereichskollision',
  'beide insert_after am selben ursprünglichen Anker erlaubt, beide Marken genau einmal',async()=>{
   const s=await scenario();await B.cancelBatch(s.c.plan_id,s.w);
   const ownerOp={file_path:s.f,action:'insert_after',after_line:1,anchor_text:'OBEN',content:'[ANKER-OWNER]'};
   await B.replanBatch({project,plan_id:s.p.plan_id,agent_id:s.o,op_index:0,ops:[ownerOp]});
   s.op={...ownerOp,content:'[ANKER-BEITRAG]'};await plan(s.w,[s.op]);
   const a=await add(s.p.plan_id,s.w,[s.op]);ok(a.success&&!a.overlap_warnings?.length,'gleicher Punkt ohne echten Overlap',a);
   await ready(s.p.plan_id,s.w);const cm=await commit(s.p.plan_id,s.o);ok(cm.success,'gemeinsamer Einfügeanker committbar',cm);
   const text=await read(s.f);for(const m of ['[ANKER-OWNER]','[ANKER-BEITRAG]'])ok(occurrences(text,m)===1,'gleicher Anker Marke einmal '+m,text);
   return {plan_id:s.p.plan_id,marks:2,overlap:a.overlap_warnings??[]};
  });
 // CE3: echte Überschneidung atomar verweigern; Rückzug revalidiert den Rest (693bbf48).
 await test('8a gleiche Stelle, echte Kollision',
  'coedit_conflict atomar; nach Rückzug bleibt Owner-Marke einmal',async()=>{
   const s=await scenario();await B.cancelBatch(s.c.plan_id,s.w);s.op=sr(s.f,'[OWNER-'+s.n+']','[KOLLISION]');await plan(s.w,[s.op]);
   const a=await add(s.p.plan_id,s.w,[s.op]);ok(a.success,'kollidierende Op tatsächlich eingereicht',a);await ready(s.p.plan_id,s.w);const cm=await commit(s.p.plan_id,s.o);
   ok(a.overlap_warnings?.length&&!cm.success&&cm.error==='coedit_conflict','echte Kollision',cm);
   ok((await read(s.f)).startsWith('OBEN'),'Konflikt schreibt nichts');
   const withdraw=await B.cancelBatch(s.p.plan_id,s.w);ok(withdraw.mode==='withdrawn','kollidierende eigene Op zurückgezogen',withdraw);
   ok((await commit(s.p.plan_id,s.o)).success,'Rest nach Rückzug committbar');
   ok(occurrences(await read(s.f),'[OWNER-'+s.n+']')===1,'Owner-Marke bleibt einmal');
   return {plan_id:s.p.plan_id,conflict:cm.error,withdraw:withdraw.mode};
  });
 await test('8b Ersetzung fremd eingefügten Texts',
  'echte Überschneidung trotz Punktregion erkannt, atomar verweigert',async()=>{
   const s=await scenario();await B.cancelBatch(s.c.plan_id,s.w);
   await B.replanBatch({project,plan_id:s.p.plan_id,agent_id:s.o,op_index:0,ops:[{action:'insert_after',file_path:s.f,after_line:1,anchor_text:'OBEN',content:'[FREMD-EINGEFUEGT]'}]});
   s.op=sr(s.f,'[FREMD-EINGEFUEGT]','[ERSETZT]');await plan(s.w,[s.op]);
   const a=await add(s.p.plan_id,s.w,[s.op]);await ready(s.p.plan_id,s.w);const cm=await commit(s.p.plan_id,s.o);
   ok(a.overlap_warnings?.length&&!cm.success,'Fremdtext-Konflikt bleibt',cm);
   await B.cancelBatch(s.p.plan_id,s.w);ok((await commit(s.p.plan_id,s.o)).success,'Fremdtext-Rest committbar');
   ok(occurrences(await read(s.f),'[FREMD-EINGEFUEGT]')===1,'eingefügte Marke bleibt einmal');return {plan_id:s.p.plan_id,error:cm.error};
  });
 await test('8c späte absolute Zeilen-Op auf geänderte Zeile',
  'late_line_ops_unmappable mit Verursacher; keine offene Folgeplan-Leiche',async()=>{
   const s=await scenario();await B.cancelBatch(s.c.plan_id,s.w);
   s.op={file_path:s.f,action:'replace_lines',line_start:1,line_end:1,shift_mode:'absolute',anchor_text:'OBEN',content:'[SPAET]'};
   await plan(s.w,[s.op]);ok((await commit(s.p.plan_id,s.o)).success,'inaktiver Wartender hindert ersten Commit nicht');
   const z=await attempt(()=>add(s.p.plan_id,s.w,[s.op]));
   ok(!z.success&&z.error==='late_line_ops_unmappable'&&z.abgelehnte_ops?.[0]?.aendernde_ops?.length,'unmappable nennt Verursacher',z);
   ok(occurrences(await read(s.f),'[OWNER-'+s.n+']')===1&&occurrences(await read(s.f),'[SPAET]')===0,'später Fehler mutiert nichts');
   return {plan_id:s.p.plan_id,error:z.error,details:z.abgelehnte_ops};
  });
 await test('9 Retry nach verlorener Antwort, commit doppelt',
  'identische coedit_add-Wiederholung nicht erneut anhängen, keine doppelte Version/Marke',async()=>{
   const s=await scenario(),first=await add(s.p.plan_id,s.w,[s.op]),retry=await add(s.p.plan_id,s.w,[s.op]);
   ok(first.appended_ops===1&&retry.appended_ops===0&&retry.already_consumed_ops===1,'Retry dedupliziert',retry);
   await ready(s.p.plan_id,s.w);const firstCommit=await commit(s.p.plan_id,s.o);
   const before=(await pool.query('SELECT count(*)::int n FROM file_versions WHERE project=$1 AND file_path=$2',[project,s.f])).rows[0].n;
   const secondCommit=await attempt(()=>commit(s.p.plan_id,s.o));
   const after=(await pool.query('SELECT count(*)::int n FROM file_versions WHERE project=$1 AND file_path=$2',[project,s.f])).rows[0].n;
   ok(firstCommit.success&&before===after,'zweiter Commit erzeugt keine Version',{firstCommit,secondCommit,before,after});
   ok(occurrences(await read(s.f),'[BEITRAG-'+s.n+']')===1,'Retry-Marke genau einmal');
   return {plan_id:s.p.plan_id,retry,secondCommit,versionsBefore:before,versionsAfter:after};
  });
 await test('10 direkter Schreibweg auf reservierte Datei (REST)',
  'CE2 erlaubt mit reservation_hint; veralteter Plan überschreibt direkte Marke nicht',async()=>{
   const f='direkt.txt',o=project+'direkt-owner',w=project+'direkt-writer';await seed(f);
   await R.addFileReservations({project,agentId:o,filePaths:[f]});
   const p=await plan(o,[sr(f,'OBEN','[DIREKT-OWNER]')]);
   const direct=await attempt(()=>rpc(w,{action:'search_replace',file_path:f,search:'UNTEN',replace:'[DIREKT-WRITER]'}));
   ok(direct.success&&direct.reservation_hint?.files?.some(x=>x.file_path===f),'Direktweg erlaubt mit Hinweis',direct);
   const stale=await attempt(()=>commit(p.plan_id,o));
   ok(!stale.success&&occurrences(await read(f),'[DIREKT-WRITER]')===1,'alter Plan überschreibt direkte Marke nicht',stale);
   ok(stale.status==='stale'&&/neu plan/.test(stale.message),'stale nennt neuen Plan statt plan_update',stale);
   const rejected=await attempt(()=>B.replanBatch({project,plan_id:p.plan_id,agent_id:o,ops:[sr(f,'OBEN','[DIREKT-OWNER]')]}));
   ok(!rejected.success&&/nicht offen/.test(rejected.error),'stale ist Endzustand',rejected);
   const p2=await plan(o,[sr(f,'OBEN','[DIREKT-OWNER]')]);
   ok(p2.plan_id!==p.plan_id,'Neuplan hat neue ID',p2);
   ok((await commit(p2.plan_id,o)).success,'Owner neu geplant');
   const text=await read(f);for(const m of ['[DIREKT-OWNER]','[DIREKT-WRITER]'])ok(occurrences(text,m)===1,'direkter Weg Marke genau einmal '+m,text);
   return {old:p.plan_id,current:p2.plan_id,directAllowed:direct.success,hint:direct.reservation_hint,stale:stale.error,stale_message:stale.message,plan_update:rejected.error};
  });
 await test('11 zweiter Plan desselben Agenten gleichzeitig',
  'eigene disjunkte Ops hängen am ersten Plan; kein zweiter konkurrierender Plan',async()=>{
   const f='eigene-parallel.txt',a=project+'parallel';await seed(f);
   const first=await plan(a,[sr(f,'OBEN','[EIGEN-0]')]);
   // 0f12acee: echten NOWAIT-Retry erzwingen; kein gemocktes PG-Ergebnis, Zielzeile real gesperrt.
   const lock=await pool.connect();let two;const lockedAt=Date.now();
   try{
    await lock.query('BEGIN');await lock.query('SELECT id FROM file_batch_plans WHERE id=$1::bigint FOR UPDATE',[first.plan_id]);
    const parallel=Promise.allSettled([plan(a,[sr(f,'MITTE','[EIGEN-1]')]),plan(a,[sr(f,'UNTEN','[EIGEN-2]')])]);
    await new Promise(r=>setTimeout(r,1000));await lock.query('COMMIT');const attempts=await parallel;
    const rejected=attempts.find(x=>x.status==='rejected');if(rejected)throw rejected.reason;two=attempts.map(x=>x.value);
   }finally{await lock.query('ROLLBACK');lock.release();}
   ok(Date.now()-lockedAt>=1000,'Parallelplanung über echten gesperrten Zielplan wiederholt');
   ok(two.every(p=>p.plan_id===first.plan_id&&p.merged_into?.some(x=>x.plan_id===first.plan_id)),'beide hängen am selben eigenen Plan',two);
   const st=await state(first.plan_id);ok(st.ops.length===3,'keine Op durch Parallelplanung verloren',st);
   ok((await commit(first.plan_id,a)).success,'gemeinsamer eigener Commit');
   for(const m of ['[EIGEN-0]','[EIGEN-1]','[EIGEN-2]'])ok(occurrences(await read(f),m)===1,'eigene parallele Marke einmal '+m);
   return {plan_id:first.plan_id,merged:two.map(x=>x.merged_into),ops:st.ops.length,forced_target_lock_ms:1000,elapsed_ms:Date.now()-lockedAt};
  });
 releaseLoad();await loadJob;await crashJob;
 await test('Endzustand vor Fixture-Cleanup',
  'keine offenen/conflict Pläne, keine ungelösten Waits; Tabellenfälle liefen unter Last',async()=>{
   const plans=(await pool.query("SELECT id::text,status::text,owner_agent_id FROM file_batch_plans WHERE project=$1 AND status IN ('open','conflict')",[project])).rows;
   // closeOrphanCarriers5865: Historien-Waits an abgeschlossenen Zielen bleiben für Spätbeiträge erhalten.
   const waits=(await pool.query("SELECT w.wait_token::text,w.source_plan_id::text,w.primary_plan_id::text,w.status::text FROM file_batch_waits w LEFT JOIN file_batch_plans t ON t.id=w.primary_plan_id WHERE w.project=$1 AND w.status IN ('waiting','linked','conflict') AND (w.primary_plan_id IS NULL OR t.id IS NULL OR t.status IN ('open','conflict'))",[project])).rows;
   const history=(await pool.query("SELECT w.wait_token::text,w.status::text,s.status::text carrier_status,t.status::text target_status FROM file_batch_waits w JOIN file_batch_plans s ON s.id=w.source_plan_id JOIN file_batch_plans t ON t.id=w.primary_plan_id WHERE w.project=$1 AND w.status IN ('waiting','linked','conflict') AND t.status='committed'",[project])).rows;
   ok(history.every(w=>w.carrier_status!=='open'),'historische Spätbeitrags-Waits haben geschlossene Träger',history);
   ok(plans.length===0&&waits.length===0,'keine Plan-/Wait-Leichen VOR Cleanup',{plans,waits});
   ok(rows.filter(x=>Object.hasOwn(x,'load_at_start')).every(x=>x.loadRunning),'Fehlerfälle unter Last gestartet',rows.map(x=>({fall:x.fall,loadRunning:x.loadRunning})));
   return {plans:plans.length,unresolved_waits:waits.length,retained_history:history,project};
  });
}catch(e){errors++;evidence({fall:'ABBRUCH',error:e.stack});}
finally{
 releaseLoad?.();if(loadJob)await loadJob.catch(()=>{});if(crashJob)await crashJob.catch(()=>{});
 console.log('ERGEBNIS_TABELLE '+JSON.stringify(rows));
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]);
 for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 await pool.query('DELETE FROM plans WHERE project=$1',[project]);await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await app.close();await D.closePool();
 if(inheritedWindow!==undefined)process.env.SYNAPSE_COEDIT_AKTIV_MIN=inheritedWindow;
}
console.log((errors?'FEHLER ':'BESTANDEN ')+checks+' P22-T198 Agentenfehler checks; Fehler='+errors);
process.exit(errors?1:0);
