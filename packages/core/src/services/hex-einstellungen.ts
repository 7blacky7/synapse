/**
 * P21-T3/T13: EINE PG-Lesestelle fuer Hex-Budgets; projekt > global > Standard.
 * Produkt hex_lesen ist standardmaessig AUS, intern ist nur ein befristeter Testoverride.
 */
import {getPool} from '../db/client.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter,ProfilVerwaltungFehler,pflichtText} from './agent-profil-verwalter.js';
import type {AusweisAkteur} from './agent-profil-vertrag.js';

export const HEX_EINSTELLUNGEN = {
 hex_bytes: 4096, max_hex_bytes: 16384, antwort_zeichen: 32768,
 max_adress_eintraege:4096,
 max_fundstellen: 64, max_diff_bloecke: 32, max_struktur_knoten: 256,
 chunk_bytes: 65536, ram_bytes: 33554432, scan_bytes: 16777216,
 laufzeit_ms: 5000, cursor_minuten: 30,
 format_bytes:65536,max_format_typen:128,max_format_felder:1024,max_struktur_tiefe:16,
 max_expr_schritte:10000,max_format_schritte:10000,max_format_wiederholungen:1000000,max_format_feld_bytes:4096,
 string_bytes: 256, max_deuten_tiefe: 16,
 entschluesseln_bytes:1048576,analyse_bytes:2097152,schluessel_bytes:4096,krypto_parameter_bytes:4096,
 max_analyse_tiefe:16,max_analyse_quellen:32,analyse_minuten:1440,max_analysen:1000,analyse_speicher_bytes:268435456,
 hex_worker_parallel:2,hex_worker_cpu:1,hex_worker_heap_bytes:8388608,hex_lease_zusatz_sekunden:5,
 hex_job_aging_sekunden:300,hex_job_scan:128,hex_node_frische_sekunden:120,
} as const;
export type HexEinstellungName = keyof typeof HEX_EINSTELLUNGEN;
export interface HexWert {wert:number;quelle:'standard'|'global'|'projekt';standard:number;global:number|null;projekt:number|null}
export interface HexStand {
 project:string|null;werte:Record<HexEinstellungName,HexWert>;letzter_fehler:string|null;
 adressen_schalter?:HexStand['schalter'];
 formate_schalter?:HexStand['schalter'];
 entschluesseln_schalter?:HexStand['schalter'];
 schalter:{aktiv:boolean;quelle:'standard'|'produkt-schalter'|'intern';bis:string|null;letzter_fehler:string|null};
}
export async function leseHexEinstellungen(project:string|null):Promise<HexStand>{
 const werte={} as HexStand['werte'];
 let fehler:string|null=null;
 let rows:Array<{ebene:string;name:string;wert:string}>=[];
 try{rows=(await getPool().query('SELECT ebene,name,wert::text FROM hex_einstellungen WHERE ebene=\'global\' OR (ebene=\'projekt\' AND project=$1)',[project])).rows;}
 catch{fehler='hex_einstellungen_nicht_lesbar';}
 for(const name of Object.keys(HEX_EINSTELLUNGEN) as HexEinstellungName[]){
  const g=rows.find(r=>r.name===name&&r.ebene==='global'),p=rows.find(r=>r.name===name&&r.ebene==='projekt');
  const z=p??g,n=z?Number(z.wert):HEX_EINSTELLUNGEN[name];
  const gueltig=Number.isSafeInteger(n)&&n>0&&n<=2147483647;
  if(!gueltig)fehler='hex_einstellung_ungueltig';
  werte[name]={wert:gueltig?n:HEX_EINSTELLUNGEN[name],quelle:gueltig&&z?(p?'projekt':'global'):'standard',
   standard:HEX_EINSTELLUNGEN[name],global:g?Number(g.wert):null,projekt:p?Number(p.wert):null};
 }
 const produkt=await leseProfilProduktSchalter('hex_lesen',project);
 let schalter:HexStand['schalter']={aktiv:produkt.aktiv,quelle:produkt.quelle,bis:null,letzter_fehler:produkt.letzter_fehler};
 if(internToolAktiv()){
  try{
   const r=await getPool().query("SELECT aktiv,bis FROM intern_schalter WHERE name='hex_lesen' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");
   const z=r.rows[0];if(z)schalter={aktiv:z.aktiv,quelle:'intern',bis:z.bis?new Date(z.bis).toISOString():null,letzter_fehler:null};
  }catch{schalter.letzter_fehler='hex_override_nicht_lesbar';}
 }
 const fp=await leseProfilProduktSchalter('hex_formate',project);
 let formate_schalter:HexStand['schalter']={aktiv:fp.aktiv,quelle:fp.quelle,bis:null,letzter_fehler:fp.letzter_fehler};
 if(internToolAktiv()){
  try{const r=await getPool().query("SELECT aktiv,bis FROM intern_schalter WHERE name='hex_formate' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");
   const z=r.rows[0];if(z)formate_schalter={aktiv:z.aktiv,quelle:'intern',bis:z.bis?new Date(z.bis).toISOString():null,letzter_fehler:null};
  }catch{formate_schalter.letzter_fehler='hex_formate_override_nicht_lesbar';}
 }
 const ep=await leseProfilProduktSchalter('hex_entschluesseln',project);
 let entschluesseln_schalter:HexStand['schalter']={aktiv:ep.aktiv,quelle:ep.quelle,bis:null,letzter_fehler:ep.letzter_fehler};
 if(internToolAktiv()){
  try{const r=await getPool().query("SELECT aktiv,bis FROM intern_schalter WHERE name='hex_entschluesseln' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");
   const z=r.rows[0];if(z)entschluesseln_schalter={aktiv:z.aktiv,quelle:'intern',bis:z.bis?new Date(z.bis).toISOString():null,letzter_fehler:null};
  }catch{entschluesseln_schalter.letzter_fehler='hex_entschluesseln_override_nicht_lesbar';}
 }
 const ap=await leseProfilProduktSchalter('hex_adressen',project);
 let adressen_schalter:HexStand['schalter']={aktiv:ap.aktiv,quelle:ap.quelle,bis:null,letzter_fehler:ap.letzter_fehler};
 if(internToolAktiv()){
  try{const r=await getPool().query("SELECT aktiv,bis FROM intern_schalter WHERE name='hex_adressen' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");
   const z=r.rows[0];if(z)adressen_schalter={aktiv:z.aktiv,quelle:'intern',bis:z.bis?new Date(z.bis).toISOString():null,letzter_fehler:null};
  }catch{adressen_schalter.letzter_fehler='hex_adressen_override_nicht_lesbar';}
 }
 return {project,werte,letzter_fehler:fehler,schalter,formate_schalter,entschluesseln_schalter,adressen_schalter};
}
export const HEX_ADMIN_ACTIONS=['hex_einstellungen'] as const;
export const HEX_ADMIN_PARAMETER={
 hex_werte:{type:'object',additionalProperties:{type:'integer',minimum:1},description:'hex_einstellungen setzen: Hex-Budgets (status nennt Namen und Quellen)'},
 hex_namen:{type:'array',items:{type:'string'},description:'hex_einstellungen entfernen: Namen auf dieser Ebene zuruecksetzen'},
};
export async function fuehreHexAdminAus(args:Record<string,unknown>,wer:AusweisAkteur|null=aktuellerW1bAkteur()):Promise<Record<string,unknown>>{
 try{
  const project=typeof args.project==='string'&&args.project?args.project:null;
  if(!project||!wer)throw new ProfilVerwaltungFehler('recht_fehlt');
  // Verwaltungsrecht aus bezeugtem Akteur; der Main verwaltet seinen eigenen Rahmen, keine fremden Projekte.
  let akteur:{wer:string;actor_identity_id:string|null};
  if(wer.art==='identitaet'&&wer.principal.rolle==='main'&&wer.principal.project===project){
   const p=wer.principal;
   const r=await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",[p.identity_id,project]);
   if(!r.rows[0])throw new ProfilVerwaltungFehler('recht_fehlt');
   akteur={wer:p.identity_id,actor_identity_id:p.identity_id};
  }else akteur=await pruefeProfilVerwalter(wer,project);
  const modus=args.modus??'status';
  if(modus!=='status'){
   if(modus!=='setzen'&&modus!=='entfernen')throw new ProfilVerwaltungFehler('modus_ungueltig');
   const ebene=args.ebene??'projekt';
   if(ebene!=='global'&&ebene!=='projekt')throw new ProfilVerwaltungFehler('ebene_ungueltig');
   const grund=pflichtText(args.grund,'grund_fehlt');
   const raw=args.hex_werte;
   if(modus==='setzen'&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw new ProfilVerwaltungFehler('hex_werte_fehlen');
   if(modus==='entfernen'&&(!Array.isArray(args.hex_namen)||!args.hex_namen.length))throw new ProfilVerwaltungFehler('hex_namen_fehlen');
   const entries=modus==='setzen'?Object.entries(raw as Record<string,unknown>):(args.hex_namen as unknown[]).map(n=>[n,null]);
   if(!entries.length)throw new ProfilVerwaltungFehler('hex_werte_fehlen');
   for(const [name,v] of entries){
    if(typeof name!=='string'||!Object.hasOwn(HEX_EINSTELLUNGEN,name))throw new ProfilVerwaltungFehler('hex_name_ungueltig');
    if(modus==='setzen'&&(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>2147483647))throw new ProfilVerwaltungFehler('hex_wert_ungueltig');
   }
   const c=await getPool().connect();
   try{
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s'");
    const ziel=ebene==='projekt'?project:null;
    if(modus==='entfernen')await c.query("DELETE FROM hex_einstellungen WHERE ebene=$1 AND COALESCE(project,'')=COALESCE($2,'') AND name=ANY($3::text[])",[ebene,ziel,entries.map(e=>e[0])]);
    else await c.query("INSERT INTO hex_einstellungen(ebene,project,name,wert,grund,gesetzt_von) SELECT $1,$2,n,v,$3,$4 FROM unnest($5::text[],$6::bigint[]) AS x(n,v) ON CONFLICT(ebene,(COALESCE(project,'')),name) DO UPDATE SET wert=EXCLUDED.wert,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=NOW()",[ebene,ziel,grund,akteur.wer,entries.map(e=>e[0]),entries.map(e=>e[1])]);
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  }
  return {success:true,action:'hex_einstellungen',modus,...await leseHexEinstellungen(project)};
 }catch(e){return {success:false,action:'hex_einstellungen',error:e instanceof ProfilVerwaltungFehler?e.code:'hex_einstellungen_speicher_fehler'};}
}
