/**
 * P13-T33/A15: Ansicht-Links über echtes Fastify (inject) gegen ein EIGENES Schema in synapse_test.
 * Kontrollierte Uhr, Fake-A14-Quelle (kein FFmpeg, keine Nutzerdaten), keine laufende API nötig.
 * Testplan p13_a15: Doppelabruf 200, Ablauf 410 abgelaufen, einmalig parallel genau einmal 200,
 * Widerruf 410, Neustart, Digest statt Klartext in PG, Audit maskiert, alle anderen /api-Routen ohne Bearer 401.
 * AUFRUF (Testphase, Synapse-shell setzt DATABASE_URL): node --test packages/rest-api/tests/asset-ansicht-link-p13-a15.test.mjs
 * Voraussetzung: core und rest-api gebaut.
 */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {AnsichtLinkDienst,AssetAnsichtFehler,ladeAssetKonfiguration,ladeAnsichtLinkKonfiguration,maskiereAnsichtLinks,istOeffentlicherAnsichtPfad} from '@synapse/core';
import {createAnsichtLinkRoutes} from '../dist/routes/asset-ansicht-links.js';
import {registerAuthHook} from '../dist/middleware/auth-hook.js';

const require=createRequire(import.meta.url),Fastify=require('fastify'),pg=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const {schwaerzeToolLogText}=await import(new URL('../../core/dist/services/tool-args-schwaerzen.js',import.meta.url).href);
const schema='p13_a15_'+randomUUID().replaceAll('-',''),projekt='p13_a15_'+randomUUID().slice(0,8);
const sha=createHash('sha256').update('p13-a15-fixture').digest('hex');
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const tokenAus=url=>url.slice(url.lastIndexOf('/')+1);
let admin,db,cfg,uhr=new Date('2026-10-14T12:00:00Z');
const gehalten=new Map();
let renderAufrufe=0;

async function connection(){
  const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
  assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
  await c.query('SET search_path TO '+schema+',public');
  return {query:(s,v)=>c.query(s,v),release:()=>c.end()};
}
const quelle=ref=>({bereich:ref.bereich,id:ref.id,revision:'1',sha256:sha,groesse:16,format:'png',mimeType:'image/png',
  adresse:{bereich:'projekt',ziel_ref:ref.ziel_ref,storage_kind:'assets',logischer_pfad:'bild.png'},
  lesen:async()=>{throw new Error('nicht genutzt');},halten:async(k,bis)=>{gehalten.set(k,bis);},freigeben:async k=>{gehalten.delete(k);}});
const fakeDienst={
  async quelle(ref){if(ref.id==='999999')throw new AssetAnsichtFehler('ansicht_quelle_fehlt','weg');return quelle(ref);},
  async ansicht(ref){renderAufrufe++;await new Promise(r=>setTimeout(r,15));
    return {success:true,mimeType:'image/png',png:PNG,breite:1,hoehe:1,cacheKey:'k',cacheTreffer:false,quelle:{...ref,revision:'1',sha256:sha}};},
};
const link={basisUrl:'https://synapse.test',basisFehler:null,produktion:true,rateProMinute:10_000,vertrauenswuerdigeProxies:['127.0.0.1'],maxOriginalBytes:1024};
const neuerDienst=(extra={})=>new AnsichtLinkDienst({db,dienst:fakeDienst,konfiguration:cfg,link,jetzt:()=>uhr,
  projektAktiv:async p=>p===projekt,projektStandardSekunden:async()=>undefined,warten:async()=>{},...extra});
const principal=t=>t==='user'?{kind:'access',scope:'api',token_hash:'c'.repeat(64)}:t==='daemon'?{kind:'service',scope:'daemon:x',token_hash:'d'.repeat(64)}:null;
/** mitHook=true: echter globaler Auth-Hook (öffentliche Route + 401 für alles andere). */
async function neueApp(dienst,mitHook){
  const a=Fastify({logger:false});
  if(mitHook)registerAuthHook(a);
  await a.register(createAnsichtLinkRoutes({dienst,link,validateToken:async t=>principal(t)}));
  a.get('/api/projects',async()=>({ok:true}));
  a.get('/api/assets/anderes',async()=>({ok:true}));
  await a.ready();return a;
}
const erzeuge=(d,extra={})=>d.erzeugen({bereich:'projekt',ziel_ref:projekt,id:'1',agent_id:'test-a15',projekt,...extra});

