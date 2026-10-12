/** P10-T42 Phase 3: eigene Testdaten/Fake-Jev, keine Live-DB. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const mod=await import('../dist/services/shell-altbestand-persistenz.js');
const pure=await import('../dist/services/shell-altbestand.js');
const {getPool,closePool}=await import('../dist/db/client.js');
const pool=getPool(),project='test-t42-persist-'+randomUUID(),secret='real-fixture-'+randomUUID(),example='example-fixture-long',publicValue='public-value';
const hash=s=>createHash('sha256').update(s).digest('hex');
try{
 await pool.query(mod.SHELL_ALT_SCHEMA_SQL);
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,'test-host','/virtual/test']);
 const output='TOKEN='+secret+'\nExample: TOKEN='+example+'\nPUBLIC_FLAG='+publicValue;
 const job=(await pool.query("INSERT INTO shell_jobs(project,command,status,output,tail) VALUES($1,'fixture','done',$2,'[]') RETURNING id",[project,output])).rows[0].id;
 const call=(await pool.query("INSERT INTO tool_calls(project,tool_name,action,result,args_preview,ok) VALUES($1,'shell','get',$2,$3,true) RETURNING id",[project,JSON.stringify({id:'opaque-id',output:'TOKEN='+secret}), 'Example: TOKEN='+example])).rows[0].id;
 const pending=(await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES($1,'pending-fixture','pending',$2) RETURNING id",[project,'TOKEN='+secret])).rows[0].id;
 const read=async()=>[...await mod.ladeShellAltZeilen('shell_jobs',project),...await mod.ladeShellAltZeilen('tool_calls',project)];
 const before=await read(),werte=[secret,example,publicValue];let calls=0;
 const fake=async a=>{
  calls++;const text=JSON.stringify(a);for(const value of werte)assert(!text.includes(value),'niemals Klartext an Jev');
  const s=a.state,choice=s.wertlaenge===secret.length?'geheimnis':s.wertlaenge===publicValue.length?'falsch':'beispiel';
  return {ok:true,daten:{answers:{bewertung:{choice,confidence:0.95}}},dauer_ms:0,modell:'fake',kosten:{usd:0.00001,quelle:'antwort',input_tokens:200,output_tokens:0}};
 };
 const marked=await mod.markiereShellAltbestand(before,werte,{project,agent_id:'sol-1-test'},{rufeJev:fake});
 assert.equal(marked.status,'fertig');assert(calls>0);
 assert.deepEqual(await read(),before,'Markierung verändert keine Quellzeile');
 const oldCalls=calls;await mod.markiereShellAltbestand(before,werte,{project,agent_id:'sol-1-test'},{rufeJev:fake});assert.equal(calls,oldCalls,'gültige Klassifikation idempotent wiederverwenden');
 const marker=(await pool.query('SELECT * FROM shell_altbestand_gruppen WHERE gruppen_id IN (SELECT gruppen_id FROM shell_altbestand_bezuege WHERE project=$1)',[project])).rows;
 for(const value of werte)assert(!JSON.stringify(marker).includes(value),'Marker ohne Klartext');
 const preview=await mod.trockenlaufShellAltbestand(project,async p=>{assert.equal(p,project);return werte;});assert.equal(preview.aenderungen,2);assert(preview.laufend>=1);
 assert.deepEqual(await read(),before,'Trockenlauf bleibt read-only');
 const applied=await mod.maskiereShellAltbestand(project,werte);
 assert.equal(applied.aenderungen,2);assert(applied.maskiert>=2);
 const after=await read(),j=after.find(r=>r.id===job).daten;
 assert(!j.output.includes(secret));assert(j.output.includes(example));assert(j.output.includes(publicValue));assert.deepEqual(j.tail,[],'unberührtes JSONB-Array bleibt Array');
 const c=after.find(r=>r.tabelle==='tool_calls'&&r.id===String(call)).daten;
 assert.equal(JSON.parse(c.result).id,'opaque-id');assert(!c.result.includes(secret));assert(c.args_preview.includes(example));
 assert(after.find(r=>r.id===pending).daten.output.includes(secret),'laufende Jobs unverändert');
 assert.equal((await mod.maskiereShellAltbestand(project,werte)).aenderungen,0,'zweiter Lauf 0 Änderungen');
 // Drift zwischen Markierung und Schreiben: aktuelle fremde Änderungen nicht überschreiben.
 const drift=(await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES($1,'drift','done',$2) RETURNING id",[project,'TOKEN='+secret])).rows[0].id;
 await mod.markiereShellAltbestand((await read()).filter(r=>r.id===drift),werte,{project},{rufeJev:fake});
 await pool.query('UPDATE shell_jobs SET output=$2 WHERE id=$1',[drift,'changed-public']);
 const dry=await mod.trockenlaufShellAltbestand(project,async p=>{assert.equal(p,project);return werte;});assert(dry.geaendert>=1);
 await mod.maskiereShellAltbestand(project,werte);assert.equal((await read()).find(r=>r.id===drift).daten.output,'changed-public');
 // Gate/Mehrdeutigkeit bleibt offen, Budgetpause ist explizit.
 const ambiguous={tabelle:'shell_jobs',id:'fake-ambig',project,daten:{output:'x '+secret+' y '+secret+' y '}};
 const groups=pure.gruppiereShellAltbestand([ambiguous],werte);
 assert(groups.some(g=>g.fundart==='offene_zuordnung'));
 assert.equal(pure.planeShellAltbestand([ambiguous],werte,groups.map(g=>({gruppe:g.id,bewertung:'geheimnis',confidence:0.99,grund:'fake'}))).length,0);
 const low=pure.gruppiereShellAltbestand([{...ambiguous,daten:{output:'TOKEN='+secret}}],werte);
 assert.equal(pure.planeShellAltbestand([{...ambiguous,daten:{output:'TOKEN='+secret}}],werte,low.map(g=>({gruppe:g.id,bewertung:'geheimnis',confidence:0.2,grund:'fake'}))).length,0);

 // Numerische/Objekt-Felder und JSON-Strings mit Steuerdaten selektiv.
 const shapes=[
  {tabelle:'tool_calls',id:'pure-json',project,daten:{result:JSON.stringify({id:'typed-id',output:'TOKEN='+secret,example:'TOKEN='+example})}},
  {tabelle:'shell_jobs',id:'pure-array',project,daten:{tail:['TOKEN='+secret,'Example: TOKEN='+example]}},
  {tabelle:'tool_calls',id:'pure-number',project,daten:{result:JSON.stringify({API_TOKEN:1234,keyboard:1234})}},
 ];
 for(const shape of shapes){
  const gs=pure.gruppiereShellAltbestand([shape],werte);
  const ds=gs.map(g=>({gruppe:g.id,bewertung:g.literal_hash===hash(secret)||g.schluessel==='API_TOKEN'?'geheimnis':'beispiel',confidence:0.99,grund:'fake'}));
  const plans=pure.planeShellAltbestand([shape],werte,ds);
  assert.equal(plans.length,1);assert.equal(Object.values(plans[0].maskiert_pro_gruppe).reduce((a,b)=>a+b,0),plans[0].maskiert);
  if(shape.id==='pure-json'){const value=JSON.parse(plans[0].daten.result);assert.equal(value.id,'typed-id');assert(value.example.includes(example));}
  if(shape.id==='pure-number'){const value=JSON.parse(plans[0].daten.result);assert.equal(value.API_TOKEN,'[WERT]');assert.equal(value.keyboard,1234);}
 }
 // Jev-Budget stoppt explizit und behält schon persistierte Ergebnisse.
 const budgetSecret='budget-fake-'+randomUUID();
 const budgetJob=(await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES($1,'budget-fixture','done',$2) RETURNING id",[project,'TOKEN='+budgetSecret])).rows[0].id;
 let paused=false;
 const budget=await mod.markiereShellAltbestand((await read()).filter(r=>r.id===budgetJob),[budgetSecret],{project},{rufeJev:async()=>({ok:false,grund:'budget',message:'fake'}),beiBudget:()=>{paused=true;}});
 assert.equal(budget.status,'budget_pause');assert(paused);assert(budget.verbleibend>0);
 // Transaktion: erzwungener Markerfehler muss auch die Quellenänderung zurückrollen.
 const rollbackId=(await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES($1,'rollback-fixture','done',$2) RETURNING id",[project,'TOKEN='+secret])).rows[0].id;
 await mod.markiereShellAltbestand((await read()).filter(r=>r.id===rollbackId),werte,{project},{rufeJev:fake});
 const schema='t42_'+randomUUID().replaceAll('-','');
 const trigger=schema+'_trg';
 await pool.query('CREATE SCHEMA '+schema);
 try{
  await pool.query('CREATE FUNCTION '+schema+".fail() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN IF NEW.zeilen_id='"+rollbackId+"' AND NEW.status='maskiert' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END; $fixture$");
  await pool.query('CREATE TRIGGER '+trigger+' BEFORE UPDATE ON shell_altbestand_bezuege FOR EACH ROW EXECUTE FUNCTION '+schema+'.fail()');
  await assert.rejects(()=>mod.maskiereShellAltbestand(project,werte),/fixture rollback/);
  assert.equal((await read()).find(r=>r.id===rollbackId).daten.output,'TOKEN='+secret,'Quellenupdate atomar zurückgerollt');
  assert((await pool.query('SELECT status FROM shell_altbestand_bezuege WHERE project=$1 AND zeilen_id=$2',[project,rollbackId])).rows.every(b=>b.status==='markiert'));
 }finally{await pool.query('DROP TRIGGER IF EXISTS '+trigger+' ON shell_altbestand_bezuege');await pool.query('DROP SCHEMA '+schema+' CASCADE');}
 // Vollständiger Projektlauf ohne Limit, danach Cache/Wiederholung.
 const full=await mod.markiereShellAltbestandGesamt({project,agent_id:'sol-1-test'},{rufeJev:fake,ladeWerte:async()=>werte});
 assert.equal(full.status,'fertig');assert.equal(full.geprueft.shell_jobs,(await pool.query('SELECT count(*)::int AS n FROM shell_jobs WHERE project=$1',[project])).rows[0].n);
 const fullCalls=calls;
 const again=await mod.markiereShellAltbestandGesamt({project},{rufeJev:fake,ladeWerte:async()=>werte});assert.equal(again.neue_gruppen,0);assert.equal(calls,fullCalls);
 // Zwei Schreiber: dieselbe Quellenzeile genau einmal ändern.
 const concurrentId=(await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES($1,'concurrent-fixture','done',$2) RETURNING id",[project,'TOKEN='+secret])).rows[0].id;
 await mod.markiereShellAltbestand((await read()).filter(r=>r.id===concurrentId),werte,{project},{rufeJev:fake});
 const concurrent=await Promise.all([mod.maskiereShellAltbestand(project,werte),mod.maskiereShellAltbestand(project,werte)]);
 // Der bisher nur markierte Rollback-Job kann ebenfalls einmal bereinigt werden.
 assert.equal(concurrent.reduce((n,r)=>n+r.aenderungen,0),2);
 assert.equal((await read()).find(r=>r.id===concurrentId).daten.output,'TOKEN=[WERT]');
 const multi={tabelle:'shell_jobs',id:'multi-path',project,daten:{tail:[secret,secret]}};
 const multiGroups=pure.gruppiereShellAltbestand([multi],werte);assert.equal(multiGroups.length,1);
 const multiPlan=pure.planeShellAltbestand([multi],werte,multiGroups.map(g=>({gruppe:g.id,bewertung:'geheimnis',confidence:0.99,grund:'fake'})))[0];
 assert.equal(multiPlan.maskiert,2);assert.deepEqual(Object.values(multiPlan.maskiert_pro_bezug),[1,1]);
 const multiId=(await pool.query("INSERT INTO shell_jobs(project,command,status,tail) VALUES($1,'multi-field-fixture','done',$2::jsonb) RETURNING id",[project,JSON.stringify([secret,secret])])).rows[0].id;
 await mod.markiereShellAltbestand((await read()).filter(r=>r.id===multiId),werte,{project},{rufeJev:fake});
 const multiApplied=await mod.maskiereShellAltbestand(project,werte);assert.equal(multiApplied.maskiert,2);
 const markerCount=(await pool.query('SELECT sum(maskiert)::int AS n FROM shell_altbestand_bezuege WHERE project=$1 AND zeilen_id=$2',[project,multiId])).rows[0].n;
 assert.equal(markerCount,2,'Marker über alle Bezugs-Pfade zählen exakt zwei Ersetzungen');
 console.log('OK Marker ohne Rohwerte; selektiv Geheimnisse, Beispiele/falsche Treffer bleiben; Drift/laufende Jobs sicher; Idempotenz; maskierter Fake-Jev');
}finally{
 const ownGroups=(await pool.query('SELECT DISTINCT gruppen_id FROM shell_altbestand_bezuege WHERE project=$1',[project]).catch(()=>({rows:[]}))).rows.map(r=>r.gruppen_id);
 await pool.query('DELETE FROM shell_altbestand_bezuege WHERE project=$1',[project]).catch(()=>{});
 await pool.query('DELETE FROM shell_altbestand_gruppen g WHERE gruppen_id=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM shell_altbestand_bezuege b WHERE b.gruppen_id=g.gruppen_id)',[ownGroups]).catch(()=>{});
 await pool.query('DELETE FROM tool_calls WHERE project=$1',[project]);await pool.query('DELETE FROM shell_jobs WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);await closePool();
}
