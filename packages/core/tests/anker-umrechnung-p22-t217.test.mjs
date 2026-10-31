/**
 * P22-T217 (Stresstest P22-T214 B2, Befund ba3ffd70): Anker-Umrechnung veralteter replace_lines/delete_lines im Plan
 * (anker-umrechnung.ts, Einbindung planBatch in file-batch.ts), Produkt-Schalter anker_umrechnung (Standard AUS).
 * Nachgestellt wie im Stresstest: ein fremder Commit fuegt 3 Zeilen oberhalb ein, danach plant der Agent mit der alten
 * Zeilennummer und eindeutigem anchor_text.
 *  A1 Schalter AUS: anchor mismatch wie bisher, ohne Fundstellen-Zusatz (Altverhalten).
 *  E1 Schalter EIN: eindeutiger Anker -> Op verschoben (Block line_start..line_end, Laenge bleibt), umgerechnet
 *     {von, nach, grund:'anker_eindeutig'}, gespeicherte Op traegt die neue Zeile, commit schreibt an der richtigen Stelle.
 *  E2 delete_lines eindeutig verschoben; anchor_contains statt anchor_text.
 *  E3 mehrdeutig -> plan_failed, Meldung nennt Anzahl und Fundstellen (max. 5, Rest gezaehlt).
 *  E4 nicht gefunden -> plan_failed mit Hinweis 'nicht gefunden'.
 *  E5 Anker passt an der angegebenen Zeile -> keine Umrechnung.
 *  U1 rechneAnkerUm rein: Ganzdatei-Op auf derselben Datei und shift_mode absolute -> keine Umrechnung.
 *  P1/P2 (Abnahme codex-rea4, thought ed19eafd): plan_update IM SELBEN Plan (replanBatch -> updatePlanInPlace) mit op_index
 *     auf replace_lines mit veralteter Zeile: AUS -> Fehler anchor mismatch ohne Zusatz, Plan unveraendert; EIN -> umgerechnet,
 *     gespeicherte Op verschoben, commit an der richtigen Stelle.
 * ABSICHERUNG: nur synapse_test, eigenes Wegwerf-Projekt, Schalter nur auf Projektebene (andere Agenten testen parallel).
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/anker-umrechnung-p22-t217.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_W1B_GATE_TTL_MS:'0'});
const B=await import('../dist/services/file-batch.js');
const AU=await import('../dist/services/anker-umrechnung.js');
const PS=await import('../dist/services/agent-profil-schalter.js');
const D=await import('../dist/db/client.js'),pool=D.getPool();
const project='p22-t217-'+randomUUID(),agent=project+'-agent',fremd=project+'-fremd',rows=[];
let errors=0,checks=0;
const short=x=>JSON.stringify(x)?.slice(0,1500);
function ok(v,label,ist){checks++;assert.ok(v,'P22-T217 '+label+' erwartet=true ist='+short(ist??v));}
const plan=(a,ops)=>B.planBatch({project,agent_id:a,ops});
const versuch=async(a,ops)=>{try{return await plan(a,ops);}catch(e){if(!e.plan_id)throw e;return {fehler:true,plan_id:e.plan_id,message:e.message,failed:e.failed_ops??e.details?.failed_ops,previews:e.previews??e.details?.previews};}};
const commit=(p,a)=>B.commitBatch({plan_id:p,agent_id:a});
const read=async f=>(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[project,f])).rows[0]?.content;
const gespeichert=async p=>(await pool.query('SELECT ops FROM file_batch_plans WHERE id=$1::bigint',[p])).rows[0]?.ops;
const cancel=p=>pool.query("UPDATE file_batch_plans SET status='cancelled' WHERE id=$1::bigint",[p]);
const schalter=aktiv=>PS.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'anker_umrechnung',aktiv,grund:'P22-T217 Test'},{system:'user'});
const fehlerText=r=>(r.failed?.[0]?.error)??(r.previews?.find(p=>p&&!p.ok)?.error)??r.message??'';
let seq=0;
/** Datei wie im Stresstest: Kopfzeile + z01..z12; danach fremder Commit mit 3 Zeilen ganz oben -> z10 von 11 auf 14. */
async function spaeteDatei(){
 const f='spaet-'+(++seq)+'.ts';
 const zeilen=['// kopf',...Array.from({length:12},(_,i)=>`export const z${String(i+1).padStart(2,'0')} = ${i+1};`)];
 const p=await plan(fremd,[{file_path:f,action:'create',content:zeilen.join('\n')+'\n'}]);ok((await commit(p.plan_id,fremd)).success,'Fixture '+f);
 const q=await plan(fremd,[{file_path:f,action:'insert_after',after_line:0,content:'// neu1\n// neu2\n// neu3'}]);ok((await commit(q.plan_id,fremd)).success,'fremder Commit '+f);
 return f;
}
/** Offener Plan ohne gescheiterte Op (-> plan_update laeuft im selben Plan) plus spaete Datei fuer die Ersatz-Op an op_index 0. */
async function updateFall(){
 const f=await spaeteDatei(),g='anker-'+(++seq)+'.txt';
 const c=await plan(fremd,[{file_path:g,action:'create',content:'A\nB\n'}]);ok((await commit(c.plan_id,fremd)).success,'Fixture '+g);
 const p=await plan(agent,[{file_path:g,action:'search_replace',search:'A',replace:'A2'}]);
 return {f,plan_id:p.plan_id};
}
const ersatzZ10=f=>[{file_path:f,action:'replace_lines',line_start:11,line_end:11,content:'export const z10 = 100;',anchor_text:'export const z10 = 10;'}];
async function test(fall,expected,fn){
 const start=Date.now();
 try{const actual=await fn();const row={fall,expected,actual,verdict:'PASS',ms:Date.now()-start};rows.push(row);console.log('TABELLE '+JSON.stringify(row));}
 catch(e){errors++;const row={fall,expected,actual:e.stack,verdict:'FAIL',ms:Date.now()-start};rows.push(row);console.error('TABELLE '+JSON.stringify(row));}
}
try{
 ok((await pool.query('SELECT current_database() db')).rows[0].db==='synapse_test','DB-Ziel');
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t217','/tmp']);

 await test('A1 Schalter AUS','anchor mismatch at line 11 wie bisher, kein anker_umrechnung-Zusatz, Stand lesbar AUS/standard',async()=>{
  const s=await AU.leseAnkerUmrechnung(project);ok(s.wirksam===false&&s.quelle==='standard','Standard AUS',s);
  const f=await spaeteDatei();
  const r=await versuch(agent,[{file_path:f,action:'replace_lines',line_start:11,line_end:11,content:'export const z10 = 100;',anchor_text:'export const z10 = 10;'}]);
  const t=fehlerText(r);
  ok(r.fehler&&/anchor mismatch at line 11/.test(t)&&!t.includes('anker_umrechnung'),'Altverhalten',r);
  await cancel(r.plan_id);return {stand:s,fehler:t.slice(0,160)};
 });

 await test('P1 plan_update im selben Plan, Schalter AUS','Fehler anchor mismatch ohne anker_umrechnung-Zusatz, Plan unveraendert',async()=>{
  const u=await updateFall();
  let fehler='';
  try{await B.replanBatch({project,plan_id:u.plan_id,agent_id:agent,op_index:0,ops:ersatzZ10(u.f)});}catch(e){fehler=e.message;}
  ok(/anchor mismatch/.test(fehler)&&!fehler.includes('anker_umrechnung'),'Altverhalten',fehler);
  const ops=await gespeichert(u.plan_id);ok(ops.length===1&&ops[0].action==='search_replace','Plan unveraendert',ops);
  await cancel(u.plan_id);return {fehler:fehler.slice(0,200)};
 });

 await schalter(true);PS.leereAusweisKernCache();

 await test('E1 eindeutig verschoben (replace_lines Block)','Block 11-12 -> 14-15, umgerechnet {von:11,nach:14}, gespeicherte Op 14-15, commit an Zeile 14',async()=>{
  const s=await AU.leseAnkerUmrechnung(project);ok(s.wirksam===true&&s.quelle==='produkt-schalter'&&s.ebene==='projekt','Schalter EIN Projekt',s);
  const f=await spaeteDatei();
  const r=await versuch(agent,[{file_path:f,action:'replace_lines',line_start:11,line_end:12,content:'export const z10 = 100;\nexport const z11 = 110;',anchor_text:'export const z10 = 10;'}]);
  ok(!r.fehler,'kein plan_failed',r);
  const u=r.previews[0].umgerechnet;ok(u&&u.von===11&&u.nach===14&&u.grund==='anker_eindeutig','umgerechnet gemeldet',r.previews[0]);
  const ops=await gespeichert(r.plan_id);ok(ops[0].line_start===14&&ops[0].line_end===15,'gespeicherte Op verschoben',ops[0]);
  ok((await commit(r.plan_id,agent)).success,'commit');
  const z=(await read(f)).split('\n');
  ok(z[13]==='export const z10 = 100;'&&z[14]==='export const z11 = 110;'&&z[12]==='export const z09 = 9;'&&z[15]==='export const z12 = 12;','Inhalt an der richtigen Stelle',z);
  return {umgerechnet:u,zeilen:z.slice(12,16)};
 });

 await test('E2 delete_lines mit anchor_contains','delete_lines 11 (anchor_contains z10) -> Zeile 14 geloescht',async()=>{
  const f=await spaeteDatei();
  const r=await versuch(agent,[{file_path:f,action:'delete_lines',line_start:11,line_end:11,anchor_contains:'z10 ='}]);
  ok(!r.fehler&&r.previews[0].umgerechnet?.nach===14,'verschoben',r);
  ok((await commit(r.plan_id,agent)).success,'commit');
  const t=await read(f);ok(!t.includes('z10 =')&&t.includes('z09 =')&&t.includes('z11 ='),'nur z10 weg',t);
  return {umgerechnet:r.previews[0].umgerechnet};
 });

 await test('E3 mehrdeutig','plan_failed, Meldung: 7x, Fundstellen Zeile 2..6 und 2 weitere; Datei unveraendert',async()=>{
  const f='mehrdeutig.ts',inhalt=['kopf',...Array(7).fill('x();'),'fuss'].join('\n');
  const p=await plan(fremd,[{file_path:f,action:'create',content:inhalt}]);await commit(p.plan_id,fremd);
  const r=await versuch(agent,[{file_path:f,action:'replace_lines',line_start:1,line_end:1,content:'y();',anchor_text:'x();'}]);
  const t=fehlerText(r);
  ok(r.fehler&&/anchor mismatch at line 1/.test(t)&&t.includes('7x')&&t.includes('Fundstellen Zeile 2, 3, 4, 5, 6')&&t.includes('und 2 weitere'),'Fundstellen genannt',t);
  ok(await read(f)===inhalt,'nichts geschrieben');await cancel(r.plan_id);
  return {fehler:t.slice(t.indexOf('anker_umrechnung'))};
 });

 await test('E4 nicht gefunden','plan_failed mit Hinweis nicht gefunden',async()=>{
  const f=await spaeteDatei();
  const r=await versuch(agent,[{file_path:f,action:'replace_lines',line_start:11,line_end:11,content:'q',anchor_text:'GIBTSNICHT'}]);
  const t=fehlerText(r);ok(r.fehler&&/anchor mismatch/.test(t)&&t.includes('nicht gefunden'),'Hinweis',t);
  await cancel(r.plan_id);return {fehler:t.slice(t.indexOf('anker_umrechnung'))};
 });

 await test('E5 Anker passt an der Zeile','keine Umrechnung, kein Feld umgerechnet',async()=>{
  const f=await spaeteDatei();
  const r=await versuch(agent,[{file_path:f,action:'replace_lines',line_start:14,line_end:14,content:'export const z10 = 1000;',anchor_text:'export const z10 = 10;'}]);
  ok(!r.fehler&&r.previews[0].umgerechnet===undefined,'unveraendert',r.previews?.[0]);
  await cancel(r.plan_id);return {preview:r.previews[0].context};
 });

 await test('P2 plan_update im selben Plan, Schalter EIN','in_place, previews[0].umgerechnet {von:11,nach:14}, gespeicherte Op 14, commit an Zeile 14',async()=>{
  const u=await updateFall();
  const r=await B.replanBatch({project,plan_id:u.plan_id,agent_id:agent,op_index:0,ops:ersatzZ10(u.f)});
  ok(r.in_place===true&&r.plan_id===u.plan_id,'im selben Plan',r);
  const um=r.previews[0]?.umgerechnet;ok(um&&um.von===11&&um.nach===14&&um.grund==='anker_eindeutig','umgerechnet gemeldet',r.previews);
  const ops=await gespeichert(u.plan_id);ok(ops.length===1&&ops[0].line_start===14&&ops[0].line_end===14,'gespeicherte Op verschoben',ops);
  ok((await commit(u.plan_id,agent)).success,'commit');
  const z=(await read(u.f)).split('\n');ok(z[13]==='export const z10 = 100;'&&z[12]==='export const z09 = 9;','Inhalt an der richtigen Stelle',z);
  return {umgerechnet:um};
 });

 await test('U1 rechneAnkerUm Ausschluesse','Ganzdatei-Op derselben Datei und shift_mode absolute: Op unveraendert',async()=>{
  const inhalte=new Map([['a.ts','x\ny\nANKER\n'],['b.ts','x\ny\nANKER\n']]);
  const op={file_path:'a.ts',action:'replace_lines',line_start:1,line_end:1,content:'n',anchor_text:'ANKER'};
  const frei=AU.rechneAnkerUm([op],inhalte);ok(frei.umgerechnet[0]?.nach===3&&frei.ops[0].line_start===3,'Positivkontrolle',frei);
  const ganz=AU.rechneAnkerUm([{file_path:'a.ts',action:'search_replace',search:'x',replace:'z'},{file_path:'a.ts',action:'update',content:'neu',anchor_text:'x'},op],inhalte);
  ok(ganz.ops[2]===op&&Object.keys(ganz.umgerechnet).length===0,'Ganzdatei-Op',ganz);
  const abs=AU.rechneAnkerUm([{...op,file_path:'b.ts',shift_mode:'absolute'}],inhalte);
  ok(Object.keys(abs.umgerechnet).length===0,'absolute',abs);
  return {frei:frei.umgerechnet};
 });
}catch(e){errors++;console.error('ABBRUCH '+e.stack);}
finally{
 console.log('ERGEBNIS_TABELLE_T217 '+JSON.stringify(rows));
 await pool.query('DELETE FROM agent_profil_schalter WHERE project=$1',[project]);
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]);
 for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await D.closePool();
}
console.log((errors?'FEHLER ':'BESTANDEN ')+checks+' P22-T217 checks; Fehler='+errors);
process.exit(errors?1:0);
