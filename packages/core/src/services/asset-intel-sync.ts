/**
 * MODUL: Asset-Intel Sync (Indexierung im lokalen Watcher, P4-T67 Etappe D)
 * ZWECK: Haelt asset_files/asset_objects/asset_references mit der Platte synchron:
 *        Watcher-Ereignisse (add/change/unlink) und der Abgleich beim Start (Verify).
 *
 * WER RUFT: nur Prozesse, die die Datei auf der Platte sehen — der TS-Daemon
 * (file-watcher-daemon-ts/manager.ts), der MCP-Watcher-Daemon (handleFileEvent mit assets:true)
 * und init im lokalen MCP-Server. Der REST-Prozess inspiziert NIE (Entwurf 999610b9, 1.2).
 *
 * GRUNDSAETZE:
 *  - Schreibt NUR asset_* (ueber services/asset-intel-store.ts). Nie code_files, nie die Platte.
 *  - Inspektion im worker_thread (asset-intel/worker-runner.ts), hart abbrechbar.
 *  - Warteschlange mit Konkurrenz 1 (SYNAPSE_ASSET_KONKURRENZ, hoechstens 2): der Erstscan eines
 *    grossen Projekts darf den Rechner nicht fluten. Doppelte Ereignisse fuer denselben Pfad
 *    werden zusammengelegt, solange sie noch warten.
 *  - Fehlt die Tabelle (PG 42P01, Daemon neuer als das Schema der Datenbank): EINMAL loggen und
 *    den Asset-Weg bis zum Neustart abschalten. Der Code-Weg ist davon nie betroffen.
 *  - Dateien werden nie komplett gelesen, um sie zu klassifizieren: nur der Kopf (KOPF_BYTES).
 *    Den sha256 rechnet inspectAsset im Worker, und auch das nur bis maxHashBytes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { FileEvent } from '../types/index.js';
import { getPool } from '../db/client.js';
import { assetArt, isExtractableDocument, isMultimodalFile, leseDateiKopf } from '../watcher/binary.js';
import { loadGitignore, shouldIgnore, istGesperrt } from '../watcher/ignore.js';
import { standardRegistry } from '../asset-intel/index.js';
import type { AssetRegistry } from '../asset-intel/registry.js';
import { AssetInspektionsWorker } from '../asset-intel/worker-runner.js';
import {
  speichereAssetErgebnis,
  markiereAssetQuelleFehlt,
  entferneAssetsEndgueltig,
  normalisiereAssetPfad,
  ASSET_LOESCHFRIST_TAGE,
} from './asset-intel-store.js';

// ---------------------------------------------------------------------------
// Konfiguration, Zustand, Zaehler
// ---------------------------------------------------------------------------

/** Laufzeit-Einstellungen (Tests). Ohne Aufruf gelten Standard-Registry und Standardgrenzen. */
export interface AssetSyncKonfiguration {
  /** Modul mit Export `registry` (Pfad oder file:-URL); ersetzt die Standard-Registry im Worker UND im Verify. */
  registryModul?: string | null;
  /** Zeitgrenze je Inspektion in ms (Standard der Inspektion: 30 s). */
  timeoutMs?: number | null;
  /** Gnadenfrist bis zum harten Abbruch in ms (Standard 5000). */
  gnadenfristMs?: number | null;
  /** Gleichzeitige Inspektionen (1 oder 2). */
  konkurrenz?: number | null;
}

let konfig: AssetSyncKonfiguration = {};
let assetWegAus = false;

/** Zaehler seit Prozessstart bzw. setzeAssetSyncZaehlerZurueck(). */
export interface AssetSyncZaehler {
  /** Inspektionen, die einen Worker beansprucht haben. */
  inspektionen: number;
  /** Gespeicherte Ergebnisse. */
  gespeichert: number;
  /** Als 'quelle_nicht_gefunden' markierte Pfade. */
  quelle_fehlt: number;
  /** Hart abgebrochene Inspektionen (Worker beendet). */
  abgebrochen: number;
  /** Fehlgeschlagene Auftraege (ohne 42P01). */
  fehler: number;
}

const zaehler: AssetSyncZaehler = { inspektionen: 0, gespeichert: 0, quelle_fehlt: 0, abgebrochen: 0, fehler: 0 };

export function konfiguriereAssetSync(k: AssetSyncKonfiguration): void {
  konfig = { ...konfig, ...k };
}

export function assetSyncZaehler(): AssetSyncZaehler {
  return { ...zaehler };
}

