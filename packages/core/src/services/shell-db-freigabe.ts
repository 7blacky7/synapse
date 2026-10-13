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
  if(test&&test.port!==live.port&&test.datenbank!==live.datenbank)r.ziele.push({...test,art:'test'});
  return r;
}
