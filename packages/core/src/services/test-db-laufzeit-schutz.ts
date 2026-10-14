/**
 * P10-T65, Rueckbau P10-T71 (14.10.2026, memory regel-datenbanken-nur-prod-gesperrt):
 * Gemeinsamer Oeffner fuer Test-Datenbanken. Einziger Schutz: das Ziel ist NICHT die
 * Synapse-Produktions-DB. Keine Freigabe-Metadaten (SYNAPSE_SHELL_DB_FREIGABE), keine
 * Systemkennung, keine Zuordnungspflicht: synapse_test, Projekt-DBs und Datenbanken in
 * Workspaces (auch zusaetzlich angelegte) werden direkt geoeffnet.
 */
import pg from 'pg';
import {parse as parseVerbindung} from 'pg-connection-string';
import {dbZielAusUrl,type ShellDbFreigabe,type ShellDbZiel} from './shell-db-zuordnung.js';
export interface TestDbClient {
  connect():Promise<unknown>;
  query(text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
  end():Promise<unknown>;
}
/** Bekannte Adresse (Host:Port) der Synapse-Produktions-DB und ihr Datenbankname. */
const PROD_HOST_PORTS=new Set(['192.168.50.65:5432']);
const PROD_DB_NAME='synapse';
/**
 * P10-T71 Nachbesserung (Abnahme d996c097): Ziel wie pg/libpq es verbindet. pg-connection-string wertet
 * ?host=/?port=-Overrides aus; ?dbname= ueberschreibt wie bei libpq den Pfad. Fehlender Port = 5432.
 */
function rohZiel(url:string):{host:string;port:string;datenbank:string}|undefined{
  if(!/^postgres(?:ql)?:\/\//i.test(url.trim()))return undefined;
  try{
    const c=parseVerbindung(url.trim()) as ReturnType<typeof parseVerbindung>&{dbname?:string};
    const datenbank=typeof c.dbname==='string'&&c.dbname!==''?c.dbname:(c.database??'');
    return {host:(c.host??'').toLowerCase(),port:c.port?String(c.port):'5432',datenbank};
  }catch{return undefined;}
}
/**
 * true, wenn die URL auf die Synapse-Produktions-DB zeigt (DB 'synapse', bekannte Prod-Adresse,
 * oder dasselbe Ziel wie SYNAPSE_DATABASE_URL bzw. die serverseitige Live-Angabe) oder nicht
 * als postgres-URL lesbar ist. Alle anderen Datenbanken gelten als frei.
 * P10-T71 Nachbesserung: URL ohne DB-Namen (libpq nimmt dann den User-Namen) gilt als Prod;
 * Port+DB der Live-Angabe treffen unabhaengig vom Host (wie die Shell-Erkennung istLiveTeilZiel).
 */
export function istSynapseProdDb(url:string,env:Record<string,string|undefined>=process.env,live?:ShellDbZiel):boolean{
  const z=rohZiel(url);
  if(!z||!z.datenbank)return true;
  if(z.datenbank===PROD_DB_NAME||PROD_HOST_PORTS.has(z.host+':'+z.port))return true;
  for(const p of [live,dbZielAusUrl(env.SYNAPSE_DATABASE_URL)])
    if(p&&p.port===z.port&&p.datenbank===z.datenbank)return true;
  return false;
}
/**
 * Oeffnet die Test-DB direkt. freigabe ist nur noch optional (Live-Ziel als zusaetzliche
 * Prod-Erkennung); die Factory ist ein interner Testanschluss, nie ein Shell-/REST-Parameter.
 */
export async function oeffneGeschuetzteTestDb(
  url:string,freigabe?:ShellDbFreigabe,
  factory:(url:string)=>TestDbClient=(uri)=>new pg.Client({connectionString:uri}),
):Promise<TestDbClient>{
  if(typeof url!=='string'||!url.trim())throw Error('test_db_url_fehlt');
  if(istSynapseProdDb(url,process.env,freigabe?.live))throw Error('test_db_ist_produktion');
  const client=factory(url);
  try{await client.connect();}
  catch(error){try{await client.end();}catch{/* fehlgeschlagene Verbindung */}
    throw Error('test_db_verbindung_fehlgeschlagen: '+((error as Error)?.message??String(error)));}
  return client;
}
/** Shell-Testdateien: DATABASE_URL des Shell-Jobs bzw. der Workspace-Umgebung, ohne Freigabe-Metadaten. */
export async function oeffneGeschuetzteShellTestDb(url=process.env.DATABASE_URL??''):Promise<TestDbClient>{
  return oeffneGeschuetzteTestDb(url);
}
