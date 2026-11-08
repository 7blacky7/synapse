/**
 * P22-T278: DeepSeek-API direkt als eigener Anbieter (deepseek-api) - ohne gueltigen Key, ohne Kosten.
 * Herkunft: Task P22-T278, thoughts c3e6c130 (Preise 08.11.2026) und 40f496c6 (User 08.11.2026: ohne Key bauen; 401 sauber als
 *   Anbieterfehler in Lauf, Laufanzeige und Debug; kein stilles Nichtstun, kein Erfolg, kein Wiederholungssturm; Heartbeat, Status,
 *   Fehlerweg, Stop messen). Quellen: core api-deepseek.ts, api-agent-dienst.ts (Buchung mit Tarif), api-agent-schleife.ts
 *   (nachOpenAi reasoning_zurueck, nutzungAusOpenAi), db/api-agent-lauf-schema.ts (Seed); rest-api api-agent-transport.ts
 *   (rufeDeepSeek/rufeOpenAiFormat), api-agent-auswahl.ts (Key-Status, Blocker deepseek_aus, Debug), api-agent-lauf.ts (Lauf, Fehlerweg).
 * Zusaetzlich P22-T202 P1 auf REST-Ebene: Main mit offenem Runtime-Auftrag -> API-Start wechsel_offen; Main als API -> CLI-Auftrag
 *   api_lauf_gewaehlt; Daemon-Claim liefert nichts.
 * Nachbesserung nach Abnahme 1dbf6af2 (claude-linde, 08.11.2026): P2-1 Main MIT Laufwahl + Tageslimit im Chat-Turn (apiLaufMainTurn,
 *   warteAufRueckfallWechsel) -> Rueckfall, Chatnachricht genau einmal; P2-2 spawneAlsApiLauf unter der CLI/API-Sperre (cli_laeuft,
 *   api_lauf_gewaehlt) und Rueckrichtung mitCliStartSperre (api_lauf_aktiv). Kette fuer alle Anbieter: T183-Test (OpenRouter -> haiku).
 * Anbieter = lokaler Fake-Server im DeepSeek-Format (SYNAPSE_DEEPSEEK_BASE_URL). Optionen:
 *   --echt-401  EIN echter Aufruf an https://api.deepseek.com mit ungueltigem Key (kostenlos, erwartet HTTP 401)
 *   --browser   KI-Browser: Auswahl DeepSeek direkt -> Start -> sichtbarer 401 -> Stop (api-deepseek-browser-helfer.mjs);
 *               mit --echt-401 gegen den echten Endpunkt, sonst gegen den 401-Fake
 * Nur synapse_test:5433, privates Schema.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
const require=createRequire(new URL('../../core/package.json',import.meta.url)),{Pool}=require('pg');
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
// P22-T278 D: echter Key (User-.env, Name DEEPSEEK_API_KEY) nur fuer --echt-turn gemerkt; wird nie ausgegeben.
const ECHT_KEY=process.env.DEEPSEEK_API_KEY?.trim()||null;
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','SYNAPSE_OPENROUTER_API_KEY','JEV_OPENROUTER_API_KEY',
 'SYNAPSE_DEEPSEEK_API_KEY','SYNAPSE_DEEPSEEK_BASE_URL','DEEPSEEK_API_KEY'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_HAUPTAGENT:'1',
 SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1'});
const echtesFetch=globalThis.fetch;
let netz=0;globalThis.fetch=async()=>{netz++;throw Error('P22-T278 Netzwerk gesperrt');};
const admin=new Pool({connectionString:url.href}),schema='p22_t278_'+process.pid+'_'+randomUUID().slice(0,8);
let C,pool,v,checks=0;const P='t278-privat',USER={art:'user'};
const check=(ok,label,wert)=>{checks++;assert.ok(ok,'P22-T278 '+label+' | erwartet wahr / tatsaechlich '+JSON.stringify(wert??ok));};
const error=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};
const rund=x=>Math.round(x*1e8)/1e8;
const pause=ms=>new Promise(r=>setTimeout(r,ms));

// Fake-DeepSeek: 401 wie api.deepseek.com bei ungueltigem Key, sonst vorbereitete Antworten der Reihe nach.
const fake={modus:'401',anfragen:[],antworten:[]};
const server=createServer((req,res)=>{let roh='';req.on('data',c=>{roh+=c;});req.on('end',()=>{
 let body=null;try{body=JSON.parse(roh);}catch{/* leer */}
 fake.anfragen.push({pfad:req.url,auth:req.headers.authorization,body});
 if(fake.modus==='402'||fake.modus==='429'){
  res.writeHead(Number(fake.modus),{'content-type':'application/json'});
  res.end(JSON.stringify({error:{message:fake.modus==='402'?'Insufficient Balance':'Rate Limit Reached',type:'fake',param:null,code:'fake'}}));
  return;
 }
 if(fake.modus==='401'){
  res.writeHead(401,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{message:'Authentication Fails, Your api key: ****t278 is invalid',type:'authentication_error',param:null,code:'invalid_request_error'}}));
  return;
 }
 const a=fake.antworten.shift();
 res.writeHead(a?200:500,{'content-type':'application/json'});res.end(JSON.stringify(a??{error:{message:'Fake: keine Antwort vorbereitet'}}));
});});

