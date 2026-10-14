/**
 * P18-T26/RV16: Retentionhalter und Bindungsprüfung für Reverse-Ansichten (Anschluss an A14/A15).
 *
 * VERTRAG Reverse-Referenz im Ansicht-Dienst:
 *   {bereich:'reverse', ziel_ref:<reverse_eintraege.id>, id:<Adapter-ID>, revision:<sha256>, sha256:<sha256>}
 *   Die Quellrevision ist (eintrag_id, sha256); revision ist IMMER die sha256 der Bytes.
 * - Gehalten werden nur Metadaten in PG (reverse_ansicht_retention), nie Bytes. Originale bleiben unter
 *   SYNAPSE_REVERSE_ROOT; nichts wird ins Projekt kopiert.
 * - Der Reverse-Adapter (RV16) liefert in aufloesen() halten/freigeben über reverseAnsichtHalter().
 * - Cache-Bereinigung nur unter demselben PG-Fence (Advisory-Lock je Quelle), gehalten bis nach dem Unlink;
 *   halten() nimmt denselben Lock, eine neue Ansicht/ein neuer Link kann also nicht dazwischenrutschen.
 * - Bindung (User F5): nur aktive reverse_bindungen(project, eintrag_id) zählen; sha256 muss zu einer Datei
 *   oder einem Asset des Eintrags gehören.
 */
import {getPool} from '../db/client.js';
import type {AssetUploadDb} from './asset-upload.js';
import type {AssetAdresse} from './asset-speicher.js';
import {AssetAnsichtFehler} from './asset-ansicht-renderer.js';

const SHA_MUSTER=/^[a-f0-9]{64}$/;
const REF_MUSTER=/^[A-Za-z0-9_.:-]{1,200}$/;
const LOCK_SQL="SELECT pg_advisory_xact_lock(hashtext('reverse-ansicht:'||$1::text||':'||$2::text))";

/** widerruf_grund-Werte, die beim Linkabruf als 410 nicht_mehr_gebunden erscheinen. */
export const REVERSE_ANSICHT_WIDERRUF_GRUENDE:readonly string[]=['bindung_geloest','bindung_revision_falsch'];

export type ReverseBindungsErgebnis='ok'|'nicht_gebunden'|'revision_falsch';
export interface ReverseAnsichtHalter {
  halten:(refKey:string,bis:Date)=>Promise<void>;
  freigeben:(refKey:string)=>Promise<void>;
}
type Db=Pick<AssetUploadDb,'query'>;

async function shaImEintrag(db:Db,eintrag:string,sha:string):Promise<boolean>{
  const r=await db.query(
    'SELECT (EXISTS(SELECT 1 FROM reverse_dateien WHERE eintrag_id=$1 AND sha256=$2) OR '+
    'EXISTS(SELECT 1 FROM reverse_assets WHERE eintrag_id=$1 AND sha256=$2)) AS ok',[eintrag,sha]);
  return r.rows[0]?.ok===true;
}

/**
 * A15/A16: Ist der Reverse-Eintrag aktiv an das Projekt gebunden und gehört sha256 (falls angegeben) zum Eintrag?
 * Fail-closed: ungültige Eingaben ergeben nicht_gebunden.
 */
export async function pruefeReverseAnsichtBindung(db:Db,o:{projekt:unknown;eintrag_id:unknown;sha256?:unknown}):Promise<ReverseBindungsErgebnis>{
  if(typeof o.projekt!=='string'||!o.projekt||o.projekt.length>200||typeof o.eintrag_id!=='string'||!REF_MUSTER.test(o.eintrag_id))return 'nicht_gebunden';
  const gebunden=(await db.query('SELECT 1 FROM reverse_bindungen WHERE project=$1 AND eintrag_id=$2 AND geloest_at IS NULL LIMIT 1',
    [o.projekt,o.eintrag_id])).rows.length>0;
  if(!gebunden)return 'nicht_gebunden';
  if(o.sha256===undefined||o.sha256===null)return 'ok';
  if(typeof o.sha256!=='string'||!SHA_MUSTER.test(o.sha256))return 'revision_falsch';
  return (await shaImEintrag(db,o.eintrag_id,o.sha256))?'ok':'revision_falsch';
}

