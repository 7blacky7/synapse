/**
 * P9-T31: Ordner-Loeschauftraege ueber die API abholen (kein PG vom PC).
 *
 * Die API legt einen Ordner-Auftrag erst an, NACHDEM der User den Loesch-Auftrag mit dem Loesch-Code
 * GENAU dieses Rechners bestaetigt hat (core projekt-loeschen.ts). Hier wird nur noch ausgefuehrt — und auch
 * das nur, wenn alle Pruefungen halten; im Zweifel wird NICHTS geloescht und 'failed' gemeldet:
 *  - config.json kennt das Projekt und sein Pfad ist GENAU der Pfad aus dem Auftrag.
 *  - Pfad absolut, ohne Symlink-Anteile (realpath == resolve), echtes Verzeichnis.
 *  - Pfad liegt STRIKT unter der Workspace-Wurzel (nie die Wurzel selbst, nie $HOME, nie /).
 *  - Kein anderes registriertes Projekt (und keine Reverse-Bibliothek) liegt im Ordner oder umschliesst ihn.
 * Reihenfolge: erst Watcher stoppen + config.json-Eintrag entfernen (sonst wuerden die Loesch-Events als
 * Dateiloeschungen nach Synapse gemeldet), dann Ordner rekursiv entfernen (Symlinks im Ordner werden als
 * Link entfernt, nie verfolgt).
 *
 * Vertrag: POST /api/project-init/projekt-loeschen/claim -> {jobs:[{id,project,pfad}]}
 *          POST /api/project-init/projekt-loeschen/:id/complete {status:'done'|'failed', message}
 * Alte API ohne Route (404) oder fehlende PC-Zuordnung (403) -> still, naechster Versuch spaeter.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AssetApiTransport, AssetApiFehler } from './asset-api-transport.js';
import type { WatcherManager } from './manager.js';
import { getWorkspaceRoot, reverseBibliothekPfad } from './config.js';

interface OrdnerJob { id: string; project: string; pfad: string }

function innerhalb(eltern: string, kind: string): boolean {
  const rel = path.relative(eltern, kind);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Liefert den zu loeschenden Pfad oder wirft mit Begruendung (dann wird nichts geloescht). */
export function pruefeLoeschPfad(
  job: OrdnerJob,
  manager: Pick<WatcherManager, 'get' | 'list' | 'getConfig'>,
  wurzelRoh = getWorkspaceRoot(),
): { pfad: string; existiert: boolean } {
  if (!job || typeof job.project !== 'string' || typeof job.pfad !== 'string' || !job.pfad) throw new Error('auftrag_unvollstaendig');
  if (!path.isAbsolute(job.pfad)) throw new Error('pfad_nicht_absolut');
  const eintrag = manager.get(job.project);
  if (!eintrag) throw new Error('config_eintrag_fehlt: Projekt ist auf diesem Rechner nicht registriert — nichts geloescht.');
  const ziel = path.resolve(job.pfad);
  if (path.resolve(eintrag.pfad) !== ziel) throw new Error('pfad_abweichung: config.json-Pfad weicht vom Auftrag ab — nichts geloescht.');
  const wurzel = path.resolve(wurzelRoh);
  const heim = path.resolve(os.homedir());
  if (ziel === path.parse(ziel).root || ziel === wurzel || ziel === heim) throw new Error('pfad_gesperrt: Wurzel/Home wird nie geloescht.');
  if (!innerhalb(wurzel, ziel) || path.relative(wurzel, ziel) === '') {
    throw new Error(`pfad_ausserhalb_workspace: ${ziel} liegt nicht unter ${wurzel} — bitte selbst loeschen.`);
  }
  if (innerhalb(ziel, heim)) throw new Error('pfad_gesperrt: Ordner umschliesst das Home-Verzeichnis.');
  for (const p of manager.list()) {
    if (p.name === job.project) continue;
    const anderer = path.resolve(p.pfad);
    if (innerhalb(ziel, anderer) || innerhalb(anderer, ziel)) {
      throw new Error(`pfad_ueberlappt: Projekt "${p.name}" (${anderer}) liegt im/um den Ordner — nichts geloescht.`);
    }
  }
  try {
    const reverse = path.resolve(reverseBibliothekPfad(manager.getConfig()));
    if (innerhalb(ziel, reverse) || innerhalb(reverse, ziel)) throw new Error('pfad_ueberlappt: Reverse-Bibliothek liegt im/um den Ordner.');
  } catch (err) {
    if ((err as Error).message.startsWith('pfad_ueberlappt')) throw err;
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(ziel);
  } catch {
    return { pfad: ziel, existiert: false };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('pfad_kein_verzeichnis: Ziel ist ein Symlink oder keine Verzeichnis — nichts geloescht.');
  if (fs.realpathSync(ziel) !== ziel) throw new Error('pfad_symlink: Pfad enthaelt Symlinks — nichts geloescht.');
  return { pfad: ziel, existiert: true };
}

export async function verarbeiteOrdnerLoeschungen(manager: WatcherManager, api = new AssetApiTransport()): Promise<number> {
  const antwort = await api.json<{ jobs?: OrdnerJob[] }>('/api/project-init/projekt-loeschen/claim', {});
  let n = 0;
  for (const job of antwort.jobs ?? []) {
    let status: 'done' | 'failed' = 'done';
    let message: string;
    try {
      const { pfad, existiert } = pruefeLoeschPfad(job, manager);
      // Erst Watcher stoppen und Eintrag entfernen: Loesch-Events duerfen nicht nach Synapse laufen.
      await manager.unregister(job.project);
      if (existiert) {
        fs.rmSync(pfad, { recursive: true, force: false, maxRetries: 2 });
        message = `Ordner ${pfad} geloescht, config.json-Eintrag entfernt.`;
      } else {
        message = `Ordner ${pfad} existierte nicht mehr; config.json-Eintrag entfernt.`;
      }
    } catch (err) {
      status = 'failed';
      message = (err as Error).message;
    }
    console.error(`[projekt-loeschen] ${job.project}: ${status} — ${message}`);
    await api.json('/api/project-init/projekt-loeschen/' + encodeURIComponent(job.id) + '/complete', { status, message });
    n++;
  }
  return n;
}

export function startProjektLoeschenWorker(
  manager: WatcherManager,
  api = new AssetApiTransport(),
  intervallMs = Number(process.env.PROJEKT_LOESCHEN_INTERVAL_MS ?? 30_000),
): { stop: () => Promise<void> } {
  let busy = false;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      await verarbeiteOrdnerLoeschungen(manager, api);
    } catch (e) {
      const still = e instanceof AssetApiFehler && [0, 401, 403, 404, 426, 503].includes(e.status);
      if (!still) console.error('[projekt-loeschen] ' + (e as Error).message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { if (!busy) running = tick(); }, intervallMs);
  timer.unref();
  running = tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}