try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const q=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+seq);
  await admin.query('ALTER TABLE '+schema+'.'+q(r.table_name)+' ALTER COLUMN '+q(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 C=await import('../../core/dist/index.js');pool=C.getPool();
 const A=await import('../dist/services/api-agent-auswahl.js'),T=await import('../dist/services/api-agent-transport.js'),L=await import('../dist/services/api-agent-lauf.js');
 await pool.query(C.API_AGENT_LAUF_SCHEMA_SQL);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'T278 Testbestand alle'},{system:'user'});

 // Einheiten: Tarif, usage, reasoning_content
 check(C.deepseekSpitzenzeit(new Date('2026-11-09T02:30:00Z'))===true,'Tarif Mo 02:30 UTC Spitze');
 check(C.deepseekSpitzenzeit(new Date('2026-11-09T00:59:00Z'))===false,'Tarif Mo 00:59 UTC Nebenzeit');
 check(C.deepseekSpitzenzeit(new Date('2026-11-09T05:00:00Z'))===false,'Tarif Mo 05:00 UTC Nebenzeit');
 check(C.deepseekSpitzenzeit(new Date('2026-11-09T09:59:59Z'))===true,'Tarif Mo 09:59 UTC Spitze');
 check(C.deepseekSpitzenzeit(new Date('2026-11-09T10:00:00Z'))===false,'Tarif Mo 10:00 UTC Nebenzeit');
 check(C.deepseekSpitzenzeit(new Date('2026-11-07T07:00:00Z'))===false,'Tarif Samstag Nebenzeit');
 check(C.deepseekTarif(new Date('2026-11-08T07:00:00Z')).faktor===0.5,'Tarif Sonntag halber Preis');
 const nu=C.nutzungAusOpenAi({prompt_tokens:100,completion_tokens:5,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40});
 check(nu.input===40&&nu.cache_read===60&&nu.output===5,'usage DeepSeek: Treffer/Fehlschuss getrennt',nu);
 const roh=t=>({typ:'roh',anbieter:'openai',block:{type:'reasoning',text:t}});
 const verlauf=[{rolle:'user',inhalt:[{typ:'text',text:'Frage 1'}]},{rolle:'assistant',inhalt:[roh('ALT'),{typ:'text',text:'Antwort 1'}]},
  {rolle:'user',inhalt:[{typ:'text',text:'Frage 2'}]},{rolle:'assistant',inhalt:[roh('NEU'),{typ:'werkzeug_aufruf',id:'c1',name:'x',eingabe:{}}]},
  {rolle:'user',inhalt:[{typ:'werkzeug_ergebnis',aufruf_id:'c1',inhalt:[{typ:'text',text:'ok'}],fehler:false}]}];
 const ass=C.nachOpenAi('s',verlauf,{reasoning_zurueck:true}).filter(m=>m.role==='assistant');
 check(ass.length===2&&ass[0].reasoning_content==='ALT'&&ass[1].reasoning_content==='NEU','reasoning_content aller Runden zurueck (Doku: mit tools Pflicht)',ass);
 const ohneDenken=C.nachOpenAi('s',[{rolle:'user',inhalt:[{typ:'text',text:'x'}]},{rolle:'assistant',inhalt:[{typ:'text',text:'Uebergabe gelesen'}]}],{reasoning_zurueck:true});
 check(ohneDenken[2].reasoning_content==='','assistant ohne gespeicherte Gedankenkette: reasoning_content leer statt fehlend',ohneDenken);
 check(C.nachOpenAi('s',verlauf).every(m=>m.reasoning_content===undefined),'ohne Option (OpenRouter) kein reasoning_content');

 // Registry-Seed und Schalter
 const modelle=await C.leseApiModelle();
 const fl=modelle.find(m=>m.alias==='ds-flash'),pro=modelle.find(m=>m.alias==='ds-v4-pro');
 check(fl?.anbieter==='deepseek-api'&&fl.anbieter_modell==='deepseek-flash'&&fl.eingabe===0.3&&fl.ausgabe===1.2&&fl.cache_lesen===0.006&&fl.context_window===1000000&&fl.output_limit===65536,'Seed ds-flash',fl);
 check(pro?.anbieter==='deepseek-api'&&pro.anbieter_modell==='deepseek-v4-pro'&&pro.eingabe===1.32&&pro.ausgabe===3.96&&pro.cache_lesen===0.044&&pro.context_window===1000000&&pro.output_limit===65536,'Seed ds-v4-pro',pro);
 check(!(await C.leseDeepseekSchalter(P)).aktiv,'Schalter api_deepseek_direkt Standard AUS trotz alle');

 const vor=(name,rolle,project=P)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project,name,rolle,grund:'T278 Testidentitaet'},USER);
 const W=await vor('t278-arbeit','subagent'),K=await vor('t278-koord','koordinator'),B=await vor('t278-browser','subagent');
 for(const project of [P,C.HAUPTAGENT_PROJEKT])for(const funktion of ['api_agenten_auswahl','api_agenten_lauf_intern','api_agenten'])
  await C.setzeProfilProduktSchalter({ebene:'projekt',project,funktion,aktiv:true,grund:'T278 explizit EIN'},{system:'user'});
 await C.setzeApiSchalter(USER,{aktiv:true,grund:'T278 API-Funktion Test'});
 await C.setzeApiBudget(USER,{grenze_usd:0.1,zeitraum:'tag',erlaubte_modelle:['ds-flash','ds-v4-pro'],grund:'T278 kleines privates Budget'});
 for(const x of [W,K,B])await C.setzeApiFreigabe(USER,{identity_id:x.identity_id,modelle:['ds-flash'],grenze_usd:0.05,grund:'T278 explizite Freigabe'});
 const anfrage=(id,modell='ds-flash')=>({identity_id:id,modell,auftrag:'Antworte T278 genau einmal.',grund:'T278 expliziter Testauftrag',
  kosten_bestaetigt:true,wechsel_bestaetigt:true,idempotenz_schluessel:randomUUID()});
 const s0=(await A.apiAnbieterStand(P))['deepseek-api'];
 check(s0.vorhanden===false&&s0.quelle===null&&s0.schalter_aktiv===false,'Key-Status fehlt und Schalter AUS getrennt sichtbar',s0);
 check(await error(()=>A.starteApiAuswahl(anfrage(W.identity_id),USER))==='deepseek_aus','Start bei Schalter AUS blockiert (deepseek_aus)');
 for(const project of [P,C.HAUPTAGENT_PROJEKT])
  await C.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'api_deepseek_direkt',aktiv:true,grund:'T278 DeepSeek explizit EIN'},{system:'user'});
 const ohneKey=await A.apiAuswahlStand(W.identity_id,USER);
 check(ohneKey.debug.deepseek.key==='fehlt'&&ohneKey.debug.deepseek.schalter===true&&ohneKey.debug.deepseek.basis==='https://api.deepseek.com','Debug: Key fehlt, Schalter EIN, Basis',ohneKey.debug.deepseek);
 check(await error(()=>A.starteApiAuswahl(anfrage(W.identity_id),USER))==='api_zugang_fehlt','ohne Key: Start mit api_zugang_fehlt');
 check(fake.anfragen.length===0,'ohne Key kein Anbieteraufruf',fake.anfragen.length);
 const KEY='sk-t278-ungueltig-'+randomUUID().slice(0,8);
 process.env.SYNAPSE_DEEPSEEK_API_KEY=KEY;process.env.SYNAPSE_DEEPSEEK_BASE_URL='http://127.0.0.1:'+server.address().port;
 const mitKey=await A.apiAuswahlStand(W.identity_id,USER);
 check(mitKey.anbieter['deepseek-api'].vorhanden&&mitKey.anbieter['deepseek-api'].quelle==='SYNAPSE_DEEPSEEK_API_KEY'&&!JSON.stringify(mitKey).includes(KEY),'Key nur als vorhanden/Quelle, Wert nie in der Antwort');

 // 401-Weg im Lauf: Anbieterfehler sichtbar, nichts berechnet, Auftrag bleibt, keine Wiederholung, Stop.
 const start=await A.starteApiAuswahl(anfrage(W.identity_id),USER);
 check(start.wahl.phase==='aktiv'&&start.wahl.anbieter==='deepseek-api','Start Arbeitsagent mit DeepSeek direkt',start.wahl);
 const werkzeugAufrufe=[];
 v=new L.LaufVerwaltung({db:pool,ausweis:async()=>W.token,
  liste:async()=>[{name:'thought',description:'Notizen',inputSchema:{type:'object',properties:{action:{type:'string'}}}}],
  aufruf:async(name,args)=>{if(name!=='chat')werkzeugAufrufe.push({name,args});return {content:[{type:'text',text:name==='chat'?'T278 Anmeldung':'WERKZEUG-T278-OK'}]};},
  transport:a=>T.rufeApiTransport({...a,holen:echtesFetch})});
 await v.takt();await v.warteAufTurns();
 const lauf=async id=>(await pool.query('SELECT status,letzter_fehler,lease_token,letzte_aktivitaet,kontext_tokens,kontext_fenster FROM api_agent_laeufe WHERE identity_id=$1',[id])).rows[0];
 let l=await lauf(W.identity_id);
 check(fake.anfragen.length===1&&fake.anfragen[0].pfad==='/chat/completions'&&fake.anfragen[0].auth==='Bearer '+KEY,'genau ein Anbieteraufruf mit Bearer-Key',fake.anfragen.map(a=>a.pfad));
 const b0=fake.anfragen[0].body;
 check(b0?.model==='deepseek-flash'&&b0.stream===false&&b0.thinking?.type==='enabled'&&b0.usage===undefined&&b0.max_tokens<=65536&&b0.tools?.[0]?.function?.name==='mcp__synapse__thought',
  'Anfrage im OpenAI-Format an deepseek-flash mit Werkzeugen',b0&&{model:b0.model,stream:b0.stream,max:b0.max_tokens});
 check(l.status==='fehler'&&l.letzter_fehler==='api_zugang_ungueltig'&&l.lease_token===null&&l.letzte_aktivitaet!==null,'Lauf: Status fehler, Code api_zugang_ungueltig, Lease frei, Heartbeat',l);
 const turn=(await pool.query('SELECT ende,meldung FROM api_agent_turns WHERE identity_id=$1 ORDER BY id DESC LIMIT 1',[W.identity_id])).rows[0];
 check(turn.ende==='nicht_begonnen'&&turn.meldung.includes('HTTP 401')&&turn.meldung.includes('DeepSeek hat den API-Key abgelehnt')&&!turn.meldung.includes(KEY),'Turn: Anbieterfehler 401 mit Meldung, Key nicht im Text',turn);
 const res=(await pool.query('SELECT status,usd::float8 AS usd,fehler FROM api_agent_reservierungen WHERE identity_id=$1 ORDER BY erstellt_am',[W.identity_id])).rows;
 check(res.length===1&&res[0].status==='freigegeben'&&res[0].usd===0&&res[0].fehler.startsWith('HTTP 401'),'Reservierung freigegeben, 0 USD',res);
 // P3 a (Kanal 37424): Key-Endung der Anbietermeldung ('****t278') nirgends gespeichert.
 check(!/\*{4}t278/.test(turn.meldung)&&turn.meldung.includes('api key: *** is invalid')&&!/\*{4}t278/.test(res[0].fehler),'P3 a: Key-Endung aus Anbietermeldung entfernt (Turn, Reservierung)',{t:turn.meldung,r:res[0].fehler});
 check(T.maskiereAnbieterText('Your api key: ****c65c is invalid','x')==='Your api key: *** is invalid'&&T.maskiereAnbieterText('key sk-abcdef123 und ****9z9z','sk-abcdef123')==='key *** und ***','P3 a: maskiereAnbieterText (Key, Endung, sk-)');
 check((await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL',[W.identity_id])).rows[0].n===1,'Auftrag bleibt offen');
 const letzte=v.zustand().letzte[0];
 check(letzte.code==='api_zugang_ungueltig'&&String(letzte.meldung).includes('401'),'Debug zustand().letzte: Code und 401-Meldung',letzte);
 const ls=(await C.apiLaeufeStand(USER,P)).laeufe.find(x=>x.identity_id===W.identity_id);
 check(ls.letzter_fehler==='api_zugang_ungueltig'&&ls.letzter_turn.meldung.includes('HTTP 401')&&!JSON.stringify(ls).includes(KEY),'Laufanzeige (REST-Stand): Code und 401-Meldung',ls);
 for(let i=0;i<3;i++){await v.takt();await v.warteAufTurns();await pause(50);}
 check(fake.anfragen.length===1,'kein Wiederholungssturm nach 401 (3 weitere Takte)',fake.anfragen.length);
 check((await pool.query('SELECT count(*)::int n FROM agent_verbrauch WHERE identity_id=$1',[W.identity_id])).rows[0].n===0,'nach 401 nichts gebucht');
 await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'stoppen',grund:'T278 Stop nach 401'});
 check((await lauf(W.identity_id)).status==='gestoppt','Stop nach 401');
 await v.takt();await v.warteAufTurns();
 check(fake.anfragen.length===1,'gestoppt: kein weiterer Aufruf');

 // Erfolg mit Thinking-Toolrunde (Fake): reasoning_content zurueck, Kosten aus usage mal Tarif, Kontext.
 fake.modus='ok';
 fake.antworten.push(
  {id:'r1',choices:[{index:0,message:{role:'assistant',content:'',reasoning_content:'DENKEN-1',
    tool_calls:[{id:'call_1',type:'function',function:{name:'mcp__synapse__thought',arguments:'{"action":"search"}'}}]},finish_reason:'tool_calls'}],
   usage:{prompt_tokens:1000,completion_tokens:50,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200,total_tokens:1050}},
  {id:'r2',choices:[{index:0,message:{role:'assistant',content:'DEEPSEEK-T278-ANTWORT',reasoning_content:'DENKEN-2'},finish_reason:'stop'}],
   usage:{prompt_tokens:1200,completion_tokens:30,prompt_cache_hit_tokens:1000,prompt_cache_miss_tokens:200,total_tokens:1230}});
 await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'fortsetzen',grund:'T278 fortsetzen (Fake mit Antwort)'});
 await v.takt();await v.warteAufTurns();
 l=await lauf(W.identity_id);
 const t2=(await pool.query('SELECT ende,antwort,kosten_usd::float8 AS k FROM api_agent_turns WHERE identity_id=$1 ORDER BY id DESC LIMIT 1',[W.identity_id])).rows[0];
 check(fake.anfragen.length===3&&t2.ende==='fertig'&&t2.antwort.includes('DEEPSEEK-T278-ANTWORT'),'Erfolg: zwei Aufrufe, Antwort im Turn',{n:fake.anfragen.length,t2});
 check(werkzeugAufrufe.length===1&&werkzeugAufrufe[0].name==='thought','Werkzeugaufruf ausgefuehrt',werkzeugAufrufe);
 const m2=fake.anfragen[2].body.messages,ai=m2.findIndex(m=>m.role==='assistant'&&m.tool_calls);
 check(ai>0&&m2[ai].reasoning_content==='DENKEN-1'&&m2[ai+1]?.role==='tool'&&m2[ai+1].tool_call_id==='call_1','Thinking: reasoning_content der laufenden Runde zurueck, tool-Nachricht folgt',m2.slice(ai));
 const f=C.deepseekTarif().faktor;
 const erwartet=[rund(rund((200*0.30+800*0.006+50*1.20)/1e6)*f),rund(rund((200*0.30+1000*0.006+30*1.20)/1e6)*f)];
 const geb=(await pool.query("SELECT usd::float8 AS usd FROM api_agent_reservierungen WHERE identity_id=$1 AND status='gebucht' ORDER BY abgeschlossen_am",[W.identity_id])).rows.map(z=>z.usd);
 check(geb.length===2&&Math.abs(geb[0]-erwartet[0])<1e-9&&Math.abs(geb[1]-erwartet[1])<1e-9,'Kosten nach usage (Treffer/Fehlschuss/Ausgabe) mal Tarif-Faktor '+f,{geb,erwartet});
 check(Math.abs(t2.k-(erwartet[0]+erwartet[1]))<1e-8,'Turnkosten = Summe der Buchungen',t2.k);
 const vb=(await pool.query('SELECT runtime,input_tokens::int i,cache_read_tokens::int c,output_tokens::int o FROM agent_verbrauch WHERE identity_id=$1 ORDER BY id',[W.identity_id])).rows;
 check(vb.length===2&&vb.every(z=>z.runtime==='deepseek-api')&&vb[0].i===200&&vb[0].c===800&&vb[1].c===1000,'agent_verbrauch: runtime deepseek-api, Cache-Treffer getrennt',vb);
 check(l.status==='bereit'&&l.letzter_fehler===null&&Number(l.kontext_tokens)===1200&&Number(l.kontext_fenster)===1000000,'Lauf bereit, Kontext 1200 von 1M',l);
 // B (Nachauftrag 37397): Verbrauch + Cache im Lauf-Stand (Laufanzeige/Hintergrund-Laeufe).
 const lb=await C.apiLaeufeStand(USER,P),wb=lb.laeufe.find(x=>x.identity_id===W.identity_id),vt=wb.verbrauch_letzter_turn;
 check(Number(vt.aufrufe)===2&&Number(vt.treffer)===1800&&Number(vt.fehlschuss)===400&&Number(vt.ausgabe)===80&&Math.abs(Number(vt.usd)-(erwartet[0]+erwartet[1]))<1e-8,
  'B: letzter Turn - Treffer 1800, Fehlschuss 400, Ausgabe 80, USD = Buchungen',vt);
 check(Number(wb.verbrauch_heute.aufrufe)===2&&Number(wb.verbrauch_sitzung.aufrufe)===2&&['spitze','neben'].includes(lb.deepseek_tarif?.tarif),'B: Sitzung/Tag zaehlen nur gebuchte Aufrufe (401 freigegeben), Tarif im Stand',{h:wb.verbrauch_heute,s:wb.verbrauch_sitzung,t:lb.deepseek_tarif});
 await v.beende();v=null;

 // P3 d (Kanal 37424): Tarif nach Anfragebeginn (Reservierung erstellt_am), nicht nach dem Abschluss (heute Sonntag = Nebenzeit).
 {
  const usage={input_tokens:1000,output_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0,kosten_usd:null};
  const tarifTest=async beginn=>{
   const rv=await C.reserviereApiAufruf({identity_id:W.identity_id,project:P,agent_id:W.agent_id,modell:'ds-flash',eingabe_zeichen:100,max_tokens:100,zugang:'agent'});
   await pool.query('UPDATE api_agent_reservierungen SET erstellt_am=$2 WHERE id=$1',[rv.reservierung_id,beginn]);
   return (await C.schliesseApiAufrufAb({reservierung_id:rv.reservierung_id,agent_id:W.agent_id,usage})).usd;
  };
  const voll=rund((1000*0.30+100*1.20)/1e6);
  const spitze=await tarifTest(new Date('2026-11-02T03:59:00Z')),neben=await tarifTest(new Date('2026-10-31T03:59:00Z'));
  check(Math.abs(spitze-voll)<1e-9&&Math.abs(neben-rund(voll*0.5))<1e-9,'P3 d: Tarif nach Anfragebeginn (Mo 03:59 UTC voller Preis, Sa halber Preis), Abschluss egal',{spitze,neben,voll});
 }
 // Rollen (Koordinator, Main) und P22-T202 P1 auf REST-Ebene.
 const sk=await A.starteApiAuswahl(anfrage(K.identity_id),USER);
 check(sk.wahl.anbieter==='deepseek-api','Koordinator mit DeepSeek direkt gestartet',sk.wahl);
 const M=await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'});
 const offenM=await C.legeRuntimeAuftragAn(USER,{art:'neustart',grund:'T278/P1 offener CLI-Auftrag'});
 check(await error(()=>A.starteApiAuswahl(anfrage('main','ds-v4-pro'),USER))==='wechsel_offen','P1 Rueckrichtung: offener Runtime-Auftrag blockiert API-Start');
 await pool.query("UPDATE agent_runtime_auftraege SET status='completed',abgeschlossen_am=NOW() WHERE id=$1",[offenM.auftrag.auftrag_id]);
 const sm=await A.starteApiAuswahl(anfrage('main','ds-v4-pro'),USER);
 check(sm.identity_id===M.identity_id&&sm.wahl.modell==='ds-v4-pro','Main mit DeepSeek direkt (ds-v4-pro) gestartet',sm.wahl);
 check(await error(()=>C.legeRuntimeAuftragAn(USER,{art:'neustart',grund:'T278/P1 CLI-Neustart trotz API'}))==='api_lauf_gewaehlt','P1: Main als API -> CLI-Neustart abgelehnt');
 check(await error(()=>C.legeRuntimeAuftragAn(USER,{art:'modellwechsel',gewuenscht:{modell:'sonnet'},grund:'T278/P1 Modellwechsel trotz API'}))==='api_lauf_gewaehlt','P1: Main als API -> CLI-Modellwechsel abgelehnt');
 check((await C.claimeRuntimeAuftraege({projekte:[C.HAUPTAGENT_PROJEKT]})).length===0,'P1: Daemon-Claim liefert nichts');
 // A (Nachauftrag 37397): Key SYNAPSE_DEEPSEEK_API_KEY bevorzugt, sonst DEEPSEEK_API_KEY; Quelle benannt.
 check(T.deepseekSchluessel({DEEPSEEK_API_KEY:'a'}).quelle==='DEEPSEEK_API_KEY'&&T.deepseekSchluessel({DEEPSEEK_API_KEY:'a',SYNAPSE_DEEPSEEK_API_KEY:'b'}).key==='b'
  &&T.deepseekSchluessel({}).key===null,'A: Key-Reihenfolge SYNAPSE_DEEPSEEK_API_KEY vor DEEPSEEK_API_KEY');
 // C (Nachauftrag 37397 + Korrektur 37398): Kette, Einstellung, Rueckfall bei Tageslimit.
 const rf0=await C.leseApiRueckfall();
 check(rf0.quelle==='standard'&&rf0.modelle.join()==='haiku,codex/gpt-6.1-terra,codex/gpt-6.1-luna'&&rf0.effort==='low'&&!rf0.modelle.some(m=>m.includes('astra')),
  'C: Standard-Kette haiku -> terra -> luna, Effort low, kein astra',rf0);
 check(await error(()=>C.setzeApiRueckfall({art:'identitaet',principal:{}},{modelle:['haiku'],grund:'T278 nicht erlaubt'}))==='recht_fehlt','C: Kette setzt nur der User');
 check(await error(()=>C.setzeApiRueckfall(USER,{modelle:['xyz-unbekannt'],grund:'T278 ungueltig'}))==='rueckfall_modell_ungueltig','C: unbekanntes Modell abgelehnt');
 const rf1=await C.setzeApiRueckfall(USER,{modelle:['haiku','codex/gpt-6.1-terra'],effort:'medium',grund:'T278 eigene Kette'});
 check(rf1.quelle==='einstellung'&&rf1.modelle.length===2&&rf1.effort==='medium','C: Kette einstellbar',rf1);
 check((await C.setzeApiRueckfall(USER,{modelle:[],grund:'T278 zurueck auf Standard'})).quelle==='standard','C: leere Liste = Standard');
 {
  const reqApi=createRequire(new URL('../package.json',import.meta.url)),app=reqApi('fastify')({logger:false});
  try{
   const {agentApiRoutes}=await import('../dist/routes/agent-api.js');
   await app.register(async f=>agentApiRoutes(f,async()=>USER));
   const g=await app.inject({method:'GET',url:'/api/main-agent/api/rueckfall'});
   check(g.statusCode===200&&g.json().rueckfall?.quelle==='standard','C: REST GET /api/main-agent/api/rueckfall',g.body.slice(0,300));
  }finally{await app.close();}
 }
 C.registriereCliModellKatalog(async rt=>rt==='codex'
  ?{modelle:[{id:'gpt-6.1-luna',name:'GPT-6.1 Luna',beschreibung:null,sichtbar:true,gruppe:null,familie:null,standard:false}],grund:null}:{modelle:[],grund:'leer'});
 const spawns=[];
 const vr=new L.LaufVerwaltung({db:pool,liste:async()=>[],ausweis:async()=>K.token,aufruf:async()=>({content:[{type:'text',text:'T278 Rueckfall Anmeldung'}]}),
  transport:async()=>{throw Object.assign(Error('Budget erschoepft'),{code:'budget_erschoepft'});},
  rueckfall:async a=>{spawns.push({name:a.name,model:a.model,effort:a.effort??null,task:a.task});
   return a.model==='haiku'?{success:false,error:'runtime_daemon_nicht_angemeldet'}:{success:true,runtime:'codex'};}});
 try{await vr.takt();await vr.warteAufTurns();}finally{await vr.beende();C.registriereCliModellKatalog(null);}
 const ks=spawns.filter(s=>s.name===K.agent_id);
 check(ks.length===2&&ks[0].model==='haiku'&&ks[0].effort===null&&ks[1].model==='codex/gpt-6.1-luna'&&ks[1].effort==='low'&&ks[1].task.includes('Antworte T278 genau einmal.'),
  'C: haiku scheitert -> terra nicht verfuegbar -> luna mit Effort low, Originalauftrag dabei',spawns);
 check(spawns.every(s=>s.name===K.agent_id),'C: Main startet keinen Spezialisten',spawns.map(s=>s.name));
 const lk=await lauf(K.identity_id);
 check(lk.status==='gestoppt'&&String(lk.letzter_fehler).startsWith('rueckfall_container:')&&String(lk.letzter_fehler).includes('codex/gpt-6.1-luna'),'C: Koordinator-Lauf gestoppt, Rueckfall benannt',lk);
 check(await C.leseApiLaufWahl(K.identity_id)===null,'C: API-Wahl vor dem CLI-Start freigegeben (P1)');
 check((await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL',[K.identity_id])).rows[0].n===0,'C: Originalauftrag genau einmal uebergeben');
 const dk=vr.zustand().letzte.find(e=>e.ende==='ruckfall_container'&&e.identity_id===K.identity_id);
 check(dk?.versuche?.map(x=>x.modell+':'+x.ergebnis).join()==='haiku:fehlgeschlagen,codex/gpt-6.1-terra:nicht_verfuegbar,codex/gpt-6.1-luna:gestartet','C: Debug nennt die Versuche',dk);
 const chatK=(await pool.query("SELECT text FROM hauptagent_verlauf WHERE identity_id=$1 AND text LIKE 'Tageslimit erreicht%'",[K.identity_id])).rows;
 check(chatK.length===1&&chatK[0].text.includes('codex/gpt-6.1-luna'),'C: Wechsel im Chat sichtbar (Tageslimit erreicht)',chatK);
 const am=(await pool.query("SELECT gewuenscht,status FROM agent_runtime_auftraege WHERE identity_id=$1 AND art='modellwechsel' AND erstellt_von='api-tageslimit'",[M.identity_id])).rows;
 check(am.length===1&&am[0].gewuenscht.modell==='haiku'&&am[0].status==='pending','C: Main -> Modellwechsel-Auftrag auf haiku (eigene Claude-Runtime)',am);
 const lm=await lauf(M.identity_id);
 check(lm.status==='gestoppt'&&lm.lease_token===null&&await C.leseApiLaufWahl(M.identity_id)===null,'C: Main-API-Lauf beendet, Wahl frei',lm);
 const cm=await C.claimeRuntimeAuftraege({projekte:[C.HAUPTAGENT_PROJEKT]});
 check(cm.length===1&&cm[0].art==='modellwechsel'&&cm[0].gewuenscht.modell==='haiku','C: Daemon bekommt den Rueckfall-Wechsel (P1-Grenze laesst ihn durch)',cm);

 // P2-1 (Abnahme 1dbf6af2): Main MIT Laufwahl, Tageslimit im Chat-Turn -> sauberer Rueckfall, Chatnachricht genau einmal.
 {
  const DM=await import('../dist/services/agent-runtime/dauerhafter-main.js');
  await pool.query("UPDATE agent_runtime_auftraege SET status='completed',abgeschlossen_am=NOW() WHERE identity_id=$1 AND status IN ('pending','claimed','accepted')",[M.identity_id]);
  const sm2=await A.starteApiAuswahl(anfrage('main','ds-v4-pro'),USER);
  check(sm2.wahl.phase==='aktiv'&&sm2.wahl.modell==='ds-v4-pro','P2-1: Main erneut per Laufwahl auf DeepSeek',sm2.wahl);
  C.registriereCliModellKatalog(async rt=>rt==='codex'
   ?{modelle:[{id:'gpt-6.1-luna',name:'GPT-6.1 Luna',beschreibung:null,sichtbar:true,gruppe:null,familie:null,standard:false}],grund:null}:{modelle:[],grund:'leer'});
  const rufe=[],versuche=[],UID=randomUUID();
  const lv=L.starteApiAgentLauf({db:pool,takt_ms:3600000,liste:async()=>[],ausweis:async()=>K.token,
   aufruf:async(name,args)=>{rufe.push({name,args});return {content:[{type:'text',text:name==='thought'?JSON.stringify({success:true,id:UID}):'ok'}]};},
   transport:async()=>{versuche.push(1);throw Object.assign(Error('Budget erschoepft'),{code:'budget_erschoepft'});}});
  try{
   const ev=[],info={};
   const session={id:'t278-p21',identityId:M.identity_id,runtimeSessionId:'t278-p21-rs',context:{}};
   const r=await DM.apiLaufMainTurn(session,'P21-CHAT-T278 bitte genau einmal',sm2.wahl.modell,e=>ev.push(e),info);
   check(r===null,'P2-1: Chat-Turn mit Laufwahl geht in den Bestand statt Fehler',r);
   check(info.rueckfall?.modell==='haiku','P2-1: Rueckfallmodell geht an den Aufrufer (haiku)',info);
   check(ev.some(x=>x.data?.hauptagent?.weg==='ruckfall_container'&&x.data.hauptagent.mit_wahl===true),'P2-1: Ereignis ruckfall_container (mit Wahl)',ev);
   const ein=(await pool.query("SELECT erledigt_am IS NOT NULL AS erledigt,turn_id FROM api_agent_eingang WHERE identity_id=$1 AND text LIKE 'P21-CHAT-T278%'",[M.identity_id])).rows;
   check(ein.length===1&&ein[0].erledigt&&ein[0].turn_id===null,'P2-1: Chatnachricht genau ein Eingang, erledigt ohne API-Turn',ein);
   check((await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL',[M.identity_id])).rows[0].n===0,'P2-1: kein offener Eingang -> kein spaeterer API-Turn mit derselben Nachricht');
   check((await pool.query("SELECT count(*)::int n FROM api_agent_turns WHERE identity_id=$1 AND ende='fertig' AND antwort LIKE '%P21%'",[M.identity_id])).rows[0].n===0&&versuche.length===1,'P2-1: kein API-Ergebnis, genau ein Anbieterversuch',versuche.length);
   const lm2=await lauf(M.identity_id);
   check(lm2.status==='gestoppt'&&String(lm2.letzter_fehler).startsWith('rueckfall_container:')&&String(lm2.letzter_fehler).includes('haiku')&&lm2.lease_token===null&&await C.leseApiLaufWahl(M.identity_id)===null,
    'P2-1: Lauf gestoppt (Marke nennt haiku), Lease und Wahl frei',lm2);
   const th=rufe.find(x=>x.name==='thought');
   check(th&&/NICHT aus dieser Uebergabe ausfuehren/.test(th.args.content)&&th.args.content.includes('P21-CHAT-T278'),'P2-1: Uebergabe nennt die Chatnachricht nur zur Info (kein Doppel durch den neuen Main)',th?.args?.content?.slice(-300));
   const au=(await pool.query("SELECT id,gewuenscht->>'modell' AS modell FROM agent_runtime_auftraege WHERE identity_id=$1 AND erstellt_von='api-tageslimit' AND status='pending'",[M.identity_id])).rows;
   check(au.length===1&&au[0].modell==='haiku','P2-1: genau ein Modellwechsel-Auftrag auf haiku (startet den Container-Main)',au);
   check(await error(()=>DM.warteAufRueckfallWechsel(M.identity_id,300,50))==='main_start_dauert','P2-1: Wechsel offen -> Chat wartet, startet nicht parallel (main_start_dauert)');
   await pool.query("UPDATE agent_runtime_auftraege SET status='completed',abgeschlossen_am=NOW() WHERE id=$1",[au[0].id]);
   check((await DM.warteAufRueckfallWechsel(M.identity_id,300,50)).gewartet_ms<300,'P2-1: Wechsel erledigt -> Chat geht an den laufenden Container-Main weiter');
   const r2=await DM.apiLaufMainTurn(session,'P21-FOLGE-T278',sm2.wahl.modell,()=>{});
   check(r2===null&&(await pool.query("SELECT count(*)::int n FROM api_agent_eingang WHERE text LIKE 'P21-FOLGE%'")).rows[0].n===0,'P2-1: Folge-Chat im Rueckfall -> Bestand, kein neuer API-Eingang');
  }finally{await lv.beende();C.registriereCliModellKatalog(null);}
 }
 // P2-2 (Abnahme 1dbf6af2): spawneAlsApiLauf unter der CLI/API-Sperre; Rueckrichtung CLI-Start neben aktivem API-Lauf.
 {
  const X=await vor('t278-p22','subagent');
  await C.setzeApiFreigabe(USER,{identity_id:X.identity_id,modelle:['ds-flash'],grenze_usd:0.05,grund:'T278 P2-2 Freigabe'});
  const spawnApi=(name,t)=>C.mitUserHerkunft('web-ui-chat',()=>C.spawneAlsApiLauf({project:P,name,model:'ds-flash',task:t}));
  const anzahl=async()=>(await pool.query('SELECT (SELECT count(*)::int FROM api_agent_laeufe WHERE identity_id=$1) l,(SELECT count(*)::int FROM api_agent_eingang WHERE identity_id=$1) e',[X.identity_id])).rows[0];
  await C.upsertWrapperStatus({agentName:X.agent_id,project:P,wrapperPid:4242,status:'running'},{art:'identity',project:P,agent_id:X.agent_id,identity_id:X.identity_id});
  const s1=await spawnApi(X.agent_id,'T278 P2-2 neben laufender CLI');
  const n1=await anzahl();
  check(s1?.success===false&&s1.error==='cli_laeuft'&&n1.l===0&&n1.e===0,'P2-2: laufender CLI-Wrapper -> kein API-Lauf daneben (cli_laeuft), nichts angelegt',{s1,n1});
  await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[X.identity_id]);
  const s2=await spawnApi(X.agent_id,'T278 P2-2 nach CLI-Ende');
  check(s2?.success===true&&s2.ort==='api'&&s2.identitaet_neu===false&&(await anzahl()).e===1,'P2-2: ohne CLI startet der API-Lauf (ein Eingang)',s2);
  const cliStart=()=>C.mitCliStartSperre(P,'spawn',{name:X.agent_id},async()=>'gestartet');
  check(await error(cliStart)==='api_lauf_aktiv','P2-2 Rueckrichtung: CLI-Start neben bereitem API-Lauf abgelehnt (api_lauf_aktiv)');
  await C.steuereApiLauf(USER,{identity_id:X.identity_id,aktion:'stoppen',grund:'T278 P2-2 API stoppen'});
  check(await cliStart()==='gestartet','P2-2 Rueckrichtung: nach API-Stop ist der CLI-Start frei');
  // Kanal 37439: fortsetzen unter derselben Sperre (kein API-Lauf neben laufender CLI, z. B. nach dem Rueckfall).
  await C.upsertWrapperStatus({agentName:X.agent_id,project:P,wrapperPid:4243,status:'running'},{art:'identity',project:P,agent_id:X.agent_id,identity_id:X.identity_id});
  check(await error(()=>C.steuereApiLauf(USER,{identity_id:X.identity_id,aktion:'fortsetzen',grund:'T278 fortsetzen neben CLI'}))==='cli_laeuft'&&(await lauf(X.identity_id)).status==='gestoppt',
   'fortsetzen neben laufender CLI abgelehnt (cli_laeuft), Lauf bleibt gestoppt');
  await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[X.identity_id]);
  await C.steuereApiLauf(USER,{identity_id:X.identity_id,aktion:'fortsetzen',grund:'T278 fortsetzen ohne CLI'});
  check((await lauf(X.identity_id)).status==='bereit','fortsetzen ohne CLI: Lauf bereit');
  await C.steuereApiLauf(USER,{identity_id:X.identity_id,aktion:'stoppen',grund:'T278 P2-2 Ende'});
  const s3=await spawnApi(W.agent_id,'T278 P2-2 trotz Laufwahl');
  check(s3?.success===false&&s3.error==='api_lauf_gewaehlt','P2-2: Identitaet mit Laufwahl -> kein zweiter Einstieg per spawn (api_lauf_gewaehlt)',s3);
 }
 // 402/429 (Kanal 37424/37439): Anbieterfehler im Lauf ohne Kosten und ohne Wiederholungssturm.
 {
  const Z=await vor('t278-402-429','subagent');
  await C.setzeApiFreigabe(USER,{identity_id:Z.identity_id,modelle:['ds-flash'],grenze_usd:0.05,grund:'T278 402/429 Freigabe'});
  const sp=await C.mitUserHerkunft('web-ui-chat',()=>C.spawneAlsApiLauf({project:P,name:Z.agent_id,model:'ds-flash',task:'T278 402/429 Auftrag'}));
  check(sp?.success===true,'402/429: API-Lauf angelegt',sp);
  const vz=new L.LaufVerwaltung({db:pool,ausweis:async()=>Z.token,liste:async()=>[],aufruf:async()=>({content:[{type:'text',text:'ok'}]}),
   transport:a=>T.rufeApiTransport({...a,holen:echtesFetch})});
  const reserv=async()=>(await pool.query('SELECT status,usd::float8 AS usd,fehler FROM api_agent_reservierungen WHERE identity_id=$1 ORDER BY erstellt_am',[Z.identity_id])).rows;
  try{
   const vorher=fake.anfragen.length;
   fake.modus='429';
   for(let i=0;i<4;i++){await vz.takt();await vz.warteAufTurns();}
   const l429=await lauf(Z.identity_id);
   const e429=(await pool.query("SELECT faellig_ab>NOW()+interval '30 seconds' AS spaeter FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL",[Z.identity_id])).rows;
   const r429=await reserv();
   check(fake.anfragen.length===vorher+1&&l429.status==='bereit'&&l429.letzter_fehler==='ueberlastet'&&e429.length===1&&e429[0].spaeter
    &&r429.length===1&&r429[0].status==='freigegeben'&&r429[0].usd===0&&r429[0].fehler.startsWith('HTTP 429'),
    '429: ueberlastet, Eingang spaeter faellig, 0 USD, genau ein Aufruf in 4 Takten',{n:fake.anfragen.length-vorher,l429,e429,r429});
   fake.modus='402';
   await pool.query('UPDATE api_agent_eingang SET faellig_ab=NOW() WHERE identity_id=$1 AND erledigt_am IS NULL',[Z.identity_id]);
   for(let i=0;i<4;i++){await vz.takt();await vz.warteAufTurns();}
   const l402=await lauf(Z.identity_id),r402=await reserv();
   check(fake.anfragen.length===vorher+2&&l402.status==='fehler'&&l402.letzter_fehler==='anbieter_guthaben_fehlt'&&r402.length===2
    &&r402[1].status==='freigegeben'&&r402[1].usd===0&&r402[1].fehler.startsWith('HTTP 402'),
    '402: Guthaben fehlt -> Status fehler, 0 USD, keine Wiederholung',{n:fake.anfragen.length-vorher,l402,r402});
   check((await pool.query('SELECT count(*)::int n FROM agent_verbrauch WHERE identity_id=$1',[Z.identity_id])).rows[0].n===0
    &&(await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL',[Z.identity_id])).rows[0].n===1,'402/429: nichts gebucht, Auftrag bleibt offen');
  }finally{await vz.beende();fake.modus='ok';}
 }
 check(netz===0,'kein Netz ausser lokalem Fake',netz);

 if(process.argv.includes('--echt-turn')){
  // D (Nachauftrag 37397, Freigabe 37400): echter bezahlter Mini-Turn, hoechstens 0,05 USD, deepseek-flash, nur privates synapse_test-Schema.
  if(!ECHT_KEY)throw Error('P22-T278 D: DEEPSEEK_API_KEY fehlt in der Umgebung');
  const basisVorher=process.env.SYNAPSE_DEEPSEEK_BASE_URL;
  delete process.env.SYNAPSE_DEEPSEEK_BASE_URL;delete process.env.SYNAPSE_DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY=ECHT_KEY;
  try{
   check(T.deepseekSchluessel().quelle==='DEEPSEEK_API_KEY','D/A: echter Key aus DEEPSEEK_API_KEY (Wert nie ausgegeben)');
   await C.setzeApiEinstellungen(USER,{werte:{max_tokens_obergrenze:4096},grund:'T278 D Deckel je Aufruf'});
   await C.setzeApiBudget(USER,{grenze_usd:0.05,zeitraum:'tag',erlaubte_modelle:['ds-flash','ds-v4-pro'],grund:'T278 D Testbudget 0,05 USD'});
   const E=await vor('t278-echt','subagent');
   await C.setzeApiFreigabe(USER,{identity_id:E.identity_id,modelle:['ds-flash'],grenze_usd:0.05,grund:'T278 D echte Freigabe'});
   const roh=[];
   const holen=async(url,init)=>{
    const body=JSON.parse(init.body),r=await echtesFetch(url,init),txt=await r.clone().text();let j=null;try{j=JSON.parse(txt);}catch{/* leer */}
    const ass=(body.messages||[]).filter(m=>m.role==='assistant');
    roh.push({status:r.status,usage:j?.usage??null,fehler:j?.error?.message??null,tools:!!body.tools?.length,assistant:ass.length,
     mitReasoning:ass.filter(m=>typeof m.reasoning_content==='string').length,leer:ass.filter(m=>m.reasoning_content==='').length,
     finish:j?.choices?.[0]?.finish_reason??null,toolCalls:j?.choices?.[0]?.message?.tool_calls?.length??0,denken:(j?.choices?.[0]?.message?.reasoning_content??'').length,
     // Belegfelder ohne 'token' im Namen (die Shell-Maskierung verdeckt sonst die Zahlen).
     hit:j?.usage?.prompt_cache_hit_tokens??null,miss:j?.usage?.prompt_cache_miss_tokens??null,rt:j?.usage?.completion_tokens_details?.reasoning_tokens??null,
     felder:Object.keys(j?.choices?.[0]?.message??{}),anfrage:{thinking:body.thinking??null,reasoning_effort:body.reasoning_effort??null}});
    return r;};
   const anmeldung='T278 Anmeldung (Testprofil). '+'Regel: knapp und auf Deutsch antworten, Werkzeuge nur wenn verlangt. '.repeat(60);
   const ve=new L.LaufVerwaltung({db:pool,ausweis:async()=>E.token,
    liste:async()=>[{name:'thought',description:'Notizen suchen',inputSchema:{type:'object',properties:{action:{type:'string'},query:{type:'string'}}}}],
    aufruf:async(name,args)=>({content:[{type:'text',text:name==='chat'?anmeldung:'Ergebnis: keine Treffer fuer '+JSON.stringify(args).slice(0,80)}]}),
    transport:a=>T.rufeApiTransport({...a,holen})});
   try{
    await A.starteApiAuswahl({identity_id:E.identity_id,modell:'ds-flash',auftrag:'Welche Zahl ist groesser, 9.11 oder 9.8? Ueberlege kurz. Rufe dann genau einmal das Werkzeug mcp__synapse__thought mit action "search" und query = der groesseren Zahl auf. Antworte danach nur mit T278-ECHT-1.',
     grund:'T278 D echter Mini-Turn',kosten_bestaetigt:true,wechsel_bestaetigt:true,idempotenz_schluessel:randomUUID()},USER);
    await ve.takt();await ve.warteAufTurns();
    // assistant-Nachricht OHNE Gedankenkette (wie nach einer Uebergabe) -> naechste Anfrage traegt reasoning_content ''.
    const sitz=(await pool.query('SELECT sitzung::text AS s FROM api_agent_laeufe WHERE identity_id=$1',[E.identity_id])).rows[0].s;
    const vp=await L.VerlaufPg.oeffne(pool,E.identity_id,sitz);
    await vp.fuegeHinzu({rolle:'user',inhalt:[{typ:'text',text:'Zwischennotiz: bitte bestaetigen.'}]});
    await vp.fuegeHinzu({rolle:'assistant',inhalt:[{typ:'text',text:'Bestaetigt (ohne Gedankenkette, wie nach einer Uebergabe).'}]});
    await pause(3000);
    await C.legeApiEingangAn({identity_id:E.identity_id,text:'Antworte nur mit T278-ECHT-2.',quelle:'auftrag',absender:'user'});
    await pool.query('UPDATE api_agent_eingang SET faellig_ab=NOW() WHERE identity_id=$1 AND erledigt_am IS NULL',[E.identity_id]);
    await ve.takt();await ve.warteAufTurns();
   }finally{await ve.beende();}
   const ok=roh.filter(x=>x.status===200);
   const geb=(await pool.query("SELECT usd::float8 AS usd,input_tokens::int AS i,cache_read_tokens::int AS c,output_tokens::int AS o FROM api_agent_reservierungen WHERE identity_id=$1 AND status='gebucht' ORDER BY abgeschlossen_am",[E.identity_id])).rows;
   const summe=geb.reduce((s,z)=>s+z.usd,0),f=C.deepseekTarif().faktor;
   const erw=ok.map(x=>{const hit=x.usage.prompt_cache_hit_tokens??0;return rund(rund(((x.usage.prompt_tokens-hit)*0.30+hit*0.006+x.usage.completion_tokens*1.20)/1e6)*f);});
   const turns=(await pool.query('SELECT ende,antwort FROM api_agent_turns WHERE identity_id=$1 ORDER BY id',[E.identity_id])).rows;
   const ls=(await C.apiLaeufeStand(USER,P)).laeufe.find(x=>x.identity_id===E.identity_id),vh=ls.verbrauch_heute;
   console.log('P22-T278 ECHT-TURN '+JSON.stringify({aufrufe:roh,gebucht:geb,summe,tarif:C.deepseekTarif(),turns,verbrauch_heute:vh,verbrauch_letzter_turn:ls.verbrauch_letzter_turn}));
   check(roh.length>=3&&roh.every(x=>x.status===200),'D: alle echten Aufrufe HTTP 200 (kein 400 wegen reasoning_content)',roh);
   check(roh.some(x=>x.toolCalls>0&&x.denken>0),'D: Thinking + Werkzeugaufruf in einer Antwort',roh);
   check(roh.some(x=>x.assistant>0&&x.mitReasoning===x.assistant&&x.status===200),'D: reasoning_content aller Runden zurueck, HTTP 200',roh);
   check(roh.some(x=>x.leer>0&&x.status===200),'D: leerer reasoning_content (assistant ohne Gedankenkette) akzeptiert',roh);
   check(roh.slice(1).some(x=>(x.usage?.prompt_cache_hit_tokens??0)>0),'D: Cache-Treffer belegt (prompt_cache_hit_tokens > 0)',roh.map(x=>x.usage));
   check(ok.every(x=>x.usage.prompt_cache_hit_tokens+x.usage.prompt_cache_miss_tokens===x.usage.prompt_tokens),'D: Treffer + Fehlschuss = prompt_tokens',roh.map(x=>x.usage));
   check(geb.length===ok.length&&geb.every((z,i)=>Math.abs(z.usd-erw[i])<1e-9&&z.c===(ok[i].usage.prompt_cache_hit_tokens??0)),'D: gebuchte Kosten = usage x Preis x Tarif',{geb,erw});
   check(summe>0&&summe<=0.05,'D: Gesamtkosten > 0 und <= 0,05 USD',summe);
   const hits=ok.reduce((s,x)=>s+(x.usage.prompt_cache_hit_tokens??0),0),miss=ok.reduce((s,x)=>s+x.usage.prompt_tokens-(x.usage.prompt_cache_hit_tokens??0),0);
   check(Number(vh.treffer)===hits&&Number(vh.fehlschuss)===miss&&Math.abs(Number(vh.usd)-summe)<1e-8,'D/B: Laufanzeige heute = Rohfelder der Antworten',{vh,hits,miss,summe});
   check(turns.length>=2&&turns.every(t=>t.ende==='fertig'),'D: beide Turns fertig',turns);
   if(process.argv.includes('--browser-verbrauch')){
    const {pruefeVerbrauchBrowser}=await import('./api-deepseek-verbrauch-browser-helfer.mjs');
    const b=await pruefeVerbrauchBrowser({C,A,L,pool,P,E,K,USER,vor,fetcher:echtesFetch,erwartet:{hits,miss,summe}});
    console.log('P22-T278 BROWSER-VERBRAUCH '+b.checks+' gruen; Bilder: '+b.bilder.join(', ')+'; Texte: '+JSON.stringify(b.texte));
   }
  }finally{process.env.SYNAPSE_DEEPSEEK_BASE_URL=basisVorher;delete process.env.DEEPSEEK_API_KEY;}
 }
 if(process.argv.includes('--echt-401')){
  const basis=process.env.SYNAPSE_DEEPSEEK_BASE_URL;delete process.env.SYNAPSE_DEEPSEEK_BASE_URL;
  try{
   let fehler=null;
   try{await T.rufeApiTransport({kontext:{identity_id:W.identity_id,agent_id:W.agent_id,project:P,zugang:'agent'},modell:'ds-flash',system:'T278',max_tokens:16,
    verlauf:[{rolle:'user',inhalt:[{typ:'text',text:'ping'}]}],werkzeuge:[],holen:echtesFetch});}catch(e){fehler=e;}
   check(fehler?.code==='api_zugang_ungueltig'&&String(fehler.message).includes('HTTP 401'),'ECHT api.deepseek.com, ungueltiger Key: HTTP 401 als api_zugang_ungueltig',fehler&&{code:fehler.code,message:fehler.message});
   const r=(await pool.query("SELECT status,usd::float8 AS usd,fehler FROM api_agent_reservierungen WHERE identity_id=$1 ORDER BY erstellt_am DESC LIMIT 1",[W.identity_id])).rows[0];
   check(r.status==='freigegeben'&&r.usd===0&&r.fehler.startsWith('HTTP 401'),'ECHT: Reservierung freigegeben, 0 USD',r);
   console.log('P22-T278 ECHT-401 Meldung: '+fehler?.message);
  }finally{process.env.SYNAPSE_DEEPSEEK_BASE_URL=basis;}
 }
 console.log('P22-T278 '+checks+' Pruefungen gruen; network='+netz+'; fake_anfragen='+fake.anfragen.length);
 if(process.argv.includes('--browser')){
  const {pruefeDeepseekBrowser}=await import('./api-deepseek-browser-helfer.mjs');
  fake.modus='401';
  const b=await pruefeDeepseekBrowser({C,pool,B,K,P,fetcher:echtesFetch,key:KEY,echt:process.argv.includes('--echt-401')});
  console.log('P22-T278 BROWSER '+b.checks+' gruen; Bilder: '+b.bilder.join(', '));
 }
}finally{
 await v?.beende();server.close();if(pool)await pool.end();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
