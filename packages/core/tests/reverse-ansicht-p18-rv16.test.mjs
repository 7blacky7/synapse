/**
 * P18-T26/RV16 (Blocker-Übernahme claude-t26b): Reverse-Retentionhalter (A14) und A15-Bindungsprüfung beim Linkabruf.
 * EIGENES Schema p18_rv16_<uuid> in synapse_test (Port 5433), kontrollierte Uhr, Fake-A14-Quelle (kein FFmpeg, keine Bytes).
 * Fälle: Schema-Spiegel, halten/freigeben/Scope, Cache-Bereinigung unter Fence, Erzeugen nur gebunden,
 * Abruf 200 gebunden -> Lösen (Trigger) -> 410 nicht_mehr_gebunden ohne Metadaten + Retention frei,
 * fremdes Projekt löst nicht, Wiederbinden belebt nicht, sha256-Abweichung -> 410 nicht_mehr_gebunden.
 * AUFRUF (Testphase, Synapse-shell setzt DATABASE_URL): node --test packages/core/tests/reverse-ansicht-p18-rv16.test.mjs
 * Voraussetzung: core gebaut.
 */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

const core=await import('../dist/index.js');
const {AnsichtLinkDienst,ReverseAnsichtRetention,pruefeReverseAnsichtBindung,REVERSE_ANSICHT_SCHEMA_SQL,ladeAssetKonfiguration}=core;
const pg=createRequire(import.meta.url)('pg');
const schema='p18_rv16_'+randomUUID().replaceAll('-',''),suffix=randomUUID().slice(0,8);
const projekt='p18_rv16_'+suffix,anderes='p18_rv16_x'+suffix;
const eintrag='rev-rv16-'+suffix.replace(/[^a-f0-9]/g,'a')+'-abcdef';
const sha=createHash('sha256').update('p18-rv16-fixture').digest('hex');
const fremdSha=createHash('sha256').update('p18-rv16-fremd').digest('hex');
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
let admin,db,cfg,retention,uhr=new Date('2026-10-14T12:00:00Z');

async function connection(){
  const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
  assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
  await c.query('SET search_path TO '+schema+',public');
  return {query:(s,v)=>c.query(s,v),release:()=>c.end()};
}
const quelle=ref=>({bereich:'reverse',id:ref.id,revision:ref.revision??sha,sha256:ref.sha256??sha,groesse:16,format:'png',mimeType:'image/png',
  adresse:{bereich:'reverse',ziel_ref:ref.ziel_ref,storage_kind:'binaries',logischer_pfad:'bild.png'},
  lesen:async()=>{throw new Error('nicht genutzt');},...retention.halter(ref.ziel_ref,ref.sha256??sha)});
const fakeDienst={
  async quelle(ref){return quelle(ref);},
  async ansicht(ref){return {success:true,mimeType:'image/png',png:PNG,breite:1,hoehe:1,cacheKey:'k',cacheTreffer:false,quelle:{...ref,revision:sha,sha256:sha}};},
};
const link={basisUrl:'https://synapse.test',basisFehler:null,produktion:true,rateProMinute:10_000,vertrauenswuerdigeProxies:[],maxOriginalBytes:1024};
const neuerDienst=(extra={})=>new AnsichtLinkDienst({db,dienst:fakeDienst,konfiguration:cfg,link,jetzt:()=>uhr,
  projektAktiv:async()=>true,projektStandardSekunden:async()=>undefined,warten:async()=>{},...extra});
const erzeuge=(d,extra={})=>d.erzeugen({bereich:'reverse',ziel_ref:eintrag,id:'1',revision:sha,sha256:sha,agent_id:'test-rv16',projekt,...extra});
const tokenAus=url=>url.slice(url.lastIndexOf('/')+1);
const meta={clientIp:'198.51.100.7',userAgent:'rv16-test'};
const binden=p=>db.query('INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,$3)',[p,eintrag,'test-rv16']);
const loesen=p=>db.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1 AND eintrag_id=$2 AND geloest_at IS NULL',[p,eintrag]);
const aktiv=async ref=>(await db.query('SELECT released_at FROM reverse_ansicht_retention WHERE ref_key=$1',[ref])).rows[0];

