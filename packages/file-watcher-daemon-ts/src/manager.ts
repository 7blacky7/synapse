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
  isProjectEnabled,
  klassifiziereDatei,
  verarbeiteAssetEreignis,
  verifyAssetsAgainstFilesystem,
  workerPausiert,
  meldeWorkerArbeit,
  registriereWarteschlange,
  seiteAusListe,
  assetWarteschlange,
} from '@synapse/core';
import type { VerschiebeAuftrag, WarteschlangenEintrag } from '@synapse/core';
import {
  DaemonConfig,
  ProjektConfig,
  loadConfig,
  saveConfig,
  findProjekt,
  upsertProjekt,
  removeProjekt,
  normalizeReverseBibliothek,
  reverseBibliothekPfad as reverseBibliothekPfadVon,
} from './config.js';
import type { ReverseBibliothekConfig } from './config.js';

import {DaemonAssetSync} from './asset-sync.js';
import { DaemonReverseBibliothek } from './reverse-bibliothek.js';

/** P18-T16/RV6: gueltige Reverse-Einstellungen oder leer (ungueltige Altwerte werden beim Setzen ersetzt). */
function reverseEinstellungenSicher(p: unknown): ReverseBibliothekConfig {
  try { return normalizeReverseBibliothek(p) ?? {}; } catch { return {}; }
}

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
  /** P13-T45: projekte[].asset_sync.aktiv (Standard aus) — fuer den Tray-Schalter. */
  asset_sync_aktiv?: boolean;
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
/** P15-T12 E3: ein wartendes Ereignis (billig: nur Pfad und Zeitpunkt) — einsehbar ueber intern. */
interface IndexWartender {
  id: number;
  project: string;
  path: string;
  typ: string;
  seit: number;
  weiter?: () => void;
  /** P15-T12 E4: 1 = vorgezogen, -1 = ans Ende (ueberstimmt die Projekt-Regel) */
  vorrang?: 1 | -1;
  /** P15-T12 E4: bis dahin keinen Slot (ms seit Epoche) */
  zurueckBis?: number;
}
const indexWaiters: IndexWartender[] = [];
/** P15-T12 E4: Steuerung je Projekt und markierte Ereignisse. Alles leer = reines FIFO wie vorher. */
const projektVorrang = new Map<string, 1 | -1>();
const projektZurueck = new Map<string, number>();
const markierteEreignisse = new Set<number>();
let wecker: NodeJS.Timeout | null = null;

function steuerungAktiv(): boolean {
  return projektVorrang.size > 0 || projektZurueck.size > 0 || markierteEreignisse.size > 0;
}

/** Rang-Klasse eines Wartenden: 1 vor 0 vor -1; null = zurueckgestellt (bekommt jetzt keinen Slot). */
function klasse(w: IndexWartender, jetzt: number): 1 | 0 | -1 | null {
  if (!steuerungAktiv()) return 0;
  const bis = w.zurueckBis ?? projektZurueck.get(w.project);
  if (bis !== undefined && bis > jetzt) return null;
  return w.vorrang ?? projektVorrang.get(w.project) ?? 0;
}

/** Wartende in der Reihenfolge, in der sie Slots bekommen (zurueckgestellte am Ende). */
function indexReihenfolge(jetzt = Date.now()): Array<{ w: IndexWartender; k: 1 | 0 | -1 | null }> {
  const mit = indexWaiters.map((w, i) => ({ w, k: klasse(w, jetzt), i }));
  const wert = (k: 1 | 0 | -1 | null): number => (k === null ? -2 : k);
  return mit.sort((x, y) => wert(y.k) - wert(x.k) || x.i - y.i).map(({ w, k }) => ({ w, k }));
}

/** Weckt die Vergabe, wenn die frueheste Zurueckstellung endet (sonst warteten die Ereignisse bis zum naechsten Release). */
function planeWecker(jetzt: number): void {
  let frueh = Infinity;
  for (const w of indexWaiters) {
    const bis = w.zurueckBis ?? projektZurueck.get(w.project);
    if (bis !== undefined && bis > jetzt) frueh = Math.min(frueh, bis);
  }
  if (wecker) { clearTimeout(wecker); wecker = null; }
  if (frueh === Infinity) return;
  wecker = setTimeout(() => { wecker = null; vergebeFreieSlots(); }, Math.max(50, frueh - jetzt + 10));
  wecker.unref?.();
}

