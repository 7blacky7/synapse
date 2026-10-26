/**
 * P10-T88 N1 (Befund P10-T81 Nachtrag d0080771): VORHANDENE ARBEIT ANDERER ANBIETEN. Der Nachfolger einer Task sah bisher nicht,
 * dass es schon Checkpoints/Befunde (thoughts mit task_id) und Dateiversionen frueherer Agenten gibt; die Zahlen standen nur in
 * plan(search). Jetzt nennen plan(get, task_id) und die gebundenen Tasks in chat(anmelden) die Pins kompakt:
 * { thoughts, dateiversionen, thought_ids[<=5], dateiversion_ids[<=5] } - dieselbe Zaehlung wie plan(search, mit_verknuepfungen:true)
 * (plan-suche.ts pinsFuerTasks, Aliase/Kurz-IDs zaehlen mit).
 * SCHALTER task_pins (Produkt-Schalter, projekt > global, Standard AUS, nur ausdruecklich; intern-Override gleichen Namens nur mit
 *   intern-Tool). AUS = Altverhalten: keine Abfrage, keine Zusatzfelder.
 * DEBUG pins_debug: Schalter mit Quelle, Anzahl Tasks, Dauer, Fehler. Ein Lesefehler laesst die Antwort unveraendert (nur Debugzeile).
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { pinsFuerTasks, type TaskPins } from './plan-suche.js';

type Q = import('pg').QueryConfig & { query_timeout: number };
export const TASK_PINS_FUNKTION = 'task_pins' as const;

export interface TaskPinsSchalter { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; ebene: 'global' | 'projekt' | null; bis: string | null; letzter_fehler: string | null }

/** Produkt-Schalter mit befristetem intern-Override; eine Lesestelle. Wirft nie. */
export async function leseTaskPinsSchalter(project: string | null): Promise<TaskPinsSchalter> {
  const p = await leseProfilProduktSchalter(TASK_PINS_FUNKTION, project);
  let stand: TaskPinsSchalter = { aktiv: p.aktiv, quelle: p.quelle, ebene: p.ebene, bis: null, letzter_fehler: p.letzter_fehler };
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>({
        text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND bis > NOW()",
        values: [TASK_PINS_FUNKTION], query_timeout: 2000 } as Q);
      const z = r.rows[0];
      if (z) stand = { ...stand, aktiv: z.aktiv, quelle: 'intern', bis: new Date(z.bis).toISOString(), letzter_fehler: null };
    } catch { stand.letzter_fehler = 'task_pins_override_nicht_lesbar'; }
  }
  return stand;
}

/**
 * Haengt je Task 'pins' an (Schluessel = Feld mit der Task-UUID, Standard 'id'). null = Schalter AUS (Aufrufer bleibt unveraendert).
 */
export async function ergaenzeTaskPins<T extends Record<string, unknown>>(
  project: string, tasks: T[], schluessel: string = 'id',
): Promise<{ tasks: Array<T & { pins?: TaskPins }>; debug: string } | null> {
  if (!project || !tasks.length) return null;
  const schalter = await leseTaskPinsSchalter(project);
  if (!schalter.aktiv) return null;
  const start = Date.now();
  const kopf = 'task_pins an (' + schalter.quelle + (schalter.ebene ? '/' + schalter.ebene : '') + ')';
  try {
    const ids = tasks.map((t) => t[schluessel]).filter((id): id is string => typeof id === 'string' && !!id);
    const pins = await pinsFuerTasks(project, [...new Set(ids)]);
    const neu = tasks.map((t) => {
      const p = typeof t[schluessel] === 'string' ? pins.get(t[schluessel] as string) : undefined;
      return p ? { ...t, pins: p } : t;
    });
    return { tasks: neu, debug: kopf + '; ' + ids.length + ' Task(s); ' + (Date.now() - start) + ' ms' };
  } catch (e) {
    return { tasks, debug: kopf + '; fehler ' + String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
}
