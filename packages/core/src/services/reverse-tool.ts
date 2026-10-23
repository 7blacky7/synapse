/**
 * RV9: eine Definition und ein serverseitiger Dispatcher für die Reverse-Bibliothek.
 * Originalbytes und Code/Assets werden hier niemals vom PC gelesen. RV10/RV8 ergänzen
 * diese Grenze später. Alle SQL-Werte sind gebunden; Projektinhalt bleibt getrennt.
 */
import {fordereReverseAdmission,reverseAdmissionDiagnose} from './reverse-pipeline-halt.js';
import {sperreReversePolicy} from './reverse-analyse-policy.js';
import { aktuelleAgentAkteurIdentityId, aktuellerAgentAufruf } from './agent-bezug.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { pruefeUnbekannteParameter } from './unbekannte-parameter.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';
import { maskiereMitKatalog } from './masken-katalog.js';
import { erfasseToolAktivitaet } from './tool-aktivitaet.js';
import { REVERSE_CODE_ACTIONS, ReverseCodeFehler, fuehreReverseCodeAus } from './reverse-code-tool.js';
import { REVERSE_ASSET_ACTIONS, ReverseAssetFehler, fuehreReverseAssetAus } from './reverse-asset-tool.js';
import { uebernehmeReverseAsset, ReverseUebernahmeFehler } from './reverse-uebernehmen.js';
import { fuehreReverseAnsichtAus } from './reverse-ansicht-ausgabe.js';
import { ANSICHT_SCHEMA_PROPERTIES, setzeMcpBilder, trenneMcpBilder } from './asset-ansicht-ausgabe.js';
import { zerlegeReverseFehlercode } from './reverse-ausfuehrer.js';
import { gruppiereRv27Dateien } from './hex-rv27.js';
import { diagnoseReverse, entstoereReverse, REVERSE_ENTSTOERBAR } from './reverse-entstoerer.js';
import { leseReverseFortschrittSchalter, reverseFortschrittAnzeige, REVERSE_FORTSCHRITT_SQL, type ReverseFortschrittStand } from './reverse-fortschritt.js';
import {leseReverseVerknuepfungen} from './reverse-verknuepfungen.js';
import {leseReverseEinstellungen,leseReverseSpeicherVerbrauch} from './reverse-einstellungen.js';
import {leseReverseEinstellwerte,reverseZahl,reverseWert,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {REVERSE_EINSTELLKATALOG} from './reverse-einstellkatalog.js';
import { vorhandeneZielfelder, zielinhaltHerkunft } from './zielinhalt.js';
import {reverseEintragSichtbar,reverseGlobalSichtbar,leseReverseStand} from './reverse-sichtbarkeit.js';
import {leseReverseFehlerlog,loggeReverseFehler,reverseFehlerlogAktiv} from './reverse-fehlerlog.js';

import {ERKENNTNIS_ACTIONS,ERKENNTNIS_PARAMETER,ERKENNTNIS_FELDER,fuehreErkenntnisAus,ErkenntnisFehler} from './reverse-erkenntnisse.js';

import {LESER_ACTIONS,LESER_PARAMETER,LESER_FELDER,fuehreReverseLeserAus} from './reverse-leser-tool.js';
import {ReverseLeserFehler} from './reverse-leser-vertrag.js';
import {LESER_RUNTIME_ACTIONS,LESER_RUNTIME_PARAMETER,LESER_RUNTIME_FELDER,fuehreLeserRuntimeAus} from './reverse-leser-runtime-tool.js';
import type {LeserRuntimeImage} from './reverse-leser-runtime-vertrag.js';
import {ergaenzeReverseLeserHinweisKontext} from './reverse-leser-hinweis.js';

export const REVERSE_ACTIONS = ['liste','eintrag','vorschlaege','bestaetigen','archivieren','binden','loesen','bindungen','status','analysieren','abbrechen','dateien','diagnose','entstoeren',...ERKENNTNIS_ACTIONS,...LESER_ACTIONS,...LESER_RUNTIME_ACTIONS,...REVERSE_CODE_ACTIONS,...REVERSE_ASSET_ACTIONS,'ansicht','uebernehmen','struktur','verknuepfungen'] as const;
export type ReverseAction = typeof REVERSE_ACTIONS[number];
export const REVERSE_FEHLERCODES = ['nicht_gefunden','nicht_gebunden','nicht_unterstuetzt','gepackt','verschluesselt','beschaedigt','zu_gross','bombe_verdacht','pfad_gefahr','zeitlimit','speicherlimit','werkzeug_fehler','container_ruht','container_gesperrt','warteschlange_voll','schicht_nicht_fertig','ziel_belegt','keine_berechtigung','ansicht_nicht_darstellbar','semantik_nicht_verfuegbar','kein_ausfuehrer','format_nicht_unterstuetzt','policy_pin_fehlt','policy_geaendert','policy_grenze','policy_nicht_lesbar'] as const;
export type ReverseFehlercode = typeof REVERSE_FEHLERCODES[number];
const TEXTE: Record<ReverseFehlercode,string> = {
  policy_pin_fehlt:'Analyse gehalten: Altauftrag ohne verlässlichen Policy-Pin. Neuen Auftrag ausdrücklich anfordern.',policy_geaendert:'Analyse gehalten: Policy oder Quellstand geändert.',policy_grenze:'Analyse durch Eintrags-/Auftragsgrenze begrenzt.',policy_nicht_lesbar:'Analyse gehalten: Policy nicht zuverlässig lesbar.',
  nicht_gefunden:'Eintrag, Datei oder Auftrag nicht gefunden.',nicht_gebunden:'Eintrag zuerst für dieses Projekt binden: reverse(action:"binden", reverse_id).',
  nicht_unterstuetzt:'Aktion oder Format wird nicht unterstützt.',gepackt:'Datei ist gepackt.',verschluesselt:'Datei ist verschlüsselt.',
  beschaedigt:'Datei ist beschädigt.',zu_gross:'Größenlimit überschritten.',bombe_verdacht:'Verdacht auf eine Archivbombe.',
  pfad_gefahr:'Nur sichere relative Reverse-Pfade sind erlaubt.',zeitlimit:'Zeitlimit überschritten.',speicherlimit:'Speicherlimit überschritten.',
  werkzeug_fehler:'Reverse-Werkzeug konnte die Anfrage nicht verarbeiten.',container_ruht:'Auftrag eingereiht; der Werkzeug-Container ruht.',
  container_gesperrt:'Werkzeug-Container oder notwendiger Anschluss ist gesperrt.',warteschlange_voll:'Die Warteschlange ist voll.',
  schicht_nicht_fertig:'Die angefragte Schicht ist noch nicht fertig.',ziel_belegt:'Ziel oder bestätigter Fingerabdruck bereits belegt.',
  keine_berechtigung:'Keine Berechtigung für diese Aktion oder dieses Projekt.',ansicht_nicht_darstellbar:'Für dieses Asset ist keine Ansicht verfügbar.',
  semantik_nicht_verfuegbar:'Semantische Reverse-Suche ist noch nicht verfügbar.',
  kein_ausfuehrer:'Für diesen Auftragstyp ist kein Ausführer angemeldet; der Auftrag wird nicht abgearbeitet.',
  format_nicht_unterstuetzt:'Dieses Medienformat wird noch nicht unterstützt (siehe fehler_detail).',
};
const mediumSchema = {type:'object',properties:{id:{type:'string'},bezeichnung:{type:'string'},art:{type:'string',enum:['image','ordner','archiv']}},required:['id'],additionalProperties:false};
export const REVERSE_DEFINITION = {
  name:'reverse',description:'Globale Reverse-Bibliothek: Grunddaten für alle, Inhalte erst nach Projektbindung. liste/eintrag/vorschlaege; bestaetigen/archivieren nur Koordinator/User; binden/loesen/bindungen; status (optional Long-Poll bis 50s), analysieren, abbrechen (eigener Auftrag/Koordinator); dateien = seitenweise Dateiliste eines gebundenen Eintrags (Originale und entpackte Dateien, optional path als Ordnerpräfix). status nennt alle offenen auftrag_ids (auftraege). diagnose (jeder, lesend): offene/hängende Aufträge mit Ursache, Container-Zustand und automatischen Maßnahmen, optional reverse_id. entstoeren (nur Koordinator/User, vorschau Standard true): ausführerlose Aufträge stornieren, abgelaufene Leases freigeben, hängenden Reverse-Container neu starten; Filter ursache/reverse_id/auftrag_id; läuft auch automatisch. Analyse asynchron, keine lokale Byteausführung. Code: verknuepfungen(datei|gruppe|funktion) ordnet Stringreferenzen an Dateien zu, nennt Funktionen und rückwärtige Aufrufer (Produkt reverse_verknuepfungen, Standard AUS); gruppe z.B. GFX oder .dat; struktur ergänzt geladen_von. vergleichen(datei_a,datei_b) vergleicht S3-Funktionen mit Unsicherheitskennzeichnung und Paging; funktion = Symbol-ID für Diff. tree/functions/symbols/references/search/file/calls über gebundene Reverse-Schichten; virtuelle Pfade, Paging, Volltext und begrenzte Textfenster. Assets: assets_tree (path/depth/recursive/limit/format/asset_type) und inspect (datei oder file_path, objects_offset/objects_limit/object_type/references_limit) über denselben Asset-Leser, nur gebundene Einträge. ansicht (datei/file_path, ansicht inline|link|beides, offen_sekunden, einmalig) über den gemeinsamen Vorschau-Dienst; Revision und Link an sha256 gebunden, Bild als MCP-image-Block. Leser: leser_liste/get lesen registrierte Versionen; leser_registrieren pinnt files-Versionen, leser_testen führt isolierte Tests ohne Publikation aus (reverse_leser EIN); leser_aktivieren/deaktivieren nur Verwaltung; leser_nachziehen bereitet ausschließlich vor. Leser-Runtime: leser_runtime_liste/get zeigen PG-Pins; leser_runtime_bereitstellen (vorschau Standard true) erzeugt RO-Snapshots aus files-Versionen; leser_runtime_aktivieren/deaktivieren setzen den globalen Standard je serverseitigem Image mit CAS/Audit, nur Verwaltung. Feste Dateifelder und Fehlercodes; unbekannte Parameter werden gemeldet.',
  inputSchema:{type:'object',properties:{
    action:{type:'string',enum:[...REVERSE_ACTIONS]},agent_id:{type:'string',description:'Agent-ID, Pflicht'},
    project:{type:'string',description:'Projekt für Bindung, Dateistatus und Analyse'},
    reverse_id:{type:'string',description:'Reverse-Eintrag-ID'},
    status:{type:'string',enum:['vorschlag','bestaetigt','archiviert']},tag:{type:'string'},query:{type:'string'},
    limit:{type:'number',description:'Seitengröße, begrenzt durch API-Konfiguration'},offset:{type:'number'},
    titel:{type:'string'},medien:{type:'array',items:mediumSchema,description:'Alle Medien in gewünschter Reihenfolge, optionale Bezeichnungen'},
    zusammenfuehren_mit:{type:'string',description:'Unanalysierten Vorschlag in diesen Ziel-Eintrag zusammenführen'},
    aufteilen:{type:'array',items:{type:'object',properties:{titel:{type:'string'},medien:{type:'array',items:{type:'string'}}},required:['titel','medien'],additionalProperties:false},description:'Vorschlag vor der Analyse in vollständige disjunkte Mediengruppen aufteilen'},
    notiz:{type:'string'},datei:{type:'string',description:'Relativer Reverse-Dateipfad'},file_path:{type:'string',description:'Alias für datei bei status/analysieren; Code-Aktionen nutzen virtuelle Pfade <Original>@S1/strings.txt, @S2/<Funktion>.asm oder @S3/<Funktion>.c'},
    datei_a:{type:'string',description:'vergleichen: erster Originalpfad im Reverse-Eintrag'},datei_b:{type:'string',description:'vergleichen: zweiter Originalpfad; beide brauchen S3 (reverse_s3)'},
    gruppe:{type:'string',description:'verknuepfungen: Dateimuster, Endung (.dat) oder Ordnergruppe (GFX)'},
    funktion:{type:'string',description:'verknuepfungen: exakter Funktionsname oder Symbol-ID (auch rückwärtige Aufrufer); vergleichen: Symbol-ID aus unterschiede für Rohtext-Diff; from_line/to_line paginieren Diff-Zeilen'},
    warten_sekunden:{type:'number',minimum:0,maximum:50},
    ursache:{type:'array',items:{type:'string',enum:[...REVERSE_ENTSTOERBAR]},description:'entstoeren: nur diese Ursachen (Standard alle entstörbaren)'},
    vorschau:{type:'boolean',description:'entstoeren: Standard true = nur zeigen; false = ausführen'},bis_schicht:{type:'string',enum:['E','S0','S1','S2','S3']},
    prioritaet:{type:'string',enum:['interaktiv','hintergrund','nachzug']},auftrag_id:{type:'string'},
    path:{type:'string'},name:{type:'string'},symbol_type:{type:'string'},file_type:{type:'string'},callee:{type:'string'},
    from_line:{type:'number'},to_line:{type:'number'},truncate_long_lines:{type:'number'},
    semantic:{type:'boolean'},exported_only:{type:'boolean'},include_name_matches:{type:'boolean'},value_contains:{type:'string'},
    min_laenge:{type:'number'},match_limit:{type:'number'},match_skip:{type:'number'},depth:{type:'number'},recursive:{type:'boolean'},
    show_functions:{type:'boolean'},show_counts:{type:'boolean'},show_lines:{type:'boolean'},
    format:{type:'string'},asset_type:{type:'string'},objects_offset:{type:'number'},objects_limit:{type:'number'},object_type:{type:'string'},references_limit:{type:'number'},
    ziel_pfad:{type:'string',description:'Projektpfad 1:1; Übernahme ausschließlich von Assets'},ueberschreiben:{type:'boolean',default:false},
    ...ANSICHT_SCHEMA_PROPERTIES,
    ...ERKENNTNIS_PARAMETER,
    ...LESER_PARAMETER,
    ...LESER_RUNTIME_PARAMETER,
  },required:['action','agent_id']},
  outputSchema:{type:'object',properties:{
    success:{type:'boolean'},reverse_id:{type:['string','null']},datei:{type:['string','null']},
    format:{type:['string','null']},arch:{type:['string','null']},bits:{type:['number','null']},
    schicht:{type:['string','null']},schicht_angefragt:{type:['string','null']},status:{type:'string'},
    fehlercode:{type:['string','null'],enum:[...REVERSE_FEHLERCODES,null]},werkzeug:{type:['string','null']},
    merkmale:{type:'array',items:{type:'string'}},fortschritt:{type:'object',properties:{gesamt:{type:'number'},fertig:{type:'number'}},required:['gesamt','fertig']},
    container:{type:'object',properties:{zustand:{type:'string',enum:['ruht','startet','laeuft']},kaltstart_s:{type:['number','null']}},required:['zustand','kaltstart_s']},
  },required:['success','reverse_id','datei','format','arch','bits','schicht','schicht_angefragt','status','fehlercode','werkzeug','merkmale','fortschritt','container'],additionalProperties:true},
} as const;
const JE_ACTION: Record<ReverseAction,readonly string[]> = {
  ...ERKENNTNIS_FELDER,
  ...LESER_FELDER,
  ...LESER_RUNTIME_FELDER,
  liste:['status','tag','query','limit','offset'],vorschlaege:['tag','query','limit','offset'],
  eintrag:['reverse_id'],bestaetigen:['reverse_id','titel','medien','zusammenfuehren_mit','aufteilen'],
  archivieren:['reverse_id'],binden:['reverse_id','notiz'],loesen:['reverse_id'],bindungen:['limit','offset'],
  status:['reverse_id','datei','file_path','warten_sekunden','limit','offset'],analysieren:['reverse_id','datei','file_path','bis_schicht','prioritaet'],
  abbrechen:['auftrag_id'],dateien:['reverse_id','path','limit','offset'],struktur:['reverse_id','limit','offset'],
  diagnose:['reverse_id','limit'],entstoeren:['reverse_id','ursache','auftrag_id','vorschau'],
  tree:['reverse_id','file_path','path','limit','offset','depth','recursive','show_functions','show_counts','show_lines','file_type'],
  functions:['reverse_id','file_path','name','exported_only','limit','offset'],
  symbols:['reverse_id','file_path','symbol_type','name','value_contains','min_laenge','limit','offset'],
  references:['reverse_id','file_path','name','include_name_matches','limit','offset'],
  search:['reverse_id','file_path','query','file_type','semantic','match_limit','match_skip','limit','offset'],
  file:['reverse_id','file_path','from_line','to_line','truncate_long_lines','min_laenge','limit','offset'],
  calls:['reverse_id','file_path','callee','limit','offset'],
  verknuepfungen:['reverse_id','datei','file_path','gruppe','funktion','limit','offset'],
  vergleichen:['reverse_id','datei_a','datei_b','limit','offset','funktion','from_line','to_line'],
  assets_tree:['reverse_id','path','depth','recursive','limit','format','asset_type'],
  inspect:['reverse_id','datei','file_path','objects_offset','objects_limit','object_type','references_limit'],
  ansicht:['reverse_id','datei','file_path','ansicht','offen_sekunden','einmalig'],
  uebernehmen:['reverse_id','file_path','ziel_pfad','ueberschreiben'],
};
export const REVERSE_NULL_FELDER = ['reverse_id','datei','format','arch','bits','schicht','schicht_angefragt','fehlercode','werkzeug','kaltstart_s','naechster_offset','eta'] as const;
/** P21-T16: Aktionen, deren Antwort Inhalt aus dem Analyseziel traegt, mit Kandidatenfeldern. */
const REVERSE_ZIELINHALT: Partial<Record<ReverseAction,readonly string[]>> = {
  erkenntnis_get:['erkenntnis','versionen[]'],erkenntnis_liste:['erkenntnisse[]'],erkenntnis_speichern:['erkenntnis'],format_anhaengen:['erkenntnis'],
  status:['s3_speicher.fehlende_funktionen[]'],
  verknuepfungen:['links[]'],
  vergleichen:['unterschiede[]','paar','diff[]'],
  tree:['baum'],functions:['functions[]'],symbols:['symbols[]'],references:['references[]','string_occurrences[]','name_matches[]'],
  search:['results[]'],file:['content','strings[]'],calls:['calls[]'],assets_tree:['baum'],inspect:['inspektion'],
  dateien:['dateien[]','container_nicht_entpackt[]'],struktur:['gruppen[]','nicht_analysiert[]','geladen_von[]'],ansicht:['ansicht'],
};
export const REVERSE_AKTIVITAET_DESCRIPTOR = Object.freeze({toolId:'reverse',tool:'reverse',aktivitaetsAktionen:REVERSE_ACTIONS.filter(a=>a!=='status')});
type Db = Pick<Pool|PoolClient,'query'>;
type Row = Record<string,unknown>;
const object = (v:unknown):v is Row => !!v && typeof v==='object'&&!Array.isArray(v);
const str = (v:unknown):string => typeof v==='string'?v:'';
const gesetzt = (v:unknown) => v!==undefined&&v!==null&&v!=='';
const stages = ['E','S0','S1','S2','S3'] as const;
/** P18-T61/E4, P18-T86: Obergrenze der automatischen Analyse = Reverse-Einstellung analyse_bis_schicht (je Eintrag);
 * ohne Snapshot gilt der Katalogstandard. */
export function reverseBisSchichtGrenze(ein?:ReverseEinstellSnapshot):typeof stages[number] {
  return (ein?reverseWert(ein,'analyse_bis_schicht'):REVERSE_EINSTELLKATALOG.analyse_bis_schicht.standard) as typeof stages[number];
}
/** Begrenzt eine gewünschte Schicht auf die konfigurierte Obergrenze; Unbekanntes wird zur Grenze. */
export function begrenzeReverseSchicht(wunsch:unknown,ein?:ReverseEinstellSnapshot):typeof stages[number] {
  const grenze=reverseBisSchichtGrenze(ein);
  if(!stages.includes(wunsch as typeof stages[number]))return grenze;
  return stages.indexOf(wunsch as typeof stages[number])>stages.indexOf(grenze)?grenze:wunsch as typeof stages[number];
}
export interface ReverseContainerInfo {zustand:'laeuft'|'startet'|'ruht';kaltstart_s:number|null;container_id?:string}
export interface ReverseAnalyseAnfrage {reverseId:string;project:string;agentId:string;dateiId:string|null;mediumId:string|null;bisSchicht:string;prioritaet:'interaktiv'|'hintergrund'|'nachzug';policyManuell?:boolean;policyElternId?:string}
export interface ReverseRuntime {
  /** PG-only, derselbe Client wie Fachauftrag und Aktivität. Kein Wake/FS/Docker unter Lock. */
  analysieren?: (anfrage:ReverseAnalyseAnfrage,db:PoolClient)=>Promise<Row>;
  /** P18-T87: darf Zusatzfelder liefern (z. B. storno:'angefordert' bei laufender Containerarbeit). */
  abbrechen?: (auftrag:Row,agentId:string,db:PoolClient)=>Promise<Row|void>;
  /** Nur lesen; nach der PG-Transaktion, keine Lebenszyklusänderung. */
  containerStatus?: (reverseId:string)=>Promise<ReverseContainerInfo>;
  /** T102: Imagekontext aus Serverkonfiguration, kein Docker-/Startbefehl. */
  leserRuntimeImage?: ()=>Promise<LeserRuntimeImage>;
}
export interface ReverseToolDependencies {pool?:Pool;runtime?:ReverseRuntime}
let runtime:ReverseRuntime={};
/** Nur vom API-Start/RV8 setzen, niemals aus Client-Argumenten. */
export function configureReverseRuntime(value:ReverseRuntime):void {runtime={...value};}
/** P18-T59: einzelne Hooks additiv setzen (z. B. containerStatus vom RV12-Executor); Rückgabe nimmt genau diese wieder heraus. */
export function ergaenzeReverseRuntime(value:Partial<ReverseRuntime>):()=>void {
  runtime={...runtime,...value};
  return ()=>{for(const [k,v] of Object.entries(value))if((runtime as Record<string,unknown>)[k]===v)delete (runtime as Record<string,unknown>)[k];};
}
export class ReverseFehler extends Error {
  constructor(readonly code:ReverseFehlercode,readonly detail?:string,readonly extra:Row={}) {super(TEXTE[code]);}
}
function fail(code:ReverseFehlercode,detail?:string,extra:Row={}):never {throw new ReverseFehler(code,detail,extra);}
function integer(v:unknown,fallback:number,max:number):number {
  const n=v===undefined?fallback:Number(v);
  if((typeof v!=='number'&&typeof v!=='string'&&v!==undefined)||!Number.isSafeInteger(n)||n<0||n>max)fail('werkzeug_fehler','parameter_ungueltig');
  return n;
}
function id(v:unknown):string {
  if(typeof v!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(v))fail('werkzeug_fehler','parameter_ungueltig');
  return v;
}
function text(v:unknown,max:number):string {
  if(typeof v!=='string'||v.length>max)fail('werkzeug_fehler','parameter_ungueltig');
  return maskiereMitKatalog(v,'reverse').text;
}
export function pruefeReversePfad(v:unknown,max=Number(REVERSE_EINSTELLKATALOG.max_pfad_zeichen.standard)):string {
  if(typeof v!=='string'||!v||v.startsWith('/')||v.includes('\\')||/[\x00-\x1f]/.test(v)||v.split('/').some(p=>!p||p==='.'||p==='..')||/^[A-Za-z]:/.test(v)||v.length>max)fail('pfad_gefahr');
  return v;
}
function fileArg(a:Row,max?:number):string|null {
  if(gesetzt(a.datei)&&gesetzt(a.file_path)&&a.datei!==a.file_path)fail('werkzeug_fehler','parameter_ungueltig');
  return gesetzt(a.datei??a.file_path)?pruefeReversePfad(a.datei??a.file_path,max):null;
}
/** Jede Antwort, auch Fehler, trägt denselben kleinen maschinenlesbaren Kontext für RV19. */
export function baueReverseAntwort(a:Row,daten:Row={},fehler?:ReverseFehlercode,detail?:string):Row {
  const base:Row={reverse_id:typeof a.reverse_id==='string'?a.reverse_id:null,datei:typeof (a.datei??a.file_path)==='string'?(a.datei??a.file_path):null,
    format:'unbekannt',arch:'unbekannt',bits:null,schicht:null,schicht_angefragt:null,status:fehler?'fehler':'offen',
    fehlercode:fehler??null,werkzeug:null,merkmale:[],fortschritt:{gesamt:0,fertig:0},container:{zustand:'ruht',kaltstart_s:null}};
  for(const k of Object.keys(base))if(Object.hasOwn(daten,k))base[k]=daten[k];
  const antwort:Row={success:!fehler,action:a.action??null,...(typeof a.project==='string'?{project:a.project}:{}),...base,...daten,
    ...(fehler?{fehlercode:fehler,message:TEXTE[fehler]}:{}),...(detail?{fehler:detail}:{}),felder:{...base,fehlercode:fehler??base.fehlercode}};
  return antwort;
}
/** P18-T109: mit reverse_global_sichtbar EIN genügt der vorhandene Eintrag (reverse-sichtbarkeit.ts); AUS = Bindung wie bisher. */
export async function pruefeReverseBindung(db:Db,project:string,reverseId:string):Promise<boolean> {
  return reverseEintragSichtbar(db,project,reverseId);
}

export function createReverseToolService(deps:ReverseToolDependencies={}) {
  const pool=deps.pool??getPool();
  const hooks=()=>({...runtime,...deps.runtime});
  async function tx<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T> {
    const db=await pool.connect();
    try {await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}
    catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
  }
  async function projektRecht(db:Db,a:Row):Promise<string> {
    const project=str(a.project);if(!project)fail('werkzeug_fehler','parameter_fehlt',{parameter:'project'});
    const k=aktuellerAgentAufruf(),p=k?.principal;
    if(k?.bezug.modus!=='alt' && p?.art==='identity'){
      if(p.project!==project)fail('keine_berechtigung');
    }else{
      const r=await db.query('SELECT project FROM agent_sessions WHERE id=$1',[a.agent_id]);
      if(!darfKoordinatorOderUser(a.agent_id)&&r.rows[0]?.project!==project)fail('keine_berechtigung');
    }
    if(!(await db.query('SELECT 1 FROM projects WHERE name=$1 LIMIT 1',[project])).rowCount)fail('nicht_gefunden');
    return project;
  }
  async function entry(db:Db,rid:string,lock=false):Promise<Row> {
    const r=await db.query('SELECT id,titel,beschreibung,status,gruppierung,fingerabdruck,analyse_policy,tags FROM reverse_eintraege WHERE id=$1'+(lock?' FOR UPDATE':''),[rid]);
    if(!r.rows[0])fail('nicht_gefunden');return r.rows[0];
  }
  async function medien(db:Db,rid:string):Promise<Row[]> {
    return (await db.query('SELECT id::text AS id,position,bezeichnung,art,status,fehlercode,groesse,satz_sha256,vorschlag FROM reverse_medien WHERE eintrag_id=$1 ORDER BY position,id',[rid])).rows;
  }
  async function entryDto(db:Db,e:Row):Promise<Row> {
    const ms=await medien(db,str(e.id));
    const layers=(await db.query(`SELECT s.schicht,count(*)::int AS gesamt,count(*) FILTER(WHERE s.status='fertig')::int AS fertig FROM reverse_schichten s
      LEFT JOIN reverse_dateien d ON d.id=s.datei_id LEFT JOIN reverse_medien m ON m.id=s.medium_id
      WHERE s.aktuell AND COALESCE(d.eintrag_id,m.eintrag_id)=$1 GROUP BY s.schicht ORDER BY s.schicht`,[e.id])).rows;
    return {reverse_id:e.id,titel:maskiereMitKatalog(str(e.titel),'reverse').text,beschreibung:maskiereMitKatalog(str(e.beschreibung),'reverse').text,status:e.status,tags:e.tags,
      medien:ms.map(m=>({...m,bezeichnung:maskiereMitKatalog(str(m.bezeichnung),'reverse').text})),schicht_summen:layers,
      dateizahl:Number((await db.query('SELECT count(*)::int AS n FROM reverse_dateien WHERE eintrag_id=$1',[e.id])).rows[0].n),
      bindungen:Number((await db.query('SELECT count(*)::int AS n FROM reverse_bindungen WHERE eintrag_id=$1 AND geloest_at IS NULL',[e.id])).rows[0].n),
      // P18-T109: Stand/Erkenntniszahl nur mit reverse_global_sichtbar EIN (AUS bleibt die Antwort unverändert).
      ...(await reverseGlobalSichtbar(db)?{...await leseReverseStand(db,str(e.id)),sichtbar:'global'}:{})};
  }
  async function activity(db:Db,a:Row,accepted=true):Promise<void> {
    const project=str(a.project);if(!project)return;
    const binding=a.reverse_id
      ? await pruefeReverseBindung(db,project,str(a.reverse_id))
      : (await db.query('SELECT 1 FROM reverse_bindungen WHERE project=$1 AND geloest_at IS NULL LIMIT 1',[project])).rowCount!==0;
    await erfasseToolAktivitaet({project,tool:'reverse',aktion:str(a.action),agentId:str(a.agent_id),akzeptiert:accepted,zaehltAlsAktivitaet:binding&&a.action!=='status'},
      {descriptor:REVERSE_AKTIVITAET_DESCRIPTOR,gebundenesProjekt:binding?project:null,berechtigt:true},db);
  }
  async function list(db:Db,a:Row,ein:ReverseEinstellSnapshot):Promise<Row> {
    const limit=integer(a.limit,reverseZahl(ein,'seiten_limit'),reverseZahl(ein,'max_limit')),tmax=reverseZahl(ein,'parameter_text_zeichen');
    if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
    const offset=integer(a.offset,0,2147483647);
    const status=a.action==='vorschlaege'?'vorschlag':a.status??null;
    if(status!==null&&!['vorschlag','bestaetigt','archiviert'].includes(String(status)))fail('werkzeug_fehler','parameter_ungueltig');
    const tag=gesetzt(a.tag)?text(a.tag,tmax):null,query=gesetzt(a.query)?text(a.query,tmax):null;
    const where=" WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR $2=ANY(tags)) AND ($3::text IS NULL OR strpos(lower(titel||' '||COALESCE(beschreibung,'')),lower($3))>0)";
    const vals=[status,tag,query];
    const total=Number((await db.query('SELECT count(*)::int AS n FROM reverse_eintraege'+where,vals)).rows[0].n);
    const rows=(await db.query('SELECT id,titel,beschreibung,status,tags FROM reverse_eintraege'+where+' ORDER BY id LIMIT $4 OFFSET $5',[...vals,limit,offset])).rows;
    const items:Row[]=[];const max=reverseZahl(ein,'antwort_bytes');
    for(const e of rows){const r=await entryDto(db,e);if(Buffer.byteLength(JSON.stringify(items))+Buffer.byteLength(JSON.stringify(r))>max)break;items.push(r);}
    if(rows.length&&!items.length)fail('zu_gross');
    return {eintraege:items,total,gekappt:offset+items.length<total,naechster_offset:offset+items.length<total?offset+items.length:null};
  }
  async function groupingAllowed(db:Db,rid:string):Promise<void> {
    // Erkenntnisse behalten ihre unveränderliche Eintragszugehörigkeit und gepinnten @ref.
    if((await db.query("SELECT 1 FROM reverse_verweise WHERE eintrag_id=$1 AND ursprung='manuell' LIMIT 1",[rid])).rows.length)fail('ziel_belegt','gruppierung_manuelle_erkenntnisse',{hinweis:'Der Eintrag enthält manuelle Erkenntnisse. Zusammenführen, Aufteilen und Ändern der Medienart sind deshalb gesperrt; Erkenntnisse und Versionen bleiben am bisherigen Eintrag.'});
    const r=await db.query(`SELECT (SELECT count(*) FROM reverse_dateien WHERE eintrag_id=$1)+(SELECT count(*) FROM reverse_auftraege WHERE eintrag_id=$1)+(SELECT count(*) FROM reverse_schichten s JOIN reverse_medien m ON m.id=s.medium_id WHERE m.eintrag_id=$1) AS n`,[rid]);
    if(Number(r.rows[0].n)>0)fail('ziel_belegt','gruppierung_bereits_analysiert');
  }
  async function confirm(db:PoolClient,a:Row,e:Row,ein:ReverseEinstellSnapshot):Promise<Row> {
    if(!darfKoordinatorOderUser(a.agent_id))fail('keine_berechtigung');
    const tmax=reverseZahl(ein,'parameter_text_zeichen');
    if(e.status==='archiviert')fail('keine_berechtigung');
    let rid=str(e.id),ms=await medien(db,rid);
    if(gesetzt(a.zusammenfuehren_mit)&&gesetzt(a.aufteilen))fail('werkzeug_fehler','parameter_ungueltig');
    if(gesetzt(a.zusammenfuehren_mit)){
      const target=id(a.zusammenfuehren_mit);if(target===rid)fail('werkzeug_fehler','parameter_ungueltig');
      const t=await entry(db,target,true);if(t.status==='archiviert')fail('keine_berechtigung');
      await groupingAllowed(db,rid);await groupingAllowed(db,target);
      const pos=Number((await db.query('SELECT COALESCE(max(position),-1)+1 AS n FROM reverse_medien WHERE eintrag_id=$1',[target])).rows[0].n);
      for(const [i,m]of ms.entries())await db.query('UPDATE reverse_medien SET eintrag_id=$1,position=$2 WHERE id=$3',[target,pos+i,m.id]);
      await db.query("UPDATE reverse_eintraege SET status='archiviert',archiviert_at=NOW(),updated_at=NOW() WHERE id=$1",[rid]);
      await db.query('UPDATE reverse_eingang_dateien d SET eintrag_id=m.eintrag_id FROM reverse_medien m WHERE d.medium_id=m.id AND d.eintrag_id=$1',[rid]);
      rid=target;ms=await medien(db,rid);
    }
    if(gesetzt(a.aufteilen)){
      await groupingAllowed(db,rid);
      if(!Array.isArray(a.aufteilen)||a.aufteilen.length<2)fail('werkzeug_fehler','parameter_ungueltig');
      const groups=a.aufteilen.map(g=>{
        if(!object(g)||Object.keys(g).some(k=>!['titel','medien'].includes(k))||!Array.isArray(g.medien)||!g.medien.length||!g.medien.every(x=>typeof x==='string'))fail('werkzeug_fehler','parameter_ungueltig');
        return {titel:text(g.titel,tmax),medien:g.medien as string[]};
      });
      const aufgenommen=(await db.query('SELECT 1 FROM reverse_eingang_dateien WHERE eintrag_id=$1 LIMIT 1',[rid])).rows.length>0;
      if(aufgenommen&&ms.some(m=>m.status!=='vollstaendig'))fail('werkzeug_fehler','medien_unvollstaendig');
      const all=groups.flatMap(g=>g.medien);
      if(all.length!==ms.length||new Set(all).size!==all.length||ms.some(m=>!all.includes(str(m.id))))fail('werkzeug_fehler','parameter_ungueltig');
      const entries=groups.map(g=>({
        id:'rev-'+g.titel.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,60).replace(/^-|-$/g,'')+'-'+randomBytes(3).toString('hex'),
        titel:g.titel,
        fingerabdruck:createHash('sha256').update(JSON.stringify(g.medien.map(mid=>{const m=ms.find(x=>x.id===mid)!;return [m.art,m.satz_sha256];}))).digest('hex'),
        medien:g.medien,
      }));
      await db.query(`INSERT INTO reverse_eintraege(id,titel,status,erstellt_von,bestaetigt_von,gruppierung,analyse_policy,fingerabdruck,creator_identity_id,confirmer_identity_id)
        SELECT g.id,g.titel,'bestaetigt',$2,$2,$3,jsonb_build_object('bis_schicht',$4::text,'automatisch',true),g.fingerabdruck,$5,$5
        FROM jsonb_to_recordset($1::jsonb) AS g(id text,titel text,fingerabdruck text)`,[JSON.stringify(entries),a.agent_id,rid,reverseBisSchichtGrenze(ein),aktuelleAgentAkteurIdentityId(a.agent_id)]);
      const moves=entries.flatMap(g=>g.medien.map((mid,position)=>({id:mid,eintrag_id:g.id,position})));
      await db.query(`UPDATE reverse_medien m SET eintrag_id=g.eintrag_id,position=g.position
        FROM jsonb_to_recordset($1::jsonb) AS g(id bigint,eintrag_id text,position integer) WHERE m.id=g.id`,[JSON.stringify(moves)]);
      await db.query("SELECT pg_notify('synapse_reverse_changed',id) FROM unnest($1::text[]) AS id",[entries.map(g=>g.id)]);
      await db.query('UPDATE reverse_eingang_dateien d SET eintrag_id=m.eintrag_id FROM reverse_medien m WHERE d.medium_id=m.id AND d.eintrag_id=$1',[rid]);
      const {katalogisiereReverseOrdner}=await import('./reverse-eingang.js');
      for(const g of entries)await katalogisiereReverseOrdner(db,g.id);
      const neu=entries.map(g=>g.id);
      await db.query("UPDATE reverse_eintraege SET status='archiviert',archiviert_at=NOW(),updated_at=NOW() WHERE id=$1",[rid]);
      return {reverse_id:rid,status:'archiviert',aufgeteilt:neu};
    }
    if(a.medien!==undefined){
      if(!Array.isArray(a.medien)||a.medien.length!==ms.length)fail('werkzeug_fehler','parameter_ungueltig');
      const order=a.medien.map(m=>{
        if(!object(m)||Object.keys(m).some(k=>!['id','bezeichnung','art'].includes(k))||typeof m.id!=='string'||!ms.some(x=>x.id===m.id))fail('werkzeug_fehler','parameter_ungueltig');
        if(m.art!==undefined&&!['image','ordner','archiv'].includes(String(m.art)))fail('werkzeug_fehler','parameter_ungueltig');
        return {id:m.id,bezeichnung:m.bezeichnung===undefined?null:text(m.bezeichnung,tmax),art:m.art===undefined?null:String(m.art)};
      });
      if(order.some(m=>m.art!==null&&ms.find(x=>x.id===m.id)?.art!==m.art))await groupingAllowed(db,rid);
      if(new Set(order.map(m=>m.id)).size!==ms.length)fail('werkzeug_fehler','parameter_ungueltig');
      if(ms.some(m=>Number(m.position)<0))fail('werkzeug_fehler');
      await db.query('UPDATE reverse_medien SET position=-position-1 WHERE eintrag_id=$1',[rid]);
      for(const [i,m]of order.entries())await db.query('UPDATE reverse_medien SET position=$1,bezeichnung=COALESCE($2,bezeichnung),art=COALESCE($4,art) WHERE id=$3',[i,m.bezeichnung,m.id,m.art]);
      if(order.some(m=>m.art!==null)){
        await db.query(`UPDATE reverse_medien m SET
          status=CASE WHEN EXISTS(SELECT 1 FROM reverse_eingang_dateien d JOIN reverse_eingang_bytes b USING(sha256) WHERE d.medium_id=m.id AND b.status<>'ready') THEN 'unvollstaendig' ELSE 'vollstaendig' END,
          fehlercode=NULL
          WHERE m.eintrag_id=$1 AND m.art='ordner' AND m.id=ANY($2::bigint[]) AND COALESCE(jsonb_array_length(m.vorschlag->'case_kollisionen'),0)=0`,[rid,order.filter(m=>m.art==='ordner').map(m=>m.id)]);
        const originals=(await db.query('SELECT medium_id,original_name AS rel_pfad,groesse,sha256 FROM reverse_medien_dateien WHERE medium_id=ANY($1::bigint[])',[order.filter(m=>m.art!==null).map(m=>m.id)])).rows;
        const {reverseOrdnerFingerabdruck}=await import('./reverse-gruppierung.js');
        for(const choice of order.filter(m=>m.art!==null)){
          const files=originals.filter(f=>String(f.medium_id)===choice.id);
          if(choice.art==='archiv'&&files.length!==1)fail('werkzeug_fehler','archiv_braucht_eine_datei');
          const fingerprint=choice.art==='archiv'?String(files[0].sha256):reverseOrdnerFingerabdruck(files.map(f=>({rel_pfad:String(f.rel_pfad),groesse:Number(f.groesse),sha256:String(f.sha256)})));
          await db.query('UPDATE reverse_medien SET satz_sha256=$2 WHERE id=$1',[choice.id,fingerprint]);
        }
      }
      ms=await medien(db,rid);
    }
    const aufgenommen=(await db.query('SELECT 1 FROM reverse_eingang_dateien WHERE eintrag_id=$1 LIMIT 1',[rid])).rows.length>0;
    if(aufgenommen){
      if(ms.some(m=>m.status!=='vollstaendig'))fail('beschaedigt','medium_noch_unvollstaendig');
      const {katalogisiereReverseOrdner}=await import('./reverse-eingang.js');
      await katalogisiereReverseOrdner(db,rid);
    }
    const fp=createHash('sha256').update(JSON.stringify(ms.map(m=>[m.art,m.satz_sha256]))).digest('hex');
    await db.query(`UPDATE reverse_eintraege SET titel=COALESCE($2,titel),status='bestaetigt',bestaetigt_von=$3,confirmer_identity_id=$5,fingerabdruck=$4,
      analyse_policy=(analyse_policy-'bis_schicht')||jsonb_build_object('automatisch',true),updated_at=NOW() WHERE id=$1`,[rid,a.titel===undefined?null:text(a.titel,tmax),a.agent_id,fp,aktuelleAgentAkteurIdentityId(a.agent_id)]);
    await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[rid]);
    return {reverse_id:rid,status:'bestaetigt',eintrag:await entryDto(db,await entry(db,rid))};
  }
  async function datei(db:Db,rid:string,path:string):Promise<Row> {
    const r=await db.query('SELECT id::text AS id,medium_id::text AS medium_id,pfad,format,arch,bits,status,metadaten FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2',[rid,path]);
    if(!r.rows[0])fail('nicht_gefunden');return r.rows[0];
  }
  async function statusData(a:Row,ein:ReverseEinstellSnapshot,live:ReverseFortschrittStand|null=null):Promise<Row> {
    const rid=id(a.reverse_id),path=fileArg(a,reverseZahl(ein,'max_pfad_zeichen'));await entry(pool,rid);
    if(a.project)await projektRecht(pool,a);
    if(path){await projektRecht(pool,a);if(!await pruefeReverseBindung(pool,str(a.project),rid))fail('nicht_gebunden');}
    const f=path?await datei(pool,rid,path):null;
    const ls=(await pool.query(`SELECT s.* FROM reverse_schichten s LEFT JOIN reverse_dateien d ON d.id=s.datei_id LEFT JOIN reverse_medien m ON m.id=s.medium_id
      WHERE s.aktuell AND COALESCE(d.eintrag_id,m.eintrag_id)=$1 AND ($2::bigint IS NULL OR s.datei_id=$2) ORDER BY s.schicht,s.id`,[rid,f?.id??null])).rows;
    // P18-T64: ALLE offenen Aufträge (nicht nur den jüngsten), damit abbrechen/entstoeren jede ID kennt.
    const jobs=(await pool.query("SELECT id,schicht,status,fehlercode,policy_pin,to_jsonb(r)->>'ausfuehrung' AS ausfuehrung,p20_auftrag_id FROM reverse_auftraege r WHERE eintrag_id=$1 AND ($2::bigint IS NULL OR datei_id=$2) AND status IN ('offen','wartet','laeuft') ORDER BY created_at DESC,id DESC LIMIT $3",[rid,f?.id??null,reverseZahl(ein,'status_auftraege_max')])).rows;
    // P18-T85: Live-Fortschritt je laufendem Container-Auftrag (Work-Job), nur mit Schalter reverse_fortschritt_live.
    const p20=live?.aktiv?jobs.map(j=>j.p20_auftrag_id).filter(Boolean).map(String):[];
    const work=new Map((p20.length?(await pool.query(`SELECT w.id::text AS id,w.state,w.attempt,w.lease_until,${REVERSE_FORTSCHRITT_SQL} FROM work_jobs w WHERE w.id=ANY($1::uuid[])`,[p20])).rows:[]).map(w=>[String(w.id),w as Row] as const));
    const liveVon=(p:unknown)=>{const w=work.get(String(p??''));const l=w&&live?reverseFortschrittAnzeige(w,live.haenger_s):null;return l?{live:l}:{};};
    // P18-T66/E3: ohne offenen Auftrag den zuletzt beendeten zeigen, damit ein endgültiger Fehler nicht als 'wartet' erscheint.
    const letzter=jobs.length?null:(await pool.query("SELECT id,schicht,status,fehlercode,policy_pin FROM reverse_auftraege WHERE eintrag_id=$1 AND ($2::bigint IS NULL OR datei_id=$2) ORDER BY updated_at DESC,id DESC LIMIT 1",[rid,f?.id??null])).rows[0]??null;
    const letzterFehler=letzter?.status==='fehler'?letzter:null;
    const rank=(s:unknown)=>stages.indexOf(s as typeof stages[number]);
    const finished=ls.filter(l=>l.status==='fertig'||l.status==='teilweise').sort((a,b)=>rank(b.schicht)-rank(a.schicht))[0];
    const active=ls.filter(l=>l.status!=='fertig'&&l.status!=='uebersprungen').sort((a,b)=>rank(b.schicht)-rank(a.schicht))[0]??finished;
    const meta=object(f?.metadaten)?f.metadaten:{};
    let s3Speicher:Row|undefined;
    if(object(meta.s3_speicher)){
      const stand=await leseReverseEinstellungen(str(a.project)||null,'reverse_verknuepfungen',rid),v=stand.werte;
      const offset=integer(a.offset,0,2147483647),limit=integer(a.limit,Math.min(v.seiten_limit.wert,v.max_limit.wert),v.max_limit.wert);
      if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
      const alle=Array.isArray(meta.s3_speicher.fehlende_funktionen)?meta.s3_speicher.fehlende_funktionen:[],items:unknown[]=[];
      let bytes=0;
      for(const item of alle.slice(offset,offset+limit)){
        const masked=JSON.parse(maskiereMitKatalog(JSON.stringify(item),'reverse').text),b=Buffer.byteLength(JSON.stringify(masked));
        if(bytes+b>Math.floor(v.antwort_bytes.wert/2))break;items.push(masked);bytes+=b;
      }
      if(alle.length>offset&&!items.length)fail('zu_gross');
      s3Speicher={antwort_bytes:v.antwort_bytes.wert,budget_bytes:v.s3_pg_budget_bytes.wert,budget_quelle:v.s3_pg_budget_bytes.quelle,
        budget_beim_import_bytes:meta.s3_speicher.budget_bytes,verbrauch_datei_bytes:meta.s3_speicher.verbrauch_bytes,
        ...await leseReverseSpeicherVerbrauch(pool,rid),fehlend_datei_gesamt:alle.length,fehlende_funktionen:items,
        gekappt:offset+items.length<alle.length,naechster_offset:offset+items.length<alle.length?offset+items.length:null,
        artefakt_vorhanden:object(meta.s3_artefakt),hinweis:meta.s3_speicher.hinweis,
        budget_art:'Maskierter C/ASM-Text und Referenzdaten; ohne PostgreSQL-Index-/Zeilenoverhead.'};
    }
    const features=Array.isArray(meta.merkmale)?meta.merkmale.filter(x=>typeof x==='string').map(x=>maskiereMitKatalog(x as string,'reverse').text):[];
    const admission=a.project&&await pruefeReverseBindung(pool,str(a.project),rid)?await reverseAdmissionDiagnose(pool,rid,integer(a.limit,reverseZahl(ein,'seiten_limit'),reverseZahl(ein,'max_limit')),integer(a.offset,0,2147483647)):undefined;
    const container=hooks().containerStatus?await hooks().containerStatus!(rid):{zustand:'ruht',kaltstart_s:null};
    if(!['ruht','startet','laeuft'].includes(container.zustand))fail('werkzeug_fehler');
    const zerlegt=zerlegeReverseFehlercode(active?.fehlercode??letzterFehler?.fehlercode);
    const error=zerlegt.code&&REVERSE_FEHLERCODES.includes(zerlegt.code as ReverseFehlercode)?zerlegt.code:null;
    return {reverse_id:rid,datei:path,...(admission?{zulauf:admission}:{}),...(s3Speicher?{s3_speicher:s3Speicher}:{}),format:f?.format??'unbekannt',arch:f?.arch??'unbekannt',bits:f?.bits??null,schicht:finished?.schicht??null,
      schicht_angefragt:jobs[0]?.schicht??active?.schicht??null,status:jobs[0]?.status??(letzterFehler&&active?.status!=='fertig'&&active?.status!=='teilweise'?'fehler':undefined)??active?.status??f?.status??'offen',fehlercode:error,
      werkzeug:active?.werkzeug??null,merkmale:features,fortschritt:{gesamt:Number(active?.funktionen_gesamt??ls.length),fertig:Number(active?.funktionen_fertig??ls.filter(l=>l.status==='fertig').length)},
      container:{zustand:container.zustand,kaltstart_s:container.kaltstart_s},...(jobs[0]?{auftrag_id:jobs[0].id,eta:null,...liveVon(jobs[0].p20_auftrag_id)}:{}),
      ...(error&&zerlegt.detail?{fehler_detail:zerlegt.detail}:{}),
      ...(letzter?{letzter_auftrag:{auftrag_id:letzter.id,schicht:letzter.schicht,status:letzter.status,policy_pin:letzter.policy_pin??null,fehlercode:zerlegeReverseFehlercode(letzter.fehlercode).code}}:{}),
      auftraege:jobs.map(j=>{const z=zerlegeReverseFehlercode(j.fehlercode);return {auftrag_id:j.id,schicht:j.schicht,status:j.status,ausfuehrung:j.ausfuehrung,policy_pin:j.policy_pin??null,p20_auftrag_id:j.p20_auftrag_id??null,fehlercode:z.code,...(z.detail?{fehler_detail:z.detail}:{}),...liveVon(j.p20_auftrag_id)};}),
      schichten:ls.map(l=>{const z=zerlegeReverseFehlercode(l.fehlercode);return {schicht:l.schicht,status:l.status,fehlercode:z.code,...(z.detail?{fehler_detail:z.detail}:{})};})};
  }
  async function analyse(db:PoolClient,a:Row,e:Row,ein:ReverseEinstellSnapshot):Promise<Row> {
    const project=await projektRecht(db,a),rid=str(e.id);
    if(!await pruefeReverseBindung(db,project,rid))fail('nicht_gebunden');
    if(e.status==='archiviert')fail('keine_berechtigung');
    const path=fileArg(a,reverseZahl(ein,'max_pfad_zeichen')),bis=str(a.bis_schicht)||reverseBisSchichtGrenze(ein);
    if(!stages.includes(bis as typeof stages[number]))fail('werkzeug_fehler','parameter_ungueltig');
    const prio=(str(a.prioritaet)||'interaktiv') as ReverseAnalyseAnfrage['prioritaet'];
    if(!['interaktiv','hintergrund','nachzug'].includes(prio))fail('werkzeug_fehler','parameter_ungueltig');
    const f=path?await datei(db,rid,path):null;
    // P18-T71: bis_schicht 'E' ohne datei = E (Entpacken) fuer alle Medien des Eintrags neu anstossen, auch wenn schon Dateien existieren.
    const targets:{dateiId:string|null;mediumId:string|null;schicht:string}[]=f?[{dateiId:str(f.id),mediumId:str(f.medium_id),schicht:bis}]
      : bis==='E'?[]
      : (await db.query('SELECT id::text AS id FROM reverse_dateien WHERE eintrag_id=$1 ORDER BY id',[rid])).rows.map(d=>({dateiId:str(d.id),mediumId:null,schicht:bis}));
    if(!targets.length)for(const m of await medien(db,rid))targets.push({dateiId:null,mediumId:str(m.id),schicht:'E'});
    if(!targets.length)fail('nicht_gefunden');
    const done:Row[]=[];
    for(const t of targets){
      const request:ReverseAnalyseAnfrage={reverseId:rid,project,agentId:str(a.agent_id),dateiId:t.dateiId,mediumId:t.mediumId,bisSchicht:bis,prioritaet:prio};
      if(hooks().analysieren){done.push(await hooks().analysieren!(request,db));continue;}
      fail('kein_ausfuehrer','policy_runtime_fehlt');
    }
    return {reverse_id:rid,datei:path,format:f?.format??'unbekannt',arch:f?.arch??'unbekannt',bits:f?.bits??null,status:'wartet',schicht_angefragt:bis,
      auftrag_id:done[0].auftrag_id,auftraege:done,eta:null,
      ...(hooks().analysieren?{...done[0],fehlercode:done[0].fehlercode??null}:{fehlercode:'container_ruht',message:TEXTE.container_ruht})};
  }
  async function execute(a:Row,action:ReverseAction,ein:ReverseEinstellSnapshot):Promise<Row> {
    const pfadMax=reverseZahl(ein,'max_pfad_zeichen');
    if((LESER_RUNTIME_ACTIONS as readonly string[]).includes(action)){
      await projektRecht(pool,a);
      return fuehreLeserRuntimeAus(pool,a,await hooks().leserRuntimeImage?.());
    }
    if((LESER_ACTIONS as readonly string[]).includes(action)){
      await projektRecht(pool,a);
      const data=await fuehreReverseLeserAus(pool,a,await hooks().leserRuntimeImage?.());await tx(db=>activity(db,a));return data;
    }
    if((ERKENNTNIS_ACTIONS as readonly string[]).includes(action)){
      await projektRecht(pool,a);
      const data=await fuehreErkenntnisAus(pool,a);await tx(db=>activity(db,a));return data;
    }
    if(action==='uebernehmen'){
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);
      await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const data=await uebernehmeReverseAsset(a,{db:pool});
      await tx(db=>activity(db,a));return data;
    }
    if(action==='ansicht'){
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);
      await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const path=fileArg(a,pfadMax);if(!path)fail('werkzeug_fehler','parameter_fehlt',{parameter:'file_path'});
      const data=await fuehreReverseAnsichtAus({...a,file_path:path},pool);
      await tx(db=>activity(db,a,data.fehlercode==null));
      return data;
    }
    if((REVERSE_ASSET_ACTIONS as readonly string[]).includes(action)){
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);
      await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const data=await fuehreReverseAssetAus(a,pool);
      await tx(db=>activity(db,a));
      return data;
    }
    if((REVERSE_CODE_ACTIONS as readonly string[]).includes(action)){
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);
      await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const data=await fuehreReverseCodeAus(a,{db:pool,anfordern:(datei,schicht)=>tx(async db=>{
        await fordereReverseAdmission(db);await sperreReversePolicy(db,rid,true);
        const e=await entry(db,rid,true);
        const input={...a,action:'analysieren',datei,file_path:undefined,bis_schicht:schicht,prioritaet:'interaktiv'};
        const job=await analyse(db,input,e,ein);await activity(db,input);return job;
      })});
      await tx(db=>activity(db,a));
      const container=hooks().containerStatus?await hooks().containerStatus!(rid):{zustand:'ruht',kaltstart_s:null};
      if(!['ruht','startet','laeuft'].includes(container.zustand))fail('werkzeug_fehler');
      return {...data,container:{zustand:container.zustand,kaltstart_s:container.kaltstart_s}};
    }
    if(action==='verknuepfungen'){
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const path=fileArg(a,pfadMax);
      const data=await leseReverseVerknuepfungen(pool,rid,project,{...a,datei:path??undefined,file_path:undefined});
      if(data.fehlercode)fail(data.fehlercode as ReverseFehlercode,String(data.fehler_detail??''));
      await tx(db=>activity(db,a,data.fehlercode==null));return data;
    }
    if(action==='struktur'){
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const limit=integer(a.limit,reverseZahl(ein,'seiten_limit'),reverseZahl(ein,'max_limit'));if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
      const offset=integer(a.offset,0,2147483647),total=Number((await pool.query('SELECT count(*)::int AS n FROM reverse_dateien WHERE eintrag_id=$1',[rid])).rows[0].n);
      const rows=(await pool.query("SELECT id::text AS id,pfad,groesse,sha256,metadaten->'rv27' AS rv27 FROM reverse_dateien WHERE eintrag_id=$1 ORDER BY pfad,id LIMIT $2 OFFSET $3",[rid,limit,offset])).rows;
      const analysed:Row[]=[],unanalysiert:string[]=[];
      for(const row of rows){if(!row.rv27||typeof row.rv27!=='object'||Array.isArray(row.rv27)){unanalysiert.push(maskiereMitKatalog(str(row.pfad),'reverse').text);continue;}
       const rv=row.rv27 as Row;analysed.push({...rv,id:row.id,path:maskiereMitKatalog(str(row.pfad),'reverse').text,groesse:Number(row.groesse),sha256:row.sha256});}
      const groups=gruppiereRv27Dateien(analysed),max=reverseZahl(ein,'antwort_bytes');let used=JSON.stringify({reverse_id:rid,offset,total}).length,kept:Row[]=[];
      for(const group of groups){const n=JSON.stringify(group).length+1;if(used+n>max)break;kept.push(group);used+=n;}
      if(kept.length<groups.length)fail('zu_gross','Seite verkleinern');
      const rv30Stand=await leseReverseEinstellungen(project);
      const rv30=rv30Stand.schalter.aktiv?await leseReverseVerknuepfungen(pool,rid,project,{},rows.map(r=>str(r.pfad)),rv30Stand):null;
      if(rv30?.fehlercode)fail(rv30.fehlercode as ReverseFehlercode,String(rv30.fehler_detail??''));
      if(rv30&&JSON.stringify(kept).length+JSON.stringify(rv30).length>max)fail('zu_gross','Seite verkleinern');
      await tx(db=>activity(db,a));const weiter=offset+rows.length<total;
      return {reverse_id:rid,status:unanalysiert.length?'teilweise':'fertig',gruppen:kept,...(rv30?{geladen_von:rv30.links,geladen_von_gekappt:rv30.gekappt,geladen_von_diagnose:rv30.diagnose}:{}),gruppen_gekappt:kept.length<groups.length,nicht_analysiert:unanalysiert,gesamt_dateien:total,analysiert:analysed.length,gekappt:weiter,naechster_offset:weiter?offset+rows.length:null,hinweis:'Eingebettete Formate sind Kandidaten mit Bytebelegen; in dieser Welle werden keine reverse_assets angelegt.'};
    }
    if(action==='dateien'){
      // P18-T61: Inhalte nur nach Projektbindung; Pfade und Texte maskiert wie die übrigen Ausgaben.
      const project=await projektRecht(pool,a),rid=id(a.reverse_id);
      await entry(pool,rid);
      if(!await pruefeReverseBindung(pool,project,rid))fail('nicht_gebunden');
      const limit=integer(a.limit,reverseZahl(ein,'seiten_limit'),reverseZahl(ein,'max_limit'));
      if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
      const offset=integer(a.offset,0,2147483647);
      const prefix=gesetzt(a.path)?pruefeReversePfad(a.path,pfadMax):null;
      const where=" WHERE eintrag_id=$1 AND ($2::text IS NULL OR pfad=$2 OR left(pfad,length($2)+1)=$2||'/')";
      const total=Number((await pool.query('SELECT count(*)::int AS n FROM reverse_dateien'+where,[rid,prefix])).rows[0].n);
      const rows=(await pool.query("SELECT id::text AS id,medium_id::text AS medium_id,pfad,art,format,arch,bits,groesse,sha256,status,entpackt_mit,storage_key,metadaten->'herkunft' AS quelle,metadaten->'siedler3' AS siedler3,metadaten->'pe_ressource' AS pe_ressource,metadaten->'pe_ressourcen' AS pe_ressourcen,metadaten->'verschachtelt' AS verschachtelt,metadaten->>'e_pfad' AS e_pfad FROM reverse_dateien"+where+' ORDER BY pfad,id LIMIT $3 OFFSET $4',[rid,prefix,limit,offset])).rows;
      const mask=(v:unknown)=>typeof v==='string'?maskiereMitKatalog(v,'reverse').text:null;
      const items:Row[]=[];const max=reverseZahl(ein,'antwort_bytes');let laenge=2;
      for(const r of rows){
        const item:Row={id:r.id,medium_id:r.medium_id,pfad:mask(r.pfad),art:r.art,format:mask(r.format),arch:mask(r.arch),bits:r.bits??null,
          groesse:Number(r.groesse??0),sha256:r.sha256??null,status:mask(r.status),entpackt_mit:mask(r.entpackt_mit),
          herkunft:str(r.storage_key).startsWith(rid+'/entpackt/')?'entpackt':'original'};
        // P18-T71: Herkunft aus verschachtelten Containern und Zustand erkannter Container; Pfade wie 'pfad' (Medium-Label vorn).
        const basis=typeof r.e_pfad==='string'&&str(r.pfad).endsWith(r.e_pfad)?str(r.pfad).slice(0,str(r.pfad).length-r.e_pfad.length):'';
        if(object(r.quelle))item.quelle={archiv:mask(basis+str(r.quelle.archiv)),pfad:mask(r.quelle.pfad),tiefe:Number(r.quelle.tiefe)||null};
        // P18-T72: flat decoded-container provenance, masked like other original-derived metadata.
        if(object(r.siedler3)){
          const v=r.siedler3;item.siedler3=Object.fromEntries(
            ['format','offset','laenge','quellbereich_sha256','typ','breite','hoehe','versatz_x','versatz_y','darstellung','gruppe','variante','samplerate','kanaele','bits','fehler']
              .filter(k=>v[k]!==undefined).map(k=>[k,typeof v[k]==='number'?v[k]:mask(v[k])]));
        }
        // P18-T76: byte-exact resource provenance and extraction diagnostics.
        if(object(r.pe_ressource)){
          const v=r.pe_ressource,wert=(x:unknown)=>typeof x==='number'?x:mask(x);
          item.pe_ressource={typ:wert(v.typ),typ_name:mask(v.typ_name),name:wert(v.name),sprache:wert(v.sprache),
            offset:wert(v.offset),laenge:wert(v.laenge),sha256:mask(v.sha256),codepage:wert(v.codepage),
            format_beschreibung:mask(v.format_beschreibung),...(v.ableitung?{ableitung:mask(v.ableitung)}:{})};
        }
        if(object(r.pe_ressourcen)){const v=r.pe_ressourcen;item.pe_ressourcen={status:mask(v.status),dateien:Number(v.dateien)||0,
          fehlercode:mask(v.fehlercode),fehler_gesamt:Number(v.fehler_gesamt)||0,
          hinweise:Array.isArray(v.hinweise)?v.hinweise.map(mask):[]};}
        if(object(r.verschachtelt)){const v=r.verschachtelt;item.verschachtelt={status:mask(v.status),format:mask(v.format),grund:mask(v.grund),
          ...(typeof v.inhalt==='string'?{inhalt:mask(basis+v.inhalt)}:{}),...(typeof v.meldung==='string'?{meldung:mask(v.meldung)}:{})};}
        laenge+=JSON.stringify(item).length+1;if(laenge>max)break;items.push(item);
      }
      if(rows.length&&!items.length)fail('zu_gross');
      await tx(db=>activity(db,a));
      const weiter=offset+items.length<total;
      // P18-T71: erkannte, aber nicht entpackte Container (Grund sichtbar, nie still verworfen); Teile eines Satzes zählen nicht.
      const offen=(await pool.query("SELECT pfad,metadaten->'verschachtelt' AS v FROM reverse_dateien"+where+" AND metadaten->'verschachtelt'->>'status' NOT IN ('entpackt','teil') ORDER BY pfad,id LIMIT $3",[rid,prefix,reverseZahl(ein,'container_offen_anzeige')])).rows;
      const containerOffen=offen.map((o:Row)=>{const v=object(o.v)?o.v:{};return {pfad:mask(o.pfad),status:mask(v.status),format:mask(v.format),grund:mask(v.grund)};});
      return {reverse_id:rid,path:prefix,dateien:items,total,gekappt:weiter,naechster_offset:weiter?offset+items.length:null,
        ...(containerOffen.length?{container_nicht_entpackt:containerOffen}:{})};
    }
    if(action==='diagnose'){
      // P18-T64: lesend für jeden Agenten; nur Auftrags-/Containerzustände, keine Inhalte.
      const rid=gesetzt(a.reverse_id)?id(a.reverse_id):null;if(rid)await entry(pool,rid);
      const limit=integer(a.limit,reverseZahl(ein,'diagnose_seiten_limit'),reverseZahl(ein,'diagnose_max_limit'));if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
      // P18-T109: zentrales Fehlerlog nur mit Schalter reverse_fehlerlog EIN (AUS: Antwort unverändert).
      const fehlerlog=await reverseFehlerlogAktiv(pool)?{fehlerlog:await leseReverseFehlerlog({reverseId:rid,limit,pool})}:{};
      return {reverse_id:rid,status:'diagnose',...await diagnoseReverse({reverseId:rid,limit,pool}),...fehlerlog};
    }
    if(action==='entstoeren'){
      if(!darfKoordinatorOderUser(a.agent_id))fail('keine_berechtigung');
      const rid=gesetzt(a.reverse_id)?id(a.reverse_id):null;if(rid)await entry(pool,rid);
      if(a.vorschau!==undefined&&typeof a.vorschau!=='boolean')fail('werkzeug_fehler','parameter_ungueltig');
      const ursachen=a.ursache===undefined?null:Array.isArray(a.ursache)?a.ursache:[a.ursache];
      if(ursachen&&ursachen.some(u=>!(REVERSE_ENTSTOERBAR as readonly unknown[]).includes(u)))fail('werkzeug_fehler','parameter_ungueltig',{erlaubt:[...REVERSE_ENTSTOERBAR]});
      const auftrag=gesetzt(a.auftrag_id)?str(a.auftrag_id):null;
      if(auftrag&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(auftrag))fail('werkzeug_fehler','parameter_ungueltig');
      const r=await entstoereReverse({reverseId:rid,ursachen:ursachen as string[]|null,auftragId:auftrag,ausfuehren:a.vorschau===false,quelle:'agent:'+str(a.agent_id),pool});
      return {reverse_id:rid,status:r.vorschau?'vorschau':'entstoert',...r};
    }
    if(action==='status'){
      const wait=integer(a.warten_sekunden,0,reverseZahl(ein,'longpoll_max_s')),until=Date.now()+wait*1000;
      const live=await leseReverseFortschrittSchalter().catch(()=>null);
      // P18-T85: laufende Sekundenzaehler des Live-Fortschritts sind keine Aenderung fuer den Long-Poll, auch nicht im
      // Haenger-Hinweis (nennt Sekunden). Dass ein Hinweis auftaucht oder verschwindet, zeigt haenger_verdacht.
      const stabil=(r:Row)=>JSON.stringify(r,function(this:Row,k:string,v:unknown){
        if(k==='letzte_meldung_vor_s'||k==='laufzeit_s')return undefined;
        return k==='hinweis'&&this?.haenger_verdacht===true?undefined:v;
      });
      let result=await statusData(a,ein,live),fingerprint=stabil(result);
      while(wait&&Date.now()<until){
        await new Promise(resolve=>setTimeout(resolve,Math.min(reverseZahl(ein,'longpoll_takt_ms'),until-Date.now())));
        const next=await statusData(a,ein,live);result=next;if(stabil(next)!==fingerprint)break;
      }
      if(a.project)await tx(db=>activity(db,a));return result;
    }
    return tx(async db=>{
      if(action==='liste'||action==='vorschlaege'){const r=await list(db,a,ein);if(a.project){await projektRecht(db,a);await activity(db,a);}return r;}
      if(action==='bindungen'){
        const project=await projektRecht(db,a),limit=integer(a.limit,reverseZahl(ein,'seiten_limit'),reverseZahl(ein,'max_limit')),offset=integer(a.offset,0,2147483647);
        if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
        const rows=(await db.query("SELECT b.eintrag_id AS reverse_id,b.gebunden_von,b.gebunden_at,b.notiz FROM reverse_bindungen b WHERE project=$1 AND geloest_at IS NULL ORDER BY eintrag_id LIMIT $2 OFFSET $3",[project,limit,offset])).rows;
        const total=Number((await db.query('SELECT count(*)::int AS n FROM reverse_bindungen WHERE project=$1 AND geloest_at IS NULL',[project])).rows[0].n);
        await activity(db,a);return {bindungen:rows,total,gekappt:offset+rows.length<total,naechster_offset:offset+rows.length<total?offset+rows.length:null};
      }
      if(action==='abbrechen'){
        const project=await projektRecht(db,a),jid=str(a.auftrag_id);
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jid))fail('werkzeug_fehler','parameter_ungueltig');
        const job=(await db.query('SELECT * FROM reverse_auftraege WHERE id=$1 FOR UPDATE',[jid])).rows[0];
        if(!job)fail('nicht_gefunden');
        if(!darfKoordinatorOderUser(a.agent_id)&&(aktuelleAgentAkteurIdentityId(a.agent_id) ? job.trigger_identity_id!==aktuelleAgentAkteurIdentityId(a.agent_id) : job.trigger_identity_id || job.ausloeser!=='agent:'+str(a.agent_id)))fail('keine_berechtigung');
        if(!await pruefeReverseBindung(db,project,str(job.eintrag_id)))fail('nicht_gebunden');
        if(!['offen','wartet','laeuft'].includes(str(job.status)))return {reverse_id:job.eintrag_id,auftrag_id:jid,status:job.status};
        if(job.p20_auftrag_id&&!hooks().abbrechen)fail('container_gesperrt','pipeline_anschluss_fehlt');
        const zusatz=hooks().abbrechen?await hooks().abbrechen!(job,str(a.agent_id),db):undefined;
        await db.query("UPDATE reverse_auftraege SET status='abgebrochen',updated_at=NOW() WHERE id=$1 AND status IN ('offen','wartet','laeuft')",[jid]);
        await activity(db,{...a,reverse_id:job.eintrag_id});return {reverse_id:job.eintrag_id,auftrag_id:jid,status:'abgebrochen',...(zusatz??{})};
      }
      if(action==='bestaetigen')await db.query("SELECT pg_advisory_xact_lock(hashtext('reverse-gruppierung'))");
      const rid=id(a.reverse_id);
       // Frühester manueller Admission-Punkt: Halt -> Policy -> Eintrag, vor Hooks/Queue.
       if(action==='analysieren'){await fordereReverseAdmission(db);await sperreReversePolicy(db,rid,true);}
       const e=await entry(db,rid,['bestaetigen','archivieren','analysieren'].includes(action));
      let r:Row;
      if(action==='eintrag')r={status:e.status,eintrag:await entryDto(db,e)};
      else if(action==='bestaetigen')r=await confirm(db,a,e,ein);
      else if(action==='archivieren'){
        if(!darfKoordinatorOderUser(a.agent_id))fail('keine_berechtigung');
        await db.query("UPDATE reverse_eintraege SET status='archiviert',archiviert_at=COALESCE(archiviert_at,NOW()),updated_at=NOW() WHERE id=$1",[rid]);r={status:'archiviert'};
      }else if(action==='binden'||action==='loesen'){
        const project=await projektRecht(db,a);
        if(action==='binden')await db.query(`INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von,notiz,binder_identity_id) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(project,eintrag_id) WHERE geloest_at IS NULL DO NOTHING`,[project,rid,a.agent_id,a.notiz===undefined?null:text(a.notiz,reverseZahl(ein,'parameter_text_zeichen')),aktuelleAgentAkteurIdentityId(a.agent_id)]);
        else await db.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1 AND eintrag_id=$2 AND geloest_at IS NULL',[project,rid]);
        r={status:e.status,gebunden:action==='binden'};
      }else r=await analyse(db,a,e,ein);
      if(a.project){await projektRecht(db,a);await activity(db,{...a,reverse_id:r.reverse_id??rid});}
      return r;
    });
  }
  async function ausfuehren(args:Row|undefined|null):Promise<Row> {
    const a=object(args)?args:{};
    let ein:ReverseEinstellSnapshot|undefined;
    try {
      if(typeof a.agent_id!=='string'||!a.agent_id.trim())fail('keine_berechtigung','agent_id_fehlt');
      const befund=pruefeUnbekannteParameter('reverse',new Set(Object.keys(REVERSE_DEFINITION.inputSchema.properties)),a);
      if(befund)fail('werkzeug_fehler','unbekannte_parameter',{unbekannt:befund.unbekannt});
      if(!REVERSE_ACTIONS.includes(a.action as ReverseAction))fail('nicht_unterstuetzt','unbekannte_action');
      const action=a.action as ReverseAction;
      const unused=Object.keys(a).filter(k=>!['action','agent_id','project',...JE_ACTION[action]].includes(k)&&gesetzt(a[k]));
      // P18-T86: eine Lesestelle je Aufruf; Projektwerte für Antworten, Eintragswerte für Analysegrenzen.
      ein=await leseReverseEinstellwerte({project:typeof a.project==='string'&&a.project?a.project:null,eintrag_id:typeof a.reverse_id==='string'&&a.reverse_id?a.reverse_id:null},pool);
      const data=await execute(a,action,ein);
      // P21-T16: Ziel-Inhalt nur bei Erfolg kennzeichnen; Werte und Maskierung bleiben unveraendert.
      const zielfelder=data.fehlercode==null||action==='status'?vorhandeneZielfelder(data,REVERSE_ZIELINHALT[action]??[]):[];
      const antwortBauen=()=>baueReverseAntwort(a,{...data,...(zielfelder.length?{provenance:zielinhaltHerkunft(zielfelder)}:{}),...(unused.length?{nicht_verwendet:unused}:{})},action==='ansicht'?data.fehlercode as ReverseFehlercode|undefined:undefined);
      let antwort=antwortBauen();
      if(action==='status'&&object(data.s3_speicher)&&Array.isArray(data.s3_speicher.fehlende_funktionen)){
        const s=data.s3_speicher,max=Number(s.antwort_bytes),items=s.fehlende_funktionen as unknown[];
        while(Buffer.byteLength(JSON.stringify(antwort))>max&&items.length){
          items.pop();s.gekappt=true;s.naechster_offset=Number(a.offset??0)+items.length;antwort=antwortBauen();
        }
        if(Buffer.byteLength(JSON.stringify(antwort))>max||Number(s.fehlend_datei_gesamt)>Number(a.offset??0)&&!items.length)fail('zu_gross','antwort_bytes zu klein für Antwortkontext');
      }
      if(action==='verknuepfungen'&&object(data.diagnose)&&object(data.diagnose.einstellungen)&&object(data.diagnose.einstellungen.antwort_bytes)&&Array.isArray(data.links)){
        const max=Number(data.diagnose.einstellungen.antwort_bytes.wert);
        // Include the common response envelope and provenance in the UTF-8 budget.
        while(Buffer.byteLength(JSON.stringify(antwort))>max&&data.links.length){
          data.links.pop();data.gekappt=true;data.antwort_gekappt=true;
          data.naechster_offset=data.links.length?Number(a.offset??0)+data.links.length:null;antwort=antwortBauen();
        }
        if(Buffer.byteLength(JSON.stringify(antwort))>max)fail('zu_gross','antwort_bytes zu klein für Antwortkontext');
      }
      antwort=await ergaenzeReverseLeserHinweisKontext(pool,a,antwort).catch(()=>antwort);
      return setzeMcpBilder(antwort,trenneMcpBilder(data).bilder);
    }catch(e){
      if(e instanceof ReverseLeserFehler)return baueReverseAntwort(a,{},['nicht_gefunden','nicht_gebunden','keine_berechtigung'].includes(e.code)?e.code as ReverseFehlercode:'werkzeug_fehler',e.code);
      if(e instanceof ErkenntnisFehler)return baueReverseAntwort(a,{...e.extra,erkenntnis_fehler:e.kennung},e.kennung==='nicht_gebunden'?'nicht_gebunden':e.kennung==='keine_berechtigung'?'keine_berechtigung':e.kennung==='nicht_gefunden'?'nicht_gefunden':'werkzeug_fehler',e.kennung);
      if(e instanceof ReverseFehler||e instanceof ReverseCodeFehler||e instanceof ReverseAssetFehler||e instanceof ReverseUebernahmeFehler)return baueReverseAntwort(a,e.extra,e.code,e.detail);
      const code=(e as {code?:string})?.code;
      if(code==='23505')return baueReverseAntwort(a,{},'ziel_belegt');
      if(code==='57014')return baueReverseAntwort(a,{},'zeitlimit');
      // P18-T66/F3: unerwartete Ausnahme sichtbar machen (z. B. idempotency_conflict); als Detail nur kurze Kennungen.
      const m=String((e as Error)?.message??'');
      void loggeReverseFehler({eintrag_id:typeof a.reverse_id==='string'?a.reverse_id:null,komponente:'tool',name:String(a.action),
        grund:/^[a-z][a-z0-9_]{2,63}$/.test(m)?m:'interner_fehler',detail:m.slice(0,200),quelle:'reverse-tool'},pool);
      console.error('[reverse-tool] Unerwarteter Fehler bei',String(a.action),':',m.slice(0,ein?reverseZahl(ein,'diagnose_log_zeichen'):Number(REVERSE_EINSTELLKATALOG.diagnose_log_zeichen.standard)));
      return baueReverseAntwort(a,{},'werkzeug_fehler',/^[a-z][a-z0-9_]{2,63}$/.test(m)?m:'interner_fehler');
    }
  }
  return {ausfuehren};
}
export async function fuehreReverseAus(args:Row|undefined|null,deps:ReverseToolDependencies={}):Promise<Row> {
  try{return await createReverseToolService(deps).ausfuehren(args);}
  catch{return baueReverseAntwort(object(args)?args:{},{},'werkzeug_fehler');}
}
