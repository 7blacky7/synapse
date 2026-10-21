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
 * NACHLAUF (P16-T23, User 21.10.2026): Mit Schalter 'nachlauf' schreibt ein commit SOFORT - die projektweite Stufe
 *        laeuft weder bei plan/plan_status noch sperrt oder reiht sie den commit ein. Nach dem Schreiben startet NICHTS
 *        (User-Korrektur): file-batch merkt den Plan nur vor (merkeBuildNachlaufVor), die commit-Antwort nennt den fertigen
 *        Aufruf code_check(build_pruefen, plan_id). Erst der stoesst an (stosseBuildNachlaufAn; offener Plan -> erst
 *        committen): je Projekt werden die Anstoesse gesammelt (nachlauf_buendel_ms), EIN Lauf auf dem beim Start gezogenen
 *        Abbild prueft den Stand vor dem ersten gegen den nach dem letzten commit des Buendels (Basis = PruefDatei.basis, Schatten =
 *        geschriebener Stand), nur betroffene Pakete. Kommen waehrenddessen commits dazu, folgt genau ein weiterer Lauf.
 *        Das Ergebnis geht je Plan an den Committer als Feld build_nachlauf in der Antwort seines NAECHSTEN Tool-Aufrufs
 *        (tool-antwort.ts, genau einmal, egal welches Tool), an den Plan (plan_status: pruefung.build mit nachlauf_befunde)
 *        und in build_status (nachlauf.letzte, neue Fehler mit Plan-Zuordnung). Neue Fehler sperren nichts (geschrieben).
 *        SCHALTER (regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter werte.nachlauf (Projekt > global,
 *        code_check build_einstellungen nachlauf, Koordinator/User); intern-Override 'build_nachlauf' (nur
 *        SYNAPSE_INTERN_TOOL=1, befristet) hat Vorrang. Standard AUS = Warteschlange wie oben. Debug: build_status
 *        (nachlauf: schalter mit quelle, laeuft, wartend, letzte), intern(status) quellen.build_pruefung.nachlauf (Zaehler,
 *        letzter Fehler). Wie die Warteschlange nur im Speicher: ein Neustart verwirft offene Laeufe und Hinweise.
 *
 * BASIS-CACHE je Commit: Ergebnis je Inhalts-Schnappschuss (sha256 ueber Pfad + Inhalt der gesendeten Dateien,
 *        Projektmenge, Budget). Nach einem commit ist der neue PG-Stand inhaltsgleich zum geprueften Schatten - dessen
 *        Ergebnis ist ohne neuen Lauf die Basis des naechsten Plans.
 *
 * ETAPPE 2 (Go + Python, 14.10.2026, claude-e2 auf der Vorbereitung von sol-11, thought 26799282): dieselbe Stufe fuer
 *        Go-Module (Ordner mit go.mod: go build -o /dev/null + go vet) und Python-Projekte (Ordner mit pyproject.toml/
 *        setup.py/setup.cfg, sonst die Projektwurzel: Pyright) im selben Container (pruefer_projekt.py). Gleicher Schalter,
 *        Ergebnis-Cache, Basisvergleich, Warteschlange; 'teilweise' sperrt nie. Sprachen je Projekt/global abwaehlbar
 *        (code_check build_einstellungen sprachen, Env BUILD_PRUEFUNG_SPRACHEN). go vet-Analyzerbefunde sind warnings
 *        (sperren nicht), nicht aufgeloeste Python-Importe nur Abdeckungshinweis (dort Unknown, keine Folgefehler).
 *        Go ohne Modulbestand im Container (externe Abhaengigkeiten) und cgo -> 'teilweise'. Ohne Go-/Python-Aenderung
 *        bleiben alle Antworten wie in E1.
 *
 * BUDGET (User 444127bc 2b): Speicher und tmpfs des Pruefcontainers, Heap von tsc und Zeitlimit per
 *        code_check(build_einstellungen) einstellbar (Tabelle build_pruefung_einstellungen), im Tool abrufbar.
 *        Aenderung von Speicher/tmpfs startet den Container neu (vor dem naechsten Auftrag abgeglichen).
 */

import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import ts from 'typescript';
import { getPool } from '../db/client.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';
import { emitEvent } from './events.js';
import type { PruefDatei } from './plan-befunde.js';
import type { FehlerBefund } from './fehlermuster-pruefung.js';
import { typenBestand, typenZustand, TYPEN_LOCKFILES, type TypenBestand, type TypenInfo } from './build-typen.js';
import { leseSchalter } from './intern-schalter.js';

// ─── Vertrag zum Pruefcontainer (rest-api pruef-container.ts, pruefer_tsbuild.py) ───────────────────────────

export interface BuildDatei {
  /** Projekt-relativer Pfad (keine absoluten Pfade, kein '..'). */
  pfad: string;
  inhalt: string;
  /** Platzhalter @@WURZEL@@ im Inhalt durch das Arbeitsverzeichnis im Container ersetzen (nur erzeugte tsconfigs). */
  wurzel_ersetzen?: boolean;
}

/** P16-T16 E2: Projektpruefer neben TypeScript (Nachrichtenschluessel im Container, pruefer_projekt.py). */
export type SprachArt = 'kotlinc' | 'javac' | 'rustcheck' | 'gobuild' | 'pyright' | 'cbuild' | 'cppbuild' | 'dartbuild' | 'csharpbuild';

export interface BuildAuftrag {
  dateien: BuildDatei[];
  /** Zu pruefende tsconfig-Dateien (die erzeugten tsconfig.synapse-build.json), projekt-relativ. */
  projekte: string[];
  zeitlimit_ms: number;
  heap_mb: number;
  /** P16-T16 E2: Go-/Python-Projektpruefer; ohne = TypeScript (E1, Nachricht 'build'). projekte sind dann Ordner. */
  art?: SprachArt;
  /** Nur pyright: Python-Sprachstand 3.x (aus .python-version des Projekts). */
  python_version?: string;
}

export interface BuildDiagnose {
  /** Projekt-relativ; null = Diagnose ohne Datei (z. B. fehlende Typdefinition). */
  datei: string | null;
  zeile: number;
  spalte: number;
  code: string;
  meldung: string;
  /** E3a: stabile Quellspanne (Inhalt statt Zeilennummer), vom Compileradapter. */
  stabile_spanne?: string;
  /** tsconfig, in deren Lauf die Diagnose entstand (wie in BuildAuftrag.projekte). */
  projekt: string;
  /** P16-T16 E2 (Go/Python): error | warning | information; fehlt bei TypeScript (= error). */
  schwere?: 'error' | 'warning' | 'information';
  /** Pyright: nicht aufgeloester Import (Abdeckungsluecke, nie Befund). */
  weich?: boolean;
}

export interface BuildProjektLauf {
  projekt: string;
  /** E2 zusaetzlich: ausgabe (zu viel Ausgabe), abhaengigkeiten (Go-Module fehlen offline), cgo (cgo-Dateien ungeprueft). */
  status: 'fertig' | 'zeitlimit' | 'speicher' | 'fehler' | 'ausgabe' | 'abhaengigkeiten' | 'cgo' | 'build_skript_oder_proc_macro' | 'konfiguration' | 'abdeckung' | 'werkzeug';
  ms: number;
  rc: number | null;
  hinweis?: string;
  /** E2: Schritt im Projekt (Go: build, vet; Python: pyright). */
  schritt?: string;
  /** Rust: Graph-Vorprüfung vor Cargo. */
  grund?: string;
  betroffene_crates?: string[];
  /** E2 Pyright: 'unvollstaendig' = Importe nicht aufgeloest (Lauf trotzdem fertig). */
  abdeckung?: string;
  fehlende_importe?: number;
  /** E2 Pyright: analysierte Dateien. */
  dateien?: number;
  /** P16-T22: hoechster RSS des Werkzeugs (MB, wait4) - Messwert je Projekt/Schritt. */
  rss_mb?: number;
}

export interface BuildLaufErgebnis {
  status: 'fertig' | 'teilweise' | 'nicht_verfuegbar';
  dauer_ms: number;
  projekte: BuildProjektLauf[];
  diagnosen: BuildDiagnose[];
  hinweis?: string;
  /** z. B. "tsc 5.9.3 (node v24.10.0)" */
  werkzeug?: string;
  /** P16-T22: Speicher des Pruefcontainers nach dem Lauf (cgroup memory.current/peak in MB). */
  speicher?: { aktuell_mb?: number; peak_mb?: number; limit_mb?: number };
  /** P16-T22: Typen-Bestand dieses Laufs (nur TypeScript). */
  typen?: TypenInfo;
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
  /** E2: Sprache dieses Teilstands (fehlt = TypeScript). */
  sprache?: 'kotlin' | 'java' | 'rust' | 'go' | 'python' | 'c' | 'cpp' | 'dart' | 'csharp';
  /** E2: neue go vet-Warnungen (sperren nicht). */
  neue_warnungen?: number;
  /** E2: Teilstaende je Sprache, wenn mehrere Sprachen im Plan geprueft wurden. */
  teile?: BuildStand[];
  /** P16-T22: Typen-Bestand (nur wenn er Luecken hat). */
  typen?: TypenInfo;
  /** P16-T23: Stand aus dem Nachlauf (nach dem commit geprueft, sperrt nicht). */
  nachlauf?: boolean;
  /** P16-T23: neue Befunde des Nachlaufs am Plan (plan_status), Kurzform. */
  nachlauf_befunde?: Array<{ datei: string; zeile: number; code?: string; severity: string; was: string; op_index: number | null }>;
}

export type BuildBefund = FehlerBefund & { op_index: number | null; agent_id: string | null; beteiligt?: number[] };

export interface BuildPlanErgebnis {
  stand: BuildStand;
  befunde: BuildBefund[];
}

export interface BuildPlanOptionen {
  /** auf das Resultat warten (Warteschlange, Nachlauf) statt status laeuft */
  warten?: boolean;
  /** P16-T23: nach dem commit - PG traegt schon den geschriebenen Stand, die Basis kommt aus PruefDatei.basis. */
  nachlauf?: boolean;
}

/** P16-T23: Folgetext neuer Fehler im Nachlauf (der commit ist schon geschrieben). */
const NACHLAUF_FOLGE = 'schon geschrieben (Nachlauf, sperrt nicht) - im naechsten Plan korrigieren.';

/** P16-T23: Basis des Nachlaufs = Stand vor dem commit (PG hat schon den geschriebenen Stand); neue Dateien fehlen dort. */
function stelleBasisHer(quellen: Map<string, string>, relevant: PruefDatei[]): void {
  for (const d of relevant) {
    if (d.basis) quellen.set(d.file_path, d.basis);
    else quellen.delete(d.file_path);
  }
}

let anbindung: BuildPrueferAnbindung | null = null;

/** Nur der Prozess mit Pruefcontainer (rest-api) meldet sich an. */
export function registriereBuildPruefer(a: BuildPrueferAnbindung | null): void {
  anbindung = a;
}

// ─── Hilfen ─────────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const TS_DATEI = /\.(?:ts|tsx|mts|cts)$/;
// P16-T22: das Lockfile der Wurzel bestimmt den Typen-Bestand (build-typen.ts) und gilt wie eine gemeinsame Konfig.
const KONFIG_DATEI = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$|^(?:pnpm-lock\.yaml|package-lock\.json)$/;
/** Dateien, deren Aenderung eine Build-Pruefung ausloest (TypeScript-Quellen, package.json, tsconfig*.json, Lockfile). */
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
  /** E2: Sprachen neben TypeScript (go, python); [] = nur TypeScript. */
  sprachen?: string[];
  /** P16-T23: Nachlauf statt Warteschlange (Projekt/global; Standard AUS). */
  nachlauf?: boolean;
  /** P16-T23: Sammelzeit vor einem Nachlauf in ms (nur global; Standard NACHLAUF_BUENDEL_MS). */
  nachlauf_buendel_ms?: number;
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

/** P16-T23: Standard der Sammelzeit vor einem Nachlauf (Einstellwert global werte.nachlauf_buendel_ms). */
const NACHLAUF_BUENDEL_MS = 3000;

export interface BuildNachlaufStand {
  aktiv: boolean;
  quelle: 'standard' | 'projekt' | 'global' | 'intern';
  /** Ablauf des intern-Overrides */
  bis: string | null;
  buendel_ms: number;
  buendel_quelle: 'standard' | 'global';
  letzter_fehler: string | null;
}

/**
 * P16-T23: wirksamer Nachlauf-Schalter. Vorrang intern-Override 'build_nachlauf' (nur SYNAPSE_INTERN_TOOL=1, modus
 * freigegeben, befristet) > Projekt-Eintrag > global > Standard AUS (= Warteschlange). Wirft nie.
 */
export async function buildNachlaufAktiv(project?: string | null): Promise<BuildNachlaufStand> {
  const z = await ladeEinstellungen();
  const ms = z.get('global')?.werte.nachlauf_buendel_ms;
  const basis: BuildNachlaufStand = {
    aktiv: false, quelle: 'standard', bis: null,
    buendel_ms: typeof ms === 'number' ? ms : NACHLAUF_BUENDEL_MS, buendel_quelle: typeof ms === 'number' ? 'global' : 'standard',
    letzter_fehler: einstellungsCache?.fehler ?? null,
  };
  // Gleiche Bedingung wie internToolAktiv() (intern-tool.ts), ohne dessen Modulbaum zu laden.
  if (process.env.SYNAPSE_INTERN_TOOL === '1') {
    const s = await leseSchalter('build_nachlauf');
    if (s.aktiv && s.modus === 'freigegeben') return { ...basis, aktiv: true, quelle: 'intern', bis: s.bis };
  }
  const p = project ? z.get('projekt:' + project)?.werte.nachlauf : undefined;
  if (typeof p === 'boolean') return { ...basis, aktiv: p, quelle: 'projekt' };
  const g = z.get('global')?.werte.nachlauf;
  if (typeof g === 'boolean') return { ...basis, aktiv: g, quelle: 'global' };
  return basis;
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

/** TS-Quellen + package.json + tsconfig*.json des Projekts aus PG (ohne node_modules), dazu das Lockfile der Wurzel. */
async function ladeQuellen(project: string): Promise<Map<string, string>> {
  const rows = (await getPool().query<{ file_path: string; content: string }>(
    `SELECT file_path, content FROM code_files
      WHERE project = $1 AND deleted_at IS NULL AND ignored = false AND content IS NOT NULL
        AND (file_path ~ $2 OR file_path ~ $3 OR file_path = ANY($5::text[])) AND file_path !~ $4
      ORDER BY file_path`,
    [project, '\\.(ts|tsx|mts|cts)$', '(^|/)(package\\.json|tsconfig[^/]*\\.json)$', '(^|/)node_modules/', [...TYPEN_LOCKFILES]],
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
  /** P16-T22: exports-Unterpfade ('tools' fuer './tools') -> Projekt-relative Quelle. */
  unterpfade: Map<string, string>;
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
    /** Ausgabepfad (dist/...) einer package.json-Angabe -> moegliche Quelldateien. */
    const quelleVon = (rel: string): string[] => {
      let ziel = verbinde(dir, rel);
      if (ausgabe && (ziel === ausgabe || ziel.startsWith(ausgabe + '/'))) ziel = quellwurzel + ziel.slice(ausgabe.length);
      const ohne = ziel.replace(/\.d\.(?:ts|mts|cts)$/, '').replace(/\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/, '');
      return ['.ts', '.tsx', '.mts', '.cts', '.d.ts'].map((e) => ohne + e);
    };
    const kandidaten: string[] = [];
    const typen = typenFeld(pkg);
    if (typen) kandidaten.push(...quelleVon(typen));
    kandidaten.push(verbinde(quellwurzel, 'index.ts'), verbinde(quellwurzel, 'index.tsx'), verbinde(dir, 'index.ts'));
    // P16-T22: Unterpfade aus exports ('./tools' -> Quelle); sonst meldet tsc jeden Import '@x/y/tools' als TS2307
    // (live synapse: @synapse/mcp-server/tools und /consolidated, dazu TS7006-Folgefehler).
    const unterpfade = new Map<string, string>();
    const exp = pkg.exports;
    if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
      for (const [k, v] of Object.entries(exp as Json)) {
        if (!k.startsWith('./') || k.includes('*')) continue;
        const ziel = typeof v === 'string' ? v
          : v && typeof v === 'object' ? [v.types, v.import, v.default, v.require].find((x): x is string => typeof x === 'string') : undefined;
        const q = ziel ? quelleVon(ziel).find((c) => quellen.has(c)) : undefined;
        if (q) unterpfade.set(k.slice(2), q);
      }
    }
    pakete.set(pkg.name, { name: pkg.name, dir, abhaengig, einstieg: kandidaten.find((k) => quellen.has(k)) ?? null, quellwurzel, unterpfade });
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
function erzeugeWrapper(cfg: string, pakete: Map<string, Paket>, quellen: Map<string, string>, typen: TypenBestand | null = null): string {
  const dir = dirOf(cfg);
  const kette = konfigKette(cfg, quellen);
  const paths: Record<string, string[]> = {};
  for (const p of pakete.values()) {
    if (p.dir === dir) continue;
    // P16-T22: exakte Unterpfade gehen in tsc vor dem Muster '<name>/*'.
    for (const [sub, q] of p.unterpfade) paths[`${p.name}/${sub}`] = [`${WURZEL}/${q}`];
    if (!p.einstieg) continue;
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
  // P16-T22: mit Typen-Bestand nur die @types, die das Paket bzw. die Wurzel selbst nennt (wie pnpm ohne Hoisting -
  // gehobene transitive @types wie @types/react sollen nicht in jedes Paket wirken). Eigene types der Kette bleiben.
  const typenListe = typen?.info.quelle && option(kette, 'types') === undefined
    ? [...new Set([...(typen.atTypes.get(dir) ?? []), ...(typen.atTypes.get('') ?? [])])].sort() : null;
  const compilerOptions: Json = {
    noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false, emitDeclarationOnly: false,
    sourceMap: false, skipLibCheck: true, rootDir: WURZEL,
    ...(Object.keys(paths).length > 0 ? { paths } : {}),
    ...(typenListe ? { types: typenListe } : {}),
  };
  return JSON.stringify({ extends: './tsconfig.json', compilerOptions }, null, 1) + '\n';
}

interface Vorbereitet {
  auftrag: BuildAuftrag;
  schluessel: string;
  bytes: number;
  /** P16-T22: Typdateien der Abhaengigkeiten (zaehlen nicht gegen max_mb, nur gegen das tmpfs). */
  typenBytes?: number;
  typen?: TypenInfo;
  /** P16-T22: typescript bzw. Sprache (Fortschritt in build_status). */
  sprache: string;
}

/** Auftrag fuer den Container: Konfigs + TS-Quellen in Projektordnern + erzeugte tsconfigs; Schluessel fuer den Cache. */
function bereiteVor(quellen: Map<string, string>, projekte: string[], budget: BuildBudget, typen: TypenBestand | null = null): Vorbereitet {
  const pakete = lesePakete(quellen);
  const ordner = tsProjekte(quellen).map(dirOf);
  const dateien: BuildDatei[] = [];
  let bytes = 0;
  for (const [pfad, inhalt] of quellen) {
    if ((TYPEN_LOCKFILES as readonly string[]).includes(pfad)) continue; // nur fuer den Typen-Bestand, nicht im Container
    if (!KONFIG_DATEI.test(pfad) && !ordner.some((d) => unter(pfad, d))) continue;
    dateien.push({ pfad, inhalt });
    bytes += Buffer.byteLength(inhalt);
  }
  for (const c of projekte) {
    const inhalt = erzeugeWrapper(c, pakete, quellen, typen);
    dateien.push({ pfad: wrapperPfad(c), inhalt, wurzel_ersetzen: true });
    bytes += Buffer.byteLength(inhalt);
  }
  const wrapper = projekte.map(wrapperPfad);
  const auftrag: BuildAuftrag = { dateien, projekte: wrapper, zeitlimit_ms: budget.zeitlimit_s * 1000, heap_mb: budget.heap_mb };
  // P16-T22: der Typen-Bestand geht ueber seinen Schluessel in den Cache-Schluessel (nicht je Datei gehasht).
  const schluessel = sha(JSON.stringify(['e1', budget.heap_mb, budget.zeitlimit_s, typen?.schluessel ?? null, wrapper, dateien.map((d) => [d.pfad, sha(d.inhalt)])]));
  if (typen) for (const d of typen.dateien) dateien.push(d);
  return { auftrag, schluessel, bytes, sprache: 'typescript', ...(typen ? { typenBytes: typen.info.bytes, typen: typen.info } : {}) };
}

/** P16-T22: Grund, warum ein Schnappschuss nicht in den Container passt (null = passt). */
function zuGross(v: Vorbereitet, budget: BuildBudget): string | null {
  if (v.bytes > budget.max_mb * 1024 * 1024) return `Schnappschuss ${(v.bytes / 1048576).toFixed(1)} MB > ${budget.max_mb} MB (BUILD_PRUEFUNG_MAX_MB bzw. 80 % tmpfs)`;
  const gesamt = v.bytes + (v.typenBytes ?? 0);
  if (gesamt > budget.tmpfs_mb * 0.8 * 1024 * 1024) return `Schnappschuss mit Typen ${(gesamt / 1048576).toFixed(1)} MB > 80 % von tmpfs ${budget.tmpfs_mb} MB`;
  return null;
}

// ─── Ausfuehrung (ein Auftrag zur Zeit, Ergebnis-Cache) ─────────────────────────────────────────────────────────

const ergebnisCache = new Map<string, BuildLaufErgebnis>();
const laufend = new Map<string, Promise<BuildLaufErgebnis>>();
let kette: Promise<unknown> = Promise.resolve();
const projektLaeuft = new Map<string, number>();

/** P16-T22: Fortschritt je Projekt fuer build_status (typen = Typen-Bestand laedt, wartet = in der Kette, laeuft = im Container). */
interface Fortschritt {
  sprache: string;
  phase: 'typen' | 'wartet' | 'laeuft';
  eingereiht_am: string;
  gestartet_am: string | null;
  projekte: number;
  basis: boolean;
}
const fortschritt = new Map<string, Map<string, Fortschritt>>();
/** P16-T22: letzter Basislauf ohne Ergebnis je Projekt (Container gestoppt/neu gestartet, nicht verfuegbar). */
const letzterAbbruch = new Map<string, { zeit: string; sprache: string; grund: string }>();

function merkeFortschritt(project: string, id: string, f: Fortschritt): void {
  const m = fortschritt.get(project) ?? new Map<string, Fortschritt>();
  m.set(id, f);
  fortschritt.set(project, m);
}

function loescheFortschritt(project: string, id: string): void {
  const m = fortschritt.get(project);
  m?.delete(id);
  if (m && m.size === 0) fortschritt.delete(project);
}

function fortschrittAnzeige(project: string): Array<Record<string, unknown>> {
  const jetzt = Date.now();
  return [...(fortschritt.get(project)?.values() ?? [])].map((f) => ({
    sprache: f.sprache, phase: f.phase, basis: f.basis, projekte: f.projekte, eingereiht_am: f.eingereiht_am,
    ...(f.gestartet_am
      ? { gestartet_am: f.gestartet_am, laeuft_s: Math.round((jetzt - Date.parse(f.gestartet_am)) / 1000) }
      : { wartet_s: Math.round((jetzt - Date.parse(f.eingereiht_am)) / 1000) }),
  }));
}

/** P16-T22: Kurzform eines fertigen Laufs fuer die warten-Antwort; nicht_verfuegbar heisst dort abgebrochen + Grund. */
function ergebnisKurz(e: BuildLaufErgebnis, fehler: number): Record<string, unknown> {
  return {
    status: e.status === 'nicht_verfuegbar' ? 'abgebrochen' : e.status, fehler, dauer_ms: e.dauer_ms,
    ...(e.status !== 'fertig' && e.hinweis ? { grund: e.hinweis } : {}),
    ...(e.typen ? { typen: e.typen } : {}),
  };
}

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
  /** P16-T22: Messwerte je Projekt/Schritt (Dauer, hoechster RSS), Speicher des Containers, Typen-Bestand. */
  laeufe?: Array<{ projekt: string; schritt?: string; status: string; ms: number; rss_mb?: number }>;
  speicher?: BuildLaufErgebnis['speicher'];
  typen?: TypenInfo;
}
const projektBasis = new Map<string, ProjektBasis>();
/** E2: Basisstand je Projekt und Sprache (Go/Python), getrennt von der TS-Basis. */
const sprachBasis = new Map<string, Map<SprachArt, ProjektBasis>>();

function leer(status: BuildLaufErgebnis['status'], hinweis: string): BuildLaufErgebnis {
  return { status, dauer_ms: 0, projekte: [], diagnosen: [], hinweis };
}

function merke(schluessel: string, e: BuildLaufErgebnis): void {
  ergebnisCache.delete(schluessel);
  ergebnisCache.set(schluessel, e);
  while (ergebnisCache.size > CACHE_MAX) ergebnisCache.delete(ergebnisCache.keys().next().value as string);
}

function merkeBasis(project: string, e: BuildLaufErgebnis, projekte: string[], vollstaendig: boolean, art?: SprachArt): void {
  // P16-T22: ein Lauf ohne Ergebnis (Container gestoppt/neu gestartet) ersetzt keinen Basisstand, er wird als Abbruch gezeigt.
  if (e.status === 'nicht_verfuegbar') {
    letzterAbbruch.set(project, { zeit: new Date().toISOString(), sprache: art ? SPRACH_NAME[art] : 'TypeScript', grund: e.hinweis ?? 'nicht verfuegbar' });
    return;
  }
  const sprachen = art ? (sprachBasis.get(project) ?? new Map<SprachArt, ProjektBasis>()) : null;
  const alt = sprachen && art ? sprachen.get(art) : projektBasis.get(project);
  // Ein Teilblick (nur betroffene Projekte eines Plans) ueberschreibt keinen vollstaendigen Basisstand.
  if (alt?.vollstaendig && !vollstaendig && Date.now() - new Date(alt.geprueft_am).getTime() < 10 * 60_000) return;
  // E2: Go/Python zaehlen nur Fehler (keine vet-Warnungen, Hinweise, Importluecken); TypeScript wie bisher alle Diagnosen.
  const diagnosen = art ? e.diagnosen.filter(istFehlerDiag) : e.diagnosen;
  const eintrag: ProjektBasis = {
    status: e.status, fehler: diagnosen.length, projekte, vollstaendig, geprueft_am: new Date().toISOString(), dauer_ms: e.dauer_ms,
    ...(e.werkzeug ? { werkzeug: e.werkzeug } : {}), ...(e.hinweis ? { hinweis: e.hinweis } : {}),
    erste_fehler: diagnosen.slice(0, 5).map((d) => ({ datei: d.datei, zeile: d.zeile, code: d.code, meldung: d.meldung.slice(0, 300) })),
    laeufe: e.projekte.map((p) => ({ projekt: p.projekt, ...(p.schritt ? { schritt: p.schritt } : {}), status: p.status, ms: p.ms, ...(typeof p.rss_mb === 'number' ? { rss_mb: p.rss_mb } : {}) })),
    ...(e.speicher ? { speicher: e.speicher } : {}),
    ...(e.typen ? { typen: e.typen } : {}),
  };
  if (sprachen && art) {
    sprachen.set(art, eintrag);
    sprachBasis.set(project, sprachen);
  } else {
    projektBasis.set(project, eintrag);
  }
}

/** Startet (bzw. teilt) einen Lauf. Nie parallel im Container: eine Kette fuer alle Projekte. Wirft nie. */
function starteLauf(project: string, v: Vorbereitet, basis?: { projekte: string[]; vollstaendig: boolean; art?: SprachArt }): Promise<BuildLaufErgebnis> {
  const treffer = ergebnisCache.get(v.schluessel);
  if (treffer) {
    // P16-T22: auch ein Cache-Treffer ist ein Basisstand (inhaltsgleicher Stand, z. B. erneutes pruefen:true).
    if (basis) merkeBasis(project, treffer, basis.projekte, basis.vollstaendig, basis.art);
    return Promise.resolve(treffer);
  }
  const offen = laufend.get(v.schluessel);
  if (offen) return offen;
  projektLaeuft.set(project, (projektLaeuft.get(project) ?? 0) + 1);
  // P16-T22: Fortschritt fuer build_status (wartet in der Kette -> laeuft im Container).
  const fid = v.schluessel.slice(0, 12);
  const f: Fortschritt = { sprache: v.sprache, phase: 'wartet', eingereiht_am: new Date().toISOString(), gestartet_am: null, projekte: v.auftrag.projekte.length, basis: !!basis };
  merkeFortschritt(project, fid, f);
  const p = kette.then(async (): Promise<BuildLaufErgebnis> => {
    const t0 = Date.now();
    f.phase = 'laeuft';
    f.gestartet_am = new Date().toISOString();
    try {
      await synchronisiereBuildBudget();
      if (!anbindung) return leer('nicht_verfuegbar', KEIN_PRUEFER);
      if (v.auftrag.projekte.length === 0) return { status: 'fertig', dauer_ms: 0, projekte: [], diagnosen: [] };
      const e = await anbindung.pruefe(v.auftrag);
      return { ...e, dauer_ms: e.dauer_ms || Date.now() - t0, ...(v.typen ? { typen: v.typen } : {}) };
    } catch (err) {
      return { ...leer('nicht_verfuegbar', `Pruefcontainer: ${(err as Error).message}`), dauer_ms: Date.now() - t0 };
    }
  });
  kette = p.catch(() => undefined);
  laufend.set(v.schluessel, p);
  void p.then((e) => {
    if (e.status !== 'nicht_verfuegbar') merke(v.schluessel, e);
    if (basis) merkeBasis(project, e, basis.projekte, basis.vollstaendig, basis.art);
  }).finally(() => {
    loescheFortschritt(project, fid);
    laufend.delete(v.schluessel);
    const n = (projektLaeuft.get(project) ?? 1) - 1;
    if (n > 0) projektLaeuft.set(project, n); else projektLaeuft.delete(project);
  });
  return p;
}

// ─── Vergleich Basis <-> Schatten ───────────────────────────────────────────────────────────────────────────────

const meldungNorm = (m: string): string => m.replace(/\s+/g, ' ').trim();
const diagSchluessel = (d: BuildDiagnose): string => `${d.datei ?? ''}|${d.code}|${d.stabile_spanne ?? ''}|${meldungNorm(d.meldung)}`;

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

function alsBefund(d: BuildDiagnose, dateien: PruefDatei[], werkzeug: string, art?: SprachArt): BuildBefund {
  if (art) return alsSprachBefund(d, dateien, werkzeug, art);
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
 * E2: TypeScript-Teil; der exportierte pruefeBuildFuerPlan (unten) ergaenzt Go/Python.
 */
async function pruefeTsBuildFuerPlan(project: string, dateien: PruefDatei[], o: BuildPlanOptionen = {}): Promise<BuildPlanErgebnis | null> {
  const relevant = dateien.filter((d) => istBuildRelevant(d.file_path));
  if (relevant.length === 0) return null;
  const t0 = Date.now();
  const stand = (s: Partial<BuildStand> & Pick<BuildStand, 'status'>): BuildStand => ({ tor: true, neue_fehler: 0, projekte: [], ...s, dauer_ms: s.dauer_ms ?? Date.now() - t0 });
  try {
    if (!(await buildAktiv(project)).aktiv) return null;
    if (!anbindung) return { stand: stand({ status: 'nicht_verfuegbar', hinweis: KEIN_PRUEFER }), befunde: [] };
    const budget = await wirksamesBuildBudget();
    const basisQuellen = await ladeQuellen(project);
    // P16-T23: im Nachlauf ist der Schatten das beim Laufstart gezogene Abbild des geschriebenen PG-Stands (auch spaetere
    // commits derselben Dateien); die Basis ist dasselbe Abbild mit dem Stand vor dem Buendel.
    const geschrieben = o.nachlauf ? new Map(basisQuellen) : null;
    if (o.nachlauf) stelleBasisHer(basisQuellen, relevant);
    const schattenQuellen = geschrieben ?? new Map(basisQuellen);
    for (const d of geschrieben ? [] : relevant) {
      if (d.geloescht) schattenQuellen.delete(d.file_path);
      else schattenQuellen.set(d.file_path, d.ergebnis);
    }
    const projekte = betroffeneProjekte(tsProjekte(schattenQuellen), lesePakete(schattenQuellen), relevant.map((d) => d.file_path));
    if (projekte.length === 0) {
      return { stand: stand({ status: 'fertig', hinweis: 'Kein TypeScript-Projekt (tsconfig.json neben package.json) betroffen.' }), befunde: [] };
    }
    const basisProjekte = projekte.filter((c) => basisQuellen.has(c));
    // P16-T22: Typen der Abhaengigkeiten aus dem Lockfile (gleiches Lockfile = derselbe Bestand aus dem Speicher).
    const typenA = await typenBestand(basisQuellen, o);
    const typenB = await typenBestand(schattenQuellen, o);
    if (typenA === 'laedt' || typenB === 'laedt') {
      return {
        stand: stand({ status: 'laeuft', projekte, hinweis: 'Typen der Abhaengigkeiten (Lockfile) werden geladen, danach laeuft die projektweite Pruefung; Ergebnis bei plan_status/commit. Ein commit wird solange eingereiht, nicht gesperrt.' }),
        befunde: [],
      };
    }
    const a = bereiteVor(basisQuellen, basisProjekte, budget, typenA);
    const b = bereiteVor(schattenQuellen, projekte, budget, typenB);
    const zu = zuGross(a, budget) ?? zuGross(b, budget);
    if (zu) {
      return {
        stand: stand({ status: 'teilweise', projekte, hinweis: `${zu} - nicht geprueft, nichts gesperrt. Mehr Platz: code_check(build_einstellungen, modus:'setzen', tmpfs_mb).` }),
        befunde: [],
      };
    }
    let basis = ergebnisCache.get(a.schluessel);
    let schatten = ergebnisCache.get(b.schluessel);
    if (!basis || !schatten) {
      // P16-T23: im Nachlauf ist der Schatten der geschriebene Stand und damit die neue Basis.
      const pa = starteLauf(project, a, o.nachlauf ? undefined : { projekte: basisProjekte, vollstaendig: false });
      const pb = starteLauf(project, b, o.nachlauf ? { projekte, vollstaendig: false } : undefined);
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
      ...(befunde.length > 0 ? [`${befunde.length} neue(r) Build-Fehler gegenueber dem Basisstand - ${o.nachlauf ? NACHLAUF_FOLGE : 'sperrt den commit; korrigieren oder quittieren.'}`] : []),
    ];
    return {
      stand: stand({
        status: unvollstaendig.length > 0 ? 'teilweise' : 'fertig', neue_fehler: befunde.length, basis_fehler: basis.diagnosen.length,
        projekte, dauer_ms: basis.dauer_ms + schatten.dauer_ms, werkzeug, ...(hinweise.length > 0 ? { hinweis: hinweise.join(' ') } : {}),
        ...(schatten.typen?.fehlend_anzahl ? { typen: schatten.typen } : {}),
      }),
      befunde,
    };
  } catch (err) {
    return { stand: stand({ status: 'nicht_verfuegbar', hinweis: `Build-Pruefung fehlgeschlagen (sperrt nicht): ${(err as Error).message}` }), befunde: [] };
  }
}

/** Basisstand eines Projekts pruefen (alle TS-Projekte). wartenMs > 0: bis dahin auf das Resultat warten. */
async function pruefeTsBuildBasis(project: string, wartenMs = 0): Promise<Record<string, unknown>> {
  if (!anbindung) return { gestartet: false, status: 'nicht_verfuegbar', hinweis: KEIN_PRUEFER };
  const budget = await wirksamesBuildBudget();
  const quellen = await ladeQuellen(project);
  const projekte = tsProjekte(quellen);
  if (projekte.length === 0) return { gestartet: false, status: 'fertig', hinweis: 'Keine TypeScript-Projekte (tsconfig.json neben package.json) im Index.' };
  // P16-T22: zuerst der Typen-Bestand (beim ersten Mal Downloads, danach Cache), dann der Lauf - beides im Hintergrund,
  // Fortschritt in build_status (Phase typen -> wartet -> laeuft).
  const jetzt = new Date().toISOString();
  const fid = `typen-${Date.now().toString(36)}`;
  merkeFortschritt(project, fid, { sprache: 'typescript', phase: 'typen', eingereiht_am: jetzt, gestartet_am: jetzt, projekte: projekte.length, basis: true });
  const p = (async (): Promise<BuildLaufErgebnis> => {
    let typen: TypenBestand | 'laedt' | null;
    try { typen = await typenBestand(quellen, { warten: true }); } finally { loescheFortschritt(project, fid); }
    const v = bereiteVor(quellen, projekte, budget, typen === 'laedt' ? null : typen);
    const zu = zuGross(v, budget);
    if (zu) {
      const e = leer('teilweise', `${zu} - nicht geprueft. tmpfs_mb erhoehen.`);
      merkeBasis(project, e, projekte, true);
      return e;
    }
    return starteLauf(project, v, { projekte, vollstaendig: true });
  })().catch((err) => leer('nicht_verfuegbar', `Build-Pruefung fehlgeschlagen: ${(err as Error).message}`));
  if (wartenMs <= 0) return { gestartet: true, projekte, hinweis: 'Laeuft im Hintergrund (zuerst Typen der Abhaengigkeiten aus dem Lockfile); Stand und Fortschritt mit code_check(action:"build_status", project).' };
  const e = await hoechstens(p, wartenMs);
  return e ? { gestartet: true, fertig: true, projekte, ...ergebnisKurz(e, e.diagnosen.length) }
    : { gestartet: true, fertig: false, projekte, laeuft: fortschrittAnzeige(project), hinweis: `Nach ${Math.round(wartenMs / 1000)} s noch nicht fertig; laeuft weiter (Fortschritt: build_status).` };
}

// ─── Etappe 2: Go und Python projektweit (pruefer_projekt.py im selben Container) ────────────────────────────────────

interface SprachDef {
  art: SprachArt;
  sprache: 'dart' | 'csharp' | 'kotlin' | 'java' | 'rust' | 'go' | 'python' | 'c' | 'cpp';
  /** Aenderung an so einer Datei loest die Pruefung aus. */
  relevant: RegExp;
  /** Dateien des Schnappschusses (PG-Regex). */
  sql: string;
  /** Datei, deren Ordner ein Projekt ist (Go-Modul bzw. Python-Projekt). */
  wurzel: RegExp;
}

// P16-T18 E3a: ganzer PG-Projektausschnitt; Header koennen sprachuebergreifend eingebunden sein.
const C_PROJEKT_SQL = '(\\.(c|C|cc|cpp|cxx|c[+][+]|h|hh|hpp|hxx|inc|ipp|inl|tpp|m|mm)$)|((^|/)compile_commands\\.json$)';
const istCArt = (s: SprachDef): boolean => s.art === 'cbuild' || s.art === 'cppbuild';
// --- P16-T19 E3b Kotlin/Java ---
const JVM_SQL = '(\\.(kt|java)$)|((^|/)(pom\\.xml|build\\.gradle(\\.kts)?|settings\\.gradle(\\.kts)?|gradle\\.properties|synapse-jvm\\.json)$)';
const JVM_WURZEL = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|synapse-jvm\.json)$/;
const istJvmArt = (s: SprachDef): boolean => s.art === 'kotlinc' || s.art === 'javac';
const SPRACHEN: SprachDef[] = [
  // --- P16-T21 E3d Dart/C# ---
  { art: 'dartbuild', sprache: 'dart', relevant: /(?:\.dart|(?:^|\/)(?:pubspec\.(?:yaml|lock)|analysis_options\.yaml|package_config\.json))$/,
    sql: '(\\.dart$)|((^|/)(pubspec\\.(yaml|lock)|analysis_options\\.yaml|package_config\\.json)$)', wurzel: /(?:^|\/)pubspec\.yaml$/ },
  { art: 'csharpbuild', sprache: 'csharp', relevant: /(?:\.(?:cs|csproj|fs|fsproj|sln|props|targets)|(?:^|\/)global\.json)$/,
    sql: '(\\.(cs|csproj|fs|fsproj|sln|props|targets)$)|((^|/)global\\.json$)', wurzel: /\.(?:csproj|fsproj)$/ },
  { art: 'kotlinc', sprache: 'kotlin', relevant: /(?:\.(?:kt|java)|(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|synapse-jvm\.json))$/,
    sql: JVM_SQL, wurzel: JVM_WURZEL },
  { art: 'javac', sprache: 'java', relevant: /(?:\.(?:java|kt)|(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|synapse-jvm\.json))$/,
    sql: JVM_SQL, wurzel: JVM_WURZEL },
  { art: 'cbuild', sprache: 'c', relevant: /(?:\.c|\.m|\.(?:h|hh|hpp|hxx|inc|ipp|inl|tpp)|(?:^|\/)compile_commands\.json)$/,
    sql: C_PROJEKT_SQL, wurzel: /(?:^|\/)compile_commands\.json$/ },
  { art: 'cppbuild', sprache: 'cpp', relevant: /(?:\.(?:C|cc|cpp|cxx|c\+\+|mm|h|hh|hpp|hxx|inc|ipp|inl|tpp)|(?:^|\/)compile_commands\.json)$/,
    sql: C_PROJEKT_SQL, wurzel: /(?:^|\/)compile_commands\.json$/ },
  {
    art: 'gobuild', sprache: 'go', relevant: /(?:\.go|(?:^|\/)go\.(?:mod|sum))$/,
    sql: '(\\.go$)|((^|/)go\\.(mod|sum)$)|((^|/)vendor/modules\\.txt$)', wurzel: /(?:^|\/)go\.mod$/,
  },
  // --- P16-T16 E3c Rust: Cargo-Graph und alle PG-Rustquellen ---
  { art: 'rustcheck', sprache: 'rust',
    relevant: /(?:\.rs|(?:^|\/)(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|\.cargo\/(?:config|config\.toml)|\.cargo-checksum\.json))$/,
    sql: '(\\.rs$)|((^|/)(Cargo\\.(toml|lock)|rust-toolchain(\\.toml)?|\\.cargo/(config|config\\.toml)|\\.cargo-checksum\\.json)$)|((^|/)vendor/)',
    wurzel: /(?:^|\/)Cargo\.toml$/ },
  {
    art: 'pyright', sprache: 'python', relevant: /(?:\.pyi?|(?:^|\/)(?:pyproject\.toml|setup\.cfg|\.python-version))$/,
    sql: '(\\.pyi?$)|((^|/)(pyproject\\.toml|setup\\.cfg|\\.python-version)$)', wurzel: /(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg)$/,
  },
];
const SPRACH_AUSSCHLUSS = '(^|/)(node_modules|\\.venv|venv|\\.tox|site-packages|__pycache__|\\.git)/';
const SPRACH_NAME: Record<SprachArt, string> = { kotlinc: 'Kotlin', javac: 'Java', rustcheck: 'Rust', gobuild: 'Go', pyright: 'Python', cbuild: 'C', cppbuild: 'C++', dartbuild: 'Dart', csharpbuild: 'C#' };
const ALLE_SPRACHEN = ['kotlin', 'java', 'rust', 'go', 'python', 'c', 'cpp', 'dart', 'csharp'];

/** Dateien, deren Aenderung die Go- bzw. Python-Pruefung ausloest. */
export const istSprachRelevant = (p: string): boolean => SPRACHEN.some((s) => s.relevant.test(p));

/** Wirksame Sprachen neben TypeScript: Projekt-Eintrag, sonst global, sonst Env BUILD_PRUEFUNG_SPRACHEN, sonst go+python. */
export async function sprachenAktiv(project: string | undefined): Promise<string[]> {
  const z = await ladeEinstellungen();
  const p = project ? z.get('projekt:' + project)?.werte.sprachen : undefined;
  if (Array.isArray(p)) return p;
  const g = z.get('global')?.werte.sprachen;
  if (Array.isArray(g)) return g;
  const env = process.env.BUILD_PRUEFUNG_SPRACHEN;
  if (env !== undefined) return env.split(',').map((x) => x.trim().toLowerCase()).filter((x) => ALLE_SPRACHEN.includes(x));
  return ['go', 'python']; // E3-Sprachen ausdrücklich wählen.
}

/** Zaehlt fuer Basis/Status: Fehler (TS ohne schwere = Fehler); nie Importluecken, Warnungen, Hinweise. */
const istFehlerDiag = (d: BuildDiagnose): boolean => !d.weich && (d.schwere === undefined || d.schwere === 'error');
/** Wird zum Befund: Fehler und go vet-Analyzerbefunde (warning). Pyright-Warnungen/-Hinweise nicht. */
const istSprachBefundDiag = (d: BuildDiagnose): boolean => !d.weich && (d.schwere === 'error' || (d.schwere === 'warning' && d.code === 'vet'));

/** Go-/Python-Quellen des Projekts aus PG (ohne node_modules, venv, __pycache__ ...). */
async function ladeSprachQuellen(project: string, s: SprachDef): Promise<Map<string, string>> {
  const rows = (await getPool().query<{ file_path: string; content: string }>(
    `SELECT file_path, content FROM code_files
      WHERE project = $1 AND deleted_at IS NULL AND ignored = false AND content IS NOT NULL
        AND file_path ~ $2 AND file_path !~ $3
      ORDER BY file_path`,
    [project, s.sql, SPRACH_AUSSCHLUSS],
  )).rows;
  return new Map(rows.map((r) => [r.file_path, r.content]));
}

const projektName = (w: string): string => w || '.';
const sprachWurzeln = (s: SprachDef, quellen: Map<string, string>): string[] =>
  [...new Set([...quellen.keys()].filter((p) => s.wurzel.test(p)).map(dirOf))].sort();
/** Tiefste Projektwurzel, unter der die Datei liegt (undefined = keine). */
function naechsteWurzel(datei: string, wurzeln: string[]): string | undefined {
  return wurzeln.filter((w) => unter(datei, w)).sort((a, b) => b.length - a.length)[0];
}

/** Lokale replace-Ziele eines go.mod (./x, ../x), projekt-relativ; Ziele ausserhalb des Projekts entfallen. */
function goReplaceZiele(modDir: string, gomod: string | undefined): string[] {
  if (!gomod) return [];
  const ziele: string[] = [];
  for (const m of gomod.matchAll(/=>\s*["`]?(\.{1,2}(?:\/[^\s)"`]*)?)/g)) {
    const z = verbinde(modDir, m[1]);
    if (!z.startsWith('..')) ziele.push(z);
  }
  return ziele;
}

/** Hat der Stand diese Projektwurzel? Python: die Projektwurzel '' gibt es immer (Rueckfall ohne pyproject). */
const hatWurzel = (s: SprachDef, quellen: Map<string, string>, w: string): boolean =>
  ((s.art === 'pyright' || istJvmArt(s) || istCArt(s)) && w === '') || [...quellen.keys()].some((p) => s.wurzel.test(p) && dirOf(p) === w);

/**
 * Betroffene Projekte eines Plans: tiefste Wurzel je geaenderter Datei (Python ohne Wurzel: Projektwurzel; Go ohne
 * go.mod: nicht pruefbar). Go zusaetzlich transitiv alle Module, die ein betroffenes Modul per lokalem replace einbinden.
 */
function betroffeneWurzeln(s: SprachDef, quellen: Map<string, string>, geaendert: string[]): string[] {
  // E3a: bewusst alle TUs; auch Header ausserhalb einer compile_commands-Wurzel erreichen alle Aufrufer.
  if (istCArt(s)) return [''];
  const alle = sprachWurzeln(s, quellen);
  // E3b: nur Module mit dieser Quellart; gemeinsame Quellen und Elternmanifeste beachten.
  if (istJvmArt(s)) return alleSprachWurzeln(s, quellen).filter((w) => geaendert.some((f) =>
    unter(f, w) || (!/\.(?:kt|java)$/.test(f) && (w === dirOf(f) || unter(w + '/', dirOf(f))))));
  // Rust: alle Crates statt nur naechster Ordner; path-Aufrufer und Workspace-Wurzel mitpruefen.
  if (s.art === 'rustcheck') return alle;
  if (s.art === 'dartbuild' || s.art === 'csharpbuild') return alle;
  const betroffen = new Set<string>();
  for (const f of geaendert) {
    const w = naechsteWurzel(f, alle) ?? ((s.art === 'pyright' || istJvmArt(s)) ? '' : undefined);
    if (w !== undefined) betroffen.add(w);
  }
  if (s.art === 'gobuild') {
    for (let weiter = true; weiter;) {
      weiter = false;
      for (const m of alle) {
        if (betroffen.has(m)) continue;
        if (goReplaceZiele(m, quellen.get(verbinde(m, 'go.mod'))).some((z) => betroffen.has(z))) {
          betroffen.add(m);
          weiter = true;
        }
      }
    }
  }
  return [...betroffen].sort();
}

/** Alle Projekte des Stands (Basispruefung); Python mit Projektwurzel, wenn Dateien ausserhalb jeder Wurzel liegen. */
function alleSprachWurzeln(s: SprachDef, quellen: Map<string, string>): string[] {
  if (istCArt(s)) return [...quellen.keys()].some((p) => (s.art === 'cbuild' ? /\.(?:c|m)$/ : /\.(?:C|cc|cpp|cxx|c\+\+|mm)$/).test(p)) ? [''] : [];
  const w = sprachWurzeln(s, quellen);
  if (istJvmArt(s)) {
    const ext = s.art === 'kotlinc' ? /\.kt$/ : /\.java$/;
    const own = [...quellen.keys()].filter((p) => ext.test(p));
    const roots = w.filter((r) => own.some((p) => naechsteWurzel(p, w) === r));
    if (own.some((p) => naechsteWurzel(p, w) === undefined)) roots.unshift('');
    return roots;
  }
  if (s.art === 'pyright' && !w.includes('') && [...quellen.keys()].some((p) => /\.pyi?$/.test(p) && naechsteWurzel(p, w) === undefined)) w.unshift('');
  return w;
}

/**
 * Auftrag fuer pruefer_projekt.py: Dateien der Projekte (Go: nur das Modul selbst, verschachtelte Module nur ueber
 * lokales replace; Python: alles unter der Wurzel) plus Cache-Schluessel. Nichts wird erzeugt oder umgeschrieben.
 */
function bereiteSpracheVor(s: SprachDef, quellen: Map<string, string>, wurzeln: string[], budget: BuildBudget): Vorbereitet {
  const alle = sprachWurzeln(s, quellen);
  // Rust: geschlossener PG-Snapshot inklusive path-/Workspace-/Vendor-Graph und Elternkonfigurationen.
  const pfade = new Set<string>(s.art === 'rustcheck' ? [...quellen.keys()] : []);
  const besucht = new Set<string>();
  const sammle = (w: string): void => {
    if (besucht.has(w)) return;
    besucht.add(w);
    for (const p of quellen.keys()) {
      if (!unter(p, w)) continue;
      if ((s.art === 'gobuild' || istJvmArt(s)) && (naechsteWurzel(p, alle) ?? '') !== w) continue;
      pfade.add(p);
    }
    if (s.art === 'gobuild') {
      for (const z of goReplaceZiele(w, quellen.get(verbinde(w, 'go.mod')))) if (alle.includes(z)) sammle(z);
    }
  };
  for (const w of wurzeln) sammle(w);
  // E3b: Eltern-Builddateien enthalten oft KAPT/KSP/Annotation-Processing oder SDK-Vorgaben.
  // Nur als Daten ergänzen; außerhalb liegende Projektquellen bleiben ausgeschlossen.
  if (istJvmArt(s)) for (const p of quellen.keys()) {
    if (/\.(?:kt|java)$/.test(p)) continue;
    if (wurzeln.some((w) => w === dirOf(p) || unter(w + '/', dirOf(p)))) pfade.add(p);
  }
  // E3d references can leave the selected package directory but never the PG snapshot.
  if (s.art === 'dartbuild' || s.art === 'csharpbuild') for (const p of quellen.keys()) pfade.add(p);
  const dateien: BuildDatei[] = [...pfade].sort().map((pfad) => ({ pfad, inhalt: quellen.get(pfad) ?? '' }));
  const bytes = dateien.reduce((n, d) => n + Buffer.byteLength(d.inhalt), 0);
  const python_version = s.art === 'pyright'
    ? wurzeln.map((w) => /^\s*(3\.\d{1,2})\b/.exec(quellen.get(verbinde(w, '.python-version')) ?? '')?.[1]).find((v): v is string => !!v)
    : undefined;
  const projekte = wurzeln.map(projektName);
  const auftrag: BuildAuftrag = {
    art: s.art, dateien, projekte, zeitlimit_ms: budget.zeitlimit_s * 1000, heap_mb: budget.heap_mb,
    ...(python_version ? { python_version } : {}),
  };
  const schluessel = sha(JSON.stringify(['e2', s.art, budget.heap_mb, budget.zeitlimit_s, projekte, python_version ?? null, dateien.map((d) => [d.pfad, sha(d.inhalt)])]));
  return { auftrag, schluessel, bytes, sprache: s.sprache };
}

/** Alle Schritte eines Projekts (Go: build + vet) fertig? */
function sprachFertig(e: BuildLaufErgebnis, name: string): boolean {
  const laeufe = e.projekte.filter((p) => p.projekt === name);
  return laeufe.length > 0 && laeufe.every((p) => p.status === 'fertig');
}

function alsSprachBefund(d: BuildDiagnose, dateien: PruefDatei[], werkzeug: string, art: SprachArt): BuildBefund {
  const projekt = d.projekt || '.';
  const vet = d.code === 'vet';
  const warnung = d.schwere === 'warning';
  const was = (art === 'kotlinc' ? 'Kotlin' : art === 'javac' ? 'Java' : art === 'pyright' ? 'Pyright' : SPRACH_NAME[art] ?? art);
  return {
    quelle: 'build',
    pruefer: `build:${werkzeug.split(' (')[0].replace(/\s+/g, '@')}`,
    severity: warnung ? 'warning' : 'error',
    datei: d.datei ?? verbinde(projekt === '.' ? '' : projekt, art === 'rustcheck' ? 'Cargo.toml' : art === 'gobuild' ? 'go.mod' : 'pyproject.toml'),
    zeilen: [Math.max(1, d.zeile), Math.max(1, d.zeile)],
    ...(d.spalte > 0 ? { spalte: d.spalte } : {}),
    // Code mit Kurz-Hash der Meldung: Quittierungen bleiben je Meldung getrennt (Schluessel ohne Zeile).
    code: `${d.code}#${sha(meldungNorm(d.meldung)).slice(0, 6)}`,
    titel: `${d.code} (${was} ${projekt})`,
    was: d.meldung,
    warum: art === 'rustcheck'
      ? 'Neuer Fehler der projektweiten Rust-Pruefung (cargo check offline/locked, Graph ohne Buildskripte/Proc-Makros) gegenueber dem Basisstand.'
      : art === 'cbuild' || art === 'cppbuild'
      ? 'Neuer Fehler der projektweiten C/C++-Pruefung (-fsyntax-only, ohne Objektdateien/Linken) gegenueber dem Basisstand.'
      : art === 'gobuild'
      ? (vet
        ? `Neuer go-vet-Befund im Modul ${projekt} gegenueber dem Basisstand (Warnung, sperrt nicht).`
        : `Neuer Fehler der projektweiten Go-Pruefung (go build -o /dev/null, Typpruefung der Tests ueber go vet; Modul ${projekt}) gegenueber dem Basisstand.`)
      : art === 'pyright'
      ? `Neuer Fehler der projektweiten Python-Typpruefung (Pyright, Projekt ${projekt}) gegenueber dem Basisstand.`
      : `Neuer Fehler der projektweiten ${was}-Typpruefung (Projekt ${projekt}) gegenueber dem Basisstand.`,
    wie: warnung
      ? 'Pruefen und bei Bedarf im selben Plan anpassen (sperrt nicht).'
      : 'Betroffene Aufrufer/Typen im selben Plan anpassen (plan_update bzw. coedit_add) oder bewusst quittieren (commit mit befunde_quittieren).',
    wo: [projekt],
    ...opZuordnung(d, dateien),
  };
}

/** Go- bzw. Python-Teil der Build-Stufe eines Plans; Verhalten wie der TypeScript-Teil. null = nichts zu pruefen. */
async function pruefeSpracheFuerPlan(project: string, s: SprachDef, dateien: PruefDatei[], o: BuildPlanOptionen): Promise<BuildPlanErgebnis | null> {
  const relevant = dateien.filter((d) => s.relevant.test(d.file_path));
  if (relevant.length === 0) return null;
  const t0 = Date.now();
  const stand = (x: Partial<BuildStand> & Pick<BuildStand, 'status'>): BuildStand => ({ tor: true, neue_fehler: 0, projekte: [], sprache: s.sprache, ...x, dauer_ms: x.dauer_ms ?? Date.now() - t0 });
  try {
    if (!(await buildAktiv(project)).aktiv) return null;
    if (!(await sprachenAktiv(project)).includes(s.sprache)) return null;
    if (!anbindung) return { stand: stand({ status: 'nicht_verfuegbar', hinweis: KEIN_PRUEFER }), befunde: [] };
    const budget = await wirksamesBuildBudget();
    const basisQuellen = await ladeSprachQuellen(project, s);
    const geschrieben = o.nachlauf ? new Map(basisQuellen) : null;
    if (o.nachlauf) stelleBasisHer(basisQuellen, relevant);
    const schattenQuellen = geschrieben ?? new Map(basisQuellen);
    for (const d of geschrieben ? [] : relevant) {
      if (d.geloescht) schattenQuellen.delete(d.file_path);
      else schattenQuellen.set(d.file_path, d.ergebnis);
    }
    // E3b: beide Quellarten teilen die Modulmenge; leere zweite JVM-Prüfung entfällt.
    if (istJvmArt(s) && alleSprachWurzeln(s, schattenQuellen).length === 0) return null;
    // E3a: gemeinsame Header duerfen keine leere zweite Sprachpruefung erzeugen.
    if (istCArt(s) && alleSprachWurzeln(s, schattenQuellen).length === 0
      && [...schattenQuellen.keys()].some((p) => /\.(?:c|m|C|cc|cpp|cxx|c\+\+|mm)$/.test(p))) return null;
    const wurzeln = betroffeneWurzeln(s, schattenQuellen, relevant.map((d) => d.file_path));
    // JVM: ein Plan der anderen Sprache außerhalb gemischter Module enthält nichts zu prüfen.
    // Keine Prüfung ist kein unvollständiger Lauf; fehlender Kontext einer echten Prüfung bleibt teilweise.
    if (istJvmArt(s) && wurzeln.length === 0) return null;
    if (wurzeln.length === 0) {
      if (s.art === 'dartbuild' || s.art === 'csharpbuild') return { stand: stand({ status: 'teilweise', hinweis: `${SPRACH_NAME[s.art]}: Projektmanifest fehlt (pubspec.yaml/.csproj); F# nicht unterstützt.` }), befunde: [] };
      // E2-Verhalten: nicht geprueft ist kein Teilstatus; nicht betroffene Sprachen veraendern den Stand nicht.
      if (s.art === 'gobuild') return { stand: stand({ status: 'fertig', hinweis: 'Keine geaenderte Go-Datei liegt in einem Modul (go.mod) - nicht geprueft.' }), befunde: [] };
      return { stand: stand({ status: 'fertig', hinweis: `Keine geaenderte ${SPRACH_NAME[s.art]}-Datei liegt in einer Projektwurzel - nicht geprueft.` }), befunde: [] };
    }
    const projekte = wurzeln.map(projektName);
    const basisWurzeln = wurzeln.filter((w) => hatWurzel(s, basisQuellen, w));
    const a = bereiteSpracheVor(s, basisQuellen, basisWurzeln, budget);
    const b = bereiteSpracheVor(s, schattenQuellen, wurzeln, budget);
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
      const pa = starteLauf(project, a, o.nachlauf ? undefined : { projekte: basisWurzeln.map(projektName), vollstaendig: false, art: s.art });
      const pb = starteLauf(project, b, o.nachlauf ? { projekte, vollstaendig: false, art: s.art } : undefined);
      if (!o.warten) {
        return {
          stand: stand({ status: 'laeuft', projekte, laufend: laufend.size, hinweis: `Projektweite ${SPRACH_NAME[s.art]}-Pruefung laeuft im Pruefcontainer (Basis und Plan-Stand); Ergebnis bei plan_status/commit. Ein commit wird solange eingereiht, nicht gesperrt.` }),
          befunde: [],
        };
      }
      [basis, schatten] = await Promise.all([pa, pb]);
    }
    if (basis.status === 'nicht_verfuegbar' || schatten.status === 'nicht_verfuegbar') {
      return { stand: stand({ status: 'nicht_verfuegbar', projekte, hinweis: schatten.hinweis ?? basis.hinweis ?? KEIN_PRUEFER }), befunde: [] };
    }
    const neu: BuildDiagnose[] = [];
    const unvollstaendig: string[] = [];
    const abdeckung: string[] = [];
    for (const w of wurzeln) {
      const name = projektName(w);
      const imBasis = basisWurzeln.includes(w);
      if (!sprachFertig(schatten, name) || (imBasis && !sprachFertig(basis, name))) {
        const lauf = [...schatten.projekte, ...basis.projekte].find((p) => p.projekt === name && p.status !== 'fertig');
        const grund = lauf?.hinweis ?? schatten.hinweis ?? basis.hinweis;
        unvollstaendig.push(`${name}: ${lauf?.status ?? 'nicht gelaufen'}${grund ? ` (${grund})` : ''}`);
        continue;
      }
      for (const l of schatten.projekte) {
        if (l.projekt === name && l.abdeckung === 'unvollstaendig') abdeckung.push(`${name}: ${l.fehlende_importe ?? '?'} Import(e) nicht aufgeloest`);
      }
      neu.push(...neueDiagnosen(
        imBasis ? basis.diagnosen.filter((d) => d.projekt === name && istSprachBefundDiag(d)) : [],
        schatten.diagnosen.filter((d) => d.projekt === name && istSprachBefundDiag(d)),
        relevant,
      ));
    }
    const gesehen = new Set<string>();
    const eindeutig = neu.filter((d) => {
      const k = `${d.datei ?? ''}|${d.zeile}|${d.code}|${meldungNorm(d.meldung)}`;
      if (gesehen.has(k)) return false;
      gesehen.add(k);
      return true;
    });
    const werkzeug = schatten.werkzeug ?? basis.werkzeug ?? s.art;
    const befunde = eindeutig.map((d) => alsBefund(d, relevant, werkzeug, s.art));
    const fehler = befunde.filter((x) => x.severity === 'error').length;
    const warnungen = befunde.length - fehler;
    const hinweise = [
      ...(unvollstaendig.length > 0 ? [`Teilweise geprueft (sperrt nicht): ${unvollstaendig.join('; ')}.`] : []),
      ...(abdeckung.length > 0 ? [`Abdeckung unvollstaendig (dort Unknown, keine Folgefehler): ${abdeckung.join('; ')}.`] : []),
      ...(fehler > 0 ? [`${fehler} neue(r) ${SPRACH_NAME[s.art]}-Fehler gegenueber dem Basisstand - ${o.nachlauf ? NACHLAUF_FOLGE : 'sperrt den commit; korrigieren oder quittieren.'}`] : []),
      ...(warnungen > 0 ? [`${warnungen} neue go-vet-Warnung(en) (sperren nicht).`] : []),
    ];
    return {
      stand: stand({
        status: unvollstaendig.length > 0 ? 'teilweise' : 'fertig', neue_fehler: fehler, ...(warnungen > 0 ? { neue_warnungen: warnungen } : {}),
        basis_fehler: basis.diagnosen.filter(istFehlerDiag).length, projekte, dauer_ms: basis.dauer_ms + schatten.dauer_ms, werkzeug,
        ...(hinweise.length > 0 ? { hinweis: hinweise.join(' ') } : {}),
      }),
      befunde,
    };
  } catch (err) {
    return { stand: stand({ status: 'nicht_verfuegbar', hinweis: `${SPRACH_NAME[s.art]}-Pruefung fehlgeschlagen (sperrt nicht): ${(err as Error).message}` }), befunde: [] };
  }
}

/** Mehrere Teilstaende (TS, Go, Python) zu einem: laeuft gewinnt (Warteschlange), sonst teilweise vor fertig. */
function kombiniere(teile: BuildPlanErgebnis[]): BuildPlanErgebnis | null {
  if (teile.length === 0) return null;
  if (teile.length === 1) return teile[0];
  const st = teile.map((t) => t.stand);
  const status: BuildStand['status'] = st.some((s) => s.status === 'laeuft') ? 'laeuft'
    : st.every((s) => s.status === 'nicht_verfuegbar') ? 'nicht_verfuegbar'
      : st.some((s) => s.status !== 'fertig') ? 'teilweise' : 'fertig';
  const summe = (f: (s: BuildStand) => number | undefined): number => st.reduce((n, s) => n + (f(s) ?? 0), 0);
  const name = (s: BuildStand): string => s.sprache ? (SPRACH_NAME[SPRACHEN.find((x) => x.sprache === s.sprache)?.art ?? 'pyright'] ?? s.sprache) : 'TypeScript';
  const hinweise = st.filter((s) => s.hinweis).map((s) => `${name(s)}: ${s.hinweis}`);
  const werkzeug = [...new Set(st.map((s) => s.werkzeug).filter((w): w is string => !!w))].join(' + ');
  const warnungen = summe((s) => s.neue_warnungen);
  return {
    stand: {
      status, tor: true, neue_fehler: summe((s) => s.neue_fehler),
      ...(warnungen > 0 ? { neue_warnungen: warnungen } : {}),
      ...(st.some((s) => s.basis_fehler !== undefined) ? { basis_fehler: summe((s) => s.basis_fehler) } : {}),
      projekte: st.flatMap((s) => (s.sprache ? s.projekte.map((p) => `${s.sprache}:${p}`) : s.projekte)),
      dauer_ms: summe((s) => s.dauer_ms),
      ...(werkzeug ? { werkzeug } : {}),
      ...(hinweise.length > 0 ? { hinweis: hinweise.join(' | ') } : {}),
      ...(status === 'laeuft' ? { laufend: Math.max(0, ...st.map((s) => s.laufend ?? 0)) } : {}),
      teile: st,
    },
    befunde: teile.flatMap((t) => t.befunde),
  };
}

/**
 * Build-Stufe eines Plans (plan-befunde.ts): TypeScript (E1) plus Go/Python (E2). null = Schalter aus oder keine
 * relevante Datei. Ohne Go-/Python-Datei im Plan exakt das E1-Ergebnis. Wirft nie.
 */
export async function pruefeBuildFuerPlan(project: string, dateien: PruefDatei[], o: BuildPlanOptionen = {}): Promise<BuildPlanErgebnis | null> {
  const tsTeil = await pruefeTsBuildFuerPlan(project, dateien, o);
  if (!dateien.some((d) => istSprachRelevant(d.file_path))) return tsTeil;
  const teile: BuildPlanErgebnis[] = tsTeil ? [tsTeil] : [];
  for (const s of SPRACHEN) {
    const e = await pruefeSpracheFuerPlan(project, s, dateien, o);
    if (e) teile.push(e);
  }
  return kombiniere(teile);
}

/** Basisstand einer Sprache (alle Projekte). null = keine Projekte dieser Sprache im Index. */
async function pruefeSpracheBasis(project: string, s: SprachDef, wartenMs: number): Promise<Record<string, unknown> | null> {
  const budget = await wirksamesBuildBudget();
  const quellen = await ladeSprachQuellen(project, s);
  const wurzeln = alleSprachWurzeln(s, quellen);
  if (wurzeln.length === 0) return null;
  const projekte = wurzeln.map(projektName);
  const v = bereiteSpracheVor(s, quellen, wurzeln, budget);
  if (v.bytes > budget.max_mb * 1024 * 1024) {
    return { gestartet: false, status: 'teilweise', projekte, hinweis: `Schnappschuss ${(v.bytes / 1048576).toFixed(1)} MB > ${budget.max_mb} MB - tmpfs_mb erhoehen.` };
  }
  const p = starteLauf(project, v, { projekte, vollstaendig: true, art: s.art });
  if (wartenMs <= 0) return { gestartet: true, projekte };
  const e = await hoechstens(p, wartenMs);
  return e ? { gestartet: true, fertig: true, projekte, ...ergebnisKurz(e, e.diagnosen.filter(istFehlerDiag).length) }
    : { gestartet: true, fertig: false, projekte, laeuft: fortschrittAnzeige(project), hinweis: `Nach ${Math.round(wartenMs / 1000)} s noch nicht fertig; laeuft weiter (Fortschritt: build_status).` };
}

/**
 * Basisstand eines Projekts pruefen: TypeScript (E1) und - wenn vorhanden und eingeschaltet - Go/Python (E2, Feld
 * sprachen). wartenMs > 0: insgesamt hoechstens so lange auf die Resultate warten. Ohne Go/Python wie in E1.
 */
export async function pruefeBuildBasis(project: string, wartenMs = 0): Promise<Record<string, unknown>> {
  const ende = Date.now() + wartenMs;
  const tsErgebnis = await pruefeTsBuildBasis(project, wartenMs);
  if (!anbindung) return tsErgebnis;
  const aktiv = await sprachenAktiv(project);
  const sprachen: Record<string, unknown> = {};
  for (const s of SPRACHEN) {
    if (!aktiv.includes(s.sprache)) continue;
    const r = await pruefeSpracheBasis(project, s, wartenMs > 0 ? Math.max(1, ende - Date.now()) : 0);
    if (r) sprachen[s.sprache] = r;
  }
  return Object.keys(sprachen).length > 0 ? { ...tsErgebnis, sprachen } : tsErgebnis;
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

// ─── P16-T23: Nachlauf (commit schreibt sofort, Pruefung danach gebuendelt) ─────────────────────────────────────

/** Hinweis an den Committer (Feld build_nachlauf der naechsten Tool-Antwort, tool-antwort.ts). */
export interface BuildNachlaufHinweis {
  plan_id: string;
  project: string;
  status: BuildStand['status'] | 'nicht_geprueft';
  neue_fehler: number;
  neue_warnungen?: number;
  fertig_am: string;
  hinweis: string;
  befunde?: Array<{ datei: string; zeile: number; code?: string; was: string }>;
  abruf: string;
}

/** Ergebnis je Plan an file-batch (am Plan speichern); null = nichts geprueft (Build-Tor aus, keine relevante Datei). */
export type BuildNachlaufRueckruf = (e: BuildPlanErgebnis | null) => Promise<void> | void;

interface NachlaufAuftrag {
  project: string;
  plan_id: string;
  agent: string | null;
  dateien: PruefDatei[];
  angestossen_am: string;
  rueckruf?: BuildNachlaufRueckruf;
}

interface NachlaufLauf {
  plaene: Array<{ plan_id: string; agent: string | null }>;
  gestartet_am: string;
  fertig_am?: string;
  status?: BuildNachlaufHinweis['status'];
  neue_fehler?: number;
  dauer_ms?: number;
  hinweis?: string;
  /** neue Befunde mit Plan-Zuordnung (build_status) */
  befunde?: Array<{ plan_ids: string[]; datei: string; zeile: number; code?: string; severity: string; was: string }>;
}

const nachlaufWartend = new Map<string, NachlaufAuftrag[]>();
const nachlaufLaeuft = new Map<string, NachlaufLauf>();
const nachlaufTimer = new Map<string, ReturnType<typeof setTimeout>>();
const nachlaufLetzte = new Map<string, NachlaufLauf[]>();
const nachlaufHinweise = new Map<string, BuildNachlaufHinweis[]>();
/** Schon angestossene Plaene: ein Plan wird nur einmal committet (Wiederholungsweg commitLegacyLocked -> commitBatchOnce). */
const nachlaufAngestossen = new Set<string>();
const nachlaufZaehler = { vorgemerkt: 0, angestossen: 0, laeufe: 0, gebuendelt: 0, hinweise_zugestellt: 0, fehler: 0 };
let nachlaufLetzterFehler: { zeit: string; fehler: string } | null = null;
const NACHLAUF_HINWEISE_MAX = 20;

/** Anstoesse eines Buendels zu einer Pruefdatei je Pfad: Basis vom ersten, Endstand vom letzten commit. */
function vereineNachlaufDateien(auftraege: NachlaufAuftrag[]): PruefDatei[] {
  const je = new Map<string, PruefDatei>();
  for (const a of auftraege) {
    for (const d of a.dateien) {
      const alt = je.get(d.file_path);
      je.set(d.file_path, alt
        ? { file_path: d.file_path, basis: alt.basis, ergebnis: d.ergebnis, ...(d.geloescht ? { geloescht: true } : {}), ops: [...alt.ops, ...d.ops] }
        : { ...d, ops: [...d.ops] });
    }
  }
  return [...je.values()];
}

/** Befund gehoert zum Plan: in seinen Dateien, oder Folgefehler ausserhalb aller Plaene des Buendels (dann alle). */
function gehoertZu(a: NachlaufAuftrag, b: BuildBefund, imBuendel: Set<string>): boolean {
  return a.dateien.some((d) => d.file_path === b.datei) || !imBuendel.has(b.datei);
}

function nachlaufBefundeFuer(a: NachlaufAuftrag, alle: NachlaufAuftrag[], imBuendel: Set<string>, befunde: BuildBefund[]): BuildBefund[] {
  return befunde.filter((b) => gehoertZu(a, b, imBuendel)).map((b) => {
    // Mehrere Plaene im Buendel: op_index gilt nur, wenn dieser Plan die Op an der Datei hat.
    if (alle.length === 1 || b.op_index === null) return b;
    const d = a.dateien.find((x) => x.file_path === b.datei);
    return d?.ops.some((o) => o.op_index === b.op_index) ? b : { ...b, op_index: null, agent_id: null };
  });
}

function nachlaufHinweis(planId: string, project: string, e: BuildPlanErgebnis | null): BuildNachlaufHinweis {
  const abruf = `files(action:"plan_status", plan_id:"${planId}", ansicht:"befunde") bzw. code_check(action:"build_status", project:"${project}")`;
  const fertig_am = new Date().toISOString();
  if (!e) {
    return { plan_id: planId, project, status: 'nicht_geprueft', neue_fehler: 0, fertig_am, abruf,
      hinweis: `Deine grosse Pruefung zu Plan ${planId}: nicht geprueft (Build-Tor aus oder keine betroffene Datei).` };
  }
  const s = e.stand;
  const fehler = e.befunde.filter((b) => b.severity === 'error');
  const ergebnis = s.status === 'nicht_verfuegbar' ? `nicht verfuegbar (${s.hinweis ?? KEIN_PRUEFER})`
    : fehler.length === 0 ? (s.status === 'teilweise' ? 'gruen, aber nur teilweise geprueft' : 'gruen')
      : `${fehler.length} neue(r) Fehler${s.status === 'teilweise' ? ' (teilweise geprueft)' : ''}`;
  return {
    plan_id: planId, project, status: s.status, neue_fehler: fehler.length,
    ...(s.neue_warnungen ? { neue_warnungen: s.neue_warnungen } : {}),
    fertig_am,
    hinweis: `Deine grosse Pruefung zu Plan ${planId} ist durch: ${ergebnis} - abrufen mit ${abruf}.`,
    ...(fehler.length > 0 ? { befunde: fehler.slice(0, 3).map((b) => ({ datei: b.datei, zeile: b.zeilen[0], ...(b.code ? { code: b.code } : {}), was: b.was.slice(0, 200) })) } : {}),
    abruf,
  };
}

function planeNachlauf(project: string, ms: number): void {
  if (nachlaufLaeuft.has(project) || nachlaufTimer.has(project)) return;
  const t = setTimeout(() => {
    nachlaufTimer.delete(project);
    void fuehreNachlaufAus(project);
  }, Math.max(0, ms));
  t.unref?.();
  nachlaufTimer.set(project, t);
}

/** P16-T23: geschriebene Plaene mit ihren Pruefdateien, bis build_pruefen sie anstoesst (nur im Speicher, begrenzt). */
const nachlaufVorgemerkt = new Map<string, Omit<NachlaufAuftrag, 'angestossen_am'> & { vorgemerkt_am: string }>();
const NACHLAUF_VORMERK_MAX = 200;

/** Fertig ausgefuellter Aufruf der grossen Pruefung eines geschriebenen Plans (Hinweis in der commit-Antwort). */
export function buildPruefenAufruf(project: string, planId: string): string {
  return `code_check(action:"build_pruefen", project:"${project}", plan_id:"${planId}")`;
}

/**
 * P16-T23 (User-Korrektur 21.10.2026: keine Automatik): nach einem GESCHRIEBENEN commit startet NICHTS. Der Plan wird
 * nur vorgemerkt (wirksamer Nachlauf-Schalter und Build-Tor, build-relevante Dateien); die commit-Antwort bekommt den
 * fertigen Aufruf build_pruefen. null = nichts vorgemerkt (Antwort unveraendert). Wirft nie.
 */
export async function merkeBuildNachlaufVor(
  project: string, planId: string, agent: string | null, dateien: PruefDatei[], rueckruf?: BuildNachlaufRueckruf,
): Promise<Record<string, unknown> | null> {
  try {
    if (!dateien.some((d) => istBuildRelevant(d.file_path) || istSprachRelevant(d.file_path))) return null;
    if (!(await buildNachlaufAktiv(project)).aktiv || !(await buildAktiv(project)).aktiv) return null;
    nachlaufVorgemerkt.set(planId, { project, plan_id: planId, agent, dateien, vorgemerkt_am: new Date().toISOString(), ...(rueckruf ? { rueckruf } : {}) });
    while (nachlaufVorgemerkt.size > NACHLAUF_VORMERK_MAX) nachlaufVorgemerkt.delete(nachlaufVorgemerkt.keys().next().value as string);
    nachlaufZaehler.vorgemerkt++;
    const aufruf = buildPruefenAufruf(project, planId);
    return {
      vorgemerkt: true, plan_id: planId, aufruf,
      hinweis: `Geschrieben. Die grosse projektweite Pruefung startet nur auf Anstoss: ${aufruf} - sie laeuft dann im Hintergrund auf einem Abbild `
        + 'des geschriebenen Stands, sperrt nichts, und das Ergebnis kommt als Feld build_nachlauf in deiner naechsten Tool-Antwort.',
    };
  } catch (err) {
    nachlaufZaehler.fehler++;
    nachlaufLetzterFehler = { zeit: new Date().toISOString(), fehler: (err as Error).message };
    return null;
  }
}

/**
 * P16-T23: code_check(build_pruefen, plan_id) - startet die grosse Pruefung eines geschriebenen, vorgemerkten Plans im
 * Hintergrund (je Projekt gebuendelt, Sammelzeit buendel_ms). Offener Plan -> erst committen. agent = Empfaenger des
 * Ergebnis-Hinweises (Aufrufer, sonst Committer). Wirft nie.
 */
export async function stosseBuildNachlaufAn(planId: string, agent: string | null): Promise<Record<string, unknown>> {
  try {
    const v = nachlaufVorgemerkt.get(planId);
    if (!v) {
      if (nachlaufAngestossen.has(planId)) {
        return { success: true, plan_id: planId, angestossen: true, wiederholt: true, hinweis: 'Schon angestossen; das Ergebnis kommt als build_nachlauf in der naechsten Tool-Antwort, Stand in build_status.' };
      }
      const r = await getPool().query<{ status: string; project: string }>('SELECT status::text AS status, project FROM file_batch_plans WHERE id = $1::bigint', [planId]);
      const plan = r.rows[0];
      if (plan?.status === 'open') {
        return {
          success: false, error: 'plan_offen', plan_id: planId,
          message: `Plan ${planId} ist noch offen - erst committen: files(action:"commit", plan_id:"${planId}"). Fuer offene Plaene gilt nur die schnelle Pruefung der `
            + 'geaenderten Dateien; die grosse Pruefung prueft nur den geschriebenen Stand. Die commit-Antwort nennt danach den fertigen Aufruf.',
        };
      }
      return {
        success: false, error: 'nicht_vorgemerkt', plan_id: planId,
        message: `Plan ${planId} (${plan?.status ?? 'unbekannt'}) ist nicht zur grossen Pruefung vorgemerkt: beim commit Nachlauf-Schalter oder Build-Tor aus, keine `
          + `build-relevante Datei, oder die API ist seitdem neu gestartet. Stattdessen den Basisstand pruefen: code_check(action:"build_status"${plan ? `, project:"${plan.project}"` : ''}, pruefen:true).`,
      };
    }
    nachlaufVorgemerkt.delete(planId);
    nachlaufAngestossen.add(planId);
    if (nachlaufAngestossen.size > 500) nachlaufAngestossen.delete(nachlaufAngestossen.values().next().value as string);
    const liste = nachlaufWartend.get(v.project) ?? [];
    liste.push({ project: v.project, plan_id: v.plan_id, agent: agent ?? v.agent, dateien: v.dateien, angestossen_am: new Date().toISOString(), ...(v.rueckruf ? { rueckruf: v.rueckruf } : {}) });
    nachlaufWartend.set(v.project, liste);
    nachlaufZaehler.angestossen++;
    const schalter = await buildNachlaufAktiv(v.project);
    const laeuft = nachlaufLaeuft.get(v.project);
    planeNachlauf(v.project, schalter.buendel_ms);
    return {
      success: true, plan_id: planId, project: v.project, angestossen: true, wartend: liste.length,
      ...(laeuft ? { laeuft_seit: laeuft.gestartet_am } : {}),
      hinweis: `Grosse Pruefung angestossen (${laeuft ? 'nach dem laufenden Durchgang' : `gebuendelt nach ${Math.round(schalter.buendel_ms / 100) / 10} s`}) auf einem Abbild des `
        + 'geschriebenen Stands - normal weiterarbeiten, nichts wird gesperrt. Das Ergebnis kommt als Feld build_nachlauf in deiner naechsten Tool-Antwort; '
        + `Stand: code_check(action:"build_status", project:"${v.project}").`,
    };
  } catch (err) {
    nachlaufZaehler.fehler++;
    nachlaufLetzterFehler = { zeit: new Date().toISOString(), fehler: (err as Error).message };
    return { success: false, error: 'fehler', plan_id: planId, message: (err as Error).message };
  }
}

/** Ein Lauf fuer alle bis jetzt angestossenen commits des Projekts; danach hoechstens ein weiterer. Wirft nie. */
async function fuehreNachlaufAus(project: string): Promise<void> {
  const auftraege = nachlaufWartend.get(project) ?? [];
  nachlaufWartend.delete(project);
  if (auftraege.length === 0) return;
  const lauf: NachlaufLauf = { plaene: auftraege.map((a) => ({ plan_id: a.plan_id, agent: a.agent })), gestartet_am: new Date().toISOString() };
  nachlaufLaeuft.set(project, lauf);
  nachlaufZaehler.laeufe++;
  nachlaufZaehler.gebuendelt += auftraege.length - 1;
  const t0 = Date.now();
  try {
    let ergebnis: BuildPlanErgebnis | null;
    try {
      ergebnis = await pruefeBuildFuerPlan(project, vereineNachlaufDateien(auftraege), { warten: true, nachlauf: true });
    } catch (err) {
      nachlaufZaehler.fehler++;
      nachlaufLetzterFehler = { zeit: new Date().toISOString(), fehler: (err as Error).message };
      ergebnis = { stand: { status: 'nicht_verfuegbar', tor: true, neue_fehler: 0, projekte: [], dauer_ms: Date.now() - t0, hinweis: `Nachlauf fehlgeschlagen: ${(err as Error).message}` }, befunde: [] };
    }
    const imBuendel = new Set(auftraege.flatMap((a) => a.dateien.map((d) => d.file_path)));
    for (const a of auftraege) {
      let teil: BuildPlanErgebnis | null = null;
      if (ergebnis) {
        const eigene = nachlaufBefundeFuer(a, auftraege, imBuendel, ergebnis.befunde);
        teil = { stand: { ...ergebnis.stand, nachlauf: true, neue_fehler: eigene.filter((b) => b.severity === 'error').length }, befunde: eigene };
      }
      try {
        await a.rueckruf?.(teil);
      } catch (err) {
        console.error(`[build-pruefung] P16-T23: Nachlauf-Ergebnis an Plan ${a.plan_id} nicht gespeichert: ${(err as Error).message}`);
      }
      if (a.agent) {
        const liste = nachlaufHinweise.get(a.agent) ?? [];
        liste.push(nachlaufHinweis(a.plan_id, project, teil));
        nachlaufHinweise.set(a.agent, liste.slice(-NACHLAUF_HINWEISE_MAX));
      }
    }
    const alle = ergebnis?.befunde ?? [];
    Object.assign(lauf, {
      fertig_am: new Date().toISOString(), dauer_ms: Date.now() - t0,
      status: ergebnis?.stand.status ?? 'nicht_geprueft', neue_fehler: alle.filter((b) => b.severity === 'error').length,
      ...(ergebnis?.stand.hinweis ? { hinweis: ergebnis.stand.hinweis } : {}),
      befunde: alle.slice(0, 20).map((b) => ({
        plan_ids: auftraege.filter((a) => gehoertZu(a, b, imBuendel)).map((a) => a.plan_id),
        datei: b.datei, zeile: b.zeilen[0], ...(b.code ? { code: b.code } : {}), severity: b.severity, was: b.was.slice(0, 300),
      })),
    });
  } finally {
    nachlaufLaeuft.delete(project);
    const letzte = nachlaufLetzte.get(project) ?? [];
    letzte.unshift(lauf);
    nachlaufLetzte.set(project, letzte.slice(0, 10));
    // Waehrend des Laufs angestossene commits: genau ein weiterer Lauf fuer alle.
    if ((nachlaufWartend.get(project)?.length ?? 0) > 0) planeNachlauf(project, 0);
  }
}

/** P16-T23: offene Nachlauf-Hinweise eines Agenten abholen - genau einmal (tool-antwort.ts, beide Transporte). */
export function holeBuildNachlaufHinweise(agent: string | null | undefined): BuildNachlaufHinweis[] {
  if (!agent) return [];
  const liste = nachlaufHinweise.get(agent);
  if (!liste || liste.length === 0) return [];
  nachlaufHinweise.delete(agent);
  nachlaufZaehler.hinweise_zugestellt += liste.length;
  return liste;
}

/** build_status: Nachlauf eines Projekts (nur bei Schalter EIN oder vorhandenem Stand; sonst Antwort unveraendert). */
async function nachlaufAnzeige(project: string): Promise<Record<string, unknown>> {
  const schalter = await buildNachlaufAktiv(project);
  const wartend = nachlaufWartend.get(project) ?? [];
  const laeuft = nachlaufLaeuft.get(project);
  const letzte = nachlaufLetzte.get(project) ?? [];
  const vorgemerkt = [...nachlaufVorgemerkt.values()].filter((v) => v.project === project);
  if (!schalter.aktiv && wartend.length === 0 && !laeuft && letzte.length === 0 && vorgemerkt.length === 0) return {};
  return {
    nachlauf: {
      schalter,
      vorgemerkt: vorgemerkt.map((v) => ({ plan_id: v.plan_id, agent: v.agent, vorgemerkt_am: v.vorgemerkt_am, aufruf: buildPruefenAufruf(project, v.plan_id) })),
      ...(laeuft ? { laeuft } : {}),
      wartend: wartend.map((a) => ({ plan_id: a.plan_id, agent: a.agent, angestossen_am: a.angestossen_am })),
      letzte,
      legende: 'Nachlauf (P16-T23): commit schreibt sofort und merkt den Plan nur vor (vorgemerkt); die projektweite Pruefung startet erst mit code_check(build_pruefen, plan_id) und laeuft gebuendelt. letzte = Laeufe (neueste zuerst) mit plaene und neuen Befunden samt plan_ids; Ergebnis je Plan als build_nachlauf in der naechsten Tool-Antwort des Committers.',
    },
  };
}

// ─── Zustand / Diagnose ─────────────────────────────────────────────────────────────────────────────────────────

function zustandVon(project: string): 'laeuft' | 'gruen' | 'rot' | 'teilweise' | 'abgebrochen' | 'unbekannt' {
  if ((projektLaeuft.get(project) ?? 0) > 0 || inArbeit.has(project) || fortschritt.has(project)
    || nachlaufLaeuft.has(project) || (nachlaufWartend.get(project)?.length ?? 0) > 0) return 'laeuft';
  const b = projektBasis.get(project);
  // E2: Go-/Python-Basis fliesst ein (schlechtester Stand); ohne sie wie in E1.
  const alle = [...(b ? [b] : []), ...(sprachBasis.get(project)?.values() ?? [])];
  // P16-T22: letzter Basislauf ohne Ergebnis (Container gestoppt/neu gestartet) und seitdem keine neuere Basis.
  const abbruch = letzterAbbruch.get(project);
  if (abbruch && alle.every((x) => x.geprueft_am < abbruch.zeit)) return 'abgebrochen';
  if (alle.length === 0) return 'unbekannt';
  if (alle.some((x) => x.status !== 'fertig')) return 'teilweise';
  return alle.every((x) => x.fehler === 0) ? 'gruen' : 'rot';
}

function warteschlangeAnzeige(project: string): Array<Record<string, unknown>> {
  return (warteschlangen.get(project) ?? []).map((e, i) => ({ position: i + 1, plan_id: e.plan_id, agent: e.agent, eingereiht_am: e.eingereiht_am }));
}

/** intern(status) -> quellen.build_pruefung */
export function buildPruefungZustand(): Record<string, unknown> {
  const projekte = new Set([...projektBasis.keys(), ...sprachBasis.keys(), ...warteschlangen.keys(), ...projektLaeuft.keys(), ...nachlaufLetzte.keys(), ...nachlaufWartend.keys()]);
  return {
    pruefer_verfuegbar: !!anbindung,
    laufend: laufend.size,
    cache: ergebnisCache.size,
    einstellungen_fehler: einstellungsCache?.fehler ?? null,
    typen: typenZustand(),
    projekte: Object.fromEntries([...projekte].map((p) => [p, { zustand: zustandVon(p), warteschlange: buildWarteschlangeLaenge(p) }])),
    // P16-T23: Debug des Nachlaufs (Zaehler, letzter Fehler, nicht abgeholte Hinweise).
    nachlauf: {
      zaehler: { ...nachlaufZaehler },
      letzter_fehler: nachlaufLetzterFehler,
      laufend: [...nachlaufLaeuft.keys()],
      vorgemerkt: nachlaufVorgemerkt.size,
      wartend: Object.fromEntries([...nachlaufWartend].map(([p, l]) => [p, l.length])),
      offene_hinweise: [...nachlaufHinweise.values()].reduce((n, l) => n + l.length, 0),
    },
  };
}

// ─── code_check-Actions ─────────────────────────────────────────────────────────────────────────────────────────

export const BUILD_ACTIONS = ['build_status', 'build_einstellungen', 'build_pruefen'] as const;

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
  sprachen: { type: 'array', items: { type: 'string', enum: ['kotlin', 'java', 'rust', 'go', 'python', 'c', 'cpp', 'dart', 'csharp', 'keine'] }, description: 'build_einstellungen setzen: Sprachen der projektweiten Pruefung neben TypeScript (kotlin, java, rust, go, python, c, cpp, dart, csharp; keine = nur TypeScript) - mit project fuer dieses Projekt, ohne global. Standard go+python (Env BUILD_PRUEFUNG_SPRACHEN). Dart/C# offline, fehlender SDK-/Paketkontext teilweise; F# nicht unterstützt.' },
  plan_id: { type: 'string', description: 'build_pruefen (P16-T23): geschriebener Plan, dessen Stand projektweit im Hintergrund geprueft wird (Aufruf steht fertig in der commit-Antwort); offener Plan -> erst committen' },
  nachlauf: { type: 'boolean', description: 'build_einstellungen setzen (P16-T23): commit schreibt sofort, die projektweite Pruefung laeuft danach gebuendelt im Hintergrund, Ergebnis als Hinweis build_nachlauf beim naechsten Tool-Aufruf (statt Warteschlange) - mit project fuer dieses Projekt, ohne global. Standard aus.' },
  nachlauf_buendel_s: { type: 'number', description: 'build_einstellungen setzen (P16-T23): Sammelzeit in s vor einem Nachlauf (0..120, global, Standard 3)' },
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
    `INSERT INTO build_pruefung_einstellungen (bereich, werte, gesetzt_von, grund, gesetzt_am, setter_identity_id)
     VALUES ($1, $2::jsonb, $3, $4, NOW(), $5)
     ON CONFLICT (bereich) DO UPDATE SET werte = build_pruefung_einstellungen.werte || EXCLUDED.werte,
       gesetzt_von = EXCLUDED.gesetzt_von, grund = EXCLUDED.grund, gesetzt_am = NOW(), setter_identity_id=EXCLUDED.setter_identity_id`,
    [bereich, JSON.stringify(werte), wer, grund ?? null, aktuelleAgentAkteurIdentityId(wer)],
  );
}

async function einstellungenAnzeige(project: string | undefined): Promise<Record<string, unknown>> {
  const z = await ladeEinstellungen(true);
  return {
    global: z.get('global') ?? null,
    ...(project ? { projekt: z.get('projekt:' + project) ?? null, schalter: await buildAktiv(project) } : {}),
    pruefcontainer: z.get('pruefcontainer') ?? null,
    budget: await wirksamesBuildBudget(),
    sprachen_wirksam: await sprachenAktiv(project),
    nachlauf: await buildNachlaufAktiv(project),
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
      const projekte = project ? [project] : [...new Set([...projektBasis.keys(), ...sprachBasis.keys(), ...warteschlangen.keys(), ...projektLaeuft.keys(), ...nachlaufLetzte.keys(), ...nachlaufWartend.keys()])].sort();
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
          // E2: nur wenn es eine Go-/Python-Basis gibt (sonst Antwort wie in E1).
          ...(sprachBasis.get(p)?.size ? { basis_sprachen: Object.fromEntries([...sprachBasis.get(p)!].map(([art, b]) => [SPRACHEN.find((s) => s.art === art)?.sprache ?? art, b])) } : {}),
          ...(fortschritt.has(p) ? { laeuft: fortschrittAnzeige(p) } : {}),
          ...(letzterAbbruch.has(p) ? { letzter_abbruch: letzterAbbruch.get(p) } : {}),
          warteschlange: warteschlangeAnzeige(p),
          letzte_commits: letzteCommits.get(p) ?? [],
          ...(await nachlaufAnzeige(p)),
        }))),
        ...(anbindung ? {} : { hinweis: KEIN_PRUEFER }),
        legende: 'zustand: gruen = Basis ohne Fehler, rot = Basis mit Fehlern (Tor sperrt nur NEUE), laeuft (Fortschritt in laeuft: Phase typen/wartet/laeuft mit Zeiten), teilweise (Zeitlimit/Speicher/fehlende Abhaengigkeiten), abgebrochen (letzter Basislauf ohne Ergebnis, z. B. Container gestoppt/neu gestartet - Grund in letzter_abbruch; erneut pruefen), unbekannt (noch nie geprueft: build_status mit pruefen:true). basis.laeufe: Dauer und hoechster RSS je Projekt/Schritt, basis.speicher: Container nach dem Lauf, basis.typen: Typen-Bestand aus dem Lockfile.',
        typen: typenZustand(),
      };
    }
    if (action === 'build_pruefen') {
      const planId = text(args.plan_id);
      if (!planId) return { success: false, error: 'ungueltig', message: 'build_pruefen braucht plan_id eines geschriebenen Plans (die commit-Antwort nennt den fertigen Aufruf).' };
      return await stosseBuildNachlaufAn(planId, agent);
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
      // P16-T23: Nachlauf-Schalter (Projekt/global) und Sammelzeit (global).
      const nachlauf = args.nachlauf === true || args.nachlauf === 'true' ? true : args.nachlauf === false || args.nachlauf === 'false' ? false : undefined;
      const buendelS = zahl(args.nachlauf_buendel_s, 'nachlauf_buendel_s', 0, 120, fehler);
      // E2: sprachen als Liste oder Komma-Text; 'keine' bzw. [] = nur TypeScript.
      let sprachen: string[] | undefined;
      if (args.sprachen !== undefined && args.sprachen !== null) {
        const roh = Array.isArray(args.sprachen) ? args.sprachen : String(args.sprachen).split(',');
        const liste = roh.map((x) => String(x).trim().toLowerCase()).filter((x) => x && x !== 'keine');
        const falsch = liste.filter((x) => !ALLE_SPRACHEN.includes(x));
        if (falsch.length > 0) fehler.push(`sprachen nur ${ALLE_SPRACHEN.join(' | ')} | keine (unbekannt: ${falsch.join(', ')})`);
        else sprachen = [...new Set(liste)];
      }
      const zurueck = text(args.zuruecksetzen);
      if (zurueck && !['projekt', 'global', 'budget'].includes(zurueck)) fehler.push('zuruecksetzen nur projekt | global | budget');
      if (zurueck === 'projekt' && !project) fehler.push('zuruecksetzen projekt braucht project');
      if (aktiv === undefined && sprachen === undefined && nachlauf === undefined && buendelS === undefined && Object.keys(budget).length === 0 && !zurueck) fehler.push('nichts zu setzen (aktiv, sprachen, nachlauf, nachlauf_buendel_s, speicher_mb, tmpfs_mb, heap_mb, zeitlimit_s oder zuruecksetzen)');
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
      if (sprachen !== undefined) {
        const bereich = project ? 'projekt:' + project : 'global';
        await zeileSchreiben(bereich, { sprachen }, agent, grund);
        geaendert.push(`${bereich}: sprachen ${sprachen.length > 0 ? sprachen.join(', ') : 'keine (nur TypeScript)'}`);
      }
      if (nachlauf !== undefined) {
        const bereich = project ? 'projekt:' + project : 'global';
        await zeileSchreiben(bereich, { nachlauf }, agent, grund);
        geaendert.push(`${bereich}: nachlauf ${nachlauf}`);
      }
      if (buendelS !== undefined) {
        await zeileSchreiben('global', { nachlauf_buendel_ms: buendelS * 1000 }, agent, grund);
        geaendert.push(`global: nachlauf_buendel_ms ${buendelS * 1000}`);
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