export function setzeAssetSyncZaehlerZurueck(): void {
  zaehler.inspektionen = 0;
  zaehler.gespeichert = 0;
  zaehler.quelle_fehlt = 0;
  zaehler.abgebrochen = 0;
  zaehler.fehler = 0;
}

/** true, wenn der Asset-Weg wegen fehlender Tabelle (42P01) abgeschaltet ist. */
export function assetWegAbgeschaltet(): boolean {
  return assetWegAus;
}

/** Schaltet den Asset-Weg wieder ein (Tests; im Betrieb geschieht das durch den Neustart). */
export function setzeAssetWegZurueck(): void {
  assetWegAus = false;
}

function konkurrenz(): number {
  const roh = konfig.konkurrenz ?? Number(process.env.SYNAPSE_ASSET_KONKURRENZ);
  return Number.isInteger(roh) && roh >= 2 ? 2 : 1;
}

/**
 * Wertet einen DB-Fehler aus. 42P01 (Tabelle fehlt): EINMAL loggen, Asset-Weg aus, Warteschlange
 * leeren. Liefert true, wenn es dieser Fall war.
 */
function behandleDbFehler(e: unknown, wo: string): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === '42P01') {
    if (!assetWegAus) {
      assetWegAus = true;
      console.error(
        `[Asset-Intel] Tabelle fehlt (42P01) bei ${wo} — Asset-Weg bis zum Neustart abgeschaltet. ` +
          `Der Code-Index arbeitet unveraendert weiter. (${(e as Error).message})`
      );
      for (const job of warteschlange.splice(0)) {
        wartend.delete(job.schluessel);
        for (const fertig of job.erledigt) fertig();
      }
    }
    return true;
  }
  zaehler.fehler++;
  console.error(`[Asset-Intel] ${wo} fehlgeschlagen: ${(e as Error)?.message ?? String(e)}`);
  return false;
}

// ---------------------------------------------------------------------------
// Warteschlange
// ---------------------------------------------------------------------------

interface Job {
  schluessel: string;
  project: string;
  root: string;
  /** projekt-relativ, '/' als Trenner */
  rel: string;
  typ: FileEvent['type'];
  erledigt: Array<() => void>;
}

const warteschlange: Job[] = [];
const wartend = new Map<string, Job>();
const freieWorker: AssetInspektionsWorker[] = [];
const alleWorker = new Set<AssetInspektionsWorker>();
let aktiv = 0;
let leerlaufWartende: Array<() => void> = [];

function einreihen(project: string, root: string, rel: string, typ: FileEvent['type']): Promise<void> {
  if (assetWegAus) return Promise.resolve();
  const schluessel = `${project}\u0000${rel}`;
  return new Promise<void>((resolve) => {
    const vorhanden = wartend.get(schluessel);
    if (vorhanden) {
      // Noch nicht gestartet: das juengste Ereignis gilt (der Lauf prueft die Platte ohnehin selbst).
      vorhanden.typ = typ;
      vorhanden.root = root;
      vorhanden.erledigt.push(resolve);
      return;
    }
    const job: Job = { schluessel, project, root, rel, typ, erledigt: [resolve] };
    wartend.set(schluessel, job);
    warteschlange.push(job);
    pumpe();
  });
}

function pumpe(): void {
  while (aktiv < konkurrenz() && warteschlange.length > 0) {
    const job = warteschlange.shift()!;
    wartend.delete(job.schluessel);
    aktiv++;
    const worker = freieWorker.pop() ?? neuerWorker();
    void fuehreAus(job, worker)
      .catch((e) => {
        behandleDbFehler(e, `${job.typ} ${job.rel}`);
      })
      .finally(() => {
        aktiv--;
        freieWorker.push(worker);
        for (const fertig of job.erledigt) fertig();
        pumpe();
        if (aktiv === 0 && warteschlange.length === 0) {
          const w = leerlaufWartende;
          leerlaufWartende = [];
          for (const fertig of w) fertig();
        }
      });
  }
}

function neuerWorker(): AssetInspektionsWorker {
  const w = new AssetInspektionsWorker();
  alleWorker.add(w);
  return w;
}

/** Wartet, bis die Warteschlange leer ist und keine Inspektion mehr laeuft. */
export function warteAufAssetLeerlauf(): Promise<void> {
  if (aktiv === 0 && warteschlange.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => leerlaufWartende.push(resolve));
}

/** Beendet alle Worker-Threads (Prozessende, Tests). Wartende Auftraege werden verworfen. */
export async function beendeAssetSync(): Promise<void> {
  for (const job of warteschlange.splice(0)) {
    wartend.delete(job.schluessel);
    for (const fertig of job.erledigt) fertig();
  }
  const alle = [...alleWorker];
  alleWorker.clear();
  freieWorker.length = 0;
  await Promise.all(alle.map((w) => w.beende()));
}

