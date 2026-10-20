/**
 * P22-T58: leichte Beobachtung eines Runtime-Containers fuer die Runtime-Ueberwachung (core runtime-ueberwachung.ts).
 * Nur docker inspect und, bei laufendem Agent-Runtime-Image, 'synapse-runtime status' (liest status.json des Daemons, die er
 * alle 30 s schreibt) mit Zeitlimit. Keine CLI-/Auth-Proben wie probeStatus, damit der Takt den Container nicht belastet.
 *   Timeout/Exec-Fehler      -> prozess 'haengt'
 *   status.json fehlt / alt  -> prozess 'daemon_tot'
 *   altes Image (kein Daemon)-> prozess 'unbekannt'
 */
import type Docker from 'dockerode';
import type { ContainerBeobachtung } from '@synapse/core';
import { captureRuntimeProbe } from './probe.js';
import { istAgentRuntimeImage, AGENT_RUNTIME_IMAGE_LABEL } from './runtime-container-spez.js';
import type { RuntimeConfiguration } from './types.js';

export interface BeobachtungsOptionen {
  probe_timeout_ms: number;
  daemon_frisch_ms: number;
  env: string[];
  istEigener: (info: Docker.ContainerInspectInfo) => boolean;
  jetzt?: () => number;
}

/**
 * 'synapse-runtime status' gibt {success, ergebnis:{quelle:'daemon', erzeugt_am, ...}} aus (runtime-cli.ts), bei Fehlern {success:false, ...}.
 * Bis P22-T71 las die Beobachtung die Huelle statt ergebnis -> quelle fehlte -> JEDER gesunde Container galt als daemon_tot
 * ('status.json fehlt', Abloesung der Ueberwachung). Zusaetzlich die alte flache Form akzeptieren (Tests, aeltere Images).
 */
export function leseStatusAusgabe(stdout: string): { quelle?: unknown; erzeugt_am?: unknown } | null {
  const zeile = stdout.trim();
  if (!zeile) return null;
  const roh = JSON.parse(zeile) as { success?: unknown; ergebnis?: unknown } | null;
  if (!roh || typeof roh !== 'object') return null;
  if (roh.success === false) return null;
  const innen = roh.ergebnis && typeof roh.ergebnis === 'object' ? roh.ergebnis : roh;
  return innen as { quelle?: unknown; erzeugt_am?: unknown };
}

const kurz = (e: unknown): string => ((e as Error)?.message ?? String(e)).slice(0, 300);

export async function beobachteRuntimeContainer(
  docker: Docker, config: RuntimeConfiguration | null, o: BeobachtungsOptionen,
): Promise<ContainerBeobachtung> {
  const basis: ContainerBeobachtung = { container: 'nicht_konfiguriert', prozess: 'unbekannt', status_alter_s: null, image: null, agent_runtime_image: false, fehler: null };
  if (!config) return basis;
  const container = docker.getContainer(config.containerName);
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch (error) {
    if (/no such container/i.test(kurz(error))) return { ...basis, container: 'fehlt', image: config.image, agent_runtime_image: istAgentRuntimeImage(config.image) };
    return { ...basis, container: 'fehler', fehler: kurz(error) };
  }
  const image = info.Config?.Image ?? null;
  const agentImage = info.Config?.Labels?.['synapse.runtime-image'] === AGENT_RUNTIME_IMAGE_LABEL || istAgentRuntimeImage(image);
  const stand = { ...basis, image, agent_runtime_image: agentImage };
  if (!o.istEigener(info)) return { ...stand, container: 'fremd' };
  if (info.State?.Restarting) return { ...stand, container: 'restarting' };
  if (!info.State?.Running) return { ...stand, container: 'gestoppt' };
  if (!agentImage) return { ...stand, container: 'laeuft' };
  let r: { stdout: string; stderr: string; exitCode: number | null };
  try {
    r = await captureRuntimeProbe(docker, container, ['synapse-runtime', 'status'], o.env, o.probe_timeout_ms);
  } catch (error) {
    return { ...stand, container: 'laeuft', prozess: 'haengt', fehler: kurz(error) };
  }
  if (r.exitCode === 127) return { ...stand, container: 'laeuft', prozess: 'unbekannt', fehler: 'synapse-runtime fehlt im Image' };
  let s: { quelle?: unknown; erzeugt_am?: unknown } | null = null;
  try { s = leseStatusAusgabe(r.stdout); } catch { s = null; }
  if (!s || s.quelle !== 'daemon' || typeof s.erzeugt_am !== 'string' || !Number.isFinite(Date.parse(s.erzeugt_am))) {
    return { ...stand, container: 'laeuft', prozess: 'daemon_tot', fehler: r.exitCode === 0 ? 'status.json fehlt' : ('synapse-runtime status Exit ' + String(r.exitCode)) };
  }
  const alterMs = (o.jetzt ?? Date.now)() - Date.parse(s.erzeugt_am);
  return bewerteAlter(stand, alterMs, o.daemon_frisch_ms);
}

function bewerteAlter(stand: ContainerBeobachtung, alterMs: number, frischMs: number): ContainerBeobachtung {
  const alter = Math.max(0, Math.round(alterMs / 1000));
  if (alterMs > frischMs) return { ...stand, container: 'laeuft', prozess: 'daemon_tot', status_alter_s: alter, fehler: 'status.json veraltet' };
  return { ...stand, container: 'laeuft', prozess: 'ok', status_alter_s: alter };
}

/**
 * P22-T58 F5: CLI-Update im Container ueber den T4-Weg ('synapse-runtime cli update <cli> latest'): neue Version daneben,
 * Launcher atomar umschalten, alte Versionen bleiben (cli_behalten des Daemons), Rollback per 'cli rollback'. Laufende Agenten
 * werden nicht neu gestartet. Nur eigene, laufende Container mit Agent-Runtime-Image.
 */
export async function fuehreCliUpdateImContainerAus(
  docker: Docker, config: RuntimeConfiguration | null, runtime: 'claude' | 'codex', o: { timeout_ms: number; env: string[]; istEigener: (info: Docker.ContainerInspectInfo) => boolean },
): Promise<{ ok: boolean; exit_code: number | null; ausgabe: string }> {
  if (!config) return { ok: false, exit_code: null, ausgabe: 'nicht_konfiguriert' };
  const container = docker.getContainer(config.containerName);
  const info = await container.inspect();
  if (!o.istEigener(info)) return { ok: false, exit_code: null, ausgabe: 'fremder_container' };
  if (!info.State?.Running) return { ok: false, exit_code: null, ausgabe: 'container_laeuft_nicht' };
  if (!(info.Config?.Labels?.['synapse.runtime-image'] === AGENT_RUNTIME_IMAGE_LABEL || istAgentRuntimeImage(info.Config?.Image))) {
    return { ok: false, exit_code: null, ausgabe: 'kein_agent_runtime_image' };
  }
  const r = await captureRuntimeProbe(docker, container, ['synapse-runtime', 'cli', 'update', runtime, 'latest', '--akteur', 'api-auto'], o.env, o.timeout_ms);
  return { ok: r.exitCode === 0, exit_code: r.exitCode, ausgabe: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-2000) };
}
