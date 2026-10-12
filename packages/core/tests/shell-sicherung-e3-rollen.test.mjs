/** P10-T37: dieselbe bestehende Namenstreue wie jev_schalten. */
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const{darfKoordinatorOderUser}=await import('../dist/services/rollen-pruefung.js');
const{mitUserHerkunft}=await import('../dist/services/user-herkunft.js');
const{fuehreJevAdminAus}=await import('../dist/services/jev-admin.js');
const db=await import('../dist/db/client.js');
const project='test-shell-e3-rolle-'+randomUUID();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test','/virtual/e3-rolle']);
for(const wer of ['koordinator','coordinator','Koordinator']){
 assert.equal(darfKoordinatorOderUser(wer),true);
 const r=await fuehreJevAdminAus('jev_schalten',{ebene:'projekt',project,funktion:'tool',aktiv:false,grund:'P10-T37 eigene Rollenprobe'},wer);
 assert.equal(r.success,true,wer);
}
for(const wer of ['sol-2','luna-1','koord','coordinator-extra','user','USER','',null,undefined]){
 assert.equal(darfKoordinatorOderUser(wer),false);
 const r=await fuehreJevAdminAus('jev_schalten',{ebene:'projekt',project,funktion:'tool',aktiv:false,grund:'P10-T37 eigene Rollenprobe'},wer);
 assert.equal(r.error,'nur_koordinator',String(wer));
}
for(const wer of ['user','USER']){
 assert.equal(mitUserHerkunft('web-ui-chat',()=>darfKoordinatorOderUser(wer)),true);
 const r=await mitUserHerkunft('web-ui-chat',()=>fuehreJevAdminAus('jev_schalten',{ebene:'projekt',project,funktion:'tool',aktiv:false,grund:'P10-T37 echte Herkunftsprobe'},wer));
 assert.equal(r.success,true);
}
console.log('P10-T37 bestehende Namenstreue und echter jev_schalten-Dispatcher gruen.');
await db.closePool();process.exit(0);
