/**
 * Kurz-IDs fuer Plaene und Tasks (Task 137fabaf, User-Vorgabe 29.09.2026).
 *
 *   Plan:  P<n>        je Projekt fortlaufend nach created_at
 *   Task:  P<n>-T<m>   je Plan fortlaufend; der Zaehler steht in plans.naechste_task_nr
 *
 * STABIL UND NIE WIEDERVERWENDET: eine vergebene Kurz-ID wird nie geaendert. Der Task-Zaehler
 * ist eine eigene Spalte statt "Maximum + 1" — sonst bekaeme nach dem Loeschen der letzten Task
 * die naechste neue Task deren Nummer.
 *
 * Reine Funktionen ohne DB: plans.ts nutzt sie beim Schreiben, scripts/plaene-kurz-ids.mjs
 * zum einmaligen Befuellen des Bestands (planeKurzIds).
 */

const PLAN_KURZ = /^P(\d+)$/i;
const TASK_KURZ = /^P(\d+)-T(\d+)$/i;

/** "P3" / "p3" -> 3, sonst null */
export function planNummer(ref: unknown): number | null {
  const m = typeof ref === 'string' ? PLAN_KURZ.exec(ref.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** "P3-T12" -> {plan: 3, task: 12}, sonst null */
export function taskNummer(ref: unknown): { plan: number; task: number } | null {
  const m = typeof ref === 'string' ? TASK_KURZ.exec(ref.trim()) : null;
  return m ? { plan: Number(m[1]), task: Number(m[2]) } : null;
}

export function planKurzId(n: number): string {
  return `P${n}`;
}

export function taskKurzId(planKurz: string, m: number): string {
  return `${planKurz.toUpperCase()}-T${m}`;
}

/** Minimal-Form einer plans-Zeile fuer die Kurz-ID-Logik */
export interface KurzIdZeile {
  id: string;
  project: string;
  created_at: string | Date;
  updated_at: string | Date;
  kurz_id: string | null;
  aktiv: boolean | null;
  naechste_task_nr: number | null;
  tasks: Array<Record<string, unknown>> | null;
}

export interface KurzIdAenderung {
  id: string;
  project: string;
  kurz_id: string;
  aktiv: boolean;
  naechste_task_nr: number;
  tasks: Array<Record<string, unknown>>;
}

const zeit = (x: string | Date | null | undefined): number => (x ? new Date(x).getTime() : 0);

/**
 * Der Plan, der ohne plan_id gilt: der als aktiv markierte; ist keiner markiert (Bestand vor
 * dem Skript), der zuletzt geaenderte — genau der Plan, den getPlan bisher aus Qdrant bekam.
 */
export function waehleAktiven<T extends { aktiv: boolean | null; updated_at: string | Date; created_at: string | Date }>(
  zeilen: T[],
): T | null {
  if (zeilen.length === 0) return null;
  const markiert = zeilen.filter((z) => z.aktiv === true);
  const kandidaten = markiert.length > 0 ? markiert : zeilen;
  return [...kandidaten].sort((a, b) => zeit(b.updated_at) - zeit(a.updated_at) || zeit(b.created_at) - zeit(a.created_at))[0];
}

/** Naechste freie Task-Nummer eines Plans: Zaehler, mindestens groesser als jede vergebene. */
export function naechsteTaskNummer(planKurz: string, tasks: Array<Record<string, unknown>>, zaehler: number | null): number {
  let max = 0;
  for (const t of tasks) {
    const n = taskNummer(t.kurz_id);
    if (n && planKurz.toUpperCase() === `P${n.plan}`) max = Math.max(max, n.task);
  }
  return Math.max(zaehler ?? 1, max + 1);
}

/**
 * Vergibt fehlende Task-Kurz-IDs eines Plans (nach createdAt, bei Gleichstand nach Position).
 * Vorhandene bleiben unangetastet. Liefert neue Task-Liste (gleiche Reihenfolge) und Zaehler.
 */
export function ergaenzeTaskKurzIds(
  planKurz: string,
  tasks: Array<Record<string, unknown>>,
  zaehler: number | null,
): { tasks: Array<Record<string, unknown>>; naechste_task_nr: number; vergeben: number } {
  let naechste = naechsteTaskNummer(planKurz, tasks, zaehler);
  const fehlend = tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => typeof t.kurz_id !== 'string' || !t.kurz_id)
    .sort((a, b) => zeit(a.t.createdAt as string) - zeit(b.t.createdAt as string) || a.i - b.i);
  const neu = [...tasks];
  for (const { i } of fehlend) neu[i] = { ...tasks[i], kurz_id: taskKurzId(planKurz, naechste++) };
  return { tasks: neu, naechste_task_nr: naechste, vergeben: fehlend.length };
}

/**
 * Plant die Befuellung des Bestands (scripts/plaene-kurz-ids.mjs): je Projekt fehlende
 * Plan-Kurz-IDs nach created_at (nach der hoechsten vorhandenen weiterzaehlend), genau ein
 * aktiver Plan (vorhandene Markierung bleibt, sonst waehleAktiven), fehlende Task-Kurz-IDs.
 * Liefert nur Zeilen, an denen sich etwas aendert — ein zweiter Lauf liefert [].
 */
export function planeKurzIds(zeilen: KurzIdZeile[]): KurzIdAenderung[] {
  const jeProjekt = new Map<string, KurzIdZeile[]>();
  for (const z of zeilen) {
    const liste = jeProjekt.get(z.project) ?? [];
    liste.push(z);
    jeProjekt.set(z.project, liste);
  }
  const aenderungen: KurzIdAenderung[] = [];
  for (const plaene of jeProjekt.values()) {
    const sortiert = [...plaene].sort((a, b) => zeit(a.created_at) - zeit(b.created_at) || a.id.localeCompare(b.id));
    let maxP = 0;
    for (const p of sortiert) maxP = Math.max(maxP, planNummer(p.kurz_id) ?? 0);
    const aktiv = waehleAktiven(sortiert);
    for (const p of sortiert) {
      const kurz = p.kurz_id && planNummer(p.kurz_id) ? p.kurz_id.toUpperCase() : planKurzId(++maxP);
      const istAktiv = p.aktiv === true || (!sortiert.some((x) => x.aktiv === true) && p === aktiv);
      const tasks = Array.isArray(p.tasks) ? p.tasks : [];
      const erg = ergaenzeTaskKurzIds(kurz, tasks, p.naechste_task_nr);
      const geaendert = kurz !== p.kurz_id || istAktiv !== p.aktiv || erg.vergeben > 0 || erg.naechste_task_nr !== p.naechste_task_nr;
      if (geaendert) {
        aenderungen.push({ id: p.id, project: p.project, kurz_id: kurz, aktiv: istAktiv, naechste_task_nr: erg.naechste_task_nr, tasks: erg.tasks });
      }
    }
  }
  return aenderungen;
}
