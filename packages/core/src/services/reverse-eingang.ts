/** RV5/RV33: globale Reverse-Aufnahme über A6; nur Metadaten in PostgreSQL. */
import {createHash,randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {ladeReverseEingangKonfiguration} from '../config/reverse-eingang.js';
import type {ReverseEingangKonfiguration} from '../config/reverse-eingang.js';
import {AssetSpeicher,erzeugeReverseId,normalisiereSpeicherPfad} from './asset-speicher.js';
import {AssetUploadKern,AssetUploadFehler} from './asset-upload.js';
import type {AssetUploadDb,AssetUploadKontext,AssetUploadFinalisierer} from './asset-upload.js';
import {registriereShareScannerBereich} from './share-scanner.js';
import type {ShareScanDatei} from './share-scanner.js';
import {reverseGruppieren,reverseOrdnerFingerabdruck,reverseArchivMagic} from './reverse-gruppierung.js';
import type {ReverseFundDatei,ReverseGruppenDatei} from './reverse-gruppierung.js';
type Row=Record<string,unknown>;
/** RV6: Abmeldung einer lokal verschwundenen Bibliotheksdatei; das Original bleibt in der Bibliothek. */
export interface ReverseAbmeldung {rel_pfad:string;status:'geloescht_lokal'|'fehlt';}
const fail=(c:string,s:number,m:string):never=>{throw new AssetUploadFehler(c,s,m);};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class ReverseEingang {
 readonly upload:AssetUploadKern; readonly speicher:AssetSpeicher;
 private readonly db:AssetUploadDb; private readonly cfg:AssetKonfiguration;private readonly regeln:ReverseEingangKonfiguration;
 constructor(o:{db?:AssetUploadDb;konfiguration?:AssetKonfiguration;regeln?:ReverseEingangKonfiguration;speicher?:AssetSpeicher}={}){
  this.db=o.db??getPool() as unknown as AssetUploadDb;this.cfg=o.konfiguration??getAssetKonfiguration();this.regeln=o.regeln??ladeReverseEingangKonfiguration();
  this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg,layout:a=>a.bereich==='reverse'?a.ziel_ref+'/original/dateien/'+a.logischer_pfad:undefined});
  this.upload=new AssetUploadKern({db:this.db,konfiguration:this.cfg,speicher:this.speicher});
  this.upload.registriereFinalisierer('reverse',this.finalisierer());
 }
 private gate(host:string){if(!this.cfg.reverse.aktiv)fail('deaktiviert',503,'Reverse ist deaktiviert.');if(typeof host!=='string'||!host||host.length>200)fail('host_ungueltig',403,'Hostbindung fehlt.');}
 private async tx<T>(fn:(db:AssetUploadDb)=>Promise<T>,snapshot=false):Promise<T>{
  const db=await this.db.connect();try{await db.query(snapshot?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
   await db.query("SELECT set_config('statement_timeout',$1,true)",[String(this.cfg.speicher.timeoutMs)]);
   const r=await fn(db);await db.query('COMMIT');return r;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.release();}
 }
 private ctx(row:Row):AssetUploadKontext{return {bereich:'reverse',ziel_ref:String(row.ziel_ref),host_id:String(row.host_id)};}
 private finalisierer():AssetUploadFinalisierer {
  return {
   formatErlaubt:()=>true,
   belegung:async(c,db)=>{
    const r=(await db.query("SELECT COALESCE(sum(groesse),0)::text AS bytes,count(*)::int AS n FROM reverse_eingang_bytes WHERE ziel_ref=$1 AND status='ready'",[c.ziel_ref])).rows[0];
    return {bytes:String(r.bytes),n:Number(r.n)};
   },
   basis:async(c,s)=>{
    const b=(await this.db.query('SELECT * FROM reverse_eingang_bytes WHERE sha256=$1',[s.sha256])).rows[0];
    if(!b||b.upload_id!==s.id||b.host_id!==c.host_id||b.ziel_ref!==c.ziel_ref||b.logischer_pfad!==s.logischer_pfad||Number(b.groesse)!==s.groesse)fail('scope_verboten',403,'Upload nicht im Reverse-Eingang reserviert.');
    return {sha256:null};
   },
   vorbereiten:async(c,s,op,db)=>{
    const r=await db.query("UPDATE reverse_eingang_bytes SET status='prepared' WHERE sha256=$1 AND upload_id=$2 AND host_id=$3 AND ziel_ref=$4 AND status='offen' RETURNING sha256",[s.sha256,s.id,c.host_id,c.ziel_ref]);
    if(!r.rows.length)fail('revision_konflikt',409,'Reverse-Reservierung verändert.');
   },
   rollback:async(_c,s,_op,db)=>{await db.query("UPDATE reverse_eingang_bytes SET status='offen',upload_id=NULL,generation=generation+1 WHERE sha256=$1 AND upload_id=$2 AND status='prepared'",[s.sha256,s.id]);},
   commit:async(c,s,op,db)=>{
    const r=await db.query("UPDATE reverse_eingang_bytes SET status='ready',storage_key=$3 WHERE sha256=$1 AND upload_id=$2 AND status='prepared' RETURNING sha256",[s.sha256,s.id,op.storage_key]);
    if(!r.rows.length)fail('revision_konflikt',409,'Reverse-Prepare fehlt.');
    return {asset_id:s.sha256,revision:'1',storage_key:op.storage_key};
   },
  };
 }
 async fundstellen(host:string,input:ReverseFundDatei[],quelle:'tray'|'unraid_eingang'='tray'){
  this.gate(host);
  if(!Array.isArray(input)||!input.length||input.length>this.regeln.maxBatch)fail('eingang_ungueltig',400,'Dateiliste überschreitet Batchgrenze.');
  const paths=new Set<string>();
  const files=input.map(f=>{
   if(!f||typeof f!=='object'||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.groesse)||f.groesse<0||f.groesse>this.cfg.reverse.maxDateiBytes)fail('eingang_ungueltig',400,'Dateimetadaten oder Größe ungültig.');
   if(f.host!==undefined&&f.host!==host)fail('host_ungueltig',403,'Host weicht von Authentifizierung ab.');
   const p=normalisiereSpeicherPfad(f.rel_pfad);if(p.length>4096||paths.has(p))fail('eingang_ungueltig',400,'Doppelter/zu langer Pfad.');paths.add(p);
   if(f.mtime!==undefined&&(typeof f.mtime!=='string'||!Number.isFinite(Date.parse(f.mtime))))fail('eingang_ungueltig',400,'mtime muss ISO-Datum sein.');
   return {rel_pfad:p,groesse:f.groesse,sha256:f.sha256,mtime:f.mtime};
  });
  const rids=new Set<string>();
  await this.tx(async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtext('reverse-gruppierung'))");
   for(const group of reverseGruppieren(files,this.regeln)){
    const groupFiles=group.medien.flatMap(m=>m.dateien),rootKey=digest([host,quelle,group.wurzel||groupFiles[0].rel_pfad]);
    const known=(await db.query("SELECT d.* FROM reverse_eingang_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id WHERE d.host_id=$1 AND d.rel_pfad=ANY($2::text[]) AND e.status<>'archiviert' ORDER BY d.id DESC",[host,groupFiles.map(f=>f.rel_pfad)])).rows;
    const matches=groupFiles.map(f=>known.find(d=>d.rel_pfad===f.rel_pfad&&d.sha256===f.sha256));
    if(matches.every(Boolean)){for(const d of matches)rids.add(String(d!.eintrag_id));continue;}
    let e=(await db.query("SELECT * FROM reverse_eintraege WHERE (eingang_schluessel=$1 OR gruppierung=$1) AND status<>'archiviert' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[rootKey])).rows[0];
    const previousEntry=e;
    if(e){
     const old=(await db.query('SELECT rel_pfad,sha256 FROM reverse_eingang_dateien WHERE eintrag_id=$1',[e.id])).rows;
     if(groupFiles.every(f=>old.some(r=>r.rel_pfad===f.rel_pfad&&r.sha256===f.sha256))){rids.add(String(e.id));continue;}
    }
    const key=e&&e.status!=='vorschlag'?digest([rootKey,e.id,reverseOrdnerFingerabdruck(groupFiles,group.wurzel)]):e?String(e.eingang_schluessel):rootKey;
    if(key!==rootKey)e=(await db.query('SELECT * FROM reverse_eintraege WHERE eingang_schluessel=$1 FOR UPDATE',[key])).rows[0];
    const rid=e?String(e.id):await erzeugeReverseId(group.titel,key,async(id,k)=>{
     const r=await db.query("INSERT INTO reverse_eintraege(id,titel,eingang_schluessel,erstellt_von,analyse_policy) VALUES($1,$2,$3,$4,'{\"automatisch\":true,\"bis_schicht\":\"S3\"}'::jsonb) ON CONFLICT DO NOTHING RETURNING id",[id,group.titel,k,host]);
     if(r.rows.length)return 'neu';return (await db.query('SELECT eingang_schluessel FROM reverse_eintraege WHERE id=$1',[id])).rows[0]?.eingang_schluessel===k?'gleich':'belegt';
    });
    rids.add(rid);
    await db.query('UPDATE reverse_eintraege SET gruppierung=$2 WHERE id=$1',[rid,rootKey]);
    if(previousEntry&&previousEntry.id!==rid){
     await db.query(`INSERT INTO reverse_eingang_dateien(host_id,rel_pfad,sha256,quelle,groesse,mtime,eintrag_id,original_name)
      SELECT host_id,rel_pfad,sha256,quelle,groesse,mtime,$2,original_name FROM reverse_eingang_dateien
      WHERE eintrag_id=$1 AND NOT(rel_pfad=ANY($3::text[])) ON CONFLICT DO NOTHING`,[previousEntry.id,rid,groupFiles.map(f=>f.rel_pfad)]);
    }
    for(const f of groupFiles){
     const previous=(await db.query('SELECT eintrag_id FROM reverse_eingang_dateien WHERE host_id=$1 AND rel_pfad=$2 AND sha256=$3 AND eintrag_id=$4',[host,f.rel_pfad,f.sha256,rid])).rows[0];
     if(previous){rids.add(String(previous.eintrag_id));continue;}
     await db.query('DELETE FROM reverse_eingang_dateien WHERE eintrag_id=$1 AND rel_pfad=$2 AND sha256<>$3',[rid,f.rel_pfad,f.sha256]);
     const quota=(await db.query('SELECT COALESCE(sum(groesse),0)::text AS bytes,count(*)::int AS n FROM reverse_eingang_dateien WHERE eintrag_id=$1',[rid])).rows[0];
     if(BigInt(String(quota.bytes))+BigInt(f.groesse)>BigInt(this.cfg.reverse.maxProjektBytes)||Number(quota.n)>=this.cfg.reverse.maxProjektDateien)fail('quote',413,'Reverse-Eintragsquote überschritten.');
     const logical=f.sha256+'/'+path.posix.basename(f.rel_pfad);
     await db.query("INSERT INTO reverse_eingang_bytes(sha256,groesse,ziel_ref,logischer_pfad,host_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[f.sha256,f.groesse,rid,logical,host]);
     const b=(await db.query('SELECT groesse FROM reverse_eingang_bytes WHERE sha256=$1',[f.sha256])).rows[0];
     if(Number(b.groesse)!==f.groesse)fail('hash_konflikt',409,'Gleicher Hash mit anderer Größe.');
     await db.query('INSERT INTO reverse_eingang_dateien(host_id,rel_pfad,sha256,quelle,groesse,mtime,eintrag_id,original_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[host,f.rel_pfad,f.sha256,quelle,f.groesse,f.mtime??null,rid,group.wurzel?f.rel_pfad.slice(group.wurzel.length+1):f.rel_pfad]);
    }
   }
  });
  // RV6: Wiedersehen hebt Lösch-/Fehlmarke und ausgeblendeten Hinweis dieser Fundstellen auf.
  await this.db.query("UPDATE reverse_fundstellen SET status='gesehen',hinweis_ausgeblendet_at=NULL,zuletzt_gesehen=clock_timestamp() WHERE quelle=$1 AND host_id=$2 AND rel_pfad=ANY($3::text[]) AND (status<>'gesehen' OR hinweis_ausgeblendet_at IS NOT NULL)",[quelle,host,files.map(f=>f.rel_pfad)]);
  for(const sha of new Set(files.map(f=>f.sha256)))await this.bytesErkannt(sha);
  for(const rid of rids)await this.aktualisieren(rid);
  const results:Row[]=[];
  for(const f of files){
   const b=(await this.db.query('SELECT b.*,d.eintrag_id FROM reverse_eingang_bytes b JOIN reverse_eingang_dateien d ON d.sha256=b.sha256 WHERE d.host_id=$1 AND d.rel_pfad=$2 AND d.sha256=$3 AND EXISTS(SELECT 1 FROM reverse_eintraege e WHERE e.id=d.eintrag_id AND e.status<>\'archiviert\') ORDER BY d.id DESC LIMIT 1',[host,f.rel_pfad,f.sha256])).rows[0];
   if(b.status==='ready'){results.push({rel_pfad:f.rel_pfad,status:'bekannt',reverse_id:b.eintrag_id});continue;}
   if(b.host_id!==host){results.push({rel_pfad:f.rel_pfad,status:'ignoriert',grund:'identische_bytes_upload_laeuft',reverse_id:b.eintrag_id});continue;}
   if(b.upload_id){
    const old=(await this.db.query('SELECT status,publish_operation FROM asset_upload_sitzungen WHERE id=$1',[b.upload_id])).rows[0];
    if(old?.status==='fehler'&&!old.publish_operation){
     const reset=(await this.db.query("UPDATE reverse_eingang_bytes SET upload_id=NULL,generation=generation+1 WHERE sha256=$1 AND upload_id=$2 AND status='offen' RETURNING generation",[b.sha256,b.upload_id])).rows[0];
     if(reset){b.generation=reset.generation;b.upload_id=null;}
    }else if(old&&['offen','laeuft'].includes(String(old.status))){
     await this.db.query("UPDATE asset_upload_sitzungen SET lease_bis=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND host_id=$2 AND bereich='reverse' AND status IN('offen','laeuft') AND publish_operation IS NULL",[b.upload_id,host,this.cfg.speicher.timeoutMs]);
    }
   }
   const s=await this.upload.erstellen(this.ctx(b),{logischer_pfad:String(b.logischer_pfad),storage_kind:'binaries',groesse:f.groesse,sha256:f.sha256,basis_revision:'0',format:'reverse-original',idempotency_key:'reverse:'+f.sha256+':'+String(b.generation)});
   await this.db.query("UPDATE reverse_eingang_bytes SET upload_id=$2 WHERE sha256=$1 AND status='offen' AND (upload_id IS NULL OR upload_id=$2)",[f.sha256,s.id]);
   results.push({rel_pfad:f.rel_pfad,status:'upload_noetig',upload_id:s.id,ziel_ref:s.ziel_ref,offset:s.offset,lease_bis:s.lease_bis,reverse_id:b.eintrag_id});
  }
  return {dateien:results,reverse_ids:[...rids]};
 }
 /** RV6: Transferbudgets und Katalog für den Bibliotheks-Watcher; nie Serverpfade oder Speicherschlüssel. */
 syncOptionen(host:string){
  this.gate(host);
  return {host,chunkBytes:this.cfg.speicher.chunkBytes,timeoutMs:this.cfg.speicher.timeoutMs,retryMs:this.cfg.sync.retryIntervallMs,scanMs:this.cfg.sync.scanIntervallMs,
   maxDateiBytes:this.cfg.reverse.maxDateiBytes,parallelTransfers:this.cfg.speicher.parallelTransfers,maxBatch:this.regeln.maxBatch,stabilMs:this.regeln.stabilMs,
   loesch_verhalten:this.regeln.loeschVerhalten,endungen:{images:[...this.regeln.imageEndungen],companions:this.regeln.companions.map(r=>({...r}))},erlaubt_alle_dateien:true};
 }
 private eingabePfade<T extends {rel_pfad:string}>(input:T[]):T[]{
  if(!Array.isArray(input)||!input.length||input.length>this.regeln.maxBatch)fail('eingang_ungueltig',400,'Dateiliste überschreitet Batchgrenze.');
  const seen=new Set<string>();
  return input.map(f=>{
   if(!f||typeof f!=='object')fail('eingang_ungueltig',400,'Eintrag ungültig.');
   const p=normalisiereSpeicherPfad(f.rel_pfad);if(p.length>4096||seen.has(p))fail('eingang_ungueltig',400,'Doppelter/zu langer Pfad.');seen.add(p);
   return {...f,rel_pfad:p};
  });
 }
 /** RV6: setzt reverse_fundstellen.status für lokal gelöschte/verschobene Dateien. Keine Byte-Löschung. */
 async abmelden(host:string,input:ReverseAbmeldung[],quelle:'tray'='tray'){
  this.gate(host);
  const files=this.eingabePfade(input);
  for(const f of files)if(f.status!=='geloescht_lokal'&&f.status!=='fehlt')fail('eingang_ungueltig',400,'status geloescht_lokal oder fehlt erwartet.');
  const results:Row[]=[];
  await this.tx(async db=>{
   for(const f of files){
    const set=await db.query('UPDATE reverse_fundstellen SET status=$4,zuletzt_gesehen=clock_timestamp() WHERE quelle=$1 AND host_id=$2 AND rel_pfad=$3 RETURNING id',[quelle,host,f.rel_pfad,f.status]);
    if(set.rows.length){results.push({rel_pfad:f.rel_pfad,status:f.status,ergebnis:'gesetzt'});continue;}
    const d=(await db.query('SELECT sha256,groesse,mtime FROM reverse_eingang_dateien WHERE host_id=$1 AND rel_pfad=$2 AND quelle=$3 ORDER BY id DESC LIMIT 1',[host,f.rel_pfad,quelle])).rows[0];
    if(!d){results.push({rel_pfad:f.rel_pfad,status:f.status,ergebnis:'unbekannt'});continue;}
    await db.query(`INSERT INTO reverse_fundstellen(quelle,host_id,rel_pfad,sha256,groesse,mtime,status) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(quelle,host_id,rel_pfad) DO UPDATE SET status=EXCLUDED.status,zuletzt_gesehen=clock_timestamp()`,[quelle,host,f.rel_pfad,d.sha256,d.groesse,d.mtime,f.status]);
    results.push({rel_pfad:f.rel_pfad,status:f.status,ergebnis:'gesetzt'});
   }
  });
  return {dateien:results};
 }
 /** RV6: Lösch-/Fehlhinweis einer eigenen Fundstelle aus- bzw. wieder einblenden. */
 async hinweis(host:string,relPfad:string,ausblenden:boolean,quelle:'tray'='tray'){
  this.gate(host);
  if(typeof ausblenden!=='boolean')fail('eingang_ungueltig',400,'ausblenden (boolean) erforderlich.');
  const p=normalisiereSpeicherPfad(relPfad);
  const r=(await this.db.query('UPDATE reverse_fundstellen SET hinweis_ausgeblendet_at=CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END WHERE quelle=$1 AND host_id=$2 AND rel_pfad=$3 RETURNING status',[quelle,host,p,ausblenden])).rows[0];
  if(!r)fail('fundstelle_unbekannt',404,'Keine eigene Fundstelle unter diesem Pfad.');
  return {rel_pfad:p,lokal:String(r.status),hinweis_ausgeblendet:ausblenden};
 }
 /** RV6: Original einer eigenen Fundstelle zum Zurückholen; nur bestätigte Bytes, optional ab offset. */
 async original(host:string,relPfad:string,offset=0,quelle:'tray'='tray'){
  this.gate(host);
  const p=normalisiereSpeicherPfad(relPfad);
  const b=(await this.db.query(`SELECT b.* FROM reverse_eingang_dateien d JOIN reverse_eingang_bytes b USING(sha256)
   WHERE d.host_id=$1 AND d.rel_pfad=$2 AND d.quelle=$3 ORDER BY d.id DESC LIMIT 1`,[host,p,quelle])).rows[0];
  if(!b)fail('fundstelle_unbekannt',404,'Keine eigene Fundstelle unter diesem Pfad.');
  if(b.status!=='ready'||!b.storage_key)fail('nicht_gesichert',404,'Original ist noch nicht gesichert.');
  const groesse=Number(b.groesse);
  if(!Number.isSafeInteger(offset)||offset<0||offset>groesse)fail('range_ungueltig',416,'offset außerhalb des Originals.');
  const stream=await this.speicher.readStorageStream({bereich:'reverse',ziel_ref:String(b.ziel_ref),storage_kind:'binaries',logischer_pfad:String(b.logischer_pfad)},String(b.storage_key),offset,groesse-offset);
  return {stream,sha256:String(b.sha256),groesse,offset,laenge:groesse-offset};
 }
 async direkt(datei:ShareScanDatei):Promise<boolean>{
  const result=await this.fundstellen('unraid_eingang',[{rel_pfad:datei.pfad,sha256:datei.sha256,groesse:datei.groesse}],'unraid_eingang');
  const r=result.dateien[0];if(r.status==='bekannt')return true;if(r.status!=='upload_noetig')return false;
  const c:AssetUploadKontext={bereich:'reverse',ziel_ref:String(r.ziel_ref),host_id:'unraid_eingang'},s=await this.upload.status(c,String(r.upload_id));
  const stage=await this.speicher.stageReverseDirekt({bereich:'reverse',ziel_ref:c.ziel_ref,storage_kind:'binaries',logischer_pfad:s.logischer_pfad},datei.pfad,s.id,{groesse:s.groesse,sha256:s.sha256});
  await this.upload.finalisierenStaging(c,s.id,stage);await this.finalisieren(c,s.id);return true;
 }
 /** Serverintern: der Betreiber/Recovery-Dienst muss physischen Stillstand belegen. */
 async recoveryDirekt(id:string,istVerwaist:()=>Promise<boolean>){
  const b=(await this.db.query("SELECT b.*,d.rel_pfad FROM reverse_eingang_bytes b JOIN reverse_eingang_dateien d USING(sha256) WHERE b.upload_id=$1 AND b.host_id='unraid_eingang' AND d.quelle='unraid_eingang' ORDER BY d.id LIMIT 1",[id])).rows[0];
  if(!b)fail('scope_verboten',403,'Keine Direktübernahme für diesen Auftrag.');
  const c=this.ctx(b);this.gate(c.host_id);
  if(!await istVerwaist())fail('recovery_unbestaetigt',409,'Physischer Stillstand nicht belegt.');
  if(b.status==='ready')return this.finalisieren(c,id);
  const renewed=await this.db.query("UPDATE asset_upload_sitzungen SET lease_bis=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1 AND bereich='reverse' AND host_id='unraid_eingang' AND status IN('offen','laeuft') AND publish_operation IS NULL RETURNING id",[id,this.cfg.speicher.timeoutMs]);
  if(!renewed.rows.length)fail('recovery_unbestaetigt',409,'Vorbereitete Publikation benötigt den A6-PG/FS-Recoveryentscheid.');
  const s=await this.upload.status(c,id),stage=await this.speicher.recoveryReverseDirekt({bereich:'reverse',ziel_ref:c.ziel_ref,storage_kind:'binaries',logischer_pfad:s.logischer_pfad},String(b.rel_pfad),id,{sha256:s.sha256,groesse:s.groesse},istVerwaist);
  await this.upload.finalisierenStaging(c,id,stage);return this.finalisieren(c,id);
 }
 registriereScanner():()=>void{
  return registriereShareScannerBereich('reverse',{
   wurzeln:async()=>{
    if(!this.cfg.speicher.reverseRoot)return [];
    await this.speicher.reverseDirektBereich();
    return [{id:'reverse-direkt',pfad:path.join(this.cfg.speicher.reverseRoot,'_direkt')}];
   },datei:d=>this.direkt(d)
  });
 }
 async finalisieren(ctx:AssetUploadKontext,id:string){
  this.gate(ctx.host_id);const s=await this.upload.finalisieren(ctx,id);
  await this.bytesErkannt(s.sha256);
  const rids=(await this.db.query('SELECT DISTINCT eintrag_id FROM reverse_eingang_dateien WHERE sha256=$1',[s.sha256])).rows;
  for(const r of rids)await this.aktualisieren(String(r.eintrag_id));
  return s;
 }
 private async bytesErkannt(sha:string){
  const b=(await this.db.query("SELECT * FROM reverse_eingang_bytes WHERE sha256=$1 AND status='ready'",[sha])).rows[0];if(!b||b.erkannt)return;
  const max=Math.min(Number(b.groesse),this.regeln.maxDescriptorBytes),chunks:Buffer[]=[];
  const stream=await this.speicher.readStorageStream({bereich:'reverse',ziel_ref:String(b.ziel_ref),storage_kind:'binaries',logischer_pfad:String(b.logischer_pfad)},String(b.storage_key),0,max);
  for await(const chunk of stream)chunks.push(Buffer.from(chunk));
  const data=Buffer.concat(chunks),referenzen:string[]=[];
  if(Number(b.groesse)<=this.regeln.maxDescriptorBytes){
   const re=/^[ \t]*(?:FILE|DATAFILE|AUDIOFILE)[ \t]+(?:"([^"]+)"|([^\s]+))/gmi;let m:RegExpExecArray|null;
   while((m=re.exec(data.toString('utf8'))))referenzen.push(normalisiereSpeicherPfad(m[1]??m[2]));
  }
  await this.db.query("UPDATE reverse_eingang_bytes SET format=$2,referenzen=$3::jsonb,erkannt=true WHERE sha256=$1 AND status='ready'",[sha,reverseArchivMagic(data),JSON.stringify(referenzen)]);
 }
 async aktualisieren(rid:string){
  await this.tx(async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtext('reverse-gruppierung'))");
   const e=(await db.query('SELECT * FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[rid])).rows[0];if(!e||e.status!=='vorschlag')return;
   // Root-Descriptor kann nach seinen Binärdateien eintreffen: Vorschläge nach echten Referenzen verbinden.
   const descriptors=(await db.query('SELECT d.host_id,d.rel_pfad,b.referenzen FROM reverse_eingang_dateien d JOIN reverse_eingang_bytes b USING(sha256) WHERE d.eintrag_id=$1 AND b.erkannt',[rid])).rows;
   for(const descriptor of descriptors){
    const rule=this.regeln.companions.find(r=>r.endungen.includes(path.posix.extname(String(descriptor.rel_pfad)).slice(1).toLowerCase()));
    if(!rule)continue;
    const sourcePath=String(descriptor.rel_pfad),dir=path.posix.dirname(sourcePath),base=sourcePath.slice(0,-path.posix.extname(sourcePath).length);
    const refs=[...rule.pflicht.map(ext=>base+'.'+ext),...rule.optional.map(ext=>base+'.'+ext),
     ...(rule.referenzen?(descriptor.referenzen as string[]??[]).map(p=>(dir==='.'?'':dir+'/')+normalisiereSpeicherPfad(p)):[])];
    const candidates=(await db.query("SELECT d.*,e.status AS entry_status FROM reverse_eingang_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id WHERE d.host_id=$1 AND d.rel_pfad=ANY($2::text[]) AND d.eintrag_id<>$3 ORDER BY d.id DESC",[descriptor.host_id,refs,rid])).rows;
    const seen=new Set<string>();
    for(const c of candidates){
     if(seen.has(String(c.rel_pfad)))continue;seen.add(String(c.rel_pfad));
     await db.query(`INSERT INTO reverse_eingang_dateien(host_id,rel_pfad,sha256,quelle,groesse,mtime,eintrag_id,original_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[c.host_id,c.rel_pfad,c.sha256,c.quelle,c.groesse,c.mtime,rid,dir==='.'?c.rel_pfad:String(c.rel_pfad).slice(dir.length+1)]);
     if(c.entry_status==='vorschlag'){
      await db.query('DELETE FROM reverse_eingang_dateien WHERE id=$1',[c.id]);
      await db.query("UPDATE reverse_eintraege e SET status='archiviert',archiviert_at=clock_timestamp() WHERE e.id=$1 AND NOT EXISTS(SELECT 1 FROM reverse_eingang_dateien d WHERE d.eintrag_id=e.id)",[c.eintrag_id]);
     }
    }
   }
   const rows=(await db.query('SELECT d.*,b.status AS bytes_status,b.storage_key,b.upload_id,b.format,b.referenzen,b.erkannt FROM reverse_eingang_dateien d JOIN reverse_eingang_bytes b USING(sha256) WHERE d.eintrag_id=$1 ORDER BY d.rel_pfad',[rid])).rows;
   if(!rows.length)return;
   const stand=digest(rows.map(r=>[r.id,r.sha256,r.bytes_status,r.format,r.referenzen]));
   if(e.eingang_stand===stand)return;
   const fs:ReverseGruppenDatei[]=rows.map(r=>({rel_pfad:String(r.rel_pfad),sha256:String(r.sha256),groesse:Number(r.groesse),archiv_format:r.format as string|null,referenzen:r.erkannt?r.referenzen as string[]:undefined}));
   const groups=reverseGruppieren(fs,this.regeln),media=groups.flatMap(g=>g.medien);
   // Proposals have no analysis/history. Rebuild only their owned file references.
   if((await db.query('SELECT 1 FROM reverse_auftraege WHERE eintrag_id=$1 LIMIT 1',[rid])).rows.length)return;
   await db.query('UPDATE reverse_eingang_dateien SET medium_id=NULL,medien_datei_id=NULL WHERE eintrag_id=$1',[rid]);
   await db.query('DELETE FROM reverse_medien_dateien WHERE medium_id IN (SELECT id FROM reverse_medien WHERE eintrag_id=$1)',[rid]);
   await db.query('DELETE FROM reverse_medien WHERE eintrag_id=$1',[rid]);
   for(const [position,m] of media.entries()){
    const complete=!m.fehlend.length&&!groups.some(g=>g.case_kollisionen.length)&&m.dateien.every(f=>rows.find(r=>r.rel_pfad===f.rel_pfad)?.bytes_status==='ready');
    const suggestion={haupt:m.haupt,fehlende_dateien:m.fehlend,confidence:m.confidence,alternativen:m.alternativen,case_kollisionen:groups.flatMap(g=>g.case_kollisionen)};
    const mid=String((await db.query('INSERT INTO reverse_medien(eintrag_id,position,bezeichnung,art,satz_sha256,groesse,status,fehlercode,vorschlag) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id',[rid,position,m.bezeichnung,m.art,m.satz_sha256,m.dateien.reduce((a,f)=>a+f.groesse,0),complete?'vollstaendig':'unvollstaendig',m.fehlend.length?'beschaedigt':groups.some(g=>g.case_kollisionen.length)?'case_kollision':null,JSON.stringify(suggestion)])).rows[0].id);
    const items=m.dateien.map(f=>{const r=rows.find(r=>r.rel_pfad===f.rel_pfad)!;return {...r,rolle:f.rel_pfad===m.haupt||m.art==='ordner'?'haupt':'begleit'};});
    await db.query(`WITH x AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
      AS x(id bigint,host_id text,rel_pfad text,quelle text,original_name text,sha256 text,groesse bigint,mtime timestamptz,storage_key text,upload_id uuid,bytes_status text,rolle text)),
     neu AS (INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key,upload_id)
      SELECT $1,rolle,original_name,sha256,groesse,storage_key,upload_id FROM x WHERE bytes_status='ready' RETURNING id,original_name),
     fund AS (INSERT INTO reverse_fundstellen(quelle,host_id,rel_pfad,sha256,groesse,mtime,medien_datei_id)
      SELECT x.quelle,x.host_id,x.rel_pfad,x.sha256,x.groesse,x.mtime,n.id FROM x JOIN neu n USING(original_name)
      ON CONFLICT(quelle,host_id,rel_pfad) DO UPDATE SET sha256=EXCLUDED.sha256,groesse=EXCLUDED.groesse,mtime=EXCLUDED.mtime,
       medien_datei_id=EXCLUDED.medien_datei_id,zuletzt_gesehen=clock_timestamp())
     UPDATE reverse_eingang_dateien d SET medium_id=$1,medien_datei_id=n.id,rolle=x.rolle FROM x LEFT JOIN neu n USING(original_name) WHERE d.id=x.id`,[mid,JSON.stringify(items)]);

   }
   const fp=digest(media.map(m=>[m.art,m.satz_sha256]));
   const duplicate=(await db.query("SELECT id FROM reverse_eintraege WHERE status='bestaetigt' AND fingerabdruck=$1",[fp])).rows[0];
   await db.query('UPDATE reverse_eintraege SET fingerabdruck=$2,beschreibung=$3,eingang_stand=$4,updated_at=clock_timestamp() WHERE id=$1',[rid,fp,duplicate?'bereits vorhanden '+String(duplicate.id):null,stand]);
   await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[rid]);
  });
 }
 async status(host:string,o:{cursor?:string;limit?:number}={}){
  this.gate(host);const limit=o.limit??Math.min(200,this.cfg.reverse.maxErgebnisse);
  if(!Number.isSafeInteger(limit)||limit<1||limit>this.cfg.reverse.maxErgebnisse)fail('limit_ungueltig',400,'Seitenlimit ungültig.');
  let id:string,last='0';
  if(o.cursor){
   let c:Row;try{if(o.cursor.length>2048)throw new Error();c=JSON.parse(Buffer.from(o.cursor,'base64url').toString());if(!c||typeof c!=='object'||Array.isArray(c))throw new Error();}catch{return fail('cursor_ungueltig',400,'Cursor ungültig.');}
   if(c.art!=='reverse-fundstellen'||c.host!==host||typeof c.id!=='string'||!UUID.test(c.id)||typeof c.last!=='string'||!/^\d+$/.test(c.last))fail('cursor_ungueltig',400,'Cursor gehört anderem Host/Vertrag.');
   id=String(c.id);last=String(c.last);
  }else{
   id=randomUUID();await this.tx(async db=>{
    await db.query("DELETE FROM reverse_fund_snapshots WHERE host_id=$1 AND lease_bis<clock_timestamp()",[host]);
    await db.query("INSERT INTO reverse_fund_snapshots(id,host_id,lease_bis) VALUES($1,$2,clock_timestamp()+$3*interval '1 millisecond')",[id,host,this.cfg.speicher.timeoutMs]);
    await db.query(`INSERT INTO reverse_fund_snapshot_zeilen(snapshot_id,id,daten)
     SELECT $1,d.id,jsonb_build_object('id',d.id::text,'rel_pfad',d.rel_pfad,'sha256',d.sha256,'reverse_id',d.eintrag_id,
      'status',CASE WHEN m.fehlercode IS NOT NULL OR layer.fehlercode IS NOT NULL OR layer.status='fehler' OR upload.status='fehler' THEN 'fehler' WHEN layer.status IN ('fertig','teilweise') THEN CASE WHEN layer.schicht='E' THEN 'entpackt' ELSE layer.schicht END WHEN layer.schicht='E' THEN 'wartet' WHEN layer.schicht IS NOT NULL THEN 'entpackt' WHEN b.status='ready' THEN 'hochgeladen' ELSE 'erkannt' END,
      'fehlercode',COALESCE(layer.fehlercode,m.fehlercode,CASE WHEN upload.status='fehler' THEN 'upload_fehler' WHEN layer.status='fehler' THEN 'werkzeug_fehler' END),
      'medium_id',m.id::text,'art',m.art,'vorschlag',m.vorschlag,'fortschritt',progress.daten,
      'lokal',COALESCE(fs.status,'gesehen'),'hinweis_ausgeblendet',(fs.hinweis_ausgeblendet_at IS NOT NULL),'gesichert',(b.status='ready'))
     FROM reverse_eingang_dateien d JOIN reverse_eingang_bytes b USING(sha256) LEFT JOIN reverse_medien m ON m.id=d.medium_id
     LEFT JOIN asset_upload_sitzungen upload ON upload.id=b.upload_id
     LEFT JOIN reverse_fundstellen fs ON fs.quelle=d.quelle AND fs.host_id=d.host_id AND fs.rel_pfad=d.rel_pfad
     LEFT JOIN (SELECT md.medium_id,jsonb_build_object('dateien_gesamt',count(*),'dateien_fertig',count(*) FILTER(WHERE mb.status='ready'),
       'bytes_gesamt',COALESCE(sum(md.groesse),0)::text,
       'bytes_erledigt',COALESCE(sum(CASE WHEN mb.status='ready' THEN md.groesse ELSE LEAST(md.groesse,COALESCE(mu.bestaetigte_bytes,0)) END),0)::text) AS daten
      FROM reverse_eingang_dateien md JOIN reverse_eingang_bytes mb USING(sha256) LEFT JOIN asset_upload_sitzungen mu ON mu.id=mb.upload_id
      WHERE md.host_id=$2 GROUP BY md.medium_id) progress ON progress.medium_id=m.id
     LEFT JOIN LATERAL(SELECT s.schicht,s.status,s.fehlercode FROM reverse_schichten s LEFT JOIN reverse_dateien f ON f.id=s.datei_id
       WHERE s.aktuell AND (s.medium_id=m.id OR f.medium_id=m.id) ORDER BY s.created_at DESC,s.id DESC LIMIT 1) layer ON true WHERE d.host_id=$2`,[id,host]);
   },true);
  }
  const r=await this.db.query("SELECT id FROM reverse_fund_snapshots WHERE id=$1 AND host_id=$2 AND lease_bis>clock_timestamp()",[id,host]);
  if(!r.rows.length)fail('manifest_abgelaufen',410,'Statussnapshot abgelaufen, ohne Cursor neu beginnen.');
  const rows=(await this.db.query('SELECT id::text,daten FROM reverse_fund_snapshot_zeilen WHERE snapshot_id=$1 AND id>$2 ORDER BY id LIMIT $3',[id,last,limit+1])).rows;
  const more=rows.length>limit,page=rows.slice(0,limit);
  return {dateien:page.map(r=>r.daten),vollstaendig:!more,cursor:more?Buffer.from(JSON.stringify({art:'reverse-fundstellen',host,id,last:page.at(-1)!.id})).toString('base64url'):null};
 }
}
/** RV33: kanonische Blobadresse nur nach Prüfung der fachlichen Dateizugehörigkeit. */
export async function reverseDateiSpeicherAdresse(db:Pick<AssetUploadDb,'query'>,rid:string,dateiId:string){
 const row=(await db.query(`SELECT f.*,b.ziel_ref AS bytes_ziel,b.logischer_pfad AS bytes_pfad FROM reverse_dateien f
  LEFT JOIN reverse_eingang_bytes b ON b.sha256=f.sha256 AND b.storage_key=f.storage_key AND b.status='ready'
  WHERE f.id=$1 AND f.eintrag_id=$2`,[dateiId,rid])).rows[0];
 if(!row?.storage_key)fail('datei_fehlt',404,'Datei hat keine bestätigte Speicherreferenz.');
 return {adresse:{bereich:'reverse' as const,ziel_ref:String(row.bytes_ziel??rid),storage_kind:'binaries' as const,logischer_pfad:String(row.bytes_pfad??row.pfad)},
  storage_key:String(row.storage_key),sha256:String(row.sha256),groesse:Number(row.groesse)};
}
/** RV33: Ordner wurden bereits dateiweise geprüft; E wird ohne Extraktion katalogisiert. */
export async function katalogisiereReverseOrdner(db:Pick<AssetUploadDb,'query'>,rid:string):Promise<void>{
 const ms=(await db.query("SELECT id,position,satz_sha256,status FROM reverse_medien WHERE eintrag_id=$1 AND art='ordner'",[rid])).rows;
 const collision=(await db.query(`SELECT f.original_name FROM reverse_medien_dateien f JOIN reverse_medien m ON m.id=f.medium_id
  WHERE m.eintrag_id=$1 AND m.art='ordner' GROUP BY f.original_name HAVING count(*)>1 LIMIT 1`,[rid])).rows[0];
 if(collision)fail('pfad_konflikt',409,'Ordner-Medien enthalten denselben relativen Pfad: '+String(collision.original_name));
 const ids=ms.filter(m=>m.status==='vollstaendig').map(m=>m.id);
 await db.query(`INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,entpackt_mit,metadaten)
  SELECT $1,f.medium_id,f.original_name,f.sha256,f.groesse,'sonstig',f.storage_key,'ordner-upload','{"E":"uebersprungen"}'::jsonb
  FROM reverse_medien_dateien f WHERE f.medium_id=ANY($2::bigint[])
  ON CONFLICT(eintrag_id,pfad) DO NOTHING`,[rid,ids]);
 await db.query(`INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,werkzeug,beendet_at)
  SELECT id,'E',satz_sha256,'uebersprungen','ordner-upload',clock_timestamp() FROM reverse_medien WHERE id=ANY($1::bigint[])
  ON CONFLICT DO NOTHING`,[ids]);
}
let singleton:ReverseEingang|undefined;
export function reverseEingang():ReverseEingang{return singleton??=new ReverseEingang();}
