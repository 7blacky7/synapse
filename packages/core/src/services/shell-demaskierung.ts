/**
 * P10-T73: Bestätigt demaskierte Shell-Ausgaben.
 *
 * Eine bestätigte Demaskierung speichert die Job-Ausgabe unmaskiert und trägt den Job
 * in die KLEINE Liste shell_demaskierungen ein. Der Worker (REST-API) arbeitet NUR diese
 * Liste ab: fällige Einträge -> genau diesen Job wieder maskieren -> Eintrag löschen.
 * Kein Scan über shell_jobs. Der Grund bleibt im Job-Audit (shell_jobs.sicherung.demaskierung).
 * tool_calls, Embeddings und Logs bleiben immer maskiert.
 */
import {getPool} from '../db/client.js';
import {maskiereShellVorSpeichern,maskiereShellText} from './shell-maske.js';
import {shellRueckfrageFristMs,type ShellDemaskierung} from './shell-rueckfrage.js';

type Abfrage={query:(sql:string,werte?:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>};

/** Trägt einen unmaskiert gespeicherten Job in die Liste ein und hält den Grund im Job-Audit fest. */
export async function trageShellDemaskierungEin(jobId:string,project:string,d:ShellDemaskierung,db:Abfrage=getPool() as unknown as Abfrage):Promise<void>{
  const grund=maskiereShellText(d.grund).text;
  await db.query(
    `INSERT INTO shell_demaskierungen(job_id,bestaetigung_id,agent_id,project,grund,maskieren_bis)
     VALUES($1::uuid,$2,$3,$4,$5,$6::timestamptz)
     ON CONFLICT(job_id) DO UPDATE SET bestaetigung_id=EXCLUDED.bestaetigung_id,agent_id=EXCLUDED.agent_id,
       grund=EXCLUDED.grund,demaskiert_at=NOW(),maskieren_bis=EXCLUDED.maskieren_bis`,
    [jobId,d.bestaetigung_id,d.agent_id,project,grund,d.maskieren_bis]);
  await db.query(
    `UPDATE shell_jobs SET sicherung=COALESCE(sicherung,'{}'::jsonb)||jsonb_build_object('demaskierung',$2::jsonb),updated_at=NOW()
     WHERE id=$1::uuid`,
    [jobId,JSON.stringify({bestaetigung_id:d.bestaetigung_id,agent_id:d.agent_id,grund,demaskiert_at:new Date().toISOString(),maskieren_bis:d.maskieren_bis})]);
}

/**
 * Maskiert fällige (oder ausdrücklich genannte) Jobs der Liste wieder und entfernt ihre Einträge.
 * job_id: früher nachmaskieren (shell(action:'maskieren', id)), unabhängig von der Frist.
 */
export async function maskiereFaelligeShellJobs(o:{job_id?:string;limit?:number}={}):Promise<{nachmaskiert:number;job_ids:string[]}>{
  const pool=getPool();
  const limit=Math.max(1,Math.min(o.limit??100,1000));
  const {rows}=await pool.query<{job_id:string;project:string}>(
    o.job_id
      ? 'SELECT job_id::text,project FROM shell_demaskierungen WHERE job_id=$1::uuid'
      : 'SELECT job_id::text,project FROM shell_demaskierungen WHERE maskieren_bis<=NOW() ORDER BY maskieren_bis LIMIT $1',
    [o.job_id??limit]);
  const erledigt:string[]=[];
  for(const e of rows){
    const job=(await pool.query<{output:string|null;tail:unknown;message:string|null;error:string|null}>(
      'SELECT output,tail,message,error FROM shell_jobs WHERE id=$1::uuid',[e.job_id])).rows[0];
    if(job){
      const safe=await maskiereShellVorSpeichern(e.project,{output:job.output,tail:job.tail,message:job.message,error:job.error}) as
        {output:string|null;tail:unknown;message:string|null;error:string|null};
      await pool.query(
        `UPDATE shell_jobs SET output=$2,tail=$3::jsonb,message=$4,error=$5,
           sicherung=CASE WHEN sicherung ? 'demaskierung'
             THEN jsonb_set(sicherung,'{demaskierung,nachmaskiert_at}',to_jsonb(NOW()::text)) ELSE sicherung END,
           updated_at=NOW()
         WHERE id=$1::uuid`,
        [e.job_id,safe.output,safe.tail===null||safe.tail===undefined?null:JSON.stringify(safe.tail),safe.message,safe.error]);
    }
    await pool.query('DELETE FROM shell_demaskierungen WHERE job_id=$1::uuid',[e.job_id]);
    erledigt.push(e.job_id);
  }
  return {nachmaskiert:erledigt.length,job_ids:erledigt};
}

/**
 * Verworfene Rückfragen hinterlassen keine Spur: die abgewiesene Job-Zeile, die nur die
 * Rückfrage transportierte, wird nach Ablauf der Frist gelöscht (bestätigte Läufe haben
 * eine eigene Zeile mit Grund im Audit).
 */
export async function entferneVerworfeneShellRueckfragen():Promise<number>{
  // M3: nur die kleine Vormerkliste lesen, Loeschen per Primaerschluessel; kein Scan ueber shell_jobs.
  const pool=getPool();
  const r=await pool.query(
    `DELETE FROM shell_jobs j USING shell_rueckfrage_jobs v
     WHERE j.id=v.job_id AND v.verfaellt_at<NOW() AND j.status='rejected'`);
  await pool.query('DELETE FROM shell_rueckfrage_jobs WHERE verfaellt_at<NOW()');
  return r.rowCount??0;
}
/** Vormerken: eine abgewiesene Rueckfrage-Zeile verfaellt nach gueltig_bis + 30 s. */
export async function merkeShellRueckfrageJobVor(jobId:string,gueltigBis:string|undefined,db:Abfrage=getPool() as unknown as Abfrage):Promise<void>{
  const bis=Date.parse(gueltigBis??'');
  const verfall=new Date((Number.isNaN(bis)?Date.now()+shellRueckfrageFristMs():bis)+30_000).toISOString();
  await db.query('INSERT INTO shell_rueckfrage_jobs(job_id,verfaellt_at) VALUES($1::uuid,$2::timestamptz) ON CONFLICT(job_id) DO UPDATE SET verfaellt_at=EXCLUDED.verfaellt_at',[jobId,verfall]);
}

/** Ein Worker-Durchlauf (REST-API): fällige Nachmaskierungen + verworfene Rückfragen. */
export async function shellNachmaskierLauf():Promise<{nachmaskiert:number;rueckfragen_entfernt:number}>{
  const m=await maskiereFaelligeShellJobs();
  const r=await entferneVerworfeneShellRueckfragen();
  return {nachmaskiert:m.nachmaskiert,rueckfragen_entfernt:r};
}
