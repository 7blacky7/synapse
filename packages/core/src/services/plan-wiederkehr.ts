/**
 * P3-T16 (User-Idee 26.10.2026, thought ab1977fa; Skill taktik-wiederkehr-plaene, Section mechanik; Entscheidung Koordinator 28878):
 * WIEDERKEHRENDE PLAENE. Ein Plan mit plans.wiederkehrend = true ist ein Ablauf, der immer wieder laeuft (Deploy, Gesamttest ...).
 *   Tasks mit einmalig = true sind Aufbau-Tasks (z. B. Laeufer bauen) und bleiben nach done erledigt.
 *   Alle anderen Tasks sind WIEDERKEHREND und gehen nach einem Durchlauf zurueck auf todo.
 *   Tasks mit abschluss = true schliessen den Durchlauf ab (wie P17-D5, P25-T5).
 * ENDE EINES DURCHLAUFS (pruefeDurchlaufEnde): Gibt es wiederkehrende Abschluss-Tasks, endet der Durchlauf, wenn die gerade auf
 *   done gesetzte Task eine davon ist und alle Abschluss-Tasks done sind (offene Zwischenschritte wie 'nur wenn NEU rot' blockieren
 *   dann nicht). Ohne Abschluss-Task endet er, wenn alle wiederkehrenden Tasks done sind. Eine einmalige Task beendet nie einen Durchlauf.
 * RUECKSTELLUNG (setzeDurchlaufZurueck): alle wiederkehrenden Tasks auf todo, Beteiligte geleert (wie update_task status todo);
 *   einmalige bleiben unveraendert. Der Plan zaehlt den Durchlauf (plans.durchlauf, letzter_durchlauf_am; Schema 163).
 * SCHALTER: Produkt-Schalter wiederkehr_plaene (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = Altverhalten: die
 *   Markierungen werden gespeichert, aber nichts setzt automatisch zurueck (die Abschluss-Task setzt von Hand per update_task zurueck).
 *   EIN = automatische Rueckstellung beim done der letzten Task des Durchlaufs + Aktion plan(durchlauf_abschliessen) als Rueckfall
 *   + plan(standard_plaene) zum Anlegen der fuenf Standardplaene.
 * DEBUG: Jede betroffene Antwort traegt das Feld wiederkehr (Schalter, Quelle des Werts, letzter_fehler, Plan, Durchlauf,
 *   zurueckgesetzte Tasks, vorher offene Tasks, Hinweis). Gelesen wird der Schalter nur bei wiederkehrenden Plaenen.
 * Reine Funktionen ohne DB ausser leseWiederkehrSchalter (wirft nie).
 */
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { mitTaskBeteiligten } from './plan-beteiligung.js';
import type { ProjectTask } from '../types/index.js';

export const WIEDERKEHR_FUNKTION = 'wiederkehr_plaene' as const;

export interface WiederkehrSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter';
  ebene: 'global' | 'projekt' | null;
  letzter_fehler: string | null;
}

/** Debugzeile in den Antworten (regel-neue-funktionen-mit-schalter-und-debug). */
export interface WiederkehrDebug {
  schalter: boolean;
  quelle: WiederkehrSchalter['quelle'];
  ebene?: WiederkehrSchalter['ebene'];
  letzter_fehler?: string | null;
  plan?: string;
  wiederkehrend?: boolean;
  durchlauf_beendet?: boolean;
  durchlauf?: number;
  zurueckgesetzt?: string[];
  waren_offen?: string[];
  hinweis?: string;
}

/** Schalter je Projekt (Vorrang projekt > global > Standard AUS). Lesefehler -> AUS mit letzter_fehler. */
export async function leseWiederkehrSchalter(project: string | null): Promise<WiederkehrSchalter> {
  try {
    const s = await leseProfilProduktSchalter(WIEDERKEHR_FUNKTION, project);
    return { aktiv: s.aktiv, quelle: s.quelle, ebene: s.ebene, letzter_fehler: s.letzter_fehler };
  } catch (e) {
    return { aktiv: false, quelle: 'standard', ebene: null, letzter_fehler: 'schalter_nicht_lesbar: ' + String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/** Grundgeruest der Debugzeile aus dem Schalterstand. */
export function wiederkehrDebug(s: WiederkehrSchalter, extra: Partial<WiederkehrDebug> = {}): WiederkehrDebug {
  return { schalter: s.aktiv, quelle: s.quelle, ...(s.ebene ? { ebene: s.ebene } : {}),
    ...(s.letzter_fehler ? { letzter_fehler: s.letzter_fehler } : {}), ...extra };
}

export const istEinmalig = (t: ProjectTask): boolean => t.einmalig === true;
export const istAbschluss = (t: ProjectTask): boolean => t.abschluss === true && t.einmalig !== true;
const kurz = (t: ProjectTask): string => t.kurz_id ?? t.id;

/**
 * Rein: endet mit der gerade auf done gesetzten Task (geaenderteId) ein Durchlauf? tasks = Stand NACH der Aenderung.
 */
export function pruefeDurchlaufEnde(tasks: ProjectTask[], geaenderteId: string): boolean {
  const wiederkehrend = tasks.filter((t) => !istEinmalig(t));
  const geaendert = wiederkehrend.find((t) => t.id === geaenderteId);
  if (!geaendert || geaendert.status !== 'done') return false;
  const abschluss = wiederkehrend.filter(istAbschluss);
  if (abschluss.length > 0) return istAbschluss(geaendert) && abschluss.every((t) => t.status === 'done');
  return wiederkehrend.every((t) => t.status === 'done');
}

/** Rein: alle wiederkehrenden Tasks auf todo (Beteiligte geleert), einmalige unveraendert. */
export function setzeDurchlaufZurueck(tasks: ProjectTask[], jetzt: string): {
  tasks: ProjectTask[]; zurueckgesetzt: string[]; waren_offen: string[];
} {
  const zurueckgesetzt: string[] = [];
  const warenOffen: string[] = [];
  const neu = tasks.map((t) => {
    if (istEinmalig(t)) return t;
    zurueckgesetzt.push(kurz(t));
    if (t.status !== 'done') warenOffen.push(`${kurz(t)}:${t.status}`);
    return { ...mitTaskBeteiligten(t, []), status: 'todo' as const, updatedAt: jetzt };
  });
  return { tasks: neu, zurueckgesetzt, waren_offen: warenOffen };
}

/** Prueft optionale boolesche Markierungen einer Eingabe (einmalig/abschluss/wiederkehrend). */
export function pruefeMarke(name: string, wert: unknown): boolean | undefined {
  if (wert === undefined || wert === null) return undefined;
  if (typeof wert !== 'boolean') throw new Error(`${name} muss true oder false sein (P3-T16).`);
  return wert;
}

/** Task-Markierungen aus einer Eingabe uebernehmen (nur gesetzte Felder). */
export function taskMarken(e: { einmalig?: unknown; abschluss?: unknown }): { einmalig?: boolean; abschluss?: boolean } {
  const einmalig = pruefeMarke('einmalig', e.einmalig);
  const abschluss = pruefeMarke('abschluss', e.abschluss);
  if (einmalig === true && abschluss === true) throw new Error('Eine Task ist entweder einmalig oder Abschluss eines Durchlaufs, nicht beides (P3-T16).');
  return { ...(einmalig !== undefined ? { einmalig } : {}), ...(abschluss !== undefined ? { abschluss } : {}) };
}
