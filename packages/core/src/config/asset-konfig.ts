/**
 * MODUL: Asset-Konfiguration (P13-T22)
 * ZWECK: Zentrale, streng validierte Betreibergrenzen fuer Projekt-Assets und Reverse.
 * Aenderungen an Werten scheitern mit Env-Namen/Klartext; es wird nie still gekappt.
 */

import * as path from 'path';
import { standardRegistry } from '../asset-intel/registry.js';
import { genericBinaryInspector } from '../asset-intel/generic-binary.js';
import { alleInspektoren } from '../asset-intel/inspectors/index.js';
import type { AssetLimits } from '../asset-intel/types.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SEKUNDE = 1000;
const TAG = 24 * 60 * 60 * SEKUNDE;

export const DEFAULT_ASSET_MAX_OBJECTS_PER_FILE = 2_000;
export const DEFAULT_ASSET_RESTORE_WINDOW_MS = 30 * TAG;

export const DEFAULT_ASSET_LIMITS: Readonly<AssetLimits> = Object.freeze({
  maxFileBytes: 256 * MIB,
  maxReadBytes: 64 * MIB,
  maxObjects: 10_000,
  timeoutMs: 30_000,
  maxDepth: 8,
  maxHashBytes: 256 * MIB,
});

export type AssetSyncRichtung = 'both' | 'pc_to_share' | 'share_to_pc';

export interface AssetKonfiguration {
  aktiv: boolean;
  speicher: {
    /** Betreiber-Mount fuer z/<projekt>/{assets,binaries}; null bei deaktiviertem Asset-Gate. */
    root: string | null;
    /** Eigenstaendiger Reverse-Mount; A3 verwendet ihn zur Bereichsaufloesung. */
    reverseRoot: string | null;
    assetsUnterordner: string;
    binariesUnterordner: string;
    maxDateiBytes: number;
    maxProjektBytes: number;
    maxProjektDateien: number;
    maxObjekteJeDatei: number;
    chunkBytes: number;
    parallelTransfers: number;
    timeoutMs: number;
    transferFormate: string[];
  };
  sync: {
    richtung: AssetSyncRichtung;
    scanIntervallMs: number;
    retryIntervallMs: number;
    /** Legacy-Inspector-Konkurrenz: 1 standard, maximal 2. */
    parallelInspektionen: number;
    restoreWindowMs: number;
    metadatenRetentionTage: number;
  };
  inspektion: AssetLimits;
  vorschau: {
    formate: string[];
    maxPixel: number;
    maxBytes: number;
    maxAnzahl: number;
    offenSekundenStandard: number;
    offenSekundenObergrenze: number;
    /** A14: optionale additive Decodergrenzen (alte Konfigurations-Fixtures bleiben gültig). */
    maxInputBytes?: number;
    maxRamBytes?: number;
    timeoutMs?: number;
    maxKante?: number;
    maxFrames?: number;
    maxDauerMs?: number;
    parallelRenderer?: number;
    ffmpeg?: string;
    ffprobe?: string;
    prlimit?: string;
  };
  reverse: {
    aktiv: boolean;
    retentionMs: number;
    maxDateiBytes: number;
    maxProjektBytes: number;
    maxProjektDateien: number;
    maxErgebnisse: number;
  };
}

export interface AssetProjektOptionen {
  richtung?: AssetSyncRichtung;
  restoreWindowMs?: number;
  maxDateiBytes?: number;
  maxProjektBytes?: number;
  maxProjektDateien?: number;
  erlaubteTypen?: string[];
  maxObjekteJeDatei?: number;
  vorschau?: {
    maxPixel?: number;
    maxBytes?: number;
    maxAnzahl?: number;
    offenSekundenStandard?: number;
  };
}

export interface WirksameAssetProjektoptionen {
  richtung: AssetSyncRichtung;
  restoreWindowMs: number;
  maxDateiBytes: number;
  maxProjektBytes: number;
  maxProjektDateien: number;
  erlaubteTypen: string[];
  maxObjekteJeDatei: number;
  vorschau: {
    maxPixel: number;
    maxBytes: number;
    maxAnzahl: number;
    offenSekundenStandard: number;
  };
}