/** Gibt freie Slots an Wartende: ohne Steuerung FIFO (shift), sonst beste Klasse, darin FIFO. */
function vergebeFreieSlots(): void {
  const jetzt = Date.now();
  while (activeIndexOps < MAX_CONCURRENT_INDEX && indexWaiters.length > 0) {
    let index = 0;
    if (steuerungAktiv()) {
      index = -1;
      let beste = -2;
      for (let i = 0; i < indexWaiters.length; i++) {
        const k = klasse(indexWaiters[i], jetzt);
        if (k !== null && k > beste) { beste = k; index = i; if (k === 1) break; }
      }
      if (index < 0) { planeWecker(jetzt); return; }
    }
    const [w] = indexWaiters.splice(index, 1);
    markierteEreignisse.delete(w.id);
    activeIndexOps++;
    w.weiter!();
  }
  if (steuerungAktiv()) planeWecker(jetzt);
}
/** Ereignisse, die wegen der Pause von sync_fs_pg noch VOR dem Slot warten. */
const pausiertWartend = new Map<number, IndexWartender>();
let naechsteWarteId = 1;
function acquireIndexSlot(w: IndexWartender): Promise<void> {
  if (activeIndexOps < MAX_CONCURRENT_INDEX && indexWaiters.length === 0 && klasse(w, Date.now()) !== null) {
    activeIndexOps++;
    return Promise.resolve();
  }
  // P15-T12 E4: einreihen und sofort vergeben (synchron) — ohne Steuerung genau das alte FIFO.
  return new Promise<void>((resolve) => {
    indexWaiters.push({ ...w, weiter: resolve });
    vergebeFreieSlots();
  });
}
function releaseIndexSlot(): void {
  // Slot zurueck und sofort (synchron) weitergeben; ohne Steuerung bekommt ihn der Erste (FIFO).
  activeIndexOps--;
  vergebeFreieSlots();
}

/** Nur fuer Tests (scripts/test-warteschlangen-index.mjs): Slot-Vergabe direkt treiben. */
export const indexSlotsFuerTests = {
  acquire: (project: string, pfad: string): Promise<void> =>
    acquireIndexSlot({ id: naechsteWarteId++, project, path: pfad, typ: 'change', seit: Date.now() }),
  release: releaseIndexSlot,
  belegt: (): number => activeIndexOps,
};

/** P15-T12 E4: intern(warteschlange_verschieben, index, prozess daemon). */
function verschiebeIndex(a: VerschiebeAuftrag): Record<string, unknown> {
  const ids = a.eintrag_ids ?? [];
  if (ids.length > 0) {
    const betroffen: string[] = [];
    const nichtGefunden: string[] = [];
    for (const id of ids) {
      const i = indexWaiters.findIndex((w) => String(w.id) === id);
      if (i < 0) { nichtGefunden.push(id); continue; }
      const w = indexWaiters[i];
      delete w.vorrang;
      delete w.zurueckBis;
      markierteEreignisse.delete(w.id);
      if (a.nach === 'vorne' || a.nach === 'hinten') {
        w.vorrang = a.nach === 'vorne' ? 1 : -1;
        indexWaiters.splice(i, 1);
        if (a.nach === 'vorne') indexWaiters.unshift(w); else indexWaiters.push(w);
        markierteEreignisse.add(w.id);
      } else if (a.nach === 'zurueckstellen') {
        w.zurueckBis = a.bis_ms;
        markierteEreignisse.add(w.id);
      }
      betroffen.push(id);
    }
    vergebeFreieSlots();
    return {
      ebene: 'ereignisse', nach: a.nach, geaendert: betroffen.length,
      ...(nichtGefunden.length > 0 ? { nicht_gefunden: nichtGefunden, hinweis: 'Nicht (mehr) wartend; Ereignisse im Status pausiert stehen noch vor der Warteschlange.' } : {}),
    };
  }
  const p = a.project!;
  if (a.nach === 'vorne' || a.nach === 'hinten') { projektVorrang.set(p, a.nach === 'vorne' ? 1 : -1); projektZurueck.delete(p); }
  else if (a.nach === 'zurueckstellen') projektZurueck.set(p, a.bis_ms!);
  else { projektVorrang.delete(p); projektZurueck.delete(p); }
  vergebeFreieSlots();
  return {
    ebene: 'projekt', project: p, nach: a.nach,
    wartend_im_projekt: indexWaiters.filter((w) => w.project === p).length,
    ...(a.nach === 'zurueckstellen' ? { zurueckgestellt_bis: new Date(a.bis_ms!).toISOString() } : {}),
    hinweis: 'Gilt im Speicher dieses Daemons bis zum Neustart.',
  };
}

