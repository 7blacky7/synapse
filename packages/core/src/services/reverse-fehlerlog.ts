/**
 * P18-T109 Teil 3: zentrales Reverse-Fehlerlog (Schalter reverse_fehlerlog, global, Standard AUS).
 * Bündelt vorhandene Stellen statt neu zu messen:
 *  - abgeleitet, nur lesend: reverse_auftraege (fehler oder policy_*), reverse_schichten (fehler/teilweise), reverse_medien.fehlercode (E),
 *    reverse_parser_generationen (aktuell, teilweise + diagnose), reverse_leser_laeufe (fehler/abgebrochen),
 *    RV27-Gruppen mit derselben Klassifikation wie der Leserhinweis (reverseLeserHinweisMatch/-Zustand + Registry),
 *    Reverse-Work-Jobs mit error_code und Reverse-Container mit last_error (P20-Tabellen nur gelesen).
 *  - dauerhaft in reverse_fehlerlog: Flüchtiges ohne eigene Zeile (Entstörer-Maßnahmen mit aufgelöstem Eintrag/Datei/Schicht,
 *    unerwartete Tool-Fehler, RV27-Leserbefunde).
 * Grenzen ausschließlich aus reverse_einstellungen (diagnose_seiten_limit/diagnose_max_limit je Quelle, diagnose_log_zeichen).
 * Ehrlich begrenzt: jede Quelle liest die jüngsten diagnose_max_limit+1 Zeilen; gekappte Quellen stehen in quellen_gekappt,
 * vollstaendig=false. Schreiben ist fire-and-forget und blockiert nie; Lesen maskiert Texte ('reverse').
 * Abruf: reverse(action:"diagnose") Feld fehlerlog (nur mit Schalter EIN). Debug: letzter_schreibfehler, quellen_fehler.
 */
