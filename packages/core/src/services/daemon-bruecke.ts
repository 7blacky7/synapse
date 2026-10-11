/**
 * MODUL: Daemon-Bruecke (P15-T12, Etappe 2, 11.10.2026)
 * ZWECK: Steuerbefehle des Tools 'intern' an lokale FileWatcher-Daemons zustellen und ihre Antworten
 *        zurueckgeben — ueber die bestehende API-Bruecke des Daemons (synapse_api_url + Service-Token
 *        aus ~/.synapse/file-watcher/config.json), NICHT ueber PG (User-Entscheidung 11.10.2026).
 *
 * ABLAUF: Der Daemon pollt GET /api/intern/daemon/befehle (Long-Poll bis 25 s, routes/intern-daemon.ts).
 *   Ist SYNAPSE_INTERN_TOOL in der API aus, bekommt er debug:false und hat keine Steuerung. Sonst holt er
 *   hier anliegende Befehle ab und meldet Ergebnisse per POST /api/intern/daemon/antwort.
 *   sendeAnDaemon() legt einen Befehl in die Warteschlange des Hosts, weckt dessen wartenden Poll und
 *   wartet hoechstens timeoutMs auf die Antwort.
 * ZUSTAND: nur im Speicher dieses API-Prozesses. Ein API-Neustart verwirft offene Befehle; der Daemon
 *   verbindet sich von selbst neu und erkennt den Modus dabei.
 * NEBENEFFEKTE: keine ausser Log.
 */

import { randomUUID } from 'node:crypto';

/** Was ein Daemon ausfuehren darf (Allowlist auch auf der Daemon-Seite). */
export const DAEMON_BEFEHLE = [
  'worker_status', 'worker_pausieren', 'worker_fortsetzen', 'worker_durchlauf',
  // P15-T11/T12: Einstellungen des lokalen GPU-Helfers (gpu-helfer.json, der Tray setzt sie um)
  'gpu_helfer_einstellen', 'gpu_helfer_status',
] as const;
export type DaemonBefehlName = (typeof DAEMON_BEFEHLE)[number];

export interface DaemonBefehl {
  id: string;
  befehl: DaemonBefehlName;
  args: Record<string, unknown>;
  erstellt: string;
}

export interface DaemonUebersicht {
  host: string;
  verbunden: boolean;
  angemeldet_seit: string;
  letzter_poll: string;
  wartet_gerade: boolean;
  offene_befehle: number;
  pausiert: string[] | null;
  status_am: string | null;
}

export class DaemonBrueckeFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface Eintrag {
  host: string;
  angemeldetSeit: number;
  letzterPoll: number;
  warteschlange: DaemonBefehl[];
  wecker: (() => void) | null;
  workerStatus: unknown;
  pausiert: string[] | null;
  statusAm: number | null;
}

const daemons = new Map<string, Eintrag>();
const offen = new Map<string, { host: string; erledige: (ergebnis: Record<string, unknown>) => void }>();

/** Ein Daemon gilt als verbunden, wenn er in dieser Zeit gepollt hat (Poll alle <= 25 s). */
const VERBUNDEN_MS = 60_000;

export function istGueltigerHost(host: unknown): host is string {
  return typeof host === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(host);
}

function eintrag(host: string): Eintrag {
  let e = daemons.get(host);
  if (!e) {
    e = {
      host, angemeldetSeit: Date.now(), letzterPoll: Date.now(), warteschlange: [], wecker: null,
      workerStatus: null, pausiert: null, statusAm: null,
    };
    daemons.set(host, e);
    console.error(`[daemon-bruecke] Daemon ${host} angemeldet (Debug-Steuerung frei)`);
  }
  return e;
}

function pausierteAus(status: unknown): string[] | null {
  if (!Array.isArray(status)) return null;
  return status
    .filter((w) => w && typeof w === 'object' && (w as { zustand?: unknown }).zustand === 'pausiert')
    .map((w) => String((w as { name?: unknown }).name));
}

/**
 * Long-Poll des Daemons: liefert sofort anliegende Befehle oder wartet bis warteMs auf einen.
 * Ein neuer Poll desselben Hosts beendet einen noch wartenden alten (der liefert dann leer).
 */
export async function holeDaemonBefehle(host: string, warteMs: number): Promise<DaemonBefehl[]> {
  const e = eintrag(host);
  e.letzterPoll = Date.now();
  if (e.warteschlange.length === 0 && warteMs > 0) {
    e.wecker?.();
    await new Promise<void>((resolve) => {
      let fertig = false;
      const wecke = (): void => {
        if (fertig) return;
        fertig = true;
        clearTimeout(timer);
        if (e.wecker === wecke) e.wecker = null;
        resolve();
      };
      const timer = setTimeout(wecke, warteMs);
      timer.unref?.();
      e.wecker = wecke;
    });
  }
  e.letzterPoll = Date.now();
  return e.warteschlange.splice(0);
}

/** Befehle, die ein abgebrochener Poll nicht mehr zustellen konnte, wieder vorne einreihen. */
export function stelleDaemonBefehleZurueck(host: string, befehle: DaemonBefehl[]): void {
  if (befehle.length === 0) return;
  const e = eintrag(host);
  e.warteschlange.unshift(...befehle);
}