function alsEintrag(w: IndexWartender, status: string, jetzt: number, k: 1 | 0 | -1 | null = 0): WarteschlangenEintrag {
  const bis = w.zurueckBis ?? projektZurueck.get(w.project);
  return {
    id: String(w.id), projekt: w.project, typ: w.typ,
    status: k === null ? 'zurueckgestellt' : status,
    prioritaet: k === 1 ? 'vorne' : k === -1 ? 'hinten' : null,
    alter_s: Math.round((jetzt - w.seit) / 1000),
    details: { pfad: w.path, ...(k === null && bis ? { zurueckgestellt_bis: new Date(bis).toISOString() } : {}) },
  };
}

// P15-T12 E3: Index-Slots und Asset-Auftraege sind ueber intern(warteschlange_liste, prozess daemon) einsehbar.
registriereWarteschlange({
  name: 'index',
  beschreibung: `Datei-Ereignisse vor der Indexierung (Slots INDEX_MAX_CONCURRENT=${MAX_CONCURRENT_INDEX}); status pausiert = wartet auf das Ende der Pause von sync_fs_pg.`,
  reihenfolge: 'FIFO: wer zuerst auf einen Slot wartet, bekommt ihn zuerst. Mit Steuerung: vorne vor normal vor hinten, darin FIFO; zurueckgestellte warten.',
  verschiebbar: 'Projekt (project) oder Ereignis (eintrag_id): vorne, hinten, zurueckstellen (dauer_min|bis), einreihen. Nur im Speicher, ein Neustart hebt es auf.',
  uebersicht: () => {
    const je: Record<string, number> = {};
    for (const w of [...indexWaiters, ...pausiertWartend.values()]) je[w.project] = (je[w.project] ?? 0) + 1;
    const jetzt = Date.now();
    return {
      anzahl: indexWaiters.length + pausiertWartend.size, wartend: indexWaiters.length, pausiert: pausiertWartend.size,
      slots_belegt: activeIndexOps, slots_max: MAX_CONCURRENT_INDEX, je_projekt: je,
      ...(steuerungAktiv() ? {
        steuerung: {
          projekt_vorrang: Object.fromEntries(projektVorrang),
          projekt_zurueckgestellt_bis: Object.fromEntries([...projektZurueck].filter(([, b]) => b > jetzt).map(([p, b]) => [p, new Date(b).toISOString()])),
          markierte_ereignisse: markierteEreignisse.size,
        },
      } : {}),
    };
  },
  liste: (f) => {
    const jetzt = Date.now();
    return seiteAusListe([
      ...indexReihenfolge(jetzt).map(({ w, k }) => alsEintrag(w, 'wartend', jetzt, k)),
      ...[...pausiertWartend.values()].map((w) => ({ ...alsEintrag(w, 'pausiert', jetzt), rang: null })),
    ], f);
  },
  verschieben: (a) => verschiebeIndex(a),
});
registriereWarteschlange({
  name: 'asset',
  beschreibung: 'Asset-Inspektionen (worker_thread, SYNAPSE_ASSET_KONKURRENZ); dasselbe Ziel wird nur einmal eingereiht.',
  reihenfolge: 'FIFO.',
  verschiebbar: 'Nein: kurze Auftraege; ein neues Ereignis fuer denselben Pfad ersetzt das wartende.',
  uebersicht: () => {
    const a = assetWarteschlange();
    return { anzahl: a.wartend.length, laufend: a.aktiv, max_gleichzeitig: a.konkurrenz, abgeschaltet: a.abgeschaltet };
  },
  liste: (f) => seiteAusListe(assetWarteschlange().wartend.map((j, i) => ({
    id: `${j.project}:${j.pfad}`, projekt: j.project, typ: j.typ, status: 'wartend', prioritaet: null, rang: i + 1,
    alter_s: Math.round(j.wartet_ms / 1000), details: { pfad: j.pfad },
  })), f),
});

/**
 * Unlink bleibt auch nach Disable erlaubt, damit bereits entfernte Dateien
 * sicher aus dem Index verschwinden. Add/Change brauchen dagegen nach dem
 * Backpressure-Warten einen frischen enabled-Check.
 */