import {createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {leseReverseProduktSchalter,leseReverseEinstellwerte,reverseZahl,type ReverseSchalterStand} from './reverse-einstellwerte.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {zerlegeReverseFehlercode} from './reverse-ausfuehrer.js';

type Db={query:Function};
type Row=Record<string,any>;
export const REVERSE_FEHLER_KOMPONENTEN=['entpacken','werkzeug','parser','leser','container','policy','zeitlimit','tool','entstoerer'] as const;
export type ReverseFehlerKomponente=typeof REVERSE_FEHLER_KOMPONENTEN[number];
export interface ReverseFehlerEintrag {
  eintrag_id?:string|null;datei?:string|null;schicht?:string|null;komponente:ReverseFehlerKomponente;
  name?:string|null;grund:string;detail?:string|null;quelle:string;
}
/** IDs/Codes folgen REF_MUSTER (<=200) der Reverse-Referenzen; Freitext nach diagnose_log_zeichen. */
const ID_MAX=200;
const kurz=(v:unknown,n:number):string|null=>v===null||v===undefined?null:String(v).slice(0,n);
const mask=(v:unknown):unknown=>typeof v==='string'?maskiereMitKatalog(v,'reverse').text:v;
const SCHICHT=(kind:unknown)=>{const m=/reverse-(E|S[0-3])\b/i.exec(String(kind??''));return m?m[1].toUpperCase():null;};
const LESER_BEFUNDE=['beschaedigt','schritt_unterbrochen','kein_leser','leser_deaktiviert'];
let letzterSchreibfehler:string|null=null;
export function reverseFehlerlogSchreibfehler():string|null{return letzterSchreibfehler;}

export function reverseFehlerKomponente(code:string|null|undefined,schicht?:unknown):ReverseFehlerKomponente{
  if(code==='zeitlimit'||code==='ueber_zeitlimit')return 'zeitlimit';
  if(code?.startsWith('policy_'))return 'policy';
  if(code&&['kein_ausfuehrer','container_gesperrt','container_ruht','warteschlange_voll'].includes(code))return 'container';
  if(code==='format_nicht_unterstuetzt')return 'leser';
  return schicht==='E'?'entpacken':'werkzeug';
}
async function schalter(db?:Db):Promise<ReverseSchalterStand|null>{
  return leseReverseProduktSchalter('reverse_fehlerlog',null,db as never).catch(()=>null);
}
export async function reverseFehlerlogAktiv(db?:Db):Promise<boolean>{
  const s=await schalter(db);return !!s?.aktiv&&!s.letzter_fehler;
}

/** Wirft nie; Aufrufer warten nicht (void loggeReverseFehler(...)). Gleicher Schlüssel zählt hoch. */
export async function loggeReverseFehler(e:ReverseFehlerEintrag,db:Db=getPool()):Promise<void>{
  try{
    if(!(await reverseFehlerlogAktiv(db)))return;
    const text=reverseZahl(await leseReverseEinstellwerte({},db),'diagnose_log_zeichen');
    const schluessel=createHash('sha256').update(JSON.stringify([e.eintrag_id??'',e.datei??'',e.schicht??'',e.komponente,e.name??'',e.grund])).digest('hex');
    await db.query(`INSERT INTO reverse_fehlerlog(schluessel,eintrag_id,datei,schicht,komponente,name,grund,detail,quelle) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(schluessel) DO UPDATE SET anzahl=reverse_fehlerlog.anzahl+1,zuletzt_at=NOW(),detail=EXCLUDED.detail,quelle=EXCLUDED.quelle`,
      [schluessel,kurz(e.eintrag_id,ID_MAX),kurz(e.datei,text),kurz(e.schicht,ID_MAX),e.komponente,kurz(e.name,ID_MAX),kurz(e.grund,ID_MAX)??'unbekannt',kurz(e.detail,text),kurz(e.quelle,ID_MAX)??'unbekannt']);
    letzterSchreibfehler=null;
  }catch(x){letzterSchreibfehler=String((x as {code?:string})?.code??(x as Error)?.message??x).slice(0,ID_MAX);}
}

/** Abnahme R3b: Entstörer-Maßnahme mit strukturiertem Kontext (Eintrag/Datei/Schicht über Auftrag oder Work-Job). Wirft nie. */
export async function loggeReverseMassnahme(m:{quelle:string;ursache:string;massnahme:string;ziel:string|null;ergebnis:string},db:Db=getPool()):Promise<void>{
  try{
    if(!(await reverseFehlerlogAktiv(db)))return;
    let k:Row={};
    if(m.ziel&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.ziel)){
      k=(await db.query(`SELECT a.eintrag_id,a.schicht,d.pfad AS datei FROM reverse_auftraege a LEFT JOIN reverse_dateien d ON d.id=a.datei_id
        WHERE a.id::text=$1 OR a.p20_auftrag_id::text=$1 ORDER BY a.created_at DESC LIMIT 1`,[m.ziel])).rows[0]
        ??(await db.query("SELECT input_ref->>'id' AS eintrag_id,kind FROM work_jobs WHERE id::text=$1",[m.ziel]).catch(()=>({rows:[]}))).rows[0]??{};
    }
    await loggeReverseFehler({eintrag_id:k.eintrag_id??null,datei:k.datei??null,schicht:k.schicht??SCHICHT(k.kind),komponente:'entstoerer',
      name:m.massnahme+(m.ziel?':'+m.ziel:''),grund:m.ursache,detail:[m.ergebnis,m.ziel?'ziel '+m.ziel:null].filter(Boolean).join('; '),quelle:m.quelle},db);
  }catch(x){letzterSchreibfehler=String((x as {code?:string})?.code??(x as Error)?.message??x).slice(0,ID_MAX);}
}

export interface ReverseFehlerlogOptionen {reverseId?:string|null;komponente?:string|null;limit?:number;offset?:number;pool?:Db}

