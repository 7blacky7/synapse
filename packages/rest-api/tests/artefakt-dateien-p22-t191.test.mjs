/**
 * P22-T191: Name/Katalog, Dateioperationen, bestehender Code-Index, PG-Ueberlauf, REST-Dispatcher und stdio-API-Vertrag.
 * Quellen: core artefakt-katalog.ts/artefakt-dateien.ts/artefakt-ueberlauf.ts, REST artefakt-tool.ts, stdio artefakt.ts.
 * Nur synapse_test:5433, privates Schema, keine Browser/Container/echten Agenten. Qdrant nicht erreichbar (sichtbarer Fehlerpfad).
 * Aufruf: mise exec node@25 -- node packages/rest-api/tests/artefakt-dateien-p22-t191.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const db=process.env.DATABASE_URL??process.env.SYNAPSE_DATABASE_URL;
const url=new URL(db);assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
process.env.DATABASE_URL=db;process.env.SYNAPSE_INTERN_TOOL='0';process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const C=await import('../../core/dist/index.js');
const {mitLesePool}=await import('../../core/dist/db/client.js');
const AT=await import('../dist/services/agent-runtime/artefakt-tool.js');
const MCP=await import('../dist/routes/mcp.js');
const ST=await import('../../mcp-server/dist/tools/consolidated/artefakt.js');
const basis=C.getPool(),schema='p22_t191_'+randomUUID().replaceAll('-','');
const pool={async connect(){const c=await basis.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
let checks=0;
const ok=(v,label,actual)=>{assert.ok(v,'P22-T191 '+label+' erwartet=erfuellt tatsaechlich='+JSON.stringify(actual).slice(0,1000));checks++;console.log('OK P22-T191 '+label);};
const P='t191-'+randomUUID(),Q=P+'-fremd',ID=randomUUID(),OTHER=randomUUID(),MAIN=randomUUID();
const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
const principal=(id=ID,rolle='koordinator',project=P)=>({art:'identity',identity_id:id,agent_id:'t191-'+id,project,rolle,modell:null,context_epoch:1,lauf_id:null});
const als=(fn,id=ID,rolle='koordinator',project=P)=>mitLesePool(pool,()=>C.mitAgentAufrufKontext({principal:principal(id,rolle,project),bezug},fn));
const tool=(args,id=ID)=>als(()=>AT.fuehreArtefaktAus({project:P,...args},'t191-'+id),id,id===OTHER?'subagent':'koordinator');
const schalter=async(name,aktiv)=>pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T191 Fixture','user') ON CONFLICT(ebene,(COALESCE(project,'')),funktion) DO UPDATE SET aktiv=excluded.aktiv",[name,aktiv]);
const neu=async(name,bereich='projekt',project=P,html='<h1>Titel</h1>\n<p>Hallo</p>',owner=ID)=>{const id=randomUUID();await pool.query("INSERT INTO agent_artifacts(id,title,name,beschreibung,html,revision,created_by_identity_id,standard_project,bereich) VALUES($1,$2,$2,$3,$4,1,$5,$6,$7)",[id,name,'Beschreibung '+name,html,owner,project,bereich]);return id;};
try{
 await basis.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_identitaeten','agent_artifacts','agent_profil_schalter','intern_schalter','hauptagent_verlauf','code_files','code_symbols','code_references','code_chunks','parse_coverage','code_statements','code_call_edges'])
  await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(C.ARTEFAKT_DATEIEN_SCHEMA_SQL);await pool.query(C.ARTEFAKT_DATEIEN_SCHEMA_SQL);
 ok(readFileSync(new URL('../../core/src/db/schema-sql/165_artefakt_dateien.sql',import.meta.url),'utf8').trim()===C.ARTEFAKT_DATEIEN_SCHEMA_SQL.trim(),'Schema165 Spiegel und Idempotenz',{schema});
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$4,'ko191','ko191','koordinator','aktiv','test'),($2,$4,'sub191','sub191','subagent','aktiv','test'),($3,$4,'main191','main191','main','aktiv','test')",[ID,OTHER,MAIN,P]);
 await schalter('artefakt_dateien',false);await schalter('tool_antwort_ueberlauf',false);
 let r=await tool({action:'list'});ok(r.error==='funktion_aus','A Standard AUS: Katalog abgelehnt',r);
 await pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES('artefakt_dateien',true,'freigegeben',NOW()+interval '1 hour','T191 Test','test')");
 r=await tool({action:'list'});ok(r.error==='funktion_aus','A Produktionsmodus ignoriert interne Freigabe',r);
 await pool.query("DELETE FROM intern_schalter WHERE name='artefakt_dateien'");
 r=await tool({action:'zeigen',html:'<p>neu</p>',name:'Nur mit Freigabe'});ok(r.error==='funktion_aus','A Metadaten-Zeigen schreibt bei AUS nichts',r);
 const original={success:true,zeilen:Array.from({length:100},(_,i)=>'Zeile '+i+' ä😀 '.repeat(8))};
 const aus=await als(()=>C.begrenzeArtefaktAntwort(original,{art:'agent',identity_id:ID,agent_id:'ko191',project:P,main:false},'probe','gross'));
 ok(aus===original,'A AUS: Antwort unveraendert',aus===original);
 await schalter('artefakt_dateien',true);
 r=await tool({action:'status'});ok(r.werte.seite_zeilen===100,'A Status zeigt Code-Standard',r);
 const a=await neu('Globaler Plan','global',Q),b=await neu('Projektbericht'),fremd=await neu('Projektbericht','projekt',Q,'fremd',OTHER);
 r=await tool({action:'list'});ok(r.success&&r.artefakte.length===2&&!JSON.stringify(r).includes(fremd),'B list Projekt/global, keine fremden Treffer',r);
 r=await tool({action:'search',query:'globaler',scope:'global'});ok(r.count===1&&r.artefakte[0].artefakt_id===a,'B Name Teiltext global',r);
 r=await tool({action:'search',query:'Beschreibung Projektbericht'});ok(r.count===1,'B Beschreibung Teiltext',r);
 r=await tool({action:'search',query:'Projektbericht',exact:true});ok(r.count===1&&r.artefakte[0].artefakt_id===b,'B Exakter Name ohne fremde Mehrdeutigkeit',r);
 r=await tool({action:'read',artefakt_id:'Globaler Plan',from_line:2,to_line:2});ok(r.content==='<p>Hallo</p>'&&r.total_lines===2,'B Name statt UUID und Zeilenbezug',r);
 const c=await neu('Globaler Plan');r=await tool({action:'read',artefakt_id:'Globaler Plan'});ok(r.error==='artefakt_mehrdeutig'&&r.treffer.length===2,'B Mehrdeutiger Name liefert Trefferliste',r);
 r=await tool({action:'read',artefakt_id:fremd});ok(r.error==='artefakt_unbekannt','B Fremde UUID nicht lesbar',r);
 r=await tool({action:'metadaten',artefakt_id:b,name:'Neuer Bericht',beschreibung:'aktuell'});ok(r.success&&r.artefakt.name==='Neuer Bericht','B Metadaten setzen',r);
 r=await tool({action:'read',artefakt_id:b});ok(r.revision===2,'C Metadaten versioniert',r);
 r=await tool({action:'search',artefakt_id:b,query:'<p>.*Hallo',regex:true});ok(r.matches?.[0]?.line===2,'C Regex mit Zeilennummer',r);
 r=await tool({action:'search',artefakt_id:b,query:'HALLO'});ok(r.matches?.[0]?.line===2,'C Textsuche ohne Gross-/Kleinschreibung',r);
 r=await tool({action:'search_replace',artefakt_id:b,search:'Hallo',replace:'Welt',expected_revision:2});ok(r.success&&r.revision===3,'C search_replace mit Revisionsschutz',r);
 r=await tool({action:'replace_lines',artefakt_id:b,line_start:2,line_end:2,content:'<p>Zeile neu</p>',expected_revision:2});ok(r.error==='revision_konflikt','C Veraltete Revision schreibt nicht',r);
 r=await tool({action:'insert_after',artefakt_id:b,after_line:1,content:'<h2>Abschnitt</h2>'});ok(r.success&&r.total_lines===3,'C insert_after',r);
 r=await tool({action:'replace_lines',artefakt_id:b,line_start:3,line_end:3,anchor_text:'<p>Welt</p>',content:'<p>Fertig</p>'});ok(r.success,'C replace_lines mit Anker',r);
 r=await tool({action:'versions',artefakt_id:b});ok(r.versions.length===5,'C vollstaendige Versionen',r);
 r=await tool({action:'restore',artefakt_id:b,version_id:'1'});ok(r.success&&r.revision===6,'C restore erzeugt neue Revision',r);
 r=await tool({action:'read',artefakt_id:b});ok(r.content.includes('Hallo')&&r.name==='Projektbericht','C restore Inhalt und Metadaten',r);
 r=await tool({action:'search_replace',artefakt_id:b,search:'Hallo',replace:'fremd'},OTHER);ok(r.error==='nicht_urheber','C Fremder darf trotz Projekt-Leserecht nicht schreiben',r);
 const html='<h1>Testabschnitt</h1>\n<script>\nfunction verdopple(x) { return x * 2; }\n</script>\n<p>Ende</p>';
 const code=await neu('Skriptprobe','projekt',P,html);
 r=await tool({action:'code_intel',intel_action:'functions',artefakt_id:code});ok(r.functions?.some(x=>x.name==='verdopple'&&x.line_start===3),'D vorhandener Code-Index: HTML-Skriptfunktion echte Zeile3',r);
 r=await tool({action:'code_intel',intel_action:'tree',artefakt_id:code});ok(r.success&&r.tree?.includes('inhalt.html')&&r.gliederung?.[0]?.titel==='Testabschnitt'&&r.gliederung[0].line_start===1&&r.gliederung[0].line_end===5,'D tree mit Artefakt-Bezug',r);
 r=await tool({action:'code_intel',intel_action:'symbols',symbol_type:'function',artefakt_id:code});ok(r.symbols?.some(x=>x.name==='verdopple'),'D symbols im bestehenden Parser',r);
 r=await tool({action:'code_intel',intel_action:'file',artefakt_id:code,from_line:3,to_line:3});ok(r.content.includes('verdopple')&&r.total_lines===5,'D file mit Zeilenbereich',r);
 r=await tool({action:'code_intel',intel_action:'search',artefakt_id:code,query:'verdopple'});ok(r.matches?.[0]?.line===3,'D search mit Zeilenbezug',r);
 r=await als(()=>MCP.handleToolCall('code_intel',{project:P,action:'functions',artefakt_id:code},'ko191'));ok(r.functions?.some(x=>x.name==='verdopple'),'D REST code_intel artefakt_id erreicht Index',r);
 r=await als(()=>MCP.handleToolCall('files',{project:P,action:'read',artefakt_id:'Projektbericht',from_line:2,to_line:2},'ko191'));ok(r.content==='<p>Hallo</p>','D REST files artefakt_id akzeptiert Namen',r);
 // Unicode-/Langzeilen-Cursor: erster Teil und Folgeteile duerfen kein Zeichen doppeln/verlieren.
 const lang='😀ä\\\"'.repeat(1000)+'\nzweite\n',werte={...C.ARTEFAKT_DATEI_STANDARD,seite_max_bytes:201,seite_zeilen:2};
 let gelesen='',cursor={from_line:1},loops=0;
 do{const seite=C.artefaktTextSeite(lang,cursor,werte);gelesen+=seite.content;cursor=seite.naechster_aufruf;ok(Buffer.byteLength(seite.content)<=201,'E UTF8-Seitenbudget',{bytes:Buffer.byteLength(seite.content)});assert(++loops<1000);}while(cursor);
 ok(gelesen===lang,'E Langzeile/Unicode vollstaendig ohne Doppel',{soll:lang.length,ist:gelesen.length,loops});
 await schalter('tool_antwort_ueberlauf',true);
 await als(()=>C.setzeArtefaktDateiEinstellungen({werte:{antwort_max_bytes:4096,seite_max_bytes:200,seite_zeilen:3,ttl_stunden:1},grund:'T191 gezielte Probe'},'test'));
 const zugang={art:'agent',identity_id:ID,agent_id:'ko191',project:P,main:false};
 r=await als(()=>C.begrenzeArtefaktAntwort(original,zugang,'probe','gross'));
 ok(r.ueberlauf&&r.artefakt_id&&r.naechster_aufruf&&r.total_lines>100,'F echte PG-Ueberlaufantwort mit Folgeaufruf',r);
 ok(Buffer.byteLength(JSON.stringify(C.baueToolErgebnis(r,{tool:'probe',strukturiert:true})))<=4096,'F komplette MCP-Huelle unter Bytebudget',{bytes:Buffer.byteLength(JSON.stringify(C.baueToolErgebnis(r,{tool:'probe',strukturiert:true})))});
 const overflow=r.artefakt_id;
 const fehler=await als(()=>C.begrenzeArtefaktAntwort({success:false,error:'Fehler '.repeat(2000)},zugang,'probe','fehler'));
 ok(fehler.ueberlauf&&fehler.success===false&&fehler.original_success===false,'F Ueberlauf behaelt Originalfehlerstatus',fehler);
 gelesen=r.content;cursor=r.naechster_aufruf;loops=0;
 while(cursor){const page=await tool(cursor);ok(page.success,'F read Folgeseite',page.success);gelesen+=page.content;cursor=page.naechster_aufruf;assert(++loops<2000);}
 ok(JSON.parse(gelesen).zeilen.join('|')===original.zeilen.join('|'),'F vollstaendige Antwort rekonstruierbar',{loops,zeichen:gelesen.length});
 r=await tool({action:'einstellungen',werte:{ttl_stunden:2},grund:'Unberechtigt setzen'},OTHER);ok(r.error==='recht_fehlt','G Subagent darf Einstellungen nicht setzen',r);
 r=await als(()=>C.fuehreW1bAdminAus('artefakt_einstellungen',{project:P,modus:'status'},{akteur:{art:'user'}}));ok(r.success&&r.werte.ttl_stunden===1,'G admin User liest PG-Werte',r);
 r=await als(()=>C.fuehreW1bAdminAus('artefakt_einstellungen',{project:P,modus:'status'},{akteur:{art:'identitaet',principal:principal(MAIN,'main')}}));ok(r.success,'G admin Main liest eigenen Rahmen',r);
 r=await als(()=>C.fuehreW1bAdminAus('artefakt_einstellungen',{project:P,modus:'status'},{akteur:{art:'identitaet',principal:principal(OTHER,'subagent')}}));ok(r.success===false&&r.error==='recht_fehlt','G admin Subagent abgewiesen',r);
 // Der stdio-Proxy wird mit echter REST-Dispatcher-Ausfuehrung hinter dem Fake-HTTP-Transport geprueft.
 let requests=[];
 const transport={url:'http://fixture.invalid/mcp',token:'fixture-secret',fetchImpl:async(u,init)=>{
  const rpc=JSON.parse(init.body);requests.push(rpc.params);
  const antwort=await tool(rpc.params.arguments);
  return {ok:true,json:async()=>({jsonrpc:'2.0',id:rpc.id,result:C.baueToolErgebnis(antwort,{tool:'artefakt',strukturiert:true})})};
 }};
 r=await ST.rufeArtefaktApi({action:'read',artefakt_id:'Projektbericht'},transport);
 ok(r.structuredContent?.content?.includes('Hallo')&&requests[0].name==='artefakt','H stdio/API read gleicher Dispatcher',r);
 // P22-T191 D2: below the actual PG budget must mean ZERO status fetches,
 // including sizes above the previous heuristic; a smaller custom budget must still apply.
 const mittel=C.baueToolErgebnis({success:true,text:'m'.repeat(2600)},{tool:'probe',strukturiert:true});
 await als(()=>C.setzeArtefaktDateiEinstellungen({werte:{antwort_max_bytes:24000},grund:'D2 lazy Budget Normalantwort'},'test'));
 requests=[];const klein=await als(()=>ST.begrenzeStdioArtefaktAntwort(mittel,{project:P,action:'mittel'},'probe',transport));
 ok(klein===mittel&&requests.length===0,'H2 ganze MCP-Huelle unter PG-Budget: null fetch',{bytes:Buffer.byteLength(JSON.stringify(mittel)),requests});
 await als(()=>C.setzeArtefaktDateiEinstellungen({werte:{antwort_max_bytes:4096},grund:'D2 lazy Budget kleiner Override'},'test'));
 await schalter('tool_antwort_ueberlauf',false);requests=[];
 await als(()=>ST.begrenzeStdioArtefaktAntwort(mittel,{project:P,action:'mittel'},'probe',transport));
 ok(requests.length===1&&requests[0].arguments.action==='status'&&!('antwort' in requests[0].arguments),'H2 gleiche Huelle ueber kleinerem PG-Budget: nur Status bei AUS',requests);
 const mcp=C.baueToolErgebnis(original,{tool:'probe',strukturiert:true});
 await schalter('tool_antwort_ueberlauf',false);requests=[];
 r=await ST.begrenzeStdioArtefaktAntwort(mcp,{project:P,action:'gross',agent_kennung:'synthetisch'},'probe',transport);
 ok(r===mcp&&requests.length===1&&requests[0].arguments.action==='status'&&!('antwort' in requests[0].arguments),'H AUS: stdio nur Statusprobe, keine Tool-Nutzdaten',requests);
 await schalter('tool_antwort_ueberlauf',true);
 r=await ST.begrenzeStdioArtefaktAntwort(mcp,{project:P,action:'gross',agent_kennung:'synthetisch'},'probe',transport);
 ok(r.structuredContent?.ueberlauf&&requests.at(-1).arguments.action==='tool_antwort','H stdio grosse Antwort ueber denselben PG-Vertrag',r);

 // P22-T191 f56c0b6a: erlaubte Kombination4096/8000 und Standard24000/8000.
 // JEDE komplette REST/stdio-Huelle messen, auch nach grossen Hook-Metadaten.
 for(const budget of [4096,24000]){
  await als(()=>C.setzeArtefaktDateiEinstellungen({werte:{antwort_max_bytes:budget,seite_max_bytes:8000,seite_zeilen:100},grund:'t214 f56c0b6a Folgehuellen'},'test'));
  const voll={success:true,text:'\\'.repeat(8000)+'😀ä"\t'.repeat(1500)+'\nzweite\n'};
  const first=await als(()=>C.begrenzeArtefaktAntwort(voll,zugang,'budget','escape'));
  for(const weg of ['REST artefakt','REST files','stdio artefakt','stdio files']){
   let page=first,gesamt='',n=0,maxBytes=0;
   while(true){
    const rpcTool=weg.endsWith('files')?'files':'artefakt';
    // Nachgestellte Hooks duerfen die bereits geschnittene Seite nicht wieder sprengen.
    const mitHook={...page,pending_events:[{summary:'t214-Hinweis '.repeat(600)}]};
    page=await als(()=>AT.begrenzeArtefaktWerkzeugAntwort(mitHook,{action:'read',artefakt_id:first.artefakt_id,project:P},rpcTool,'read'));
    const finalWert=weg.startsWith('stdio')?{...page,pending_events:[{summary:'stdio-Hook '.repeat(1200)}]}:page;
    let huelle=C.baueToolErgebnis(finalWert,{tool:rpcTool,strukturiert:true});
    if(weg.startsWith('stdio')){
     huelle=await ST.begrenzeStdioArtefaktAntwort(huelle,{action:'read',artefakt_id:first.artefakt_id,project:P},rpcTool,transport);
     page=huelle.structuredContent;
    }
    const bytes=Buffer.byteLength(JSON.stringify(huelle),'utf8');maxBytes=Math.max(maxBytes,bytes);
    ok(page.success&&bytes<=budget,'F2 artefakt-dateien.ts '+weg+' JEDE Huelle unter '+budget,{bytes,n,cursor:page.naechster_aufruf,success:page.success,error:page.error,keys:Object.keys(page),content:page.content?.slice(0,300)});
    ok(page.returned_range.eof||page.content.length>0,'F2 '+weg+' Cursor macht Fortschritt',{n,cursor:page.naechster_aufruf});
    gesamt+=page.content;n++;assert(n<2000);
    const next=page.naechster_aufruf;if(!next)break;
    const {tool:_werkzeug,...folgeArgs}=next;const a={...folgeArgs,project:P};
    if(weg.startsWith('stdio')){
     const proxy={...transport,werkzeug:rpcTool,fetchImpl:async(_u,init)=>{
      const x=JSON.parse(init.body),value=await als(()=>MCP.handleToolCall(x.params.name,x.params.arguments,'ko191'));
      const limited=await als(()=>AT.begrenzeArtefaktWerkzeugAntwort(value,x.params.arguments,x.params.name,'read'));
      return {ok:true,json:async()=>({jsonrpc:'2.0',id:x.id,result:C.baueToolErgebnis(limited,{tool:rpcTool,strukturiert:true})})};
     }};
     const proxied=await ST.rufeArtefaktApi(a,proxy);page=proxied.structuredContent;
    }else page=await als(()=>MCP.handleToolCall(rpcTool,a,'ko191'));
   }
   console.log('MESSUNG P22-T191 '+JSON.stringify({weg,budget,maxBytes,pages:n,zeichen:gesamt.length}));
   ok(gesamt===JSON.stringify(voll,null,2),'F2 '+weg+' Escape/Unicode vollständig ohne Verlust '+budget,{pages:n,soll:JSON.stringify(voll,null,2).length,ist:gesamt.length});
  }
 }

 const stub=await ST.rufeArtefaktApi({action:'read'}, {...transport,fetchImpl:async()=>{throw Error('aus');}});
 ok(stub.structuredContent?.fehler==='api_nicht_erreichbar','H API-Ausfall klar, kein lokaler Fallback',stub);
 await pool.query('UPDATE agent_artifacts SET ablauf_am=NOW()-interval \'1 second\' WHERE id=$1',[overflow]);
 r=await tool({action:'read',artefakt_id:overflow});ok(r.error==='artefakt_unbekannt','I Ablauf sperrt Lesen vor Bereinigung',r);
 r=await als(()=>C.bereinigeArtefaktUeberlaeufe(100));ok(r.geloescht===1&&!r.fehler.length,'I TTL-Bereinigung entfernt abgelaufenes Artefakt',r);
 ok(!(await pool.query('SELECT 1 FROM agent_artifacts WHERE id=$1',[overflow])).rowCount,'I PG-Inhalt entfernt',overflow);
 console.log('P22-T191 '+checks+' Pruefungen GRUEN; Semantik-Ausfallpfad/Modellguete nicht als Modelltest behauptet.');
}catch(e){console.error('DEBUG P22-T191 artefakt-dateien erwartet=alle Vertraege gruen tatsaechlich='+e.stack+' schema='+schema);process.exitCode=1;}
finally{await basis.query('DROP SCHEMA '+schema+' CASCADE');await basis.end();}
process.exit(process.exitCode??0);
