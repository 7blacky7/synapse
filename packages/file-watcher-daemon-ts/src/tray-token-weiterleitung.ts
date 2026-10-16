/**
 * P9-T28: Produktionsstandard aus Env/Config (Default AUS), unabhaengig von intern.
 * Frischer Intern-Long-Poll darf ihn befristet ueberschreiben; Fehler/stop verwerfen
 * den Override. 35s = Poll 25s + bestehendes Timeout 10s. Kein PG im Daemon.
 */
import { loadConfig } from './config.js';
export interface TrayTokenFreigabe { an: boolean; bis: string | null; quelle: 'standard' | 'intern' }
const FRISCHE_MS = 35_000;
let override: { an: boolean; bis: string | null; empfangen: number } | null = null;

export function standardTrayTokenWeiterleitung(env: NodeJS.ProcessEnv = process.env, cfg?: { tray_token_weiterleitung?: unknown }): boolean {
  const wert = env.SYNAPSE_TRAY_TOKEN_WEITERLEITUNG?.trim().toLowerCase();
  if (wert === '1' || wert === 'true') return true;
  if (wert === '0' || wert === 'false') return false;
  try { return (cfg ?? loadConfig()).tray_token_weiterleitung === true; } catch { return false; }
}

let letzterFehler: string | null = 'noch_kein_intern_stand';
export function verwerfeTrayTokenFreigabe(): void { override = null; letzterFehler = 'bruecke_getrennt'; }
/** Nur feste Diagnosecodes, niemals Token oder ungefilterte Transportfehler. */
export function trayTokenBrueckenStatus(jetzt = Date.now()): { letzter_fehler: string | null } {
  return { letzter_fehler: letzterFehler ?? (override && jetzt - override.empfangen >= FRISCHE_MS ? 'intern_stand_veraltet' :
    override?.bis && Date.parse(override.bis) <= jetzt ? 'intern_override_abgelaufen' : null) };
}

export function uebernehmeTrayTokenFreigabe(antwort: unknown, jetzt = Date.now()): void {
  override = null;
  letzterFehler = 'intern_ohne_gueltigen_override';
  if (!antwort || typeof antwort !== 'object') return;
  const a = antwort as Record<string, unknown>;
  if (a.success !== true || a.debug !== true || !a.tray_token_weiterleitung || typeof a.tray_token_weiterleitung !== 'object') return;
  const s = a.tray_token_weiterleitung as Record<string, unknown>;
  if (s.name !== 'tray_token_weiterleitung' || typeof s.aktiv !== 'boolean' || s.modus !== 'freigegeben' || s.abgelaufen === true) return;
  // Nie gesetzter Schalter hat kein modus/bis; explizit AUS hat ebenfalls eine Dauer.
  if (s.bis === null && s.dauerhaft === true) override = { an: s.aktiv, bis: null, empfangen: jetzt };
  else if (typeof s.bis === 'string' && Number.isFinite(Date.parse(s.bis)) && Date.parse(s.bis) > jetzt) {
    override = { an: s.aktiv, bis: s.bis, empfangen: jetzt };
  }
  if (override) letzterFehler = null;
}

export function trayTokenFreigabe(jetzt = Date.now(), standard = standardTrayTokenWeiterleitung()): TrayTokenFreigabe {
  if (override && jetzt >= override.empfangen && jetzt - override.empfangen < FRISCHE_MS &&
      (override.bis === null || Date.parse(override.bis) > jetzt)) {
    return { an: override.an, bis: override.bis, quelle: 'intern' };
  }
  return { an: standard, bis: null, quelle: 'standard' };
}
