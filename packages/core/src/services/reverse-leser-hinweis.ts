/** P18-T45 / Teil F: lesende RV27-Diagnose, RV19-Zustellung. Kein Analyseauftrag.
 * Teure Belege vor der RV19-Frist im gemeinsamen Handler vorbereiten; Quelle bleibt klein. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {getPool} from '../db/client.js';
import {aktuelleAgentIdentityId} from './agent-bezug.js';
import {registriereHinweisQuelle,type HinweisQuelle,type AusloeserHinweis} from './ausloeser-hinweise.js';
import {leseReverseEinstellwerte,leseReverseProduktSchalter,reverseZahl} from './reverse-einstellwerte.js';
import {gruppiereRv27Dateien} from './hex-rv27.js';
import {leseReverseVerknuepfungen} from './reverse-verknuepfungen.js';
import {reverseEintragSichtbar,reverseSichtbarSql} from './reverse-sichtbarkeit.js';
import {loggeReverseFehler} from './reverse-fehlerlog.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import type {ReverseLeserManifest} from './reverse-leser-vertrag.js';
type Row=Record<string,any>;
const obj=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x);
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const mask=(x:unknown)=>maskiereMitKatalog(String(x??''),'reverse').text;
export type LeserHinweisZustand='kein_leser'|'leser_deaktiviert'|'beschaedigt'|'schritt_unterbrochen'|'gueltige_leere_tabelle'|'leser_aktiv'|'erkennung_offen';
/** Nur vorhandene Bytebelege verwenden; fehlende Probe ist niemals ein negativer Magic-Test. */
export function reverseLeserHinweisMatch(m:ReverseLeserManifest,d:Row):boolean|null{
 const e=m.erkennung,size=BigInt(d.groesse);
 if(size<BigInt(e.min_bytes)||e.max_bytes!==null&&size>BigInt(e.max_bytes))return false;
 const ext=String(d.extension).toLowerCase();
 if(e.endungen.length&&!e.endungen.includes(ext))return false;
 const hex=String(d.header_hex??'').toLowerCase();let offen=false;
 for(const p of e.magic){
  const start=BigInt(p.offset)*2n,end=start+BigInt(p.hex.length);
  if(end>size*2n)return false;
  if(end>BigInt(hex.length)){offen=true;continue;}
  if(hex.slice(Number(start),Number(end))!==p.hex)return false;
 }
 return offen?null:true;
}
/** Exakte Status-/Endbelege haben Vorrang vor fehlenden Ergebnissen. Exit0/0 Zeilen reichen nicht. */
export function reverseLeserHinweisZustand(d:Row,aktiv:boolean,inaktiv:boolean,offen:boolean):LeserHinweisZustand{
 const l=d.lauf;
 if(d.status==='beschaedigt'||l?.fehlercode==='beschaedigt'||l?.fehlercode==='leser_beschaedigt')return 'beschaedigt';
 if(l&&(l.status==='abgebrochen'||l.status==='teilweise'||l.status==='fehler'))return 'schritt_unterbrochen';
 if(l?.status==='fertig'&&l.host_validiert===true&&l.manifest_key&&l.manifest_sha256&&l.beendet_at
  &&String(l.ausgabe_anzahl)==='0'&&String(l.offen)==='0')return 'gueltige_leere_tabelle';
 if(l&&(l.status==='offen'||l.status==='laeuft'))return 'schritt_unterbrochen';
 if(l?.status==='fertig'&&l.host_validiert!==true)return 'schritt_unterbrochen';
 return aktiv?'leser_aktiv':inaktiv?'leser_deaktiviert':offen?'erkennung_offen':'kein_leser';
}
const registrySql="SELECT md5(COALESCE(string_agg(r.id||':'||z.status||':'||COALESCE(z.storage_key,''),',' ORDER BY r.id),'')) AS revision FROM reverse_leser r JOIN reverse_leser_zustaende z ON z.leser_id=r.id";
const AKTIONEN=new Set(['dateien','status','struktur','inspect']);
export async function ergaenzeReverseLeserHinweisKontext(pool:Pool,a:Row,antwort:Row):Promise<Row>{
 if(!AKTIONEN.has(String(a.action))||antwort.success!==true||typeof a.project!=='string'||typeof a.reverse_id!=='string')return antwort;
 const schalter=await leseReverseProduktSchalter('reverse_leser_hinweise',null,pool);
 if(!schalter.aktiv||schalter.letzter_fehler)return antwort; // AUS: keine zusätzlichen Felder/Quellenabfragen.
 initialisiereReverseLeserHinweise();
 const leserSchalter=await leseReverseProduktSchalter('reverse_leser',null,pool);
 const s=await leseReverseEinstellwerte({project:a.project,eintrag_id:a.reverse_id},pool);
 const basis:Row={schalter,leser_schalter:leserSchalter,zustell_limit:reverseZahl(s,'max_limit'),einstellungen_revision:s.revision,einstellungen:{
  leser_hinweis_min_dateien:s.werte.leser_hinweis_min_dateien,leser_hinweis_funktionen:s.werte.leser_hinweis_funktionen},gruppen:[]};
 const ausgabe=(extra:Row)=>{
  const kontext={...basis,...extra},result={...antwort,felder:{...antwort.felder,leser_hinweis:kontext}};
  // Den vorhandenen Nutzinhalt nie für einen optionalen Hinweis abschneiden.
  return Buffer.byteLength(JSON.stringify(result))<=reverseZahl(s,'antwort_bytes')?result:antwort;
 };
 if(s.letzter_fehler)return ausgabe({letzter_fehler:s.letzter_fehler});
 const c=await pool.connect(),start=Date.now();
 const q=async(sql:string,p:unknown[])=>{
  const rest=reverseZahl(s,'laufzeit_ms')-(Date.now()-start);
  if(rest<=0)throw new Error('hinweis_zeitlimit');
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(rest)]);
  return c.query(sql,p);
 };
 let rows:Row[]=[],revision='',registryOffen=false,offset=Number(a.offset??0);
 const sichtSql=await reverseSichtbarSql(pool); // P18-T109

 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(!(await q(sichtSql,[a.project,a.reverse_id])).rows.length){await c.query('ROLLBACK');return antwort;}
  const limit=Math.min(Number(a.limit??reverseZahl(s,'seiten_limit')),reverseZahl(s,'max_limit'));
  const pfad=typeof (a.datei??a.file_path)==='string'?a.datei??a.file_path:null;
  const prefix=typeof a.path==='string'?a.path:null;
  if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(offset)||offset<0){await c.query('ROLLBACK');return antwort;}
  // Fensterzaehler vor Seiten-/Pfadfilter: min_dateien gilt fuer die gesamte RV27-Gruppe.
  rows=(await q(`WITH d AS (
   SELECT id::text,pfad,groesse::text,sha256,status,format,leser_plugin,entpackt_mit,
    metadaten->'rv27'->>'extension' AS extension,metadaten->'rv27'->>'magic' AS magic,
    metadaten->'rv27'->>'size_pattern' AS size_pattern,metadaten->'rv27'->>'header_hex' AS header_hex,
    count(*) OVER(PARTITION BY metadaten->'rv27'->>'extension',metadaten->'rv27'->>'magic',metadaten->'rv27'->>'size_pattern')::text AS gruppenzahl
   FROM reverse_dateien WHERE eintrag_id=$1 AND NOT(metadaten ? 'reverse_leser')
    AND jsonb_typeof(metadaten->'rv27')='object')
   SELECT d.*,l.lauf FROM d LEFT JOIN LATERAL(
    SELECT jsonb_build_object('status',l.status,'fehlercode',l.fehlercode,'ausgabe_anzahl',l.ausgabe_anzahl::text,
     'offen',l.offen::text,'host_validiert',l.diagnose->'host_validiert','manifest_key',l.manifest_key,
     'manifest_sha256',l.manifest_sha256,'beendet_at',l.beendet_at,'leser_id',l.leser_id) AS lauf
    FROM reverse_leser_laeufe l WHERE l.eintrag_id=$1 AND l.datei_id=d.id::bigint AND l.quell_sha256=d.sha256
     AND l.diagnose->>'testmodus' IS DISTINCT FROM 'true' ORDER BY l.created_at DESC,l.id DESC LIMIT 1
   ) l ON true WHERE ($2::text IS NULL OR d.pfad=$2) AND ($3::text IS NULL OR d.pfad=$3 OR left(d.pfad,length($3)+1)=$3||'/')
   ORDER BY d.pfad,d.id::bigint LIMIT $4 OFFSET $5`,[a.reverse_id,pfad,prefix,limit,offset])).rows;
  revision=String((await q(registrySql,[])).rows[0].revision);let nach:string|null=null;
  for(const d of rows){d.aktiv=false;d.inaktiv=false;d.offen=false;}
  // Registry ohne Gesamtdeckel keyset-weise lesen, keine Quelltexte/Pakete laden.
  for(;;){
   const rs:Row[]=(await q(`SELECT r.id,r.manifest,z.status,z.storage_key FROM reverse_leser r
    JOIN reverse_leser_zustaende z ON z.leser_id=r.id WHERE ($1::text IS NULL OR r.id>$1) ORDER BY r.id LIMIT $2`,
    [nach,reverseZahl(s,'max_limit')])).rows;
   for(const r of rs){
    for(const d of rows){
     const m=reverseLeserHinweisMatch(r.manifest,d);
     if(m===null){d.offen=true;registryOffen=true;}
     else if(m===true){if(r.status==='aktiv'&&r.storage_key&&leserSchalter.aktiv&&!leserSchalter.letzter_fehler)d.aktiv=true;else d.inaktiv=true;}
    }
   }
   if(rs.length<reverseZahl(s,'max_limit'))break;nach=String(rs[rs.length-1].id);
  }
  await c.query('COMMIT');
 }catch(e){
  await c.query('ROLLBACK').catch(()=>undefined);
  return ausgabe({letzter_fehler:(e as {code?:string}).code==='57014'?'hinweis_zeitlimit':'hinweis_belege_nicht_lesbar'});
 }finally{c.release();}
 const gruppen:Row[]=[];
 for(const g of gruppiereRv27Dateien(rows.map(d=>({...d,path:d.pfad})))){
  const ds=g.files as Row[];
  if(BigInt(ds[0].gruppenzahl)<BigInt(reverseZahl(s,'leser_hinweis_min_dateien')))continue;
  const zustaende=[...new Set(ds.map(d=>reverseLeserHinweisZustand(d,d.aktiv,d.inaktiv,d.offen)))];
  // Ein erkannter Alt-Leser oder natives Format ist kein fehlender externer Leser.
  const relevant=ds.some(d=>d.lauf||d.inaktiv||d.aktiv||(!d.leser_plugin&&!d.entpackt_mit&&(!d.format||['unbekannt','binaer','binary','data'].includes(d.format))));
  if(!relevant)continue;
  const rang:LeserHinweisZustand[]=['beschaedigt','schritt_unterbrochen','kein_leser','leser_deaktiviert','erkennung_offen','gueltige_leere_tabelle','leser_aktiv'];
  const zustand=rang.find(z=>zustaende.includes(z))!;
  const schluessel=a.reverse_id+':'+hash(g.key)+':';
  const item:Row={gruppe:mask(g.key),anzahl:ds[0].gruppenzahl,seite_dateien:ds.length,zustand,zustaende,
   quellschluessel:schluessel+revision,schluessel_prefix:schluessel,registryrevision:revision,
   datei:mask(ds[0].pfad),header_comparison:{...g.header_comparison as Row,reference:mask((g.header_comparison as Row).reference)},funktionen:[]};
  item.pfade=ds.map(d=>String(d.pfad));
  gruppen.push(item);
  // P18-T109: Leserbefund zusätzlich ins zentrale Fehlerlog (Schalter reverse_fehlerlog, blockiert nie).
  if(['beschaedigt','schritt_unterbrochen','kein_leser','leser_deaktiviert'].includes(zustand))
   void loggeReverseFehler({eintrag_id:String(a.reverse_id),datei:String(ds[0].pfad),komponente:'leser',name:String(g.key),grund:zustand,detail:ds[0].gruppenzahl+' Dateien',quelle:'rv27_leser_hinweis'},pool);
 }
 // Ein RV30-Leselauf je Antwort; Funktionen bleiben statische Belege, kein Ghidra-Auftrag.
 const maxFn=reverseZahl(s,'leser_hinweis_funktionen');
 if(maxFn>0&&gruppen.some(g=>['kein_leser','leser_deaktiviert'].includes(g.zustand))){
  try{
   const links=await leseReverseVerknuepfungen(pool,a.reverse_id,a.project,{limit:Math.min(maxFn,reverseZahl(s,'max_limit'))},gruppen.flatMap(g=>g.pfade));
   for(const g of gruppen){
    const seen=new Set<string>(),pfade=new Set(g.pfade.map(mask));
    for(const link of links.links??[])if(link.funktion&&link.ziele?.some((z:Row)=>pfade.has(z.pfad))&&!seen.has(link.funktion.id)&&g.funktionen.length<maxFn){
     seen.add(link.funktion.id);g.funktionen.push(link.funktion);
    }
    g.funktionen_gekappt=!!links.gekappt;g.funktionen_fehler=links.fehlercode??null;
    g.funktionen_schalter=links.diagnose?.schalter;
   }
  }catch{for(const g of gruppen)g.funktionen_fehler='rv30_nicht_lesbar';}
 }
 for(const g of gruppen)delete g.pfade;
 // Direkt vor Sichtbarkeit erneut pruefen: AUS oder Bindung weg => keinen alten Befund publizieren.
 const aktuell=await leseReverseProduktSchalter('reverse_leser_hinweise',null,pool);
 const leserAktuell=await leseReverseProduktSchalter('reverse_leser',null,pool);
 if(leserAktuell.aktiv!==leserSchalter.aktiv||leserAktuell.letzter_fehler)return ausgabe({letzter_fehler:'leser_schalter_geaendert'});
 if(String((await pool.query(registrySql)).rows[0].revision)!==revision)return ausgabe({letzter_fehler:'registry_geaendert'});
 const einstellungen=await leseReverseEinstellwerte({project:a.project,eintrag_id:a.reverse_id},pool);
 if(einstellungen.letzter_fehler||einstellungen.revision!==s.revision)return ausgabe({letzter_fehler:'einstellungen_geaendert'});
 if(!aktuell.aktiv||aktuell.letzter_fehler||!(await reverseEintragSichtbar(pool,String(a.project),String(a.reverse_id))))return antwort;
 return ausgabe({registryrevision:revision,registry_erkennung_offen:registryOffen,gruppen,
  seite:{offset,limit:rows.length},letzter_fehler:null});
}
/** Der gemeinsame Handler hat Rechte/Bindung geprueft; keine Kandidaten aus Clientargumenten. */
export function reverseLeserHinweisQuelle(db:Pick<Pool,'query'>=getPool()):HinweisQuelle{
 return {quelle_id:'format_ohne_leser',async pruefe(ctx){
  if(ctx.tool!=='reverse'||!AKTIONEN.has(ctx.aktion??'')||ctx.signal.aborted)return [];
  const h=ctx.felder.leser_hinweis;
  if(!obj(h)||!h.schalter?.aktiv||h.letzter_fehler||!Array.isArray(h.gruppen))return [];
  if(!(await reverseEintragSichtbar(db,String(ctx.projekt),String(ctx.argumente.reverse_id)))||ctx.signal.aborted)return [];
  const stand=await leseReverseProduktSchalter('reverse_leser_hinweise',null,db);
  if(!stand.aktiv||stand.letzter_fehler||ctx.signal.aborted)return [];
  const leser=await leseReverseProduktSchalter('reverse_leser',null,db);
  if(leser.aktiv!==h.leser_schalter?.aktiv||leser.letzter_fehler||ctx.signal.aborted)return [];
  const s=await leseReverseEinstellwerte({project:ctx.projekt,eintrag_id:String(ctx.argumente.reverse_id)},db);
  if(s.letzter_fehler||s.revision!==h.einstellungen_revision||ctx.signal.aborted)return [];
  if(String((await db.query(registrySql)).rows[0].revision)!==h.registryrevision||ctx.signal.aborted)return [];
  const out:AusloeserHinweis[]=[];
  for(const g of h.gruppen){
   if(ctx.signal.aborted)return [];
   if(['leser_aktiv','gueltige_leere_tabelle'].includes(g.zustand)){
    const identity=aktuelleAgentIdentityId(ctx.projekt,ctx.agent_id);
    // Nur RV19-eigene Zustellmarken erledigen; keine Reverse-/Projektinhalte aendern.
    const table=identity?'agent_identitaet_hinweis_zustellungen':'ausloeser_hinweis_zustellungen',spalte=identity?'identity_id':'agent_id';
    const alte=(await db.query(`SELECT hinweis_id FROM ${table} WHERE project=$1 AND ${spalte}=$2 AND sitzung=$3 AND quelle_id='format_ohne_leser'
     AND left(hinweis_id,length($4))=$4 ORDER BY hinweis_id LIMIT $5`,
     [ctx.projekt,identity??ctx.agent_id,ctx.sitzung,g.schluessel_prefix,h.zustell_limit])).rows;
    for(const alt of alte)out.push({hinweis_id:alt.hinweis_id,modus:'einmal_je_sitzung',text:'Leser vorhanden; Hinweis erledigt.',erledigt:true});
    continue;
   }
   if(g.zustand==='erkennung_offen')continue;
   const next=g.zustand==='kein_leser'?'Leser entwerfen und registrieren':
    g.zustand==='leser_deaktiviert'?'Koordinator: Leser prüfen und aktivieren':
    g.zustand==='beschaedigt'?'Bytebeleg prüfen; Quelle reparieren':'Laufgrund prüfen; Fortsetzung vorbereiten';
   const args={project:ctx.projekt,reverse_id:ctx.argumente.reverse_id,datei:g.datei};
   const funktionen=g.funktionen.map((f:Row)=>mask(f.name)).join(', ');
   out.push({hinweis_id:g.quellschluessel,modus:'einmal_je_sitzung',spezifitaet:50,
    text:next+'; '+g.zustand+' '+mask(g.gruppe)+' ('+g.anzahl+' Dateien)'+(funktionen?'; statische Belege: '+funktionen:''),
    folgeaktion:{tool:'reverse',aktion:'inspect',argumente:args}});
  }
  // RV19 akzeptiert höchstens 100 Kandidaten je Quelle (Schnittstellenvertrag, kein Bestandslimit).
  return ctx.signal.aborted?[]:out.slice(0,100);
 }};
}
let registriert=false;
export function initialisiereReverseLeserHinweise():void{
 if(registriert)return;registriereHinweisQuelle(reverseLeserHinweisQuelle());registriert=true;
}