export async function leseReverseFehlerlog(o:ReverseFehlerlogOptionen={}):Promise<Row>{
  const db=o.pool??getPool(),rid=o.reverseId??null;
  const stand=await schalter(db);
  if(!stand?.aktiv||stand.letzter_fehler)return {aktiv:false,schalter:stand,eintraege:[],total:0,hinweis:'Schalter reverse_fehlerlog AUS (Standard).'};
  const s=await leseReverseEinstellwerte({eintrag_id:rid},db);
  const deckel=reverseZahl(s,'diagnose_max_limit'),text=reverseZahl(s,'diagnose_log_zeichen');
  const limit=Math.min(Math.max(Math.trunc(o.limit??reverseZahl(s,'diagnose_seiten_limit')),1),deckel),offset=Math.max(Math.trunc(o.offset??0),0);
  const alle:Row[]=[],quellen_fehler:Row[]=[],quellen_gekappt:string[]=[];
  const lies=async(quelle:string,sql:string,abbild:(r:Row)=>Row|null)=>{
    try{
      const rows=(await db.query(sql,[rid,deckel+1])).rows as Row[];
      if(rows.length>deckel){quellen_gekappt.push(quelle);rows.length=deckel;}
      for(const r of rows){const e=abbild(r);if(e)alle.push({quelle,...e});}
    }catch(x){quellen_fehler.push({quelle,fehler:String((x as {code?:string})?.code??'nicht_lesbar')});}
  };
  const ausCode=(r:Row)=>{const f=zerlegeReverseFehlercode(r.fehlercode as string|null);
    return {eintrag_id:r.eintrag_id,datei:r.pfad??null,schicht:r.schicht??null,komponente:reverseFehlerKomponente(f.code,r.schicht),
      name:r.werkzeug??null,grund:f.code??String(r.status??'fehler'),detail:kurz(f.detail,text),anzahl:1,zuletzt:r.zeit??null};};
  await lies('reverse_auftraege',`SELECT a.eintrag_id,d.pfad,a.schicht,a.status,a.fehlercode,to_jsonb(a)->>'werkzeug' AS werkzeug,a.updated_at AS zeit
    FROM reverse_auftraege a LEFT JOIN reverse_dateien d ON d.id=a.datei_id
    WHERE (a.status='fehler' OR left(a.fehlercode,7)='policy_') AND ($1::text IS NULL OR a.eintrag_id=$1) ORDER BY a.updated_at DESC,a.id LIMIT $2`,ausCode);
  await lies('reverse_schichten',`SELECT COALESCE(d.eintrag_id,m.eintrag_id) AS eintrag_id,COALESCE(d.pfad,m.bezeichnung) AS pfad,s.schicht,s.status,s.fehlercode,
    s.werkzeug,COALESCE(s.beendet_at,s.created_at) AS zeit FROM reverse_schichten s
    LEFT JOIN reverse_dateien d ON d.id=s.datei_id LEFT JOIN reverse_medien m ON m.id=s.medium_id
    WHERE s.aktuell AND s.status IN ('fehler','teilweise') AND ($1::text IS NULL OR COALESCE(d.eintrag_id,m.eintrag_id)=$1)
    ORDER BY COALESCE(s.beendet_at,s.created_at) DESC,s.id LIMIT $2`,ausCode);
  await lies('reverse_medien',`SELECT eintrag_id,bezeichnung AS pfad,'E' AS schicht,status,fehlercode,created_at AS zeit FROM reverse_medien
    WHERE fehlercode IS NOT NULL AND ($1::text IS NULL OR eintrag_id=$1) ORDER BY created_at DESC,id LIMIT $2`,ausCode);
  await lies('reverse_parser_generationen',`SELECT g.eintrag_id,d.pfad,g.schicht,g.status,g.adapter_version,g.diagnose-'funktionen' AS diagnose,
    COALESCE(g.beendet_at,g.created_at) AS zeit FROM reverse_parser_generationen g JOIN reverse_dateien d ON d.id=g.datei_id
    WHERE g.aktuell AND g.status='teilweise' AND ($1::text IS NULL OR g.eintrag_id=$1) ORDER BY COALESCE(g.beendet_at,g.created_at) DESC,g.id LIMIT $2`,
    r=>{const dg=r.diagnose&&typeof r.diagnose==='object'?r.diagnose as Row:{};
      return {eintrag_id:r.eintrag_id,datei:r.pfad,schicht:r.schicht,komponente:'parser',name:r.adapter_version??null,
        grund:String(dg.grund??dg.fehlercode??'teilweise'),detail:kurz(JSON.stringify(dg),text),anzahl:1,zuletzt:r.zeit};});
  await lies('reverse_leser_laeufe',`SELECT l.eintrag_id,d.pfad,l.leser_id,l.status,l.fehlercode,COALESCE(l.beendet_at,l.created_at) AS zeit
    FROM reverse_leser_laeufe l LEFT JOIN reverse_dateien d ON d.id=l.datei_id
    WHERE l.status IN ('fehler','abgebrochen') AND l.diagnose->>'testmodus' IS DISTINCT FROM 'true' AND ($1::text IS NULL OR l.eintrag_id=$1)
    ORDER BY l.created_at DESC,l.id LIMIT $2`,
    r=>({eintrag_id:r.eintrag_id,datei:r.pfad,schicht:null,komponente:'leser',name:r.leser_id,grund:String(r.fehlercode??r.status),detail:null,anzahl:1,zuletzt:r.zeit}));
  // Abnahme R3c: Container-/Policy-/Startfehler vor einem reverse_auftraege-Fehler (P20-Tabellen nur gelesen).
  // Re-Abnahme 1ef9bb27: auch Leser-Jobs (capability reverse_leser, inputRef id=Eintrag, revision=Datei-ID; reverse-leser-nachzug.ts).
  await lies('work_jobs',`SELECT w.input_ref->>'id' AS eintrag_id,w.capability,w.kind,w.state,w.error_code,w.attempt,COALESCE(w.lease_until,w.created_at) AS zeit,d.pfad
    FROM work_jobs w LEFT JOIN reverse_dateien d ON w.capability='reverse_leser' AND d.eintrag_id=w.input_ref->>'id' AND d.id::text=w.input_ref->>'revision'
    WHERE w.capability IN ('reverse_bibliothek','reverse_leser') AND w.error_code IS NOT NULL AND w.state NOT IN ('pending','leased','staged')
     AND ($1::text IS NULL OR w.input_ref->>'id'=$1) ORDER BY w.created_at DESC,w.id LIMIT $2`,
    r=>{const f=zerlegeReverseFehlercode(r.error_code as string|null);const sch=SCHICHT(r.kind);
      const k=reverseFehlerKomponente(f.code,sch),leser=r.capability==='reverse_leser'&&k==='werkzeug';
      return {eintrag_id:r.eintrag_id??null,datei:r.pfad??null,schicht:sch,komponente:leser?'leser':k,name:r.kind,
        grund:f.code??String(r.error_code),detail:kurz([f.detail,'versuch '+r.attempt,'zustand '+r.state].filter(Boolean).join('; '),text),anzahl:1,zuletzt:r.zeit};});
  // Re-Abnahme 1ef9bb27: Zuordnung auch historisch über tool_container_runs (Jobs dieser Instanz/Generation), nicht nur
  // über die aktuelle work_job_id. Grenze: last_error ist der aktuelle Containerstand; vom Lebenszyklus geleerte Fehler fehlen.
  await lies('tool_containers',`SELECT * FROM (SELECT DISTINCT ON (t.instance_id,t.generation)
      COALESCE(CASE WHEN $1::text IS NOT NULL AND wr.input_ref->>'id'=$1 THEN wr.input_ref->>'id' END,wc.input_ref->>'id',wr.input_ref->>'id') AS eintrag_id,
      t.tool_id,t.state,t.last_error,COALESCE(t.operation_at,t.updated_at) AS zeit
    FROM tool_containers t LEFT JOIN work_jobs wc ON wc.id=t.work_job_id
     LEFT JOIN tool_container_runs r ON r.instance_id=t.instance_id AND r.generation=t.generation LEFT JOIN work_jobs wr ON wr.id=r.job_id
    WHERE t.project='reverse-bibliothek' AND t.last_error IS NOT NULL
     AND ($1::text IS NULL OR wc.input_ref->>'id'=$1 OR wr.input_ref->>'id'=$1)
    ORDER BY t.instance_id,t.generation,(wr.input_ref->>'id' IS NOT DISTINCT FROM $1) DESC) c ORDER BY zeit DESC LIMIT $2`,
    r=>({eintrag_id:r.eintrag_id??null,datei:null,schicht:null,komponente:'container',name:r.tool_id,grund:'container_'+String(r.state),
      detail:kurz(r.last_error,text),anzahl:1,zuletzt:r.zeit}));
  await leseLeserBefunde(db,rid,deckel,alle,quellen_fehler,quellen_gekappt);
  await lies('reverse_fehlerlog',`SELECT eintrag_id,datei,schicht,komponente,name,grund,detail,quelle,anzahl,zuerst_at,zuletzt_at FROM reverse_fehlerlog
    WHERE ($1::text IS NULL OR eintrag_id=$1) ORDER BY zuletzt_at DESC,id LIMIT $2`,
    r=>({eintrag_id:r.eintrag_id,datei:r.datei,schicht:r.schicht,komponente:r.komponente,name:r.name,grund:r.grund,detail:r.detail,
      anzahl:Number(r.anzahl),zuerst:r.zuerst_at,zuletzt:r.zuletzt_at,ursprung:r.quelle}));
  const gefiltert=o.komponente?alle.filter(e=>e.komponente===o.komponente):alle;
  const zeit=(e:Row)=>e.zuletzt?new Date(e.zuletzt as string).getTime():0;
  gefiltert.sort((x,y)=>zeit(y)-zeit(x)||String(x.quelle).localeCompare(String(y.quelle)));
  const je_komponente:Record<string,number>={};
  for(const e of gefiltert)je_komponente[String(e.komponente)]=(je_komponente[String(e.komponente)]??0)+1;
  const seite=gefiltert.slice(offset,offset+limit).map(e=>Object.fromEntries(Object.entries(e).map(([k,v])=>[k,mask(v)])));
  const weiter=offset+seite.length<gefiltert.length;
  const vollstaendig=!quellen_gekappt.length&&!quellen_fehler.length;
  return {aktiv:true,schalter:stand,eintraege:seite,total:gefiltert.length,gekappt:weiter||!vollstaendig,naechster_offset:weiter?offset+seite.length:null,
    vollstaendig,quellen_gekappt,deckel_je_quelle:deckel,je_komponente,quellen_fehler,letzter_schreibfehler:letzterSchreibfehler,
    ...(vollstaendig?{}:{hinweis:'Begrenzte Sicht: je Quelle nur die jüngsten '+deckel+' Zeilen (diagnose_max_limit) bzw. Quelle nicht lesbar; ältere Fehler mit reverse_id eingrenzen.'})};
}