// ---------------------------------------------------------------------------
// Ein Auftrag
// ---------------------------------------------------------------------------

function absolut(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

/**
 * Umbenennen ueber sha256: Bei einem Verschieben kommt das ADD (Debounce 300 ms) VOR dem UNLINK
 * (1500 ms). Der Store uebernimmt eine Zeile aber nur, wenn sie schon 'quelle_nicht_gefunden'
 * ist. Deshalb hier: Zeilen mit gleichem Hash, deren Datei es nicht mehr gibt, zuerst als fehlend
 * markieren — dann behaelt die Zeile beim Speichern ihre id und zieht an den neuen Pfad um.
 */
async function markiereVerschobeneZwillinge(project: string, root: string, rel: string, sha256: string): Promise<void> {
  const r = await getPool().query<{ file_path: string }>(
    `SELECT file_path FROM asset_files
      WHERE project = $1 AND sha256 = $2 AND file_path <> $3 AND status <> 'quelle_nicht_gefunden'
      LIMIT 20`,
    [project, sha256, rel]
  );
  for (const z of r.rows) {
    if (!fs.existsSync(absolut(root, z.file_path))) {
      await markiereAssetQuelleFehlt(project, z.file_path);
      zaehler.quelle_fehlt++;
    }
  }
}

async function fuehreAus(job: Job, worker: AssetInspektionsWorker): Promise<void> {
  if (assetWegAus) return;
  const abs = absolut(job.root, job.rel);
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(abs);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) {
    // Weg (UNLINK, oder ein ADD fuer eine Datei, die schon wieder fehlt). Die Zeile bleibt,
    // status 'quelle_nicht_gefunden'; eingehende Verweise werden 'fehlt' (beides in EINER
    // Anweisung des Stores, der damit auch aktualisiereVerweisZiel(..., false) abdeckt).
    await markiereAssetQuelleFehlt(job.project, job.rel);
    zaehler.quelle_fehlt++;
    return;
  }
  // Die Datei existiert — auch bei einem UNLINK, wenn sie inzwischen wieder angelegt wurde.
  zaehler.inspektionen++;
  const vorher = worker.abgebrochen;
  const ergebnis = await worker.inspiziere(abs, {
    ...(konfig.timeoutMs ? { timeoutMs: konfig.timeoutMs } : {}),
    ...(konfig.gnadenfristMs !== undefined && konfig.gnadenfristMs !== null ? { gnadenfristMs: konfig.gnadenfristMs } : {}),
    ...(konfig.registryModul ? { registryModul: konfig.registryModul } : {}),
  });
  if (worker.abgebrochen > vorher) zaehler.abgebrochen++;
  if (assetWegAus) return;
  if (ergebnis.status === 'quelle_nicht_gefunden') {
    await markiereAssetQuelleFehlt(job.project, job.rel);
    zaehler.quelle_fehlt++;
    return;
  }
  if (ergebnis.sha256) await markiereVerschobeneZwillinge(job.project, job.root, job.rel, ergebnis.sha256);
  await speichereAssetErgebnis(job.project, job.rel, ergebnis, { projektRoot: job.root, mtime: st.mtime });
  zaehler.gespeichert++;
}

// ---------------------------------------------------------------------------
// Oeffentliche Einstiege
// ---------------------------------------------------------------------------

/**
 * Nimmt ein Watcher-Ereignis fuer ein Asset an (event.asset gesetzt) und reiht es ein. Ereignisse
 * ohne asset werden ignoriert. Das Promise erfuellt sich, wenn der Auftrag erledigt ist; es wird
 * nie verworfen. Aufrufer im Watcher warten NICHT darauf (der Code-Weg darf nicht haengen).
 */
export function verarbeiteAssetEreignis(event: FileEvent, projectRoot: string): Promise<void> {
  // WIRFT NIE, auch nicht synchron: die Aufrufer (handleFileEvent, manager.forwardEvent) rufen
  // ohne await VOR dem Code-Weg derselben Datei auf. Eine Ausnahme hier (z. B. normalisiereAssetPfad
  // bei '../x' ueber einen Symlink, absolutem Pfad ausserhalb, 'C:/x') wuerde sonst den Code-Weg
  // abbrechen. Der Asset-Weg darf den Code-Weg nie stoeren.
  try {
    if (!event?.asset || assetWegAus) return Promise.resolve();
    let rel = event.path;
    if (path.isAbsolute(rel)) rel = path.relative(projectRoot, rel);
    return einreihen(event.project, projectRoot, normalisiereAssetPfad(rel), event.type).catch((e) => {
      meldeEreignisFehler(event, e);
    });
  } catch (e) {
    meldeEreignisFehler(event, e);
    return Promise.resolve();
  }
}

