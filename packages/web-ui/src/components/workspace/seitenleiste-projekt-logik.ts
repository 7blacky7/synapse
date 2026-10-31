/**
 * P22-T230: reine Logik der Karte 'Aktives Projekt' in der Seitenleiste (ohne React/DOM, ohne Importe; testbar mit
 * node --experimental-strip-types).
 *
 * SCHALTER: Produkt-Schalter seitenleiste_projekt_tasks (core agent-profil-schalter.ts, Standard AUS, nur ausdruecklich),
 *   gelesen ueber GET /api/projects/:p/agent-profile/schalter. AUS/Lesefehler = bisherige Karte (Unterzeile
 *   'ein Projekt · ein UI-Objekt', Klick oeffnet die Uebersicht).
 * EIN: Unterzeile = die letzten 3 aktiv bearbeiteten Tasks (Kurz-IDs, juengste zuerst, Titel im Tooltip); Klick oeffnet die
 *   bestehende Projektsuche (ProjectSelector) als Feld an der Karte.
 * DATENQUELLE (eine Stelle, siehe api/seitenleiste-projekt.ts):
 *   1. Vertrag P22-T232 (codex-rea4, Channel t128-team 31472/31473): GET /api/projects/:p/agentennetzwerk?nur=aktuelle_tasks
 *      -> aktuelle_tasks [{task_id, titel, zuletzt, quelle}].
 *   2. Uebergang, solange der Vertrag das Feld nicht liefert: agenten-aktuelle-task (P22-T172, eine Task je Agent).
 * DEBUG: console.debug('[seitenleiste-projekt]') bei jeder Aenderung von Schalter/Quelle/Tasks; data-Attribute an der Karte.
 */

export const SEITENLEISTE_FUNKTION = 'seitenleiste_projekt_tasks';
export const SEITENLEISTE_ANZAHL = 3;
export const SEITENLEISTE_TRENNER = ' · ';
export const SEITENLEISTE_LEERTEXT = 'keine aktive Task';
/** Bisherige Unterzeile (Schalter AUS). */
export const SEITENLEISTE_ALTTEXT = 'ein Projekt · ein UI-Objekt';

export interface SeitenleistenTask {
  task_id: string;
  titel: string | null;
  zuletzt: string | null;
  /** Herkunft des Eintrags (z. B. aktivitaet:tool_calls, bindung). */
  quelle: string;
}

/** Woher die Liste kommt: Vertrag T232, Uebergangsquelle agent_aktuelle_task, keine (beides aus/Fehler). */
export type SeitenleistenQuelle = 'aktuelle_tasks' | 'agent_aktuelle_task' | 'keine';

export interface SeitenleistenTasks {
  quelle: SeitenleistenQuelle;
  tasks: SeitenleistenTask[];
  /** Grund, warum keine Liste da ist (Schalter der Quelle AUS, Lesefehler). */
  hinweis: string | null;
  stand: string | null;
}

export interface SeitenleistenSchalter {
  aktiv: boolean;
  quelle: string;
  ebene: string | null;
  letzter_fehler: string | null;
}

export const SCHALTER_AUS: SeitenleistenSchalter = { aktiv: false, quelle: 'standard', ebene: null, letzter_fehler: null };
export const TASKS_LEER: SeitenleistenTasks = { quelle: 'keine', tasks: [], hinweis: null, stand: null };

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const objekt = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const zeitwert = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/** Je Task-ID der juengste Eintrag, juengste zuerst (ohne Zeit hinten, sonst stabil nach ID), hoechstens n. */
export function letzteTasks(eintraege: SeitenleistenTask[], n = SEITENLEISTE_ANZAHL): SeitenleistenTask[] {
  const je = new Map<string, SeitenleistenTask>();
  for (const e of eintraege) {
    const vorher = je.get(e.task_id);
    if (!vorher || zeitwert(e.zuletzt) > zeitwert(vorher.zuletzt)) je.set(e.task_id, { ...e, titel: e.titel ?? vorher?.titel ?? null });
  }
  return [...je.values()]
    .sort((a, b) => zeitwert(b.zuletzt) - zeitwert(a.zuletzt) || a.task_id.localeCompare(b.task_id))
    .slice(0, Math.max(0, n));
}

