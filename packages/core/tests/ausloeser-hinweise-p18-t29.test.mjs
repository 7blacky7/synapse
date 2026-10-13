/** RV19: synthetische Quellen, ausschließlich p18_rv19 auf synapse_test:5433. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const core = await import('../dist/index.js');
assert.equal(typeof core.registriereHinweisQuelle, 'function', 'RV19 Quellen-Registry fehlt (rote Kontrolle)');
const H = await import('../dist/services/ausloeser-hinweise.js');
const { HINWEIS_SCHEMA_SQL } = await import('../dist/db/ausloeser-hinweise-schema.js');
const pool = core.getPool(), project = 'p18_rv19', agent = 'p18_rv19-' + randomUUID();
const names = ['project','search','memory','thought','plan','proposal','chat','channel','jev','event','specialist','docs','admin','code_intel','asset_intel','files','files_batch','shell','code_check','ignore','guide','workspace','skills','artefakt'];
const samples = [{success:true,count:0,results:[],empty:'',nullable:null,zero:0,flag:false},[{name:'synthetic',value:7}],{success:false,error:'synthetic',exit_code:null}];
const options = {pool, zeitbudgetMs:1000};
const args = {project, agent_id:agent, action:'read', file_path:'synthetic.ts'};
const raw = {success:true, felder:{konflikt:true}, file_path:'synthetic.ts'};
const call = (data=raw, extra={}) => H.haengeAusloeserHinweiseAn(data,'files',{...args,...extra},agent,options);
let stop;
try {
  await pool.query(HINWEIS_SCHEMA_SQL); await pool.query(HINWEIS_SCHEMA_SQL);
  await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',NOW())", [agent,project]);
  // Altstand-Werte stammen aus Job 5c3d847f, vor jedem Produktionsedit.
  const values = [];
  for (const tool of names) {
    const answers = [];
    for (const payload of samples) {
      const unchanged = await H.haengeAusloeserHinweiseAn(payload,tool,args,agent,options);
      assert.equal(unchanged,payload,'Leere Registry erhält Objektidentität');
      const stdio = {content:[{type:'text',text:JSON.stringify(payload,null,2)}]};
      await H.haengeAusloeserTextHinweiseAn(stdio,tool,args,agent,options);
      answers.push({rest:core.baueToolErgebnis(unchanged,{tool,action:'read',strukturiert:true}),stdio:core.kompaktiereTextErgebnis(stdio,tool,'read')});
    }
    values.push([tool,answers]);
  }
  assert.equal(createHash('sha256').update(JSON.stringify(values)).digest('hex'),'4d31782212790947c933921918b7e7caf1c6204f69f72da684daa9b169e39ab6','24 Tool-Antworten REST+stdio bytegleich');
  stop = H.registriereHinweisQuelle({quelle_id:'rv19-test',pruefe:c => {
    assert.equal(c.projekt,project); assert.equal(c.agent_id,agent); assert(c.sitzung);
    assert(c.pfade.includes('synthetic.ts')); assert.equal(c.felder.konflikt,true);
    return c.aktion === 'read' ? [{hinweis_id:'skill',modus:'einmal_je_sitzung',text:'Skill synthetisch laden',spezifitaet:5,folgeaktion:{tool:'skills',aktion:'get_full',argumente:{skill_name:'rv19-test'}}}] : [];
  }});
  assert.equal(await call(raw,{action:'inspect'}),raw,'Nicht-Treffer unverändert');
  const first = await call(); assert.deepEqual(first.ausloeser_hinweise,['Skill synthetisch laden']);
  assert.equal(await call(),raw,'einmal je Sitzung');
  await pool.query("UPDATE agent_sessions SET sitzung_seit=NOW()+interval '1 second' WHERE id=$1",[agent]);
  const race = await Promise.all(Array.from({length:5},()=>call()));
  assert.equal(race.filter(x=>x.ausloeser_hinweise).length,1,'atomare Dedup bei konkurrierenden Aufrufen');
  await H.haengeAusloeserHinweiseAn(raw,'skills',{...args,action:'get_full',skill_name:'anderer'},agent,options);
  assert.equal((await H.holeAusloeserHinweisMetriken(project,pool)).find(x=>x.quelle_id==='rv19-test').gefolgt,0);
  await H.haengeAusloeserHinweiseAn(raw,'skills',{action:'get_full',skill_name:'rv19-test'},agent,options);
  assert.equal((await H.holeAusloeserHinweisMetriken(project,pool)).find(x=>x.quelle_id==='rv19-test').gefolgt,1);
  stop();
  let erledigt=false;
  stop=H.registriereHinweisQuelle({quelle_id:'rv19-test',pruefe:()=>[{hinweis_id:'konflikt',modus:'bis_erledigt',text:'Konflikt beheben',kurztext:'Konflikt offen',erledigt,entprellung_ms:100}]});
  assert.deepEqual((await call()).ausloeser_hinweise,['Konflikt beheben']);
  assert.equal(await call(),raw);
  await pool.query("UPDATE ausloeser_hinweis_zustellungen SET gezeigt_am=NOW()-interval '1 second' WHERE agent_id=$1",[agent]);
  assert.deepEqual((await call()).ausloeser_hinweise,['Konflikt offen']);
  erledigt=true; assert.equal(await call(),raw); erledigt=false;
  assert.deepEqual((await call()).ausloeser_hinweise,['Konflikt beheben'],'erneuter Konflikt nach Erledigung');
  assert.equal(await H.fuehreHinweisprofilAdminAus('kontextprofil_setzen',{project,ziel:agent,hinweise_aus:['rv19-test']},agent,pool),null,'Berechtigung bleibt beim Bestandsdispatcher');
  const profile=await H.fuehreHinweisprofilAdminAus('kontextprofil_setzen',{project,ziel:agent,hinweise_aus:['rv19-test']},'koordinator',pool);
  assert.equal(profile.success,true); assert.equal(await call(),raw,'Profil schaltet Quelle ab');
  assert.equal((await H.fuehreHinweisprofilAdminAus('kontextprofil_entfernen',{project,ziel:agent},'koordinator',pool)).success,true);
  await H.fuehreHinweisprofilAdminAus('kontextprofil_setzen',{project,ziel:'p18_rv19-*',hinweise_nur:['andere']},'koordinator',pool);
  assert.equal(await call(),raw,'Namensmuster und Allowlist');
  await H.fuehreHinweisprofilAdminAus('kontextprofil_entfernen',{project,ziel:'p18_rv19-*'},'koordinator',pool);
  stop();
  stop=H.registriereHinweisQuelle({quelle_id:'rv19-test',pruefe:()=>{throw Error('synthetisch');}});
  assert.equal(await call(),raw,'Quellenfehler bleibt still'); stop();
  stop=H.registriereHinweisQuelle({quelle_id:'rv19-test',pruefe:async()=>{await new Promise(r=>setTimeout(r,100));return [{hinweis_id:'late',modus:'einmal_je_sitzung',text:'zu spät'}];}});
  const t=Date.now(); assert.equal(await H.haengeAusloeserHinweiseAn(raw,'files',args,agent,{pool,zeitbudgetMs:10}),raw);
  assert(Date.now()-t<80,'hartes Zeitbudget'); await new Promise(r=>setTimeout(r,120));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ausloeser_hinweis_zustellungen WHERE agent_id=$1 AND hinweis_id='late'",[agent])).rows[0].n,0,'späte Quelle verbraucht keine Zustellung');stop();
  const removers=[1,2,3].map(n=>H.registriereHinweisQuelle({quelle_id:'rv19-test-'+n,pruefe:()=>[{hinweis_id:'rank',modus:'einmal_je_sitzung',text:'Zeile '+n+'\nZusatz',spezifitaet:n}]}));
  const ranked=await call();assert.deepEqual(ranked.ausloeser_hinweise,['Zeile 3 Zusatz','Zeile 2 Zusatz'],'max zwei Kurzzeilen, spezifisch zuerst');
  assert.deepEqual((await call()).ausloeser_hinweise,['Zeile 1 Zusatz'],'nicht ausgelieferte Kandidaten bleiben verfügbar');
  removers.forEach(r=>r());
  stop=H.registriereHinweisQuelle({quelle_id:'rv19-text',pruefe:()=>[{hinweis_id:'text',modus:'bis_erledigt',text:'Textadapter',kurztext:'offen',entprellung_ms:0}]});
  const textResponse={content:[{type:'text',text:JSON.stringify(raw)}]};
  await H.haengeAusloeserTextHinweiseAn(textResponse,'files',args,agent,options);
  assert.deepEqual(JSON.parse(textResponse.content[0].text).ausloeser_hinweise,['Textadapter']);
  stop();
  const metrics=await H.holeAusloeserHinweisMetriken(project,pool);
  assert(metrics.some(x=>x.ausgeliefert>0));
  const errors=metrics.find(x=>x.quelle_id==='rv19-test');assert.equal(errors.fehler,1);assert.equal(errors.zeitueberschreitung,1,'auch nach später Quellenantwort genau ein Timeout');
  const concurrent=await Promise.all(Array.from({length:5},()=>H.holeAusloeserHinweisMetriken(project,pool)));
  assert(concurrent.every(rows=>rows.find(x=>x.quelle_id==='rv19-test').fehler===1),'parallele Metrikabrufe doppeln keine Fehler');
  // Beide Oberflächen benutzen denselben Adapter an der Werkzeug-Regel-Einhängestelle.
  for(const [file,needle] of [['../../mcp-server/src/server.ts','await haengeAusloeserTextHinweiseAn'],['../../rest-api/src/routes/mcp.ts','await haengeAusloeserHinweiseAn']]) {
    assert((await readFile(new URL(file,import.meta.url),'utf8')).includes(needle));
  }
  console.log('P18-T29 PASS: Golden 24 Tools REST+stdio, Treffer/Dedup/Sitzung/Race, bis_erledigt, Profile, gefolgt, Fehler/Timeout, Rangfolge/Textadapter, idempotentes DDL');
} finally {
  stop?.();
  for(const table of ['ausloeser_hinweis_zustellungen','ausloeser_hinweis_metriken','ausloeser_hinweis_profile']) await pool.query('DELETE FROM '+table+' WHERE project=$1',[project]);
  await pool.query('DELETE FROM ausloeser_hinweis_aufrufe WHERE agent_id=$1',[agent]);
  await pool.query('DELETE FROM agent_sessions WHERE id=$1',[agent]); await pool.end();
}
