/**
 * P10-T68/P10-T72: private Workspace-Umgebung, keine DSN aus Request-/Testdaten.
 * P10-T72 (14.10.2026): kein Projekt-Sonderfall mehr. Fuer JEDES Projekt bleibt DATABASE_URL nur, wenn sie
 * genau die registrierte Projekt-DB ist, die die serverseitige Freigabe als art 'projekt' belegt, und weder
 * Port noch DB der System-DB traegt. Der fruehere Fallback SYNAPSE_TEST_DATABASE_URL nur fuer synapse entfaellt:
 * synapse bekommt synapse_test wie jedes Projekt ueber projekt_datenbanken (project(projekt_db, uebernehmen)).
 * serverEnv bleibt aus Kompatibilitaet in der Signatur und wird nicht mehr gelesen.
 */
import {dbZielAusUrl,gleichesDbZiel,type ShellDbFreigabe} from '@synapse/core';
export function workspaceJobDatenbank(project:string,env:NodeJS.ProcessEnv,freigabe:ShellDbFreigabe,_serverEnv:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const result={...env};
 const eigen=dbZielAusUrl(result.DATABASE_URL);
 if(eigen&&freigabe.live&&freigabe.project===project&&eigen.port!==freigabe.live.port&&eigen.datenbank!==freigabe.live.datenbank&&
   freigabe.ziele.some(z=>z.art==='projekt'&&gleichesDbZiel(z,eigen)))return result;
 delete result.DATABASE_URL; // Kein geerbter/zufaelliger Zugang, fuer kein Projekt.
 return result;
}
