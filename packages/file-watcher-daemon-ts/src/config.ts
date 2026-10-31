/**
 * MODUL: Config-Persistenz
 * ZWECK: Liest/schreibt ~/.synapse/file-watcher/config.json
 *
 * Layout (kompatibel zum moo-Daemon):
 *   {
 *     "port": 7878,
 *     "synapse_api_url": "http://127.0.0.1:3456",
 *     "projekte": [
 *       { "name": "synapse", "pfad": "/abs/path", "enabled": true }
 *     ]
 *   }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {AssetTransferOptionen} from './asset-transfer-queue.js';

export const DEFAULT_PORT = 7878;
export const DEFAULT_SYNAPSE_API_URL = 'http://127.0.0.1:3456';

/**
 * Workspace-Root: Verzeichnis unter dem neue Projekte beim Self-Service
 * (project init nur mit Name, ohne Pfad) angelegt werden duerfen.
 *
 * Aufloesung in dieser Reihenfolge:
 *  1. ENV `SYNAPSE_WORKSPACE_ROOT`
 *  2. Feld `workspace_root` in config.json
 *  3. Default: `~/dev`
 */
export function getWorkspaceRoot(): string {
  const env = process.env.SYNAPSE_WORKSPACE_ROOT;
  if (env && env.trim()) return path.resolve(env.trim());

  try {
    const cfg = loadConfig();
    if (cfg.workspace_root && cfg.workspace_root.trim()) {
      return path.resolve(cfg.workspace_root.trim());
    }
  } catch { /* config nicht da → fallback default */ }

  const home = process.env.HOME || os.homedir() || '/tmp';
  return path.join(home, 'dev');
}

/** A8 client preferences can restrict the centrally negotiated direction and budgets. */
export interface DaemonAssetSyncConfig {
 aktiv?:boolean;richtung?:'both'|'pc_to_share'|'share_to_pc';
 chunk_bytes?:number;retry_ms?:number;scan_ms?:number;
 /** P22-T240: Download/Loeschen nach max_versuche parken (0 = aus), danach Retry alle park_retry_ms. Standard 20 / 3600000. */
 max_versuche?:number;park_retry_ms?:number;
}
/**
 * aktiv: Asset-Sync dieses Projekts. P22-T238 (User 31.10.2026, thought d59f32e8): Standard EIN fuer alle aktiven Projekte;
 * fehlendes Feld = EIN (Bestands-config.json ohne Feld wird damit ohne Umschreiben migriert), nur aktiv:false = bewusst aus.
 */
export interface ProjektAssetSyncConfig {aktiv?:boolean;richtung?:'both'|'pc_to_share'|'share_to_pc';verwaltet?:boolean;host?:string;optionen?:AssetTransferOptionen;}
export interface ProjektConfig {
  name: string;
  pfad: string;
  enabled: boolean;
  /** Optional: Anzahl zuletzt gesehener Dateien */
  file_count?: number;
  /** Optional: Timestamp letzter Scan (ms) */
  last_scan_ms?: number;
  asset_sync?: ProjektAssetSyncConfig;
}

/**
 * P18-T16/RV6: Reverse-Bibliothek (schreibt der Tray, RV7). aktiv Standard false; pfad Standard
 * <os.homedir()>/synapse-reverse; geloeschte_ausblenden wertet nur der Tray aus (Daemon reicht durch).
 * Unbekannte Unterfelder bleiben erhalten.
 */
export interface ReverseBibliothekConfig {
  aktiv?: boolean;
  pfad?: string;
  geloeschte_ausblenden?: boolean;
  [fremdesFeld: string]: unknown;
}

/** P22-T133: Tray-Haken "CLI-Verlauf an Synapse" (cli-verlauf.ts). Gehoert dem Tray, siehe saveConfig. */
export interface CliVerlaufConfig {
  aktiv?: boolean;
  [fremdesFeld: string]: unknown;
}

