/** P22-T227: projektgebundene Log-Stroeme. Nur bereits maskierte, vollstaendige
 * Pufferstuecke anhaengen; nie bestaetigt demaskierte Rohausgabe uebernehmen.
 * Wiederholungen desselben (job_id, folge) sind idempotent. */
import {createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {registriereHinweisQuelle} from './ausloeser-hinweise.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool-aktiv.js';
import {maskiereShellVorSpeichern} from './shell-maske.js';

export const LOG_STROM_MAX_TEIL_BYTES = 32768;
export const LOG_STROM_MAX_ZEILEN = 1000;
export const LOG_STROM_MAX_ANTWORT_BYTES = 262144;

export async function logStromSchalter(project: string) {
  const s = await leseProfilProduktSchalter('log_strom', project);
  const basis={aktiv:s.aktiv && !s.letzter_fehler, quelle:String(s.quelle), letzter_fehler:s.letzter_fehler, bis:null as string|null};
  if(!internToolAktiv())return basis;
  try {
    const r=await getPool().query<{aktiv:boolean;bis:Date|null}>("SELECT aktiv,bis FROM intern_schalter WHERE name='log_strom' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");
    const z=r.rows[0];
    return z?{...basis,aktiv:z.aktiv,quelle:'intern',bis:z.bis?.toISOString()??null}:basis;
  }catch{return basis;}
}
export function pruefeLogStromName(name: string): string {
  const n = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(n)) throw new Error('log_strom_name_ungueltig');
  return n;
}
async function mussFreigegeben(project:string): Promise<void> {
  const s=await logStromSchalter(project);
  if(!s.aktiv) throw new Error('log_strom_funktion_aus');
}
/** Der Transport verifiziert zuvor Job, Projekt und Eigentum des sendenden Daemons. */
export async function haengeLogStromTeilAn(project:string,name:string,jobId:string,folge:number,inhalt:string):Promise<boolean> {
  await mussFreigegeben(project);
  name=pruefeLogStromName(name);
  if(!Number.isInteger(folge)||folge<0||Buffer.byteLength(inhalt,'utf8')>LOG_STROM_MAX_TEIL_BYTES) throw new Error('log_strom_teil_ungueltig');
  if(!inhalt) return false;
  const safe=await maskiereShellVorSpeichern(project,{inhalt});
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO shell_log_stroeme(project,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[project,name]);
    const r=await db.query('INSERT INTO shell_log_strom_teile(project,name,job_id,folge,inhalt) VALUES($1,$2,$3::uuid,$4,$5) ON CONFLICT(job_id,folge) DO NOTHING RETURNING id',[project,name,jobId,folge,safe.inhalt]);
    if(r.rowCount) {
      await db.query('UPDATE shell_log_stroeme SET aktualisiert_am=NOW() WHERE project=$1 AND name=$2',[project,name]);
      await db.query("SELECT pg_notify('synapse_log_strom',json_build_object('project',$1::text,'op','append','id',$2::text)::text)",[project,name]);
    }
    await db.query('COMMIT');
    return !!r.rowCount;
  } catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}

/** Abgleich beim Jobabschluss: nur den nachweislich fehlenden maskierten Rest anhaengen.
 * Der feste Marker hat eine reservierte Folge und ist bei erneuter Abschlussmeldung idempotent. */
