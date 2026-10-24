/** P18-T104: one Reverse-only policy contract. Callers own the transaction; never reconnect a held client. */
import {createHash} from 'node:crypto';
import {leseReverseEinstellwerte,reverseWert,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
export const REVERSE_POLICY_STUFEN=['E','S0','S1','S2','S3'] as const;
export type ReversePolicyStufe=typeof REVERSE_POLICY_STUFEN[number];
type Db={query:Function};
type Row=Record<string,any>;
export class ReversePolicyFehler extends Error {
 constructor(readonly code:'policy_pin_fehlt'|'policy_geaendert'|'policy_grenze'|'policy_nicht_lesbar',readonly auftragId?:string){super(code);}
}
export const istReversePolicyFehler=(e:unknown):e is ReversePolicyFehler=>e instanceof ReversePolicyFehler;
export function reversePolicyStufe(v:unknown):ReversePolicyStufe {
 if(!REVERSE_POLICY_STUFEN.includes(v as ReversePolicyStufe))throw new ReversePolicyFehler('policy_nicht_lesbar');
 return v as ReversePolicyStufe;
}
export function reversePolicyMinimum(...werte:unknown[]):ReversePolicyStufe {
 if(!werte.length)throw new ReversePolicyFehler('policy_nicht_lesbar');
 return REVERSE_POLICY_STUFEN[Math.min(...werte.map(v=>REVERSE_POLICY_STUFEN.indexOf(reversePolicyStufe(v))))]!;
}
export function reversePolicyProjektion(s:ReverseEinstellSnapshot) {
 if(s.letzter_fehler||s.migrationsbedarf.some(x=>x.name==='analyse_bis_schicht'))throw new ReversePolicyFehler('policy_nicht_lesbar');
 const w=s.werte.analyse_bis_schicht;
 return {kontext:s.kontext,grenze:reversePolicyStufe(w.wert),quelle:w.quelle,ebene:w.ebene,global:w.global,projekt:w.projekt,eintrag:w.eintrag};
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface ReversePolicyPin {
 version:1;ursprung:'manuell'|'automatisch'|'folge';root_id:string;scope_key:string;
 eintrag_id:string;project:string|null;angefragt_bis:ReversePolicyStufe;wirksam_bis:ReversePolicyStufe;
 policy_revision:string;quelle:{datei_id:string|null;medium_id:string|null;sha256:string};
 vorgaben:string[];
 /** P18-T98: abgeschlossene Altaufträge ohne Pin (fertig/teilweise) zählen für diesen Pin nicht als Vorgabe. Nur Nachzug-Aufträge setzen das. */
 ohne_legacy_abgeschlossen?:true;
 /** P18-T111: automatischer Nachzug mit eigener Grenze (nur S3 fuer PE, Schalter s3_auto); ersetzt analyse_bis_schicht nur fuer diesen Pin. */
 auto_grenze?:ReversePolicyStufe;
}
interface Kontext {reverseId:string;dateiId:string|null;mediumId:string|null;project?:string|null}
interface Vorgabe {id:string;pin:ReversePolicyPin}
export async function sperreReversePolicy(db:Db,rid:string,exklusiv=false):Promise<void>{
 // Same writer lock as reverse-einstellungen.ts. Always settings -> entry -> job/budget locks.
 await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('reverse-einstellungen'))");
 await db.query('SELECT '+(exklusiv?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared')+'(hashtext($1))',['reverse-policy:'+rid]);
}
function pinLesen(raw:unknown,id?:string):ReversePolicyPin {
 const p=raw as ReversePolicyPin|null;
 if(!p||p.version!==1||!['manuell','automatisch','folge'].includes(p.ursprung)||typeof p.root_id!=='string'||
  typeof p.eintrag_id!=='string'||typeof p.scope_key!=='string'||typeof p.policy_revision!=='string'||
  !p.quelle||typeof p.quelle.sha256!=='string'||!Array.isArray(p.vorgaben)||p.vorgaben.some(x=>typeof x!=='string')||
  !(p.project===null||typeof p.project==='string'))throw new ReversePolicyFehler('policy_pin_fehlt',id);
 reversePolicyStufe(p.angefragt_bis);reversePolicyStufe(p.wirksam_bis);return p;
}
async function quelle(db:Db,k:Kontext):Promise<ReversePolicyPin['quelle']>{
 const e=(await db.query("SELECT status FROM reverse_eintraege WHERE id=$1",[k.reverseId])).rows[0];
 if(e?.status!=='bestaetigt')throw new ReversePolicyFehler('policy_grenze');
 const r=k.dateiId
  ?(await db.query('SELECT id::text,medium_id::text,sha256 FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2::bigint',[k.reverseId,k.dateiId])).rows[0]
  :(await db.query('SELECT id::text,satz_sha256 AS sha256 FROM reverse_medien WHERE eintrag_id=$1 AND id=$2::bigint',[k.reverseId,k.mediumId])).rows[0];
 if(!r||!/^[a-f0-9]{64}$/.test(String(r.sha256)))throw new ReversePolicyFehler('policy_geaendert');
 return {datei_id:k.dateiId,medium_id:k.dateiId?(r.medium_id??null):String(r.id),sha256:r.sha256};
}
async function vorgaben(db:Db,k:Kontext,q:ReversePolicyPin['quelle'],ersetze?:string,ohneLegacyAbgeschlossen=false):Promise<Vorgabe[]> {
 // Latest explicit root per applicable scope. Legacy manual requests have no trustworthy depth: hold, never infer from GREATEST.
 const scopes=['eintrag',...(q.medium_id?['medium:'+q.medium_id]:[]),...(q.datei_id?['datei:'+q.datei_id]:[])];
 const rows=(await db.query(`SELECT DISTINCT ON (scope_key) id::text,policy_pin,scope_key FROM (
  SELECT id,created_at,policy_pin,COALESCE(policy_pin->>'scope_key',CASE WHEN datei_id IS NOT NULL THEN 'datei:'||datei_id::text ELSE 'medium:'||medium_id::text END) AS scope_key
  FROM reverse_auftraege WHERE eintrag_id=$1 AND
   (policy_pin->>'ursprung'='manuell' OR policy_pin IS NULL AND ausloeser LIKE 'agent:%' AND ausloeser<>'agent:reverse-pipeline')
   -- P18-T98/T112 (Koordinator-Entscheidung zu 14fabd17): mit Flag zaehlen ALLE abgeschlossenen (fertig/teilweise) Altauftraege
   -- ohne Pin nicht mehr als Vorgabe, gleich welcher Schicht (nicht nur E) - sie geben nichts mehr vor. Offene Altauftraege ohne Pin
   -- (offen/wartet/laeuft/fehler) halten weiter (policy_pin_fehlt).
   AND NOT ($4::boolean AND policy_pin IS NULL AND status IN ('fertig','teilweise'))
 ) r WHERE scope_key=ANY($2::text[]) AND ($3::text IS NULL OR scope_key<>$3)
 ORDER BY scope_key,created_at DESC,id DESC`,[k.reverseId,scopes,ersetze??null,ohneLegacyAbgeschlossen])).rows;
 return rows.map((r:Row)=>({id:String(r.id),pin:pinLesen(r.policy_pin,String(r.id))}));
}
function ids(v:Vorgabe[]):string[]{return v.map(x=>x.id).sort();}
export async function bereiteReversePolicyPin(db:Db,k:Kontext&{id:string;angefragt:string;manuell?:boolean;elternId?:string|null;ohneLegacyAbgeschlossen?:boolean;autoGrenze?:string}):Promise<ReversePolicyPin>{
 await sperreReversePolicy(db,k.reverseId,!!k.manuell);
 const q=await quelle(db,k),scope=q.datei_id?'datei:'+q.datei_id:'medium:'+q.medium_id;
 let parent:ReversePolicyPin|undefined;
 if(k.elternId)parent=await pruefeReversePolicyAuftrag(db,k.elternId,k.reverseId,'E');
 // P18-T112 (bbb29904): Folgeauftraege (z. B. S0 -> S1) erben die Legacy-Ausnahme des Eltern-Pins; sonst blockiert ein
 // abgeschlossener Alt-E ohne Pin jeden Folgeschritt, obwohl der Root bereits mit Ausnahme angenommen wurde.
 const ohneLegacy=k.ohneLegacyAbgeschlossen===true||(!k.manuell&&parent?.ohne_legacy_abgeschlossen===true);
 const v=await vorgaben(db,k,q,k.manuell?scope:undefined,ohneLegacy);
 const project=k.manuell?(k.project??null):(parent?.project??v.find(x=>x.pin.scope_key===scope)?.pin.project??v.at(-1)?.pin.project??null);
 const s=reversePolicyProjektion(await leseReverseEinstellwerte({project,eintrag_id:k.reverseId},db));
 // A root whose config has changed cannot silently grant a fresh descendant.
 for(const x of v){
  const aktuell=reversePolicyProjektion(await leseReverseEinstellwerte({project:x.pin.project,eintrag_id:k.reverseId},db));
  if(hash(aktuell)!==x.pin.policy_revision)throw new ReversePolicyFehler('policy_geaendert',x.id);
 }
 // P18-T111: nur ein automatischer Root (kein manueller, kein Folgeauftrag) darf eine eigene Grenze tragen; Vorgaben begrenzen weiter.
 // Folgeauftraege eines automatischen S3-Roots erben dessen Grenze (pruefeReversePolicyAuftrag prueft s3_auto weiter).
 const autoGrenze=k.manuell?undefined:parent?(parent.auto_grenze?reversePolicyStufe(parent.auto_grenze):undefined):k.autoGrenze?reversePolicyStufe(k.autoGrenze):undefined;
 const grenze=autoGrenze??s.grenze;
 const angefragt=k.manuell?reversePolicyStufe(k.angefragt):(parent?.wirksam_bis??grenze);
 const wirksam=reversePolicyMinimum(grenze,angefragt,...v.map(x=>x.pin.wirksam_bis));
 return {version:1,ursprung:k.manuell?'manuell':parent?'folge':'automatisch',root_id:k.manuell?k.id:parent?.root_id??k.id,scope_key:scope,
  eintrag_id:k.reverseId,project,angefragt_bis:angefragt,wirksam_bis:wirksam,policy_revision:hash(s),quelle:q,
  vorgaben:[...ids(v),...(k.manuell?[k.id]:[])].sort(),...(ohneLegacy?{ohne_legacy_abgeschlossen:true as const}:{}),...(autoGrenze?{auto_grenze:autoGrenze}:{})};
}
/** Strictly scoped by entry and optionally source; accepts Fachauftrag ID or P20 ID. Read-only inside caller's TX. */
export async function pruefeReversePolicyAuftrag(db:Db,id:string,rid:string,stufe:string,dateiId?:string|null):Promise<ReversePolicyPin>{
 await sperreReversePolicy(db,rid);
 const rows=(await db.query(`SELECT id::text,eintrag_id,datei_id::text,medium_id::text,policy_pin FROM reverse_auftraege
  WHERE eintrag_id=$1 AND (id::text=$2 OR p20_auftrag_id::text=$2)
   AND ($3::text IS NULL OR datei_id::text=$3) ORDER BY created_at DESC,id DESC`,[rid,id,dateiId??null])).rows;
 if(!rows.length)throw new ReversePolicyFehler('policy_pin_fehlt',id);
 let answer:ReversePolicyPin|undefined;
 for(const r of rows){
  const p=pinLesen(r.policy_pin,String(r.id));
  if(p.eintrag_id!==rid||p.quelle.datei_id!==(r.datei_id??null))throw new ReversePolicyFehler('policy_geaendert',String(r.id));
  const k={reverseId:rid,dateiId:r.datei_id??null,mediumId:r.medium_id??null,project:p.project};
  const q=await quelle(db,k);
  if(q.sha256!==p.quelle.sha256||q.medium_id!==p.quelle.medium_id)throw new ReversePolicyFehler('policy_geaendert',String(r.id));
  const roh=await leseReverseEinstellwerte({project:p.project,eintrag_id:rid},db),s=reversePolicyProjektion(roh);
  // P18-T111: Schalter s3_auto aus = automatische S3-Pins sind nicht mehr gedeckt.
  if(p.auto_grenze&&reverseWert(roh,'s3_auto')!=='an')throw new ReversePolicyFehler('policy_geaendert',String(r.id));
  const v=await vorgaben(db,k,q,undefined,p.ohne_legacy_abgeschlossen===true);
  for(const x of v){const aktuell=reversePolicyProjektion(await leseReverseEinstellwerte({project:x.pin.project,eintrag_id:rid},db));if(hash(aktuell)!==x.pin.policy_revision)throw new ReversePolicyFehler('policy_geaendert',String(r.id));}
  if(hash(s)!==p.policy_revision||JSON.stringify(ids(v))!==JSON.stringify(p.vorgaben))
   throw new ReversePolicyFehler('policy_geaendert',String(r.id));
  const max=reversePolicyMinimum(p.wirksam_bis,p.auto_grenze??s.grenze,...v.map(x=>x.pin.wirksam_bis));
  if(REVERSE_POLICY_STUFEN.indexOf(reversePolicyStufe(stufe))>REVERSE_POLICY_STUFEN.indexOf(max))throw new ReversePolicyFehler('policy_grenze',String(r.id));
  answer=p;
 }
 return answer!;
}
/** One scoped metadata row only; no generation deletion or fake successful layer. Caller applies its lease fence first. */
export async function halteReversePolicyAuftrag(db:Db,id:string,rid:string,code:ReversePolicyFehler['code']):Promise<void>{
 await db.query("UPDATE reverse_auftraege SET status='fehler',fehlercode=$3,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id::text=$1 AND eintrag_id=$2 AND status IN ('offen','wartet','laeuft','fehler')",[id,rid,code]);
}
