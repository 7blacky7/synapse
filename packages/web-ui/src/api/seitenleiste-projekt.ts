import { apiFetch } from './auth';
import { leseAktuelleTasks } from './aktuelle-tasks';
import {
  SCHALTER_AUS,
  TASKS_LEER,
  ausAktuellenTasks,
  liesSchalterAntwort,
  liesVertragAntwort,
  type SeitenleistenSchalter,
  type SeitenleistenTasks,
} from '../components/workspace/seitenleiste-projekt-logik';

/**
 * P22-T230: Abrufe der Seitenleisten-Karte 'Aktives Projekt'. EINE Stelle fuer die Datenquelle 'aktiv bearbeitete Tasks':
 *   1. Vertrag P22-T232: GET /api/projects/:p/agentennetzwerk?nur=aktuelle_tasks -> aktuelle_tasks[] (leichter Abruf).
 *   2. Liefert der Server das Feld nicht (Vertrag noch nicht da, Netzwerk-Schalter AUS, Fehler), gilt fuer VERTRAG_PAUSE_MS die
 *      Uebergangsquelle agenten-aktuelle-task (gemeinsamer Puffer api/aktuelle-tasks.ts), danach wird der Vertrag erneut versucht.
 * Schalter seitenleiste_projekt_tasks ueber GET /api/projects/:p/agent-profile/schalter (Lesefehler = AUS).
 */
export const SEITENLEISTE_TAKT_MS = 20_000;
export const SEITENLEISTE_SCHALTER_TAKT_MS = 60_000;
const VERTRAG_PAUSE_MS = 5 * 60_000;

const ohneVertrag = new Map<string, number>();
const basis = (project: string): string => '/api/projects/' + encodeURIComponent(project);
const meldung = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function leseSeitenleistenSchalter(project: string): Promise<SeitenleistenSchalter> {
  if (!project) return SCHALTER_AUS;
  try {
    const response = await apiFetch(basis(project) + '/agent-profile/schalter');
    return liesSchalterAntwort(response.ok, await response.json().catch(() => ({})));
  } catch (error) {
    return { ...SCHALTER_AUS, quelle: 'fehler', letzter_fehler: meldung(error) };
  }
}

export async function leseSeitenleistenTasks(project: string): Promise<SeitenleistenTasks> {
  if (!project) return TASKS_LEER;
  const pause = ohneVertrag.get(project);
  if (pause === undefined || Date.now() - pause > VERTRAG_PAUSE_MS) {
    try {
      const response = await apiFetch(basis(project) + '/agentennetzwerk?nur=aktuelle_tasks');
      const vertrag = liesVertragAntwort(response.ok, await response.json().catch(() => ({})));
      if (vertrag) {
        ohneVertrag.delete(project);
        return vertrag;
      }
    } catch {
      // Uebergangsquelle unten; der Grund steht im Debug-Hinweis der Quelle.
    }
    ohneVertrag.set(project, Date.now());
  }
  return ausAktuellenTasks(await leseAktuelleTasks(project).catch(() => null));
}
