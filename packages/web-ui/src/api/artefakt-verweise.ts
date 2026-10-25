import { apiFetch } from './auth';

/**
 * P22-T165: Produkt-Schalter artefakt_verweise (global, Standard AUS) fuer anklickbare Verweise und den Zustand ueber Live-Updates
 * in Artefakten. Einmal je 30 s gefragt und von allen Darstellungsflaechen geteilt; Fehler = AUS (Bestand).
 */
const GUELTIG_MS = 30_000;
let stand: { aktiv: boolean; zeit: number } | null = null;
let laufend: Promise<boolean> | null = null;

/** Bekannter Stand (null = noch nicht gefragt oder abgelaufen). */
export function artefaktVerweiseBekannt(): boolean | null {
  return stand && Date.now() - stand.zeit < GUELTIG_MS ? stand.aktiv : null;
}

export async function leseArtefaktVerweiseAktiv(): Promise<boolean> {
  const bekannt = artefaktVerweiseBekannt();
  if (bekannt !== null) return bekannt;
  if (!laufend) {
    laufend = (async () => {
      try {
        const response = await apiFetch('/api/main-agent/artefakt-verweise');
        const data = await response.json().catch(() => ({})) as { aktiv?: boolean };
        const aktiv = response.ok && data.aktiv === true;
        stand = { aktiv, zeit: Date.now() };
        return aktiv;
      } catch {
        stand = { aktiv: false, zeit: Date.now() };
        return false;
      } finally {
        laufend = null;
      }
    })();
  }
  return laufend;
}