export async function darfWatcherEventNachSlot(
  eventType: FileEvent['type'],
  lokalEnabled: boolean,
  project: string,
  enabledPruefen: (name: string) => Promise<boolean> = isProjectEnabled
): Promise<boolean> {
  if (eventType === 'unlink') return true;
  if (!lokalEnabled) return false;
  try {
    return await enabledPruefen(project);
  } catch (err) {
    console.error(`[manager] Projektstatus nicht lesbar, ${eventType} verworfen: ${project}`, err);
    return false;
  }
}

export class WatcherManager {
  private instances = new Map<string, FileWatcherInstance>();
  private config: DaemonConfig;
  readonly assetSync: DaemonAssetSync;
  /** P18-T16/RV6: Reverse-Bibliotheks-Watcher (eigene Wurzel, nur ueber die API). */
  readonly reverse: DaemonReverseBibliothek;
  private reverseSchalter: Promise<unknown> = Promise.resolve();
  /** P13-T45: laufende Asset-Sync-Umschaltungen je Projekt (werden nacheinander abgearbeitet). */
  private readonly assetSchalter = new Map<string, Promise<unknown>>();
  /** EventEmitter fuer State-Changes — abonniert von api.ts SSE-Stream. Events: "state_change". */
  readonly events = new EventEmitter();

