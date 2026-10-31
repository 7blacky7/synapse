/**
 * P22-T222: Wahl der Arbeitsflaechen-Huelle (alt = SynapseWorkspaceMock, neu = workspace/SynapseWorkspace aus den P26-Modulen).
 * Quelle in dieser Reihenfolge:
 *   url             - ?oberflaeche=alt|neu, gilt nur fuer diesen Tab (sessionStorage); ?oberflaeche=schalter hebt das wieder auf
 *   produkt-schalter - Produkt-Schalter web_ui_neue_oberflaeche (GET /api/projects/:project/agent-profile/schalter)
 *   standard        - alt (auch bei Lesefehler, letzter_fehler im Stand)
 * Absturz der neuen Huelle schaltet im Tab auf alt zurueck (App.tsx, quelle 'absturz').
 * Debug: console.debug('[oberflaeche]', stand).
 */
import { apiFetch } from '../api/auth';

export const OBERFLAECHE_FUNKTION = 'web_ui_neue_oberflaeche';
const SPEICHER = 'synapse.oberflaeche';

export type Oberflaeche = 'alt' | 'neu';
export interface OberflaecheStand {
  oberflaeche: Oberflaeche;
  quelle: 'standard' | 'produkt-schalter' | 'url' | 'absturz';
  letzter_fehler: string | null;
}

/** Liest ?oberflaeche= aus der Adresse, merkt es im Tab und entfernt den Parameter aus der Adresszeile. */
export function urlWahl(): Oberflaeche | null {
  try {
    const url = new URL(window.location.href);
    const roh = url.searchParams.get('oberflaeche');
    if (roh !== null) {
      if (roh === 'alt' || roh === 'neu') sessionStorage.setItem(SPEICHER, roh);
      else sessionStorage.removeItem(SPEICHER);
      url.searchParams.delete('oberflaeche');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    const gemerkt = sessionStorage.getItem(SPEICHER);
    return gemerkt === 'alt' || gemerkt === 'neu' ? gemerkt : null;
  } catch {
    return null;
  }
}

export function merkeTabWahl(oberflaeche: Oberflaeche | null): void {
  try {
    if (oberflaeche) sessionStorage.setItem(SPEICHER, oberflaeche);
    else sessionStorage.removeItem(SPEICHER);
  } catch { /* Tab ohne Speicher: Wahl gilt nur bis zum Neuladen */ }
}

export async function leseOberflaeche(project: string): Promise<OberflaecheStand> {
  const url = urlWahl();
  if (url) return { oberflaeche: url, quelle: 'url', letzter_fehler: null };
  try {
    const r = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/agent-profile/schalter');
    const d = await r.json().catch(() => null) as { schalter?: Array<{ funktion: string; aktiv: boolean }> } | null;
    if (!r.ok) return { oberflaeche: 'alt', quelle: 'standard', letzter_fehler: 'HTTP ' + r.status };
    const s = d?.schalter?.find((x) => x.funktion === OBERFLAECHE_FUNKTION);
    return s?.aktiv
      ? { oberflaeche: 'neu', quelle: 'produkt-schalter', letzter_fehler: null }
      : { oberflaeche: 'alt', quelle: s ? 'produkt-schalter' : 'standard', letzter_fehler: s ? null : 'schalter_fehlt' };
  } catch (reason) {
    return { oberflaeche: 'alt', quelle: 'standard', letzter_fehler: reason instanceof Error ? reason.message : String(reason) };
  }
}

/** Produkt-Schalter global setzen (User-Sitzung der Web-UI). */
export async function setzeOberflaeche(project: string, neu: boolean, grund: string): Promise<string | null> {
  try {
    const r = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/agent-profile/schalter', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profil_funktion: OBERFLAECHE_FUNKTION, aktiv: neu, ebene: 'global', grund }),
    });
    return r.ok ? null : 'HTTP ' + r.status;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
