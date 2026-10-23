/**
 * P18-T109 Teil 2: zentrale Sichtbarkeit der Reverse-Bibliothek.
 * Schalter reverse_global_sichtbar (global, Standard AUS):
 *   AUS = bisheriges Verhalten: Inhalte nur bei aktiver reverse_bindungen(project, eintrag_id).
 *   EIN = jeder vorhandene Eintrag ist für jedes Projekt lesbar (auch unfertige); nichts wird geblockt.
 * Alle Reverse-Lesepfade fragen NUR hier, damit AUS/EIN überall gleich wirkt.
 * Stand je Eintrag (vollstaendig|laeuft|mit_fehlern|leer) leitet sich nur lesend aus Aufträgen, Schichten und Medien ab.
 */
import {leseReverseProduktSchalter,type ReverseSchalterStand} from './reverse-einstellwerte.js';

type Db={query:Function};
const BINDUNG_SQL='SELECT 1 FROM reverse_bindungen WHERE project=$1 AND eintrag_id=$2 AND geloest_at IS NULL';
// $1 bleibt gebunden, damit beide Varianten dieselben Parameter nehmen.
const GLOBAL_SQL='SELECT 1 FROM reverse_eintraege WHERE id=$2 AND $1::text IS NOT NULL';

export async function leseReverseSichtbarkeitSchalter(db?:Db):Promise<ReverseSchalterStand|null>{
  return leseReverseProduktSchalter('reverse_global_sichtbar',null,db as never).catch(()=>null);
}
/** Lesefehler des Schalters = AUS (bisheriges, engeres Verhalten). */
export async function reverseGlobalSichtbar(db?:Db):Promise<boolean>{
  const s=await leseReverseSichtbarkeitSchalter(db);
  return !!s?.aktiv&&!s.letzter_fehler;
}
/** SQL mit Parametern [$1 project, $2 eintrag_id]; liefert eine Zeile, wenn der Eintrag für das Projekt sichtbar ist. */
export async function reverseSichtbarSql(db?:Db,lock=false):Promise<string>{
  return (await reverseGlobalSichtbar(db)?GLOBAL_SQL:BINDUNG_SQL)+(lock?' FOR SHARE':'');
}
export async function reverseEintragSichtbar(db:Db,project:string,reverseId:string,lock=false):Promise<boolean>{
  const r=await db.query(await reverseSichtbarSql(db,lock),[project,reverseId]);
  return (r?.rows?.length??0)>0;
}

export type ReverseStand='vollstaendig'|'laeuft'|'mit_fehlern'|'leer';
export interface ReverseStandDaten {stand:ReverseStand;dateien:number;auftraege_offen:number;auftraege_fehler:number;schichten_fehler:number;medien_fehler:number;
  leser_offen:number;leser_fehler:number;leser_teilweise:number;erkenntnisse:number}
/**
 * Laufende Arbeit hat Vorrang; danach Fehler/teilweise; ohne Dateien 'leer'.
 * Abnahme R2: Leserläufe zählen mit (je Datei nur der jüngste Lauf zur aktuellen Quell-sha256, ohne Testmodus –
 * dieselbe Auswahl wie reverse-leser-hinweis.ts); Auftragsfehler nur, wenn kein jüngerer Auftrag für dasselbe Ziel folgt.
 */