export interface DaemonConfig {
  asset_sync?: DaemonAssetSyncConfig;
  reverse_bibliothek?: ReverseBibliothekConfig;
  cli_verlauf?: CliVerlaufConfig;
  port: number;
  synapse_api_url: string;
  /** Optionaler gemeinsamer API-Rueckfall; Quelle ist config.json. */
  synapse_api_fallback_url?: string;
  projekte: ProjektConfig[];
  /** Optional: Root-Verzeichnis fuer Self-Service Project-Init via REST. */
  workspace_root?: string;
  /**
   * Felder, die NICHT dem Daemon gehoeren. Der Go-Tray legt in derselben Datei
   * z.B. synapse_api_token ab. Sie werden hier nur durchgereicht, nie ausgewertet
   * — aber sie muessen erhalten bleiben, sonst loescht der Daemon sie beim
   * naechsten Speichern (siehe loadConfig).
   */
  [fremdesFeld: string]: unknown;
}

/** Basis-Verzeichnis: ~/.synapse/file-watcher */
export function daemonDir(): string {
  return configDir();
}

export function configDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) return '/tmp/synapse-file-watcher';
  return path.join(home, '.synapse', 'file-watcher');
}

export function ensureConfigDir(): string {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function configFilePath(): string {
  return path.join(ensureConfigDir(), 'config.json');
}

export function pidFilePath(): string {
  return path.join(ensureConfigDir(), 'daemon.pid');
}

export function portFilePath(): string {
  return path.join(ensureConfigDir(), 'daemon.port');
}

function defaultConfig(): DaemonConfig {
  return {
    port: DEFAULT_PORT,
    synapse_api_url: DEFAULT_SYNAPSE_API_URL,
    projekte: [],
  };
}

/** Laedt Config. Bei fehlender/korrupter Datei: Defaults. */
export function loadConfig(): DaemonConfig {
  const p = configFilePath();
  if (!fs.existsSync(p)) return defaultConfig();

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[config] WARN: korrupt, starte mit Defaults');
      return defaultConfig();
    }
    const cfg: DaemonConfig = {
      // Fremdfelder ZUERST uebernehmen, danach die eigenen validiert daruebersetzen.
      // Ohne diesen Spread baute loadConfig ein Objekt aus nur den bekannten
      // Feldern, und saveConfig schrieb genau das zurueck — alles andere war weg.
      // So ist am 2026-07-25 das synapse_api_token des Trays verschwunden, das
      // der Nutzer kurz zuvor eingerichtet hatte.
      ...parsed,
      port: typeof parsed.port === 'number' ? parsed.port : DEFAULT_PORT,
      synapse_api_url:
        typeof parsed.synapse_api_url === 'string' && parsed.synapse_api_url
          ? parsed.synapse_api_url
          : DEFAULT_SYNAPSE_API_URL,
      projekte: Array.isArray(parsed.projekte)
        ? parsed.projekte.filter(isValidProjekt).map(normalizeProjekt)
        : [],
      workspace_root:
        typeof parsed.workspace_root === 'string' && parsed.workspace_root.trim()
          ? parsed.workspace_root.trim()
          : undefined,
      reverse_bibliothek: leseReverseBibliothek(parsed.reverse_bibliothek),
    };
    if (cfg.reverse_bibliothek === undefined) delete cfg.reverse_bibliothek;
    return cfg;
  } catch (err) {
    console.error('[config] WARN: parse-fehler, starte mit Defaults:', (err as Error).message);
    return defaultConfig();
  }
}

function isValidProjekt(p: unknown): p is Partial<ProjektConfig> {
  return !!p && typeof p === 'object' && typeof (p as ProjektConfig).name === 'string' && typeof (p as ProjektConfig).pfad === 'string';
}

function normalizeProjekt(p: Partial<ProjektConfig>): ProjektConfig {
  return {
    name: String(p.name),
    pfad: String(p.pfad),
    enabled: p.enabled !== false,
    file_count: typeof p.file_count === 'number' ? p.file_count : undefined,
    last_scan_ms: typeof p.last_scan_ms === 'number' ? p.last_scan_ms : undefined,
    asset_sync: normalizeAssetSync(p.asset_sync),
  };
}

