import { apiFetch } from './auth';
import { AKTUELLE_TASKS_AUS, liesAktuelleTasksAntwort, type AktuelleTasksDaten } from '../components/agent-task-logik';

/**
 * P22-T172: aktuelle Task je Agent (GET /api/projects/:name/agenten-aktuelle-task). Je Projekt EIN Puffer, von allen Marken geteilt
 * (Channel, Agententeam, Runtime-Panel, Koordinator-Dock, Netzwerk, Ausweis-Liste); solange jemand abonniert, wird alle
 * AKTUELLE_TASKS_TAKT_MS neu gelesen. Fehler = AUS (keine Marke), letzter Fehler im Stand. Debug: console.debug('[aktuelle-task]').
 */
export const AKTUELLE_TASKS_TAKT_MS = 20_000;

const staende = new Map<string, { daten: AktuelleTasksDaten; zeit: number }>();
const laufend = new Map<string, Promise<AktuelleTasksDaten>>();
const hoerer = new Map<string, Set<(d: AktuelleTasksDaten) => void>>();
const takte = new Map<string, ReturnType<typeof setInterval>>();

export function aktuelleTasksBekannt(project: string): AktuelleTasksDaten | null {
  const s = staende.get(project);
  return s && Date.now() - s.zeit < AKTUELLE_TASKS_TAKT_MS ? s.daten : null;
}

export async function leseAktuelleTasks(project: string, neu = false): Promise<AktuelleTasksDaten> {
  if (!project) return AKTUELLE_TASKS_AUS;
  const bekannt = neu ? null : aktuelleTasksBekannt(project);
  if (bekannt) return bekannt;
  const offen = laufend.get(project);
  if (offen) return offen;
  const anfrage = (async (): Promise<AktuelleTasksDaten> => {
    let daten: AktuelleTasksDaten;
    try {
      const response = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/agenten-aktuelle-task');
      daten = liesAktuelleTasksAntwort(response.ok, await response.json().catch(() => ({})));
    } catch (error) {
      daten = { ...AKTUELLE_TASKS_AUS, quelle: 'fehler', letzter_fehler: error instanceof Error ? error.message : String(error) };
    }
    const vorher = staende.get(project)?.daten;
    staende.set(project, { daten, zeit: Date.now() });
    if (!vorher || vorher.aktiv !== daten.aktiv || vorher.letzter_fehler !== daten.letzter_fehler) {
      console.debug('[aktuelle-task]', { project, aktiv: daten.aktiv, quelle: daten.quelle, agenten: daten.agenten.length, fehler: daten.letzter_fehler });
    }
    for (const fn of hoerer.get(project) ?? []) fn(daten);
    return daten;
  })();
  laufend.set(project, anfrage);
  try { return await anfrage; } finally { laufend.delete(project); }
}

/** Abonniert den Stand eines Projekts; der Takt laeuft nur, solange es Hoerer gibt. Rueckgabe: abmelden. */
export function abonniereAktuelleTasks(project: string, fn: (d: AktuelleTasksDaten) => void): () => void {
  if (!project) return () => undefined;
  const menge = hoerer.get(project) ?? new Set();
  menge.add(fn);
  hoerer.set(project, menge);
  if (!takte.has(project)) takte.set(project, setInterval(() => { void leseAktuelleTasks(project, true); }, AKTUELLE_TASKS_TAKT_MS));
  const bekannt = aktuelleTasksBekannt(project);
  if (bekannt) fn(bekannt); else void leseAktuelleTasks(project);
  return () => {
    menge.delete(fn);
    if (menge.size) return;
    hoerer.delete(project);
    const t = takte.get(project);
    if (t) clearInterval(t);
    takte.delete(project);
  };
}