  constructor(config?: DaemonConfig) {
    this.config = config ?? loadConfig();
    this.assetSync = new DaemonAssetSync(()=>this.config,undefined,()=>this.emitChange('asset_sync'),()=>saveConfig(this.config));
    this.reverse = new DaemonReverseBibliothek(() => this.config, undefined, () => this.emitChange('reverse'));
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

  /**
   * Nimmt eine Projekt-Liste aus der PG-Registry (projects-Tabelle, gefiltert
   * auf den eigenen Hostname) entgegen und ergaenzt lokal unbekannte Projekte.
   * PG ist die Quelle fuer NEUE Projekte (z.B. per REST/MCP project(init)
   * angelegt, ohne dass dieser Daemon je eine config.json-Zeile dafuer
   * geschrieben hat). Bereits bekannte Projekte werden hier NICHT angefasst —
   * Pfad-Aenderungen laufen ueber register(), das enabled-Flag ueber
   * enable()/disable() bzw. den enabled-sync-Tick, der diese Methode aufruft.
   * config.json wird bei jedem Fund sofort mitgeschrieben und bleibt so der
   * lokale Cache/Notnagel, falls PG beim naechsten Start nicht erreichbar ist
   * (Vorbild: loadGitignore() in packages/core/src/watcher/ignore.ts).
   */
  discoverFromRegistry(rows: Array<{ name: string; pfad: string; enabled: boolean }>): void {
    let changed = false;
    for (const row of rows) {
      if (findProjekt(this.config, row.name)) continue;
      if (!fs.existsSync(row.pfad) || !fs.statSync(row.pfad).isDirectory()) {
        console.error(`[manager] PG-Projekt "${row.name}" uebersprungen: Pfad "${row.pfad}" existiert nicht auf diesem Host.`);
        continue;
      }
      const projekt: ProjektConfig = { name: row.name, pfad: row.pfad, enabled: row.enabled };
      upsertProjekt(this.config, projekt);
      changed = true;
      console.error(`[manager] Projekt "${row.name}" aus PG uebernommen (fehlte in config.json).`);
      if (row.enabled && !this.instances.has(row.name)) {
        try {
          this.spawnWatcher(projekt);
        } catch (err) {
          console.error(`[manager] Fehler beim Start von "${row.name}" (aus PG uebernommen):`, (err as Error).message);
        }
      }
    }
    if (changed) {
      saveConfig(this.config);
      this.emitChange('discoverFromRegistry');
    }
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

  /** A10: called only after complete API restore + persisted A8 checkpoint. No initial empty tree. */
  async registerRestored(name:string,pfad:string):Promise<ProjektConfig>{
    if(this.isRunning(name))throw new Error('restore_watcher_laeuft');
    if(!fs.lstatSync(pfad).isDirectory()||fs.lstatSync(pfad).isSymbolicLink())throw new Error('restore_pfad_ungueltig');
    const prior=findProjekt(this.config,name);
    const projekt:ProjektConfig={...prior,name,pfad,enabled:true,asset_sync:{...prior?.asset_sync,verwaltet:true}};
    upsertProjekt(this.config,projekt);saveConfig(this.config);
    this.spawnWatcher(projekt);this.emitChange('restore:'+name);return projekt;
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

  /**
   * P13-T45: Asset-Sync je Projekt schalten (Tray-Schalter). Setzt NUR asset_sync.aktiv in der
   * Konfiguration im Speicher, speichert config.json (Fremdfelder bleiben, siehe loadConfig) und
   * startet bei laufendem Watcher ausschliesslich die Asset-Bindung dieses Projekts neu
   * (DaemonAssetSync stop/starte). Der Datei-Watcher und andere Projekte laufen weiter.
   * Aufrufe je Projekt laufen nacheinander, damit zwei schnelle Klicks keine Bindung doppelt stoppen.
   */
  async setzeAssetSyncAktiv(name: string, aktiv: boolean): Promise<{ aktiv: boolean; neu_gestartet: boolean }> {
    const vorher = this.assetSchalter.get(name) ?? Promise.resolve();
    const lauf = vorher.catch(() => undefined).then(async () => {
      const p = findProjekt(this.config, name);
      if (!p) throw new Error(`Projekt "${name}" nicht gefunden`);
      p.asset_sync = { ...p.asset_sync, aktiv };
      saveConfig(this.config);
      let neuGestartet = false;
      if (this.instances.has(name)) {
        await this.assetSync.stop(name);
        this.assetSync.starte(p);
        neuGestartet = true;
      }
      this.emitChange(`asset_sync:${name}`);
      return { aktiv, neu_gestartet: neuGestartet };
    });
    this.assetSchalter.set(name, lauf);
    try {
      return await lauf;
    } finally {
      if (this.assetSchalter.get(name) === lauf) this.assetSchalter.delete(name);
    }
  }

  /** P18-T16/RV6: Reverse-Bibliothek starten (wirkt nur bei reverse_bibliothek.aktiv:true). */
  async startReverse(): Promise<void> {
    await this.reverse.starte();
  }

  /**
   * P18-T16/RV6: Tray-Schalter fuer die Reverse-Bibliothek. Uebernimmt zuerst den Stand aus config.json
   * (der Tray schreibt dort z.B. geloeschte_ausblenden), setzt die uebergebenen Felder, speichert atomar
   * (Fremdfelder bleiben) und startet bei aktiv/pfad ausschliesslich die Reverse-Bindung neu.
   * Ungueltige Werte werfen TypeError (Route: 400). Aufrufe laufen nacheinander.
   */
  async setzeReverseKonfig(e: { aktiv?: boolean; pfad?: string; geloeschte_ausblenden?: boolean }): Promise<{ aktiv: boolean; pfad: string; geloeschte_ausblenden: boolean; neu_gestartet: boolean }> {
    const lauf = this.reverseSchalter.catch(() => undefined).then(async () => {
      let disk: unknown;
      try { disk = loadConfig().reverse_bibliothek; } catch { disk = undefined; }
      const roh = { ...reverseEinstellungenSicher(this.config.reverse_bibliothek), ...reverseEinstellungenSicher(disk) };
      for (const [k, v] of Object.entries(e)) if (v !== undefined) roh[k] = v;
      const neu = normalizeReverseBibliothek(roh) ?? {};
      this.config.reverse_bibliothek = neu;
      saveConfig(this.config, { reverseBibliothekEigen: true });
      let neuGestartet = false;
      if (e.aktiv !== undefined || e.pfad !== undefined) {
        await this.reverse.stop();
        await this.reverse.starte();
        neuGestartet = true;
      }
      this.emitChange('reverse_konfig');
      return { aktiv: neu.aktiv === true, pfad: reverseBibliothekPfadVon(this.config), geloeschte_ausblenden: neu.geloeschte_ausblenden === true, neu_gestartet: neuGestartet };
    });
    this.reverseSchalter = lauf;
    return await lauf;
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
        asset_sync_aktiv: p.asset_sync?.aktiv === true,
      })),
    };
  }

  /** Stoppt alle Watcher (ohne Config zu aendern). Fuer Shutdown. */
  async stopAll(): Promise<void> {
    const names = [...this.instances.keys()];
    await Promise.all(names.map((n) => this.stopWatcher(n)));
    await this.reverse.stop();
  }

  // ══════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════

  private spawnWatcher(p: ProjektConfig): void {
    // A10: stale config/registry must not start a scan against partially installed restore bytes.
    const journalPath=path.join(path.dirname(path.resolve(p.pfad)),'.synapse-restore',p.name,'state.json');
    let restoreFd:number|undefined;
    try{
      restoreFd=fs.openSync(journalPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const journal=JSON.parse(fs.readFileSync(restoreFd,'utf8'));
      if(journal.project!==p.name||journal.path!==path.resolve(p.pfad)||journal.complete!==true)
        throw new Error('restore_noch_nicht_abgeschlossen');
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    finally{if(restoreFd!==undefined)fs.closeSync(restoreFd);}
    this.assetSync.starte(p);
    const instance = startFileWatcher({
      projectPath: p.pfad,
      projectName: p.name,
      onFileChange: (event) => this.forwardEvent(event),
      onError: (err) => {
        console.error(`[manager] Watcher-Fehler "${p.name}":`, err.message);
      },
      // Asset-Abgleich nach dem Erstscan (P4-T67): nur asset_*, inspiziert nur Abweichungen.
      onReady: () => {
        void this.assetSync.bereit(p.name).then(managed=>managed?undefined:verifyAssetsAgainstFilesystem(p.name,p.pfad)).catch((err) =>
          console.error(`[manager] Asset-Abgleich "${p.name}" fehlgeschlagen:`, (err as Error).message)
        );
      },
    });
    this.instances.set(p.name, instance);
    console.error(`[manager] Watcher gestartet: ${p.name} (${p.pfad})`);
  }

  private async stopWatcher(name: string): Promise<void> {
    await this.assetSync.stop(name);
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
    // New pure binary transport is API-only and precedes legacy code PG/backpressure.
    const local=this.config.projekte.find(p=>p.name===event.project);
    const managedAsset=Boolean(event.asset&&local?.enabled&&await this.assetSync.ereignis(event));
    if(managedAsset&&event.asset==='nur_asset')return;
    // In-Process Indexierung — wie der alte watcher-daemon.ts vor dem moo-Pivot.
    // indexFile() macht intern: storeFileContent (Hash/mtime-Schutz) + parseAndEmbed
    // (PG -> Qdrant). Kein HTTP-Umweg, kein REST-API-Bedarf, Daemon bleibt
    // standalone. HTTP-API + SSE-Push bleiben offen fuer externe Orchestrierung.
    //
    // BACKPRESSURE: Slot holen BEVOR content gelesen/geparst wird. Bei vielen
    // gleichzeitigen Events (Initial-Scan) warten die ueberzaehligen hier als
    // billiges event-Objekt statt tausende indexFile()-Buffer parallel zu halten.
    // P15-T12: Worker sync_fs_pg pausiert (intern, prozess daemon) -> das Ereignis wartet hier als
    // billiges Objekt und wird nach der Pause normal verarbeitet; nichts geht verloren.
    const wartender: IndexWartender = { id: naechsteWarteId++, project: event.project, path: event.path, typ: event.type, seit: Date.now() };
    if (workerPausiert('sync_fs_pg')) {
      pausiertWartend.set(wartender.id, wartender);
      try {
        while (workerPausiert('sync_fs_pg')) await new Promise((r) => setTimeout(r, 5_000));
      } finally {
        pausiertWartend.delete(wartender.id);
      }
    }
    await acquireIndexSlot(wartender);
    try {
      const projektCfg = this.config.projekte.find((p) => p.name === event.project);
      if (!(await darfWatcherEventNachSlot(event.type, projektCfg?.enabled === true, event.project))) {
        console.error(`[manager] ${event.type} nach Disable verworfen: ${event.project}/${event.path}`);
        return;
      }
      const projectRoot = (await getProjectRoot(event.project)) ?? projektCfg?.pfad;
      if (!projectRoot) {
        console.error(`[manager] indexieren skip: kein projectRoot fuer "${event.project}"`);
        return;
      }
      let relPath = event.path;
      if (path.isAbsolute(relPath)) relPath = path.relative(projectRoot, relPath);
      // ASSET-WEG (P4-T67, Etappe D): eigene Warteschlange mit worker_thread, NICHT abgewartet —
      // der Index-Slot gehoert dem Code-Weg. 'nur_asset' (Binaerdateien) erreicht den Code-Weg
      // nie, genau wie vor dem Umbau, als der Watcher sie verwarf.
      if (event.asset) {
        const managed=managedAsset||await this.assetSync.ereignis({...event,path:relPath});
        if(!managed)void verarbeiteAssetEreignis({ ...event, path: relPath }, projectRoot);
        if (event.asset === 'nur_asset') return;
      }
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
      meldeWorkerArbeit('sync_fs_pg');
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
