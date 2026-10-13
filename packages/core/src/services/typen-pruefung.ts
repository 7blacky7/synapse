/**
 * P16-T15: Code-Intel als erste Stufe, danach gezielte TypeScript-Diagnosen im Worker.
 * PG und Plan-Schatten sind die Quelle; Platte liefert nur installierte Abhängigkeiten.
 */
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { getPool } from '../db/client.js';
import { getParserForFile } from '../parser/index.js';
import { getReferences } from './code-intel.js';
import type { PruefDatei, PruefDateiOp } from './plan-befunde.js';
import type { FehlerBefund } from './fehlermuster-pruefung.js';

export interface TypRohBefund extends FehlerBefund {
  op_index: number | null;
  agent_id: string | null;
  beteiligt?: number[];
}
export interface TypPruefung {
  status: 'fertig' | 'zeitlimit' | 'nicht_verfuegbar' | 'aus';
  dauer_ms: number;
  befunde: TypRohBefund[];
  altlasten: number;
  dateien: string[];
  hinweis?: string;
  vollstaendig: boolean;
  fehlende_module: string[];
  betroffene_aufrufer: string[];
}
export interface TypAuftrag {
  project: string;
  root: string;
  quellen: Array<{ file_path: string; content: string }>;
  dateien: PruefDatei[];
  ziele: string[];
  budget_ms: number;
  basisvergleich: boolean;
}
interface Antwort {
  id: number;
  ergebnis: TypPruefung;
}
const istTs = (p: string) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(p);
type WorkspacePruefer = (auftrag: TypAuftrag) => Promise<TypPruefung>;
let workspacePruefer: WorkspacePruefer | null = null;
/** API setzt nur den Abhängigkeits-Ausführungsort; Prüflogik bleibt derselbe Core-Worker. */
export function registriereTypWorkspacePruefer(pruefer: WorkspacePruefer): void { workspacePruefer = pruefer; }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let worker: Worker | null = null;
let naechsteId = 0;
const offen = new Map<number, { resolve: (r: TypPruefung) => void; timer: NodeJS.Timeout }>();

function leeresErgebnis(status: TypPruefung['status'], hinweis?: string): TypPruefung {
  return { status, dauer_ms: 0, befunde: [], altlasten: 0, dateien: [], vollstaendig: status === 'fertig', fehlende_module: [], betroffene_aufrufer: [], ...(hinweis ? { hinweis } : {}) };
}