before(async()=>{
  admin=await connection();await admin.query('CREATE SCHEMA '+schema);await admin.query('SET search_path TO '+schema+',public');
  for(const f of ['95_asset_intel.sql','96_asset_transport.sql','102_asset_ansicht_links.sql'])
    await admin.query(await fs.readFile(new URL('../../core/src/db/schema-sql/'+f,import.meta.url),'utf8'));
  db={connect:connection,async query(s,v){const c=await connection();try{return await c.query(s,v);}finally{await c.release();}}};
  cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_PREVIEW_OPEN_SECONDS:'300',SYNAPSE_ASSET_PREVIEW_MAX_OPEN_SECONDS:'3600'});
});
after(async()=>{if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.release();}});

test('Konfiguration: externe Basis validiert, kein localhost-Rückfall im Produktionsmodus',()=>{
  assert.equal(ladeAnsichtLinkKonfiguration({NODE_ENV:'production'},cfg).basisUrl,null);
  assert.equal(ladeAnsichtLinkKonfiguration({NODE_ENV:'production',SYNAPSE_PUBLIC_URL:'http://localhost:3456'},cfg).basisUrl,null);
  assert.equal(ladeAnsichtLinkKonfiguration({NODE_ENV:'production',SYNAPSE_PUBLIC_URL:'http://synapse.example'},cfg).basisUrl,null);
  assert.equal(ladeAnsichtLinkKonfiguration({NODE_ENV:'production',SYNAPSE_PUBLIC_URL:'https://u:p@synapse.example'},cfg).basisUrl,null);
  assert.equal(ladeAnsichtLinkKonfiguration({NODE_ENV:'production',SYNAPSE_ASSET_ANSICHT_BASE_URL:'https://synapse.example/'},cfg).basisUrl,'https://synapse.example');
  assert.throws(()=>ladeAnsichtLinkKonfiguration({SYNAPSE_TRUSTED_PROXY_IPS:'kein-ip'},cfg));
  assert.throws(()=>ladeAnsichtLinkKonfiguration({SYNAPSE_ASSET_ANSICHT_RATE_PRO_MINUTE:'0'},cfg));
});

test('Auth-Ausnahme exakt: nur GET mit 43-Zeichen-Token',()=>{
  const t='A'.repeat(43);
  assert.equal(istOeffentlicherAnsichtPfad('GET','/api/assets/ansicht/'+t),true);
  for(const [m,p] of [['HEAD','/api/assets/ansicht/'+t],['POST','/api/assets/ansicht/'+t],['GET','/api/assets/ansicht/'+t+'/'],
    ['GET','/api/assets/ansicht/'+t.slice(1)],['GET','/api/assets/ansicht/'+t+'A'],['GET','/api/assets/ansicht-links'],['GET','/api/assets/ansicht/'+t.slice(2)+'%41']])
    assert.equal(istOeffentlicherAnsichtPfad(m,p),false,m+' '+p);
});

test('erzeugen: A4-Standard, Obergrenze abgewiesen (nicht gekappt), Retention gebunden, Basis Pflicht',async()=>{
  const d=neuerDienst();
  const r=await erzeuge(d);
  assert.equal(r.success,true);assert.equal(r.offen_sekunden,300);assert.equal(r.einmalig,false);assert.equal(r.art,'ansicht');
  assert.match(r.url,/^https:\/\/synapse\.test\/api\/assets\/ansicht\/[A-Za-z0-9_-]{43}$/);
  assert.equal(gehalten.get('a15-'+r.token_id)?.toISOString(),r.expires_at);
  assert.equal((await erzeuge(d,{offen_sekunden:3600})).success,true);
  const zuGross=await erzeuge(d,{offen_sekunden:3601});
  assert.deepEqual([zuGross.success,zuGross.fehlercode],[false,'offen_sekunden_zu_gross']);
  for(const v of [0,-1,1.5,'60'])assert.equal((await erzeuge(d,{offen_sekunden:v})).fehlercode,'offen_sekunden_ungueltig');
  assert.equal((await erzeuge(d,{einmalig:'ja'})).fehlercode,'einmalig_ungueltig');
  assert.equal((await erzeuge(d,{id:'999999'})).fehlercode,'ansicht_quelle_fehlt');
  const ohneBasis=neuerDienst({link:{...link,basisUrl:null,basisFehler:'fehlt'}});
  assert.equal((await erzeuge(ohneBasis)).fehlercode,'ansicht_basisadresse_fehlt');
});

