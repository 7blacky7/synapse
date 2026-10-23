/** P18-T27/RV17: API-only, keine Rohkopie und kein code_files-Schreibweg. */
import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetUploadKern,AssetUploadFehler,type AssetUploadDb} from './asset-upload.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {holeReverseAnsichtDatei,reverseAnsichtAdapter} from './reverse-ansicht-adapter.js';
import {reverseEintragSichtbar} from './reverse-sichtbarkeit.js';
type Row=Record<string,unknown>;
export class ReverseUebernahmeFehler extends Error {
 constructor(readonly code:'keine_berechtigung'|'nicht_gebunden'|'nicht_gefunden'|'ziel_belegt'|'pfad_gefahr'|'werkzeug_fehler',readonly detail?:string,readonly extra:Row={}){super(code);}
}
function fail(code:ReverseUebernahmeFehler['code'],detail?:string,extra:Row={}):never{throw new ReverseUebernahmeFehler(code,detail,extra);}
function pfad(v:unknown):string {
 if(typeof v!=='string'||!v||normalisiereSpeicherPfad(v)!==v)fail('pfad_gefahr');
 return v;
}
export async function uebernehmeReverseAsset(a:Row,o:{db?:AssetUploadDb|Pool;konfiguration?:AssetKonfiguration}={}):Promise<Row>{
 const db=(o.db??getPool()) as unknown as AssetUploadDb,cfg=o.konfiguration??getAssetKonfiguration();
 const rid=String(a.reverse_id),project=String(a.project);
 if(a.ueberschreiben!==undefined&&typeof a.ueberschreiben!=='boolean')fail('werkzeug_fehler','parameter_ungueltig');
 const quelle=pfad(a.file_path),ziel=pfad(a.ziel_pfad);
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
 const code=(await db.query('SELECT 1 FROM code_files WHERE project=$1 AND file_path=$2 LIMIT 1',[project,ziel])).rows;
 if(code.length)fail('ziel_belegt','Ziel ist eine Projektcodedatei.');
 const old=(await db.query('SELECT id,transport_revision,storage_kind FROM asset_files WHERE project=$1 AND file_path=$2',[project,ziel])).rows[0];
 if(old&&a.ueberschreiben!==true)fail('ziel_belegt',undefined,{vorhandene_revision:String(old.transport_revision??'0'),asset_id:String(old.id)});
 const q=await reverseAnsichtAdapter({db,konfiguration:cfg}).aufloesen({bereich:'reverse',ziel_ref:rid,id:datei.id,revision:datei.sha256});
 const hold='uebernahme:'+randomUUID(),controller=new AbortController();
 await q.halten(hold,new Date(Date.now()+cfg.speicher.timeoutMs));
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
  const session=await kern.erstellen(ctx,{logischer_pfad:ziel,storage_kind:old?.storage_kind==='binaries'?'binaries':'assets',groesse:q.groesse,sha256:q.sha256,basis_revision:String(old?.transport_revision??'0'),idempotency_key:hold,mime_type:q.mimeType,format:q.format});
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
  const r=await kern.finalisieren(ctx,session.id);
  return {status:'fertig',datei:quelle,ziel_pfad:ziel,asset_id:r.asset_id,revision:r.revision,sha256:q.sha256,reverse_id:rid};
 }catch(e){
  if(e instanceof AssetUploadFehler&&['revision_konflikt','konflikt','finalisierung_laeuft'].includes(e.code)){
   const row=(await db.query('SELECT transport_revision FROM asset_files WHERE project=$1 AND file_path=$2',[project,ziel])).rows[0];
   fail('ziel_belegt',e.code,{vorhandene_revision:String(row?.transport_revision??'0')});
  }
  throw e;
 }finally{clearTimeout(timer);controller.abort();await q.freigeben(hold);}
}