/**
 * Abnahme R3a: fehlende/inaktive Leser mit DERSELBEN Mechanik wie der RV27-Leserhinweis (reverse-leser-hinweis.ts):
 * Dateiauswahl, jüngster Leserlauf zur Quell-sha256, Registryabgleich über reverseLeserHinweisMatch und Zustand über
 * reverseLeserHinweisZustand. Nur Befundzustände (kein_leser, leser_deaktiviert, schritt_unterbrochen, beschaedigt).
 */
async function leseLeserBefunde(db:Db,rid:string|null,deckel:number,alle:Row[],quellen_fehler:Row[],quellen_gekappt:string[]):Promise<void>{
  const quelle='rv27_leser';
  try{
    const da=(await db.query("SELECT to_regclass('reverse_leser') AS a,to_regclass('reverse_leser_zustaende') AS b,to_regclass('reverse_leser_laeufe') AS c")).rows[0]??{};
    if(!da.a||!da.b||!da.c){quellen_fehler.push({quelle,fehler:'leser_tabellen_fehlen'});return;}
    const {reverseLeserHinweisMatch,reverseLeserHinweisZustand}=await import('./reverse-leser-hinweis.js');
    const leserSchalter=await leseReverseProduktSchalter('reverse_leser',null,db as never);
    const rows=(await db.query(`SELECT d.id::text,d.eintrag_id,d.pfad,d.groesse::text,d.sha256,d.status,d.format,d.leser_plugin,d.entpackt_mit,
      d.metadaten->'rv27'->>'extension' AS extension,d.metadaten->'rv27'->>'magic' AS magic,
      d.metadaten->'rv27'->>'size_pattern' AS size_pattern,d.metadaten->'rv27'->>'header_hex' AS header_hex,l.lauf
      FROM reverse_dateien d LEFT JOIN LATERAL(
       SELECT jsonb_build_object('status',l.status,'fehlercode',l.fehlercode,'ausgabe_anzahl',l.ausgabe_anzahl::text,
        'offen',l.offen::text,'host_validiert',l.diagnose->'host_validiert','manifest_key',l.manifest_key,
        'manifest_sha256',l.manifest_sha256,'beendet_at',l.beendet_at,'leser_id',l.leser_id) AS lauf
       FROM reverse_leser_laeufe l WHERE l.eintrag_id=d.eintrag_id AND l.datei_id=d.id AND l.quell_sha256=d.sha256
        AND l.diagnose->>'testmodus' IS DISTINCT FROM 'true' ORDER BY l.created_at DESC,l.id DESC LIMIT 1) l ON true
      WHERE NOT(d.metadaten ? 'reverse_leser') AND jsonb_typeof(d.metadaten->'rv27')='object' AND ($1::text IS NULL OR d.eintrag_id=$1)
      ORDER BY d.updated_at DESC,d.id LIMIT $2`,[rid,deckel+1])).rows as Row[];
    if(rows.length>deckel){quellen_gekappt.push(quelle);rows.length=deckel;}
    for(const d of rows){d.aktiv=false;d.inaktiv=false;d.offen=false;}
    let nach:string|null=null;
    for(;;){
      const rs=(await db.query(`SELECT r.id,r.manifest,z.status,z.storage_key FROM reverse_leser r JOIN reverse_leser_zustaende z ON z.leser_id=r.id
        WHERE ($1::text IS NULL OR r.id>$1) ORDER BY r.id LIMIT $2`,[nach,deckel])).rows as Row[];
      for(const r of rs)for(const d of rows){
        const m=reverseLeserHinweisMatch(r.manifest,d);
        if(m===null)d.offen=true;
        else if(m===true){if(r.status==='aktiv'&&r.storage_key&&leserSchalter.aktiv&&!leserSchalter.letzter_fehler)d.aktiv=true;else d.inaktiv=true;}
      }
      if(rs.length<deckel)break;nach=String(rs[rs.length-1].id);
    }
    const gruppen=new Map<string,Row>();
    for(const d of rows){
      // Relevanzregel wie im Leserhinweis: erkannter Alt-Leser/natives Format ist kein fehlender externer Leser.
      if(!(d.lauf||d.inaktiv||d.aktiv||(!d.leser_plugin&&!d.entpackt_mit&&(!d.format||['unbekannt','binaer','binary','data'].includes(d.format)))))continue;
      const zustand=reverseLeserHinweisZustand(d,d.aktiv,d.inaktiv,d.offen);
      if(!LESER_BEFUNDE.includes(zustand))continue;
      const name=[d.extension,d.magic,d.size_pattern].filter(Boolean).join(' ')||null;
      const key=JSON.stringify([d.eintrag_id,name,zustand]);
      const g=gruppen.get(key);
      if(g)g.anzahl++;else gruppen.set(key,{eintrag_id:d.eintrag_id,datei:d.pfad,schicht:null,komponente:'leser',name,grund:zustand,anzahl:1,zuletzt:null});
    }
    for(const g of gruppen.values())alle.push({quelle,...g,detail:g.anzahl+' Dateien'});
  }catch(x){quellen_fehler.push({quelle,fehler:String((x as {code?:string})?.code??'nicht_lesbar')});}
}
