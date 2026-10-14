/**
 * MODUL: FileWatcher
 * ZWECK: Echtzeit-Ueberwachung von Projektdateien — erkennt Aenderungen und loest Indexierung aus
 *
 * INPUT:
 *   - projectPath: string - Absoluter Pfad zum Projektverzeichnis
 *   - projectName: string - Projekt-Identifikator fuer Metadaten
 *   - onFileChange: (FileEvent) => void - Callback bei add/change/unlink
 *   - onError?: (Error) => void - Callback bei Watcher-Fehlern
 *   - onIgnoreChange?: (string[]) => void - Callback wenn .synapseignore sich aendert
 *
 * OUTPUT:
 *   - FileWatcherInstance: { stop(), projectName, projectPath }
 *
 * NEBENEFFEKTE:
 *   - Filesystem: Liest .gitignore und .synapseignore live
 *   - Chokidar: Oeffnet inotify/FSEvents-Handle auf projectPath
 *   - Debounce: Batched schnelle Aenderungen (300ms Fenster)
 *
 * ABHAENGIGKEITEN:
 *   - ./ignore.js (intern) - Gitignore- und Synapseignore-Filterung
 *   - ./binary.js (intern) - Binaer/Multimodal/Dokument-Klassifizierung
 *   - chokidar (npm) - Cross-Platform Filesystem-Watcher
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import chokidar, { FSWatcher } from 'chokidar';
import { Ignore } from 'ignore';
import { FileEvent } from '../types/index.js';
import { getConfig } from '../config.js';
import { loadGitignore, istGesperrt, shouldIgnore, aktualisiereIgnoreRegeln } from './ignore.js';
import { isBinaryFile, isExtractableDocument, isMultimodalFile, getFileType, MAX_MEDIA_SIZE_MB, assetArt, leseDateiKopf } from './binary.js';
import { workerPausiert } from '../services/worker-steuerung.js';
import { liegtImProjekt } from '../services/projekt-pfad.js';
import { SkipMeldungen } from './skip-meldung.js';
// P9-T27: PG-Zugriffe des Watchers hinter einem austauschbaren Datenweg (Vorgabe PG, Daemon-API-Weg: API)
import { pgWatcherDatenweg, type WatcherDatenweg } from './datenweg.js';
export { pgWatcherDatenweg } from './datenweg.js';
export type { WatcherDatenweg, PgFsZeile, PgFsLoeschZeile, PgFsSeiten } from './datenweg.js';

export * from './binary.js';
export * from './ignore.js';

export interface FileWatcherOptions {
  /** Projekt-Pfad zum Ueberwachen */
  projectPath: string;
  /** Projekt-Name fuer Metadaten */
  projectName: string;
  /** Callback bei Dateiaenderung */
  onFileChange: (event: FileEvent) => void | Promise<void>;
  /** Callback bei Fehler */
  onError?: (error: Error) => void;
  /** Callback wenn .synapseignore geaendert wird - erhaelt neue Ignore-Patterns */
  onIgnoreChange?: (newPatterns: string[]) => void | Promise<void>;
  /** Callback nach Initial-Scan (Reconciliation gegen PG) */
  onReady?: () => void | Promise<void>;
  /**
   * P9-T27: Weg fuer alle PG-Zugriffe des Watchers (watcher_events, Rename-Pruefung, PG->Platte).
   * Ohne Angabe: pgWatcherDatenweg (bisheriges Verhalten). Der Daemon ohne DATABASE_URL uebergibt
   * einen API-Datenweg.
   */
  datenweg?: WatcherDatenweg;
}

export interface FileWatcherInstance {
  /** Stoppt den Watcher */
  stop: () => Promise<void>;
  /** Gibt den Projekt-Namen zurueck */
  projectName: string;
  /** Gibt den Projekt-Pfad zurueck */
  projectPath: string;
}

/**
 * Startet einen FileWatcher fuer ein Projekt
 */
