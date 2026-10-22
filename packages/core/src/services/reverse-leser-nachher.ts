/** P18-T102: EIN lesender Nachher-Resolver fuer Reverse-Runtime und Leserpakete. */
import {Pool,type PoolClient} from 'pg';
import {reverseLeserPfad,reverseLeserHash,ReverseLeserFehler} from './reverse-leser-vertrag.js';
import {reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
export type ReverseNachherDb=Pick<PoolClient,'query'>;
export interface ReverseNachherErwartung {pfad:string;version_id:string;sha256:string;bytes:string}
export interface ReverseNachherBeleg extends ReverseNachherErwartung {
 quell_pfad:string;anker_batch_id:string|null;anker_aktion:string|null;
 gelesen_aus:'naechste_version'|'aktueller_stand';snapshot_version_id:string|null;snapshot_batch_id:string|null;
 code_file_id:string|null;code_updated_at:string|null;
}
export class ReverseNachherFehler extends ReverseLeserFehler {
 constructor(readonly grund:string){super('leser_quelle_'+grund);}
}
function fail(grund:string):never{throw new ReverseNachherFehler(grund);}
/** Nur ein echter Pool bekommt einen neuen Client/TX. Gehaltene Clients bleiben im Aufruferkontext. */
export async function mitReverseNachherLesesicht<T>(db:ReverseNachherDb,s:ReverseEinstellSnapshot,body:(c:ReverseNachherDb)=>Promise<T>):Promise<T>{
 if(!(db instanceof Pool))return body(db);
 const c=await db.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(reverseZahl(s,'leser_statement_timeout_ms'))]);
  const r=await body(c);await c.query('COMMIT');return r;
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
/** Keine eigene TX, kein reconnect, kein FS/Diff-Fallback. Scope kommt aus dem autorisierten Reverse-Aufrufer. */
export async function loeseReverseLeserNachher(c:ReverseNachherDb,project:string,d:ReverseNachherErwartung,
 erlaubtePfade:ReadonlySet<string>,restBytes:bigint,s:ReverseEinstellSnapshot):Promise<{content:string;beleg:ReverseNachherBeleg}>{
 if(typeof project!=='string'||!project||project.length>reverseZahl(s,'parameter_text_zeichen'))fail('nachher_anker_fehlt');
 const pfad=reverseLeserPfad(d.pfad,s);
 if(!erlaubtePfade.has(pfad))fail('nachher_pfad_nicht_freigegeben');
 if(typeof d.version_id!=='string'||!(/^[1-9][0-9]*$/).test(d.version_id)||BigInt(d.version_id)>9223372036854775807n
  ||typeof d.sha256!=='string'||!(/^[a-f0-9]{64}$/).test(d.sha256)
  ||typeof d.bytes!=='string'||!(/^(0|[1-9][0-9]*)$/).test(d.bytes))fail('nachher_erwartung_ungueltig');
 if(BigInt(d.bytes)>restBytes)fail('paket_zu_gross');
 const row=(await c.query({text:`SELECT v.id::text AS version_id,v.batch_id::text AS anker_batch_id,v.edit_action AS anker_aktion,
  n.id::text AS snapshot_version_id,n.batch_id::text AS snapshot_batch_id,
  CASE WHEN n.id IS NOT NULL THEN 'naechste_version' ELSE 'aktueller_stand' END AS gelesen_aus,
  CASE WHEN n.id IS NULL THEN cf.id::text END AS code_file_id,
  CASE WHEN n.id IS NULL THEN cf.updated_at::text END AS code_updated_at,
  CASE WHEN n.id IS NOT NULL THEN n.content_hash ELSE cf.content_hash END AS content_hash,
  octet_length(CASE WHEN n.id IS NOT NULL THEN n.content ELSE cf.content END)::text AS bytes,
  CASE WHEN octet_length(CASE WHEN n.id IS NOT NULL THEN n.content ELSE cf.content END)<=$4::bigint
   THEN CASE WHEN n.id IS NOT NULL THEN n.content ELSE cf.content END END AS content,
  EXISTS(SELECT 1 FROM file_versions z WHERE n.batch_id IS NOT NULL AND z.project=v.project AND z.file_path=v.file_path
   AND z.batch_id=n.batch_id AND z.id>v.id AND z.content_hash IS DISTINCT FROM n.content_hash) AS batch_konflikt
  FROM file_versions v
  LEFT JOIN LATERAL(SELECT id,batch_id,content,content_hash FROM file_versions n
   WHERE n.project=v.project AND n.file_path=v.file_path AND n.id>v.id
    AND (v.batch_id IS NULL OR n.batch_id IS DISTINCT FROM v.batch_id) ORDER BY n.id LIMIT 1)n ON TRUE
  LEFT JOIN code_files cf ON n.id IS NULL AND cf.project=v.project AND cf.file_path=v.file_path AND cf.deleted_at IS NULL
  WHERE v.id=$1 AND v.project=$2 AND v.file_path=$3`,
  values:[d.version_id,project,pfad,String(restBytes)],query_timeout:reverseZahl(s,'leser_statement_timeout_ms')} as import('pg').QueryConfig)).rows[0];
 if(!row||row.anker_aktion?.startsWith('ignore_'))fail('nachher_anker_fehlt');
 if(row.batch_konflikt)fail('nachher_batch_konflikt');
 if(row.bytes==null)fail('nachher_fehlt');
 if(typeof row.content!=='string')fail('paket_zu_gross');
 const bytes=String(Buffer.byteLength(row.content)),sha256=reverseLeserHash(row.content);
 if(bytes!==row.bytes||sha256!==row.content_hash)fail('quellhash');
 if(bytes!==d.bytes||sha256!==d.sha256)fail('nachher_geaendert');
 return {content:row.content,beleg:{...d,quell_pfad:pfad,anker_batch_id:row.anker_batch_id,anker_aktion:row.anker_aktion,
  gelesen_aus:row.gelesen_aus,snapshot_version_id:row.snapshot_version_id,snapshot_batch_id:row.snapshot_batch_id,
  code_file_id:row.code_file_id,code_updated_at:row.code_updated_at,sha256,bytes}};
}
