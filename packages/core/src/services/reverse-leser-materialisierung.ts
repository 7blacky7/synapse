/** P18-T42: unveränderliche Pakete und versionierte, gefencete Ergebnisse. */
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {reverseBigInt,reverseZahl,leseReverseEinstellwerte,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {leseReverseLeserSchalter,leseReverseLeserRevision,pruefeReverseLeserQuelle,type ReverseLeserRevision} from './reverse-leser-registry.js';
import {reverseEintragAktiv,leseReverseAssetRegistrierungSchalter,registriereReverseAssetBlock} from './reverse-asset-registrierung.js';
import {reverseLeserPfad,reverseLeserHash,reverseLeserKanonisch,ReverseLeserFehler,type ReverseLeserEreignis} from './reverse-leser-vertrag.js';
import {loeseReverseLeserNachher,mitReverseNachherLesesicht} from './reverse-leser-nachher.js';
type Db=Pick<PoolClient,'query'>;
type Objekt=Extract<ReverseLeserEreignis,{art:'objekt'}>;
function fail(code:string):never {throw new ReverseLeserFehler(code);}
export function reverseLeserRoot():string{
 const root=getAssetKonfiguration().speicher.reverseRoot;if(!root)fail('leser_speicher_fehlt');return root;
}
export async function reverseLeserDateipfad(root:string,key:string,s:ReverseEinstellSnapshot,create=false):Promise<string>{
 reverseLeserPfad(key,s);const base=path.resolve(root);if(await realpath(base)!==base)fail('leser_wurzel_symlink');
 let p=base;const parts=key.split('/');
 for(let i=0;i<parts.length;i++){
  p=path.join(p,parts[i]);
  if(create&&i<parts.length-1)try{await mkdir(p,{mode:0o755});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  try{const st=await lstat(p);
   if(st.isSymbolicLink()||i<parts.length-1&&!st.isDirectory()||i===parts.length-1&&(!st.isFile()||st.nlink!==1))fail('leser_pfad_ungueltig');
  }catch(e){if(!(create&&i===parts.length-1&&(e as NodeJS.ErrnoException).code==='ENOENT'))throw e;}
 }return p;
}
export async function pruefeReverseLeserDatei(root:string,key:string,sha:string,bytes:string,s:ReverseEinstellSnapshot){
 const p=await reverseLeserDateipfad(root,key,s),h=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const vor=await h.stat({bigint:true});if(!vor.isFile()||vor.nlink!==1n||String(vor.size)!==bytes)fail('leser_datei_laenge');
  const hash=createHash('sha256'),b=Buffer.alloc(reverseZahl(s,'lese_block_bytes'));let n=0n;
  const deadline=Date.now()+reverseZahl(s,'e_zeitlimit_s')*1000;
  for(;;){if(Date.now()>deadline)fail('leser_datei_zeitlimit');const r=await h.read(b,0,b.length,null);if(!r.bytesRead)break;
   n+=BigInt(r.bytesRead);if(n>BigInt(bytes))fail('leser_datei_veraendert');hash.update(b.subarray(0,r.bytesRead));}
  const nach=await h.stat({bigint:true});
  if(hash.digest('hex')!==sha||n!==vor.size||vor.mtimeNs!==nach.mtimeNs||vor.ctimeNs!==nach.ctimeNs)fail('leser_datei_hash');
 }finally{await h.close();}return p;
}
async function unveraenderlich(root:string,key:string,text:string,sha:string,s:ReverseEinstellSnapshot){
 const p=await reverseLeserDateipfad(root,key,s,true);let h;
 try{h=await open(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o444);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await pruefePaketDatei(root,key,sha,String(Buffer.byteLength(text)),s);return;}
 try{await h.writeFile(text);await h.chmod(0o444);await h.sync();}finally{await h.close();}
 await pruefePaketDatei(root,key,sha,String(Buffer.byteLength(text)),s);
}
async function pruefePaketDatei(root:string,key:string,sha:string,bytes:string,s:ReverseEinstellSnapshot){
 const p=await reverseLeserDateipfad(root,key,s),st=await lstat(p);
 if((st.mode&0o004)===0)fail('leser_paket_container_nicht_lesbar');
 if((st.mode&0o7777)!==0o444)fail('leser_paket_modus_ungueltig');
 return pruefeReverseLeserDatei(root,key,sha,bytes,s);
}
async function pruefePaketOrdner(p:string,versiegelt=false){
 const st=await lstat(p);
 if(!st.isDirectory()||st.isSymbolicLink())fail('leser_pfad_ungueltig');
 if((st.mode&0o005)!==0o005)fail('leser_paket_container_nicht_lesbar');
 if(versiegelt&&(st.mode&0o7777)!==0o555)fail('leser_paket_modus_ungueltig');
}
async function syncPaketOrdner(p:string,mode:number){
 const h=await open(p,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{await h.chmod(mode);await h.sync();}finally{await h.close();}
}
/** Neue eigene Ordner explizit lesbar; vorhandene Snapshotrechte werden niemals repariert. */
async function neuePaketOrdner(root:string,key:string,s:ReverseEinstellSnapshot,neu:Set<string>,versiegelt=false){
 try{await mkdir(path.join(root,key),{mode:0o755});neu.add(path.join(root,key));await syncPaketOrdner(path.join(root,key),0o755);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 await pruefePaketOrdner(path.join(root,key),versiegelt&&!neu.has(path.join(root,key)));
}
/** Nur eigene Paketdateien; neue Revisionen nutzen denselben Nachher-Resolver wie Runtime/Registry. */
export async function stelleReverseLeserPaketBereit(db:Db,r:ReverseLeserRevision,s:ReverseEinstellSnapshot,root=reverseLeserRoot()){
 const storage_key='.intern/leser/'+r.id+'/'+r.paket_sha256,base=r.quelle.manifest.pfad.replace(/[^/]+$/,'');
 const nachher=r.quelle.quellvertrag==='files-nachher-v1';
 const anfrage=nachher?pruefeReverseLeserQuelle(r.quelle.anfrage,s):null;
 if(nachher&&(anfrage!.project!==r.quelle.project||anfrage!.manifest_pfad!==r.quelle.manifest.pfad
  ||anfrage!.dateien.length!==r.quelle.dateien.length))fail('leser_quellbeleg_ungueltig');
 const erlaubt=new Set([r.quelle.manifest.pfad,...(anfrage?.dateien.map(q=>base+q.pfad)??r.quelle.dateien.map(q=>base+q.pfad))]);
 const missing:typeof r.quelle.dateien=[];const ordner=new Set<string>([storage_key]);
 for(const q of r.quelle.dateien){
  reverseLeserPfad(q.pfad,s);
  const relative=q.pfad.split('/').slice(0,-1);let key=storage_key;
  for(const part of relative){key+='/'+part;ordner.add(key);}
  if(anfrage){
   const d=anfrage.dateien.find(d=>d.pfad===q.pfad);
   if(!d||d.version_id!==q.version_id||d.sha256!==q.sha256||d.bytes!==q.bytes)fail('leser_quellbeleg_ungueltig');
  }
 }
 // Bestehende eigene Verzeichnisse zuerst pruefen, damit fehlendes Search-Recht klar erkennbar bleibt.
 let vorhandeneWurzel=false;
 for(const key of ordner)try{await pruefePaketOrdner(path.join(root,key),nachher);if(key===storage_key)vorhandeneWurzel=true;}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 for(const q of r.quelle.dateien)try{await pruefePaketDatei(root,storage_key+'/'+q.pfad,q.sha256,q.bytes,s);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;missing.push(q);}
 if(nachher&&vorhandeneWurzel&&missing.length)fail('leser_paket_unvollstaendig');
 const daten=await mitReverseNachherLesesicht(db,s,async c=>{
  const result=new Map<string,string>();let bytes=BigInt(r.quelle.manifest.bytes);
  for(const q of r.quelle.dateien){
   bytes+=BigInt(q.bytes);if(bytes>reverseBigInt(s,'leser_paket_bytes'))fail('leser_paket_zu_gross');
   if(!missing.includes(q))continue;
   if(nachher){
    const v=await loeseReverseLeserNachher(c,r.quelle.project,{...q,pfad:base+q.pfad},erlaubt,reverseBigInt(s,'leser_paket_bytes')-(bytes-BigInt(q.bytes)),s);
    result.set(q.pfad,v.content);
   }else{
    // Ausschliesslich alte, bereits gespeicherte Revisionen behalten ihren Vorher-Snapshot.
    const row=(await c.query({text:'SELECT content FROM file_versions WHERE id=$1 AND project=$2 AND file_path=$3 AND content_hash=$4 AND octet_length(content)=$5::bigint',
     values:[q.version_id,r.quelle.project,base+q.pfad,q.sha256,q.bytes],query_timeout:reverseZahl(s,'leser_statement_timeout_ms')} as import('pg').QueryConfig)).rows[0];
    if(typeof row?.content!=='string'||reverseLeserHash(row.content)!==q.sha256)fail('leser_quellversion_veraendert');
    result.set(q.pfad,row.content);
   }
  }return result;
 });
 if(missing.length){
  // Nur Eltern des eigenen storage_key vorbereiten, keine Projektpfade oder alten Snapshots chmodden.
  await reverseLeserDateipfad(root,'.intern/leser/'+r.id+'/.paket-pfadprobe',s,true);
  const neu=new Set<string>();
  for(const key of ordner)await neuePaketOrdner(root,key,s,neu,nachher);
  for(const q of missing)await unveraenderlich(root,storage_key+'/'+q.pfad,daten.get(q.pfad)!,q.sha256,s);
  for(const p of [...neu].sort((a,b)=>b.length-a.length))await syncPaketOrdner(p,0o555);
 }
 for(const key of ordner)await pruefePaketOrdner(path.join(root,key),nachher);
 for(const q of r.quelle.dateien)await pruefePaketDatei(root,storage_key+'/'+q.pfad,q.sha256,q.bytes,s);
 return {storage_key,paket_bytes:r.quelle.dateien.reduce((n,q)=>n+BigInt(q.bytes),0n).toString()};
}
export function reverseLeserTxBudget(s:ReverseEinstellSnapshot,zeilen:number,params:unknown):void{
 if(zeilen>reverseZahl(s,'e_uebernahme_block_zeilen')||
 BigInt(Buffer.byteLength(reverseLeserKanonisch(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))fail('leser_materialisierung_tx_zu_gross');
}
export async function reverseLeserTx<T>(pool:Pool,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();try{await c.query('BEGIN');const r=await run(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
async function* records(root:string,key:string,s:ReverseEinstellSnapshot):AsyncGenerator<Record<string,unknown>>{
 const h=await open(await reverseLeserDateipfad(root,key,s),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{let rest:Buffer=Buffer.alloc(0);const b=Buffer.alloc(reverseZahl(s,'lese_block_bytes'));
  for(;;){const r=await h.read(b,0,b.length,null);if(!r.bytesRead)break;rest=Buffer.concat([rest,b.subarray(0,r.bytesRead)]);
   let n;while((n=rest.indexOf(10))>=0){if(n>reverseZahl(s,'e_metadaten_record_bytes'))fail('leser_record_zu_gross');
    const line=rest.subarray(0,n);rest=rest.subarray(n+1);yield JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}
   if(rest.length>reverseZahl(s,'e_metadaten_record_bytes'))fail('leser_record_zu_gross');
  }if(rest.length)fail('leser_manifest_unvollstaendig');
 }finally{await h.close();}
}
async function kopiere(root:string,srcKey:string,dstKey:string,sha:string,bytes:string,s:ReverseEinstellSnapshot){
 const src=await pruefeReverseLeserDatei(root,srcKey,sha,bytes,s),dst=await reverseLeserDateipfad(root,dstKey,s,true);
 let out;try{out=await open(dst,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o444);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await pruefeReverseLeserDatei(root,dstKey,sha,bytes,s);return;}
 const input=await open(src,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const b=Buffer.alloc(reverseZahl(s,'lese_block_bytes'));for(;;){const r=await input.read(b,0,b.length,null);if(!r.bytesRead)break;
   let pos=0;while(pos<r.bytesRead){const w=await out.write(b,pos,r.bytesRead-pos);if(!w.bytesWritten)fail('leser_kopie_kurz');pos+=w.bytesWritten;}}
  await out.sync();
 }finally{await input.close();await out.close();}
 await pruefeReverseLeserDatei(root,dstKey,sha,bytes,s);
}
export interface ReverseLeserMaterialisierung {lauf_id:string;root?:string;fence:(c:PoolClient)=>Promise<void>}
/** Nur hostvalidierte reguläre Läufe. Jede TX hat eigenen Lease-Fence; Tests bleiben isoliert.
 * Ein atomarer Laufzeiger veröffentlicht erst nach dem letzten Block. Keine DELETEs. */
export async function materialisiereReverseLeser(pool:Pool,o:ReverseLeserMaterialisierung){
 const l=(await pool.query('SELECT l.*,d.medium_id::text FROM reverse_leser_laeufe l JOIN reverse_dateien d ON d.id=l.datei_id AND d.eintrag_id=l.eintrag_id WHERE l.id=$1',[o.lauf_id])).rows[0];
 if(!l||l.diagnose?.testmodus===true||l.diagnose?.host_validiert!==true||!['fertig','teilweise'].includes(l.status)||!l.manifest_key)fail('leser_materialisierung_nicht_freigegeben');
 const s=await leseReverseEinstellwerte({eintrag_id:l.eintrag_id},pool),r=await leseReverseLeserRevision(pool,l.leser_id),root=o.root??reverseLeserRoot();
 if(s.letzter_fehler)fail(s.letzter_fehler);
 if(s.revision!==l.einstellungen_revision)fail('leser_einstellungen_geaendert');
 if(!r)fail('leser_revision_fehlt');
 if(l.diagnose?.publiziert===true)return {status:'publiziert',lauf_id:l.id,idempotent:true};
 async function guard(c:PoolClient){
  await o.fence(c);
  // Der für Ergebnisarbeit verwendete Snapshot s bleibt gepinnt; aktuelle Werte nur vergleichen.
  const aktuell=await leseReverseEinstellwerte({eintrag_id:l.eintrag_id},c);
  if(aktuell.letzter_fehler)fail(aktuell.letzter_fehler);
  if(aktuell.revision!==l.einstellungen_revision)fail('leser_einstellungen_geaendert');
  const sch=await leseReverseLeserSchalter(c);
  if(!sch.aktiv||sch.letzter_fehler)fail('leser_aus');
  if(!await reverseEintragAktiv(c,l.eintrag_id))fail('leser_eintrag_inaktiv');
  if((await c.query('SELECT status FROM reverse_leser_zustaende WHERE leser_id=$1 FOR SHARE',[r!.id])).rows[0]?.status!=='aktiv')fail('leser_revision_inaktiv');
 }
 const key=String(l.manifest_key),dir=key.slice(0,key.lastIndexOf('/')+1);
 const stat=await lstat(await reverseLeserDateipfad(root,key,s));
 await pruefeReverseLeserDatei(root,key,l.manifest_sha256,String(stat.size),s);
 async function* objekte():AsyncGenerator<Objekt>{
  for await(const v of records(root,key,s)){
   if(v.art==='objekt')yield v as unknown as Objekt;
   else if(v.art==='schritt'){const seg=v.segment as {pfad:string;sha256:string;bytes:string};
    await pruefeReverseLeserDatei(root,dir+reverseLeserPfad(seg.pfad,s),seg.sha256,seg.bytes,s);
    for await(const w of records(root,dir+seg.pfad,s)){if(w.art!=='objekt')fail('leser_segment_record');yield w as unknown as Objekt;}
   }
  }
 }
 let position=0n;
 for await(const v of objekte()){
  position++;if(position<=BigInt(l.position))continue;reverseLeserPfad(v.objektpfad,s);
  const identity=reverseLeserHash(reverseLeserKanonisch([l.eintrag_id,l.quell_sha256,r.id,r.code_sha256,v.objektpfad,'original']));
  const ext=v.datei?path.posix.extname(v.datei.pfad):'.json',pfad='leser/'+r.id+'/'+l.quell_sha256+'/'+identity+ext;
  const storage=v.datei?l.eintrag_id+'/entpackt/'+pfad:null,bytes=v.datei?.bytes??'0';
  if(BigInt(bytes)>reverseBigInt(s,'max_datei_bytes'))fail('leser_datei_zu_gross');
  // Reservierung unter Eintragssperre: vergangene Generationen/Rückhalt + laufende Kopien zählen mit.
  if(v.datei)await reverseLeserTx(pool,async c=>{
   await guard(c);await c.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[l.eintrag_id]);
   const used=(await c.query(`SELECT (COALESCE((SELECT sum(groesse) FROM reverse_dateien WHERE eintrag_id=$1),0)
    +COALESCE((SELECT sum(ausgabe_bytes+COALESCE((diagnose->>'kopie_reserviert')::bigint,0)) FROM reverse_leser_laeufe WHERE eintrag_id=$1),0))::text AS bytes`,[l.eintrag_id])).rows[0];
   const pending=(await c.query('SELECT diagnose FROM reverse_leser_laeufe WHERE id=$1 FOR UPDATE',[l.id])).rows[0].diagnose;
   if(BigInt(used.bytes)+(pending.kopie_identitaet===identity?0n:BigInt(bytes))>reverseBigInt(s,'eintrag_bytes'))fail('leser_eintrag_bytes');
   reverseLeserTxBudget(s,1,[l.id,bytes,identity]);
   await c.query("UPDATE reverse_leser_laeufe SET diagnose=diagnose||jsonb_build_object('kopie_reserviert',$2::text,'kopie_identitaet',$3::text) WHERE id=$1",[l.id,bytes,identity]);
  });
  if(v.datei)await kopiere(root,dir+reverseLeserPfad(v.datei.pfad,s),storage!,v.datei.sha256,bytes,s);
  const meta:Record<string,unknown>={...v.metadaten,quell_sha256:l.quell_sha256,objektpfad:v.objektpfad,
   reverse_leser:{identitaet:identity,revision:r.id,code_sha256:r.code_sha256,variante:'original'}};
  delete meta.code_klassifikation; // T95 ist einziger Klassifikationsschreiber.
  const fp=[l.eintrag_id,l.medium_id,String(l.datei_id),pfad,v.datei?.sha256??null,bytes,v.typ==='text'?'text':'asset',storage,meta,r.name,r.version];
  const op=[l.eintrag_id,v.typ,v.objektpfad,{...meta,ursprung:'leser',reverse_leser:{...meta.reverse_leser as Record<string,unknown>,lauf_id:l.id,generation:l.generation,datei_id:String(l.datei_id)}},v.quelle.offset,v.quelle.laenge];
  reverseLeserTxBudget(s,3,[fp,op,[l.id,String(position),l.eintrag_id]]);
  await reverseLeserTx(pool,async c=>{
   await guard(c);await c.query('SELECT id FROM reverse_leser_laeufe WHERE id=$1 FOR UPDATE',[l.id]);
   const d=(await c.query(`INSERT INTO reverse_dateien(eintrag_id,medium_id,eltern_id,pfad,sha256,groesse,art,storage_key,metadaten,leser_plugin,leser_version,status,entpackt_mit)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'fertig',$10)
    ON CONFLICT(eintrag_id,pfad) DO NOTHING RETURNING id::text`,fp)).rows[0];
   const datei=d??(await c.query('SELECT id::text,sha256,storage_key,metadaten FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2 FOR UPDATE',[l.eintrag_id,pfad])).rows[0];
   if(!d&&(datei?.sha256!==(v.datei?.sha256??null)||datei?.storage_key!==storage||reverseLeserKanonisch(datei.metadaten)!==reverseLeserKanonisch(meta)))fail('leser_idempotenz_konflikt');
   // Die erst jetzt bekannte PG-Datei-ID zählt ebenfalls in das gesamte TX-Bytebudget.
   // Ein Grenztreffer rollt auch den vorangegangenen Datei-Insert zurück.
   reverseLeserTxBudget(s,3,[fp,[datei.id,...op],[l.id,String(position),l.eintrag_id]]);
   if(!(await c.query("SELECT 1 FROM reverse_objekte WHERE datei_id=$1 AND eintrag_id=$2 AND data#>>'{reverse_leser,lauf_id}'=$3",[datei.id,l.eintrag_id,l.id])).rows.length)
    await c.query('INSERT INTO reverse_objekte(datei_id,eintrag_id,ordnung,kind,name,data,byte_offset,byte_length) VALUES($1,$2,0,$3,$4,$5::jsonb,$6::bigint,$7::bigint)',[datei.id,...op]);
   await c.query("UPDATE reverse_leser_laeufe SET position=GREATEST(position,$2::bigint),diagnose=diagnose-'kopie_reserviert'-'kopie_identitaet' WHERE id=$1 AND eintrag_id=$3",[l.id,String(position),l.eintrag_id]);
  });
 }
 if(position!==BigInt(l.ausgabe_anzahl))fail('leser_objektzahl_widerspruch');
 const assetSch=await leseReverseAssetRegistrierungSchalter(pool);
 if(!assetSch.aktiv){
  await reverseLeserTx(pool,async c=>{await guard(c);reverseLeserTxBudget(s,1,[l.id]);
   await c.query(`UPDATE reverse_leser_laeufe SET diagnose=diagnose||'{"materialisierung":"staged","abhaengigkeit":"reverse_asset_registrierung"}'::jsonb WHERE id=$1`,[l.id]);});
  return {status:'staged',abhaengigkeit:'reverse_asset_registrierung'};
 }
 let nach='0';
 for(;;){
  const ds=(await pool.query("SELECT d.id::text FROM reverse_dateien d WHERE d.eintrag_id=$1 AND EXISTS(SELECT 1 FROM reverse_objekte o WHERE o.datei_id=d.id AND o.eintrag_id=d.eintrag_id AND o.data#>>'{reverse_leser,lauf_id}'=$2) AND d.id>$3::bigint ORDER BY d.id LIMIT $4",
   [l.eintrag_id,l.id,nach,reverseZahl(s,'seiten_limit')])).rows;if(!ds.length)break;
  for(const d of ds){await reverseLeserTx(pool,async c=>{
   await guard(c);reverseLeserTxBudget(s,2,[l.eintrag_id,d.id]);
   await registriereReverseAssetBlock(c,{eintrag_id:l.eintrag_id,einstellungen:s,cursor:{version:1,eintrag_id:l.eintrag_id,medium_id:null,nach_id:String(BigInt(d.id)-1n),bis_id:d.id}});
  });nach=d.id;}
 }
 nach='0';
 for(;;){
  const old=(await pool.query(`SELECT a.id::text FROM reverse_assets a JOIN reverse_dateien d ON d.id=a.datei_id AND d.eintrag_id=a.eintrag_id
   JOIN reverse_leser r ON r.id=d.metadaten#>>'{reverse_leser,revision}'
   WHERE a.eintrag_id=$1 AND d.eltern_id=$2 AND r.name=$3 AND a.aktuell
   AND NOT EXISTS(SELECT 1 FROM reverse_objekte o WHERE o.datei_id=d.id AND o.eintrag_id=d.eintrag_id AND o.data#>>'{reverse_leser,lauf_id}'=$4)
   AND a.id>$5::bigint ORDER BY a.id LIMIT $6`,
   [l.eintrag_id,l.datei_id,r.name,l.id,nach,reverseZahl(s,'seiten_limit')])).rows;if(!old.length)break;
  for(const a of old){await reverseLeserTx(pool,async c=>{await guard(c);reverseLeserTxBudget(s,1,[a.id,l.eintrag_id]);
   await c.query('UPDATE reverse_assets SET aktuell=false WHERE id=$1 AND eintrag_id=$2',[a.id,l.eintrag_id]);});nach=a.id;}
 }
 await reverseLeserTx(pool,async c=>{
  await guard(c);const sch=await leseReverseAssetRegistrierungSchalter(c);if(!sch.aktiv||sch.letzter_fehler)fail('leser_asset_registrierung_aus');
  reverseLeserTxBudget(s,1,[l.id,l.eintrag_id]);
  await c.query("UPDATE reverse_leser_laeufe SET diagnose=diagnose||jsonb_build_object('publiziert',true,'publiziert_am',clock_timestamp()::text,'materialisierung','publiziert') WHERE id=$1 AND eintrag_id=$2",[l.id,l.eintrag_id]);
 });return {status:'publiziert',lauf_id:l.id,objekte:String(position)};
}
