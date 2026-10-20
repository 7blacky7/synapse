/**
 * MODUL: Skill-Sinnpruefung (P23-T1, 19.10.2026, User-Vorgabe "Skill-Vorschlaege nach Sinn"; P23-T4 mehr Kontext)
 * ZWECK: Semantische Skill-Treffer (Embedding + kalibrierte Schwelle) werden VOR der Auslieferung von Jev
 *        auf Sinn geprueft: "Hilft dieser Skill den Empfaengern bei ihrer Arbeit an diesem Text wirklich?"
 *        EIN Jev-Aufruf je Quelltext (eine noul-Frage je Kandidat), fuer alle Empfaenger zusammen.
 *        Vorgegebene und verknuepfte Skills (Kette, 0,99) laufen NICHT hier durch. P23-T8: namentlich genannte
 *        Skills (0,99) laufen mit durch - ein Name im Text belegt nicht, dass der Skill bei dieser Arbeit hilft.
 * STATE (P23-T4, User 19.10.2026 "Jev braucht mehr Kontext"):
 *   quelle    Art/Anlass (thought | memory | task | channel ...) + Klartext + ID
 *   text      der Quelltext
 *   empfaenger nach Aufgabe GRUPPIERT (nicht je Empfaenger): je Gruppe Rollen, Typen, Anzahl, Aufgaben-IDs.
 *             Rolle/Typ aus dem Profil der Identitaet (profilBlock), Aufgaben = gebundene Tasks
 *             (gebundeneTasks) + Beteiligungen an offenen Tasks. Keine eigene Ausweis-Aufloesung:
 *             der Aufrufer reicht die schon aufgeloesten Ziele (identity_id | agent_id) herein.
 *   aufgaben  Titel + Beschreibung der Tasks (dedupliziert, hoechstens MAX_AUFGABEN)
 *   skills    je Kandidat: name, zweck (Uebersichts-Abschnitt des Skills), scope, projekt, abschnitt_titel,
 *             der GANZE getroffene abschnitt, abschnitte (alle Abschnittstitel des Skills)
 * BUDGET: jev_optionen skill_rerank_budget_tokens (Standard 10.000, Obergrenze 60.000 < Jev-Grenze 64k,
 *   memory wissen-jev-eingabegrenze-64k). Schaetzung konservativ Zeichen/3 ueber state + questions.
 *   Kuerzung nach Prioritaet: Zweck und Aufgabe NIE kuerzen (nur feste Sicherheitsdeckel ZWECK_MAX_ZEICHEN /
 *   AUFGABE_MAX_ZEICHEN beim Laden); zuerst die Abschnitte (gleichmaessig von oben gedeckelt), dann der
 *   Quelltext (bis QUELLTEXT_MIN_ZEICHEN), zuletzt entfallen Kandidaten vom Ende (niedrigster Score; sie
 *   bekommen keinen Wert und werden bei aktiver Pruefung nicht ausgeliefert). Passt es dann noch immer
 *   nicht unter die Obergrenze, faellt die Pruefung aus (grund budget_tokens, Treffer bleiben ungeprueft).
 * TIMEOUT: jev_optionen skill_rerank_timeout_ms (Standard 20.000) statt des festen Jev-Client-Timeouts.
 * SCHALTER: Jev-Funktion skill_rerank (admin jev_schalten). Standard AUS (jev-schalter.ts
 *   JEV_FUNKTIONEN_STANDARD_AUS): wirkt nur mit ausdruecklichem "an" oder befristetem intern-Schalter
 *   skill_rerank. Jev global/Projekt aus oder Budget-Pause -> keine Pruefung, Treffer bleiben wie bisher.
 * EINSTELLWERTE: jev_optionen skill_rerank_tor / _max / _budget_tokens / _timeout_ms (admin jev_optionen).
 * KOSTEN: rufeJev bucht jeden Aufruf in jev_aufrufe (funktion skill_rerank) -> admin jev_kosten.
 * DEBUG: Ergebnis nennt gelaufen, grund (aus | budget | kein_key | timeout | netz | http | keine_kandidaten |
 *   antwort_unlesbar | budget_tokens), tor, den Jev-Wert je Skill und budget (geschaetzte Tokens, Kuerzungen);
 *   der Aufrufer schreibt den Jev-Wert in die reason des Vorschlags.
 * DIAGNOSE (P23-T6): intern skill_probe nutzt baueSkillSinnAnfrage/werteSkillSinnAntwort (derselbe state), ruft Jev
 *   aber als eigene Funktion skill_rerank_probe (unabhaengig vom Schalter skill_rerank, Kosten getrennt sichtbar).
 * Wirft nie.
 */