test('PG hält nur den Digest; Audit und tool_calls-Schwärzung ohne Token',async()=>{
  const d=neuerDienst(),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d),token=tokenAus(r.url);
    assert.equal((await app.inject({method:'GET',url:'/api/assets/ansicht/'+token,headers:{'user-agent':'probe/'+r.url}})).statusCode,200);
    const zeile=(await db.query('SELECT row_to_json(t)::text AS j,token_digest FROM ansicht_tokens t WHERE token_id=$1',[r.token_id])).rows[0];
    assert.equal(zeile.token_digest,createHash('sha256').update(token).digest('hex'));
    assert.equal(zeile.j.includes(token),false,'Klartext-Token nie in PG');
    const audit=(await db.query("SELECT string_agg(row_to_json(a)::text,'\n') AS j FROM ansicht_token_audit a")).rows[0].j;
    assert.equal(audit.includes(token),false,'Audit ohne Token');
    assert.ok(audit.includes('/api/assets/ansicht/[WERT]'),'User-Agent mit URL maskiert');
    assert.equal(maskiereAnsichtLinks(r.url).includes(token),false);
    assert.equal(schwaerzeToolLogText(JSON.stringify({success:true,url:r.url})).includes(token),false,'tool_calls-Schwärzung');
  }finally{await app.close();}
});

test('Doppelabruf im Fenster 200 mit Sicherheitsheadern, nach Ablauf 410 abgelaufen',async()=>{
  const d=neuerDienst(),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d,{offen_sekunden:60}),url='/api/assets/ansicht/'+tokenAus(r.url);
    for(let i=0;i<2;i++){
      const a=await app.inject({method:'GET',url});
      assert.equal(a.statusCode,200);assert.equal(a.headers['content-type'],'image/png');
      assert.match(String(a.headers['cache-control']),/no-store/);assert.equal(a.headers['x-content-type-options'],'nosniff');
      assert.equal(a.headers['referrer-policy'],'no-referrer');assert.deepEqual(a.rawPayload,PNG);
    }
    uhr=new Date(uhr.getTime()+60_000);
    const weg=await app.inject({method:'GET',url});
    assert.equal(weg.statusCode,410);assert.deepEqual(weg.json(),{success:false,error:{code:'abgelaufen'}});
  }finally{await app.close();}
});

test('einmalig: zwei parallele GETs ergeben genau einmal 200, danach 410 verbraucht',async()=>{
  const d=neuerDienst(),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d,{einmalig:true}),url='/api/assets/ansicht/'+tokenAus(r.url);
    const antworten=await Promise.all([app.inject({method:'GET',url}),app.inject({method:'GET',url})]);
    assert.deepEqual(antworten.map(a=>a.statusCode).sort(),[200,410]);
    assert.equal(antworten.find(a=>a.statusCode===410).json().error.code,'verbraucht');
    assert.equal((await app.inject({method:'GET',url})).json().error.code,'verbraucht');
  }finally{await app.close();}
});

test('Widerruf über geschützten Weg: 410 widerrufen, Liste ohne Token, Rechte geprüft',async()=>{
  const d=neuerDienst(),oeffentlich=await neueApp(d,true),verwaltung=await neueApp(d,false);
  try{
    const r=await erzeuge(d),token=tokenAus(r.url),url='/api/assets/ansicht/'+token;
    assert.equal((await oeffentlich.inject({method:'POST',url:'/api/assets/ansicht-links/widerrufen',payload:{bereich:'projekt',ziel_ref:projekt,token_id:r.token_id}})).statusCode,401);
    assert.equal((await verwaltung.inject({method:'POST',url:'/api/assets/ansicht-links/widerrufen',payload:{bereich:'projekt',ziel_ref:projekt,token_id:r.token_id},headers:{authorization:'Bearer daemon'}})).statusCode,403);
    const w=await verwaltung.inject({method:'POST',url:'/api/assets/ansicht-links/widerrufen',payload:{bereich:'projekt',ziel_ref:projekt,token_id:r.token_id,grund:'test'},headers:{authorization:'Bearer user'}});
    assert.equal(w.statusCode,200);assert.equal(w.json().widerrufen,1);
    assert.equal(gehalten.has('a15-'+r.token_id),false,'Retention freigegeben');
    const g=await oeffentlich.inject({method:'GET',url});
    assert.equal(g.statusCode,410);assert.equal(g.json().error.code,'widerrufen');
    const liste=await verwaltung.inject({method:'GET',url:'/api/assets/ansicht-links?bereich=projekt&ziel_ref='+projekt,headers:{authorization:'Bearer user'}});
    assert.equal(liste.statusCode,200);assert.equal(liste.body.includes(token),false);
    assert.equal(liste.json().links.find(l=>l.token_id===r.token_id).status,'widerrufen');
  }finally{await oeffentlich.close();await verwaltung.close();}
});