function fehler(envName: string, grund: string): never {
  throw new Error(`Asset-Konfiguration ${envName}: ${grund}`);
}

function flag(env: NodeJS.ProcessEnv, name: string, standard: boolean): boolean {
  const roh = env[name];
  if (roh === undefined) return standard;
  switch (roh.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'ja':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'nein':
      return false;
    default:
      return fehler(name, 'erwartet 1/true/ja oder 0/false/nein');
  }
}

function zahl(env: NodeJS.ProcessEnv, name: string, standard: number, min: number, max: number): number {
  const roh = env[name];
  if (roh === undefined) return standard;
  if (!/^\d+$/.test(roh.trim())) return fehler(name, 'muss eine positive ganze Zahl sein');
  const wert = Number(roh.trim());
  if (!Number.isSafeInteger(wert) || wert < min || wert > max) {
    return fehler(name, `muss zwischen ${min} und ${max} liegen; erhalten: ${roh}`);
  }
  return wert;
}

function parallelInspektionenAlt(env: NodeJS.ProcessEnv): number {
  const wert = Number(env.SYNAPSE_ASSET_KONKURRENZ);
  return Number.isInteger(wert) && wert >= 2 ? 2 : 1;
}

function rootPfad(env: NodeJS.ProcessEnv, name: string, erforderlich: boolean): string | null {
  const roh = env[name];
  if (roh === undefined || roh.trim() === '') {
    if (erforderlich) return fehler(name, 'ist erforderlich, wenn das zugehoerige Feature aktiviert ist');
    return null;
  }
  const wert = roh.trim();
  if (!path.isAbsolute(wert) || wert.includes('\0')) {
    return fehler(name, 'muss ein absoluter, gueltiger Server-Mountpfad sein');
  }
  const normal = path.normalize(wert);
  if (normal === path.parse(normal).root) return fehler(name, 'darf nicht das Dateisystem-Wurzelverzeichnis sein');
  return normal;
}

function unterordner(env: NodeJS.ProcessEnv, name: string, standard: string): string {
  const wert = env[name]?.trim() || standard;
  if (wert === '.' || wert === '..' || path.isAbsolute(wert) || /[\/\\\u0000-\u001f]/.test(wert)) {
    return fehler(name, 'muss genau ein sicherer relativer Ordnername sein');
  }
  return wert;
}

function formate(env: NodeJS.ProcessEnv, name: string, katalog: string[]): string[] {
  const roh = env[name];
  if (roh === undefined) return [...katalog];
  const angefragt = [...new Set(roh.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))].sort();
  const unbekannt = angefragt.filter(f => !katalog.includes(f));
  if (unbekannt.length > 0) return fehler(name, `enthaelt nicht registrierte Formate: ${unbekannt.join(', ')}`);
  return angefragt;
}

