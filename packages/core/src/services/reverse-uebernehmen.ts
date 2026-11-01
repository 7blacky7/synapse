/** P18-T27/RV17: API-only, keine Rohkopie und kein code_files-Schreibweg. */
import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetUploadKern,AssetUploadFehler,type AssetUploadDb} from './asset-upload.js';
import {normalisiereSpeicherPfad,ASSET_BEREICHSSPERRE_MELDUNG} from './asset-speicher.js';
import {holeReverseAnsichtDatei,reverseAnsichtAdapter} from './reverse-ansicht-adapter.js';
import {pcZustellungFuerAsset} from './asset-pc-zustellung.js';
import {reverseEintragSichtbar} from './reverse-sichtbarkeit.js';
type Row=Record<string,unknown>;
export class ReverseUebernahmeFehler extends Error {
 constructor(readonly code:'keine_berechtigung'|'nicht_gebunden'|'nicht_gefunden'|'ziel_belegt'|'pfad_gefahr'|'werkzeug_fehler',readonly detail?:string,readonly extra:Row={}){super(code);}
}
function fail(code:ReverseUebernahmeFehler['code'],detail?:string,extra:Row={}):never{throw new ReverseUebernahmeFehler(code,detail,extra);}
function pfad(v:unknown):string {
 if(typeof v!=='string'||!v)fail('pfad_gefahr');
 // P22-T274 B1: normalisiereSpeicherPfad wirft bei '..' & Co.; das ist pfad_gefahr, kein interner Fehler.
 let norm:string;try{norm=normalisiereSpeicherPfad(v);}catch{fail('pfad_gefahr');}
 if(norm!==v)fail('pfad_gefahr');
 return v;
}
const gesetzt=(v:unknown)=>v!==undefined&&v!==null&&v!=='';
/** P22-T274 B1: datei ist Alias für file_path (wie bei status/analysieren/ansicht); beide laufen durch dieselbe Pfadprüfung.
 * Bisher las die Übernahme nur file_path, mit datei kam pfad(undefined) = pfad_gefahr. */
function quellArg(a:Row):unknown {
 if(gesetzt(a.datei)&&gesetzt(a.file_path)&&a.datei!==a.file_path)fail('werkzeug_fehler','parameter_ungueltig',{hinweis:'datei und file_path sind Aliase und müssen gleich sein.'});
 return gesetzt(a.datei)?a.datei:a.file_path;
}
/** P22-T274 B7: AssetSpeicher.publish hält je Projekt EINE Bereichssperre (<projekt>/.intern/locks/publish, O_EXCL).
 * Parallele Übernahmen in dasselbe Projekt liefen in diese Sperre und wurden als ziel_belegt gemeldet, obwohl das Ziel fehlte.
 * Darum laufen Übernahmen je Projekt in diesem Prozess nacheinander; hält ein anderer Weg (Daemon-Upload, anderer Prozess)
 * die Sperre, wird mit neuer Uploadsitzung kurz erneut versucht und am Ende veroeffentlichung_gesperrt gemeldet, nie ziel_belegt. */
