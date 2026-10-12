/** P10-T42: Markierung und selektive Nachmaskierung, Laufaufrufe explizit getrennt. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getPool} from '../db/client.js';
import type {PoolClient} from 'pg';
import {ladeShellWerte} from './shell-maske.js';
import {gruppiereShellAltbestand,bewerteShellAltbestand,planeShellAltbestand,shellAltQuellHash,
 type ShellAltZeile,type ShellAltEntscheidung} from './shell-altbestand.js';
export {SHELL_ALT_SCHEMA_SQL} from '../db/shell-altbestand-schema.js';

/** Cache folgt automatisch dem kompilierten gemeinsamen Regel-/Zuordnungsstand. */
export const SHELL_ALT_REGELVERSION=createHash('sha256').update(
 ['env-maske.js','mcp-json-maske.js','shell-maske.js','shell-altbestand.js'].map(p=>readFileSync(new URL(p,import.meta.url),'utf8')).join('\n')).digest('hex');
const felder={shell_jobs:['output','tail','message','error'],tool_calls:['result','args_preview','error']} as const;
const row=(table:ShellAltZeile['tabelle'],r:Record<string,unknown>):ShellAltZeile=>({
 tabelle:table,id:String(r.id),project:r.project as string|null,
 daten:Object.fromEntries(felder[table].map(k=>[k,r[k]])),gespeichert_am:r.gespeichert_am as Date|null
});
async function eineZeile(table:ShellAltZeile['tabelle'],id:string,c:PoolClient,sperren=false){
 const sql='SELECT id::text AS id,project,'+felder[table].join(',')+','+
  (table==='shell_jobs'?'status,COALESCE(completed_at,created_at)':'ts')+' AS gespeichert_am FROM '+table+' WHERE id=$1'+(sperren?' FOR UPDATE':'');
 const r=(await c.query(sql,[id])).rows[0];return r?{row:row(table,r),laufend:table==='shell_jobs'&&['pending','running'].includes(r.status)}:null;
}
/** Auswahl nur Output-Felder; kein Command und keine frei wählbaren Tabellen/Spalten. */
export async function ladeShellAltZeilen(table:ShellAltZeile['tabelle'],project?:string):Promise<ShellAltZeile[]>{
 if(!Object.hasOwn(felder,table))throw new Error('Ungültige Altbestand-Tabelle');
 const sql='SELECT id::text AS id,project,'+felder[table].join(',')+','+
  (table==='shell_jobs'?'COALESCE(completed_at,created_at)':'ts')+' AS gespeichert_am FROM '+table+
  (table==='tool_calls'?" WHERE tool_name='shell'"+(project?' AND project=$1':''):project?' WHERE project=$1':'');
 return (await getPool().query(sql,project?[project]:[])).rows.map(r=>row(table,r));
}
async function cached(ids:string[]):Promise<Map<string,ShellAltEntscheidung>>{
 const aus=new Map<string,ShellAltEntscheidung>();
 for(let i=0;i<ids.length;i+=500){
  const r=await getPool().query('SELECT gruppen_id,bewertung,confidence,grund FROM shell_altbestand_gruppen WHERE regelversion=$1 AND gruppen_id=ANY($2::text[])',[SHELL_ALT_REGELVERSION,ids.slice(i,i+500)]);
  for(const b of r.rows)aus.set(b.gruppen_id,{gruppe:b.gruppen_id,bewertung:b.bewertung,confidence:b.confidence,grund:b.grund});
 }
 return aus;
}
/** Jede Gruppe bewerten/cache'n, danach Marker unter Quellprüfung; Quellen niemals schreiben. */
export async function markiereShellAltbestand(rows:readonly ShellAltZeile[],werte:readonly string[],
 opt:{project:string|null;agent_id?:string},deps:Parameters<typeof bewerteShellAltbestand>[2]={}){
 const groups=gruppiereShellAltbestand(rows,werte),entscheidungen=await cached(groups.map(g=>g.id));
 let neue_gruppen=0,usd=0;
 for(const g of groups){
  if(entscheidungen.has(g.id))continue;
  const r=await bewerteShellAltbestand([g],opt,deps);usd+=r.usd;
  if(r.status==='budget_pause')return {status:'budget_pause' as const,gruppen:groups.length,neue_gruppen,markierte_zeilen:0,geaendert:0,verbleibend:groups.filter(x=>!entscheidungen.has(x.id)).length,usd};
  const b=r.bewertungen[0]!;
  // Alle gespeicherten Texte stammen ausschließlich aus dem geprüften maskierten Gruppenobjekt/Grundcode.
  await getPool().query(`INSERT INTO shell_altbestand_gruppen(regelversion,gruppen_id,literal_hash,feld,schluessel,fundart,kontext,wertlaenge,bewertung,confidence,grund)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
   [SHELL_ALT_REGELVERSION,g.id,g.literal_hash,g.feld,g.schluessel,g.fundart,g.kontext,g.wertlaenge,b.bewertung,b.confidence,b.grund]);
  entscheidungen.set(g.id,b);neue_gruppen++;
 }
 let markierte_zeilen=0,geaendert=0;
 for(const original of rows){
  const relevant=groups.filter(g=>g.bezuege.some(b=>b.tabelle===original.tabelle&&b.id===original.id));if(!relevant.length)continue;
  const c=await getPool().connect();
  try{
   await c.query('BEGIN');
   const aktuelle=await eineZeile(original.tabelle,original.id,c,true),fingerprint=shellAltQuellHash(original);
   if(!aktuelle||aktuelle.row.project!==original.project||shellAltQuellHash(aktuelle.row)!==fingerprint){geaendert++;await c.query('ROLLBACK');continue;}
   let added=0;
   for(const g of relevant)for(const b of g.bezuege.filter(b=>b.tabelle===original.tabelle&&b.id===original.id)){
    const r=await c.query(`INSERT INTO shell_altbestand_bezuege(regelversion,gruppen_id,tabelle,zeilen_id,project,pfad,quell_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
     [SHELL_ALT_REGELVERSION,g.id,b.tabelle,b.id,original.project,b.pfad,fingerprint]);
    added+=r.rowCount??0;
   }
   await c.query('COMMIT');if(added)markierte_zeilen++;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 return {status:'fertig' as const,gruppen:groups.length,neue_gruppen,markierte_zeilen,geaendert,verbleibend:0,usd};
}
type ShellAltWerte=readonly string[]|((project:string|null)=>Promise<readonly string[]>);
async function lauf(project:string|undefined,werte:ShellAltWerte,schreiben:boolean){
 const pool=getPool(),version=SHELL_ALT_REGELVERSION;
 const refs=(await pool.query(`SELECT DISTINCT tabelle,zeilen_id FROM shell_altbestand_bezuege
  WHERE regelversion=$1 AND status IN ('markiert','offen')`+(project?' AND project=$2':''),project?[version,project]:[version])).rows;
 const aus={aenderungen:0,maskiert:0,geaendert:0,laufend:0,fehlend:0,offen:0,behalten:0,
  tabellen:{shell_jobs:{aenderungen:0,maskiert:0},tool_calls:{aenderungen:0,maskiert:0}}};
 for(const ref of refs){
  const table=ref.tabelle as ShellAltZeile['tabelle'];if(!Object.hasOwn(felder,table))throw new Error('Ungültiger Marker');
  const c=await pool.connect();
  try{
   await c.query(schreiben?'BEGIN':'BEGIN READ ONLY');
   const current=await eineZeile(table,ref.zeilen_id,c,schreiben);
   if(!current){aus.fehlend++;await c.query('ROLLBACK');continue;}
   if(current.laufend){aus.laufend++;await c.query('ROLLBACK');continue;}
   const entries=(await c.query(`SELECT b.quell_hash,b.gruppen_id,g.bewertung,g.confidence,g.grund
    FROM shell_altbestand_bezuege b JOIN shell_altbestand_gruppen g USING(regelversion,gruppen_id)
    WHERE b.regelversion=$1 AND b.tabelle=$2 AND b.zeilen_id=$3 AND b.status IN ('markiert','offen')`,
    [version,table,ref.zeilen_id])).rows;
   const fingerprint=shellAltQuellHash(current.row),valid=entries.filter(b=>b.quell_hash===fingerprint);
   if(!valid.length){
    aus.geaendert++;
    if(schreiben)await c.query("UPDATE shell_altbestand_bezuege SET status='geaendert' WHERE regelversion=$1 AND tabelle=$2 AND zeilen_id=$3 AND status IN ('markiert','offen')",[version,table,ref.zeilen_id]);
    await c.query(schreiben?'COMMIT':'ROLLBACK');continue;
   }
   const decisions=valid.map(b=>({gruppe:b.gruppen_id,bewertung:b.bewertung,confidence:b.confidence,grund:b.grund})) as ShellAltEntscheidung[];
   if(decisions.some(b=>b.bewertung==='offen'))aus.offen++;
   if(decisions.some(b=>b.bewertung==='beispiel'||b.bewertung==='falsch'))aus.behalten++;
   const values=typeof werte==='function'?await werte(current.row.project):werte;
   const change=planeShellAltbestand([current.row],values,decisions)[0];
   if(change){
    if(schreiben){
     const columns=felder[table],values=columns.map(k=>table==='shell_jobs'&&k==='tail'&&change.daten[k]!==null?JSON.stringify(change.daten[k]):change.daten[k]);
     await c.query('UPDATE '+table+' SET '+columns.map((k,i)=>k+'=$'+(i+1)).join(',')+' WHERE id=$'+(columns.length+1),[...values,ref.zeilen_id]);
    }
    aus.aenderungen++;aus.maskiert+=change.maskiert;aus.tabellen[table].aenderungen++;aus.tabellen[table].maskiert+=change.maskiert;
   }
   if(schreiben)await c.query(`UPDATE shell_altbestand_bezuege b SET
    status=CASE WHEN g.bewertung='offen' THEN 'offen' WHEN g.bewertung='geheimnis' THEN $5 ELSE 'behalten' END,
    maskiert=CASE WHEN g.bewertung='geheimnis' THEN COALESCE(($6::jsonb->>(b.gruppen_id||':'||b.pfad))::integer,0) ELSE 0 END,
    maskiert_at=CASE WHEN g.bewertung='geheimnis' AND $5='maskiert' THEN NOW() ELSE NULL END
    FROM shell_altbestand_gruppen g WHERE b.regelversion=g.regelversion AND b.gruppen_id=g.gruppen_id
    AND b.regelversion=$1 AND b.tabelle=$2 AND b.zeilen_id=$3 AND b.quell_hash=$4`,
    [version,table,ref.zeilen_id,fingerprint,change?'maskiert':'offen',JSON.stringify(change?.maskiert_pro_bezug??{})]);
   await c.query(schreiben?'COMMIT':'ROLLBACK');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 return aus;
}
/** Read-only, nur Zähler; nie Quelltext in der Antwort. */
export const trockenlaufShellAltbestand=(project:string|undefined,werte:ShellAltWerte)=>lauf(project,werte,false);
/** Separater Aufruf, nur nach freigegebenem Trockenlauf; Zeilenlock + Fingerprint + Marker atomar. */
export const maskiereShellAltbestand=(project:string|undefined,werte:ShellAltWerte)=>lauf(project,werte,true);

/** Expliziter Gesamtlauf nach Deploy: cursorweise lesen, sämtliche Gruppen bewerten/markieren.
 * Kein Nachmaskieren. Erfolgreiche Gruppen sind sofort persistiert und bei Wiederholung wiederverwendbar.
 * Quell- und Marker-Zugriffe laufen absichtlich auf getrennten Verbindungen.
 */
export async function markiereShellAltbestandGesamt(
 opt:{project?:string;agent_id?:string},
 deps:Parameters<typeof bewerteShellAltbestand>[2]&{fortschritt?:(daten:Record<string,unknown>)=>void|Promise<void>;ladeWerte?:(project:string|null)=>Promise<readonly string[]>}={}
){
 const pool=getPool(),c=await pool.connect(),werte=new Map<string,readonly string[]>(),gruppen=new Set<string>();
 const aus={status:'fertig' as 'fertig'|'budget_pause',geprueft:{shell_jobs:0,tool_calls:0},gruppen:0,neue_gruppen:0,markierte_zeilen:0,geaendert:0,usd:0};
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for(const table of ['shell_jobs','tool_calls'] as const){
   const where=table==='tool_calls'?" WHERE tool_name='shell'"+(opt.project?' AND project=$1':''):opt.project?' WHERE project=$1':'';
   await c.query('DECLARE shell_altgesamt NO SCROLL CURSOR FOR SELECT id::text AS id,project,'+felder[table].join(',')+','+
    (table==='shell_jobs'?'COALESCE(completed_at,created_at)':'ts')+' AS gespeichert_am FROM '+table+where,opt.project?[opt.project]:[]);
   while(true){
    const batch=(await c.query('FETCH FORWARD 300 FROM shell_altgesamt')).rows;if(!batch.length)break;
    const byProject=new Map<string,ShellAltZeile[]>();
    for(const raw of batch){const key=raw.project??'';if(!byProject.has(key))byProject.set(key,[]);byProject.get(key)!.push(row(table,raw));aus.geprueft[table]++;}
    for(const [p,part]of byProject){
     if(!werte.has(p))werte.set(p,await (deps.ladeWerte?deps.ladeWerte(p||null):ladeShellWerte(p||undefined,{projektFs:p==='synapse'})));
     const values=werte.get(p)!;
     for(const g of gruppiereShellAltbestand(part,values))gruppen.add(g.id);
     const result=await markiereShellAltbestand(part,values,{project:p||null,agent_id:opt.agent_id},deps);
     aus.gruppen=gruppen.size;aus.neue_gruppen+=result.neue_gruppen;aus.markierte_zeilen+=result.markierte_zeilen;aus.geaendert+=result.geaendert;aus.usd+=result.usd;
     if(result.status==='budget_pause'){aus.status='budget_pause';await deps.fortschritt?.({...aus});await c.query('ROLLBACK');return aus;}
    }
    await deps.fortschritt?.({...aus});
   }
   await c.query('CLOSE shell_altgesamt');
  }
  await c.query('ROLLBACK');return aus;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
