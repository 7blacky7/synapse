/**
 * P18-T98: manuelles Neu-Parsen ueber reverse(neu_parsen) auf den gespeicherten Reverse-Dateien (kein Original/ISO neu einlesen).
 * Vorschau (Standard, vorschau!==false) zaehlt S1-Dateien je Profil; Ausfuehren (Koordinator/User) reiht hoechstens limit Dateien
 * ueber denselben automatischen queue-Weg der Pipeline mit Prioritaet 'nachzug' ein (Pin-Ursprung automatisch, kein manueller
 * Root, damit spaetere Automatik wie S3 nicht auf S1 begrenzt wird). Ersetzt werden nur S1-Ableitungen der gewaehlten Dateien
 * (neue Parser-Generation, alte bleibt in reverse_parser_generationen). Projekt-Neu-Parsen (intern parse_neu) bleibt unberuehrt.
 */
type Row=Record<string,unknown>;
type Db={query:Function};
export const NEU_PARSEN_ACTIONS=['neu_parsen'] as const;
export const NEU_PARSEN_PARAMETER={
 pfad_praefix:{type:'string',description:'neu_parsen: nur Dateien unter diesem Reverse-Pfad (Ordner)'},
 profil_version:{type:'string',description:'neu_parsen: nur Dateien, deren aktuelle S1-Schicht dieses Profil traegt (siehe Vorschau profile[])'},
} as const;
export const NEU_PARSEN_FELDER={neu_parsen:['reverse_id','datei','file_path','pfad_praefix','profil_version','vorschau','limit']} as const;
export interface NeuParsenAuftrag {
 reverseId:string;datei:string|null;pfadPraefix:string|null;profil:string|null;vorschau:boolean;limit:number;
 /** Eine Datei in eigener Transaktion einreihen (automatischer queue-Weg). */
 einreihen?:(dateiId:string,mediumId:string|null)=>Promise<Row>;
}
const like=(s:string)=>s.replace(/[\\%_]/g,m=>'\\'+m)+'%';
/** $1 Eintrag, $2 exakter Pfad, $3 Pfad-LIKE, $4 Profil. */
const FILTER=`FROM reverse_dateien d JOIN reverse_schichten s ON s.datei_id=d.id AND s.schicht='S1' AND s.aktuell AND s.status IN ('fertig','teilweise')
 WHERE d.eintrag_id=$1 AND d.storage_key IS NOT NULL AND d.sha256 IS NOT NULL AND ($2::text IS NULL OR d.pfad=$2)
  AND ($3::text IS NULL OR d.pfad LIKE $3 ESCAPE '\\') AND ($4::text IS NULL OR s.profil_version=$4)`;
const OFFEN_S1=`EXISTS(SELECT 1 FROM reverse_auftraege r WHERE r.datei_id=d.id AND r.schicht='S1' AND r.status IN ('offen','wartet','laeuft'))`;

export async function fuehreNeuParsenAus(db:Db,o:NeuParsenAuftrag):Promise<Row>{
 const p=[o.reverseId,o.datei,o.pfadPraefix?like(o.pfadPraefix):null,o.profil];
 const profile=(await db.query(`SELECT s.profil_version,(s.profil_version LIKE 'parser-s1:%') AS parser,count(*)::int AS dateien,
   count(*) FILTER (WHERE ${OFFEN_S1})::int AS offen ${FILTER} GROUP BY 1,2 ORDER BY 3 DESC`,p)).rows;
 const gesamt=profile.reduce((n:number,r:Row)=>n+Number(r.dateien),0);
 const ohneParser=profile.filter((r:Row)=>!r.parser).reduce((n:number,r:Row)=>n+Number(r.dateien),0);
 const basis={reverse_id:o.reverseId,datei:o.datei,status:o.vorschau?'vorschau':'eingereiht',gesamt,ohne_parser_profil:ohneParser,profile};
 if(o.vorschau){
  const beispiele=(await db.query(`SELECT d.pfad,s.profil_version ${FILTER} AND s.profil_version NOT LIKE 'parser-s1:%' ORDER BY d.id LIMIT 10`,p)).rows;
  // P18-T111: Stand S3 automatisch je Eintrag (PE-Programme).
  const s3=(await db.query(`SELECT count(*)::int AS pe_gesamt,
   count(*) FILTER (WHERE EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S3' AND s.aktuell AND s.status IN ('fertig','teilweise')))::int AS s3_fertig,
   count(*) FILTER (WHERE EXISTS(SELECT 1 FROM reverse_auftraege r WHERE r.datei_id=d.id AND r.schicht='S3' AND r.status IN ('offen','wartet','laeuft')))::int AS s3_offen,
   count(*) FILTER (WHERE (d.metadaten->'nachzug_auto'->>'s3_fehler')='true' AND NOT EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S3' AND s.aktuell AND s.status IN ('fertig','teilweise')))::int AS s3_auto_fehler
  FROM reverse_dateien d WHERE d.eintrag_id=$1 AND d.format='pe' AND lower(d.pfad) ~ '\\.(exe|dll|ocx|sys|drv)$'`,[o.reverseId])).rows[0];
  return {...basis,beispiele,s3_auto:s3,hinweis:'Nur Vorschau. Ausfuehren: reverse(action:"neu_parsen", reverse_id, [datei|pfad_praefix|profil_version], vorschau:false, limit) - nur Koordinator/User; Prioritaet nachzug.'};
 }
 if(!o.einreihen)throw new Error('neu_parsen_ohne_runtime');
 const kandidaten=(await db.query(`SELECT d.id::text AS id,d.medium_id::text AS medium_id ${FILTER} AND NOT ${OFFEN_S1} ORDER BY d.id LIMIT $5`,[...p,o.limit])).rows;
 const ergebnisse:Record<string,number>={};let abbruch:string|null=null;
 for(const d of kandidaten){
  let r:Row;
  try{r=await o.einreihen(String(d.id),d.medium_id==null?null:String(d.medium_id));}
  catch(e){r={status:'fehler',fehlercode:String((e as {code?:string})?.code??'werkzeug_fehler')};}
  const k=r.status==='fehler'||r.success===false?'fehler:'+String(r.fehlercode??'werkzeug_fehler'):String(r.status??'wartet');
  ergebnisse[k]=(ergebnisse[k]??0)+1;
  if(k==='fehler:warteschlange_voll'){abbruch='warteschlange_voll';break;}
 }
 return {...basis,angestossen:kandidaten.length,ergebnisse,abbruch,rest:Math.max(0,gesamt-kandidaten.length)};
}
