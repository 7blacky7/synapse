/** P10-T68: private Workspace-Umgebung, keine DSN aus Request-/Testdaten. */
import {dbZielAusUrl,gleichesDbZiel,type ShellDbFreigabe} from '@synapse/core';
export function workspaceJobDatenbank(project:string,env:NodeJS.ProcessEnv,freigabe:ShellDbFreigabe,serverEnv:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const result={...env};
 if(project!=='synapse')return result; // Registry-Projektzugang kommt bereits aus baueJobUmgebung.
 delete result.DATABASE_URL; // Kein geerbter/zufälliger Zugang darf zum Systemprojekt zurückkehren.
 const uri=serverEnv.SYNAPSE_TEST_DATABASE_URL,target=dbZielAusUrl(uri);
 if(uri&&target&&freigabe.live&&target.datenbank==='synapse_test'&&target.port!==freigabe.live.port&&
   target.datenbank!==freigabe.live.datenbank&&freigabe.project===project&&
   freigabe.ziele.some(z=>z.art==='test'&&gleichesDbZiel(z,target)))result.DATABASE_URL=uri;
 return result;
}
