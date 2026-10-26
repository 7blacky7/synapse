import { apiFetch } from './auth';
import { LAUF_HERKUNFT_AUS, liesLaufHerkunftAntwort, type LaufHerkunftDaten } from '../components/lauf-herkunft-logik';

/**
 * P22-T178: Lauf-Herkunft je Agent (GET /api/projects/:name/agenten-lauf-herkunft). Je Projekt EIN Puffer, von allen Marken geteilt;
 * solange jemand abonniert, wird alle LAUF_HERKUNFT_TAKT_MS neu gelesen. Fehler = AUS (keine Marke), letzter Fehler im Stand.
 * Gleiches Muster wie api/aktuelle-tasks.ts (P22-T172). Debug: console.debug('[lauf-herkunft]').
 */
export const LAUF_HERKUNFT_TAKT_MS = 30_000;

const staende = new Map<string, { daten: LaufHerkunftDaten; zeit: number }>();
const laufend = new Map<string, Promise<LaufHerkunftDaten>>();
const hoerer = new Map<string, Set<(d: LaufHerkunftDaten) => void>>();
const takte = new Map<string, ReturnType<typeof setInterval>>();

export function laufHerkunftBekannt(project: string): LaufHerkunftDaten | null {
  const s = staende.get(project);
  return s && Date.now() - s.zeit < LAUF_HERKUNFT_TAKT_MS ? s.daten : null;
}

export async function leseLaufHerkunft(project: string, neu = false): Promise<LaufHerkunftDaten> {
  if (!project) return LAUF_HERKUNFT_AUS;
  const bekannt = neu ? null : laufHerkunftBekannt(project);
  if (bekannt) return bekannt;
  const offen = laufend.get(project);
  if (offen) return offen;
  const anfrage = (async (): Promise<LaufHerkunftDaten> => {
    let daten: LaufHerkunftDaten;
    try {
      const response = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/agenten-lauf-herkunft');
      daten = liesLaufHerkunftAntwort(response.ok, await response.json().catch(() => ({})));
    } catch (error) {
      daten = { ...LAUF_HERKUNFT_AUS, quelle: 'fehler', letzter_fehler: error instanceof Error ? error.message : String(error) };
    }
    const vorher = staende.get(project)?.daten;
    staende.set(project, { daten, zeit: Date.now() });
    if (!vorher || vorher.aktiv !== daten.aktiv || vorher.letzter_fehler !== daten.letzter_fehler) {
      console.debug('[lauf-herkunft]', { project, aktiv: daten.aktiv, quelle: daten.quelle, agenten: daten.agenten.length, fehler: daten.letzter_fehler });
    }
    for (const fn of hoerer.get(project) ?? []) fn(daten);
    return daten;
  })();
  laufend.set(project, anfrage);
  try { return await anfrage; } finally { laufend.delete(project); }
}

/** Abonniert den Stand eines Projekts; der Takt laeuft nur, solange es Hoerer gibt. Rueckgabe: abmelden. */
export function abonniereLaufHerkunft(project: string, fn: (d: LaufHerkunftDaten) => void): () => void {
  if (!project) return () => undefined;
  const menge = hoerer.get(project) ?? new Set();
  menge.add(fn);
  hoerer.set(project, menge);
  if (!takte.has(project)) takte.set(project, setInterval(() => { void leseLaufHerkunft(project, true); }, LAUF_HERKUNFT_TAKT_MS));
  const bekannt = laufHerkunftBekannt(project);
  if (bekannt) fn(bekannt); else void leseLaufHerkunft(project);
  return () => {
    menge.delete(fn);
    if (menge.size) return;
    hoerer.delete(project);
    const t = takte.get(project);
    if (t) clearInterval(t);
    takte.delete(project);
  };
}