/** Ein begrenzter Worker pro Prozess, Paket-Program-Cache im Worker, keine Blockade des API-Threads. */
function imWorker(auftrag: TypAuftrag): Promise<TypPruefung> {
  if (offen.size >= 16) return Promise.resolve(leeresErgebnis('nicht_verfuegbar', 'Typprüf-Warteschlange voll.'));
  if (!worker) {
    const w = new Worker(new URL('./typen-pruefung-worker.js', import.meta.url), {
      execArgv: process.execArgv.filter(a => !/^--(input-type|eval|print)\b|^-[ep]$/.test(a)),
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    worker = w;
    w.on('message', (msg: Antwort) => {
      const a = offen.get(msg.id);
      if (!a) return;
      offen.delete(msg.id);
      clearTimeout(a.timer);
      a.resolve(msg.ergebnis);
      if (!offen.size) w.unref();
    });
    const ausgefallen = () => {
      if (worker !== w) return;
      worker = null;
      for (const a of offen.values()) {
        clearTimeout(a.timer);
        a.resolve(leeresErgebnis('nicht_verfuegbar', 'Typprüf-Worker ausgefallen.'));
      }
      offen.clear();
      void w.terminate();
    };
    w.on('error', ausgefallen);
    w.on('exit', ausgefallen);
    w.unref();
  }
  const w = worker;
  w.ref();
  return new Promise(resolve => {
    const id = ++naechsteId;
    const timer = setTimeout(() => {
      if (worker === w) worker = null;
      // Ein synchron rechnender TS-Checker wird wirklich beendet, nicht im Hintergrund weitergerechnet.
      for (const a of offen.values()) {
        clearTimeout(a.timer);
        a.resolve(leeresErgebnis('zeitlimit', 'FEHLERPRUEFUNG_TYPEN_MS überschritten; keine Typ-Sperre.'));
      }
      offen.clear();
      void w.terminate();
    }, auftrag.budget_ms);
    offen.set(id, { resolve, timer });
    w.postMessage({ id, auftrag });
  });
}

function opFuer(datei: PruefDatei, zeile: number): PruefDateiOp | undefined {
  const passend = datei.ops.filter(o => o.spannen.some(([s,e]) => s < e ? zeile > s && zeile <= e : Math.abs(zeile - s) <= 1));
  return (passend.length ? passend : datei.ops).at(-1);
}

function aufrufAnzahlen(inhalt: string, pfad: string, name: string, zeile: number): number[] {
  const sf = ts.createSourceFile(pfad, inhalt, ts.ScriptTarget.Latest, true,
    pfad.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const zahlen: number[] = [];
  const gehe = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
      && sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 === zeile
      && !n.arguments.some(ts.isSpreadElement)) zahlen.push(n.arguments.length);
    ts.forEachChild(n, gehe);
  };
  gehe(sf);
  return zahlen;
}

/** Gleicher Parser und derselbe Referenz-Leser wie code_intel; Schatten wird nur im Speicher geparst. */
async function intelStufe(project: string, dateien: PruefDatei[], quellen: Map<string,string>) {
  const befunde: TypRohBefund[] = [];
  const callerCache = new Map<string, ReturnType<NonNullable<ReturnType<typeof getParserForFile>>['parse']> | undefined>();
  const ziele = new Set(dateien.filter(d => istTs(d.file_path)).map(d => d.file_path));
  for (const datei of dateien.filter(d => istTs(d.file_path))) {
    const parser = getParserForFile(datei.file_path, datei.basis || datei.ergebnis);
    if (!parser) continue;
    const alt = parser.parse(datei.basis, datei.file_path).symbols.filter(s => s.is_exported && s.name);
    const neu = datei.geloescht ? [] : parser.parse(datei.ergebnis, datei.file_path).symbols.filter(s => s.is_exported && s.name);
    for (const sym of alt) {
      const nach = neu.find(s => s.name === sym.name && s.symbol_type === sym.symbol_type);
      const alterTyp = sym.symbol_type === 'function' ? '' : datei.basis.split('\n').slice(sym.line_start-1,sym.line_end??sym.line_start).join('\n');
      const neuerTyp = nach?.symbol_type === 'function' ? '' : nach ? datei.ergebnis.split('\n').slice(nach.line_start-1,nach.line_end??nach.line_start).join('\n') : '';
      if (nach && alterTyp === neuerTyp && JSON.stringify([sym.params,sym.return_type,sym.value]) === JSON.stringify([nach.params,nach.return_type,nach.value])) continue;
      const ids = (await getPool().query<{id:string}>(
        'SELECT id::text FROM code_symbols WHERE project=$1 AND file_path=$2 AND name=$3',
        [project,datei.file_path,sym.name])).rows.map(r => r.id);
      const refs = await getReferences(project, sym.name!, false, 0);
      for (const ref of refs.references.filter(r => r.file_path !== datei.file_path && r.symbol_id && ids.includes(String(r.symbol_id)))) {
        ziele.add(ref.file_path);
        const caller = dateien.find(d => d.file_path === ref.file_path);
        if (caller?.geloescht) continue;
        const text = caller?.ergebnis ?? quellen.get(ref.file_path);
        if (text === undefined) continue;
        const name = ref.via_alias ?? sym.name!;
        // Bereits im selben Plan angepasste Aufrufer/Importe erzeugen keinen veralteten Hinweis.
        if (!callerCache.has(ref.file_path)) callerCache.set(ref.file_path,getParserForFile(ref.file_path,text)?.parse(text,ref.file_path));
        const parsed = callerCache.get(ref.file_path);
        const verwendung = parsed?.references.find(r => r.symbol_name === name && r.line_number === ref.line_number)
          ?? parsed?.symbols.find(s => s.symbol_type === 'import' && s.line_start === ref.line_number
            && (s.name === name || s.params?.includes(name)));
        const aufrufe = nach && JSON.stringify(sym.params) !== JSON.stringify(nach.params)
          ? aufrufAnzahlen(text,ref.file_path,name,ref.line_number) : [];
        const parameter = nach?.params ?? [];
        const min = parameter.filter(p => !/\?|=|^\.\.\./.test(p)).length;
        const max = parameter.some(p => /^\.\.\./.test(p)) ? Infinity : parameter.length;
        const entfernt = !nach && !!verwendung;
        const anzahl = nach && sym.symbol_type === 'function' && JSON.stringify(sym.params) !== JSON.stringify(nach.params)
          && aufrufe.some(n => n < min || n > max);
        if (!entfernt && !anzahl) continue;
        const op = opFuer(datei,nach?.line_start ?? sym.line_start);
        if (!op) continue;
        befunde.push({
          quelle:'typen', pruefer:'code_intel:signaturen@1', severity:'warning',
          datei:ref.file_path, zeilen:[ref.line_number,ref.line_number],
          code:entfernt ? 'INTEL_EXPORT_ENTFERNT' : 'INTEL_PARAMETERZAHL',
          was:entfernt ? 'Entfernter Export ' + sym.name + ' wird hier noch verwendet.'
            : 'Aufruf von ' + sym.name + ' passt nicht zur geänderten Parameterzahl.',
          warum:'Vergleich der Code-Intel-Symbole im Basis- und Plan-Schattenstand mit den verknüpften Referenzen.',
          wie:'Import beziehungsweise Aufruf zusammen mit der geänderten Signatur anpassen.',
          wo:[], op_index:op.op_index, agent_id:op.agent_id,
          entstanden_bei:{op_index:op.op_index,zeilen:[Math.max(1,(op.spannen[0]?.[0] ?? 0)+1),Math.max(1,op.spannen[0]?.[1] ?? 1)]},
        });
      }
    }
  }
  return { befunde, ziele:[...ziele] };
}


/** checkJs folgt relativen extends aus demselben PG-Snapshot; keine Dateien vom Rechner. */
export function checkJsAusPg(file:string,quellen:Map<string,string>):boolean {
  const lies=(p:string,besucht=new Set<string>()):boolean=>{
    if(besucht.has(p)) return false;besucht.add(p);
    const text=quellen.get(p);if(text===undefined)return false;
    const c=ts.parseConfigFileTextToJson(p,text).config;
    if(!c || c.compilerOptions?.checkJs!==undefined) return c?.compilerOptions?.checkJs===true;
    const parents=Array.isArray(c.extends)?c.extends:[c.extends];
    return parents.filter((x:unknown):x is string=>typeof x==='string' && x.startsWith('.')).some((x:string)=>{
      const rel=path.posix.normalize(path.posix.join(path.posix.dirname(p),x));
      return lies(rel.endsWith('.json')?rel:rel+'.json',besucht);
    });
  };
  for(let dir=path.posix.dirname(file);;dir=path.posix.dirname(dir)){
    const config=dir==='.'?'tsconfig.json':dir+'/tsconfig.json';
    if(quellen.has(config))return lies(config);
    if(dir==='.')return false;
  }
}

/** Typprüfung ergänzt vorhandene Befunde. Abschalten betrifft nur Stufe 2; Code-Intel bleibt aktiv. */
export async function pruefePlanTypen(project: string, dateien: PruefDatei[], basisvergleich = true): Promise<TypPruefung | null> {
  if (!dateien.some(d => istTs(d.file_path))) return null;
  const start = Date.now();
  const roh = process.env.FEHLERPRUEFUNG_TYPEN_MS;
  const zahl = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  const ms = Number.isFinite(zahl) && zahl >= 0 ? zahl : 5000;
  let intel: Awaited<ReturnType<typeof intelStufe>> = { befunde:[],ziele:[] };
  try {
    // Keine Quelltexte aus dem FS: gleiches Ergebnis im API- und Daemon-Schreibweg.
    const rows = (await getPool().query<{file_path:string;content:string;file_type:string}>(
      "SELECT file_path, content, file_type FROM code_files WHERE project=$1 AND deleted_at IS NULL AND ignored=false AND content IS NOT NULL AND file_path ~ '\\.(json|[cm]?[jt]sx?)$' ORDER BY file_path",
      [project])).rows;
    const quellen = new Map(rows.map(r => [r.file_path,r.content]));
    for (const d of dateien) if (/\.json$/.test(d.file_path)) {
      if (d.geloescht) quellen.delete(d.file_path); else quellen.set(d.file_path,d.ergebnis);
    }
    // JS nur bei checkJs des nächstgelegenen Paket-tsconfig (einschließlich extends).
    const unterstuetzt = dateien.filter(d => {
      // P16-T15/26209: ohne indexierten Paketkontext wird keine Typstufe versucht.
      // Syntax-/Musterantworten solcher Dateien bleiben dadurch bytegleich.
      let paketKontext = false;
      for (let dir = path.posix.dirname(d.file_path);; dir = path.posix.dirname(dir)) {
        const config = dir === '.' ? 'tsconfig.json' : dir + '/tsconfig.json';
        if (quellen.has(config)) { paketKontext = true; break; }
        if (dir === '.') break;
      }
      if (!paketKontext) return false;
      const typ = rows.find(r=>r.file_path===d.file_path)?.file_type ?? path.extname(d.file_path).slice(1);
      return ['ts','tsx','mts','cts'].includes(typ) || ['js','mjs','cjs'].includes(typ) && checkJsAusPg(d.file_path,quellen);
    });
    if (!unterstuetzt.length) return null;
    intel = basisvergleich ? await intelStufe(project,unterstuetzt,quellen) : {befunde:[],ziele:unterstuetzt.map(d=>d.file_path)};
    if (process.env.FEHLERPRUEFUNG_TYPEN === '0') {
      return { ...leeresErgebnis('aus'),befunde:intel.befunde,dateien:intel.ziele,betroffene_aufrufer:intel.ziele.filter(p=>!dateien.some(d=>d.file_path===p)),dauer_ms:Date.now()-start };
    }
    const rest = ms - (Date.now()-start);
    if (rest <= 0) return { ...leeresErgebnis('zeitlimit'),befunde:intel.befunde,dateien:intel.ziele,dauer_ms:Date.now()-start };
    const roots = (await getPool().query<{path:string}>('SELECT path FROM projects WHERE name=$1 AND path IS NOT NULL',[project])).rows;
    let root = roots.map(r=>r.path).find(p=>path.isAbsolute(p) && existsSync(path.join(p,'node_modules')));
    const lokal = !!root;
    root ??= path.resolve('/__synapse_typen__',sha(project).slice(0,16));
    const auftrag = {project,root,quellen:rows,dateien,ziele:intel.ziele,budget_ms:Math.max(1,ms-(Date.now()-start)),basisvergleich};
    const ergebnis = !lokal && workspacePruefer ? await workspacePruefer(auftrag) : await imWorker(auftrag);
    return {...ergebnis,dateien:intel.ziele,befunde:[...intel.befunde,...ergebnis.befunde],dauer_ms:Date.now()-start,
      betroffene_aufrufer:intel.ziele.filter(p=>!unterstuetzt.some(d=>d.file_path===p))};
  } catch (err) {
    return { ...leeresErgebnis('nicht_verfuegbar',(err as Error).message),befunde:intel.befunde,dateien:intel.ziele,dauer_ms:Date.now()-start };
  }
}
