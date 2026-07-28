/**
 * MODUL: WatcherManager
 * ZWECK: Multi-Projekt FileWatcher Lifecycle. Haelt Map<name, FileWatcherInstance>
 *        und persistiert Projekt-Zustand via config.ts.
 *
 * ABHAENGIGKEITEN:
 *   - @synapse/core/watcher  -> startFileWatcher() (Referenz, nicht anfassen)
 *   - ./config               -> Config-Persistenz
 *
 * Jedes File-Event wird an ${config.synapse_api_url}/api/fs/events POSTed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  startFileWatcher,
  FileWatcherInstance,
  FileEvent,
  indexFile,
  indexDocument,
  removeFile,
  getProjectRoot,
  setProjectEnabled,
  klassifiziereDatei,
} from '@synapse/core';
import {
  DaemonConfig,
  ProjektConfig,
  loadConfig,
  saveConfig,
  findProjekt,
  upsertProjekt,
  removeProjekt,
} from './config.js';

export interface OpResult {
  ok: boolean;
  msg: string;
}

export interface ProjektStatus {
  name: string;
  pfad: string;
  enabled: boolean;
  running: boolean;
  file_count?: number;
  last_scan_ms?: number;
}

export interface AggregateStatus {
  port: number;
  synapse_api_url: string;
  projekte: ProjektStatus[];
}

// ─── Backpressure: begrenzt gleichzeitige Datei-Indexierungen GLOBAL ───
// Ohne Limit startet der Initial-Scan aller Projekte zehntausende parallele
// indexFile()-Operationen gleichzeitig — jede haelt Datei-Content + native
// Buffer → RSS explodiert (nativer Speicher, NICHT per --max-old-space-size
// begrenzbar) → OOM nach ~1-2 Min. Mit Limit sind nie mehr als N Dateien
// gleichzeitig in Bearbeitung; der Rest wartet als billiger Pfad-String
// (event-Objekt) in der Queue. Content wird erst gelesen wenn ein Slot frei
// ist → Speicher hat eine feste Obergrenze statt mit Datei-Anzahl zu wachsen.
const MAX_CONCURRENT_INDEX = Math.max(1, Number(process.env.INDEX_MAX_CONCURRENT ?? 3));
let activeIndexOps = 0;
const indexWaiters: Array<() => void> = [];
function acquireIndexSlot(): Promise<void> {
  if (activeIndexOps < MAX_CONCURRENT_INDEX) {
    activeIndexOps++;
    return Promise.resolve();
  }
  // Wartender bekommt den Slot uebergeben (release zaehlt NICHT runter) —
  // sonst akkumuliert der Counter und alle queuen ewig.
  return new Promise<void>((resolve) => indexWaiters.push(resolve));
}
function releaseIndexSlot(): void {
  const next = indexWaiters.shift();
  if (next) next();
  else activeIndexOps--;
}

export class WatcherManager {
  private instances = new Map<string, FileWatcherInstance>();
  private config: DaemonConfig;
  /** EventEmitter fuer State-Changes — abonniert von api.ts SSE-Stream. Events: "state_change". */
  readonly events = new EventEmitter();

  constructor(config?: DaemonConfig) {
    this.config = config ?? loadConfig();
  }

  /** Emittiert ein state_change-Event mit aktuellem Aggregate-Snapshot. */
  private emitChange(reason: string): void {
    this.events.emit('state_change', { reason, ts: Date.now(), state: this.statusAll() });
  }

  /** Liefert alle Projekte als Config-Array (fuer API /projects). */
  list(): ProjektConfig[] {
    return this.config.projekte.slice();
  }

  /** Liefert Projekt-Config per Name (undefined wenn nicht vorhanden). */
  get(name: string): ProjektConfig | undefined {
    return findProjekt(this.config, name);
  }

  /** True wenn Watcher fuer diesen Namen laeuft. */
  isRunning(name: string): boolean {
    return this.instances.has(name);
  }

  /** Alias fuer stopAll() - wird von main.ts verwendet. */
  async shutdownAll(): Promise<void> {
    return this.stopAll();
  }

  /** Gibt aktuelle Config (read-only verwenden). */
  getConfig(): DaemonConfig {
    return this.config;
  }

  /** Startet alle Projekte mit enabled=true aus der Config. */
  async startAllEnabled(): Promise<void> {
    for (const p of this.config.projekte) {
      if (p.enabled && !this.instances.has(p.name)) {
        try {
          this.spawnWatcher(p);
        } catch (err) {
          console.error(`[manager] Fehler beim Start von "${p.name}":`, (err as Error).message);
        }
      }
    }
  }

  /** Registriert ein Projekt neu und startet den Watcher. Wirft bei Fehler. */
  async register(name: string, pfad: string): Promise<ProjektConfig> {
    if (!name || !pfad) throw new Error('name und pfad erforderlich');
    if (!fs.existsSync(pfad) || !fs.statSync(pfad).isDirectory()) {
      throw new Error(`Pfad existiert nicht oder ist kein Verzeichnis: ${pfad}`);
    }

    const existing = findProjekt(this.config, name);
    if (existing && existing.pfad !== pfad) {
      await this.stopWatcher(name);
    }

    const projekt: ProjektConfig = { name, pfad, enabled: true };
    upsertProjekt(this.config, projekt);
    saveConfig(this.config);

    if (!this.instances.has(name)) this.spawnWatcher(projekt);
    this.emitChange(`register:${name}`);
    return projekt;
  }

  /** Entfernt Projekt komplett. Wirft wenn nicht gefunden. */
  async unregister(name: string): Promise<void> {
    const existed = !!findProjekt(this.config, name) || this.instances.has(name);
    if (!existed) throw new Error(`Projekt "${name}" nicht gefunden`);
    await this.stopWatcher(name);
    removeProjekt(this.config, name);
    saveConfig(this.config);
    this.emitChange(`unregister:${name}`);
  }

  /** Aktiviert ein Projekt (enabled=true, startet Watcher). */
  async enable(name: string): Promise<void> {
    const p = findProjekt(this.config, name);
    if (!p) throw new Error(`Projekt "${name}" nicht gefunden`);
    p.enabled = true;
    saveConfig(this.config);
    // enabled-Flag server-seitig spiegeln, damit der Parser-Worker es respektiert.
    try { await setProjectEnabled(name, true); } catch (e) { console.error(`[manager] setProjectEnabled(${name},true) fehlgeschlagen:`, (e as Error).message); }
    if (!this.instances.has(name)) this.spawnWatcher(p);
    this.emitChange(`enable:${name}`);
  }

  /** Deaktiviert ein Projekt (stoppt Watcher, enabled=false). */
  async disable(name: string): Promise<void> {
    const p = findProjekt(this.config, name);
    if (!p) throw new Error(`Projekt "${name}" nicht gefunden`);
    p.enabled = false;
    saveConfig(this.config);
    // enabled-Flag server-seitig spiegeln → Parser-Worker ueberspringt das Projekt.
    try { await setProjectEnabled(name, false); } catch (e) { console.error(`[manager] setProjectEnabled(${name},false) fehlgeschlagen:`, (e as Error).message); }
    await this.stopWatcher(name);
    this.emitChange(`disable:${name}`);
  }

  /** Status eines einzelnen Projekts. */
  status(name: string): ProjektStatus | undefined {
    const p = findProjekt(this.config, name);
    if (!p) return undefined;
    return {
      name: p.name,
      pfad: p.pfad,
      enabled: p.enabled,
      running: this.instances.has(p.name),
      file_count: p.file_count,
      last_scan_ms: p.last_scan_ms,
    };
  }

  /** Aggregate Status ueber alle Projekte. */
  statusAll(): AggregateStatus {
    return {
      port: this.config.port,
      synapse_api_url: this.config.synapse_api_url,
      projekte: this.config.projekte.map((p) => ({
        name: p.name,
        pfad: p.pfad,
        enabled: p.enabled,
        running: this.instances.has(p.name),
        file_count: p.file_count,
        last_scan_ms: p.last_scan_ms,
      })),
    };
  }

  /** Stoppt alle Watcher (ohne Config zu aendern). Fuer Shutdown. */
  async stopAll(): Promise<void> {
    const names = [...this.instances.keys()];
    await Promise.all(names.map((n) => this.stopWatcher(n)));
  }

  // ══════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════

  private spawnWatcher(p: ProjektConfig): void {
    const instance = startFileWatcher({
      projectPath: p.pfad,
      projectName: p.name,
      onFileChange: (event) => this.forwardEvent(event),
      onError: (err) => {
        console.error(`[manager] Watcher-Fehler "${p.name}":`, err.message);
      },
    });
    this.instances.set(p.name, instance);
    console.error(`[manager] Watcher gestartet: ${p.name} (${p.pfad})`);
  }

  private async stopWatcher(name: string): Promise<void> {
    const inst = this.instances.get(name);
    if (!inst) return;
    try {
      await inst.stop();
    } catch (err) {
      console.error(`[manager] stop("${name}") Fehler:`, (err as Error).message);
    }
    this.instances.delete(name);
    console.error(`[manager] Watcher gestoppt: ${name}`);
  }

  private async forwardEvent(event: FileEvent): Promise<void> {
    // In-Process Indexierung — wie der alte watcher-daemon.ts vor dem moo-Pivot.
    // indexFile() macht intern: storeFileContent (Hash/mtime-Schutz) + parseAndEmbed
    // (PG -> Qdrant). Kein HTTP-Umweg, kein REST-API-Bedarf, Daemon bleibt
    // standalone. HTTP-API + SSE-Push bleiben offen fuer externe Orchestrierung.
    //
    // BACKPRESSURE: Slot holen BEVOR content gelesen/geparst wird. Bei vielen
    // gleichzeitigen Events (Initial-Scan) warten die ueberzaehligen hier als
    // billiges event-Objekt statt tausende indexFile()-Buffer parallel zu halten.
    await acquireIndexSlot();
    try {
      const projektCfg = this.config.projekte.find((p) => p.name === event.project);
      const projectRoot = (await getProjectRoot(event.project)) ?? projektCfg?.pfad;
      if (!projectRoot) {
        console.error(`[manager] indexieren skip: kein projectRoot fuer "${event.project}"`);
        return;
      }
      let relPath = event.path;
      if (path.isAbsolute(relPath)) relPath = path.relative(projectRoot, relPath);
      if (event.type === 'unlink') {
        await removeFile(relPath, event.project);
      } else {
        // KLASSIFIKATION PFLICHT. Hier stand bis zum 28.07.2026 ein blankes
        // indexFile() — dieser Pfad umging damit die Aussortierung, die
        // handleFileEvent im core laengst hatte. Eine PNG, die in ein ueberwachtes
        // Projekt gelegt wurde, landete als UTF-8-dekodierter Byte-Salat im
        // Code-Index. Belegt an den Zeitmustern: 28 PNGs in einem Projekt verteilt
        // ueber 21 verschiedene Minuten und 8,2 Stunden — das kann kein Scan sein.
        const art = klassifiziereDatei(relPath);
        if (art === 'media') {
          // Nur ueber admin(index_media), nur auf Anweisung des Users.
          console.error(`[manager] Media uebersprungen: ${relPath}`);
        } else if (art === 'dokument') {
          await indexDocument(relPath, event.project);
        } else {
          await indexFile(relPath, event.project, projectRoot);
        }
      }
    } catch (err) {
      console.error(
        `[manager] indexieren ${event.type} ${event.path} fehlgeschlagen:`,
        (err as Error).message
      );
    } finally {
      releaseIndexSlot();
    }
  }
}