export async function gleicheLogStromAbschlussAn(project:string,name:string,jobId:string,output:string|undefined,gekappt:boolean):Promise<void> {
  if(!(await logStromSchalter(project)).aktiv)return;
  const r=await getPool().query<{bisher:string;naechste:number}>(
    "SELECT COALESCE(string_agg(inhalt,'' ORDER BY folge) FILTER (WHERE folge<2147483647),'') AS bisher, COALESCE(MAX(folge) FILTER (WHERE folge<2147483647),-1)+1 AS naechste FROM shell_log_strom_teile WHERE project=$1 AND name=$2 AND job_id=$3::uuid",[project,name,jobId]);
  const bisher=r.rows[0].bisher; let folge=Number(r.rows[0].naechste);
  let rest='',hinweis='';
  if(output===undefined){hinweis='[Log-Strom: Abschlussausgabe nicht verfuegbar; Ausgabe kann fehlen.]';}
  else if(output.startsWith(bisher))rest=output.slice(bisher.length);
  else if(!bisher.startsWith(output)){hinweis='[Log-Strom: Abgleich nicht eindeutig; Ausgabe kann fehlen.]';}
  const zeichen=Array.from(rest);
  for(let i=0;i<zeichen.length;i+=8192)await haengeLogStromTeilAn(project,name,jobId,folge++,zeichen.slice(i,i+8192).join(''));
  if(gekappt)hinweis += (hinweis?' ':'')+'[Jobabschluss gekappt; der Log-Strom kann zusaetzliche Live-Teile enthalten.]';
  if(hinweis)await haengeLogStromTeilAn(project,name,jobId,2147483647,'\n'+hinweis+'\n');
}

/** P22-T227: Workspace-Laeufe stehen wie Daemon-Jobs in shell_jobs; Sperre serialisiert Start und Loeschen. */
export async function beginneWorkspaceLogStrom(project:string,name:string,jobId:string,command:string,agent:string|null) {
 await mussFreigegeben(project); name=pruefeLogStromName(name);
 const sicher=await maskiereShellVorSpeichern(project,{command});
 const db=await getPool().connect();
 try {
  await db.query('BEGIN');
  await db.query('INSERT INTO shell_log_stroeme(project,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[project,name]);
  await db.query('SELECT 1 FROM shell_log_stroeme WHERE project=$1 AND name=$2 FOR UPDATE',[project,name]);
  await db.query("INSERT INTO shell_jobs(id,project,command,status,agent_id,claimed_by,claimed_at,log_strom) VALUES($1::uuid,$2,$3,'running',$4,'workspace',NOW(),$5)",[jobId,project,sicher.command,agent,name]);
  await db.query('COMMIT');
 } catch(e){await db.query('ROLLBACK');throw e;} finally {db.release();}
}
/** Abschluss erst nach belegtem Prozessende; unklare Laeufe bleiben zum Schutz running. */
export async function beendeWorkspaceLogStrom(project:string,jobId:string,erfolgreich=true) {
 await getPool().query("UPDATE shell_jobs SET status=$3::shell_job_status,completed_at=NOW(),updated_at=NOW() WHERE id=$1::uuid AND project=$2 AND claimed_by='workspace' AND status='running'",[jobId,project,erfolgreich?'done':'failed']);
}

/** Kein automatisches Loeschen: nur Koordinator/User und kein laufender Job. */
export async function entferneLogStrom(project:string,name:string,actor:string) {
  await mussFreigegeben(project); name=pruefeLogStromName(name);
  const {darfKoordinatorOderUser}=await import('./rollen-pruefung.js');
  if(!darfKoordinatorOderUser(actor))throw new Error('log_strom_recht_fehlt');
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT 1 FROM shell_log_stroeme WHERE project=$1 AND name=$2 FOR UPDATE',[project,name]);
    const r=await db.query("DELETE FROM shell_log_stroeme s WHERE project=$1 AND name=$2 AND NOT EXISTS (SELECT 1 FROM shell_jobs j WHERE j.project=s.project AND j.log_strom=s.name AND j.status IN ('pending','running')) RETURNING name",[project,name]);
    await db.query('COMMIT');return {entfernt:!!r.rowCount};
  } catch(e){await db.query('ROLLBACK');throw e;} finally {db.release();}
}
export async function veralteteLogStroeme(project:string) {
  const schalter=await logStromSchalter(project);
  if(!schalter.aktiv)return {stroeme:[],schalter,tage:0};
  const {leseArtefaktVorlagenEinstellungen}=await import('./artefakt-vorlagen.js');
  const einstellungen=await leseArtefaktVorlagenEinstellungen();
  const tage=einstellungen.werte.log_strom_veraltet_tage;
  const r=await getPool().query<{name:string;aktualisiert_am:Date}>(
    "SELECT name,aktualisiert_am FROM shell_log_stroeme WHERE project=$1 AND aktualisiert_am < NOW()-($2::integer * interval '1 day') ORDER BY aktualisiert_am LIMIT 20",[project,tage]);
  return {stroeme:r.rows,schalter,tage,einstellung:einstellungen.einstellungen.log_strom_veraltet_tage};
}
let hinweisRegistriert=false;
export function initialisiereLogStromHinweise():void {
  if(hinweisRegistriert)return;
  registriereHinweisQuelle({quelle_id:'log_strom_veraltet',async pruefe(k){
    const {darfKoordinatorOderUser}=await import('./rollen-pruefung.js');
    if(!k.projekt || !darfKoordinatorOderUser(k.agent_id))return [];
    const r=await veralteteLogStroeme(k.projekt);
    return r.stroeme.map(z=>({hinweis_id:z.name,modus:'bis_erledigt' as const,
      text:'Log-Strom '+z.name+' veraltet seit '+new Date(new Date(z.aktualisiert_am).getTime()+(r.tage??0)*86400000).toISOString()+', bitte entfernen.',
      folgeaktion:{tool:'shell',aktion:'log_loeschen',argumente:{project:k.projekt,log_strom:z.name}}}));
  }});
  hinweisRegistriert=true;
}