export async function leseReverseStand(db:Db,reverseId:string):Promise<ReverseStandDaten>{
  const r=(await db.query(`SELECT
    (SELECT count(*) FROM reverse_dateien WHERE eintrag_id=$1)::int AS dateien,
    (SELECT count(*) FROM reverse_auftraege WHERE eintrag_id=$1 AND status IN ('offen','wartet','laeuft'))::int AS auftraege_offen,
    (SELECT count(*) FROM reverse_auftraege a WHERE a.eintrag_id=$1 AND a.status='fehler' AND NOT EXISTS(SELECT 1 FROM reverse_auftraege b
      WHERE b.eintrag_id=a.eintrag_id AND b.schicht=a.schicht AND b.datei_id IS NOT DISTINCT FROM a.datei_id AND b.medium_id IS NOT DISTINCT FROM a.medium_id
       AND b.created_at>a.created_at))::int AS auftraege_fehler,
    (SELECT count(*) FROM reverse_schichten s LEFT JOIN reverse_dateien d ON d.id=s.datei_id LEFT JOIN reverse_medien m ON m.id=s.medium_id
      WHERE s.aktuell AND COALESCE(d.eintrag_id,m.eintrag_id)=$1 AND s.status IN ('fehler','teilweise'))::int AS schichten_fehler,
    (SELECT count(*) FROM reverse_medien WHERE eintrag_id=$1 AND fehlercode IS NOT NULL)::int AS medien_fehler`,[reverseId])).rows[0]??{};
  // Spalte ursprung kommt mit 138_reverse_erkenntnisse; to_jsonb liest sie tolerant, damit keine umgebende Transaktion abbricht.
  r.erkenntnisse=(await db.query("SELECT count(*)::int AS n FROM reverse_verweise v WHERE v.eintrag_id=$1 AND to_jsonb(v)->>'ursprung'='manuell'",[reverseId])).rows[0]?.n??0;
  r.leser_offen=0;r.leser_fehler=0;r.leser_teilweise=0;
  // Tabellen erst mit 141_reverse_leser bzw. P20: vorher prüfen, damit keine umgebende Transaktion abbricht.
  const da=(await db.query("SELECT to_regclass('reverse_leser_laeufe') AS l,to_regclass('work_jobs') AS w")).rows[0]??{};
  if(da.l){
    // Re-Abnahme 1ef9bb27: offen auch, solange Host-Validierung/Publikation läuft (fertig ohne host_validiert oder Work-Job
    // noch pending/leased/staged; der Executor setzt den Laufstatus vor materialisieren/complete). teilweise = unvollständig.
    const job=da.w?" OR EXISTS(SELECT 1 FROM work_jobs w WHERE w.id=l.work_job_id AND w.state IN ('pending','leased','staged'))":'';
    const offen="(l.status IN ('offen','laeuft') OR (l.status='fertig' AND (l.diagnose->>'host_validiert') IS DISTINCT FROM 'true')"+job+')';
    const l=(await db.query(`SELECT count(*) FILTER(WHERE ${offen})::int AS offen,
      count(*) FILTER(WHERE NOT ${offen} AND l.status IN ('fehler','abgebrochen'))::int AS fehler,
      count(*) FILTER(WHERE NOT ${offen} AND l.status='teilweise')::int AS teilweise FROM reverse_dateien d
      JOIN LATERAL(SELECT x.status,x.diagnose,x.work_job_id FROM reverse_leser_laeufe x WHERE x.eintrag_id=d.eintrag_id AND x.datei_id=d.id AND x.quell_sha256=d.sha256
        AND x.diagnose->>'testmodus' IS DISTINCT FROM 'true' ORDER BY x.created_at DESC,x.id DESC LIMIT 1) l ON true WHERE d.eintrag_id=$1`,[reverseId])).rows[0]??{};
    r.leser_offen=l.offen??0;r.leser_fehler=l.fehler??0;r.leser_teilweise=l.teilweise??0;
  }
  const n=(k:string)=>Number(r[k]??0);
  const stand:ReverseStand=n('auftraege_offen')+n('leser_offen')>0?'laeuft'
    :n('schichten_fehler')+n('medien_fehler')+n('auftraege_fehler')+n('leser_fehler')+n('leser_teilweise')>0?'mit_fehlern':n('dateien')>0?'vollstaendig':'leer';
  return {stand,dateien:n('dateien'),auftraege_offen:n('auftraege_offen'),auftraege_fehler:n('auftraege_fehler'),schichten_fehler:n('schichten_fehler'),
    medien_fehler:n('medien_fehler'),leser_offen:n('leser_offen'),leser_fehler:n('leser_fehler'),leser_teilweise:n('leser_teilweise'),erkenntnisse:n('erkenntnisse')};
}