/**
 * Schreibt Config atomar (tmp + rename).
 * P18-T16/M1: reverse_bibliothek gehoert dem Tray bzw. POST /reverse/konfig. Alle anderen Speicherwege
 * uebernehmen den Stand von der Platte (auch in cfg), damit nie ein alter Speicherstand zurueckgeschrieben wird.
 * Nur setzeReverseKonfig speichert mit reverseBibliothekEigen:true.
 */
export function saveConfig(cfg: DaemonConfig, o: { reverseBibliothekEigen?: boolean } = {}): void {
  const p = configFilePath();
  if (!o.reverseBibliothekEigen) {
    const platte = reverseVonPlatte(p);
    if (platte.gelesen) {
      if (platte.wert === undefined) delete cfg.reverse_bibliothek;
      else cfg.reverse_bibliothek = platte.wert;
    }
  }
  // P22-T133: cli_verlauf setzt nur der Tray; jeder Speicherweg uebernimmt den Stand von der Platte.
  const cli = feldVonPlatte(p, 'cli_verlauf');
  if (cli.gelesen) {
    if (cli.wert === undefined) delete cfg.cli_verlauf;
    else cfg.cli_verlauf = cli.wert as CliVerlaufConfig;
  }
  const tmp = p + '.tmp';
  const json = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(tmp, json, 'utf-8');
  fs.renameSync(tmp, p);
}

/** Findet Projekt per Name. */
export function findProjekt(cfg: DaemonConfig, name: string): ProjektConfig | undefined {
  return cfg.projekte.find((p) => p.name === name);
}

/** Fuegt Projekt hinzu oder aktualisiert es. Liefert geaenderte Config (Mutation). */
export function upsertProjekt(cfg: DaemonConfig, p: ProjektConfig): DaemonConfig {
  const idx = cfg.projekte.findIndex((x) => x.name === p.name);
  if (idx >= 0) cfg.projekte[idx] = { ...cfg.projekte[idx], ...p };
  else cfg.projekte.push(p);
  return cfg;
}

/** Entfernt Projekt per Name. Liefert true wenn entfernt. */
export function removeProjekt(cfg: DaemonConfig, name: string): boolean {
  const before = cfg.projekte.length;
  cfg.projekte = cfg.projekte.filter((p) => p.name !== name);
  return cfg.projekte.length < before;
}


/** Reject malformed preferences rather than silently enabling an unintended direction. */
function normalizeAssetSync(p:unknown):ProjektAssetSyncConfig|undefined{
 if(p===undefined)return undefined;
 if(!p||typeof p!=='object'||Array.isArray(p))throw new TypeError('asset_sync muss ein Objekt sein.');
 const a=p as ProjektAssetSyncConfig;
 if(a.richtung!==undefined&&!['both','pc_to_share','share_to_pc'].includes(a.richtung))throw new TypeError('asset_sync.richtung ungültig.');
 if(a.verwaltet!==undefined&&typeof a.verwaltet!=='boolean')throw new TypeError('asset_sync.verwaltet ungültig.');
 if(a.aktiv!==undefined&&typeof a.aktiv!=='boolean')throw new TypeError('asset_sync.aktiv ungültig.');
 return {...(a.aktiv===undefined?{}:{aktiv:a.aktiv}),...(a.richtung?{richtung:a.richtung}:{}),...(a.verwaltet===undefined?{}:{verwaltet:a.verwaltet}),
  ...(typeof a.host==='string'&&a.host?{host:a.host}:{}),...(a.optionen?{optionen:a.optionen}:{})};
}