export async function leseLogStromEnde(project:string,name:string,limit=100,maxBytes=LOG_STROM_MAX_ANTWORT_BYTES) {
  const schalter=await logStromSchalter(project);
  if(!schalter.aktiv)throw new Error('log_strom_funktion_aus');
  name=pruefeLogStromName(name);
  const n=Number.isFinite(limit)?Math.max(1,Math.min(LOG_STROM_MAX_ZEILEN,Math.trunc(limit))):100;
  const pool=getPool();
  const meta=(await pool.query<{aktualisiert_am:Date}>('SELECT aktualisiert_am FROM shell_log_stroeme WHERE project=$1 AND name=$2',[project,name])).rows[0];
  if(!meta) throw new Error('log_strom_unbekannt');
  const teile=(await pool.query<{inhalt:string}>('SELECT inhalt FROM shell_log_strom_teile WHERE project=$1 AND name=$2 ORDER BY id DESC LIMIT 128',[project,name])).rows.reverse();
  const komplett=teile.map(t=>t.inhalt).join('');
  const zeilen=komplett.split('\n');
  if(zeilen.at(-1)==='')zeilen.pop();
  let ende=zeilen.slice(-n);
  let gekappt=zeilen.length>n||teile.length===128;
  const budget=Math.max(256,Math.min(LOG_STROM_MAX_ANTWORT_BYTES,Number.isFinite(maxBytes)?Math.trunc(maxBytes)-512:LOG_STROM_MAX_ANTWORT_BYTES));
  const groesse=(v:string[])=>Buffer.byteLength(JSON.stringify(v),'utf8');
  while(ende.length>1 && groesse(ende)>budget){ende.shift();gekappt=true;}
  if(ende.length===1 && groesse(ende)>budget){
    const chars=Array.from(ende[0]); let lo=0,hi=chars.length;
    while(lo<hi){const m=Math.ceil((lo+hi)/2);if(groesse([chars.slice(-m).join('')])<=budget)lo=m;else hi=m-1;}
    ende=[lo?chars.slice(-lo).join(''):''];gekappt=true;
  }
  return {project,name,zeilen:ende,stand:meta.aktualisiert_am,hash:createHash('sha256').update(ende.join('\n')).digest('hex'),gekappt,
    debug:{teile:teile.length,limit:n,max_bytes:budget,schalter_quelle:schalter.quelle,letzte_zeile_am:meta.aktualisiert_am}};
}
