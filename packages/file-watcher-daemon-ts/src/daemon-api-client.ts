/**
 * MODUL: daemon-api-client.ts (P22-T4, W2a; W0c-Bericht 502500cd Abschn. 3 "daemon-api-client")
 * ZWECK: Gemeinsamer HTTP-Weg des Daemons zur Synapse-API. Der ZUGANG wird injiziert statt fest verdrahtet:
 *          - PC:      pcApiZugang()      = synapse_api_url + synapse_api_token aus ~/.synapse/file-watcher/config.json,
 *                                          vom Tray nach der TOTP-Anmeldung geschrieben (leseApiZugang, unveraendert).
 *          - Runtime: runtimeApiZugang() = DIESELBE Datei und dieselben Felder im Container
 *                                          (/root/.synapse/file-watcher/config.json, persistenter home-Mount, 0600).
 *                                          Schreiber ist dort die API per docker exec (P22-T5, Vertrag 462ccb13 F3/F4),
 *                                          weil kein Tray laeuft. Fehlt der Token, gibt es keinen Zugang und KEINEN
 *                                          Rueckfall (kein PG).
 *        Unterschied der beiden Zugaenge ist nur die Art (fuer Status/Meldungen); der Server bindet den Runtime-Token
 *        an die Runtime (scope runtime-daemon:<runtime>), nicht an einen PC-Host.
 *
 * Der Bearer hier ist Client-Auth (auth_tokens), NICHT der Agenten-Ausweis (sai_). Keine Zugangswerte in Logs.
 */
import { leseApiZugang } from './skills-proxy.js';

export type ApiZugangArt = 'pc-tray' | 'runtime';

export interface ApiZugang {
  art: ApiZugangArt;
  url: string;
  token: string | null;
  /** Meldung, wenn token fehlt (ohne Zugangswerte). */
  fehltHinweis: string;
}

export type ApiZugangQuelle = () => ApiZugang;

export class DaemonApiFehler extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** PC: bisheriger Zugang des Trays. */
export function pcApiZugang(): ApiZugang {
  const { url, token } = leseApiZugang();
  return { art: 'pc-tray', url, token, fehltHinweis: 'kein synapse_api_token in config.json (Tray: Verbindung einrichten)' };
}

/** Runtime: gleiche config.json im Container; ausgestellt vom User in der Web-UI (P22-T5). */
export function runtimeApiZugang(): ApiZugang {
  const { url, token } = leseApiZugang();
  return { art: 'runtime', url, token,
    fehltHinweis: 'kein synapse_api_token in ~/.synapse/file-watcher/config.json (Runtime-Daemon-Zugang stellt der User in der Web-UI aus, P22-T5)' };
}

/**
 * Eine JSON-Anfrage an die API ueber den injizierten Zugang. Wirft DaemonApiFehler (kein_token, HTTP-Status)
 * statt still zurueckzufallen.
 */
export async function apiAnfrage<T>(
  zugangQuelle: ApiZugangQuelle,
  pfad: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const { url, token, fehltHinweis } = zugangQuelle();
  if (!token) throw new DaemonApiFehler(fehltHinweis, 0, 'kein_token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const weiter = () => controller.abort();
  signal?.addEventListener('abort', weiter, { once: true });
  try {
    const res = await fetch(`${url}${pfad}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    let daten: Record<string, unknown> = {};
    try { daten = (await res.json()) as Record<string, unknown>; } catch { /* leerer Body */ }
    if (!res.ok) {
      const code = typeof daten.error === 'string' ? daten.error : undefined;
      const hinweis = res.status === 404 && !code ? ' (API ohne Daemon-Job-Routen — veralteter Stand?)' : '';
      throw new DaemonApiFehler(`HTTP ${res.status}${code ? ` ${code}` : ''} bei ${pfad}${hinweis}`, res.status, code);
    }
    return daten as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', weiter);
  }
}
