/** P6-T3: unabhängiger Plattenvergleich vor Plan/Commit, niemals eine Kopie des PG-Hashes. */
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {daemonUebersicht,sendeAnDaemon} from './daemon-bruecke.js';
import {syncDateiLokal} from './intern-diagnose-daemon.js';

export interface FsPruefung {
  status: 'gleich' | 'drift' | 'ungeprueft';
  dateien: Array<Record<string,unknown>>;
}
export class FsDriftFehler extends Error {
  readonly name='FsDriftFehler';
  constructor(readonly fs_pruefung:FsPruefung) {
    super('Platte weicht von PostgreSQL ab. Nichts geschrieben. Betroffene Zeilen/Diff prüfen, FS→PG-Sync abwarten und Plan an den aktuellen Stand anpassen.');
  }
}
export function fsDriftAntwort(fehler:FsDriftFehler):Record<string,unknown> {
  return {success:false,error:'fs_drift',geschrieben:false,fs_pruefung:fehler.fs_pruefung,message:fehler.message};
}
export async function pruefeFsDrift(project:string,pfade:string[]):Promise<FsPruefung> {
  const files=[...new Set(pfade)];
  const result:FsPruefung={status:'gleich',dateien:[]};
  if(!files.length)return result;
  const {rows:ziele}=await getPool().query<{hostname:string;path:string}>(
    "SELECT DISTINCT hostname,path FROM projects WHERE name=$1 AND path NOT LIKE '/virtual/%'",[project]);
  const ziel=ziele.length===1?ziele[0]:undefined;
  const lokal=ziel?.hostname===hostname();
  const verbunden=ziel&&daemonUebersicht().some(d=>d.verbunden&&d.host===ziel.hostname);
  if(!ziel||(!lokal&&!verbunden)) {
    return {status:'ungeprueft',dateien:files.map(file_path=>({file_path,status:'ungeprueft',grund:!ziel?'Kein eindeutiger physischer Projekt-Host':'Ziel-Daemon nicht verbunden'}))};
  }
  // Gesamtbudget statt Anzahl Dateien mal Timeout; vier parallele Leseproben.
  const deadline=Date.now()+5000;
  let index=0;
  const worker=async()=>{
    while(index<files.length){
      const file_path=files[index++];
      const eintrag:Record<string,unknown>={file_path,host:ziel.hostname,status:'ungeprueft'};
      result.dateien.push(eintrag);
      try {
        if(Date.now()>=deadline)throw new Error('FS-Prüfbudget erschöpft');
        const {rows}=await getPool().query<{content:string|null;deleted_at:unknown}>(
          'SELECT content,deleted_at FROM code_files WHERE project=$1 AND file_path=$2',[project,file_path]);
        const vorhanden=!!rows[0]&&!rows[0].deleted_at;
        if(vorhanden&&rows[0].content===null)throw new Error('PG-Inhalt nicht lesbar');
        const pgHash=vorhanden?createHash('sha256').update(rows[0].content!).digest('hex'):null;
        const probe=lokal
          ? await syncDateiLokal(project,file_path,ziel.path,'lokal',true)
          : (await sendeAnDaemon('sync_datei',{project,file_path,mit_diff:true},ziel.hostname,Math.max(1,deadline-Date.now()))).ergebnis;
        const platte=probe.platte as Record<string,unknown>|undefined;
        if(probe.success!==true||!platte||platte.fehler||typeof platte.existiert!=='boolean')throw new Error('Plattenstand nicht lesbar');
        if(platte.verzeichnis||platte.utf8_gueltig===false)throw new Error('Kein prüfbarer UTF-8-Dateiinhalt');
        if(platte.existiert&&typeof platte.sha256!=='string')throw new Error('Plattenhash fehlt');
        const fsHash=platte.existiert?String(platte.sha256):null;
        Object.assign(eintrag,{pg_hash:pgHash,fs_hash:fsHash,pg_existiert:vorhanden,fs_existiert:platte.existiert});
        if(pgHash===fsHash){eintrag.status='gleich';continue}
        eintrag.status='drift';
        eintrag.grund=probe.bekannte_version?'sync_rueckstand':'lokale_abweichung';
        eintrag.diff=probe.drift_diff??{nicht_verfuegbar:'Daemon liefert noch keinen Diff; Hashabweichung bleibt gesperrt'};
        eintrag.ansehen={action:'sync_inspektor',project,file_path,prozess:'daemon:'+ziel.hostname};
        eintrag.was_tun='Diff/Zeilen prüfen; nach FS→PG-Abgleich code_intel(file) für diese Bereiche lesen und plan_update verwenden.';
      }catch(err){eintrag.grund=err instanceof Error?err.message:String(err)}
    }
  };
  await Promise.all(Array.from({length:Math.min(4,files.length)},worker));
  result.dateien.sort((a,b)=>files.indexOf(String(a.file_path))-files.indexOf(String(b.file_path)));
  result.status=result.dateien.some(d=>d.status==='drift')?'drift':result.dateien.some(d=>d.status==='ungeprueft')?'ungeprueft':'gleich';
  if(result.status==='drift')throw new FsDriftFehler(result);
  return result;
}
