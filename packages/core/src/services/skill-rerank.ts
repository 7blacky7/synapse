/**
 * MODUL: Skill-Sinnpruefung (P23-T1, 19.10.2026, User-Vorgabe "Skill-Vorschlaege nach Sinn")
 * ZWECK: Semantische Skill-Treffer (Embedding + kalibrierte Schwelle) werden VOR der Auslieferung von Jev
 *        auf Sinn geprueft: "Hilft dieser Skill einem Agenten, der an diesem Text arbeitet, wirklich?"
 *        EIN Jev-Aufruf je Quelltext (eine noul-Frage je Kandidat), fuer alle Empfaenger zusammen.
 *        Namentlich genannte, vorgegebene und verknuepfte Skills (Kette, 0,99) laufen NICHT hier durch.
 * SCHALTER: Jev-Funktion skill_rerank (admin jev_schalten). Standard AUS (jev-schalter.ts
 *   JEV_FUNKTIONEN_STANDARD_AUS): wirkt nur mit ausdruecklichem "an" oder befristetem intern-Schalter
 *   skill_rerank. Jev global/Projekt aus oder Budget-Pause -> keine Pruefung, Treffer bleiben wie bisher.
 * EINSTELLWERTE: jev_optionen skill_rerank_tor / skill_rerank_max (admin jev_optionen), Code-Wert nur Standard.
 * KOSTEN: rufeJev bucht jeden Aufruf in jev_aufrufe (funktion skill_rerank) -> admin jev_kosten.
 * DEBUG: Ergebnis nennt gelaufen, grund (aus | budget | kein_key | timeout | netz | http | keine_kandidaten |
 *   antwort_unlesbar), tor und den Jev-Wert je Skill; der Aufrufer schreibt ihn in die reason des Vorschlags.
 * Wirft nie.
 */

import { rufeJev } from './jev-client.js';
import { leseJevOptionen } from './jev-optionen.js';

export interface SkillSinnKandidat {
  skill_name: string;
  /** kurzer Inhalt (z. B. beste Section) fuer Jev */
  inhalt?: string;
}

export interface SkillSinnErgebnis {
  /** true = Jev hat geantwortet; nur dann gilt das Tor */
  gelaufen: boolean;
  grund?: string;
  tor: number;
  /** Jev-Wahrscheinlichkeit "hilft wirklich" je Skill (nur gepruefte, gueltige Antworten) */
  werte: Map<string, number>;
  usd?: number;
}

function kurz(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Darf ein semantischer Kandidat nach der Pruefung ausgeliefert werden? */
export function bestehtSinnpruefung(e: SkillSinnErgebnis, skillName: string): boolean {
  if (!e.gelaufen) return true;
  const p = e.werte.get(skillName);
  return p !== undefined && p >= e.tor;
}

/** Debug-Zusatz fuer die reason eines semantischen Vorschlags (leer, wenn die Pruefung aus ist). */
export function sinnpruefungsZusatz(e: SkillSinnErgebnis, skillName: string): string {
  if (e.gelaufen) {
    const p = e.werte.get(skillName);
    return p === undefined ? ', Jev-Sinnpruefung ohne Wert' : `, Jev-Sinnpruefung ${p.toFixed(2)} (Tor ${e.tor})`;
  }
  if (!e.grund || e.grund === 'aus' || e.grund === 'keine_kandidaten') return '';
  return `, Jev-Sinnpruefung ausgefallen (${e.grund})`;
}

export async function pruefeSkillTrefferSinn(
  a: { project: string; text: string; kandidaten: SkillSinnKandidat[]; agent_id?: string | null },
  deps: { fetch?: typeof fetch } = {},
): Promise<SkillSinnErgebnis> {
  const werte = new Map<string, number>();
  let tor = 0.5;
  try {
    const opt = await leseJevOptionen();
    tor = opt.skill_rerank_tor;
    const liste = a.kandidaten.filter((k) => !!k.skill_name).slice(0, opt.skill_rerank_max);
    if (liste.length === 0) return { gelaufen: false, grund: 'keine_kandidaten', tor, werte };
    const state = {
      text: kurz(a.text, 2000),
      skills: liste.map((k, i) => ({ i, name: k.skill_name, inhalt: kurz(k.inhalt, 300) })),
    };
    const questions: Record<string, unknown> = {};
    liste.forEach((_, i) => {
      questions[`skill_${i}`] = {
        type: 'noul',
        instructions:
          `Would an AI agent working on state.text actually benefit from reading skill ${i} (state.skills[${i}]) for this work? ` +
          'Judge by the meaning of the work, not by shared words, project names or similar skill names. Give the probability that the answer is yes.',
      };
    });
    const r = await rufeJev({ funktion: 'skill_rerank', project: a.project, agent_id: a.agent_id ?? null, state, questions }, deps);
    if (!r.ok) return { gelaufen: false, grund: r.grund, tor, werte };
    liste.forEach((k, i) => {
      const p = r.daten.answers?.[`skill_${i}`]?.noul;
      if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) werte.set(k.skill_name, p);
    });
    return { gelaufen: true, tor, werte, usd: r.kosten.usd };
  } catch (err) {
    console.error('[skill-rerank] Sinnpruefung fehlgeschlagen, Treffer bleiben ungeprueft:', err instanceof Error ? err.message : err);
    return { gelaufen: false, grund: 'antwort_unlesbar', tor, werte };
  }
}
