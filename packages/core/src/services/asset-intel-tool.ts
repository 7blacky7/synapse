/**
 * MODUL: Asset-Intel Tool (Definition + Dispatcher)
 * ZWECK: EINE Schema-Definition und EIN Dispatcher fuer das MCP-Tool asset_intel. Der lokale
 *        MCP-Server (stdio) und die REST-API haengen beides nur ein:
 *          stdio: { definition: ASSET_INTEL_DEFINITION, handler: fuehreAssetIntelAus }
 *          REST:  MCP_TOOLS.push(ASSET_INTEL_DEFINITION); case 'asset_intel': fuehreAssetIntelAus(args)
 *        Damit sind beide Strecken per Konstruktion gleich (Entwurf thought 999610b9, 4.4: die
 *        code_intel-Spiegel sind auseinandergelaufen).
 *
 * ANTWORT: { success, action, project, beantwortet_von:'asset_intel', ...daten, total, gekappt, hinweis? }
 * FEHLER:  { success:false, action, project, beantwortet_von, fehler:<code>, message, hinweis? }
 *          Codes u. a.: unbekannte_action, unbekannte_parameter, parameter_fehlt, object_type_fehlt,
 *          datei_nicht_im_asset_index, filter_ungueltig, pfad_ungueltig, zeitlimit, asset_tabellen_fehlen.
 *
 * UNBEKANNTE PARAMETER: werden NICHT still verworfen (falle-alter-mcp-stand-verwirft-neue-parameter):
 *   - nicht im Schema -> Fehler unbekannte_parameter, Aufruf wird nicht ausgefuehrt
 *   - im Schema, aber fuer diese action ohne Wirkung -> Feld nicht_verwendet in der Antwort
 *
 * UMKEHR-WEICHE (Entwurf 5.6, Etappe C): inspect/references/objects auf einen Pfad ohne Asset-Zeile, aber mit
 *   code_files-Zeile -> beantwortet_von:'code_intel' + Dateiinhalt (Zeilen 1-200) + Hinweis. tree/search/health
 *   schalten nicht um, nennen aber die Zahl passender Code-Dateien (Feld code_intel, nur wenn > 0).
 */

import { pruefeUnbekannteParameter } from './unbekannte-parameter.js';
import {
  AssetIntelFehler,
  ASSET_STATUS,
  assetHealth,
  holeAssetBaum,
  holeBenutztVon,
  holeFehlende,
  holeGraph,
  holeObjekte,
  holeVerweise,
  holeWurzelnUndWaisen,
  inspiziereAusDb,
  kappeAntwort,
  movePreview,
  sucheAssets,
  sucheAssetsBatch,
} from './asset-intel-abfragen.js';
import { findeCodeDatei, zaehleCodeDateien } from './asset-weiche.js';
import {fuehreAssetWiederherstellungAus} from './asset-wiederherstellung.js';
import { getFileContent } from './code-intel.js';
import {AssetKonfliktKern,holeAssetKonflikt} from './asset-konflikte.js';
import {AssetUploadFehler} from './asset-upload.js';
import {isProjectEnabled} from './project-registry.js';

export const ASSET_INTEL_ACTIONS = [
  'tree', 'inspect', 'objects', 'references', 'used_by', 'missing', 'graph',
  'roots', 'orphans', 'search', 'search_batch', 'move_preview', 'health', 'konflikte', 'konflikt_loesen', 'geloescht', 'wiederherstellen',
] as const;
export type AssetIntelAction = (typeof ASSET_INTEL_ACTIONS)[number];