export function startFileWatcher(options: FileWatcherOptions): FileWatcherInstance {
  const { projectPath, projectName, onFileChange, onError, onIgnoreChange, onReady } = options;
  const datenweg: WatcherDatenweg = options.datenweg ?? pgWatcherDatenweg;
  const config = getConfig();

  console.error(`[Synapse] Starte FileWatcher fuer "${projectName}" in ${projectPath}`);

  // Gitignore laden (mutable - wird bei .synapseignore Aenderung neu geladen)
  let ig: Ignore = loadGitignore(projectPath, projectName);
  // Zwei getrennte Mengen, und das ist der Kern der Sache:
  //   ig          entscheidet ueber die SICHTBARKEIT (Suche, Baum, Embeddings)
  //   istGesperrt(...)  entscheidet ueber die EXISTENZ (Weg zwischen Platte und DB)
  // Beides in einer Instanz zu fuehren war der Fehler, der ausgeblendete Dateien
  // nie auf der Platte ankommen liess.
  //
  // Die Sperre wird BEI JEDEM EREIGNIS frisch erfragt statt in einer Variablen
  // gehalten: eine gehaltene Ignore-Instanz ist ein Schnappschuss vom Start, und
  // eine danach angelegte Sperre wirkte dadurch erst nach einem Neustart. Genau
  // das ist am 28.07. im Test aufgefallen — die Datei landete trotz Sperre in
  // der Datenbank.

  // IGN-3: Die Regeln aus der Datenbank stehen erst nach einer Abfrage bereit.
  // Bis dahin gilt der Notnagel (.synapseignore vom Dateisystem); sobald die
  // Regeln geladen sind, wird die Instanz ersetzt. Bewusst nicht abgewartet,
  // damit der Start des Watchers nicht an der Datenbank haengt.
  void aktualisiereIgnoreRegeln(projectName).then((anzahl) => {
    if (anzahl > 0) {
      ig = loadGitignore(projectPath, projectName);

      console.error(`[Synapse] ${anzahl} Ignore-Regeln aus der Datenbank uebernommen ("${projectName}")`);
    }
  });

  // Pfade zu ignore Dateien
  const synapseignorePath = path.join(projectPath, '.synapseignore');
  const gitignorePath = path.join(projectPath, '.gitignore');

  // Debounce Map fuer Batch-Updates
  const pendingEvents = new Map<string, { type: FileEvent['type']; timeout: NodeJS.Timeout }>();
  // Pfade, die in diesem Lauf als Asset weitergeleitet wurden. Beim UNLINK ist die Datei weg und
  // laesst sich nicht mehr pruefen; ohne Endung (nur Magic) waere sie sonst nicht wiederzuerkennen.
  const bekannteAssets = new Set<string>();

  /**
   * Liest neue Patterns aus .synapseignore
   */
  function readSynapseignorePatterns(): string[] {
    try {
      if (fs.existsSync(synapseignorePath)) {
        const content = fs.readFileSync(synapseignorePath, 'utf-8');
        return content.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
      }
    } catch {
      // Ignore
    }
    return [];
  }

  /**
   * Verarbeitet ein Datei-Event mit Debounce
   */
  function handleEvent(type: FileEvent['type'], filePath: string): void {
    // Relativen Pfad berechnen
    const relativePath = path.relative(projectPath, filePath);

    // Pruefen ob .synapseignore oder .gitignore geaendert wurde
    if (filePath === synapseignorePath || filePath === gitignorePath) {
      console.error(`[Synapse] Ignore-Datei geaendert: ${relativePath}`);

      // Ignore-Patterns neu laden
      ig = loadGitignore(projectPath, projectName);
      // Die Sperre braucht hier nichts: istGesperrt() erneuert sich selbst,
      // sobald sich die Regelliste aendert.

      // Callback aufrufen mit neuen Patterns
      if (onIgnoreChange) {
        const patterns = readSynapseignorePatterns();
        Promise.resolve(onIgnoreChange(patterns)).catch(error => {
          console.error(`[Synapse] Fehler bei onIgnoreChange:`, error);
        });
      }
      return;
    }

    // Ignorierte Dateien ueberspringen
    // NUR gesperrte Pfade ueberspringen. Ausgeblendete Dateien werden ganz normal
    // eingelesen und landen in der Datenbank — sie sind lediglich in der Suche
    // unsichtbar. Wer hier auf ig statt auf die Sperre prueft, macht aus "nicht
    // anzeigen" ein "nicht speichern", und das faellt niemandem auf.
    if (istGesperrt(relativePath, projectPath, projectName)) {
      return;
    }

    // Binaere Dateien ueberspringen (nur bei add/change)
    // AUSNAHME: Extrahierbare Dokumente (PDF, Word, Excel) werden durchgelassen
    // AUSNAHME: Multimodal-Dateien (Bilder, Videos) werden bei Google-Provider durchgelassen
    // ASSET-WEG (P4-T67, Etappe D): `asset` wird NUR fuer Assets gesetzt. Fuer alle anderen
    // Dateien bleibt das Ereignis exakt wie vorher. 'nur_asset' erreicht den Code-Weg nie
    // (die Konsumenten pruefen das Feld) — genau wie frueher, als Binaerdateien hier endeten.
    let asset: FileEvent['asset'];
    if (type !== 'unlink') {
      try {
        const isDocument = isExtractableDocument(filePath);
        const isMedia = isMultimodalFile(filePath);
        let kopf: Buffer | undefined;

        if (!isDocument && !isMedia) {
          // Nur den Kopf lesen. Frueher: readFileSync der GANZEN Datei fuer 512 Byte — bei
          // GB-Assets teuer. isBinaryFile prueft ohnehin nur die ersten 512 Byte: gleiches Urteil.
          kopf = leseDateiKopf(filePath);
          if (isBinaryFile(filePath, kopf)) {
            // Frueher: verworfen. Jetzt: nur in den Asset-Weg.
            if (assetArt(filePath, kopf) !== 'nur_asset') {
              return;
            }
            asset = 'nur_asset';
          }
        }

        if (!asset) {
          // Dateigroesse pruefen (Dokumente: 50MB, Media: 20MB, Code: config)
          const stats = fs.statSync(filePath);
          const sizeMB = stats.size / (1024 * 1024);
          const maxSize = isDocument ? 50 : isMedia ? MAX_MEDIA_SIZE_MB : config.files.maxSizeMB;
          // Fuer reine Text-/Code-Dateien bedeutet maxSize <= 0: unbegrenzt.
          // Dokumente und Medien liefern weiterhin positive feste Limits.
          if (maxSize > 0 && sizeMB > maxSize) {
            console.error(`[Synapse] Datei zu gross (${sizeMB.toFixed(2)}MB > ${maxSize}MB): ${relativePath}`);
            // Fuer den bisherigen Weg bleibt die Datei verworfen. Ein Asset (z. B. eine grosse
            // PNG) geht trotzdem in den Asset-Weg; dessen Grenzen setzt inspectAsset selbst.
            if (!assetArt(filePath, kopf)) {
              return;
            }
            asset = 'nur_asset';
          } else {
            asset = assetArt(filePath, kopf) ?? undefined;
          }
        }
      } catch {
        // Datei nicht mehr vorhanden - ignorieren
        return;
      }
      if (asset) bekannteAssets.add(relativePath);
    } else {
      // Die Datei ist weg: nur Endung oder "in diesem Lauf als Asset gesehen" entscheiden.
      asset = assetArt(filePath) ?? (bekannteAssets.has(relativePath) ? 'nur_asset' : undefined);
      bekannteAssets.delete(relativePath);
    }

    // Existierendes Pending-Event abbrechen — relativePath als Key
    const existing = pendingEvents.get(relativePath);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    // Unlinks bekommen laengeren Debounce, damit ADD-Events eines Moves
    // zuerst verarbeitet werden koennen (Live-Rename-Detection greift dann).
    const debounceMs = type === 'unlink' ? 1500 : config.files.debounceMs;

    // Neues Debounced Event erstellen
    const timeout = setTimeout(async () => {
      pendingEvents.delete(relativePath);

      // Bei Unlink: pruefen ob die PG-Row bereits von einem Rename umgebogen wurde
      if (type === 'unlink') {
        try {
          if (!(await datenweg.codeZeileVorhanden(projectName, relativePath))) {
            if (!asset) {
              console.error(`[Synapse] UNLINK uebersprungen (Rename-detected): ${relativePath}`);
              return;
            }
            // Asset ohne Code-Zeile (Binaerdatei, Media): der Code-Weg bleibt wie bisher
            // uebersprungen, nur der Asset-Weg erfaehrt vom Loeschen.
            asset = 'nur_asset';
          }
        } catch {
          // PG nicht erreichbar — fail-open, normaler Unlink-Flow
        }
      }

      const event: FileEvent = {
        type,
        path: relativePath,
        project: projectName,
      };
      if (asset) event.asset = asset;

      console.error(`[Synapse] ${type.toUpperCase()}: ${relativePath}`);

      Promise.resolve(onFileChange(event)).catch(error => {
        console.error(`[Synapse] Fehler bei Event-Verarbeitung:`, error);
        onError?.(error);
      });
    }, debounceMs);

    pendingEvents.set(relativePath, { type, timeout });
  }

  // ═══ Event-Logging in PostgreSQL (watcher_events) ═══
  // Standard: ADD/CHANGE/UNLINK/ADDDIR/UNLINKDIR werden IMMER geloggt (leichtgewichtig).
  // Verbose-Modus (IGNORE/ALLOW/RAW) nur per SYNAPSE_WATCHER_DEBUG=1 oder
  // Datei .synapse/watcher-debug.enabled — diese Events sind pro Projekt-Scan tausendfach.
  const verboseEnabled = process.env.SYNAPSE_WATCHER_DEBUG === '1'
    || fs.existsSync(path.join(projectPath, '.synapse', 'watcher-debug.enabled'));
  if (verboseEnabled) {
    console.error(`[Synapse] FileWatcher verbose-log AKTIV (IGNORE/ALLOW/RAW)`);
  }

  // P9-T27: watcher_events ueber den Datenweg (PG wie bisher; im Daemon-API-Weg gebuendelt ueber die API).
  // TTL-Cleanup: Events aelter als 7 Tage loeschen (einmal beim Start)
  void datenweg.ereignisseAufraeumen(projectName).catch(() => {});

  function debugLog(kind: string, rel: string, details?: unknown): void {
    // Verbose-Events nur bei aktivem Flag
    if (!verboseEnabled && (kind === 'IGNORE' || kind === 'ALLOW' || kind.startsWith('RAW:'))) return;
    datenweg.ereignisProtokollieren(projectName, kind, rel, details);
  }

  /**
   * Liest Filesystem-Metadaten + Content-Hash fuer Event-Log.
   * Limits: nur bis 10MB, Binaer-Dateien nur stat (kein Hash).
   */
  function captureFileMeta(absPath: string): Record<string, unknown> | undefined {
    try {
      const stat = fs.statSync(absPath);
      const meta: Record<string, unknown> = {
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        ino: stat.ino,
        mode: stat.mode,
        is_dir: stat.isDirectory(),
        is_symlink: stat.isSymbolicLink(),
      };
      if (!stat.isDirectory() && stat.size > 0 && stat.size <= 10 * 1024 * 1024) {
        try {
          const buf = fs.readFileSync(absPath);
          meta.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        } catch { /* Hash optional */ }
      }
      return meta;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  // Cache: letzte bekannte inode+hash pro relPath, damit UNLINK-Events
  // diese Meta trotz weggenommener Datei mitloggen koennen (fuer Move-Detection).
  const lastKnownMeta = new Map<string, Record<string, unknown>>();

  // Chokidar Watcher erstellen
  const watcher: FSWatcher = chokidar.watch(projectPath, {
    ignored: (filePath: string) => {
      const relativePath = path.relative(projectPath, filePath);
      const ignored = relativePath === 'pnpm-lock.yaml'
        ? istGesperrt(relativePath, projectPath, projectName) : shouldIgnore(ig, relativePath);
      if (verboseEnabled && relativePath) {
        debugLog(ignored ? 'IGNORE' : 'ALLOW', relativePath);
      }
      return ignored;
    },
    persistent: true,
    ignoreInitial: false, // Initial Scan durchfuehren
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  // Event Handler registrieren
  watcher.on('add', (filePath) => {
    const rel = path.relative(projectPath, filePath);
    const meta = captureFileMeta(filePath);
    if (meta && !meta.error) lastKnownMeta.set(rel, meta);
    debugLog('ADD', rel, meta);
    handleEvent('add', filePath);
  });
  watcher.on('change', (filePath) => {
    const rel = path.relative(projectPath, filePath);
    const meta = captureFileMeta(filePath);
    if (meta && !meta.error) lastKnownMeta.set(rel, meta);
    debugLog('CHANGE', rel, meta);
    handleEvent('change', filePath);
  });
  watcher.on('unlink', (filePath) => {
    const rel = path.relative(projectPath, filePath);
    // UNLINK: Datei ist weg — nutze letzte bekannte inode+hash aus Cache
    const lastMeta = lastKnownMeta.get(rel);
    lastKnownMeta.delete(rel);
    debugLog('UNLINK', rel, lastMeta);
    handleEvent('unlink', filePath);
  });
  watcher.on('addDir', (dirPath) => {
    debugLog('ADDDIR', path.relative(projectPath, dirPath), captureFileMeta(dirPath));
  });
  watcher.on('unlinkDir', (dirPath) => {
    debugLog('UNLINKDIR', path.relative(projectPath, dirPath));
  });
  watcher.on('raw', (event: string, rawPath: string, details: unknown) => {
    debugLog('RAW:' + event, rawPath, details);
  });

  watcher.on('error', (error) => {
    console.error(`[Synapse] FileWatcher Fehler:`, error);
    onError?.(error);
  });

  watcher.on('ready', () => {
    console.error(`[Synapse] FileWatcher bereit fuer "${projectName}"`);
    // Ab hier ist jedes 'add' ein Laufzeit-Ereignis und kein Erstscan mehr.
    // Dynamischer Import, weil services/code.ts seinerseits watcher/binary.js
    // laedt — statisch waere das ein Zyklus.
    void import('../services/code.js')
      .then(m => m.markiereScanAbgeschlossen(projectName))
      .catch(err => console.error(`[Synapse] Erstscan-Markierung fehlgeschlagen:`, err));
    if (onReady) {
      Promise.resolve(onReady()).catch(error => {
        console.error(`[Synapse] Fehler in onReady:`, error);
      });
    }
  });

  // ═══ PG-Watcher: Externe Aenderungen aus PostgreSQL auf Festplatte synchen ═══
  // Der Startbestand kommt seitenweise ueber den Vollabgleich; Delta beginnt jetzt.
  let lastPgCheck = new Date().toISOString();
  // updated_at ist der Transaktionsbeginn, NICHT die Sichtbarkeits-/Commit-Reihenfolge.
  // Ueberlappung faengt spaete Commits zeitnah ab; der Vollabgleich auch beliebig alte.
  const positiveMs = (name: string, fallback: number): number => {
    const wert = Number(process.env[name]);
    return Number.isFinite(wert) && wert > 0 ? wert : fallback;
  };
  const pgOverlapMs = positiveMs('SYNAPSE_PGFS_OVERLAP_MS', 120_000);
  const pgFullReconcileMs = positiveMs('SYNAPSE_PGFS_FULL_RECONCILE_MS', 300_000);
  const pgFullBatchFiles = Math.max(1, Math.floor(positiveMs('SYNAPSE_PGFS_FULL_BATCH_FILES', 500)));
  let letzterVollabgleich: number | null = null;
  let vollabgleichStand: { begann: number; changedAfter: string | null; deletedAfter: string | null; dateien: number; nachgeholt: number } | null = null;
  let pgPollInterval: NodeJS.Timeout | null = null;
  let pgPollBusy = false;  // Re-Entrancy-Guard: verhindert Ueberlappen langsamer Polls (OOM-Schutz)
  // P15 Logpflege (929b5b10): jede Skip-Zeile je Datei und Grund nur EINMAL, erneut erst nach einer
  // Aenderung des Stands (PG-Inhalt bzw. Plattenstand). Vorher: eine Zeile je Runde (alle 2 s).
  const skipMeldungen = new SkipMeldungen();

  // Kann der Watcher diesen Pfad von der Platte einsammeln? Nur dann lohnt es, eine Zeile mit fremdem
  // Plattenstand zurueckzustellen ("der naechste Tick sammelt es ein"). NICHT einsammelbar - und so bleibt
  // es (User-Entscheidung 11.10.2026, Watcher wird nicht umgebaut): chokidar sieht ausgeblendete und
  // .gitignore-Pfade nicht (ignored = shouldIgnore, auch fuer jedes Elternverzeichnis), die Ignore-Dateien
  // im Projektwurzel loesen nur einen Regel-Reload aus, Binaerdateien ohne Dokument/Medium werden verworfen.
  function watcherSammeltEin(relativePath: string, filePath: string): boolean {
    if (filePath === gitignorePath || filePath === synapseignorePath) return false;
    const teile = relativePath.split(/[\\/]/);
    for (let i = 1; i <= teile.length; i++) {
      if (shouldIgnore(ig, teile.slice(0, i).join('/'))) return false;
    }
    try {
      if (isExtractableDocument(filePath) || isMultimodalFile(filePath)) return true;
      return !isBinaryFile(filePath, leseDateiKopf(filePath));
    } catch {
      return false;
    }
  }

  // Start PG-Watcher (async setup, doesn't block return)
  (async () => {
    try {
      const crypto = await import('crypto');

      pgPollInterval = setInterval(async () => {
        if (pgPollBusy) return;  // vorheriger Poll laeuft noch → diesen Tick ueberspringen
        // P15-T12: Worker sync_pg_fs pausiert (intern, prozess daemon) -> Tick auslassen; lastPgCheck
        // bleibt stehen, nach der Pause holt der naechste Tick alles nach.
        if (workerPausiert('sync_pg_fs')) return;
        pgPollBusy = true;
        const pollBeginn = Date.now();
        if (!vollabgleichStand && (letzterVollabgleich === null || pollBeginn - letzterVollabgleich >= pgFullReconcileMs)) {
          vollabgleichStand = { begann: pollBeginn, changedAfter: '', deletedAfter: '', dateien: 0, nachgeholt: 0 };
        }
        const vollabgleich = vollabgleichStand;
        let nachgeholteDateien = 0;
        const checkpointVorher = lastPgCheck;
        const untergrenze = new Date(Math.max(0, Date.parse(lastPgCheck) - pgOverlapMs)).toISOString();
        try {
          // 1. Changed/new files: Kandidaten OHNE content laden — nur den Hash.
          //    Der grosse content (inkl. Multi-MB-PDFs/Binaries) wird NICHT fuer
          //    den ganzen Batch in den Speicher gezogen, sondern erst geholt wenn
          //    eine Datei wirklich geschrieben werden muss. Alle Contents
          //    gleichzeitig im Query-Result zu halten war der native-Buffer-
          //    Treiber des OOM (RSS waechst ueber den JS-Heap-Cap hinaus).
          const geaendert = await datenweg.geaenderte(projectName, {
            untergrenze,
            vollNach: vollabgleich?.changedAfter != null ? vollabgleich.changedAfter : null,
            limit: pgFullBatchFiles,
          });
          const delta = { rows: geaendert.delta };
          // Keyset-Paging statt eines synchronen Hash-Laufs ueber zehntausende Dateien.
          // Delta laeuft auch waehrend des Vollabgleichs in JEDEM Tick; geloeschte Zeilen
          // verschieben keine Offsets. Neue Zeilen hinter dem Cursor sieht der naechste Vollabgleich.
          const volleSeite = { rows: geaendert.voll };
          const deltaPfade = new Set(delta.rows.map(row => row.file_path));
          const vollePfade = new Set(volleSeite.rows.map(row => row.file_path));
          const changed = { rows: [...new Map([...delta.rows, ...volleSeite.rows].map(row => [row.file_path, row])).values()] };

          // Zeilen, die dieser Tick bewusst NICHT geschrieben hat. Sie halten den
          // Checkpoint zurueck, damit der naechste Tick sie erneut sieht.
          const alsIso = (wert: string | Date): string =>
            typeof wert === 'string' ? wert : new Date(wert).toISOString();
          const zurueckgestellt: string[] = [];
          for (const row of changed.rows) {
            const relativePath: string = row.file_path;
            // Ignore-Regeln auch auf PG→FS anwenden — sonst synct/loopt der Poller
            // .gitignore/.synapseignore-Dateien (war Ursache der README.md-
            // Endlosschleife bei Rows, die vor dem Ignore-Eintrag ingestiert wurden).
            // NUR gesperrte Pfade zurueckhalten. Die urspruengliche Endlosschleife
            // (Poller schrieb .gitignore/.synapseignore gegen sich selbst) bleibt
            // verhindert, weil beide ueber DEFAULT_IGNORES gesperrt sind.
            // AUSGEBLENDETE PFADE MUESSEN HIER DURCH: sonst entsteht ein Eintrag in
            // der Datenbank, den es auf der Platte nie gibt — genau der Fall, der
            // am 28.07. die Parser-Fixtures verschluckt hat.
            // P15-T36: Daemon-Schutz. Ein Pfad, der aus dem Projekt fuehrt ('../x') oder absolut ist, wird
            // NIE auf die Platte geschrieben (path.join wuerde ausserhalb landen) und bricht den Tick nicht ab
            // (istGesperrt/ignore wirft bei solchen Pfaden). Ueberspringen und protokollieren, Bestand bleibt.
            if (!liegtImProjekt(projectPath, relativePath)) {
              if (skipMeldungen.sollMelden(relativePath, 'ausserhalb', String(row.content_hash))) {
                console.error(`[Synapse] PG→FS Skip (Pfad ausserhalb des Projekts): ${JSON.stringify(relativePath)}`);
              }
              continue;
            }
            if (istGesperrt(relativePath, projectPath, projectName)) continue;
            // BUGFIX 2026-05-07 (unlink-bootstrap-race): wenn fuer dieses File
            // ein chokidar-unlink-Event pending ist (User hat gerade rm/mv
            // gemacht, Debounce 1500ms laeuft noch), darf der PG-Watcher es
            // NICHT zurueckschreiben. Sonst wird das User-Delete rueckgaengig
            // gemacht und der unlink-Handler skippt mit "Rename-detected".
            const pending = pendingEvents.get(relativePath);
            if (pending && pending.type === 'unlink') {
              if (deltaPfade.has(relativePath)) zurueckgestellt.push(alsIso(row.updated_at));
              if (skipMeldungen.sollMelden(relativePath, 'unlink', String(row.content_hash))) {
                console.error(`[Synapse] PG→FS Skip (unlink pending): ${path.basename(relativePath)}`);
              }
              continue;
            }
            const filePath = path.join(projectPath, relativePath);  // absolut rekonstruieren
            const exists = fs.existsSync(filePath);
            let localHash: string | null = null;
            if (exists) {
              localHash = crypto.createHash('sha256').update(fs.readFileSync(filePath, 'utf-8')).digest('hex');
            }
            if (localHash === row.content_hash) {  // konvergiert → nichts zu tun
              skipMeldungen.vergessen(relativePath);
              continue;
            }
            // SYNC-1: Ueberschreiben nur, wenn PG den Inhalt auf der Platte KENNT.
            //
            // Frueher entschied hier die mtime ("Disk neuer? dann nicht anfassen").
            // Das hat fremde Aenderungen zerstoert, sobald ihre mtime aelter war als
            // code_files.updated_at — bei cp -p, rsync -a, entpackten Archiven oder
            // Uhren-Drift ist das der Normalfall. Reproduziert am 2026-07-25: Datei
            // geaendert, mtime zurueckgesetzt, Inhalt war anschliessend weg.
            //
            // Jetzt gilt: kennt PG den Disk-Hash als frueheren Stand, hinkt die Platte
            // nur hinterher und darf aktualisiert werden. Ist der Hash UNBEKANNT, hat
            // jemand die Datei ausserhalb von Synapse geaendert und der Watcher hat sie
            // noch nicht eingesammelt — dann stehen lassen und den naechsten Tick
            // abwarten. Das Einsammeln erledigt storeFileContent (versioniert).
            if (exists && localHash) {
              if (!(await datenweg.hashBekannt(projectName, relativePath, localHash))) {
                // Nur zurueckstellen (Checkpoint halten), wenn der Watcher den Pfad auch einsammeln kann.
                // Sonst kaeme das Einsammeln nie und jede Runde fragte ab der aeltesten solchen Zeile neu
                // (Endlosschleife, Befund 929b5b10). Ueberschrieben wird in beiden Faellen NICHT.
                const einsammelbar = watcherSammeltEin(relativePath, filePath);
                // Alte Vollabgleich-Zeilen duerfen den Delta-Merkpunkt nicht auf den
                // Projektanfang zuruecksetzen; FS-Aenderungen kommen ueber den Watcher.
                if (einsammelbar && deltaPfade.has(relativePath)) zurueckgestellt.push(alsIso(row.updated_at));
                const grund = einsammelbar ? 'fremd' : 'fremd-nicht-einsammelbar';
                if (skipMeldungen.sollMelden(relativePath, grund, `${row.content_hash}|${localHash}`)) {
                  console.error(
                    einsammelbar
                      ? `[Synapse] PG→FS Skip (fremde Aenderung auf der Platte, nicht ueberschrieben): ${relativePath}`
                      : `[Synapse] PG→FS Skip (fremde Aenderung auf der Platte, nicht ueberschrieben; Watcher sammelt den Pfad nicht ein: ausgeblendet/.gitignore/binaer; einmalige Meldung bis zur naechsten Aenderung): ${relativePath}`
                  );
                }
                continue;
              }
            }
            // Content erst JETZT holen — nur fuer die wenigen Rows die wirklich
            // geschrieben werden, nicht fuer den ganzen Batch.
            const content: string | null | undefined = await datenweg.inhalt(projectName, relativePath);
            if (content == null) continue;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf-8');
            skipMeldungen.vergessen(relativePath);
            const ausVollabgleich = vollePfade.has(relativePath);
            if (ausVollabgleich) nachgeholteDateien++;
            const nachgeholt = ausVollabgleich || alsIso(row.updated_at) <= checkpointVorher;
            console.error(nachgeholt
              ? `[Synapse] PG→FS Nachgeholt (${ausVollabgleich ? 'Vollabgleich' : 'Überlappung'}): ${relativePath}`
              : `[Synapse] PG→FS Sync: ${relativePath}`);
          }

          // 2. Soft-deleted files
          const geloescht = await datenweg.geloeschte(projectName, {
            untergrenze,
            geloeschtNach: vollabgleich?.deletedAfter != null ? vollabgleich.deletedAfter : null,
            limit: pgFullBatchFiles,
          });
          const deletedDelta = { rows: geloescht.delta };
          const geloeschteSeite = { rows: geloescht.voll };
          const volleLoeschPfade = new Set(geloeschteSeite.rows.map(row => row.file_path));
          const deleted = { rows: [...new Map([...deletedDelta.rows, ...geloeschteSeite.rows].map(row => [row.file_path, row])).values()] };
          for (const row of deleted.rows) {
            // P15-T36: Daemon-Schutz auch beim Loeschen - nie ausserhalb des Projekts unlinken.
            if (!liegtImProjekt(projectPath, row.file_path)) {
              console.error(`[Synapse] PG→FS Delete-Skip (Pfad ausserhalb des Projekts): ${JSON.stringify(row.file_path)}`);
              continue;
            }
            const filePath = path.join(projectPath, row.file_path);  // absolut rekonstruieren
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              const ausVollabgleich = volleLoeschPfade.has(row.file_path);
              if (ausVollabgleich) nachgeholteDateien++;
              console.error(ausVollabgleich || alsIso(row.updated_at) <= checkpointVorher
                ? `[Synapse] PG→FS Nachgeholt (${ausVollabgleich ? 'Vollabgleich' : 'Überlappung'}, gelöscht): ${row.file_path}`
                : `[Synapse] PG→FS Delete: ${row.file_path}`);
            }
            await datenweg.geloeschtAbschliessen(projectName, String(row.id), row.file_path);
          }

          // Checkpoint: MAX(updated_at) from results
          const allRows = [...changed.rows, ...deleted.rows];
          if (allRows.length > 0) {
            const maxUpdated = allRows.reduce((max: string, r: { updated_at: string | Date }) => {
              const ts = typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at).toISOString();
              return ts > max ? ts : max;
            }, lastPgCheck);
            // Eine zurueckgestellte Zeile darf der Checkpoint NICHT ueberspringen:
            // sonst faellt sie aus dem Fenster updated_at > lastPgCheck und wird nie
            // wieder geholt — der in den Skip-Zweigen zugesagte naechste Tick kommt
            // fuer sie dann nicht mehr. Im Log standen dafuer 143 Faelle (fremde
            // Aenderung) und 150 (pending unlink). Deshalb hoechstens bis knapp vor
            // die aelteste zurueckgestellte Zeile vorruecken. Das erneute Pruefen ist
            // billig: konvergierte Dateien fallen oben am Hash-Vergleich heraus.
            let neuerStand = maxUpdated;
            if (zurueckgestellt.length > 0) {
              const aelteste = zurueckgestellt.reduce((min, ts) => (ts < min ? ts : min));
              const knappDavor = new Date(new Date(aelteste).getTime() - 1).toISOString();
              if (knappDavor < neuerStand) neuerStand = knappDavor;
            }
            lastPgCheck = neuerStand;
          }
          // Seiten-Cursor erst nach erfolgreicher Verarbeitung verschieben, Fehler werden wiederholt.
          if (vollabgleich) {
            vollabgleich.dateien += volleSeite.rows.length + geloeschteSeite.rows.length;
            vollabgleich.nachgeholt += nachgeholteDateien;
            vollabgleich.changedAfter = volleSeite.rows.length < pgFullBatchFiles ? null : volleSeite.rows.at(-1)!.file_path;
            vollabgleich.deletedAfter = geloeschteSeite.rows.length < pgFullBatchFiles ? null : geloeschteSeite.rows.at(-1)!.file_path;
            if (vollabgleich.changedAfter === null && vollabgleich.deletedAfter === null) {
              letzterVollabgleich = Date.now();
              console.error(`[Synapse] PG→FS Vollabgleich: Projekt=${JSON.stringify(projectName)} Dateien=${vollabgleich.dateien} Dauer_ms=${letzterVollabgleich - vollabgleich.begann} nachgeholt=${vollabgleich.nachgeholt}`);
              vollabgleichStand = null;
            }
          }
        } catch {
          // PG not reachable — ignore, next poll will retry
        } finally {
          pgPollBusy = false;  // Poll fertig → naechster Tick darf laufen
        }
      }, 2000);
    } catch {
      console.error('[Synapse] PG-Watcher konnte nicht gestartet werden — nur Filesystem-Ueberwachung aktiv');
    }
  })();

  // Return FileWatcher Instance
  return {
    stop: async () => {
      // PG-Poll-Intervall stoppen
      if (pgPollInterval) clearInterval(pgPollInterval);

      // Alle pending Events abbrechen
      for (const { timeout } of pendingEvents.values()) {
        clearTimeout(timeout);
      }
      pendingEvents.clear();

      await watcher.close();
      console.error(`[Synapse] FileWatcher gestoppt fuer "${projectName}"`);
    },
    projectName,
    projectPath,
  };
}

/**
 * Liest eine Datei und gibt Inhalt + Metadaten zurueck
 */
export function readFileWithMetadata(filePath: string, projectName: string): {
  content: string;
  fileName: string;
  fileType: string;
  lineCount: number;
} | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const fileType = getFileType(filePath);
    const lineCount = content.split('\n').length;

    return {
      content,
      fileName,
      fileType,
      lineCount,
    };
  } catch {
    return null;
  }
}