/** Erstellt und validiert die vollstaendige Konfiguration; fuer Tests kann eine isolierte Env uebergeben werden. */
export function ladeAssetKonfiguration(env: NodeJS.ProcessEnv = process.env): AssetKonfiguration {
  const aktiv = flag(env, 'SYNAPSE_ASSET_ENABLED', false);
  const reverseAktiv = flag(env, 'SYNAPSE_REVERSE_ENABLED', false);
  const projektRoot = rootPfad(env, 'SYNAPSE_PROJEKTE_ROOT', aktiv);
  const reverseRoot = rootPfad(env, 'SYNAPSE_REVERSE_ROOT', reverseAktiv);
  const assetsUnterordner = unterordner(env, 'SYNAPSE_ASSET_ASSETS_DIR', 'assets');
  const binariesUnterordner = unterordner(env, 'SYNAPSE_ASSET_BINARIES_DIR', 'binaries');
  if (assetsUnterordner === binariesUnterordner) {
    return fehler('SYNAPSE_ASSET_ASSETS_DIR/SYNAPSE_ASSET_BINARIES_DIR', 'muessen verschieden sein');
  }

  // getPool()/getConfig() kann vor asset-intel/index.js geladen werden. Die Konfiguration
  // braucht den vollständigen Built-in-Formatkatalog daher selbst, ohne den optionalen
  // Asset-Intel-Consumer als Voraussetzung zu machen.
  standardRegistry.register(genericBinaryInspector);
  for (const inspector of alleInspektoren) standardRegistry.register(inspector);
  const katalog = standardRegistry.formats();
  const maxDateiBytes = zahl(env, 'SYNAPSE_ASSET_MAX_FILE_BYTES', 2 * GIB, 1, Number.MAX_SAFE_INTEGER);
  const maxProjektBytes = zahl(env, 'SYNAPSE_ASSET_MAX_PROJECT_BYTES', 20 * GIB, maxDateiBytes, Number.MAX_SAFE_INTEGER);
  const maxProjektDateien = zahl(env, 'SYNAPSE_ASSET_MAX_PROJECT_FILES', 100_000, 1, Number.MAX_SAFE_INTEGER);
  const syncRichtung = env.SYNAPSE_ASSET_SYNC_DIRECTION ?? 'both';
  if (!(['both', 'pc_to_share', 'share_to_pc'] as const).includes(syncRichtung as AssetSyncRichtung)) {
    return fehler('SYNAPSE_ASSET_SYNC_DIRECTION', 'erwartet both, pc_to_share oder share_to_pc');
  }

  const insp: AssetLimits = {
    maxFileBytes: zahl(env, 'SYNAPSE_ASSET_INSPECT_MAX_FILE_BYTES', DEFAULT_ASSET_LIMITS.maxFileBytes, 1, Number.MAX_SAFE_INTEGER),
    maxReadBytes: zahl(env, 'SYNAPSE_ASSET_INSPECT_MAX_READ_BYTES', DEFAULT_ASSET_LIMITS.maxReadBytes, 1, Number.MAX_SAFE_INTEGER),
    maxObjects: zahl(env, 'SYNAPSE_ASSET_INSPECT_MAX_OBJECTS', DEFAULT_ASSET_LIMITS.maxObjects, 1, Number.MAX_SAFE_INTEGER),
    timeoutMs: zahl(env, 'SYNAPSE_ASSET_INSPECT_TIMEOUT_MS', DEFAULT_ASSET_LIMITS.timeoutMs, 1, 3_600_000),
    maxDepth: zahl(env, 'SYNAPSE_ASSET_INSPECT_MAX_DEPTH', DEFAULT_ASSET_LIMITS.maxDepth, 0, 64),
    maxHashBytes: zahl(env, 'SYNAPSE_ASSET_INSPECT_MAX_HASH_BYTES', DEFAULT_ASSET_LIMITS.maxHashBytes, 1, Number.MAX_SAFE_INTEGER),
  };

  const vorschauMaxSekunden = zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_OPEN_SECONDS', 3_600, 1, 86_400);
  const vorschauStandardSekunden = zahl(env, 'SYNAPSE_ASSET_PREVIEW_OPEN_SECONDS', 300, 1, vorschauMaxSekunden);
  const reverseMaxDatei = zahl(env, 'SYNAPSE_REVERSE_MAX_FILE_BYTES', 4 * GIB, 1, Number.MAX_SAFE_INTEGER);

  return {
    aktiv,
    speicher: {
      root: projektRoot,
      reverseRoot,
      assetsUnterordner,
      binariesUnterordner,
      maxDateiBytes,
      maxProjektBytes,
      maxProjektDateien,
      maxObjekteJeDatei: zahl(
        env,
        'SYNAPSE_ASSET_MAX_OBJECTS_PER_FILE',
        env.SYNAPSE_ASSET_MAX_OBJECTS_PER_FILE === undefined && Number.isInteger(Number(env.SYNAPSE_ASSET_MAX_OBJEKTE)) && Number(env.SYNAPSE_ASSET_MAX_OBJEKTE) > 0
          ? Number(env.SYNAPSE_ASSET_MAX_OBJEKTE)
          : DEFAULT_ASSET_MAX_OBJECTS_PER_FILE,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      chunkBytes: zahl(env, 'SYNAPSE_ASSET_CHUNK_BYTES', 8 * MIB, 1, 64 * MIB),
      parallelTransfers: zahl(env, 'SYNAPSE_ASSET_PARALLEL', 2, 1, 16),
      timeoutMs: zahl(env, 'SYNAPSE_ASSET_TIMEOUT_MS', 120_000, 1, 3_600_000),
      transferFormate: formate(env, 'SYNAPSE_ASSET_TRANSFER_FORMATS', katalog),
    },
    sync: {
      richtung: syncRichtung as AssetSyncRichtung,
      scanIntervallMs: zahl(env, 'SYNAPSE_ASSET_SCAN_INTERVAL_MS', 60_000, 1_000, 86_400_000),
      retryIntervallMs: zahl(env, 'SYNAPSE_ASSET_RETRY_INTERVAL_MS', 30_000, 1_000, 86_400_000),
      parallelInspektionen: parallelInspektionenAlt(env),
      restoreWindowMs: zahl(env, 'SYNAPSE_ASSET_RESTORE_WINDOW_MS', DEFAULT_ASSET_RESTORE_WINDOW_MS, 0, 365 * TAG),
      metadatenRetentionTage: zahl(env, 'SYNAPSE_ASSET_METADATA_RETENTION_DAYS', 30, 0, 3650),
    },
    inspektion: insp,
    vorschau: {
      formate: formate(env, 'SYNAPSE_ASSET_PREVIEW_FORMATS', katalog),
      maxPixel: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_PIXELS', 16_777_216, 1, 268_435_456),
      maxBytes: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_BYTES', 8 * MIB, 1, 256 * MIB),
      maxAnzahl: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_COUNT', 5, 1, 100),
      offenSekundenStandard: vorschauStandardSekunden,
      offenSekundenObergrenze: vorschauMaxSekunden,
      maxInputBytes: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_INPUT_BYTES', 64 * MIB, 1, 256 * MIB),
      maxRamBytes: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_RAM_BYTES', GIB, 64 * MIB, 16 * GIB),
      timeoutMs: zahl(env, 'SYNAPSE_ASSET_PREVIEW_TIMEOUT_MS', 15_000, 1, 3_600_000),
      maxKante: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_EDGE', 2048, 1, 16384),
      maxFrames: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_FRAMES', 1, 1, 100),
      maxDauerMs: zahl(env, 'SYNAPSE_ASSET_PREVIEW_MAX_DURATION_MS', 12_000, 1, 60_000),
      parallelRenderer: zahl(env, 'SYNAPSE_ASSET_PREVIEW_PARALLEL', 1, 1, 8),
      ffmpeg: env.SYNAPSE_ASSET_PREVIEW_FFMPEG ?? 'ffmpeg',
      ffprobe: env.SYNAPSE_ASSET_PREVIEW_FFPROBE ?? 'ffprobe',
      prlimit: env.SYNAPSE_ASSET_PREVIEW_PRLIMIT ?? 'prlimit',
    },
    reverse: {
      aktiv: reverseAktiv,
      retentionMs: zahl(env, 'SYNAPSE_REVERSE_RETENTION_MS', 365 * TAG, 0, 3650 * TAG),
      maxDateiBytes: reverseMaxDatei,
      maxProjektBytes: zahl(env, 'SYNAPSE_REVERSE_MAX_PROJECT_BYTES', 100 * GIB, reverseMaxDatei, Number.MAX_SAFE_INTEGER),
      maxProjektDateien: zahl(env, 'SYNAPSE_REVERSE_MAX_PROJECT_FILES', 500_000, 1, Number.MAX_SAFE_INTEGER),
      maxErgebnisse: zahl(env, 'SYNAPSE_REVERSE_MAX_RESULTS', 10_000, 1, 1_000_000),
    },
  };
}

/**
 * Projektwerte duerfen nur Betreibergrenzen verschaerfen. Werte oberhalb der
 * konfigurierten Betreibergrenze sind Fehler und werden nie still gekappt.
 */
export function loeseAssetProjektoptionen(
  konfig: AssetKonfiguration,
  optionen: AssetProjektOptionen = {},
): WirksameAssetProjektoptionen {
  const max = (name: string, wert: number | undefined, deckel: number, standard: number): number => {
    if (wert === undefined) return standard;
    if (!Number.isSafeInteger(wert) || wert < 0) return fehler(name, 'muss eine nichtnegative sichere Ganzzahl sein');
    if (wert > deckel) return fehler(name, `ueberschreitet Betreibergrenze ${deckel}`);
    return wert;
  };
  const pv = optionen.vorschau ?? {};
  const richtung = optionen.richtung ?? konfig.sync.richtung;
  if (!(['both', 'pc_to_share', 'share_to_pc'] as const).includes(richtung)) {
    return fehler('Projektoption richtung', 'erwartet both, pc_to_share oder share_to_pc');
  }
  const angefragt = optionen.erlaubteTypen ?? konfig.speicher.transferFormate;
  if (!Array.isArray(angefragt) || angefragt.some(format => typeof format !== 'string' || format.trim() === '')) {
    return fehler('Projektoption erlaubteTypen', 'muss eine Liste nichtleerer Formatnamen sein');
  }
  const erlaubteTypen = [...new Set(angefragt.map(format => format.trim().toLowerCase()))].sort();
  const unbekannt = erlaubteTypen.filter(format => !konfig.speicher.transferFormate.includes(format));
  if (unbekannt.length > 0) return fehler('Projektoption erlaubteTypen', `enthaelt nicht registrierte Formate: ${unbekannt.join(', ')}`);
  const offen = max('Projektoption vorschau.offenSekundenStandard', pv.offenSekundenStandard, konfig.vorschau.offenSekundenObergrenze, konfig.vorschau.offenSekundenStandard);
  if (offen === 0) return fehler('Projektoption vorschau.offenSekundenStandard', 'muss mindestens 1 sein');
  return {
    richtung,
    restoreWindowMs: max('Projektoption restoreWindowMs', optionen.restoreWindowMs, konfig.sync.restoreWindowMs, konfig.sync.restoreWindowMs),
    maxDateiBytes: max('Projektoption maxDateiBytes', optionen.maxDateiBytes, konfig.speicher.maxDateiBytes, konfig.speicher.maxDateiBytes),
    maxProjektBytes: max('Projektoption maxProjektBytes', optionen.maxProjektBytes, konfig.speicher.maxProjektBytes, konfig.speicher.maxProjektBytes),
    maxProjektDateien: max('Projektoption maxProjektDateien', optionen.maxProjektDateien, konfig.speicher.maxProjektDateien, konfig.speicher.maxProjektDateien),
    erlaubteTypen,
    maxObjekteJeDatei: max('Projektoption maxObjekteJeDatei', optionen.maxObjekteJeDatei, konfig.speicher.maxObjekteJeDatei, konfig.speicher.maxObjekteJeDatei),
    vorschau: {
      maxPixel: max('Projektoption vorschau.maxPixel', pv.maxPixel, konfig.vorschau.maxPixel, konfig.vorschau.maxPixel),
      maxBytes: max('Projektoption vorschau.maxBytes', pv.maxBytes, konfig.vorschau.maxBytes, konfig.vorschau.maxBytes),
      maxAnzahl: max('Projektoption vorschau.maxAnzahl', pv.maxAnzahl, konfig.vorschau.maxAnzahl, konfig.vorschau.maxAnzahl),
      offenSekundenStandard: offen,
    },
  };
}

let cache: AssetKonfiguration | null = null;

/** Runtime-Einstieg; bei Fehlkonfiguration wird der Prozessstart mit Klartextfehler abgebrochen. */
export function getAssetKonfiguration(): AssetKonfiguration {
  if (!cache) cache = ladeAssetKonfiguration();
  return cache;
}

/** Fuer Tests, die mehrere Konfigurationsfaelle im selben Prozess pruefen. */
export function resetAssetKonfiguration(): void {
  cache = null;
}