before(async()=>{
  admin=await connection();await admin.query('CREATE SCHEMA '+schema);await admin.query('SET search_path TO '+schema+',public');
  for(const f of ['95_asset_intel.sql','96_asset_transport.sql','97_reverse.sql','102_asset_ansicht_links.sql','104_reverse_ansicht.sql'])
    await admin.query(await fs.readFile(new URL('../src/db/schema-sql/'+f,import.meta.url),'utf8'));
  db={connect:connection,async query(s,v){const c=await connection();try{return await c.query(s,v);}finally{await c.release();}}};
  cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_PREVIEW_OPEN_SECONDS:'300',SYNAPSE_ASSET_PREVIEW_MAX_OPEN_SECONDS:'3600'});
  retention=new ReverseAnsichtRetention({db});
  await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'RV16 Fixture','bestaetigt')",[eintrag]);
  const m=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,art) VALUES($1,1,'ordner') RETURNING id",[eintrag])).rows[0].id;
  await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key) VALUES($1,$2,'bild.png',$3,16,'asset','x/bild.png')",[eintrag,m,sha]);
});
after(async()=>{if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.release();}});

test('Schema: SQL-Spiegel 104 entspricht REVERSE_ANSICHT_SCHEMA_SQL',async()=>{
  const sql=await fs.readFile(new URL('../src/db/schema-sql/104_reverse_ansicht.sql',import.meta.url),'utf8');
  assert.equal(REVERSE_ANSICHT_SCHEMA_SQL.trim(),sql.trim());
});

test('Retention: halten/verlängern/freigeben, fremde sha256 und fremder Scope abgewiesen, keine Bytes',async()=>{
  const bis=new Date(Date.now()+60_000);
  await retention.halten({ref_key:'a14-t1',eintrag_id:eintrag,sha256:sha,expires_at:bis});
  assert.equal(await retention.istGehalten(eintrag,sha),true);
  await assert.rejects(retention.halten({ref_key:'a14-t2',eintrag_id:eintrag,sha256:fremdSha,expires_at:bis}),e=>e.code==='ansicht_revision_falsch');
  await assert.rejects(retention.halten({ref_key:'a14-t3',eintrag_id:'rev-gibts-nicht-000000',sha256:sha,expires_at:bis}),e=>e.code==='ansicht_quelle_fehlt');
  await assert.rejects(retention.halten({ref_key:'a14-t1',eintrag_id:eintrag,sha256:'0'.repeat(64),expires_at:bis}));
  await retention.freigeben('a14-t1');
  assert.equal(await retention.istGehalten(eintrag,sha),false);
  const spalten=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='reverse_ansicht_retention'",[schema])).rows.map(r=>r.column_name).sort();
  assert.deepEqual(spalten,['created_at','eintrag_id','expires_at','ref_key','released_at','sha256']);
});

test('Cache-Bereinigung nur ohne Halter, Fence bis nach dem Unlink, nur bereich reverse',async()=>{
  let entfernt=0;
  const dienst={async bereinigeCache(_a,_k,fence){if(!await fence())return false;entfernt++;return true;}};
  const o={adresse:{bereich:'reverse',ziel_ref:eintrag,storage_kind:'binaries',logischer_pfad:'bild.png'},cacheKey:'a'.repeat(64),eintrag_id:eintrag,sha256:sha};
  await retention.halten({ref_key:'a14-cache',eintrag_id:eintrag,sha256:sha,expires_at:new Date(Date.now()+60_000)});
  assert.equal(await retention.bereinigeCache(dienst,o),false);assert.equal(entfernt,0);
  await retention.freigeben('a14-cache');
  assert.equal(await retention.bereinigeCache(dienst,o),true);assert.equal(entfernt,1);
  await assert.rejects(retention.bereinigeCache(dienst,{...o,adresse:{...o.adresse,bereich:'projekt'}}));
});

test('Bindungsprüfung: fail-closed, sha256 muss zum Eintrag gehören',async()=>{
  assert.equal(await pruefeReverseAnsichtBindung(db,{projekt,eintrag_id:eintrag}),'nicht_gebunden');
  await binden(projekt);
  assert.equal(await pruefeReverseAnsichtBindung(db,{projekt,eintrag_id:eintrag,sha256:sha}),'ok');
  assert.equal(await pruefeReverseAnsichtBindung(db,{projekt,eintrag_id:eintrag,sha256:fremdSha}),'revision_falsch');
  assert.equal(await pruefeReverseAnsichtBindung(db,{projekt:null,eintrag_id:eintrag}),'nicht_gebunden');
  assert.equal(await pruefeReverseAnsichtBindung(db,{projekt,eintrag_id:'../x'}),'nicht_gebunden');
  await loesen(projekt);
});

