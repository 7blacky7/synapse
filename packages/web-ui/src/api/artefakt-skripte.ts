import { apiFetch } from './auth';

/**
 * P22-T166: Artefakte mit Skript (nur Top-Artefakte).
 *  - leseArtefaktSkripteAktiv(): Produkt-Schalter artefakt_skripte (global, Standard AUS), einmal je 30 s gefragt und geteilt; Fehler = AUS.
 *    Genutzt fuer den Hinweis im Chatfenster ('Skript entfernt · läuft nur in den Top-Artefakten').
 *  - rufeSkriptBruecke(): eine nur lesende Anfrage des Skript-Rahmens an POST /api/main-agent/artefakte/:id/bruecke. Das Projekt setzt
 *    der Rahmen, nie das Skript. Fehler kommen als SkriptBrueckeFehler mit code (schalter_aus, projekt_fremd, urheber_fremd, ...).
 */
const GUELTIG_MS = 30_000;
let stand: { aktiv: boolean; zeit: number } | null = null;
let laufend: Promise<boolean> | null = null;

/** Bekannter Stand (null = noch nicht gefragt oder abgelaufen). */
export function artefaktSkripteBekannt(): boolean | null {
  return stand && Date.now() - stand.zeit < GUELTIG_MS ? stand.aktiv : null;
}

export async function leseArtefaktSkripteAktiv(): Promise<boolean> {
  const bekannt = artefaktSkripteBekannt();
  if (bekannt !== null) return bekannt;
  if (!laufend) {
    laufend = (async () => {
      try {
        const response = await apiFetch('/api/main-agent/artefakt-skripte');
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

export class SkriptBrueckeFehler extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface SkriptBrueckeAntwort { daten: unknown; debug?: Record<string, unknown> }

/** Eine Anfrage an die Bruecke (Koerper baut skript-rahmen-logik.ts brueckeKoerper). */
export async function rufeSkriptBruecke(artefaktId: string, koerper: Record<string, unknown>, signal?: AbortSignal): Promise<SkriptBrueckeAntwort> {
  const response = await apiFetch('/api/main-agent/artefakte/' + encodeURIComponent(artefaktId) + '/bruecke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(koerper), signal,
  });
  const data = await response.json().catch(() => ({})) as { success?: boolean; daten?: unknown; debug?: Record<string, unknown>; error?: { code?: string; message?: string } };
  if (!response.ok || data.success !== true) {
    throw new SkriptBrueckeFehler(data.error?.code || 'http_' + response.status, data.error?.message || 'Bruecke HTTP ' + response.status);
  }
  return { daten: data.daten ?? null, debug: data.debug };
}