/** P18-T16/RV6: wie normalizeAssetSync — fehlerhafte Werte werden abgelehnt statt still uminterpretiert. */
export function normalizeReverseBibliothek(p: unknown): ReverseBibliothekConfig | undefined {
  if (p === undefined) return undefined;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('reverse_bibliothek muss ein Objekt sein.');
  const a = p as ReverseBibliothekConfig;
  if (a.aktiv !== undefined && typeof a.aktiv !== 'boolean') throw new TypeError('reverse_bibliothek.aktiv ungültig.');
  if (a.geloeschte_ausblenden !== undefined && typeof a.geloeschte_ausblenden !== 'boolean') throw new TypeError('reverse_bibliothek.geloeschte_ausblenden ungültig.');
  if (a.pfad !== undefined && (typeof a.pfad !== 'string' || !a.pfad.trim() || a.pfad.includes(String.fromCharCode(0)) || !path.isAbsolute(a.pfad.trim()))) {
    throw new TypeError('reverse_bibliothek.pfad muss ein absoluter Pfad sein.');
  }
  if (a.pfad !== undefined) {
    const gesperrt = reversePfadGesperrt(path.resolve(a.pfad.trim()));
    if (gesperrt) throw new TypeError('reverse_bibliothek.pfad gesperrt: ' + gesperrt);
  }
  return { ...a, ...(a.pfad !== undefined ? { pfad: path.resolve(a.pfad.trim()) } : {}) };
}

/** Beim Laden: ungueltige Werte bleiben unveraendert erhalten (der Tray kann sie korrigieren), Reverse startet dann nicht. */
function leseReverseBibliothek(p: unknown): ReverseBibliothekConfig | undefined {
  try {
    return normalizeReverseBibliothek(p);
  } catch (e) {
    console.error('[config] WARN: reverse_bibliothek ungueltig, Reverse bleibt aus:', (e as Error).message);
    return p as ReverseBibliothekConfig;
  }
}

/**
 * P18-T16/K4: Sperrliste fuer die Bibliothek. $HOME selbst und Punktordner direkt unter $HOME (~/.ssh, ~/.gnupg,
 * ~/.config, ~/.synapse ...) samt Inhalt waeren sonst ueber die Loopback-Route hochladbar. Liefert den Grund oder undefined.
 */
export function reversePfadGesperrt(abs: string): string | undefined {
  const home = path.resolve(os.homedir());
  const ziel = path.resolve(abs);
  if (ziel === home) return '$HOME selbst';
  if (ziel === path.parse(ziel).root) return 'Dateisystemwurzel';
  const rel = path.relative(home, ziel);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const erster = rel.split(path.sep)[0];
  return erster.startsWith('.') ? 'Punktordner unter $HOME (' + erster + ')' : undefined;
}

/** M1: reverse_bibliothek aus der aktuellen config.json; gelesen:false bei fehlender/kaputter Datei. */
function reverseVonPlatte(p: string): { gelesen: boolean; wert?: ReverseBibliothekConfig } {
  try {
    if (!fs.existsSync(p)) return { gelesen: false };
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { gelesen: false };
    return { gelesen: true, wert: j.reverse_bibliothek === undefined ? undefined : leseReverseBibliothek(j.reverse_bibliothek) };
  } catch {
    return { gelesen: false };
  }
}

/** P22-T133: ein Feld frisch von der Platte (gelesen:false = Datei fehlt oder ist unlesbar, dann nichts aendern). */
function feldVonPlatte(p: string, feld: string): { gelesen: boolean; wert?: unknown } {
  try {
    if (!fs.existsSync(p)) return { gelesen: false };
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { gelesen: false };
    return { gelesen: true, wert: (j as Record<string, unknown>)[feld] };
  } catch {
    return { gelesen: false };
  }
}

/** Bibliothekspfad: reverse_bibliothek.pfad, sonst <os.homedir()>/synapse-reverse (kein absoluter Hardcode). */
export function reverseBibliothekPfad(cfg: DaemonConfig): string {
  const p = cfg.reverse_bibliothek?.pfad;
  return typeof p === 'string' && p.trim() && path.isAbsolute(p.trim()) ? path.resolve(p.trim()) : path.join(os.homedir(), 'synapse-reverse');
}
