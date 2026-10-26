/** P22-T191: Artefakt-Grenzen im bestehenden admin-/Web-UI-Rechtepfad. */
import {getPool} from '../db/client.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter,ProfilVerwaltungFehler} from './agent-profil-verwalter.js';
import type {AusweisAkteur} from './agent-profil-vertrag.js';
import {artefaktDateiSchalter,ArtefaktDateiFehler} from './artefakt-katalog.js';
import {leseArtefaktDateiEinstellungen,setzeArtefaktDateiEinstellungen} from './artefakt-dateien.js';
export const ARTEFAKT_ADMIN_PARAMETER={artefakt_werte:{type:'object',additionalProperties:{type:'number'},description:'artefakt_einstellungen: Antwort-/Seitenbudgets in Bytes, seite_zeilen, ttl_stunden, bereinigung_max.'}};
export async function fuehreArtefaktAdminAus(args:Record<string,unknown>,vorgegeben?:AusweisAkteur|null):Promise<Record<string,unknown>>{
 try{
  const project=typeof args.project==='string'?args.project:'',wer=vorgegeben??aktuellerW1bAkteur();
  if(!wer)throw new ProfilVerwaltungFehler('recht_fehlt');
  let von:string;
  if(wer.art==='identitaet'&&wer.principal.rolle==='main'&&wer.principal.project===project){
   const p=wer.principal;
   if(!(await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",[p.identity_id,project])).rows[0])throw new ProfilVerwaltungFehler('recht_fehlt');
   von=p.identity_id;
  }else von=(await pruefeProfilVerwalter(wer,project)).wer;
  const modus=args.modus??'status';
  if(modus!=='status'&&modus!=='setzen')throw new ProfilVerwaltungFehler('modus_ungueltig');
  if(modus==='setzen')await setzeArtefaktDateiEinstellungen({werte:args.artefakt_werte,grund:args.grund},von);
  return {success:true,action:'artefakt_einstellungen',...await leseArtefaktDateiEinstellungen(),
   schalter:{artefakt_dateien:await artefaktDateiSchalter('artefakt_dateien',project),tool_antwort_ueberlauf:await artefaktDateiSchalter('tool_antwort_ueberlauf',project)}};
 }catch(e){return {success:false,error:e instanceof ProfilVerwaltungFehler||e instanceof ArtefaktDateiFehler?e.code:'artefakt_einstellungen_fehler'};}
}
