/**
 * MODUL: intern-bruecke.ts (P15-T12, Etappe 2, 11.10.2026)
 * ZWECK: Debug-Steuerung dieses Daemons durch das Tool 'intern' der API (worker_status,
 *        worker_pausieren, worker_fortsetzen, worker_durchlauf mit prozess "daemon").
 *
 * WEG: die bestehende API-Bruecke des Daemons — synapse_api_url + synapse_api_token aus
 *   ~/.synapse/file-watcher/config.json (leseApiZugang, wie skills-proxy.ts). Kein eigener Token,
 *   keine PG-Tabelle, keine Aenderung am Tray.
 * ABLAUF: Long-Poll GET /api/intern/daemon/befehle?host=<hostname>&warte=25.
 *   - debug:false (API ohne SYNAPSE_INTERN_TOOL=1) oder 404 (alte API) -> keine Steuerung, neuer
 *     Versuch nach 60 s.
 *   - debug:true -> beim ersten Mal (auch nach jedem Wiederverbinden) Anmeldung mit worker_status,
 *     dann Befehle ausfuehren und per POST /api/intern/daemon/antwort melden.
 *   - Fehler (API-Neustart, Netz) -> Backoff 1..30 s, danach wird der Modus neu erkannt.
 * Ausfuehrbar sind nur die Befehle aus DAEMON_BEFEHLE (core) — kein Shell. Einziger Dateizugriff:
 * sync_datei (P15-T23) liest eine Datei eines in config.json eingetragenen Projekts (stat + Hash,
 * kein Ausbruch aus dem Projektpfad, nur lesend).
 * AUS: DAEMON_INTERN_BRUECKE_DISABLED=1.
 */

import os from 'node:os';
import { DAEMON_BEFEHLE, fuehreDiagnoseLokal, skillNutzungLokal, fuehreWorkerActionAus, fuehreWarteschlangeLokal, workerStatus } from '@synapse/core';
import { findProjekt, loadConfig } from './config.js';
import { leseApiZugang } from './skills-proxy.js';
import { gpuHelferEinstellen, gpuHelferStatus } from './gpu-helfer-datei.js';
// P9-T27 letzter Schritt: sync_datei liest den PG-Stand im API-Weg ueber die API.
import { daemonJobsWeg } from './daemon-jobs-api.js';
import { apiSyncDateiZugriff } from './daemon-sync-api.js';
import { uebernehmeTrayTokenFreigabe, verwerfeTrayTokenFreigabe } from './tray-token-weiterleitung.js';

const HOST = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128) || 'daemon';
const PROZESS = `daemon:${HOST}`;
const POLL_S = 25;
const DEBUG_AUS_PAUSE_MS = 60_000;

export interface InternBrueckeHandle {
  stop: () => void;
}

interface Befehl {
  id: string;
  befehl: string;
  args?: Record<string, unknown>;
}

