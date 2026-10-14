/** P10-T65: serverseitige Vertrauensquelle, keine Client-DSN als Konfiguration verwenden. */
import {getConfig} from '../config.js';
import {leseProjektDbZugang} from './projekt-db.js';
import {dbZielAusUrl,gleichesDbZiel,type ShellDbFreigabe} from './shell-db-zuordnung.js';
export async function holeShellDbFreigabe(
  project:string,
  opts:{env?:NodeJS.ProcessEnv;leseZugang?:typeof leseProjektDbZugang}={},
):Promise<ShellDbFreigabe>{
  const env=opts.env??process.env;
  const live=dbZielAusUrl(env.SYNAPSE_DATABASE_URL??env.DATABASE_URL??getConfig().database.url);
  const r:ShellDbFreigabe={project,ziele:[],...(live?{live}:{})};
  // Ohne eindeutige Systemgrenze keine neue Freigabe.
  if(!live)return r;
  try {
    const z=await (opts.leseZugang??leseProjektDbZugang)(project);
    if(z){
      const ziel=dbZielAusUrl(z.database_url);
      const registry={host:z.host,port:String(z.port),datenbank:z.database,user:z.user};
      if(ziel&&gleichesDbZiel(ziel,registry)&&ziel.port!==live.port&&ziel.datenbank!==live.datenbank)
        r.ziele.push({...ziel,art:'projekt'});
    }
  }catch{/* Keine Zuordnung bei Registryfehler, niemals raten. */}
  // P10-T27 prüft Test-DSNs, registriert sie aber nicht. Neue Konfiguration ist opt-in.
  const test=dbZielAusUrl(env.SYNAPSE_TEST_DATABASE_URL);
  if(test&&test.port!==live.port&&test.datenbank!==live.datenbank){
    r.ziele.push({...test,art:'test'});
    if(/^[1-9][0-9]{0,19}$/.test(env.SYNAPSE_TEST_DATABASE_SYSTEM_ID??''))r.test_system_id=env.SYNAPSE_TEST_DATABASE_SYSTEM_ID;
  }
  return r;
}

/** P10-T69: metadata is not a start permission; only an already accepted decision may inject it. */
export function privateShellTestDbFreigabe(
 lage:import('./shell-lage.js').ShellLage,freigabe:ShellDbFreigabe,
 pruefung:Pick<import('./shell-start-sicherung.js').ShellStartEntscheidung,'darf_starten'|'audit'>,
):string|undefined{
 if(!pruefung.darf_starten||!freigabe.test_system_id)return undefined;
 // Existing successful DB assignments retain their exact serialized contract.
 if(lage.datenbank_zuordnung)return JSON.stringify(freigabe);
 const nachweis=lage.datenbank_testzuordnung;
 if(pruefung.audit.entscheidung!=='bestaetigt'||!nachweis||nachweis.project!==freigabe.project||
  !freigabe.live||! /^[1-9][0-9]{0,19}$/.test(freigabe.test_system_id)||!nachweis.ziele.length)return undefined;
 if(!nachweis.ziele.every(z=>z.art==='test'&&z.datenbank==='synapse_test'&&z.port!=='5432'&&
  z.port!==freigabe.live!.port&&z.datenbank!==freigabe.live!.datenbank&&
  freigabe.ziele.some(s=>s.art==='test'&&gleichesDbZiel(s,z))))return undefined;
 return JSON.stringify(freigabe);
}
