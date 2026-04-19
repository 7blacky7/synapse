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

export const DEFAULT_PORT = 7878;
export const DEFAULT_SYNAPSE_API_URL = 'http://127.0.0.1:3456';

export interface ProjektConfig {
  name: string;
  pfad: string;
  enabled: boolean;
  /** Optional: Anzahl zuletzt gesehener Dateien */
  file_count?: number;
  /** Optional: Timestamp letzter Scan (ms) */
  last_scan_ms?: number;
}

export interface DaemonConfig {
  port: number;
  synapse_api_url: string;
  projekte: ProjektConfig[];
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
      port: typeof parsed.port === 'number' ? parsed.port : DEFAULT_PORT,
      synapse_api_url:
        typeof parsed.synapse_api_url === 'string' && parsed.synapse_api_url
          ? parsed.synapse_api_url
          : DEFAULT_SYNAPSE_API_URL,
      projekte: Array.isArray(parsed.projekte)
        ? parsed.projekte.filter(isValidProjekt).map(normalizeProjekt)
        : [],
    };
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
  };
}

/** Schreibt Config atomar (tmp + rename). */
export function saveConfig(cfg: DaemonConfig): void {
  const p = configFilePath();
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
