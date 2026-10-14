/**
 * MODUL: Build-Pruefung (P16-T16 Etappe 1, 14.10.2026)
 *
 * ZWECK: Ein TypeScript-Monorepo PROJEKTWEIT ueber die Paketgrenzen pruefen - tsc --noEmit je Paket-tsconfig, die
 *        Workspace-Pakete untereinander auf ihre QUELLEN umgebogen (paths) statt auf dist/. Laeuft im BESTEHENDEN
 *        Pruefcontainer auf Unraid (rest-api meldet die Anbindung an, registriereBuildPruefer). Ergaenzt die
 *        Typpruefung je Paket (typen-pruefung.ts, P16-T15), ersetzt sie nicht.
 *
 * NUR PRUEFEN (User 14.10., thought db49c8d6): --noEmit, keine Abhaengigkeitsskripte, kein Projektcode wird
 *        ausgefuehrt, nichts aus dem Lauf wird gestartet. Quelle ist PG (code_files) plus der Plan-Schatten im
 *        Speicher; nichts kommt von der Platte, nichts wird ins Projekt geschrieben (Container-tmpfs, danach weg).
 *
 * BEFUNDE: nur NEUE Diagnosen gegenueber dem Basisstand (gleiche Projektmenge, gleiches Werkzeug). Vergleich ohne
 *        Zeilennummer (Datei|Code|Meldung als Mehrfachmenge), damit verschobene Altfehler nicht als neu gelten.
 *        quelle 'build', severity error, quittierbar wie jeder Planbefund (files commit befunde_quittieren).
 *        Folgefehler in unveraenderten Dateien (Aufrufer) haben keine belegbare Op: op_index null, beteiligt = alle.
 *
 * SCHALTER: Standard AUS (bis die Basis gruen ist). Wirksam: Projekt-Eintrag, sonst global, sonst Env
 *        BUILD_PRUEFUNG=1. Setzen nur Koordinator/User: code_check(build_einstellungen, modus:'setzen', aktiv, project).
 *        Aus = keine Build-Stufe, alle Antworten unveraendert zum Altstand.
 *
 * TEILWEISE: Zeitlimit, Speicher (OOM), zu grosser Schnappschuss -> 'teilweise'; kein Pruefcontainer in diesem Prozess
 *        -> 'nicht_verfuegbar'. Beides SPERRT NIE (User-Entscheidung 444127bc Punkt 2d), nur Hinweis.
 *
 * WARTESCHLANGE (User-Idee 444127bc): Laeuft fuer ein Projekt die Pruefung eines commits noch (oder wartet schon ein
 *        commit dieses Projekts), wird der commit EINGEREIHT statt den Agenten zu blockieren (Antwort
 *        build_pruefung_eingereiht, nichts geschrieben). Die Warteschlange fuehrt die commits je Projekt der Reihe nach
 *        selbst aus (FIFO, file-batch registriert den Ausfuehrer); das Resultat geht als Event ANNOUNCEMENT
 *        (Quelle build-pruefung) an den Agenten.
 *        NUR IM SPEICHER (bewusst, Abnahme d996c097): Warteschlange, Basis-Cache und Status leben im API-Prozess.
 *        Ein Neustart verwirft eingereihte commits ohne Event - nichts wurde geschrieben, der Plan bleibt open. Die
 *        Eingereiht-Antwort (file-batch.ts) sagt das und nennt den Weg (plan_status + build_status, dann erneut committen).
 *        Persistenz waere riskanter: die gespeicherten commit-Argumente muessten nach dem Neustart ohne den urspruenglichen
 *        Aufrufkontext erneut ausgefuehrt werden.
 *
 * BASIS-CACHE je Commit: Ergebnis je Inhalts-Schnappschuss (sha256 ueber Pfad + Inhalt der gesendeten Dateien,
 *        Projektmenge, Budget). Nach einem commit ist der neue PG-Stand inhaltsgleich zum geprueften Schatten - dessen
 *        Ergebnis ist ohne neuen Lauf die Basis des naechsten Plans.
 *
 * BUDGET (User 444127bc 2b): Speicher und tmpfs des Pruefcontainers, Heap von tsc und Zeitlimit per
 *        code_check(build_einstellungen) einstellbar (Tabelle build_pruefung_einstellungen), im Tool abrufbar.
 *        Aenderung von Speicher/tmpfs startet den Container neu (vor dem naechsten Auftrag abgeglichen).
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import ts from 'typescript';
import { getPool } from '../db/client.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';
import { emitEvent } from './events.js';
import type { PruefDatei } from './plan-befunde.js';
import type { FehlerBefund } from './fehlermuster-pruefung.js';

// ─── Vertrag zum Pruefcontainer (rest-api pruef-container.ts, pruefer_tsbuild.py) ───────────────────────────

export interface BuildDatei {
  /** Projekt-relativer Pfad (keine absoluten Pfade, kein '..'). */
  pfad: string;
  inhalt: string;
  /** Platzhalter @@WURZEL@@ im Inhalt durch das Arbeitsverzeichnis im Container ersetzen (nur erzeugte tsconfigs). */
  wurzel_ersetzen?: boolean;
}

export interface BuildAuftrag {
  dateien: BuildDatei[];
  /** Zu pruefende tsconfig-Dateien (die erzeugten tsconfig.synapse-build.json), projekt-relativ. */
  projekte: string[];
  zeitlimit_ms: number;
  heap_mb: number;
}

export interface BuildDiagnose {
  /** Projekt-relativ; null = Diagnose ohne Datei (z. B. fehlende Typdefinition). */
  datei: string | null;
  zeile: number;
  spalte: number;
  code: string;
  meldung: string;
  /** tsconfig, in deren Lauf die Diagnose entstand (wie in BuildAuftrag.projekte). */
  projekt: string;
}

export interface BuildProjektLauf {
  projekt: string;
  status: 'fertig' | 'zeitlimit' | 'speicher' | 'fehler';
  ms: number;
  rc: number | null;
  hinweis?: string;
}

export interface BuildLaufErgebnis {
  status: 'fertig' | 'teilweise' | 'nicht_verfuegbar';
  dauer_ms: number;
  projekte: BuildProjektLauf[];
  diagnosen: BuildDiagnose[];
  hinweis?: string;
  /** z. B. "tsc 5.9.3 (node v24.10.0)" */
  werkzeug?: string;
}

export interface BuildPrueferAnbindung {
  pruefe(auftrag: BuildAuftrag): Promise<BuildLaufErgebnis>;
  /** Speicher/tmpfs des Pruefcontainers setzen; ein laufender Container wird neu gestartet. */
  setzeBudget(b: { speicher_mb?: number; tmpfs_mb?: number }): Promise<unknown> | unknown;
  /** Aktuell wirksame Container-Grenzen. */
  budget(): { speicher_mb: number; tmpfs_mb: number };
}

/** Stand der Build-Stufe an einem Plan (PlanPruefung.build, plan/plan_status/commit). */
export interface BuildStand {
  status: 'fertig' | 'teilweise' | 'laeuft' | 'nicht_verfuegbar';
  /** Schalter wirksam (sonst gibt es keinen Stand). */
  tor: boolean;
  neue_fehler: number;
  basis_fehler?: number;
  /** Gepruefte tsconfig-Dateien. */
  projekte: string[];
  dauer_ms: number;
  werkzeug?: string;
  hinweis?: string;
  /** Laufende/wartende Pruefungen gerade (nur bei status laeuft). */
  laufend?: number;
}