/** Antwort von GET /agent-profile/schalter -> Stand dieses Schalters; fehlt der Eintrag oder die Antwort = AUS mit Fehlertext. */
export function liesSchalterAntwort(ok: boolean, data: unknown): SeitenleistenSchalter {
  const d = objekt(data);
  if (!ok || d.success === false) {
    const e = d.error;
    return { ...SCHALTER_AUS, quelle: 'fehler', letzter_fehler: text(typeof e === 'string' ? e : objekt(e).code) ?? 'nicht_lesbar' };
  }
  const liste = Array.isArray(d.schalter) ? d.schalter : [];
  const z = liste.map(objekt).find((s) => s.funktion === SEITENLEISTE_FUNKTION);
  if (!z) return { ...SCHALTER_AUS, quelle: 'fehler', letzter_fehler: 'funktion_unbekannt' };
  const fehler = text(z.letzter_fehler);
  return { aktiv: z.aktiv === true && !fehler, quelle: text(z.quelle) ?? 'standard', ebene: text(z.ebene), letzter_fehler: fehler };
}

/**
 * Vertrag P22-T232: aktuelle_tasks [{task_id, titel, zuletzt, quelle}]. null = Feld nicht geliefert (aelterer Server,
 * Vertrag noch nicht umgesetzt) -> Uebergangsquelle. Leeres Array ist eine gueltige Antwort (niemand arbeitet).
 */
export function liesVertragAntwort(ok: boolean, data: unknown): SeitenleistenTasks | null {
  const d = objekt(data);
  if (!ok || d.success === false || !Array.isArray(d.aktuelle_tasks)) return null;
  // Channel t128-team 31484: daten_schalter (netzwerk_datengrundlage, Standard AUS). AUS = Vertrag liefert nichts Verwertbares -> Uebergangsquelle.
  if (objekt(d.daten_schalter).aktiv === false) return null;
  const tasks: SeitenleistenTask[] = [];
  for (const roh of d.aktuelle_tasks) {
    const r = objekt(roh);
    const id = text(r.task_id);
    if (id) tasks.push({ task_id: id, titel: text(r.titel), zuletzt: text(r.zuletzt), quelle: text(r.quelle) ?? 'aktuelle_tasks' });
  }
  const schalter = objekt(d.schalter);
  const aus = schalter.aktiv === false;
  return { quelle: 'aktuelle_tasks', tasks: letzteTasks(tasks), hinweis: aus ? 'Netzwerk-Schalter AUS' : null, stand: text(d.stand) };
}

/** Uebergangsquelle P22-T172 (AktuelleTasksDaten): eine Task je Agent; erledigte zaehlen nicht als 'aktiv bearbeitet'. */
export function ausAktuellenTasks(daten: { aktiv: boolean; agenten: Array<{ task_id: string; titel: string | null; status: string | null; seit: string | null; zuletzt: string | null; quelle: string }>; letzter_fehler: string | null; stand: string | null } | null | undefined): SeitenleistenTasks {
  if (!daten) return { ...TASKS_LEER, hinweis: 'nicht_lesbar' };
  if (!daten.aktiv) return { ...TASKS_LEER, quelle: 'agent_aktuelle_task', hinweis: daten.letzter_fehler ?? 'Schalter agent_aktuelle_task AUS', stand: daten.stand };
  const tasks = daten.agenten
    .filter((a) => a.status !== 'done')
    .map((a) => ({ task_id: a.task_id, titel: a.titel, zuletzt: a.zuletzt ?? a.seit, quelle: a.quelle }));
  return { quelle: 'agent_aktuelle_task', tasks: letzteTasks(tasks), hinweis: daten.letzter_fehler, stand: daten.stand };
}

/** Unterzeile der Karte bei Schalter EIN. */
export function unterzeile(t: SeitenleistenTasks): string {
  return t.tasks.length ? t.tasks.map((x) => x.task_id).join(SEITENLEISTE_TRENNER) : SEITENLEISTE_LEERTEXT;
}

/** Tooltip einer Kurz-ID: ID und Titel. */
export function taskTitel(x: SeitenleistenTask): string {
  return x.task_id + (x.titel ? ': ' + x.titel : '');
}

/** Tooltip der ganzen Karte (Debug): Projekt, Tasks mit Titel, Quelle, ggf. Hinweis. */
export function kartenTitel(project: string, t: SeitenleistenTasks): string {
  return [
    project || 'Projekt wählen',
    ...t.tasks.map(taskTitel),
    'Quelle: ' + (t.quelle === 'aktuelle_tasks' ? 'aktuelle_tasks (P22-T232)' : t.quelle === 'agent_aktuelle_task' ? 'agenten-aktuelle-task (Übergang)' : 'keine')
      + (t.hinweis ? ' · ' + t.hinweis : ''),
    'Klick: Projekt suchen',
  ].join('\n');
}

/** Gleichheit fuer Debug-Ausgabe und unnoetige Re-Renders. */
export function gleicheTasks(a: SeitenleistenTasks, b: SeitenleistenTasks): boolean {
  return a.quelle === b.quelle && a.hinweis === b.hinweis && a.tasks.length === b.tasks.length
    && a.tasks.every((x, i) => x.task_id === b.tasks[i].task_id && x.titel === b.tasks[i].titel);
}