import { getPool } from '../db/client.js';
import { jevKonfig, rufeJev, type JevAntwortDaten } from './jev-client.js';
import { jevWirksam } from './jev-schalter.js';
import { leseJevOptionen, SKILL_RERANK_BUDGET_GRENZE } from './jev-optionen.js';

export interface SkillSinnKandidat {
  skill_name: string;
  /** der GANZE getroffene Abschnitt (P23-T4; vorher 300 Zeichen) */
  inhalt?: string;
  /** Titel des getroffenen Abschnitts */
  abschnitt?: string | null;
  scope?: string | null;
  projekt?: string | null;
}

/** Ein Empfaenger, wie ihn der Aufrufer schon aufgeloest hat (Identitaet oder Legacy-Name). */
export interface SkillSinnEmpfaenger {
  identity_id?: string | null;
  agent_id?: string | null;
}

export interface SkillSinnBudget {
  budget_tokens: number;
  tokens_geschaetzt: number;
  abschnitte_gedeckelt_auf?: number;
  quelltext_gekuerzt_auf?: number;
  kandidaten_entfallen?: string[];
}

export interface SkillSinnErgebnis {
  /** true = Jev hat geantwortet; nur dann gilt das Tor */
  gelaufen: boolean;
  grund?: string;
  tor: number;
  /** Jev-Wahrscheinlichkeit "hilft wirklich" je Skill (nur gepruefte, gueltige Antworten) */
  werte: Map<string, number>;
  usd?: number;
  budget?: SkillSinnBudget;
}

/** Feste Sicherheitsdeckel beim LADEN (keine Budget-Kuerzung): halten den unkuerzbaren Teil unter der Jev-Grenze. */
export const ZWECK_MAX_ZEICHEN = 1500;
export const AUFGABE_MAX_ZEICHEN = 4000;
export const MAX_AUFGABEN = 10;
export const MAX_EMPFAENGER = 30;
export const QUELLTEXT_MIN_ZEICHEN = 300;
/** Abschnittstitel, die den Zweck eines Skills beschreiben (Reihenfolge = Vorrang). */
const ZWECK_ABSCHNITTE = ['uebersicht', 'overview', 'skill-overview', 'beschreibung', 'description', 'zweck', 'kernprinzip'];