/** Schema des Tools (Budget: JSON <= 4.800 Zeichen, gemessen wie scripts/messe-tool-schemas.mjs). */
export const ASSET_INTEL_DEFINITION = {
  name: 'asset_intel',
  description:
    'Struktur-Index fuer Nicht-Quellcode-Dateien (Bilder, 3D, Audio, Archive, Executables, Unreal, DCC …): ' +
    'abgeleitete Daten der lokalen Inspektion, nur lesend, ohne Embeddings. Gegenstueck zu code_intel. ' +
    'tree=Asset-Baum; inspect=Datei mit Metadaten, Objekten, Verweisen (seitenweise); objects=Objekte einer Art projektweit; ' +
    'references=ausgehende Verweise; used_by=wer verweist auf die Datei; missing=Verweise ins Leere; ' +
    'graph=Abhaengigkeiten (down/up, Zyklen markiert); roots/orphans; search=Pfad, Objektname, Verweisziel + Filter; ' +
    'move_preview=was bricht beim Verschieben; health=Zustand des Index; geloescht=Löschliste; wiederherstellen(asset_id,basis_revision,event_id)=neue Share-Revision. ' +
    'Filter where: "<asset_type|kind>.<schluessel><op><wert>", op = != > >= < <= ~, max 5, z. B. image.width>=4096. ' +
    'Listen tragen total + gekappt. konflikte=offene Share/PC-Konflikte; konflikt_loesen(asset_id,wahl pc|share) über API. Share gewinnt automatisch, PC-Revision bleibt gesichert.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ASSET_INTEL_ACTIONS], description: 'Aktion' },
      project: { type: 'string', description: 'Projekt-Name' },
      agent_id: { type: 'string', description: 'Agent-ID' },
      asset_id: {type:'string',description:'Asset-ID (konflikt_loesen Pflicht, konflikte Filter)'},
      wahl: {type:'string',enum:['pc','share'],description:'konflikt_loesen: PC übernehmen oder Share behalten'},
      file_path: { type: 'string', description: 'Projekt-relativer Pfad (inspect, references, used_by, graph, move_preview Pflicht; objects, missing, health optional)' },
      path: { type: 'string', description: 'tree: Verzeichnis-Prefix' },
      new_path: { type: 'string', description: 'move_preview: Zielpfad' },
      object_type: { type: 'string', description: 'Objekt-kind (objects Pflicht, inspect Filter), z. B. mesh, material, export' },
      name: { type: 'string', description: 'objects: Teilstring im Objektnamen' },
      kind: { type: 'string', description: 'Verweisart-Filter (references, used_by, missing)' },
      query: { type: 'string', description: 'search: Begriffe, Kurzform format:x type:y und Filter' },
      queries: { type: 'array', items: { type: 'string' }, description: 'search_batch: 1..10 Suchen' },
      where: { type: 'array', items: { type: 'string' }, description: 'Eigenschaftsfilter (objects, search)' },
      format: { type: 'string', description: 'Format-Filter, z. B. glb, png, uasset' },
      asset_type: { type: 'string', description: 'Typ-Filter, z. B. image, model3d, audio' },
      status: { type: 'string', enum: [...ASSET_STATUS], description: 'tree: Status-Filter' },
      direction: { type: 'string', enum: ['down', 'up'], description: 'graph: down=worauf, up=wer (Standard down)' },
      depth: { type: 'number', description: 'tree: Tiefe; graph: 1..10 (Standard 3)' },
      recursive: { type: 'boolean', description: 'tree: Unterordner (Standard true)' },
      include_name_matches: { type: 'boolean', description: 'used_by: auch Verweise mit gleichem Dateinamen, anderem Pfad' },
      offset: { type: 'number', description: 'Paging (inspect, objects)' },
      limit: { type: 'number', description: 'Max. Eintraege' },
      basis_revision: {type:'string',description:'Bekannte Revision (wiederherstellen Pflicht)'},
      event_id: {type:'string',description:'Idempotenz-ID (wiederherstellen Pflicht)'},
    },
    required: ['action', 'project'],
  },
} as const;

const IMMER = ['action', 'project', 'agent_id'];