let ereignisFehlerGemeldet = false;

/** Zaehlt einen abgelehnten Asset-Auftrag; geloggt wird nur der erste (kein Flooden je Ereignis). */
function meldeEreignisFehler(event: FileEvent, e: unknown): void {
  zaehler.fehler++;
  if (ereignisFehlerGemeldet) return;
  ereignisFehlerGemeldet = true;
  console.error(
    `[Asset-Intel] Ereignis ${event?.type} ${String(event?.path)} nicht angenommen: ${(e as Error)?.message ?? String(e)} ` +
      `\u2014 Code-Weg unberuehrt. Weitere Faelle werden nur gezaehlt (assetSyncZaehler().fehler).`
  );
}

/** Ergebnis von verifyAssetsAgainstFilesystem. */
export interface AssetVerifyErgebnis {
  /** Asset-Kandidaten auf der Platte. */
  kandidaten: number;
  /** Ohne Eintrag (oder Eintrag mit fehlender Quelle) -> inspiziert. */
  neu: number;
  /** Groesse oder mtime weichen ab -> inspiziert. */
  geaendert: number;
  /** Inspektor neuer als der Eintrag, oder erstmals ein Inspektor zustaendig -> inspiziert. */
  nachgezogen: number;
  /** Unveraendert -> NICHT inspiziert. */
  unveraendert: number;
  /** Eintrag neuer als der Inspektor dieses Prozesses (aelterer Daemon) -> nicht angefasst. */
  aelter_als_eintrag: number;
  /** Eintraege, deren Datei fehlt -> quelle_nicht_gefunden. */
  fehlt: number;
  /** Eintraege, deren Datei noch da, aber kein Asset mehr ist (ignoriert, Typ gewechselt) -> entfernt. */
  entfernt: number;
  /** Endgueltig entfernt nach Ablauf der Frist (quelle_nicht_gefunden aelter als 30 Tage). */
  aufgeraeumt: number;
  dauer_ms: number;
  /** Gesetzt, wenn der Asset-Weg abgeschaltet ist (42P01). */
  abgeschaltet?: true;
}

interface Kandidat {
  size: number;
  /** stat.mtime in ms — derselbe Wert, den der Store speichert (Node rundet mtimeMs dafuer). */
  mtime: number;
}

/** Eigener Walk NUR fuer Asset-Kandidaten. Liest je Datei hoechstens den Kopf. */
function sammleAssetKandidaten(root: string, project: string): Map<string, Kandidat> {
  const ig = loadGitignore(root, project);
  const kandidaten = new Map<string, Kandidat>();
  const walk = (dir: string): void => {
    let eintraege: fs.Dirent[];
    try {
      eintraege = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of eintraege) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (shouldIgnore(ig, rel)) continue;
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        if (istGesperrt(rel, root, project)) continue;
        if (isExtractableDocument(abs)) continue;
        // Media braucht keinen Kopf; alles andere: nur KOPF_BYTES lesen.
        const art = isMultimodalFile(abs) ? 'zusaetzlich' : assetArt(abs, leseDateiKopf(abs));
        if (!art) continue;
        const st = fs.statSync(abs);
        kandidaten.set(normalisiereAssetPfad(rel), { size: st.size, mtime: st.mtime.getTime() });
      } catch {
        /* unzugaenglich */
      }
    }
  };
  walk(root);
  return kandidaten;
}

async function verifyRegistry(): Promise<AssetRegistry> {
  if (!konfig.registryModul) return standardRegistry;
  const m = await import(konfig.registryModul.startsWith('file:') ? konfig.registryModul : pathToFileURL(konfig.registryModul).href);
  return (m.registry ?? m.default) as AssetRegistry;
}

let rueckschrittGemeldet = false;

/**
 * Gleicht asset_files mit der Platte ab (Start des Watchers, init). Inspiziert NUR, was neu,
 * veraendert (Groesse/mtime) oder mit einem neueren Inspektor nachzuziehen ist; unveraenderte
 * Dateien werden nicht angefasst. Fehlende Quellen -> quelle_nicht_gefunden; Eintraege, die
 * laenger als 30 Tage fehlen, werden endgueltig entfernt.
 */
