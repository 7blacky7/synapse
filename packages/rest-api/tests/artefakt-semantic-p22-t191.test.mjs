/**
 * P22-T191 Semantik-Vertrag: core artefakt-katalog/dateien delegieren an vorhandenes code.js searchCode.
 * Echte Rechte/Metadaten in privatem synapse_test:5433-Schema; Index-/Vektorgrenze als Attrappe, keine Modellguete-Behauptung.
 * Aufruf: mise exec node@25 -- node --experimental-test-module-mocks packages/rest-api/tests/artefakt-semantic-p22-t191.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mock} from 'node:test';
const db=process.env.DATABASE_URL??process.env.SYNAPSE_DATABASE_URL,u=new URL(db);assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
process.env.DATABASE_URL=db;process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const codeUrl=new URL('../../core/dist/services/code.js',import.meta.url),code=await import(codeUrl.href);
let kaputt=false,treffer=[],calls=[],index=[];
mock.module(codeUrl.href,{namedExports:{...code,indexiereDateiInhalt:async(path,project,text)=>{index.push({path,project,text});},parseAndEmbed:async()=>{},
 searchCode:async(...args)=>{calls.push(args);if(kaputt)throw Error('Vektorzugang aus');return treffer;}}});
const K=await import('../../core/dist/services/artefakt-katalog.js'),D=await import('../../core/dist/services/artefakt-dateien.js');
const {getPool,mitLesePool}=await import('../../core/dist/db/client.js');
const {ARTEFAKT_DATEIEN_SCHEMA_SQL}=await import('../../core/dist/db/artefakt-dateien-schema.js');
const basis=getPool(),schema='p22_t191_sem_'+randomUUID().replaceAll('-',''),P='t191-sem-'+randomUUID(),ID=randomUUID();
const pool={async connect(){const c=await basis.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const b={art:'agent',identity_id:ID,agent_id:'sem191',project:P,main:false};
const mit=fn=>mitLesePool(pool,fn);
let n=0;const ok=(v,label,actual)=>{assert.ok(v,'P22-T191 Semantik '+label+' erwartet=erfuellt tatsaechlich='+JSON.stringify(actual).slice(0,600));n++;console.log('OK P22-T191 Semantik '+label);};
try{
 await basis.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_artifacts','agent_identitaeten'])await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(ARTEFAKT_DATEIEN_SCHEMA_SQL);
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'sem191','sem191','koordinator','aktiv','test')",[ID,P]);
 const a=randomUUID(),g=randomUUID(),f=randomUUID();
 for(const [id,name,bereich,p]of [[a,'Plan','projekt',P],[g,'Welt','global','anders'],[f,'Geheim','projekt','anders']])
  await pool.query("INSERT INTO agent_artifacts(id,name,title,beschreibung,html,revision,standard_project,bereich) VALUES($1,$2,$2,$3,$4,1,$5,$6)",[id,name,'Fortschritt und Aufgaben','<h1>Plan</h1>',p,bereich]);
 treffer=[{score:0.99,payload:{file_path:'artefakte/'+f+'/katalog.md'}},{score:0.9,payload:{file_path:'artefakte/'+g+'/katalog.md'}},{score:0.8,payload:{file_path:'artefakte/'+a+'/katalog.md'}}];
 let r=await mit(()=>K.listeArtefaktKatalog({query:'Aufgabenfortschritt',semantic:true},b));
 ok(r.success&&r.count===2&&r.artefakte[0].artefakt_id===g,'Projekt/global semantisch und nach Score sortiert',r);
 ok(!JSON.stringify(r).includes(f),'fremde Vektortreffer werden vor Ausgabe entfernt',r);
 ok(calls.length===2&&calls.every(c=>c[0]==='Aufgabenfortschritt'&&c[1].startsWith('__artefakte_')&&c[1].endsWith('_katalog')&&c[2]==='md'),'genau bestehendes searchCode mit isoliertem Katalognamespace',calls);
 ok(index.length===2&&index.some(x=>x.text.includes('Fortschritt und Aufgaben')),'Katalogtext in vorhandenen Code-Index gegeben',index);
 r=await mit(()=>K.listeArtefaktKatalog({query:'Fortschritt',semantic:true,scope:'global',limit:1},b));
 ok(r.count===1&&r.artefakte[0].artefakt_id===g,'globaler Bereich in semantischer Suche',r);
 const z=await mit(()=>K.ladeArtefaktKatalogEintrag(a,b)),s=await mit(()=>D.ladeArtefaktText(z));
 treffer=[{score:0.92,payload:{file_path:'artefakte/'+a+'/inhalt.html',line_start:3,line_end:7,content:'Skript'}}];calls=[];
 r=await mit(()=>D.artefaktCodeIntel({intel_action:'search',query:'Berechnung',semantic:true},z,s));
 ok(r.mode==='semantic'&&r.results[0].payload.line_start===3,'semantischer Inhalt mit Zeilenbezug',r);
 ok(calls[0][4]==='artefakte/'+a+'/inhalt.html','Inhaltssuche ist auf exakten Artefaktpfad begrenzt',calls);
 kaputt=true;
 r=await mit(()=>K.listeArtefaktKatalog({query:'Fortschritt',semantic:true},b));
 ok(r.success===false&&r.error==='semantik_nicht_erreichbar'&&r.unvollstaendig,'Vektorfehler sichtbar statt scheinbar leerer Erfolg',r);
 console.log('P22-T191 Semantik '+n+' Vertraege GRUEN (Index-/Vektorattrappe, keine Modellguete).');
}catch(e){console.error('DEBUG P22-T191 semantic erwartet=Vertraege gruen tatsaechlich='+e.stack+' schema='+schema);process.exitCode=1;}
finally{mock.restoreAll();await basis.query('DROP SCHEMA '+schema+' CASCADE');await basis.end();}
process.exit(process.exitCode??0);