function flach(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}
function kurz(text: unknown, max: number): string {
  const s = flach(text);
  if (max <= 0) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Konservative Token-Schaetzung (Zeichen/3; JSON, Deutsch und Code liegen eher bei 3,5-4). */
export function schaetzeTokens(wert: unknown): number {
  return Math.ceil(JSON.stringify(wert ?? null).length / 3);
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

interface SkillMeta { zweck: string | null; abschnitte: string[] }

/** Zweck (Uebersichts-Abschnitt) und Abschnittstitel je Skill aus PG (Quelle der Wahrheit). Wirft nie. */
export async function ladeSkillMeta(project: string, namen: string[]): Promise<Map<string, SkillMeta>> {
  const aus = new Map<string, SkillMeta>();
  if (namen.length === 0) return aus;
  try {
    const { rows } = await getPool().query<{ skill_name: string; section: string; content: string }>(
      `SELECT skill_name, section, content FROM (
         SELECT skill_name, section, content, scope, project FROM skill_sections
         UNION ALL SELECT skill_name, section, content, scope, project FROM agent_identitaet_skill_sections
       ) s WHERE skill_name = ANY($1::text[]) AND (COALESCE(scope,'global')='global' OR project=$2)
       ORDER BY skill_name, section`,
      [namen, project],
    );
    for (const z of rows) {
      const m = aus.get(z.skill_name) ?? { zweck: null, abschnitte: [] };
      if (!m.abschnitte.includes(z.section)) m.abschnitte.push(z.section);
      aus.set(z.skill_name, m);
    }
    for (const name of aus.keys()) {
      const eigene = rows.filter((z) => z.skill_name === name);
      const rang = (s: string) => { const i = ZWECK_ABSCHNITTE.indexOf(s.toLowerCase()); return i < 0 ? 99 : i; };
      const beste = eigene.filter((z) => rang(z.section) < 99).sort((a, b) => rang(a.section) - rang(b.section))[0];
      aus.get(name)!.zweck = beste ? kurz(beste.content, ZWECK_MAX_ZEICHEN) : null;
    }
  } catch (err) {
    console.error('[skill-rerank] Skill-Zweck nicht lesbar:', err instanceof Error ? err.message : err);
  }
  return aus;
}

export interface SkillSinnEmpfaengerKontext {
  /** nach Aufgabe gruppiert */
  gruppen: Array<{ aufgaben: string[]; rollen: string[]; typen: string[]; anzahl: number }>;
  aufgaben: Array<{ id: string; titel: string | null; beschreibung: string | null; status: string | null }>;
}

/**
 * Empfaengerkontext: Rolle/Typ (Profil der Identitaet) und Aufgaben (gebundene Tasks + Beteiligungen an
 * offenen Tasks), nach Aufgabe gruppiert. Nutzt die vorhandenen Profil-Lesewege (profilBlock, gebundeneTasks).
 * Wirft nie; was nicht lesbar ist, fehlt.
 */
export async function ladeEmpfaengerKontext(project: string, empfaenger: SkillSinnEmpfaenger[]): Promise<SkillSinnEmpfaengerKontext> {
  const liste = empfaenger.filter((e) => e.identity_id || e.agent_id).slice(0, MAX_EMPFAENGER);
  const je: Array<{ rolle: string | null; typ: string | null; tasks: string[] }> = [];
  let profilWeg: typeof import('./agent-profil-update.js') | null = null;
  try { profilWeg = await import('./agent-profil-update.js'); } catch { profilWeg = null; }
  for (const e of liste) {
    let rolle: string | null = null, typ: string | null = null;
    const tasks = new Set<string>();
    if (e.identity_id && profilWeg) {
      try {
        const p = await profilWeg.profilBlock(e.identity_id);
        rolle = p.rolle ?? null; typ = p.typ?.schluessel ?? null;
      } catch { /* Profil nicht lesbar: ohne Rolle/Typ */ }
      try {
        for (const t of await profilWeg.gebundeneTasks(project, e.identity_id)) tasks.add(t.task_id);
      } catch { /* keine Bindungen lesbar */ }
    }
    try {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT t.id FROM plan_tasks t WHERE t.project=$1 AND t.task->>'status' IN ('todo','in_progress','blocked')
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.task->'beteiligte')='array' THEN t.task->'beteiligte' ELSE '[]'::jsonb END) b
             WHERE ($2::text IS NOT NULL AND b->>'identity_id'=$2) OR ($3::text IS NOT NULL AND b->>'identity_id' IS NULL AND b->>'agent_id'=$3))
          ORDER BY t.updated_at DESC LIMIT 5`,
        [project, e.identity_id ?? null, e.agent_id ?? null],
      );
      for (const z of rows) tasks.add(z.id);
    } catch { /* Beteiligungen nicht lesbar */ }
    je.push({ rolle, typ, tasks: [...tasks] });
  }
  // Aufgaben (Titel + Beschreibung) in EINER Abfrage; Bindungen nennen task_id als UUID oder Kurz-ID.
  const alleIds = [...new Set(je.flatMap((x) => x.tasks))];
  const aufgabenJeRef = new Map<string, { id: string; titel: string | null; beschreibung: string | null; status: string | null }>();
  if (alleIds.length > 0) {
    try {
      const { rows } = await getPool().query<{ id: string; kurz: string | null; titel: string | null; beschreibung: string | null; status: string | null }>(
        `SELECT t.id, t.task->>'kurz_id' AS kurz, t.task->>'title' AS titel, t.task->>'description' AS beschreibung, t.task->>'status' AS status
           FROM plan_tasks t WHERE t.project=$1 AND (t.id = ANY($2::text[]) OR t.task->>'kurz_id' = ANY($2::text[]))`,
        [project, alleIds],
      );
      for (const z of rows) {
        const a = { id: z.kurz ?? z.id, titel: z.titel, beschreibung: z.beschreibung ? kurz(z.beschreibung, AUFGABE_MAX_ZEICHEN) : null, status: z.status };
        aufgabenJeRef.set(z.id, a);
        if (z.kurz) aufgabenJeRef.set(z.kurz, a);
      }
    } catch { /* Aufgaben nicht lesbar */ }
  }
  const aufgaben: SkillSinnEmpfaengerKontext['aufgaben'] = [];
  const gruppen = new Map<string, SkillSinnEmpfaengerKontext['gruppen'][number]>();
  for (const x of je) {
    const ids: string[] = [];
    for (const ref of x.tasks) {
      const a = aufgabenJeRef.get(ref);
      if (!a) continue;
      if (!aufgaben.some((b) => b.id === a.id)) {
        if (aufgaben.length >= MAX_AUFGABEN) continue;
        aufgaben.push(a);
      }
      if (!ids.includes(a.id)) ids.push(a.id);
    }
    ids.sort();
    const key = ids.join('|');
    const g = gruppen.get(key) ?? { aufgaben: ids, rollen: [], typen: [], anzahl: 0 };
    if (x.rolle && !g.rollen.includes(x.rolle)) g.rollen.push(x.rolle);
    if (x.typ && !g.typen.includes(x.typ)) g.typen.push(x.typ);
    g.anzahl++;
    gruppen.set(key, g);
  }
  return { gruppen: [...gruppen.values()], aufgaben };
}

export interface StateSkill {
  i: number; name: string; zweck: string | null; scope: string | null; projekt: string | null;
  abschnitt_titel: string | null; abschnitt: string; abschnitte: string[];
}

/**
 * Kuerzt state nach Prioritaet auf das Budget (mutiert state/questions-Liste, liefert den Budget-Bericht).
 * Reihenfolge: Abschnitte gleichmaessig deckeln -> Quelltext bis QUELLTEXT_MIN_ZEICHEN -> Kandidaten vom Ende.
 * Zweck und Aufgaben werden nie gekuerzt.
 */
export function kuerzeAufBudget(
  state: { text: string; skills: StateSkill[] } & Record<string, unknown>,
  baueFragen: (skills: StateSkill[]) => Record<string, unknown>,
  budget: number,
): SkillSinnBudget {
  const mass = () => schaetzeTokens(state) + schaetzeTokens(baueFragen(state.skills));
  const bericht: SkillSinnBudget = { budget_tokens: budget, tokens_geschaetzt: mass() };
  if (bericht.tokens_geschaetzt <= budget) return bericht;
  // 1) Abschnitte: groesster gemeinsamer Deckel c mit Summe(min(len, c)) passend (Binaersuche ueber c).
  const original = state.skills.map((s) => s.abschnitt);
  const setzeDeckel = (c: number) => state.skills.forEach((s, k) => { s.abschnitt = original[k].length > c ? kurz(original[k], c) : original[k]; });
  const laengste = Math.max(0, ...original.map((t) => t.length));
  let lo = 0, hi = laengste;
  setzeDeckel(0);
  if (mass() <= budget) {
    while (lo < hi) {
      const mitte = Math.ceil((lo + hi) / 2);
      setzeDeckel(mitte);
      if (mass() <= budget) lo = mitte; else hi = mitte - 1;
    }
    setzeDeckel(lo);
    bericht.abschnitte_gedeckelt_auf = lo;
    bericht.tokens_geschaetzt = mass();
    return bericht;
  }
  bericht.abschnitte_gedeckelt_auf = 0;
  // 2) Quelltext bis zur Mindestlaenge.
  const text = state.text;
  let tlo = Math.min(QUELLTEXT_MIN_ZEICHEN, text.length), thi = text.length;
  state.text = kurz(text, tlo);
  if (mass() <= budget) {
    while (tlo < thi) {
      const mitte = Math.ceil((tlo + thi) / 2);
      state.text = kurz(text, mitte);
      if (mass() <= budget) tlo = mitte; else thi = mitte - 1;
    }
    state.text = kurz(text, tlo);
    bericht.quelltext_gekuerzt_auf = tlo;
    bericht.tokens_geschaetzt = mass();
    return bericht;
  }
  bericht.quelltext_gekuerzt_auf = state.text.length;
  // 3) Kandidaten vom Ende (niedrigster Score), mindestens einer bleibt.
  const entfallen: string[] = [];
  while (state.skills.length > 1 && mass() > budget) entfallen.unshift(state.skills.pop()!.name);
  if (entfallen.length) bericht.kandidaten_entfallen = entfallen;
  bericht.tokens_geschaetzt = mass();
  return bericht;
}

function baueFragen(skills: StateSkill[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const s of skills) {
    questions[`skill_${s.i}`] = {
      type: 'noul',
      instructions:
        `Would the recipients (state.empfaenger, their tasks in state.aufgaben) working on state.text actually benefit from reading skill ${s.i} ` +
        `(state.skills[${s.i}]: its purpose "zweck", the matched section "abschnitt") for this work? ` +
        'Judge by the meaning of the work and the purpose of the skill, not by shared words, project names or similar skill names. ' +
        'Give the probability that the answer is yes.',
    };
  }
  return questions;
}

/** Eingabe der Sinnpruefung (Hook und intern skill_probe). */
export interface SkillSinnEingabe {
  project: string;
  text: string;
  kandidaten: SkillSinnKandidat[];
  agent_id?: string | null;
  /** P23-T4: Quelle/Anlass des Textes */
  quelle?: { art: string; klartext?: string; id?: string } | null;
  /** P23-T4: schon aufgeloeste Empfaenger (Rolle/Typ/Aufgabe werden daraus gelesen) */
  empfaenger?: SkillSinnEmpfaenger[];
}

/** state, wie er an Jev geht (P23-T4). */
export type SkillSinnState = {
  projekt: string;
  quelle: { art: string; klartext?: string; id?: string } | null;
  text: string;
  empfaenger: SkillSinnEmpfaengerKontext['gruppen'];
  aufgaben: SkillSinnEmpfaengerKontext['aufgaben'];
  skills: StateSkill[];
};

/**
 * P23-T6: baut state + questions der Sinnpruefung samt Budgetkuerzung - OHNE Schalter-/Key-Pruefung und OHNE
 * Jev-Aufruf. Gemeinsamer Weg fuer den Hook (pruefeSkillTrefferSinn) und die Diagnose intern skill_probe, damit
 * die Probe genau den state zeigt, den der Betrieb senden wuerde. Wirft nie (nicht Lesbares fehlt im state).
 */
export async function baueSkillSinnAnfrage(
  a: SkillSinnEingabe,
  opt: { skill_rerank_max: number; skill_rerank_budget_tokens: number },
): Promise<{ state: SkillSinnState; questions: Record<string, unknown>; bericht: SkillSinnBudget }> {
  const liste = a.kandidaten.filter((k) => !!k.skill_name).slice(0, opt.skill_rerank_max);
  const [meta, empf] = await Promise.all([
    ladeSkillMeta(a.project, liste.map((k) => k.skill_name)),
    ladeEmpfaengerKontext(a.project, a.empfaenger ?? []),
  ]);
  const skills: StateSkill[] = liste.map((k, i) => ({
    i,
    name: k.skill_name,
    zweck: meta.get(k.skill_name)?.zweck ?? null,
    scope: k.scope ?? 'global',
    projekt: k.projekt ?? null,
    abschnitt_titel: k.abschnitt ?? null,
    abschnitt: flach(k.inhalt),
    abschnitte: meta.get(k.skill_name)?.abschnitte ?? [],
  }));
  const state: SkillSinnState = {
    projekt: a.project,
    quelle: a.quelle ?? null,
    text: flach(a.text),
    empfaenger: empf.gruppen,
    aufgaben: empf.aufgaben,
    skills,
  };
  const bericht = kuerzeAufBudget(state, baueFragen, opt.skill_rerank_budget_tokens);
  return { state, questions: baueFragen(state.skills), bericht };
}

/** P23-T6: gueltige Jev-Werte (noul 0..1) je Skill aus einer Antwort. */
export function werteSkillSinnAntwort(state: SkillSinnState, daten: JevAntwortDaten | null | undefined): Map<string, number> {
  const werte = new Map<string, number>();
  for (const s of state.skills) {
    const p = daten?.answers?.[`skill_${s.i}`]?.noul;
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) werte.set(s.name, p);
  }
  return werte;
}

export async function pruefeSkillTrefferSinn(
  a: {
    project: string;
    text: string;
    kandidaten: SkillSinnKandidat[];
    agent_id?: string | null;
    /** P23-T4: Quelle/Anlass des Textes */
    quelle?: { art: string; klartext?: string; id?: string } | null;
    /** P23-T4: schon aufgeloeste Empfaenger (Rolle/Typ/Aufgabe werden daraus gelesen) */
    empfaenger?: SkillSinnEmpfaenger[];
  },
  deps: { fetch?: typeof fetch } = {},
): Promise<SkillSinnErgebnis> {
  const werte = new Map<string, number>();
  let tor = 0.5;
  try {
    const opt = await leseJevOptionen();
    tor = opt.skill_rerank_tor;
    const liste = a.kandidaten.filter((k) => !!k.skill_name).slice(0, opt.skill_rerank_max);
    if (liste.length === 0) return { gelaufen: false, grund: 'keine_kandidaten', tor, werte };
    // Erst Schalter/Key, dann Kontext laden: ist die Pruefung aus, kostet sie keine Profil-/Task-Abfragen.
    if (!jevKonfig().key) return { gelaufen: false, grund: 'kein_key', tor, werte };
    const w = await jevWirksam(a.project, 'skill_rerank');
    if (!w.an) return { gelaufen: false, grund: w.ebene === 'budget' ? 'budget' : 'aus', tor, werte };
    const { state, questions, bericht } = await baueSkillSinnAnfrage(a, opt);
    if (bericht.tokens_geschaetzt > SKILL_RERANK_BUDGET_GRENZE) {
      console.error(`[skill-rerank] state passt nicht unter die Obergrenze (${bericht.tokens_geschaetzt} > ${SKILL_RERANK_BUDGET_GRENZE} Tokens), keine Pruefung.`);
      return { gelaufen: false, grund: 'budget_tokens', tor, werte, budget: bericht };
    }
    const r = await rufeJev({
      funktion: 'skill_rerank', project: a.project, agent_id: a.agent_id ?? null, state, questions,
      timeout_ms: opt.skill_rerank_timeout_ms,
    }, deps);
    if (!r.ok) return { gelaufen: false, grund: r.grund, tor, werte, budget: bericht };
    for (const [name, p] of werteSkillSinnAntwort(state, r.daten)) werte.set(name, p);
    return { gelaufen: true, tor, werte, usd: r.kosten.usd, budget: bericht };
  } catch (err) {
    console.error('[skill-rerank] Sinnpruefung fehlgeschlagen, Treffer bleiben ungeprueft:', err instanceof Error ? err.message : err);
    return { gelaufen: false, grund: 'antwort_unlesbar', tor, werte };
  }
}