export type BuildBefund = FehlerBefund & { op_index: number | null; agent_id: string | null; beteiligt?: number[] };

export interface BuildPlanErgebnis {
  stand: BuildStand;
  befunde: BuildBefund[];
}

let anbindung: BuildPrueferAnbindung | null = null;

/** Nur der Prozess mit Pruefcontainer (rest-api) meldet sich an. */
export function registriereBuildPruefer(a: BuildPrueferAnbindung | null): void {
  anbindung = a;
}

// ─── Hilfen ─────────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const TS_DATEI = /\.(?:ts|tsx|mts|cts)$/;
const KONFIG_DATEI = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/;
/** Dateien, deren Aenderung eine Build-Pruefung ausloest (TypeScript-Quellen, package.json, tsconfig*.json). */
export const istBuildRelevant = (p: string): boolean => TS_DATEI.test(p) || KONFIG_DATEI.test(p);
const WRAPPER_NAME = 'tsconfig.synapse-build.json';
const WURZEL = '@@WURZEL@@';
const KEIN_PRUEFER = 'Kein Pruefcontainer in diesem Prozess (die Build-Pruefung laeuft nur in der Synapse-API); kein Build-Tor, nichts gesperrt.';
const CACHE_MAX = 48;

function envZahl(name: string, standard: number): number {
  const roh = process.env[name];
  const wert = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : standard;
}