test('Rechte-/Löschänderung: Projekt gesperrt und Asset gelöscht widerrufen betroffene Links',async()=>{
  const id=String((await db.query("INSERT INTO asset_files(project,file_path,file_name,status) VALUES($1,'loesch.png','loesch.png','ok') RETURNING id",[projekt])).rows[0].id);
  const d=neuerDienst(),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d,{id});
    await db.query('UPDATE asset_files SET deleted_at=NOW() WHERE id=$1',[id]);
    const g=await app.inject({method:'GET',url:'/api/assets/ansicht/'+tokenAus(r.url)});
    assert.equal(g.statusCode,410);assert.equal(g.json().error.code,'widerrufen');
    assert.equal((await db.query('SELECT widerruf_grund FROM ansicht_tokens WHERE token_id=$1',[r.token_id])).rows[0].widerruf_grund,'asset_geloescht');
    const gesperrt=neuerDienst({projektAktiv:async()=>false}),r2=await erzeuge(d);
    const app2=await neueApp(gesperrt,true);
    try{assert.equal((await app2.inject({method:'GET',url:'/api/assets/ansicht/'+tokenAus(r2.url)})).json().error.code,'widerrufen');}
    finally{await app2.close();}
  }finally{await app.close();}
});

test('Neustart: neuer Dienst und neue App sehen denselben PG-Zustand',async()=>{
  const d1=neuerDienst(),r=await erzeuge(d1,{offen_sekunden:120});
  const app=await neueApp(neuerDienst(),true);
  try{assert.equal((await app.inject({method:'GET',url:'/api/assets/ansicht/'+tokenAus(r.url)})).statusCode,200);}
  finally{await app.close();}
});

test('Unbekannter Token 404 ohne Metadaten; HEAD/andere Pfade und alle anderen /api-Routen ohne Bearer 401',async()=>{
  const d=neuerDienst(),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d),token=tokenAus(r.url);
    const unbekannt=await app.inject({method:'GET',url:'/api/assets/ansicht/'+'B'.repeat(43)});
    assert.equal(unbekannt.statusCode,404);assert.deepEqual(unbekannt.json(),{success:false,error:{code:'nicht_gefunden'}});
    for(const [method,url] of [['HEAD','/api/assets/ansicht/'+token],['GET','/api/assets/ansicht/'+token+'/x'],['GET','/api/assets/ansicht/'+token.slice(1)],
      ['GET','/api/assets/ansicht-links'],['GET','/api/projects'],['GET','/api/assets/anderes']])
      assert.equal((await app.inject({method,url})).statusCode,401,method+' '+url.replace(token,'<token>'));
  }finally{await app.close();}
});

test('Rate-Limit je Client-IP; CF-Connecting-IP nur über konfigurierten Proxy',async()=>{
  const d=neuerDienst({link:{...link,rateProMinute:2}}),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d),url='/api/assets/ansicht/'+tokenAus(r.url);
    const codes=[];for(let i=0;i<3;i++)codes.push((await app.inject({method:'GET',url,remoteAddress:'10.0.0.9'})).statusCode);
    assert.deepEqual(codes,[200,200,429]);
    // Vertrauenswürdiger Proxy: unterschiedliche CF-Clients zählen getrennt.
    assert.equal((await app.inject({method:'GET',url,remoteAddress:'127.0.0.1',headers:{'cf-connecting-ip':'203.0.113.5'}})).statusCode,200);
    const ip=(await db.query("SELECT client_ip FROM ansicht_token_audit WHERE token_id=$1 ORDER BY id DESC LIMIT 1",[r.token_id])).rows[0].client_ip;
    assert.equal(ip,'203.0.113.5');
  }finally{await app.close();}
});