/** Antwort des Daemons zu einem Befehl. false = kein offener Befehl mit dieser id (z. B. schon abgelaufen). */
export function meldeDaemonAntwort(host: string, id: string, ergebnis: Record<string, unknown>): boolean {
  const o = offen.get(id);
  if (!o || o.host !== host) return false;
  offen.delete(id);
  o.erledige(ergebnis);
  // Stand der Pausen mitfuehren, damit die API (z. B. shell) ihn ohne Rueckfrage kennt.
  const status = (ergebnis as { worker?: unknown }).worker;
  if (status !== undefined) meldeDaemonStatus(host, status);
  return true;
}

/** Momentaufnahme der Worker eines Daemons (bei Anmeldung und nach jedem Statusbefehl). */
export function meldeDaemonStatus(host: string, workerStatus: unknown): void {
  const e = eintrag(host);
  e.workerStatus = workerStatus;
  e.pausiert = pausierteAus(workerStatus);
  e.statusAm = Date.now();
}

function verbundene(jetzt = Date.now()): Eintrag[] {
  return [...daemons.values()].filter((e) => e.wecker !== null || jetzt - e.letzterPoll < VERBUNDEN_MS);
}

/** Uebersicht aller Daemons, die sich seit dem Start dieser API gemeldet haben. */
export function daemonUebersicht(): DaemonUebersicht[] {
  const jetzt = Date.now();
  return [...daemons.values()].map((e) => ({
    host: e.host,
    verbunden: e.wecker !== null || jetzt - e.letzterPoll < VERBUNDEN_MS,
    angemeldet_seit: new Date(e.angemeldetSeit).toISOString(),
    letzter_poll: new Date(e.letzterPoll).toISOString(),
    wartet_gerade: e.wecker !== null,
    offene_befehle: e.warteschlange.length,
    pausiert: e.pausiert,
    status_am: e.statusAm ? new Date(e.statusAm).toISOString() : null,
  }));
}

/** Alles vergessen und wartende Polls beenden (Tests, Schliessen der API). */
export function vergissDaemons(): void {
  for (const e of daemons.values()) e.wecker?.();
  daemons.clear();
  offen.clear();
}

/**
 * Stellt einen Befehl an einen Daemon zu und wartet auf die Antwort. Ohne host: der einzige verbundene
 * Daemon; mehrere -> Fehler mit Liste. Wirft DaemonBrueckeFehler (daemon_nicht_verbunden,
 * daemon_mehrdeutig, daemon_antwortet_nicht, befehl_unbekannt).
 */
export async function sendeAnDaemon(
  befehl: string,
  args: Record<string, unknown>,
  hostWunsch?: string,
  timeoutMs = 10_000,
): Promise<{ host: string; ergebnis: Record<string, unknown> }> {
  if (!(DAEMON_BEFEHLE as readonly string[]).includes(befehl)) {
    throw new DaemonBrueckeFehler('befehl_unbekannt', `Befehl ${befehl} ist fuer Daemons nicht vorgesehen (${DAEMON_BEFEHLE.join(', ')}).`);
  }
  const da = verbundene();
  let ziel: Eintrag | undefined;
  if (hostWunsch) {
    ziel = da.find((e) => e.host === hostWunsch);
    if (!ziel) {
      const bekannt = daemons.get(hostWunsch);
      throw new DaemonBrueckeFehler('daemon_nicht_verbunden', bekannt
        ? `Daemon ${hostWunsch} nicht verbunden (letzter Poll ${new Date(bekannt.letzterPoll).toISOString()}).`
        : `Daemon ${hostWunsch} hat sich seit dem Start der API nicht gemeldet. Verbunden: ${da.map((e) => e.host).join(', ') || 'keiner'}.`);
    }
  } else if (da.length === 1) {
    ziel = da[0];
  } else if (da.length === 0) {
    throw new DaemonBrueckeFehler('daemon_nicht_verbunden',
      'Kein Daemon verbunden. Er meldet sich ueber GET /api/intern/daemon/befehle an, sobald er mit neuem Build laeuft und SYNAPSE_INTERN_TOOL=1 in der API gilt.');
  } else {
    throw new DaemonBrueckeFehler('daemon_mehrdeutig', `Mehrere Daemons verbunden: ${da.map((e) => e.host).join(', ')} — prozess:"daemon:<host>" angeben.`);
  }
  const b: DaemonBefehl = { id: randomUUID(), befehl: befehl as DaemonBefehlName, args, erstellt: new Date().toISOString() };
  const zielHost = ziel.host;
  const ergebnis = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      offen.delete(b.id);
      const e = daemons.get(zielHost);
      if (e) e.warteschlange = e.warteschlange.filter((x) => x.id !== b.id);
      reject(new DaemonBrueckeFehler('daemon_antwortet_nicht', `Daemon ${zielHost} hat binnen ${timeoutMs} ms nicht geantwortet (Befehl verworfen).`));
    }, timeoutMs);
    timer.unref?.();
    offen.set(b.id, { host: zielHost, erledige: (r) => { clearTimeout(timer); resolve(r); } });
    ziel!.warteschlange.push(b);
    ziel!.wecker?.();
  });
  return { host: zielHost, ergebnis };
}