/** Parameter, die je action wirken (alles andere wird als nicht_verwendet gemeldet). */
const PARAMETER_JE_ACTION: Record<AssetIntelAction, string[]> = {
  tree: ['path', 'depth', 'recursive', 'format', 'asset_type', 'status', 'limit'],
  inspect: ['file_path', 'object_type', 'offset', 'limit'],
  objects: ['object_type', 'file_path', 'name', 'where', 'limit', 'offset'],
  references: ['file_path', 'kind', 'limit'],
  used_by: ['file_path', 'kind', 'limit', 'include_name_matches'],
  missing: ['file_path', 'kind', 'limit'],
  graph: ['file_path', 'direction', 'depth', 'limit'],
  roots: ['format', 'asset_type', 'limit'],
  orphans: ['format', 'asset_type', 'limit'],
  search: ['query', 'where', 'format', 'asset_type', 'limit'],
  search_batch: ['queries', 'limit'],
  move_preview: ['file_path', 'new_path'],
  health: ['file_path'],
  konflikte: ['asset_id','file_path','limit','offset'],
  konflikt_loesen: ['asset_id','wahl'],
  geloescht: ['file_path','limit','offset'],
  wiederherstellen: ['file_path','asset_id','basis_revision','event_id'],
};

const ERLAUBT = new Set(Object.keys(ASSET_INTEL_DEFINITION.inputSchema.properties));

