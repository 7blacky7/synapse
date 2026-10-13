/** P10-T65: ausschließlich geprüfte Testdateien verwenden diesen gemeinsamen Guard. */
import pg from 'pg';
import {dbZielAusUrl,gleichesDbZiel,dbUmgebungPasst,sqlBleibtInDb,type ShellDbFreigabe} from './shell-db-zuordnung.js';
interface TestDbClient {
  connect():Promise<unknown>;
  query(text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
  end():Promise<unknown>;
}
/** Die Factory ist ein interner Testanschluss; nie ein Shell-/REST-Parameter. */
export async function oeffneGeschuetzteTestDb(
  url:string,freigabe:ShellDbFreigabe,
  factory:(url:string)=>TestDbClient=(uri)=>new pg.Client({connectionString:uri}),
){
  const ziel=dbZielAusUrl(url);
  if(!ziel||!freigabe.live||ziel.port===freigabe.live.port||ziel.datenbank===freigabe.live.datenbank||
    ziel.datenbank!=='synapse_test'||!freigabe.ziele.some(z=>z.art==='test'&&gleichesDbZiel(z,ziel)))throw Error('test_db_ziel_nicht_freigegeben');
  const systemId=freigabe.test_system_id;
  if(!systemId||!/^[1-9][0-9]{0,19}$/.test(systemId))throw Error('test_db_kennung_fehlt');
  if(!dbUmgebungPasst(process.env,ziel))throw Error('test_db_umgebung_abweichend');
  const client=factory(url);
  try{await client.connect();}catch{try{await client.end();}catch{/* fehlgeschlagene Verbindung */}throw Error('test_db_verbindung_fehlgeschlagen');}
  const query=client.query.bind(client);
  let kette:Promise<unknown>=Promise.resolve(),geschlossen=false;
  const guarded={
    query(text:string,values?:unknown[]){
      const run=async()=>{
        if(geschlossen)throw Error('test_db_verbindung_geschlossen');
        if(typeof text!=='string'||!sqlBleibtInDb(text,ziel))throw Error('test_db_sql_ausserhalb');
        // Nach SQL-Fehler lässt PG keine Kontroll-SELECT zu (25P02). Nacktes ROLLBACK
        // verwirft nur die Transaktion derselben Verbindung; jede folgende Nutzabfrage
        // prüft DB/Cluster/User erneut. Keine Werte oder Folge-Statements ausnehmen.
        if(values===undefined&&/^\s*ROLLBACK\s*;?\s*$/i.test(text))return query(text);
        const r=await query('SELECT current_database() AS datenbank, system_identifier::text AS system_id, current_user AS user FROM pg_control_system()');
        const row=r.rows[0];
        if(r.rows.length!==1||!row||row.datenbank!==ziel.datenbank||row.system_id!==systemId||row.user!==ziel.user)
          throw Error('test_db_laufzeit_ziel_abweichend');
        return query(text,values);
      };
      const result=kette.then(run);kette=result.catch(()=>undefined);return result;
    },
    async end(){await kette;geschlossen=true;await client.end();},
  };
  // Rohclient, Pool und Verbindungskonfiguration werden nicht an das Testskript ausgegeben.
  return Object.freeze(guarded);
}
/** Shell-Testdateien beziehen den Sollwert nur aus privaten API-/Daemon-Jobmetadaten. */
export async function oeffneGeschuetzteShellTestDb(url=process.env.DATABASE_URL??''){
  let freigabe:ShellDbFreigabe;
  try{freigabe=JSON.parse(process.env.SYNAPSE_SHELL_DB_FREIGABE??'');}catch{throw Error('test_db_servermetadaten_fehlen');}
  if(!freigabe||typeof freigabe.project!=='string'||!Array.isArray(freigabe.ziele))throw Error('test_db_servermetadaten_fehlen');
  return oeffneGeschuetzteTestDb(url,freigabe);
}