const dirOf = (p: string): string => {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
};
const verbinde = (dir: string, rel: string): string => {
  const n = path.posix.normalize(path.posix.join(dir || '.', rel));
  return n === '.' ? '' : n.replace(/^\.\//, '');
};
const unter = (datei: string, dir: string): boolean => dir === '' || datei.startsWith(dir + '/');
/** Wartet hoechstens ms auf p; der Timer wird in jedem Fall geloescht. null = Zeit um. */
function hoechstens<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    p.then((wert) => { clearTimeout(timer); resolve(wert); }, () => { clearTimeout(timer); resolve(null); });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** JSON/tsconfig tolerant lesen (Kommentare, Kommas am Ende); null bei Fehler. */
function lesJson(text: string | undefined, pfad: string): Json | null {
  if (text === undefined) return null;
  const r = ts.parseConfigFileTextToJson(pfad, text);
  return r.error || !r.config || typeof r.config !== 'object' ? null : (r.config as Json);
}

// ─── Einstellungen (Tabelle build_pruefung_einstellungen) ───────────────────────────────────────────────────────

interface Werte {
  aktiv?: boolean;
  speicher_mb?: number;
  tmpfs_mb?: number;
  heap_mb?: number;
  zeitlimit_s?: number;
}

interface EinstellungsZeile {
  bereich: string;
  werte: Werte;
  gesetzt_von: string | null;
  grund: string | null;
  gesetzt_am: string;
}

let einstellungsCache: { zeit: number; zeilen: Map<string, EinstellungsZeile>; fehler?: string } | null = null;

async function ladeEinstellungen(frisch = false): Promise<Map<string, EinstellungsZeile>> {
  if (!frisch && einstellungsCache && Date.now() - einstellungsCache.zeit < envZahl('BUILD_PRUEFUNG_CACHE_MS', 5000)) {
    return einstellungsCache.zeilen;
  }
  try {
    const r = await getPool().query<{ bereich: string; werte: Werte | null; gesetzt_von: string | null; grund: string | null; gesetzt_am: Date | string }>(
      'SELECT bereich, werte, gesetzt_von, grund, gesetzt_am FROM build_pruefung_einstellungen',
    );
    const zeilen = new Map(r.rows.map((z) => [z.bereich, {
      bereich: z.bereich, werte: z.werte ?? {}, gesetzt_von: z.gesetzt_von, grund: z.grund, gesetzt_am: new Date(z.gesetzt_am).toISOString(),
    }] as const));
    einstellungsCache = { zeit: Date.now(), zeilen };
  } catch (err) {
    // Tabelle fehlt (DB vor P16-T16) oder PG kurz weg: nur Env-Standard (Schalter aus, wenn BUILD_PRUEFUNG nicht 1).
    einstellungsCache = { zeit: Date.now(), zeilen: new Map(), fehler: (err as Error).message };
  }
  return einstellungsCache.zeilen;
}

/** Wirksamer Schalter fuer ein Projekt: Projekt-Eintrag, sonst global, sonst Env BUILD_PRUEFUNG=1 (Standard aus). */
export async function buildAktiv(project: string): Promise<{ aktiv: boolean; quelle: 'projekt' | 'global' | 'env' }> {
  const z = await ladeEinstellungen();
  const p = z.get('projekt:' + project)?.werte.aktiv;
  if (typeof p === 'boolean') return { aktiv: p, quelle: 'projekt' };
  const g = z.get('global')?.werte.aktiv;
  if (typeof g === 'boolean') return { aktiv: g, quelle: 'global' };
  return { aktiv: process.env.BUILD_PRUEFUNG === '1', quelle: 'env' };
}

export interface BuildBudget {
  speicher_mb: number;
  tmpfs_mb: number;
  heap_mb: number;
  zeitlimit_s: number;
  max_mb: number;
}

/** Wirksames Budget: Tabelle (bereich 'pruefcontainer') vor Env. heap_mb ohne Angabe = Speicher - 192 MB (mind. 128). */
export async function wirksamesBuildBudget(): Promise<BuildBudget> {
  const w = (await ladeEinstellungen()).get('pruefcontainer')?.werte ?? {};
  const speicher = w.speicher_mb ?? Math.max(128, envZahl('PRUEFCONTAINER_MEM_MB', 384));
  const tmpfs = w.tmpfs_mb ?? Math.max(8, envZahl('PRUEFCONTAINER_TMPFS_MB', 64));
  const heapEnv = envZahl('BUILD_PRUEFUNG_HEAP_MB', 0);
  return {
    speicher_mb: speicher,
    tmpfs_mb: tmpfs,
    heap_mb: w.heap_mb ?? (heapEnv > 0 ? heapEnv : Math.max(128, speicher - 192)),
    zeitlimit_s: w.zeitlimit_s ?? (envZahl('BUILD_PRUEFUNG_ZEITLIMIT_S', 300) || 300),
    // Schnappschuss darf das tmpfs nicht fuellen (Dateien + tsc-Arbeitsplatz).
    max_mb: Math.max(1, Math.min(envZahl('BUILD_PRUEFUNG_MAX_MB', 48) || 48, Math.floor(tmpfs * 0.8))),
  };
}

/**
 * Speicher/tmpfs der Tabelle auf den Pruefcontainer anwenden, wenn sie abweichen (Start der API, vor jedem Auftrag,
 * nach build_einstellungen). Rueckgabe true = geaendert (der Container startet beim naechsten Auftrag neu). Wirft nie.
 */
export async function synchronisiereBuildBudget(frisch = false): Promise<boolean> {
  if (!anbindung) return false;
  try {
    const w = (await ladeEinstellungen(frisch)).get('pruefcontainer')?.werte;
    if (!w || (w.speicher_mb === undefined && w.tmpfs_mb === undefined)) return false;
    const ist = anbindung.budget();
    const soll = { speicher_mb: w.speicher_mb ?? ist.speicher_mb, tmpfs_mb: w.tmpfs_mb ?? ist.tmpfs_mb };
    if (soll.speicher_mb === ist.speicher_mb && soll.tmpfs_mb === ist.tmpfs_mb) return false;
    await anbindung.setzeBudget(soll);
    return true;
  } catch (err) {
    console.error(`[build-pruefung] Budget nicht angewendet: ${(err as Error).message}`);
    return false;
  }
}

// ─── Schnappschuss, Pakete, Projekte ─────────────────────────────────────────────────────────────────────────────

/** TS-Quellen + package.json + tsconfig*.json des Projekts aus PG (ohne node_modules). */
async function ladeQuellen(project: string): Promise<Map<string, string>> {
  const rows = (await getPool().query<{ file_path: string; content: string }>(
    `SELECT file_path, content FROM code_files
      WHERE project = $1 AND deleted_at IS NULL AND ignored = false AND content IS NOT NULL
        AND (file_path ~ $2 OR file_path ~ $3) AND file_path !~ $4
      ORDER BY file_path`,
    [project, '\\.(ts|tsx|mts|cts)$', '(^|/)(package\\.json|tsconfig[^/]*\\.json)$', '(^|/)node_modules/'],
  )).rows;
  return new Map(rows.map((r) => [r.file_path, r.content]));
}

interface KonfigGlied {
  pfad: string;
  config: Json;
}

/** tsconfig samt relativer extends-Kette (nur Dateien aus demselben Schnappschuss). */
function konfigKette(cfg: string, quellen: Map<string, string>): KonfigGlied[] {
  const kette: KonfigGlied[] = [];
  const besucht = new Set<string>();
  let aktuell: string | null = cfg;
  while (aktuell && !besucht.has(aktuell)) {
    besucht.add(aktuell);
    const c = lesJson(quellen.get(aktuell), aktuell);
    if (!c) break;
    kette.push({ pfad: aktuell, config: c });
    const ext: unknown = Array.isArray(c.extends) ? c.extends[0] : c.extends;
    if (typeof ext !== 'string' || !ext.startsWith('.')) break;
    let ziel = verbinde(dirOf(aktuell), ext);
    if (!ziel.endsWith('.json')) ziel += '.json';
    aktuell = ziel;
  }
  return kette;
}

/** compilerOptions.<name> aus der Kette (erster Treffer) samt Ordner der Datei, in der es steht. */
function option(kette: KonfigGlied[], name: string): { wert: unknown; dir: string } | undefined {
  for (const k of kette) {
    const co = k.config.compilerOptions;
    if (co && typeof co === 'object' && name in co) return { wert: co[name], dir: dirOf(k.pfad) };
  }
  return undefined;
}

interface Paket {
  name: string;
  dir: string;
  abhaengig: string[];
  /** Projekt-relativer Pfad der Einstiegs-Quelle (z. B. packages/core/src/index.ts), null = unbekannt. */
  einstieg: string | null;
  /** Quellwurzel des Pakets (rootDir, sonst src). */
  quellwurzel: string;
}

function typenFeld(pkg: Json): string | undefined {
  const exp = pkg.exports;
  const punkt = exp && typeof exp === 'object' && !Array.isArray(exp) ? (exp['.'] ?? (typeof exp.types === 'string' || typeof exp.import === 'string' ? exp : undefined)) : exp;
  const ausExports = typeof punkt === 'string' ? punkt
    : punkt && typeof punkt === 'object' ? [punkt.types, punkt.import, punkt.default, punkt.require].find((x) => typeof x === 'string') : undefined;
  return [pkg.types, pkg.typings, ausExports, pkg.main].find((x): x is string => typeof x === 'string' && x.trim() !== '');
}

/** Workspace-Pakete des Schnappschusses (package.json mit name), mit Einstiegs-Quelle statt dist/. */
function lesePakete(quellen: Map<string, string>): Map<string, Paket> {
  const pakete = new Map<string, Paket>();
  for (const [pfad, text] of quellen) {
    if (path.posix.basename(pfad) !== 'package.json') continue;
    const pkg = lesJson(text, pfad);
    if (!pkg || typeof pkg.name !== 'string' || !pkg.name.trim()) continue;
    const dir = dirOf(pfad);
    const abhaengig = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((k) => (pkg[k] && typeof pkg[k] === 'object' ? Object.keys(pkg[k]) : []));
    const kette = konfigKette(verbinde(dir, 'tsconfig.json'), quellen);
    const root = option(kette, 'rootDir');
    const out = option(kette, 'outDir');
    const quellwurzel = root && typeof root.wert === 'string' ? verbinde(root.dir, root.wert) : verbinde(dir, 'src');
    const ausgabe = out && typeof out.wert === 'string' ? verbinde(out.dir, out.wert) : null;
    const kandidaten: string[] = [];
    const typen = typenFeld(pkg);
    if (typen) {
      let ziel = verbinde(dir, typen);
      if (ausgabe && (ziel === ausgabe || ziel.startsWith(ausgabe + '/'))) ziel = quellwurzel + ziel.slice(ausgabe.length);
      const ohne = ziel.replace(/\.d\.(?:ts|mts|cts)$/, '').replace(/\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/, '');
      kandidaten.push(...['.ts', '.tsx', '.mts', '.cts', '.d.ts'].map((e) => ohne + e));
    }
    kandidaten.push(verbinde(quellwurzel, 'index.ts'), verbinde(quellwurzel, 'index.tsx'), verbinde(dir, 'index.ts'));
    pakete.set(pkg.name, { name: pkg.name, dir, abhaengig, einstieg: kandidaten.find((k) => quellen.has(k)) ?? null, quellwurzel });
  }
  return pakete;
}

/** Zu pruefende Projekte: tsconfig.json neben einer package.json (oder an der Wurzel). */
function tsProjekte(quellen: Map<string, string>): string[] {
  return [...quellen.keys()]
    .filter((p) => path.posix.basename(p) === 'tsconfig.json' && (p === 'tsconfig.json' || quellen.has(verbinde(dirOf(p), 'package.json'))))
    .sort();
}

/**
 * Betroffene Projekte eines Plans: Projekte, in deren Ordner eine geaenderte Datei liegt, plus (transitiv) alle
 * Projekte, deren Paket ein betroffenes Paket als Abhaengigkeit nennt. Gemeinsame Konfig ausserhalb aller
 * Projektordner (tsconfig.base.json, Wurzel-package.json) -> alle Projekte.
 */
function betroffeneProjekte(alle: string[], pakete: Map<string, Paket>, geaendert: string[]): string[] {
  const betroffen = new Set<string>();
  for (const f of geaendert) {
    const treffer = alle.filter((c) => unter(f, dirOf(c)));
    if (treffer.length === 0 && KONFIG_DATEI.test(f)) return alle;
    for (const c of treffer) betroffen.add(c);
  }
  const paketVon = (c: string): Paket | undefined => [...pakete.values()].find((p) => p.dir === dirOf(c));
  for (let weiter = true; weiter;) {
    weiter = false;
    const namen = new Set([...betroffen].map((c) => paketVon(c)?.name).filter((n): n is string => !!n));
    for (const c of alle) {
      if (betroffen.has(c)) continue;
      if (paketVon(c)?.abhaengig.some((n) => namen.has(n))) {
        betroffen.add(c);
        weiter = true;
      }
    }
  }
  return alle.filter((c) => betroffen.has(c));
}

const wrapperPfad = (cfg: string): string => verbinde(dirOf(cfg), WRAPPER_NAME);

/**
 * Erzeugte tsconfig neben der Paket-tsconfig: erbt alles (extends ./tsconfig.json, also auch include/files/exclude),
 * schaltet Ausgaben ab und biegt die Workspace-Pakete auf ihre Quellen um. Vorhandene paths behalten Vorrang
 * (absolut gemacht). Pfade mit @@WURZEL@@ ersetzt der Container durch sein Arbeitsverzeichnis.
 */
function erzeugeWrapper(cfg: string, pakete: Map<string, Paket>, quellen: Map<string, string>): string {
  const dir = dirOf(cfg);
  const kette = konfigKette(cfg, quellen);
  const paths: Record<string, string[]> = {};
  for (const p of pakete.values()) {
    if (!p.einstieg || p.dir === dir) continue;
    paths[p.name] = [`${WURZEL}/${p.einstieg}`];
    paths[`${p.name}/*`] = [`${WURZEL}/${p.quellwurzel ? p.quellwurzel + '/' : ''}*`];
  }
  const eigene = option(kette, 'paths');
  if (eigene && eigene.wert && typeof eigene.wert === 'object') {
    const basis = option(kette, 'baseUrl');
    const bezug = basis && typeof basis.wert === 'string' ? verbinde(basis.dir, basis.wert) : eigene.dir;
    for (const [k, v] of Object.entries(eigene.wert as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      paths[k] = v.filter((x): x is string => typeof x === 'string')
        .map((x) => (x.startsWith('/') ? x : `${WURZEL}/${verbinde(bezug, x)}`));
    }
  }
  const compilerOptions: Json = {
    noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false, emitDeclarationOnly: false,
    sourceMap: false, skipLibCheck: true, rootDir: WURZEL,
    ...(Object.keys(paths).length > 0 ? { paths } : {}),
  };
  return JSON.stringify({ extends: './tsconfig.json', compilerOptions }, null, 1) + '\n';
}

interface Vorbereitet {
  auftrag: BuildAuftrag;
  schluessel: string;
  bytes: number;
}

/** Auftrag fuer den Container: Konfigs + TS-Quellen in Projektordnern + erzeugte tsconfigs; Schluessel fuer den Cache. */
function bereiteVor(quellen: Map<string, string>, projekte: string[], budget: BuildBudget): Vorbereitet {
  const pakete = lesePakete(quellen);
  const ordner = tsProjekte(quellen).map(dirOf);
  const dateien: BuildDatei[] = [];
  let bytes = 0;
  for (const [pfad, inhalt] of quellen) {
    if (!KONFIG_DATEI.test(pfad) && !ordner.some((d) => unter(pfad, d))) continue;
    dateien.push({ pfad, inhalt });
    bytes += Buffer.byteLength(inhalt);
  }
  for (const c of projekte) {
    const inhalt = erzeugeWrapper(c, pakete, quellen);
    dateien.push({ pfad: wrapperPfad(c), inhalt, wurzel_ersetzen: true });
    bytes += Buffer.byteLength(inhalt);
  }
  const wrapper = projekte.map(wrapperPfad);
  const auftrag: BuildAuftrag = { dateien, projekte: wrapper, zeitlimit_ms: budget.zeitlimit_s * 1000, heap_mb: budget.heap_mb };
  const schluessel = sha(JSON.stringify(['e1', budget.heap_mb, budget.zeitlimit_s, wrapper, dateien.map((d) => [d.pfad, sha(d.inhalt)])]));
  return { auftrag, schluessel, bytes };
}

// ─── Ausfuehrung (ein Auftrag zur Zeit, Ergebnis-Cache) ─────────────────────────────────────────────────────────

const ergebnisCache = new Map<string, BuildLaufErgebnis>();
const laufend = new Map<string, Promise<BuildLaufErgebnis>>();
let kette: Promise<unknown> = Promise.resolve();
const projektLaeuft = new Map<string, number>();

interface ProjektBasis {
  status: BuildLaufErgebnis['status'];
  fehler: number;
  projekte: string[];
  vollstaendig: boolean;
  geprueft_am: string;
  dauer_ms: number;
  werkzeug?: string;
  hinweis?: string;
  erste_fehler: Array<Pick<BuildDiagnose, 'datei' | 'zeile' | 'code' | 'meldung'>>;
}
const projektBasis = new Map<string, ProjektBasis>();

function leer(status: BuildLaufErgebnis['status'], hinweis: string): BuildLaufErgebnis {
  return { status, dauer_ms: 0, projekte: [], diagnosen: [], hinweis };
}

function merke(schluessel: string, e: BuildLaufErgebnis): void {
  ergebnisCache.delete(schluessel);
  ergebnisCache.set(schluessel, e);
  while (ergebnisCache.size > CACHE_MAX) ergebnisCache.delete(ergebnisCache.keys().next().value as string);
}

function merkeBasis(project: string, e: BuildLaufErgebnis, projekte: string[], vollstaendig: boolean): void {
  const alt = projektBasis.get(project);
  // Ein Teilblick (nur betroffene Projekte eines Plans) ueberschreibt keinen vollstaendigen Basisstand.
  if (alt?.vollstaendig && !vollstaendig && Date.now() - new Date(alt.geprueft_am).getTime() < 10 * 60_000) return;
  projektBasis.set(project, {
    status: e.status, fehler: e.diagnosen.length, projekte, vollstaendig, geprueft_am: new Date().toISOString(), dauer_ms: e.dauer_ms,
    ...(e.werkzeug ? { werkzeug: e.werkzeug } : {}), ...(e.hinweis ? { hinweis: e.hinweis } : {}),
    erste_fehler: e.diagnosen.slice(0, 5).map((d) => ({ datei: d.datei, zeile: d.zeile, code: d.code, meldung: d.meldung.slice(0, 300) })),
  });
}

/** Startet (bzw. teilt) einen Lauf. Nie parallel im Container: eine Kette fuer alle Projekte. Wirft nie. */
function starteLauf(project: string, v: Vorbereitet, basis?: { projekte: string[]; vollstaendig: boolean }): Promise<BuildLaufErgebnis> {
  const treffer = ergebnisCache.get(v.schluessel);
  if (treffer) return Promise.resolve(treffer);
  const offen = laufend.get(v.schluessel);
  if (offen) return offen;
  projektLaeuft.set(project, (projektLaeuft.get(project) ?? 0) + 1);
  const p = kette.then(async (): Promise<BuildLaufErgebnis> => {
    const t0 = Date.now();
    try {
      await synchronisiereBuildBudget();
      if (!anbindung) return leer('nicht_verfuegbar', KEIN_PRUEFER);
      if (v.auftrag.projekte.length === 0) return { status: 'fertig', dauer_ms: 0, projekte: [], diagnosen: [] };
      const e = await anbindung.pruefe(v.auftrag);
      return { ...e, dauer_ms: e.dauer_ms || Date.now() - t0 };
    } catch (err) {
      return { ...leer('nicht_verfuegbar', `Pruefcontainer: ${(err as Error).message}`), dauer_ms: Date.now() - t0 };
    }
  });
  kette = p.catch(() => undefined);
  laufend.set(v.schluessel, p);
  void p.then((e) => {
    if (e.status !== 'nicht_verfuegbar') merke(v.schluessel, e);
    if (basis) merkeBasis(project, e, basis.projekte, basis.vollstaendig);
  }).finally(() => {
    laufend.delete(v.schluessel);
    const n = (projektLaeuft.get(project) ?? 1) - 1;
    if (n > 0) projektLaeuft.set(project, n); else projektLaeuft.delete(project);
  });
  return p;
}

// ─── Vergleich Basis <-> Schatten ───────────────────────────────────────────────────────────────────────────────

const meldungNorm = (m: string): string => m.replace(/\s+/g, ' ').trim();
const diagSchluessel = (d: BuildDiagnose): string => `${d.datei ?? ''}|${d.code}|${meldungNorm(d.meldung)}`;

function inOpSpanne(d: BuildDiagnose, dateien: PruefDatei[]): boolean {
  const datei = d.datei ? dateien.find((f) => f.file_path === d.datei) : undefined;
  if (!datei) return false;
  const i = d.zeile - 1;
  return datei.ops.some((o) => o.spannen.some(([s, e]) => (s < e ? i >= s && i < e : Math.abs(i - s) <= 1)));
}

/** Diagnosen des Schattens, die im Basisstand (als Mehrfachmenge ohne Zeile) nicht vorkommen. */
function neueDiagnosen(basis: BuildDiagnose[], schatten: BuildDiagnose[], dateien: PruefDatei[]): BuildDiagnose[] {
  const anzahl = new Map<string, number>();
  for (const d of basis) anzahl.set(diagSchluessel(d), (anzahl.get(diagSchluessel(d)) ?? 0) + 1);
  const gruppen = new Map<string, BuildDiagnose[]>();
  for (const d of schatten) gruppen.set(diagSchluessel(d), [...(gruppen.get(diagSchluessel(d)) ?? []), d]);
  const neu: BuildDiagnose[] = [];
  for (const [k, liste] of gruppen) {
    const ueber = liste.length - (anzahl.get(k) ?? 0);
    if (ueber <= 0) continue;
    // Bei gleicher Meldung zuerst die Stellen in geaenderten Zeilen als neu werten.
    const sortiert = [...liste].sort((x, y) => Number(inOpSpanne(y, dateien)) - Number(inOpSpanne(x, dateien)) || x.zeile - y.zeile);
    neu.push(...sortiert.slice(0, ueber));
  }
  return neu;
}

function opZuordnung(d: BuildDiagnose, dateien: PruefDatei[]): { op_index: number | null; agent_id: string | null; beteiligt?: number[] } {
  const datei = d.datei ? dateien.find((f) => f.file_path === d.datei) : undefined;
  if (datei && datei.ops.length > 0) {
    const i = d.zeile - 1;
    const treffer = datei.ops.filter((o) => o.spannen.some(([s, e]) => (s < e ? i >= s && i < e : Math.abs(i - s) <= 1)));
    const op = (treffer.length > 0 ? treffer : datei.ops).reduce((x, y) => (y.op_index > x.op_index ? y : x));
    return { op_index: op.op_index, agent_id: op.agent_id };
  }
  // Folgefehler in einer unveraenderten Datei (Aufrufer, Importeur): keine belegbare Op.
  const alle = [...new Set(dateien.flatMap((f) => f.ops.map((o) => o.op_index)))].sort((a, b) => a - b);
  return { op_index: null, agent_id: null, ...(alle.length > 0 ? { beteiligt: alle } : {}) };
}

function alsBefund(d: BuildDiagnose, dateien: PruefDatei[], werkzeug: string): BuildBefund {
  const paket = dirOf(d.projekt) || '.';
  return {
    quelle: 'build',
    pruefer: `build:${werkzeug.split(' (')[0].replace(/\s+/g, '@')}`,
    severity: 'error',
    datei: d.datei ?? verbinde(dirOf(d.projekt), 'tsconfig.json'),
    zeilen: [Math.max(1, d.zeile), Math.max(1, d.zeile)],
    ...(d.spalte > 0 ? { spalte: d.spalte } : {}),
    // Code mit Kurz-Hash der Meldung: Quittierungen bleiben je Meldung getrennt (Schluessel ohne Zeile).
    code: `${d.code}#${sha(meldungNorm(d.meldung)).slice(0, 6)}`,
    titel: `${d.code} (Build ${paket})`,
    was: d.meldung,
    warum: `Neuer Fehler der projektweiten TypeScript-Pruefung (tsc --noEmit ueber die Paketgrenzen, Paket ${paket}) gegenueber dem Basisstand.`,
    wie: 'Betroffene Aufrufer/Typen im selben Plan anpassen (plan_update bzw. coedit_add) oder bewusst quittieren (commit mit befunde_quittieren).',
    wo: [d.projekt],
    ...opZuordnung(d, dateien),
  };
}

// ─── Plan-Stufe (plan-befunde.ts) ───────────────────────────────────────────────────────────────────────────────

/**
 * Build-Stufe eines Plans. null = Schalter aus oder keine relevante Datei (Antwort unveraendert).
 * warten:false (plan, plan_status, commit eines Agenten): vorhandene Ergebnisse sofort, sonst Lauf im Hintergrund
 * starten und status 'laeuft'. warten:true (Warteschlange): auf das Resultat warten. Wirft nie.
 */
export async function pruefeBuildFuerPlan(project: string, dateien: PruefDatei[], o: { warten?: boolean } = {}): Promise<BuildPlanErgebnis | null> {
  const relevant = dateien.filter((d) => istBuildRelevant(d.file_path));
  if (relevant.length === 0) return null;
  const t0 = Date.now();
  const stand = (s: Partial<BuildStand> & Pick<BuildStand, 'status'>): BuildStand => ({ tor: true, neue_fehler: 0, projekte: [], ...s, dauer_ms: s.dauer_ms ?? Date.now() - t0 });
  try {
    if (!(await buildAktiv(project)).aktiv) return null;
    if (!anbindung) return { stand: stand({ status: 'nicht_verfuegbar', hinweis: KEIN_PRUEFER }), befunde: [] };
    const budget = await wirksamesBuildBudget();
    const basisQuellen = await ladeQuellen(project);
    const schattenQuellen = new Map(basisQuellen);
    for (const d of relevant) {
      if (d.geloescht) schattenQuellen.delete(d.file_path);
      else schattenQuellen.set(d.file_path, d.ergebnis);
    }
    const projekte = betroffeneProjekte(tsProjekte(schattenQuellen), lesePakete(schattenQuellen), relevant.map((d) => d.file_path));
    if (projekte.length === 0) {
      return { stand: stand({ status: 'fertig', hinweis: 'Kein TypeScript-Projekt (tsconfig.json neben package.json) betroffen.' }), befunde: [] };
    }
    const basisProjekte = projekte.filter((c) => basisQuellen.has(c));
    const a = bereiteVor(basisQuellen, basisProjekte, budget);
    const b = bereiteVor(schattenQuellen, projekte, budget);
    const groesste = Math.max(a.bytes, b.bytes);
    if (groesste > budget.max_mb * 1024 * 1024) {
      return {
        stand: stand({ status: 'teilweise', projekte, hinweis: `Schnappschuss ${(groesste / 1048576).toFixed(1)} MB > ${budget.max_mb} MB (BUILD_PRUEFUNG_MAX_MB bzw. 80 % tmpfs) - nicht geprueft, nichts gesperrt. Mehr Platz: code_check(build_einstellungen, modus:'setzen', tmpfs_mb).` }),
        befunde: [],
      };
    }
    let basis = ergebnisCache.get(a.schluessel);
    let schatten = ergebnisCache.get(b.schluessel);
    if (!basis || !schatten) {
      const pa = starteLauf(project, a, { projekte: basisProjekte, vollstaendig: false });
      const pb = starteLauf(project, b);
      if (!o.warten) {
        return {
          stand: stand({ status: 'laeuft', projekte, laufend: laufend.size, hinweis: 'Projektweite Build-Pruefung laeuft im Pruefcontainer (Basis und Plan-Stand); Ergebnis bei plan_status/commit. Ein commit wird solange eingereiht, nicht gesperrt.' }),
          befunde: [],
        };
      }
      [basis, schatten] = await Promise.all([pa, pb]);
    }
    if (basis.status === 'nicht_verfuegbar' || schatten.status === 'nicht_verfuegbar') {
      return { stand: stand({ status: 'nicht_verfuegbar', projekte, hinweis: schatten.hinweis ?? basis.hinweis ?? KEIN_PRUEFER }), befunde: [] };
    }
    const fertig = (e: BuildLaufErgebnis, w: string) => e.projekte.find((p) => p.projekt === w)?.status === 'fertig';
    const neu: BuildDiagnose[] = [];
    const unvollstaendig: string[] = [];
    for (const c of projekte) {
      const w = wrapperPfad(c);
      if (!fertig(schatten, w) || (basisQuellen.has(c) && !fertig(basis, w))) {
        const lauf = schatten.projekte.find((p) => p.projekt === w) ?? basis.projekte.find((p) => p.projekt === w);
        unvollstaendig.push(`${dirOf(c) || '.'}: ${lauf?.status ?? 'nicht gelaufen'}${lauf?.hinweis ? ` (${lauf.hinweis})` : ''}`);
        continue;
      }
      neu.push(...neueDiagnosen(basis.diagnosen.filter((d) => d.projekt === w), schatten.diagnosen.filter((d) => d.projekt === w), relevant));
    }
    // Dieselbe Diagnose aus mehreren Projekten (Quellen eines anderen Pakets per paths mitgeprueft) nur einmal.
    const gesehen = new Set<string>();
    const eindeutig = neu.filter((d) => {
      const k = `${d.datei ?? ''}|${d.zeile}|${d.code}|${meldungNorm(d.meldung)}`;
      if (gesehen.has(k)) return false;
      gesehen.add(k);
      return true;
    });
    const werkzeug = schatten.werkzeug ?? basis.werkzeug ?? 'tsc';
    const befunde = eindeutig.map((d) => alsBefund(d, relevant, werkzeug));
    const hinweise = [
      ...(unvollstaendig.length > 0 ? [`Teilweise geprueft (sperrt nicht): ${unvollstaendig.join('; ')}. Budget: code_check(build_einstellungen).`] : []),
      ...(befunde.length > 0 ? [`${befunde.length} neue(r) Build-Fehler gegenueber dem Basisstand - sperrt den commit; korrigieren oder quittieren.`] : []),
    ];
    return {
      stand: stand({
        status: unvollstaendig.length > 0 ? 'teilweise' : 'fertig', neue_fehler: befunde.length, basis_fehler: basis.diagnosen.length,
        projekte, dauer_ms: basis.dauer_ms + schatten.dauer_ms, werkzeug, ...(hinweise.length > 0 ? { hinweis: hinweise.join(' ') } : {}),
      }),
      befunde,
    };
  } catch (err) {
    return { stand: stand({ status: 'nicht_verfuegbar', hinweis: `Build-Pruefung fehlgeschlagen (sperrt nicht): ${(err as Error).message}` }), befunde: [] };
  }
}

/** Basisstand eines Projekts pruefen (alle TS-Projekte). wartenMs > 0: bis dahin auf das Resultat warten. */
export async function pruefeBuildBasis(project: string, wartenMs = 0): Promise<Record<string, unknown>> {
  if (!anbindung) return { gestartet: false, status: 'nicht_verfuegbar', hinweis: KEIN_PRUEFER };
  const budget = await wirksamesBuildBudget();
  const quellen = await ladeQuellen(project);
  const projekte = tsProjekte(quellen);
  if (projekte.length === 0) return { gestartet: false, status: 'fertig', hinweis: 'Keine TypeScript-Projekte (tsconfig.json neben package.json) im Index.' };
  const v = bereiteVor(quellen, projekte, budget);
  if (v.bytes > budget.max_mb * 1024 * 1024) {
    return { gestartet: false, status: 'teilweise', hinweis: `Schnappschuss ${(v.bytes / 1048576).toFixed(1)} MB > ${budget.max_mb} MB - tmpfs_mb erhoehen.` };
  }
  const p = starteLauf(project, v, { projekte, vollstaendig: true });
  if (wartenMs <= 0) return { gestartet: true, projekte, hinweis: 'Laeuft im Hintergrund; Stand mit code_check(action:"build_status", project).' };
  const e = await hoechstens(p, wartenMs);
  return e ? { gestartet: true, fertig: true, projekte, status: e.status, fehler: e.diagnosen.length, dauer_ms: e.dauer_ms }
    : { gestartet: true, fertig: false, projekte, hinweis: `Nach ${Math.round(wartenMs / 1000)} s noch nicht fertig; laeuft weiter.` };
}

// ─── Warteschlange der commits ──────────────────────────────────────────────────────────────────────────────────

export type BuildCommitAusfuehrer = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
let commitAusfuehrer: BuildCommitAusfuehrer | null = null;

/** file-batch.ts meldet commitBatch an (kein Import-Zyklus). */
export function registriereBuildCommitAusfuehrer(f: BuildCommitAusfuehrer): void {
  commitAusfuehrer = f;
}

interface Eintrag {
  project: string;
  plan_id: string;
  agent: string | null;
  args: Record<string, unknown>;
  eingereiht_am: string;
}

const warteschlangen = new Map<string, Eintrag[]>();
const inArbeit = new Set<string>();
const letzteCommits = new Map<string, Array<{ plan_id: string; agent: string | null; ergebnis: string; zeit: string }>>();
const imLauf = new AsyncLocalStorage<boolean>();

/** true, wenn der aktuelle commit aus der Build-Warteschlange kommt (dann wird gewartet statt eingereiht). */
export function laeuftAusBuildWarteschlange(): boolean {
  return imLauf.getStore() === true;
}

export function buildWarteschlangeLaenge(project: string): number {
  return warteschlangen.get(project)?.length ?? 0;
}

/** commit einreihen (gleicher Plan nur einmal; neuere Argumente gewinnen). */
export function reiheCommitEin(project: string, planId: string, args: Record<string, unknown>, agent: string | null): { position: number; laenge: number; eingereiht_am: string } {
  const liste = warteschlangen.get(project) ?? [];
  let eintrag = liste.find((e) => e.plan_id === planId);
  if (eintrag) {
    eintrag.args = { ...args };
    eintrag.agent = agent ?? eintrag.agent;
  } else {
    eintrag = { project, plan_id: planId, agent, args: { ...args }, eingereiht_am: new Date().toISOString() };
    liste.push(eintrag);
  }
  warteschlangen.set(project, liste);
  void arbeiteAb(project);
  return { position: liste.indexOf(eintrag) + 1, laenge: liste.length, eingereiht_am: eintrag.eingereiht_am };
}

async function meldeErgebnis(e: Eintrag, r: Record<string, unknown>): Promise<void> {
  const ok = r.success === true;
  const ergebnis = ok ? 'geschrieben' : String(r.error ?? 'nicht_geschrieben');
  const liste = letzteCommits.get(e.project) ?? [];
  liste.unshift({ plan_id: e.plan_id, agent: e.agent, ergebnis, zeit: new Date().toISOString() });
  letzteCommits.set(e.project, liste.slice(0, 10));
  if (!e.agent) return;
  const payload = {
    art: 'build_pruefung_commit',
    plan_id: e.plan_id,
    ergebnis,
    hinweis: ok
      ? `Eingereihter commit von Plan ${e.plan_id} nach der Build-Pruefung geschrieben (eingereiht ${e.eingereiht_am}).`
      : `Eingereihter commit von Plan ${e.plan_id} NICHT geschrieben: ${String(r.message ?? '').slice(0, 500)}`,
    ...(Array.isArray(r.blockierende) ? { blockierende: (r.blockierende as unknown[]).slice(0, 5) } : {}),
    abruf: `files(action:"plan_status", plan_id:"${e.plan_id}", ansicht:"befunde")`,
  };
  try {
    await emitEvent(e.project, 'ANNOUNCEMENT', ok ? 'normal' : 'high', `agent:${e.agent}`, 'build-pruefung', JSON.stringify(payload), true);
  } catch (err) {
    console.error(`[build-pruefung] Event an ${e.agent} fehlgeschlagen: ${(err as Error).message}`);
  }
}

/** Arbeitet die Warteschlange eines Projekts ab (FIFO, ein commit nach dem anderen). */
async function arbeiteAb(project: string): Promise<void> {
  if (inArbeit.has(project)) return;
  inArbeit.add(project);
  try {
    for (;;) {
      const liste = warteschlangen.get(project);
      const e = liste?.[0];
      if (!liste || !e) break;
      let r: Record<string, unknown>;
      try {
        r = commitAusfuehrer
          ? await imLauf.run(true, () => commitAusfuehrer!(e.args))
          : { success: false, error: 'kein_ausfuehrer', message: 'Kein commit-Ausfuehrer angemeldet.' };
      } catch (err) {
        r = { success: false, error: 'fehler', message: (err as Error).message };
      }
      liste.shift();
      if (liste.length === 0) warteschlangen.delete(project);
      await meldeErgebnis(e, r);
    }
  } finally {
    inArbeit.delete(project);
    if (buildWarteschlangeLaenge(project) > 0) void arbeiteAb(project);
  }
}

// ─── Zustand / Diagnose ─────────────────────────────────────────────────────────────────────────────────────────

function zustandVon(project: string): 'laeuft' | 'gruen' | 'rot' | 'teilweise' | 'unbekannt' {
  if ((projektLaeuft.get(project) ?? 0) > 0 || inArbeit.has(project)) return 'laeuft';
  const b = projektBasis.get(project);
  if (!b) return 'unbekannt';
  if (b.status !== 'fertig') return 'teilweise';
  return b.fehler === 0 ? 'gruen' : 'rot';
}

function warteschlangeAnzeige(project: string): Array<Record<string, unknown>> {
  return (warteschlangen.get(project) ?? []).map((e, i) => ({ position: i + 1, plan_id: e.plan_id, agent: e.agent, eingereiht_am: e.eingereiht_am }));
}

/** intern(status) -> quellen.build_pruefung */
export function buildPruefungZustand(): Record<string, unknown> {
  const projekte = new Set([...projektBasis.keys(), ...warteschlangen.keys(), ...projektLaeuft.keys()]);
  return {
    pruefer_verfuegbar: !!anbindung,
    laufend: laufend.size,
    cache: ergebnisCache.size,
    einstellungen_fehler: einstellungsCache?.fehler ?? null,
    projekte: Object.fromEntries([...projekte].map((p) => [p, { zustand: zustandVon(p), warteschlange: buildWarteschlangeLaenge(p) }])),
  };
}

// ─── code_check-Actions ─────────────────────────────────────────────────────────────────────────────────────────

export const BUILD_ACTIONS = ['build_status', 'build_einstellungen'] as const;

/** Zusaetzliche Schema-Properties fuer code_check (REST und stdio aus EINER Quelle). project/grund stehen schon dort. */
export const BUILD_PARAMETER: Record<string, Record<string, unknown>> = {
  pruefen: { type: 'boolean', description: 'build_status (mit project): Basisstand jetzt pruefen, alle TS-Projekte, im Hintergrund' },
  warten_sekunden: { type: 'number', description: 'build_status mit pruefen: hoechstens so lange auf das Ergebnis warten (0..50, Standard 0)' },
  modus: { type: 'string', enum: ['status', 'setzen'], description: 'build_einstellungen: status (Standard) | setzen (nur Koordinator/User)' },
  aktiv: { type: 'boolean', description: 'build_einstellungen setzen: Build-Tor an/aus - mit project fuer dieses Projekt, ohne project global' },
  speicher_mb: { type: 'number', description: 'build_einstellungen setzen: Speichergrenze des Pruefcontainers in MB (256..16384); Container startet neu' },
  tmpfs_mb: { type: 'number', description: 'build_einstellungen setzen: /tmp des Pruefcontainers in MB (16..4096); Container startet neu' },
  heap_mb: { type: 'number', description: 'build_einstellungen setzen: Heap von tsc in MB (128..16384; Standard Speicher - 192)' },
  zeitlimit_s: { type: 'number', description: 'build_einstellungen setzen: Zeitlimit je Build-Lauf in s (10..3600); danach teilweise (sperrt nicht)' },
  zuruecksetzen: { type: 'string', enum: ['projekt', 'global', 'budget'], description: 'build_einstellungen setzen: Eintrag entfernen (projekt braucht project) - danach gilt die naechste Ebene bzw. Env' },
};

export function istBuildAction(action: string | undefined): boolean {
  return typeof action === 'string' && (BUILD_ACTIONS as readonly string[]).includes(action);
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function zahl(v: unknown, name: string, min: number, max: number, fehler: string[]): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    fehler.push(`${name} muss zwischen ${min} und ${max} liegen (ist ${String(v)})`);
    return undefined;
  }
  return Math.round(n);
}

async function zeileSchreiben(bereich: string, werte: Werte, wer: string | null, grund: string | undefined): Promise<void> {
  await getPool().query(
    `INSERT INTO build_pruefung_einstellungen (bereich, werte, gesetzt_von, grund, gesetzt_am)
     VALUES ($1, $2::jsonb, $3, $4, NOW())
     ON CONFLICT (bereich) DO UPDATE SET werte = build_pruefung_einstellungen.werte || EXCLUDED.werte,
       gesetzt_von = EXCLUDED.gesetzt_von, grund = EXCLUDED.grund, gesetzt_am = NOW()`,
    [bereich, JSON.stringify(werte), wer, grund ?? null],
  );
}

async function einstellungenAnzeige(project: string | undefined): Promise<Record<string, unknown>> {
  const z = await ladeEinstellungen(true);
  return {
    global: z.get('global') ?? null,
    ...(project ? { projekt: z.get('projekt:' + project) ?? null, schalter: await buildAktiv(project) } : {}),
    pruefcontainer: z.get('pruefcontainer') ?? null,
    budget: await wirksamesBuildBudget(),
    ...(anbindung ? { container_jetzt: anbindung.budget() } : {}),
    env: { BUILD_PRUEFUNG: process.env.BUILD_PRUEFUNG ?? null },
    ...(einstellungsCache?.fehler ? { tabelle_fehler: einstellungsCache.fehler } : {}),
  };
}

/** Fuehrt eine Build-Action aus (code_check). agent = effektive Agent-ID. Wirft nie. */
export async function fuehreBuildActionAus(action: string, args: Record<string, unknown>, agent: string | null): Promise<Record<string, unknown>> {
  const project = text(args.project);
  try {
    if (action === 'build_status') {
      let pruefung: Record<string, unknown> | undefined;
      if (args.pruefen === true || args.pruefen === 'true') {
        if (!project) return { success: false, error: 'ungueltig', message: 'pruefen braucht project' };
        const sek = Math.max(0, Math.min(50, Number(args.warten_sekunden) || 0));
        pruefung = await pruefeBuildBasis(project, sek * 1000);
      }
      const projekte = project ? [project] : [...new Set([...projektBasis.keys(), ...warteschlangen.keys(), ...projektLaeuft.keys()])].sort();
      return {
        success: true,
        pruefer_verfuegbar: !!anbindung,
        ...(pruefung ? { pruefung } : {}),
        budget: await wirksamesBuildBudget(),
        projekte: await Promise.all(projekte.map(async (p) => ({
          project: p,
          zustand: zustandVon(p),
          schalter: await buildAktiv(p),
          basis: projektBasis.get(p) ?? null,
          warteschlange: warteschlangeAnzeige(p),
          letzte_commits: letzteCommits.get(p) ?? [],
        }))),
        ...(anbindung ? {} : { hinweis: KEIN_PRUEFER }),
        legende: 'zustand: gruen = Basis ohne Fehler, rot = Basis mit Fehlern (Tor sperrt nur NEUE), laeuft, teilweise (Zeitlimit/Speicher), unbekannt (noch nie geprueft: build_status mit pruefen:true).',
      };
    }
    if (action === 'build_einstellungen') {
      const modus = text(args.modus) ?? 'status';
      if (modus === 'status') return { success: true, modus, ...(await einstellungenAnzeige(project)) };
      if (modus !== 'setzen') return { success: false, error: 'ungueltig', message: 'modus nur status | setzen' };
      if (!darfKoordinatorOderUser(agent)) {
        return { success: false, error: 'nicht_erlaubt', message: 'build_einstellungen setzen nur Koordinator oder User (Schalter sperrt commits aller Lanes, Budget startet den Pruefcontainer neu).' };
      }
      const fehler: string[] = [];
      const grund = text(args.grund);
      const budget: Werte = {};
      const speicher = zahl(args.speicher_mb, 'speicher_mb', 256, 16384, fehler);
      const tmpfs = zahl(args.tmpfs_mb, 'tmpfs_mb', 16, 4096, fehler);
      const heap = zahl(args.heap_mb, 'heap_mb', 128, 16384, fehler);
      const zeit = zahl(args.zeitlimit_s, 'zeitlimit_s', 10, 3600, fehler);
      if (speicher !== undefined) budget.speicher_mb = speicher;
      if (tmpfs !== undefined) budget.tmpfs_mb = tmpfs;
      if (heap !== undefined) budget.heap_mb = heap;
      if (zeit !== undefined) budget.zeitlimit_s = zeit;
      const aktiv = args.aktiv === true || args.aktiv === 'true' ? true : args.aktiv === false || args.aktiv === 'false' ? false : undefined;
      const zurueck = text(args.zuruecksetzen);
      if (zurueck && !['projekt', 'global', 'budget'].includes(zurueck)) fehler.push('zuruecksetzen nur projekt | global | budget');
      if (zurueck === 'projekt' && !project) fehler.push('zuruecksetzen projekt braucht project');
      if (aktiv === undefined && Object.keys(budget).length === 0 && !zurueck) fehler.push('nichts zu setzen (aktiv, speicher_mb, tmpfs_mb, heap_mb, zeitlimit_s oder zuruecksetzen)');
      if (fehler.length > 0) return { success: false, error: 'ungueltig', message: fehler.join('; '), fehler };
      const geaendert: string[] = [];
      if (zurueck) {
        const bereich = zurueck === 'projekt' ? 'projekt:' + project : zurueck === 'global' ? 'global' : 'pruefcontainer';
        await getPool().query('DELETE FROM build_pruefung_einstellungen WHERE bereich = $1', [bereich]);
        geaendert.push(`${bereich} entfernt`);
      }
      if (aktiv !== undefined) {
        const bereich = project ? 'projekt:' + project : 'global';
        await zeileSchreiben(bereich, { aktiv }, agent, grund);
        geaendert.push(`${bereich}: aktiv ${aktiv}`);
      }
      if (Object.keys(budget).length > 0) {
        await zeileSchreiben('pruefcontainer', budget, agent, grund);
        geaendert.push(`pruefcontainer: ${JSON.stringify(budget)}`);
      }
      einstellungsCache = null;
      const neustart = await synchronisiereBuildBudget(true);
      return {
        success: true, modus, geaendert,
        ...(neustart ? { neustart: 'Pruefcontainer mit neuem Speicherbudget: wird beim naechsten Auftrag neu gestartet (laufende Auftraege abgebrochen).' } : {}),
        ...(anbindung ? {} : { hinweis: 'Gespeichert. Dieser Prozess hat keinen Pruefcontainer; die API uebernimmt das Budget vor ihrem naechsten Auftrag.' }),
        ...(await einstellungenAnzeige(project)),
      };
    }
    return { success: false, error: 'unbekannte_action', message: `Unbekannte Build-Action ${action}` };
  } catch (err) {
    return { success: false, error: 'fehler', message: (err as Error).message };
  }
}
