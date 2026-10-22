/** P18-T42: aktuelle Leser-Generation ohne Änderung der gemeinsamen Asset-Engine.
 * Historische, exakt adressierte Dateien bleiben über inspect erreichbar. */
import type {Pool,QueryConfig,QueryResult} from 'pg';
/** Publikation ist ein einzelner Laufzeiger. Staging/Test/abgelöste Läufe sind im Baum unsichtbar. */
export const REVERSE_LESER_SICHT_SQL=`SELECT sicht.* FROM reverse_dateien sicht
 WHERE NOT (sicht.metadaten ? 'reverse_leser') OR EXISTS(
 SELECT 1 FROM reverse_leser_laeufe l JOIN reverse_leser r ON r.id=l.leser_id
 WHERE l.leser_id=sicht.metadaten#>>'{reverse_leser,revision}'
 AND EXISTS(SELECT 1 FROM reverse_objekte o WHERE o.datei_id=sicht.id AND o.eintrag_id=sicht.eintrag_id AND o.data#>>'{reverse_leser,lauf_id}'=l.id::text)
 AND l.eintrag_id=sicht.eintrag_id AND l.diagnose->>'publiziert'='true'
 AND l.diagnose->>'testmodus' IS DISTINCT FROM 'true'
 AND NOT EXISTS(SELECT 1 FROM reverse_leser_laeufe n JOIN reverse_leser nr ON nr.id=n.leser_id
 WHERE n.eintrag_id=l.eintrag_id AND n.datei_id=l.datei_id AND nr.name=r.name
 AND n.diagnose->>'publiziert'='true' AND n.diagnose->>'testmodus' IS DISTINCT FROM 'true'
 AND (n.diagnose->>'publiziert_am',n.id)>(l.diagnose->>'publiziert_am',l.id)))`;
/** Eine deduplizierte Datei kann zu mehreren Läufen gehören. inspect zeigt die neueste
 * publizierte Mitgliedschaft dieser exakten Datei; historische Zeilen bleiben gespeichert. */
const OBJEKT_SICHT_SQL=`SELECT own.* FROM reverse_objekte own
 WHERE own.data->>'ursprung' IS DISTINCT FROM 'leser' OR EXISTS(
 SELECT 1 FROM reverse_leser_laeufe l WHERE l.id::text=own.data#>>'{reverse_leser,lauf_id}'
 AND l.eintrag_id=own.eintrag_id AND l.diagnose->>'publiziert'='true'
 AND l.diagnose->>'testmodus' IS DISTINCT FROM 'true'
 AND NOT EXISTS(SELECT 1 FROM reverse_objekte newer JOIN reverse_leser_laeufe n
 ON n.id::text=newer.data#>>'{reverse_leser,lauf_id}' AND n.eintrag_id=newer.eintrag_id
 WHERE newer.datei_id=own.datei_id AND newer.eintrag_id=own.eintrag_id
 AND n.diagnose->>'publiziert'='true' AND n.diagnose->>'testmodus' IS DISTINCT FROM 'true'
 AND (n.diagnose->>'publiziert_am',n.id)>(l.diagnose->>'publiziert_am',l.id)))`;
/** Nur feste SQL-Bezeichner ersetzen, niemals gebundene Werte, Strings oder Kommentare. */
export function reverseLeserSichtSql(sql:string,historisch=false):string {
 return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\breverse_(?:dateien|objekte)\b/g,
  t=>t==='reverse_dateien'&&!historisch?'('+REVERSE_LESER_SICHT_SQL+')':t==='reverse_objekte'?'('+OBJEKT_SICHT_SQL+')':t);
}
export async function reverseLeserLesepool(pool:Pool,historisch=false):Promise<Pool>{
 // Alt-Schema/Schalter AUS erfordern weder eine Migration noch eine zweite Engine.
 if(!(await pool.query("SELECT to_regclass('reverse_leser_laeufe') AS t")).rows[0]?.t)return pool;
 const query=(target:Pick<Pool,'query'>)=>(first:string|QueryConfig,values?:unknown[]):Promise<QueryResult>=>{
  const sql=typeof first==='string'?reverseLeserSichtSql(first,historisch):{...first,text:reverseLeserSichtSql(first.text,historisch)};
  return target.query(sql,values);
 };
 return {query:query(pool),connect:async()=>{
  const c=await pool.connect();return {query:query(c),release:()=>c.release()};
 }} as unknown as Pool;
}