test('TP-C Sicherheit: nur der exakte Pfad ist offen; Varianten, Methoden und Kodierungen bleiben zu',async()=>{
  const d=neuerDienst(),app=await neueApp(d,true);
  // Rohes HTTP statt inject: inject/URL normalisiert Punktsegmente clientseitig; hier zaehlt, was der Server sieht.
  const net=await import('node:net');
  await app.listen({port:0,host:'127.0.0.1'});
  const roh=(method,pfad)=>new Promise((res,rej)=>{
    const s=net.connect(app.server.address().port,'127.0.0.1',()=>s.write(method+' '+pfad+' HTTP/1.1\r\nHost: synapse.test\r\nConnection: close\r\n\r\n'));
    let daten='';s.setEncoding('utf8');s.on('data',c=>{daten+=c;});s.on('error',rej);
    s.on('end',()=>res({statusCode:Number(daten.split(' ')[1]),body:daten}));
  });
  try{
    const r=await erzeuge(d),t=tokenAus(r.url),basis='/api/assets/ansicht/';
    // Query-String ist harmlos (Pfad bleibt exakt), Ergebnis wie ohne.
    assert.equal((await roh('GET',basis+t+'?x=1')).statusCode,200);
    const varianten=[
      ['GET',basis+t+';x'],['GET',basis+t+'%00'],['GET','/api/assets//ansicht/'+t],['GET',basis+'/'+t],
      ['GET','/api/assets/./ansicht/'+t],['GET','/api/assets/x/../ansicht/'+t],['GET','/api/assets/ANSICHT/'+t],
      ['GET',basis+t.slice(0,42)+'%2F'],['GET',basis+'%2e%2e%2fansicht-links'],['GET',basis+t+'/..'],
      ['OPTIONS',basis+t],['PUT',basis+t],['DELETE',basis+t],['PATCH',basis+t],['POST',basis+t],['HEAD',basis+t],
    ];
    for(const [method,url] of varianten){
      const a=await roh(method,url),wo=method+' '+url.replace(t,'<token>')+' -> '+a.statusCode;
      assert.notEqual(a.statusCode,200,wo);
      // OPTIONS ist CORS-Preflight (204 ohne Inhalt); sonst Bearer-Zwang (401) bzw. Parserabweisung (400).
      if(method!=='OPTIONS')assert.ok([400,401].includes(a.statusCode),wo);
      assert.equal(a.body.includes('image/png'),false,wo);
      assert.equal(a.body.split('\r\n\r\n').slice(1).join('').includes(t),false,'Antwort ohne Token: '+wo);
    }
    // Gross geschriebenes /API faellt nicht unter den Bearer-Praefix, darf aber nie den Link ausliefern.
    const gross=await roh('GET','/API/assets/ansicht/'+t);
    assert.notEqual(gross.statusCode,200);
    // Kein Abruf ueber eine der Varianten verbraucht/zaehlt den Link.
    const zeile=(await db.query('SELECT abrufe FROM ansicht_tokens WHERE token_id=$1',[r.token_id])).rows[0];
    assert.equal(Number(zeile.abrufe),1,'nur der ?x=1-Abruf zaehlt');
  }finally{await app.close();}
});

test('TP-C Sicherheit: CF-Connecting-IP von nicht vertrauenswuerdigem Absender umgeht das Rate-Limit nicht; Fehlerantworten tragen Sicherheitsheader ohne Metadaten',async()=>{
  const d=neuerDienst({link:{...link,rateProMinute:2}}),app=await neueApp(d,true);
  try{
    const r=await erzeuge(d),url='/api/assets/ansicht/'+tokenAus(r.url);
    const codes=[];
    for(let i=0;i<3;i++)codes.push((await app.inject({method:'GET',url,remoteAddress:'198.51.100.7',headers:{'cf-connecting-ip':'203.0.113.'+(10+i)}})).statusCode);
    assert.deepEqual(codes,[200,200,429],'gefaelschte CF-IPs zaehlen als ein Absender');
    const ips=(await db.query("SELECT DISTINCT client_ip FROM ansicht_token_audit WHERE token_id=$1 AND ereignis='abruf'",[r.token_id])).rows.map(x=>x.client_ip);
    assert.deepEqual(ips,['198.51.100.7'],'Audit nimmt den direkten Absender, nicht den Header');
    const limit=await app.inject({method:'GET',url,remoteAddress:'198.51.100.7'});
    assert.equal(limit.statusCode,429);assert.ok(limit.headers['retry-after']);
    for(const a of [limit,await app.inject({method:'GET',url:'/api/assets/ansicht/'+'C'.repeat(43),remoteAddress:'198.51.100.8'})]){
      assert.match(String(a.headers['cache-control']),/no-store/);assert.equal(a.headers['x-content-type-options'],'nosniff');
      assert.equal(a.headers['referrer-policy'],'no-referrer');assert.match(String(a.headers['content-security-policy']),/default-src 'none'; sandbox/);
      assert.deepEqual(Object.keys(a.json()).sort(),['error','success']);assert.deepEqual(Object.keys(a.json().error),['code']);
    }
    // 410 verraet weder token_id noch Ziel.
    await d.widerrufen({bereich:'projekt',ziel_ref:projekt,token_id:r.token_id,grund:'tp-c'});
    const weg=await app.inject({method:'GET',url,remoteAddress:'198.51.100.9'});
    assert.equal(weg.statusCode,410);assert.deepEqual(weg.json(),{success:false,error:{code:'widerrufen'}});
    assert.equal(weg.body.includes(r.token_id),false);assert.equal(weg.body.includes(projekt),false);
  }finally{await app.close();}
});
