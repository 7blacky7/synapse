/**
 * MODUL: gpu-helfer-datei.ts (P15-T12 E2, Ergaenzung zu P15-T11, 11.10.2026)
 * ZWECK: Einstellungen des lokalen GPU-Helfers ueber die intern-Bruecke aendern und anzeigen.
 *   ~/.synapse/file-watcher/gpu-helfer.json gehoert dem Tray ({lan_bevorzugen, embed_pause_ms}); der
 *   Tray prueft sie alle 5 s und startet einen laufenden Helfer bei Abweichung selbst neu. Der Daemon
 *   aendert nur die genannten Schluessel, fremde bleiben erhalten, Schreiben atomar (tmp + rename).
 *   NICHT config.json: die haelt der Daemon im Speicher und ueberschreibt sie beim naechsten Speichern.
 *   gpu-helfer-status.json schreibt der Helfer selbst (aktive Adresse, Rueckfall, Pause) — nur lesen.
 */

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';

const EINSTELLUNGEN = 'gpu-helfer.json';
const STATUS = 'gpu-helfer-status.json';

function leseJson(datei: string): { daten: Record<string, unknown> | null; fehler?: string } {
  try {
    const roh = fs.readFileSync(datei, 'utf8');
    const p: unknown = JSON.parse(roh);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { daten: null, fehler: 'kein JSON-Objekt' };
    return { daten: p as Record<string, unknown> };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { daten: null };
    return { daten: null, fehler: (err as Error).message };
  }
}

/** gpu_helfer_status: beide Dateien, fehlende als null. */
export function gpuHelferStatus(): Record<string, unknown> {
  const dir = configDir();
  const e = leseJson(path.join(dir, EINSTELLUNGEN));
  const s = leseJson(path.join(dir, STATUS));
  return {
    success: true,
    action: 'gpu_helfer_status',
    einstellungen: e.daten,
    ...(e.fehler ? { einstellungen_fehler: e.fehler } : {}),
    status: s.daten,
    ...(s.fehler ? { status_fehler: s.fehler } : {}),
    hinweis: e.daten ? undefined : 'gpu-helfer.json fehlt: es gilt LAN aus (nur oeffentliche URL) und die Standard-Pause von core.',
  };
}

/**
 * gpu_helfer_einstellen: lan_bevorzugen (bool | null) und/oder embed_pause_ms (ganze Zahl >= 0 | null).
 * null entfernt den Schluessel. Andere Schluessel bleiben erhalten.
 */
export function gpuHelferEinstellen(args: Record<string, unknown>): Record<string, unknown> {
  const action = 'gpu_helfer_einstellen';
  const hatLan = 'lan_bevorzugen' in args && args.lan_bevorzugen !== undefined;
  const hatPause = 'embed_pause_ms' in args && args.embed_pause_ms !== undefined;
  if (!hatLan && !hatPause) {
    return { success: false, action, error: 'parameter_fehlt', message: 'lan_bevorzugen und/oder embed_pause_ms angeben (null entfernt den Schluessel).' };
  }
  if (hatLan && args.lan_bevorzugen !== null && typeof args.lan_bevorzugen !== 'boolean') {
    return { success: false, action, error: 'parameter_ungueltig', message: 'lan_bevorzugen: true | false | null.' };
  }
  const pause = args.embed_pause_ms;
  if (hatPause && pause !== null && !(typeof pause === 'number' && Number.isInteger(pause) && pause >= 0)) {
    return { success: false, action, error: 'parameter_ungueltig', message: 'embed_pause_ms: ganze Zahl >= 0 oder null.' };
  }
  const dir = configDir();
  const datei = path.join(dir, EINSTELLUNGEN);
  const vorher = leseJson(datei);
  if (vorher.fehler) {
    return { success: false, action, error: 'datei_unlesbar', message: `${EINSTELLUNGEN} ist nicht lesbar (${vorher.fehler}) — nichts geaendert.` };
  }
  const neu: Record<string, unknown> = { ...(vorher.daten ?? {}) };
  if (hatLan) {
    if (args.lan_bevorzugen === null) delete neu.lan_bevorzugen;
    else neu.lan_bevorzugen = args.lan_bevorzugen;
  }
  if (hatPause) {
    if (pause === null) delete neu.embed_pause_ms;
    else neu.embed_pause_ms = pause;
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${datei}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(neu, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, datei);
  console.error(`[intern-bruecke] ${EINSTELLUNGEN} geaendert: ${JSON.stringify(neu)}`);
  return {
    success: true,
    action,
    vorher: vorher.daten,
    einstellungen: neu,
    hinweis: 'Der Tray uebernimmt die Aenderung binnen ~5 s und startet einen laufenden GPU-Helfer selbst neu.',
  };
}