export const REVERSE_UEBERNAHME_SPERRE_VERSUCHE=5;
const projektKette=new Map<string,Promise<void>>();
async function nacheinander<T>(project:string,fn:()=>Promise<T>):Promise<T>{
 const vor=projektKette.get(project)??Promise.resolve();
 let frei:()=>void=()=>undefined;
 const meins=new Promise<void>(r=>{frei=r;});
 const kette=vor.then(()=>meins);projektKette.set(project,kette);
 await vor;
 try{return await fn();}
 finally{frei();if(projektKette.get(project)===kette)projektKette.delete(project);}
}
/** Debug: Projekte mit laufender oder wartender Übernahme in diesem Prozess. */
export function reverseUebernahmeWarteschlange():string[]{return [...projektKette.keys()];}
function istBereichssperre(e:unknown):boolean {
 return e instanceof AssetUploadFehler&&e.code==='konflikt'&&String(e.message).includes(ASSET_BEREICHSSPERRE_MELDUNG);
}
export async function uebernehmeReverseAsset(a:Row,o:{db?:AssetUploadDb|Pool;konfiguration?:AssetKonfiguration;sperreWarteMs?:number}={}):Promise<Row>{
 const db=(o.db??getPool()) as unknown as AssetUploadDb,cfg=o.konfiguration??getAssetKonfiguration();
 const rid=String(a.reverse_id),project=String(a.project);
 if(a.ueberschreiben!==undefined&&typeof a.ueberschreiben!=='boolean')fail('werkzeug_fehler','parameter_ungueltig');
 const quelle=pfad(quellArg(a)),ziel=pfad(a.ziel_pfad);
 if(/@S[0-3](?:\/|$)/i.test(quelle))fail('keine_berechtigung','Nur Assets sind übernehmbar; neuen Code über files mit @ref-Marke schreiben.');
 const bindung=async(d:Pick<AssetUploadDb,'query'>,lock=false)=>{
  // P18-T109: zentrale Sichtbarkeit; Übernahme bleibt an Projektrecht und diesen Weg gebunden.
  if(!(await reverseEintragSichtbar(d,project,rid,lock)))fail('nicht_gebunden');
 };
 await bindung(db);
 const datei=await holeReverseAnsichtDatei(db,rid,quelle);
 if(!datei)fail('nicht_gefunden');
 const original=datei.id.startsWith('datei:');
 const source=original?(await db.query("SELECT id,art FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2",[rid,datei.id.slice(6)])).rows[0]:null;
 if(original&&source?.art!=='asset')fail('keine_berechtigung','Nur Assets sind übernehmbar, keine Binaries oder Dekompilate.');
 const warteMs=o.sperreWarteMs??150;
 return nacheinander(project,async()=>{
  // Zielprüfung erst in der Projekt-Reihe: ein vorher fertig gewordener Lauf ist hier sichtbar.
  const code=(await db.query('SELECT 1 FROM code_files WHERE project=$1 AND file_path=$2 LIMIT 1',[project,ziel])).rows;
  if(code.length)fail('ziel_belegt','Ziel ist eine Projektcodedatei.');
  const old=(await db.query('SELECT id,transport_revision,storage_kind FROM asset_files WHERE project=$1 AND file_path=$2',[project,ziel])).rows[0];
  if(old&&a.ueberschreiben!==true)fail('ziel_belegt',undefined,{vorhandene_revision:String(old.transport_revision??'0'),asset_id:String(old.id)});
  const q=await reverseAnsichtAdapter({db,konfiguration:cfg}).aufloesen({bereich:'reverse',ziel_ref:rid,id:datei.id,revision:datei.sha256});
  const hold='uebernahme:'+randomUUID();
  await q.halten(hold,new Date(Date.now()+cfg.speicher.timeoutMs*REVERSE_UEBERNAHME_SPERRE_VERSUCHE));
  const versuch=async(nr:number):Promise<Row>=>{
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),cfg.speicher.timeoutMs);timer.unref();
   try{
    const kern=new AssetUploadKern({db,konfiguration:cfg,quelle:'reverse',nachProjektPublikation:async(d,s,r)=>{
     await bindung(d,true);
     if((await d.query('SELECT 1 FROM code_files WHERE project=$1 AND file_path=$2 LIMIT 1',[project,ziel])).rows.length)fail('ziel_belegt');
     let assetId=datei.id.slice(6);
     if(original){
      await d.query('SELECT id FROM reverse_dateien WHERE id=$1 FOR UPDATE',[source!.id]);
      const existing=(await d.query('SELECT id FROM reverse_assets WHERE eintrag_id=$1 AND datei_id=$2 AND pfad=$3 AND sha256=$4 ORDER BY id LIMIT 1',[rid,source!.id,quelle,q.sha256])).rows[0];
      assetId=String(existing?.id??(await d.query('INSERT INTO reverse_assets(eintrag_id,datei_id,pfad,format,mime,sha256,groesse,storage_key,erzeugt_mit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[rid,source!.id,quelle,q.format,q.mimeType,q.sha256,q.groesse,datei.storage_key,'uebernahme-original'])).rows[0].id);
     }
     await d.query('UPDATE asset_files SET reverse_id=$2,reverse_quellpfad=$3,reverse_quellhash=$4 WHERE id=$1',[r.asset_id,rid,quelle,q.sha256]);
     await d.query("INSERT INTO reverse_uebernahmen(eintrag_id,reverse_asset_id,project,ziel_pfad,asset_id,asset_revision,von_agent,status,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,'fertig',$8)",[rid,assetId,project,s.logischer_pfad,r.asset_id,r.revision,String(a.agent_id),aktuelleAgentAkteurIdentityId(a.agent_id)]);
    }});
    const ctx={bereich:'projekt' as const,ziel_ref:project,host_id:'reverse-api'};
    // Jeder Versuch braucht eine eigene Sitzung: eine an der Bereichssperre gescheiterte Sitzung ist terminal ('fehler').
    const session=await kern.erstellen(ctx,{logischer_pfad:ziel,storage_kind:old?.storage_kind==='binaries'?'binaries':'assets',groesse:q.groesse,sha256:q.sha256,basis_revision:String(old?.transport_revision??'0'),idempotency_key:nr===1?hold:hold+':'+nr,mime_type:q.mimeType,format:q.format});
    // P22-T252: liegt am Ziel schon exakt dieser Inhalt, liefert erstellen die Sitzung bereits finalisiert (ohne Staging-Bytes).
    // Dann keine Teile senden: teil() meldete sonst offset_konflikt, und ueberschreiben:true endete als interner_fehler.
    const unveraendert=session.status==='finalisiert';
    if(!unveraendert){
    const stream=await q.lesen(controller.signal);
    try{
     let chunk=Buffer.alloc(0),offset=0;
     for await(const part of stream){
      chunk=Buffer.concat([chunk,Buffer.from(part)]);
      while(chunk.length>=cfg.speicher.chunkBytes){
       await kern.teil(ctx,session.id,offset,cfg.speicher.chunkBytes,[chunk.subarray(0,cfg.speicher.chunkBytes)]);
       offset+=cfg.speicher.chunkBytes;chunk=chunk.subarray(cfg.speicher.chunkBytes);
      }
     }
     if(chunk.length)await kern.teil(ctx,session.id,offset,chunk.length,[chunk]);
    }finally{stream.destroy();}
    }
    const r=await kern.finalisieren(ctx,session.id);
    // P22-T237: Uebernehmen legt ein PROJEKT-Asset in den Projekt-Share (ohne Daemon) -> Zustellstand Share->Projektordner
    // mitgeben, damit 'Daemon offline' bzw. 'Asset-Sync AUS' sichtbar ist. Nur mit Schalter asset_pc_zustellung, sonst unveraendert.
    const pc=r.asset_id?await pcZustellungFuerAsset(project,String(r.asset_id),{db}):null;
    return {status:'fertig',datei:quelle,ziel_pfad:ziel,asset_id:r.asset_id,revision:r.revision,sha256:q.sha256,reverse_id:rid,...(unveraendert?{unveraendert:true}:{}),...(nr>1?{versuche:nr}:{}),...(pc?{pc_zustellung:pc}:{})};
   }finally{clearTimeout(timer);controller.abort();}
  };
  try{
   for(let nr=1;;nr++){
    try{return await versuch(nr);}
    catch(e){
     if(!istBereichssperre(e))throw e;
     if(nr>=REVERSE_UEBERNAHME_SPERRE_VERSUCHE)fail('werkzeug_fehler','veroeffentlichung_gesperrt',{wiederholbar:true,versuche:nr,
      hinweis:'Eine andere Veröffentlichung im Projekt hält die Bereichssperre der Ablage; das Ziel ist frei. Später erneut übernehmen.'});
     await new Promise(r=>setTimeout(r,warteMs*nr+Math.floor(Math.random()*warteMs)));
    }
   }
  }catch(e){
   if(e instanceof AssetUploadFehler&&['revision_konflikt','konflikt','finalisierung_laeuft'].includes(e.code)){
    const row=(await db.query('SELECT transport_revision FROM asset_files WHERE project=$1 AND file_path=$2',[project,ziel])).rows[0];
    fail('ziel_belegt',e.code,{vorhandene_revision:String(row?.transport_revision??'0')});
   }
   throw e;
  }finally{await q.freigeben(hold);}
 });
}
