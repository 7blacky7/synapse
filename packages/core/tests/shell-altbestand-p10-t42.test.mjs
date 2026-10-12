/** P10-T42 Phase 1+2: TestDB/Fake-Jev, niemals Live-Daten. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const {getPool,closePool}=await import('../dist/db/client.js');
const pool=getPool(),project='test-p10-t42-'+randomUUID(),secret='private-fixture-'+randomUUID();
try{
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,'test-host','/virtual/test']);
 const fixtures=['TOKEN='+secret,'TOKEN='+secret,'PUBLIC_FLAG=ordinary-public-long-value','Example: TOKEN=example-password','unclear AUTH=ambiguous'];
 for(const output of fixtures)await pool.query("INSERT INTO shell_jobs(project,command,status,output,tail) VALUES($1,'own-fixture','done',$2,'[]'::jsonb)",[project,output]);
 const before=(await pool.query('SELECT id,output FROM shell_jobs WHERE project=$1 ORDER BY created_at,id',[project])).rows;
 assert(before.some(r=>r.output.includes(secret)),'Positivkontrolle: alter Klartext vor Auswertung vorhanden');
 console.log('OK Positivkontrolle Altbestand enthält Test-Klartext');
 const mod=await import('../dist/services/shell-altbestand.js');
 const rows=before.map(r=>({tabelle:'shell_jobs',id:r.id,project,daten:{output:r.output}}));
 const gruppen=mod.gruppiereShellAltbestand(rows,[secret,'ordinary-public-long-value']);
 assert(gruppen.length<rows.length,'gleicher Literal-Hash/Feld/Fundart verdichtet gleiche Fälle');
 assert(!JSON.stringify(gruppen).includes(secret),'Gruppen enthalten kein Literal');
 assert(gruppen.some(g=>g.bezuege.length===2));
 const sent=[];
 const fake=async a=>{
   sent.push(a);
   assert(!JSON.stringify(a).includes(secret));assert(!JSON.stringify(a).includes('example-password'));
   const s=a.state,choice=s.fenster.includes('Example:')?'beispiel':s.name==='PUBLIC_FLAG'?'falsch':s.name==='AUTH'?'keine_passt':'geheimnis';
   return {ok:true,daten:{answers:{bewertung:{choice,confidence:0.95}}},dauer_ms:0,modell:'fake',kosten:{usd:0.00001,quelle:'antwort',input_tokens:200,output_tokens:0}};
 };
 const r=await mod.bewerteShellAltbestand(gruppen,{project,agent_id:'sol-1-test'},{rufeJev:fake});
 assert.equal(r.status,'fertig');assert.equal(sent.length,gruppen.filter(g=>!mod.shellAltIstDeterministisch(g)).length,'jede Jev-pflichtige Gruppe, deterministische ohne Aufruf');
 assert(r.bewertungen.some(b=>b.bewertung==='geheimnis'));
 assert(r.bewertungen.some(b=>b.bewertung==='beispiel'));
 assert(r.bewertungen.some(b=>b.bewertung==='falsch'));
 assert(r.bewertungen.some(b=>b.bewertung==='offen'));
 assert.deepEqual((await pool.query('SELECT id,output FROM shell_jobs WHERE project=$1 ORDER BY created_at,id',[project])).rows,before,'Phase1+2 schreibt/markiert/bereinigt nichts');
 const getrennt=mod.gruppiereShellAltbestand([{tabelle:'shell_jobs',id:'eigenes-id',project,daten:{output:secret,tail:[secret]}}],[secret]);
 assert.equal(getrennt.length,2,'verschiedene Felder bleiben getrennte Gruppen');
 const parsed=mod.gruppiereShellAltbestand([{tabelle:'tool_calls',id:'eigenes-json',project,daten:{result:JSON.stringify({id:'11111111-1111-4111-8111-111111111111',output:'TOKEN='+secret})}}],[secret,'11111111-1111-4111-8111-111111111111']);
 assert(parsed.every(g=>!g.feld.endsWith('.id')),'opaque Result-Metadaten werden wie gemeinsame Maske behandelt');
 const low=await mod.bewerteShellAltbestand(gruppen,{project},{rufeJev:async()=>({ok:true,daten:{answers:{bewertung:{choice:'geheimnis',confidence:0.2}}},dauer_ms:0,modell:'fake',kosten:{usd:0,quelle:'keine',input_tokens:null,output_tokens:null}})});
 assert(low.bewertungen.every(b=>b.grund==='deterministisch'?b.bewertung==='geheimnis':b.bewertung==='offen'));
 let pause=false;
 const paused=await mod.bewerteShellAltbestand(gruppen,{project},{rufeJev:async()=>({ok:false,grund:'budget',message:'Fake-Budget-Pause'}),beiBudget:()=>{pause=true;}});
 assert.equal(paused.status,'budget_pause');assert.equal(paused.verbleibend,gruppen.length-paused.bewertungen.length);assert(pause,'Budget-Bremse explizit gemeldet');
 const maskierte=rows.map(row=>({...row,daten:{output:row.daten.output.replaceAll(secret,'[WERT]')}})).filter(row=>row.daten.output==='TOKEN=[WERT]');
 assert.equal(mod.gruppiereShellAltbestand(maskierte,[secret]).length,0,'zweiter Lauf bereits maskierter Zeilen erzeugt keine Kandidaten');
 const kosten=mod.schaetzeShellAltbestandKosten(gruppen);
 assert.equal(kosten.gruppen,gruppen.length);assert(kosten.usd_geschaetzt>=0);assert.equal(kosten.kostentor,false);

 const kontexte=mod.gruppiereShellAltbestand([
  {tabelle:'shell_jobs',id:'real',project,daten:{output:'TOKEN='+secret}},
  {tabelle:'shell_jobs',id:'example',project,daten:{output:'Example: TOKEN='+secret}},
 ],[secret]);
 assert.equal(kontexte.length,2,'verschiedene maskierte Kontexte sind verschiedene Fälle, auch bei gleichem Literal/Feld');
 const keySecret=mod.gruppiereShellAltbestand([{tabelle:'tool_calls',id:'key-fixture',project,daten:{result:{[secret]:secret}}}],[secret]);
 assert(!JSON.stringify(keySecret).includes(secret),'Geheimnis in Feldnamen/Bezugspfaden ebenfalls nicht exportieren');
 const ambig=mod.gruppiereShellAltbestand([{tabelle:'shell_jobs',id:'ambig',project,daten:{output:'x '+secret+' y '+secret+' y '}}],[secret]);
 assert(ambig.every(g=>g.fundart==='literal'),'präzise Katalogspannen lösen früher mehrdeutige Anker');
 const ung=await mod.bewerteShellAltbestand(ambig,{project},{rufeJev:fake});
 assert(ung.bewertungen.every(b=>b.bewertung==='geheimnis'),'eindeutige bestätigte Literale sind jetzt zuordenbar');
 const viele=mod.gruppiereShellAltbestand(Array.from({length:1501},(_,i)=>({tabelle:'shell_jobs',id:'many-'+i,project,daten:{output:'log TOKEN=fake-value-'+i}})),[]);
 let vieleCalls=0;
 const alle=await mod.bewerteShellAltbestand(viele,{project},{rufeJev:async a=>{vieleCalls++;return fake(a);}});
 assert.equal(vieleCalls,1501);assert.equal(alle.bewertungen.length,1501,'kein 200/500/1000-Gruppenlimit');
 const original=gruppen[0].kontext;gruppen[0].kontext=secret;
 await assert.rejects(()=>mod.bewerteShellAltbestand(gruppen,{project},{rufeJev:fake}),'geänderte/ungesicherte Gruppen werden vor externem Aufruf abgewiesen');
 gruppen[0].kontext=original;

 const zeitRows=[
  {...rows[0],gespeichert_am:'2026-10-12T14:13:59Z'},
  {...rows[1],gespeichert_am:'2026-10-12T14:14:00Z',daten:{output:'irreversibel [WERT]'}},
  {...rows[2],gespeichert_am:'2026-10-12T15:00:00Z'},
  {...rows[3],gespeichert_am:null},
 ];
 const fenster=mod.zaehleShellUebermaskierungsFenster(zeitRows,{von:'2026-10-12T14:14:00Z',bis:'2026-10-12T15:00:00Z'});
 assert.equal(fenster.shell_jobs.zeilen_im_fenster,1);assert.equal(fenster.shell_jobs.mit_platzhaltern,1);
 assert.equal(fenster.shell_jobs.zeit_unbekannt,1);assert.equal(fenster.nicht_reparierbar,true);
 assert.throws(()=>mod.zaehleShellUebermaskierungsFenster(zeitRows,{von:'invalid',bis:'2026-10-12T15:00:00Z'}));

 console.log(JSON.stringify({fixture_rows:rows.length,fixture_groups:gruppen.length,extra_groups_evaluated:vieleCalls,...kosten}));

 console.log('OK Gruppierung/Felder, vollständig maskierter Jev-Kontext, alle Gruppen, Tor/keine passt/Budget, Kosten informativ, TestDB unverändert');
}finally{
 await pool.query('DELETE FROM shell_jobs WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await closePool();
}
process.exit(0);