function gesetzt(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function fehlerAntwort(action: unknown, project: unknown, code: string, message: string, hinweis?: string, details?: Record<string, unknown>): Record<string, unknown> {
  return {
    success: false,
    action: action ?? null,
    project: project ?? null,
    beantwortet_von: 'asset_intel',
    fehler: code,
    message,
    ...(hinweis ? { hinweis } : {}),
    ...(details ?? {}),
  };
}

function pflicht(args: Record<string, unknown>, name: string, action: string, beispiel: string): void {
  if (!gesetzt(args[name])) {
    throw new AssetIntelFehler('parameter_fehlt', action + ' braucht ' + name + '.', 'Beispiel: asset_intel(action:"' + action + '", ' + beispiel + ')');
  }
}

async function fuehreAus(action: AssetIntelAction, project: string, a: Record<string, unknown>,api:{apiAusfuehrung?:boolean;agentId?:string}={}): Promise<Record<string, unknown>> {
  switch (action) {
    case 'geloescht':
    case 'wiederherstellen':
      if(!api.apiAusfuehrung)throw new AssetUploadFehler('api_erforderlich',403,'Restoreaktionen laufen ausschließlich über die API.');
      return fuehreAssetWiederherstellungAus(action,project,{...a,agent_id:api.agentId});
    case 'tree':
      return holeAssetBaum(project, a);
    case 'inspect': {
      pflicht(a, 'file_path', action, 'file_path:"gltf/box/Box.gltf"');
      const r = await inspiziereAusDb(project, a.file_path, { object_type: a.object_type, objects_offset: a.offset, objects_limit: a.limit, references_limit: a.limit });
      if (!r) {
        throw new AssetIntelFehler(
          'datei_nicht_im_asset_index',
          'Kein Asset-Eintrag fuer ' + String(a.file_path) + '.',
          'Laeuft der lokale Watcher (nur er inspiziert)? Textdatei/Quellcode? -> code_intel(action:"file", file_path). Pfade: asset_intel(action:"tree") oder action:"search".'
        );
      }
      return { ...r, total: r.objekte_total, gekappt: r.objekte_gekappt || r.verweise_gekappt };
    }
    case 'objects':
      return holeObjekte(project, a);
    case 'references':
      pflicht(a, 'file_path', action, 'file_path:"gltf/box/Box.gltf"');
      return holeVerweise(project, a.file_path, a);
    case 'used_by':
      pflicht(a, 'file_path', action, 'file_path:"textures/rock.png"');
      return holeBenutztVon(project, a.file_path, a);
    case 'missing':
      return holeFehlende(project, a);
    case 'graph':
      pflicht(a, 'file_path', action, 'file_path:"scenes/level.gltf", direction:"down", depth:3');
      return { ...(await holeGraph(project, a.file_path, a)) };
    case 'roots':
    case 'orphans':
      return holeWurzelnUndWaisen(project, { art: action, format: a.format, asset_type: a.asset_type, limit: a.limit });
    case 'search':
      pflicht(a, 'query', action, 'query:"rock image.width>=4096"');
      return sucheAssets(project, a);
    case 'search_batch':
      pflicht(a, 'queries', action, 'queries:["rock","format:glb"]');
      return sucheAssetsBatch(project, a.queries, a.limit);
    case 'move_preview':
      pflicht(a, 'file_path', action, 'file_path:"a/x.png", new_path:"b/x.png"');
      pflicht(a, 'new_path', action, 'file_path:"a/x.png", new_path:"b/x.png"');
      return movePreview(project, a.file_path, a.new_path);
    case 'health':
      return assetHealth(project, a.file_path);
    case 'konflikte':
    case 'konflikt_loesen': {
      if(!api.apiAusfuehrung)throw new AssetUploadFehler('api_erforderlich',403,'Konfliktaktionen laufen ausschließlich über die API.');
      if(!await isProjectEnabled(project))throw new AssetUploadFehler('projekt_verboten',403,'Projekt fehlt oder ist nicht freigegeben.');
      const kern=new AssetKonfliktKern();
      if(action==='konflikte')return kern.liste(project,{asset_id:a.asset_id as string|undefined,file_path:a.file_path as string|undefined,limit:a.limit as number|undefined,offset:a.offset as number|undefined});
      pflicht(a,'asset_id',action,'asset_id:"123", wahl:"pc"');pflicht(a,'wahl',action,'asset_id:"123", wahl:"share"');
      return {asset:await kern.loesen({bereich:'projekt',ziel_ref:project,host_id:'tool:'+String(api.agentId??'')},a.asset_id as string,a.wahl as 'pc'|'share',api.agentId??'')};
    }
  }
}

/** Actions, die bei einem Pfad ohne Asset-Zeile auf code_intel umschalten (Entwurf 5.6). */
const UMKEHR_ACTIONS = new Set<AssetIntelAction>(['inspect', 'references', 'objects']);
const UMKEHR_ZEILEN = 200;
const UMKEHR_MAX_ZEICHEN = 40000;

/** Umkehr-Weiche: Pfad im Code-Index -> Antwort von code_intel (Zeilen 1-200); sonst null. Wirft nicht. */
async function umkehrZuCodeIntel(act: AssetIntelAction, project: string, filePath: unknown): Promise<Record<string, unknown> | null> {
  try {
    const code = await findeCodeDatei(project, filePath);
    if (!code) return null;
    const datei = await getFileContent(project, code.file_path, { from: 1, to: UMKEHR_ZEILEN });
    if (!datei) return null;
    const zuLang = datei.content.length > UMKEHR_MAX_ZEICHEN;
    return {
      success: true,
      action: act,
      project,
      beantwortet_von: 'code_intel',
      weiche: 'Textdatei (' + (code.file_type ?? 'text') + ') -> code_intel',
      grund: 'Kein Asset-Eintrag, aber im Code-Index',
      ...datei,
      ...(zuLang ? { content: datei.content.slice(0, UMKEHR_MAX_ZEICHEN) + '\n…[gekuerzt]', content_gekuerzt: true } : {}),
      hinweis: 'Mehr: code_intel(action:"file"|"functions", file_path:"' + code.file_path + '")',
    };
  } catch {
    return null;
  }
}

/**
 * Fuehrt einen asset_intel-Aufruf aus. Wirft nie: jeder Fehler wird zu einer Antwort mit
 * success:false, fehler-Code und Hinweis. Antworten sind hart auf 60.000 Zeichen gekappt.
 */
export async function fuehreAssetIntelAus(args: Record<string, unknown> | undefined | null,api:{apiAusfuehrung?:boolean;agentId?:string}={}): Promise<Record<string, unknown>> {
  const a: Record<string, unknown> = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const action = a.action;
  const project = a.project;

  const befund = pruefeUnbekannteParameter('asset_intel', ERLAUBT, a);
  if (befund) return fehlerAntwort(action, project, 'unbekannte_parameter', befund.meldung, undefined, { unbekannt: befund.unbekannt });

  if (typeof action !== 'string' || !(ASSET_INTEL_ACTIONS as readonly string[]).includes(action)) {
    return fehlerAntwort(action, project, 'unbekannte_action', 'Unbekannte action: ' + JSON.stringify(action ?? null) + '.', 'Erlaubt: ' + ASSET_INTEL_ACTIONS.join(', '));
  }
  if (typeof project !== 'string' || project.trim() === '') {
    return fehlerAntwort(action, project, 'parameter_fehlt', 'project fehlt.', 'Projektname angeben, z. B. project:"synapse".');
  }
  const act = action as AssetIntelAction;
  const wirksam = new Set([...IMMER, ...PARAMETER_JE_ACTION[act]]);
  const nichtVerwendet = Object.keys(a).filter(k => !wirksam.has(k) && gesetzt(a[k]));

  try {
    const daten = await fuehreAus(act, project, a,api);
    const antwort: Record<string, unknown> = {
      success: true,
      action: act,
      project,
      beantwortet_von: 'asset_intel',
      ...daten,
      total: daten.total ?? null,
      gekappt: daten.gekappt ?? false,
    };
    if (act === 'tree' || act === 'search' || act === 'health') {
      const n = await zaehleCodeDateien(project, act, a);
      if (n > 0) {
        antwort.code_intel = { dateien: n, hinweis: n + ' passende Datei(en) im Code-Index -> code_intel(action:"' + (act === 'search' ? 'search' : 'tree') + '")' };
      }
    }
    if (nichtVerwendet.length > 0) {
      antwort.nicht_verwendet = nichtVerwendet;
      const h = 'Parameter ohne Wirkung bei ' + act + ': ' + nichtVerwendet.join(', ') + ' (wirksam: ' + PARAMETER_JE_ACTION[act].join(', ') + ').';
      antwort.hinweis = antwort.hinweis ? antwort.hinweis + ' | ' + h : h;
    }
    if(typeof a.file_path==='string'){
      const konflikt=await holeAssetKonflikt(project,a.file_path);
      if(konflikt)antwort.konflikt=konflikt;
    }
    return kappeAntwort(antwort);
  } catch (e) {
    if (e instanceof AssetIntelFehler && e.code === 'datei_nicht_im_asset_index' && UMKEHR_ACTIONS.has(act)) {
      const umkehr = await umkehrZuCodeIntel(act, project, a.file_path);
      if (umkehr) return umkehr;
    }
    if(e instanceof AssetUploadFehler)return fehlerAntwort(act,project,e.code,e.message,undefined,e.details);
    if (e instanceof AssetIntelFehler) return fehlerAntwort(act, project, e.code, e.message, e.hinweis, e.details);
    const code = (e as { code?: string }).code;
    if (code === '57014') {
      return fehlerAntwort(act, project, 'zeitlimit', 'Abfrage nach 10 s abgebrochen (statement_timeout).', 'Mit path/file_path/format/object_type/limit einengen.');
    }
    if (code === '42P01') {
      return fehlerAntwort(act, project, 'asset_tabellen_fehlen', 'Die Tabellen asset_files/asset_objects/asset_references fehlen in dieser Datenbank.', 'Schema-Stand der API pruefen (Etappe A noch nicht deployt?).');
    }
    return fehlerAntwort(act, project, 'interner_fehler', e instanceof Error ? e.message : String(e));
  }
}
