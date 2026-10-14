/** P18-T26/RV16: gebundene Reverse-Metadaten; nur eigenes Schema in synapse_test:5433.
 * Gebündelte Testphase: node packages/core/tests/reverse-assets-p18-rv16.test.mjs
 * Kein FS/Daemon/Docker/Renderer; ansicht separat nach Freigabe des Quellenanschlusses.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const root=new Pool({connectionString:url.toString()});
const schema='p18_rv16_'+randomUUID().replaceAll('-','');
const pool={
 async connect(){const c=await root.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}
};
const core=await import('../dist/index.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const service=core.createReverseToolService({pool});
const project='p18_rv16',agent='p18_rv16-agent',rid='rev-fixture-000016',other='rev-fixture-000017';
const call=(action,args={})=>service.ausfuehren({action,agent_id:agent,project,reverse_id:rid,...args});
let created=false;
try {
 assert.equal((await pool.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
 await pool.query('CREATE SCHEMA '+schema);created=true;
 for(const table of ['projects','agent_sessions','tool_aktivitaet'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(REVERSE_SCHEMA_SQL);
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv16',true)",[project]);
 await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',NOW())",[agent,project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel) VALUES($1,'RV16'),($2,'anderer Scope')",[rid,other]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(1,$1,0,'ordner'),(2,$2,0,'ordner')",[rid,other]);
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,groesse,format,art,status,metadaten) VALUES(1,$1,1,'gfx/menu.bmp',$3,70,'bmp','asset','ok','{\"asset_type\":\"textur\",\"inspector\":\"bmp\"}'),(2,$1,1,'audio/theme.wav',$4,40,'wav','asset','ok','{\"asset_type\":\"audio\"}'),(3,$2,2,'secret.bmp',$3,70,'bmp','asset','ok','{}')",[rid,other,'a'.repeat(64),'b'.repeat(64)]);
 await pool.query("INSERT INTO reverse_objekte(datei_id,eintrag_id,ordnung,kind,name,data) VALUES(1,$1,0,'bild','menu','{\"breite\":1}'),(1,$1,1,'bild','andere','{}')",[rid]);
 await pool.query("INSERT INTO reverse_verweise(datei_id,eintrag_id,ordnung,kind,target,aufloesung) VALUES(1,$1,0,'embedded','palette','intern')",[rid]);
 for(const action of ['assets_tree','inspect'])assert.equal((await call(action,{file_path:'gfx/menu.bmp'})).fehlercode,'nicht_gebunden');
 assert.equal((await call('binden')).success,true);
 let tree=await call('assets_tree');assert.equal(tree.success,true,JSON.stringify(tree));assert.equal(tree.total,2);assert(tree.baum.includes('menu.bmp'));assert(!tree.baum.includes('secret.bmp'));
 tree=await call('assets_tree',{path:'gfx',limit:1});assert.equal(tree.total,1);assert.equal(tree.dateien,1);
 tree=await call('assets_tree',{format:'wav'});assert.equal(tree.total,1);assert(tree.baum.includes('theme.wav'));
 const paged=await call('assets_tree',{limit:1});assert.equal(paged.total,2);assert.equal(paged.gekappt,true);
 const inspect=await call('inspect',{file_path:'gfx/menu.bmp',objects_offset:1,objects_limit:1,references_limit:0});
 assert.equal(inspect.success,true,JSON.stringify(inspect));assert.equal(inspect.datei,'gfx/menu.bmp');assert.equal(inspect.format,'bmp');assert.equal(inspect.inspektion.objekte_total,2);assert.equal(inspect.inspektion.objekte.length,1);assert.equal(inspect.inspektion.objekte[0].name,'andere');assert.equal(inspect.inspektion.verweise_total,1);assert.equal(inspect.inspektion.verweise.length,0);
 assert.equal((await call('inspect',{datei:'gfx/menu.bmp'})).success,true);
 for(const key of core.REVERSE_DEFINITION.outputSchema.required)assert(Object.hasOwn(inspect,key),'Pflichtfeld '+key);
 assert(!JSON.stringify(inspect).includes('storage_key'));assert(!JSON.stringify(inspect).includes('data:image'));
 assert.equal((await call('inspect',{file_path:'menu.bmp'})).fehlercode,'nicht_gefunden','kein Suffixraten');
 assert.equal((await call('inspect',{file_path:'secret.bmp'})).fehlercode,'nicht_gefunden','kein fremder Scope');
 assert.equal((await call('inspect',{file_path:'gfx/menu.bmp',datei:'audio/theme.wav'})).fehler,'parameter_ungueltig');
 assert.equal((await call('inspect',{file_path:'../etc/passwd'})).fehlercode,'pfad_gefahr');
 assert.equal((await call('assets_tree',{path:'../etc'})).fehlercode,'pfad_gefahr');
 assert.equal((await call('inspect',{file_path:'gfx/menu.bmp',object_type:"' OR 1=1 --"})).inspektion.objekte_total,0);
 const clamped=await call('inspect',{file_path:'gfx/menu.bmp',objects_limit:-1});
 assert.equal(clamped.success,true);assert.equal(clamped.inspektion.objekte.length,0,'Bestandsgrenze: negative Objektlimits auf 0 begrenzt');
 assert.equal((await call('inspect',{file_path:'gfx/menu.bmp',objects_limit:'keine-zahl'})).success,false,'nicht-numerisches Limit wird abgewiesen');
 assert.equal((await call('inspect',{file_path:'gfx/menu.bmp',project:'anderes-projekt'})).fehlercode,'keine_berechtigung');
 assert.equal((await call('loesen')).success,true);
 assert.equal((await call('inspect',{file_path:'gfx/menu.bmp'})).fehlercode,'nicht_gebunden');
 assert.equal((await call('assets_tree')).fehlercode,'nicht_gebunden');
 console.log('PASS p18_rv16 assets_tree/inspect: Bindung, Scope, Paging, Pflichtfelder, Pfade, SQL-Werte');
} finally {
 if(created)await pool.query('DROP SCHEMA '+schema+' CASCADE');
 await root.end();
}