const schlafe = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export function startInternBruecke(): InternBrueckeHandle {
  verwerfeTrayTokenFreigabe();
  let stopped = false;
  let laufend: AbortController | null = null;
  /** null = noch nicht erkannt bzw. nach Verbindungsfehler neu erkennen */
  let debug: boolean | null = null;
  let fehlerZyklen = 0;
  let fehlerGemeldet = false;

  async function anfrage(pfad: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown> | 'nicht_gefunden'> {
    const { url, token } = leseApiZugang();
    if (!token) throw new Error('kein synapse_api_token in config.json (Tray: Verbindung einrichten)');
    const controller = new AbortController();
    laufend = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}${pfad}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 404) return 'nicht_gefunden';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
      if (laufend === controller) laufend = null;
    }
  }

  async function melde(body: Record<string, unknown>): Promise<void> {
    try {
      await anfrage('/api/intern/daemon/antwort', { method: 'POST', body: JSON.stringify({ host: HOST, ...body }) }, 10_000);
    } catch (err) {
      verwerfeTrayTokenFreigabe();
      console.error(`[intern-bruecke] Antwort an die API fehlgeschlagen: ${(err as Error).message}`);
    }
  }

  async function fuehreAus(b: Befehl): Promise<void> {
    let ergebnis: Record<string, unknown>;
    if (!(DAEMON_BEFEHLE as readonly string[]).includes(b.befehl)) {
      // P15-T29: eigene Allowlist mitschicken, damit die API fehlende Befehle (veralteter Build) benennen kann
      ergebnis = {
        success: false, error: 'befehl_unbekannt', message: `Befehl ${b.befehl} wird vom Daemon nicht ausgefuehrt.`,
        daemon_befehle: [...DAEMON_BEFEHLE],
      };
    } else {
      const args = b.args ?? {};
      try {
        if (b.befehl === 'gpu_helfer_status') ergebnis = gpuHelferStatus();
        else if (b.befehl === 'gpu_helfer_einstellen') ergebnis = gpuHelferEinstellen(args);
        // P15-T12 E3/E4: Speicher-Warteschlangen dieses Daemons (warteschlangen-register)
        else if (b.befehl.startsWith('warteschlange_')) ergebnis = await fuehreWarteschlangeLokal(b.befehl, args, PROZESS);
        // P10-T44: JSONL-Nutzung nur lesen; Ergebnisse enthalten keine Transcript-Inhalte.
        else if (b.befehl === 'skills_scan') {
          if (typeof args.project === 'string') {
            const projekt = findProjekt(loadConfig(), args.project);
            if (!projekt) throw Object.assign(new Error('Projekt unbekannt.'), { code: 'projekt_unbekannt' });
            ergebnis = await skillNutzungLokal(args, projekt.pfad);
          } else {
            ergebnis = await skillNutzungLokal(args);
          }
        }
        // P15-T23: Diagnose im Daemon (Plattenstand einer Datei, Parser-Pool dieses Prozesses)
        else if (b.befehl === 'sync_datei' || b.befehl === 'parser_pool') {
          ergebnis = await fuehreDiagnoseLokal(b.befehl, args, {
            prozess: PROZESS,
            projektPfad: (name) => findProjekt(loadConfig(), name)?.pfad,
            ...(daemonJobsWeg() === 'api' ? { pgZugriff: apiSyncDateiZugriff } : {}),
          });
        }
        else ergebnis = await fuehreWorkerActionAus(b.befehl, args, typeof args.von === 'string' ? args.von : undefined, PROZESS);
      } catch (err) {
        const e = err as Error & { code?: string };
        ergebnis = { success: false, action: b.befehl, error: e.code ?? 'daemon_fehler', message: e.message };
      }
    }
    console.error(`[intern-bruecke] Befehl ${b.befehl} ausgefuehrt (${ergebnis.success === false ? `Fehler ${String(ergebnis.error)}` : 'ok'})`);
    await melde({ id: b.id, ergebnis });
  }

  void (async () => {
    while (!stopped) {
      try {
        // Anmeldung (Modus noch unbekannt) ohne Warten, damit die Steuerung sofort frei ist; danach Long-Poll.
        const warteS = debug === true ? POLL_S : 0;
        const antwort = await anfrage(`/api/intern/daemon/befehle?host=${encodeURIComponent(HOST)}&warte=${warteS}`, { method: 'GET' }, (POLL_S + 10) * 1000);
        if (fehlerGemeldet) {
          console.error('[intern-bruecke] API wieder erreichbar');
          fehlerGemeldet = false;
        }
        fehlerZyklen = 0;
        if (stopped) break;
        uebernehmeTrayTokenFreigabe(antwort);
        if (antwort === 'nicht_gefunden' || antwort.debug !== true) {
          if (debug !== false) {
            console.error(debug === true
              ? '[intern-bruecke] Debug-Modus der API aus — Steuerung gesperrt'
              : `[intern-bruecke] API ohne Debug-Modus (SYNAPSE_INTERN_TOOL) — keine Steuerung, pruefe alle ${DEBUG_AUS_PAUSE_MS / 1000} s`);
            debug = false;
          }
          await schlafe(DEBUG_AUS_PAUSE_MS);
          continue;
        }
        if (debug !== true) {
          debug = true;
          console.error(`[intern-bruecke] Debug-Modus der API erkannt — Steuerung frei (${PROZESS})`);
          void melde({ anmeldung: true, worker_status: workerStatus() });
        }
        const befehle = Array.isArray(antwort.befehle) ? (antwort.befehle as Befehl[]) : [];
        for (const b of befehle) await fuehreAus(b);
      } catch (err) {
        verwerfeTrayTokenFreigabe();
        if (stopped) break;
        fehlerZyklen = Math.min(fehlerZyklen + 1, 30);
        if (!fehlerGemeldet) {
          console.error(`[intern-bruecke] API nicht erreichbar (${(err as Error).message}) — neuer Versuch mit Backoff bis 30 s`);
          fehlerGemeldet = true;
        }
        debug = null; // nach dem Wiederverbinden Modus neu erkennen und neu anmelden
        await schlafe(1_000 * fehlerZyklen);
      }
    }
  })();

  console.error(`[intern-bruecke] aktiv (host=${HOST}, Long-Poll ${POLL_S} s)`);
  return {
    stop: () => {
      stopped = true;
      verwerfeTrayTokenFreigabe();
      laufend?.abort();
    },
  };
}
