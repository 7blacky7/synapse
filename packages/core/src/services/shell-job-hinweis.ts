/** P10-T40: optionale DB-Hinweise nur am aeusseren Antwortpfad filtern. */
import {getPool} from '../db/client.js';
import {claimHinweis} from './hinweis-drossel.js';

type Objekt=Record<string,unknown>;
const objekt=(v:unknown):v is Objekt=>!!v && typeof v==='object' && !Array.isArray(v);
export async function drossleShellJobHinweis<T>(args:Objekt, daten:T):Promise<T> {
  try { return await drossle(args,daten); }
  catch { return daten; } // optionale Hinweise duerfen den Shell-Aufruf nie brechen
}
async function drossle<T>(args:Objekt, daten:T):Promise<T> {
  if (!['exec','get','history','get_stream'].includes(String(args.action??'exec'))) return daten;
  const agent=String(args.agent_id??process.env.SYNAPSE_AGENT_NAME??'');
  const entscheidungen=new Map<string,Promise<Objekt|undefined>>();
  const detail=args.action==='get' && args.detail==='full';
  const hinweis=(project:string):Promise<Objekt|undefined>=>{
    let p=entscheidungen.get(project);
    if (!p) {
      p=(async()=>{
        const r=await getPool().query<{host:string;port:number;db:string}>(
          'SELECT host,port,db FROM projekt_datenbanken WHERE project=$1',[project]);
        const db=r.rows[0];
        const database_url=project==='synapse'?'keine':db?`projekt-db ${db.db} (${db.host}:${db.port})`:'keine';
        return await claimHinweis({project,agentId:agent,art:'job_env',fingerprint:database_url})
          ? {database_url} : undefined;
      })();
      entscheidungen.set(project,p);
    }
    return p;
  };
  const gezeigteProjekte=new Set<string>();
  const bearbeiten=async(v:Objekt, projekt?:string):Promise<Objekt>=>{
    const out={...v};
    const project=typeof out.project==='string'?out.project:projekt;
    if (Array.isArray(out.content)) {
      out.content=await Promise.all(out.content.map(async block=>{
        if (!objekt(block)||block.type!=='text'||typeof block.text!=='string')return block;
        let parsed:unknown;try{parsed=JSON.parse(block.text);}catch{return block;}
        return objekt(parsed)?{...block,text:JSON.stringify(await bearbeiten(parsed,project))}:block;
      }));
      return out;
    }
    // Ausschliesslich Metadaten anfassen, nie Logs/result/args rekursiv durchsuchen.
    const historisch=objekt(out.job_env)?out.job_env:undefined;
    let alt:Objekt|undefined=historisch;
    if (typeof out.message==='string') {
      const m=/^job_env: database_url=([^\r\n;]+)(; maskiert: \d+ Werte)?$/.exec(out.message);
      if (m) {
        alt={database_url:m[1]};
        if(m[2])out.message=m[2].slice(2);else delete out.message;
      }
    }
    delete out.job_env;
    if (Array.isArray(out.jobs))out.jobs=await Promise.all(out.jobs.map(j=>objekt(j)?bearbeiten(j,project):j));
    if (objekt(out.job))out.job=await bearbeiten(out.job,project);
    // Detail ist ein ausdruecklicher Abruf und verbraucht keinen automatischen Hinweis.
    if(detail && alt)out.job_env=alt;
    else if(project && agent && !gezeigteProjekte.has(project)){
      gezeigteProjekte.add(project);
      const info=await hinweis(project);
      if(info)out.job_env=info;
    }
    return out;
  };
  if(!objekt(daten))return daten;
  let project=typeof args.project==='string'?args.project:undefined;
  if(!project && typeof args.id==='string'){
    const r=await getPool().query<{project:string}>('SELECT project FROM shell_jobs WHERE id::text=$1',[args.id]);
    project=r.rows[0]?.project;
  }
  return await bearbeiten(daten,project) as T;
}