test('Erzeugen nur für gebundene Einträge; revision muss sha256 sein',async()=>{
  const d=neuerDienst();
  assert.equal((await erzeuge(d)).fehlercode,'nicht_gebunden');
  assert.equal((await erzeuge(d,{projekt:null})).fehlercode,'nicht_gebunden');
  await binden(projekt);
  try{
    assert.equal((await erzeuge(d,{revision:'1'})).fehlercode,'ansicht_revision_falsch');
    const r=await erzeuge(d);
    assert.equal(r.success,true);assert.equal(r.revision,sha);
    const row=(await db.query('SELECT erstellt_von_projekt,retention_ref FROM ansicht_tokens WHERE token_id=$1',[r.token_id])).rows[0];
    assert.equal(row.erstellt_von_projekt,projekt);
    assert.equal((await aktiv(row.retention_ref)).released_at,null,'Link hält die Reverse-Revision');
  }finally{await loesen(projekt);}
});

test('Abruf: 200 solange gebunden; Lösen widerruft per Trigger -> 410 nicht_mehr_gebunden, Retention frei, Wiederbinden belebt nicht',async()=>{
  await binden(projekt);await binden(anderes);
  const d=neuerDienst(),r=await erzeuge(d),token=tokenAus(r.url);
  const ret=(await db.query('SELECT retention_ref FROM ansicht_tokens WHERE token_id=$1',[r.token_id])).rows[0].retention_ref;
  assert.equal((await d.abrufen(token,meta)).status,200);
  await loesen(anderes);
  assert.equal((await d.abrufen(token,meta)).status,200,'fremdes Projekt löst nicht');
  await loesen(projekt);
  const weg=await d.abrufen(token,meta);
  assert.deepEqual(weg,{status:410,code:'nicht_mehr_gebunden',token_id:r.token_id},'keine Metadaten außer Code');
  assert.notEqual((await aktiv(ret)).released_at,null,'Retention freigegeben');
  const z=(await db.query('SELECT widerruf_grund FROM ansicht_tokens WHERE token_id=$1',[r.token_id])).rows[0];
  assert.equal(z.widerruf_grund,'bindung_geloest');
  await binden(projekt);
  try{assert.equal((await d.abrufen(token,meta)).code,'nicht_mehr_gebunden','Wiederbinden belebt den Link nicht');}
  finally{await loesen(projekt);}
});

test('Abruf prüft Bindung selbst (ohne Trigger) und sha256: 410 nicht_mehr_gebunden',async()=>{
  await binden(projekt);
  try{
    const d=neuerDienst(),r=await erzeuge(d);
    const wechsel=neuerDienst({reverseBindung:async()=>'revision_falsch'});
    assert.deepEqual(await wechsel.abrufen(tokenAus(r.url),meta),{status:410,code:'nicht_mehr_gebunden',token_id:r.token_id});
    assert.equal((await db.query('SELECT widerruf_grund FROM ansicht_tokens WHERE token_id=$1',[r.token_id])).rows[0].widerruf_grund,'bindung_revision_falsch');
    const r2=await erzeuge(d);
    const ungebunden=neuerDienst({reverseBindung:async()=>'nicht_gebunden'});
    assert.equal((await ungebunden.abrufen(tokenAus(r2.url),meta)).code,'nicht_mehr_gebunden');
    const r3=await erzeuge(d);
    await db.query("UPDATE ansicht_tokens SET erstellt_von_projekt=NULL WHERE token_id=$1",[r3.token_id]);
    assert.equal((await d.abrufen(tokenAus(r3.url),meta)).code,'nicht_mehr_gebunden','ohne Erstellerprojekt fail-closed');
  }finally{await loesen(projekt);}
});

test('Projekt-Links bleiben unberührt (Auth-Ausnahme und Projektpfad unverändert)',()=>{
  assert.equal(core.istOeffentlicherAnsichtPfad('GET','/api/assets/ansicht/'+'A'.repeat(43)),true);
  assert.equal(core.istOeffentlicherAnsichtPfad('HEAD','/api/assets/ansicht/'+'A'.repeat(43)),false);
});