export class ReverseAnsichtRetention {
  private readonly db:AssetUploadDb;
  constructor(o:{db?:AssetUploadDb}={}){this.db=o.db??getPool() as unknown as AssetUploadDb;}
  private async tx<T>(fn:(db:AssetUploadDb)=>Promise<T>):Promise<T>{
    const db=await this.db.connect();
    try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}
    catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}
    finally{await db.release();}
  }

  /** Hält (eintrag_id, sha256) bis expires_at. Gleicher ref_key verlängert nur, fremder Scope wird abgewiesen. */
  async halten(e:{ref_key:string;eintrag_id:string;sha256:string;expires_at:Date}):Promise<void>{
    if(typeof e.ref_key!=='string'||!e.ref_key||e.ref_key.length>200||typeof e.eintrag_id!=='string'||!REF_MUSTER.test(e.eintrag_id)||
       typeof e.sha256!=='string'||!SHA_MUSTER.test(e.sha256)||!(e.expires_at instanceof Date)||!Number.isFinite(e.expires_at.getTime())){
      throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Ungültige Reverse-Retentionreferenz.');
    }
    await this.tx(async db=>{
      await db.query(LOCK_SQL,[e.eintrag_id,e.sha256]);
      const eintrag=(await db.query('SELECT 1 FROM reverse_eintraege WHERE id=$1 FOR SHARE',[e.eintrag_id])).rows[0];
      if(!eintrag)throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Reverse-Eintrag fehlt.');
      if(!await shaImEintrag(db,e.eintrag_id,e.sha256))throw new AssetAnsichtFehler('ansicht_revision_falsch','sha256 gehört nicht zum Reverse-Eintrag.');
      const prior=(await db.query('SELECT eintrag_id,sha256 FROM reverse_ansicht_retention WHERE ref_key=$1',[e.ref_key])).rows[0];
      if(prior&&(String(prior.eintrag_id)!==e.eintrag_id||String(prior.sha256)!==e.sha256))throw new AssetAnsichtFehler('ansicht_revision_falsch','Retentionreferenz gehört anderem Scope.');
      await db.query(
        'INSERT INTO reverse_ansicht_retention(ref_key,eintrag_id,sha256,expires_at) VALUES($1,$2,$3,$4) '+
        'ON CONFLICT(ref_key) DO UPDATE SET expires_at=GREATEST(reverse_ansicht_retention.expires_at,EXCLUDED.expires_at),released_at=NULL',
        [e.ref_key,e.eintrag_id,e.sha256,e.expires_at]);
    });
  }

  async freigeben(refKey:string):Promise<void>{
    await this.db.query('UPDATE reverse_ansicht_retention SET released_at=clock_timestamp() WHERE ref_key=$1 AND released_at IS NULL',[refKey]);
  }

  /** Halter für AssetAnsichtQuelle.halten/freigeben einer konkreten Reverse-Revision. */
  halter(eintragId:string,sha256:string):ReverseAnsichtHalter{
    return {
      halten:(refKey,bis)=>this.halten({ref_key:refKey,eintrag_id:eintragId,sha256,expires_at:bis}),
      freigeben:refKey=>this.freigeben(refKey),
    };
  }

  /** true, solange eine aktive Retention oder ein offener Ansicht-Link die Quelle hält. */
  async istGehalten(eintragId:string,sha256:string,db:Db=this.db):Promise<boolean>{
    const r=await db.query(
      'SELECT (EXISTS(SELECT 1 FROM reverse_ansicht_retention WHERE eintrag_id=$1 AND sha256=$2 AND released_at IS NULL AND expires_at>clock_timestamp()) OR '+
      "EXISTS(SELECT 1 FROM ansicht_tokens WHERE bereich='reverse' AND ziel_ref=$1 AND sha256=$2 AND revoked_at IS NULL "+
      'AND expires_at>clock_timestamp() AND (NOT einmalig OR consumed_at IS NULL))) AS gehalten',[eintragId,sha256]);
    return r.rows[0]?.gehalten!==false;
  }

  /**
   * Entfernt eine Reverse-Previewdatei nur, wenn weder Retention noch offener Link die Quelle hält.
   * Der Advisory-Lock (derselbe wie in halten) bleibt bis nach dem Unlink gehalten (A14 bereinigeCache-Vertrag).
   */
  async bereinigeCache(dienst:{bereinigeCache(adresse:AssetAdresse,cacheKey:string,fence:()=>Promise<boolean>):Promise<boolean>},
    o:{adresse:AssetAdresse;cacheKey:string;eintrag_id:string;sha256:string}):Promise<boolean>{
    if(o.adresse?.bereich!=='reverse'||typeof o.eintrag_id!=='string'||!REF_MUSTER.test(o.eintrag_id)||typeof o.sha256!=='string'||!SHA_MUSTER.test(o.sha256)){
      throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Ungültige Reverse-Cachereferenz.');
    }
    return this.tx(async db=>{
      await db.query(LOCK_SQL,[o.eintrag_id,o.sha256]);
      return dienst.bereinigeCache(o.adresse,o.cacheKey,async()=>!(await this.istGehalten(o.eintrag_id,o.sha256,db)));
    });
  }
}

let standard:ReverseAnsichtRetention|null=null;
/** Prozessweite Instanz (Zustand liegt in PG). */
export function standardReverseAnsichtRetention():ReverseAnsichtRetention{return standard??=new ReverseAnsichtRetention();}
/** Kurzform für den Reverse-Adapter: halten/freigeben für (eintrag_id, sha256). */
export function reverseAnsichtHalter(eintragId:string,sha256:string,retention:ReverseAnsichtRetention=standardReverseAnsichtRetention()):ReverseAnsichtHalter{
  return retention.halter(eintragId,sha256);
}