export async function verifyAssetsAgainstFilesystem(project: string, projectRoot: string): Promise<AssetVerifyErgebnis> {
  const start = Date.now();
  const erg: AssetVerifyErgebnis = {
    kandidaten: 0, neu: 0, geaendert: 0, nachgezogen: 0, unveraendert: 0, aelter_als_eintrag: 0,
    fehlt: 0, entfernt: 0, aufgeraeumt: 0, dauer_ms: 0,
  };
  const fertig = (): AssetVerifyErgebnis => {
    erg.dauer_ms = Date.now() - start;
    if (assetWegAus) erg.abgeschaltet = true;
    return erg;
  };
  if (assetWegAus) return fertig();

  try {
    const registry = await verifyRegistry();
    const kandidaten = sammleAssetKandidaten(projectRoot, project);
    erg.kandidaten = kandidaten.size;

    const zeilen = await getPool().query<{
      file_path: string; file_size: string; mtime: Date | null; status: string; inspector: string | null; parser_version: number;
    }>(
      `SELECT file_path, file_size, mtime, status, inspector, parser_version FROM asset_files WHERE project = $1`,
      [project]
    );
    const bestand = new Map(zeilen.rows.map((z) => [z.file_path, z]));

    // 1. Fehlende Quellen ZUERST markieren: dann greift beim Speichern der neuen Pfade die
    //    Umbenennung per sha256 im Store (die Zeile behaelt ihre id).
    const entfernen: string[] = [];
    for (const z of zeilen.rows) {
      if (kandidaten.has(z.file_path) || z.status === 'quelle_nicht_gefunden') continue;
      if (fs.existsSync(absolut(projectRoot, z.file_path))) {
        entfernen.push(z.file_path);
      } else {
        await markiereAssetQuelleFehlt(project, z.file_path);
        zaehler.quelle_fehlt++;
        erg.fehlt++;
      }
    }
    if (entfernen.length > 0) erg.entfernt = await entferneAssetsEndgueltig(project, { pfade: entfernen });

    // 2. Kandidaten: nur Abweichungen inspizieren.
    const auftraege: Promise<void>[] = [];
    for (const [rel, k] of kandidaten) {
      const z = bestand.get(rel);
      let grund: 'neu' | 'geaendert' | 'nachgezogen' | null = null;
      if (!z || z.status === 'quelle_nicht_gefunden') {
        grund = 'neu';
      } else if (Number(z.file_size) !== k.size || z.mtime === null || new Date(z.mtime).getTime() !== k.mtime) {
        grund = 'geaendert';
      } else if (z.inspector) {
        const insp = registry.get(z.inspector);
        if (insp && insp.version > z.parser_version) {
          grund = 'nachgezogen';
        } else if (insp && insp.version < z.parser_version) {
          // Ein aelterer Daemon-Stand inspiziert nie ueber einen neueren Eintrag.
          erg.aelter_als_eintrag++;
          if (!rueckschrittGemeldet) {
            rueckschrittGemeldet = true;
            console.error(
              `[Asset-Intel] ${rel}: Eintrag von Inspektor ${z.inspector} v${z.parser_version}, dieser Prozess kennt nur v${insp.version} ` +
                `— nicht ueberschrieben (aelterer Stand). Weitere Faelle werden nur gezaehlt.`
            );
          }
        }
      } else {
        // Bisher kein Inspektor zustaendig: ist inzwischen einer da?
        try {
          const abs = absolut(projectRoot, rel);
          if (registry.detect(abs, leseDateiKopf(abs)).inspector) grund = 'nachgezogen';
        } catch {
          /* unlesbar: bleibt wie es ist */
        }
      }
      if (!grund) {
        erg.unveraendert++;
        continue;
      }
      erg[grund]++;
      auftraege.push(einreihen(project, projectRoot, rel, 'change'));
    }
    await Promise.all(auftraege);

    // 3. Frist abgelaufen -> endgueltig entfernen.
    if (!assetWegAus) erg.aufgeraeumt = await entferneAssetsEndgueltig(project, { aelterAlsTage: ASSET_LOESCHFRIST_TAGE });
  } catch (e) {
    if (!behandleDbFehler(e, `Asset-Abgleich ${project}`)) throw e;
  }

  console.error(
    `[Asset-Intel] Abgleich "${project}": ${erg.kandidaten} Kandidaten, ${erg.neu} neu, ${erg.geaendert} geaendert, ` +
      `${erg.nachgezogen} nachgezogen, ${erg.unveraendert} unveraendert, ${erg.fehlt} fehlen, ${erg.entfernt} entfernt, ` +
      `${erg.aufgeraeumt} aufgeraeumt` + (assetWegAus ? ' (Asset-Weg abgeschaltet)' : '')
  );
  return fertig();
}
