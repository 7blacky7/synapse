/**
 * Modell-Empfehlung je Plan-Task per Jev (plan action 'empfehlen', JEV-3). EXPERIMENTELL.
 *
 * EIN Jev-Aufruf je Plan (OpenRouter /api/v1/systemone), zweistufig: Jev wertet alle Fragen
 * parallel aus (60 Fragen kosten das 1,08-Fache von einer, JEV-Test jev-zugang-und-api).
 *   Zustand: Plan kurz + Lage (nur das Kontingent der angefragten Familien, als Kategorien)
 *            + je Task Titel/Beschreibung gekuerzt, optional stakes/previous_attempt.
 *   Kandidaten: Standard nur Claude-CLI ('anthropic'); Codex/Gemini nur auf Nennung.
 *   Je Task i:
 *     model_<i>             choice ueber die Modelle, eine Option je Kandidat
 *     effort_<i>_<modell>   choice ueber die Stufen des Modells (nur bei > 1 Stufe)
 *     langer_kontext_<i>    noul "> 200k Tokens" -> 1M
 *   Gewertet wird effort_<i>_<gewaehltes modell>. Gibt es nur eine Option (ein Modell
 *   bzw. eine Stufe), wird nicht gefragt: direkt gesetzt, Confidence 1.0, Vermerk
 *   einzige_option.
 * Texte: criteria der Quelle (jev-criteria-katalog.ts). Claude nur mit Stufen aus criteria
 * UND model_registry.effort_stufen. Unter dem Confidence-Tor (Modellwahl) gibt es keine
 * Empfehlung, sondern {unsicher, bester_vorschlag}; eine unsichere Stufe wird nur markiert.
 *
 * Alles hier ist nur EMPFEHLUNG (User-Entscheidung 29.09.2026): der Spawner darf abweichen,
 * 'unsicher' ist ein zulaessiges Ergebnis, es wird nichts gespawnt.
 *
 * Geschrieben wird nur das Feld `empfehlung` im jeweiligen Task-Objekt von plans.tasks
 * (JSONB, keine Schemaaenderung). Das UPDATE gilt nur, wenn tasks seit dem Lesen
 * unveraendert ist; sonst neu lesen und erneut mergen — eine gleichzeitige Aenderung
 * anderer Felder geht so nicht verloren. Qdrant-Payload wird danach nachgezogen
 * (plan get liest heute noch aus Qdrant, eigene Task a82fd42f).
 *
 * Der Key (JEV_OPENROUTER_API_KEY) wird nie ausgegeben oder geloggt.
 */

import { getPool } from '../db/client.js';
import { isBinaryExtension } from '../watcher/binary.js';
import { listModels as registryModelle } from './model-registry.js';
import { getPlan, aendereTasks, planKontext, type PlanRef } from './plans.js';
import { planNummer, taskNummer } from './plan-kurz-ids.js';
import { listWrapperStatus as wrapperListe } from './wrapper-status.js';
import { istEffortStufe, type EffortStufe } from './effort.js';
import {
  JEV_KATALOG, JEV_GRUPPEN, JEV_STANDARD_KANDIDATEN, OHNE_EFFORT,
  type JevKandidat,
} from './jev-criteria.js';
import { KATALOG_QUELLE, KATALOG_STAND } from './jev-criteria-katalog.js';

export const JEV_STANDARD_URL = 'https://openrouter.ai/api/v1/systemone';
export const JEV_STANDARD_MODELL = 'typesafe/jev-1.13-20260917';
const STANDARD_TIMEOUT_MS = 10_000;
const STANDARD_CONFIDENCE_TOR = 0.5;
/** Ab dieser Wahrscheinlichkeit fuer "braucht > 200k Kontext" gilt 1M */
const SCHWELLE_LANGER_KONTEXT = 0.5;
/** Hoechstzahl der task_id je Aufruf (Zustand klein halten) */
const MAX_TASKS = 50;
/** Vermerk, wenn nicht gefragt wurde, weil es nur eine Option gab */
export const EINZIGE_OPTION = 'einzige_option';

export type JevKontext = '200k' | '1m';

/** Lage als Kategorien (Jev rechnet nicht). Synapse kennt das Kontingent nicht: der Aufrufer sagt es. */
export interface JevLage {
  claude_quota: 'plenty' | 'low' | 'exhausted';
  codex_quota: 'plenty' | 'low' | 'exhausted';
  paid_api: 'allowed' | 'not allowed';
}

const LAGE_WERTE: Record<keyof JevLage, readonly string[]> = {
  claude_quota: ['plenty', 'low', 'exhausted'],
  codex_quota: ['plenty', 'low', 'exhausted'],
  paid_api: ['allowed', 'not allowed'],
};
const STANDARD_LAGE: JevLage = { claude_quota: 'plenty', codex_quota: 'plenty', paid_api: 'not allowed' };

/** Optionale Task-Felder aus zustand_schema der Quelle; nur gueltige Werte gehen in den Zustand. */
const TASK_KATEGORIEN: Record<'stakes' | 'previous_attempt', readonly string[]> = {
  stakes: ['normal', 'critical'],
  previous_attempt: ['none', 'failed with a smaller model'],
};

export interface JevEmpfehlung {
  modell?: string;
  /** Stufe aus den criteria; null = ohne Effort (haiku). Codex/Gemini: deren eigene Stufen (none, minimal ...) */
  effort?: string | null;
  kontext?: JevKontext;
  /** Alias fuer specialist(spawn), bei 1M z. B. 'opus[1m]' */
  spawn_alias?: string;
  /** Confidence der Modellwahl (1.0 bei einziger Option) */
  confidence: number;
  /** Confidence der Stufenwahl (1.0 bei einziger Stufe) */
  effort_confidence?: number;
  /** Stufe unter dem Tor: Empfehlung bleibt, die Stufe ist aber wackelig */
  effort_unsicher?: true;
  /** einzige_option = Modell wurde nicht gefragt */
  vermerk?: typeof EINZIGE_OPTION;
  /** einzige_option = Stufe wurde nicht gefragt */
  effort_vermerk?: typeof EINZIGE_OPTION;
  p_langer_kontext: number | null;
  quelle: 'cloud';
  kandidaten: string[];
  /** Name eines idle Spezialisten derselben Familie mit 1M, sonst null */
  wiederverwenden?: string | null;
  /** false = Synapse hat fuer dieses Modell (noch) keine Runtime, z. B. Codex */
  spawnbar?: boolean;
  unsicher?: true;
  bester_vorschlag?: { modell: string; effort: string | null; kontext: JevKontext } | null;
  hinweis?: string;
  stand: string;
  experimentell: true;
}

export interface EmpfehlenOptionen {
  /** Aliase und/oder Gruppen (anthropic|abos|alle|codex|google|legacy, auch claude-abo|codex-abo|gemini-api). Standard 'anthropic'. */
  kandidaten?: unknown;
  /** PFLICHT (User-Vorgabe 29.09.2026): genau diese Tasks, hoechstens 50. Jev bewertet nur, was ausdruecklich genannt ist. */
  task_ids?: string[];
  /** PFLICHT: Plan-UUID oder Kurz-ID P<n> (ein Projekt kann mehrere Plaene haben) */
  plan_id?: string;
  /** Standard true. false = nur anzeigen. */
  schreiben?: boolean;
  /** Standard JEV_CONFIDENCE_TOR bzw. 0.5 */
  confidence_tor?: number;
  /** Kontingent/paid_api; Standard plenty/plenty/not allowed */
  lage?: Partial<Record<keyof JevLage, unknown>>;
  /** Hoechstzahl der Modelle in der Modell-Choice. Standard unbegrenzt. */
  max_optionen?: number;
  /** Eigene Prioritaeten fuer Jev (String, max 500 Zeichen), als state.hinweise mitgeschickt */
  hinweise?: unknown;
}

interface WrapperZeile { agentName: string; model: string | null; status: string; busy: boolean }

export interface JevDeps {
  fetch?: typeof fetch;
  listModels?: () => Promise<Array<{ alias: string; effortStufen?: string[] | null }>>;
  listWrapperStatus?: (project: string) => Promise<WrapperZeile[]>;
  qdrantSync?: (project: string, planId: string, tasks: unknown[], updatedAt: string) => Promise<void>;
  /** Projektfakten aus dem Index; Standard holeProjektFakten (SQL auf code_files) */
  projektFakten?: (project: string) => Promise<ProjektFakten | null>;
}

export interface EmpfehlenErgebnis {
  success: boolean;
  message: string;
  experimentell: true;
  plan_id?: string;
  kandidaten?: string[];
  /** Modelle in der Modell-Choice */
  modelle?: string[];
  /** Stufen je Modell, die angeboten wurden */
  stufen?: Record<string, string[]>;
  /** Durch max_optionen weggelassene Modelle */
  ausgelassen?: string[];
  confidence_tor?: number;
  lage?: JevLage;
  katalog?: { quelle: string; stand: string };
  empfehlungen?: Array<{ task_id: string; kurz_id: string | null; titel: string; empfehlung: JevEmpfehlung }>;
  /** Der bewertete Plan (Kurz-ID, Name) */
  plan_ref?: PlanRef;
  geschrieben?: number;
  jev?: { modell: string; fragen: number; dauer_ms: number; input_tokens: number | null; cost: number | null };
  /** Projektfakten, die Jev im Zustand bekam (fehlt: keine lesbar oder leerer Index) */
  projekt_fakten?: ProjektFakten & { tokens_ca: number; schwelle_tokens: number; gross_fuer_200k: boolean };
  /** Der als state.hinweise gesendete Text (getrimmt, auf 500 Zeichen gekuerzt); fehlt ohne Parameter */
  hinweise_verwendet?: string;
  hinweise?: string[];
  warning?: string;
}

// ---------------------------------------------------------------------------
// Kandidaten, Lage, Auswahl
// ---------------------------------------------------------------------------

/**
 * Kandidaten aus Aliasen und/oder Gruppen. Leer/fehlend = 'anthropic' (nur Claude-CLI).
 * Unbekannt -> Error mit allen erlaubten Werten.
 */
export function loeseKandidatenAuf(kandidaten: unknown): JevKandidat[] {
  let namen: string[];
  if (kandidaten === undefined || kandidaten === null || kandidaten === '') namen = [JEV_STANDARD_KANDIDATEN];
  else if (typeof kandidaten === 'string') namen = [kandidaten];
  else if (Array.isArray(kandidaten) && kandidaten.every((k) => typeof k === 'string')) {
    namen = kandidaten.length > 0 ? (kandidaten as string[]) : [JEV_STANDARD_KANDIDATEN];
  } else {
    throw new Error('kandidaten muss ein String oder eine Liste von Strings sein.');
  }

  const ergebnis = new Map<string, JevKandidat>();
  const unbekannt: string[] = [];
  for (const roh of namen) {
    const name = roh.trim();
    const gruppe = JEV_GRUPPEN[name];
    if (gruppe) {
      for (const k of JEV_KATALOG.filter(gruppe)) ergebnis.set(k.alias, k);
      continue;
    }
    const k = JEV_KATALOG.find((x) => x.alias === name);
    if (k) ergebnis.set(k.alias, k);
    else unbekannt.push(name);
  }
  if (unbekannt.length > 0) {
    throw new Error(
      `Unbekannte kandidaten: ${unbekannt.join(', ')}. Erlaubt: Gruppen ${Object.keys(JEV_GRUPPEN).join(', ')}; ` +
      `Aliase ${JEV_KATALOG.map((k) => k.alias).join(', ')}.`,
    );
  }
  return Array.from(ergebnis.values());
}

/**
 * Prueft lage gegen die Kategorien der Quelle (zustand_schema). Fehlend = Standard.
 * Ungueltig -> Error mit den erlaubten Werten.
 */
export function pruefeLage(roh: unknown): JevLage {
  if (roh === undefined || roh === null) return { ...STANDARD_LAGE };
  if (typeof roh !== 'object' || Array.isArray(roh)) throw new Error('lage muss ein Objekt sein: {claude_quota, codex_quota, paid_api}.');
  const lage = { ...STANDARD_LAGE } as Record<keyof JevLage, string>;
  for (const [feld, wert] of Object.entries(roh as Record<string, unknown>)) {
    const erlaubt = LAGE_WERTE[feld as keyof JevLage];
    if (!erlaubt) throw new Error(`Unbekanntes Feld lage.${feld}. Erlaubt: ${Object.keys(LAGE_WERTE).join(', ')}.`);
    if (wert === undefined || wert === null) continue;
    if (typeof wert !== 'string' || !erlaubt.includes(wert)) {
      throw new Error(`Ungueltiger Wert lage.${feld} = "${String(wert)}". Erlaubt: ${erlaubt.join(', ')}.`);
    }
    lage[feld as keyof JevLage] = wert;
  }
  return lage as unknown as JevLage;
}

/**
 * Vorfilter aus der Quelle (vorfilter.bedingt_raus): Claude bei claude_quota exhausted,
 * Codex bei codex_quota exhausted, Gemini ohne paid_api. Liefert die uebrigen Kandidaten
 * und je entfernter Gruppe einen Hinweis.
 */
export function filtereNachLage(kandidaten: JevKandidat[], lage: JevLage): { kandidaten: JevKandidat[]; hinweise: string[] } {
  const raus = (k: JevKandidat) =>
    (k.familie === 'anthropic' && lage.claude_quota === 'exhausted')
    || (k.familie === 'codex' && lage.codex_quota === 'exhausted')
    || (k.familie === 'google' && lage.paid_api === 'not allowed');
  const hinweise: string[] = [];
  const weg = kandidaten.filter(raus);
  if (weg.some((k) => k.familie === 'anthropic')) hinweise.push('claude_quota exhausted: Claude-Kandidaten entfernt.');
  if (weg.some((k) => k.familie === 'codex')) hinweise.push('codex_quota exhausted: Codex-Kandidaten entfernt.');
  if (weg.some((k) => k.familie === 'google')) hinweise.push('paid_api not allowed: Gemini-Kandidaten entfernt (lage.paid_api: "allowed" erlaubt sie).');
  return { kandidaten: kandidaten.filter((k) => !raus(k)), hinweise };
}

/** Schluessel-Teil einer Stufen-Frage: effort_<i>_<frageTeil(alias)> (nur a-z0-9_) */
export function frageTeil(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

interface Stufe {
  stufe: string;
  /** null = ohne Effort */
  effort: string | null;
  criterion: string;
}

export interface ModellAuswahl {
  kandidat: JevKandidat;
  /** Erlaubte Stufen in Quellreihenfolge */
  stufen: Stufe[];
  /** Text der Option in der Modell-Choice */
  kriterium: string;
}

/**
 * Je Kandidat die erlaubten Stufen und der Text fuer die Modell-Choice.
 * Claude nur mit Stufen aus criteria UND model_registry.effort_stufen ('default' = ohne
 * Effort, nur wenn das Modell keine Stufen hat). Fuehrt die Registry fuer ein Modell mit
 * Katalog-Stufen eine LEERE Liste, gilt das als unbekannt (Spalte nicht befuellt):
 * Rueckfall + Hinweis. Codex/Gemini (keine Runtime): Stufen unveraendert.
 * Modell-Text: bei einer Stufe deren Text, sonst die Aufzaehlung der erlaubten Stufentexte.
 * max: Hoechstzahl der Modelle (Standard unbegrenzt), der Rest in Kandidatenreihenfolge faellt weg.
 */
export function baueAuswahl(
  kandidaten: JevKandidat[],
  stufenJeAlias: Map<string, EffortStufe[]>,
  max?: number,
): { modelle: ModellAuswahl[]; ausgelassen: string[]; hinweise: string[] } {
  const modelle: ModellAuswahl[] = [];
  const hinweise: string[] = [];
  for (const k of kandidaten) {
    let erlaubt: readonly string[] | null = null;
    if (k.registryAlias) {
      const ausRegistry = stufenJeAlias.get(k.registryAlias);
      const rueckfall = k.effortStufen ?? [];
      if (ausRegistry && (ausRegistry.length > 0 || rueckfall.length === 0)) {
        erlaubt = ausRegistry;
      } else {
        erlaubt = rueckfall;
        if (ausRegistry) hinweise.push(`model_registry fuehrt fuer ${k.registryAlias} keine effort_stufen, Rueckfall: ${rueckfall.join(', ')}.`);
      }
    }
    const stufen: Stufe[] = [];
    for (const o of k.optionen) {
      const effort = o.stufe === OHNE_EFFORT ? null : o.stufe;
      if (erlaubt && (effort === null ? erlaubt.length > 0 : !erlaubt.includes(effort))) continue;
      stufen.push({ stufe: o.stufe, effort, criterion: o.criterion });
    }
    if (stufen.length === 0) {
      hinweise.push(`${k.alias}: keine Stufe aus den criteria ist fuer dieses Modell erlaubt, Kandidat entfernt.`);
      continue;
    }
    const kriterium = stufen.length === 1
      ? stufen[0].criterion
      : `The model fits when one of these holds: ${stufen.map((s, j) => `(${j + 1}) ${s.criterion}`).join(' ')}`;
    modelle.push({ kandidat: k, stufen, kriterium });
  }
  if (max !== undefined && modelle.length > max) {
    const weg = modelle.splice(max);
    return { modelle, ausgelassen: weg.map((m) => m.kandidat.alias), hinweise };
  }
  return { modelle, ausgelassen: [], hinweise };
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function kurz(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function zahlAusEnv(name: string): number | undefined {
  const roh = process.env[name]?.trim();
  if (!roh) return undefined;
  const n = Number(roh);
  return Number.isFinite(n) ? n : undefined;
}

function ist1M(model: string): boolean {
  // sonnet (CLI-Alias) ist nativ 1M (P7-T23, gemessen 29.09.2026)
  return model.endsWith('[1m]') || model.startsWith('fable') || model === 'sonnet';
}

// ---------------------------------------------------------------------------
// Projektfakten (JEV-8) und hinweise
// ---------------------------------------------------------------------------

/**
 * Ab dieser Groesse des indexierten Codes (Tokens, grob Zeichen/4) gilt das Projekt als
 * "zu gross fuer ein 200k-Fenster": dann reichen 200k nur fuer eine sehr kleine, direkte Task.
 * Standard 150000: ein 200k-Fenster hat nach System-Prompt, Tool-Schemas (~40k) und
 * Antwortreserve nur etwa 130-150k fuer Projektinhalt. Ist der ganze Index groesser, kann eine
 * Task, die mehrere Stellen lesen muss, ihn nicht im Blick halten. Ueberschreibbar per Env
 * JEV_KONTEXT_PROJEKT_TOKENS.
 */
export const STANDARD_SCHWELLE_PROJEKT_TOKENS = 150_000;
/** Laenge des optionalen Parameters hinweise (Zustand klein halten) */
export const MAX_HINWEISE_ZEICHEN = 500;

export interface ProjektFakten {
  dateien: number;
  zeichen: number;
  sprachen: Array<{ typ: string; dateien: number; anteil_prozent: number }>;
}

/** Lockfiles ohne .lock-Endung, die die Binaerliste nicht kennt */
const LOCKFILE_NAMEN = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/i;

/**
 * Projektfakten aus dem Code-Index: nur LEBENDE Dateien (deleted_at IS NULL), ohne
 * Binaerdateien (Bilder, Archive, ... laut watcher/binary.ts) und ohne Lockfiles — ein grosses
 * PNG oder package-lock.json wuerde die Tokenzahl sonst aufblasen. Ein Aufruf, ohne Embedding.
 * Leerer Index -> null.
 */
export async function holeProjektFakten(project: string): Promise<ProjektFakten | null> {
  const { rows } = await getPool().query(
    `SELECT file_path, file_type, file_size FROM code_files WHERE project = $1 AND deleted_at IS NULL`,
    [project],
  );
  let dateien = 0;
  let zeichen = 0;
  const jeTyp = new Map<string, { dateien: number; zeichen: number }>();
  for (const r of rows as Array<{ file_path: string; file_type: string | null; file_size: number | string | null }>) {
    if (isBinaryExtension(r.file_path) || LOCKFILE_NAMEN.test(r.file_path)) continue;
    const groesse = Number(r.file_size ?? 0);
    const g = Number.isFinite(groesse) && groesse > 0 ? groesse : 0;
    dateien += 1;
    zeichen += g;
    const typ = (r.file_type ?? '').toLowerCase().replace(/^\./, '') || 'sonstige';
    const e = jeTyp.get(typ) ?? { dateien: 0, zeichen: 0 };
    e.dateien += 1;
    e.zeichen += g;
    jeTyp.set(typ, e);
  }
  if (dateien === 0) return null;
  const sprachen = Array.from(jeTyp.entries())
    .sort((a, b) => b[1].zeichen - a[1].zeichen || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([typ, e]) => ({
      typ,
      dateien: e.dateien,
      anteil_prozent: zeichen > 0 ? Math.round((e.zeichen / zeichen) * 100) : 0,
    }));
  return { dateien, zeichen, sprachen };
}

/**
 * Zusatz an der langer_kontext-Anweisung je nach Projektgroesse. 'Direkt' ist die User-Definition
 * vom 29.09.2026 (Channel 23214): die Task beschreibt detailliert, WIE etwas gemacht wird, mit wenig
 * Spielraum; indirekt = 'behebe Problem B', verschachtelt, Ursache unklar.
 */
/** Begruendung des Users (Channel 23215), in langer_kontext (grosses Projekt) und model_/effort_ */
const DIREKT_BEGRUENDUNG =
  ' Reason: with a direct task the agent reads the task, sees the next step, does it and is done. ' +
  'With an indirect task it must search first; in a large project the search results alone fill 200k, ' +
  'and small models (haiku) search poorly even with economical tools. So indirect tasks in large projects ' +
  'need more than 200k and should not go to haiku.';

function projektZusatz(grossFuer200k: boolean): string {
  return grossFuer200k
    ? ' The project in the state is large (project.tokens_ca tokens of code, more than fits in 200k). ' +
      'At this size 200k is enough only if the task is direct: it describes in detail how something is to be done, ' +
      'leaving little room for deviation (for example a single call or a precisely specified change at a known spot). ' +
      'An indirect task — "fix problem B" where the problem is entangled with many other code changes and its cause ' +
      'is unclear — needs more than 200k.' +
      DIREKT_BEGRUENDUNG
    : ' The project in the state is small (project.tokens_ca tokens of code); 200k is normally enough unless the task itself spans very long material.';
}

/** Gleiche Unterscheidung fuer model_ und effort_: direkt genuegt kleiner/niedriger, indirekt braucht mehr */
const DIREKT_ZUSATZ =
  ' A direct task (it describes in detail how something is to be done, leaving little room for deviation) ' +
  'usually needs only a smaller model and a lower effort level; an indirect task (for example "fix problem B" ' +
  'where the problem is entangled with many other code changes and its cause is unclear) needs a stronger one.' +
  DIREKT_BEGRUENDUNG;

const HINWEIS_ZUSATZ = ' Take the notes in state.hinweise into account.';

/** Fehlertext ohne Key (falls ein Upstream ihn je zurueckspiegelt) */
function ohneKey(text: string, key: string): string {
  return key ? text.split(key).join('***') : text;
}

/**
 * Schreibt empfehlung je Task-ID in DIESEN Plan — ueber den Plan-Service (optimistisch: nur
 * wenn tasks seit dem Lesen unveraendert ist, sonst neu lesen; Qdrant danach best effort).
 */
async function schreibeEmpfehlungen(
  project: string,
  planId: string,
  empfehlungen: Map<string, JevEmpfehlung>,
): Promise<{ geschrieben: number; warning?: string }> {
  const r = await aendereTasks(project, planId, (tasks) => {
    let geschrieben = 0;
    const neu = tasks.map((t) => {
      const e = typeof t.id === 'string' ? empfehlungen.get(t.id) : undefined;
      if (!e) return t;
      geschrieben++;
      return { ...t, empfehlung: e };
    });
    return { tasks: neu, ergebnis: geschrieben };
  });
  if (!r) throw new Error(`Plan ${planId} fuer Projekt ${project} ist verschwunden, nichts geschrieben.`);
  return { geschrieben: r.ergebnis, ...(r.warning ? { warning: r.warning } : {}) };
}

/**
 * task_id -> Task DIESES Plans: UUID oder Kurz-ID P<n>-T<m>. Gehoert die Kurz-ID zu einem
 * anderen Plan oder gibt es die Task nicht: Fehlertext, sonst die Task.
 */
function findeTaskImPlan(
  plan: { id: string; kurz_id?: string | null; name: string; tasks: Array<Record<string, unknown>> },
  ref: string,
): Record<string, unknown> | string {
  const kurz = taskNummer(ref);
  if (kurz) {
    if (planNummer(plan.kurz_id) !== kurz.plan) {
      return `Task ${ref} gehoert nicht zu Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
    }
    const t = plan.tasks.find((x) => typeof x.kurz_id === 'string' && x.kurz_id.toUpperCase() === ref.toUpperCase());
    return t ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id}`;
  }
  return plan.tasks.find((x) => x.id === ref) ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
}

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

export async function empfehleFuerPlan(
  project: string,
  optionen: EmpfehlenOptionen = {},
  deps: JevDeps = {},
): Promise<EmpfehlenErgebnis> {
  const fehlschlag = (message: string): EmpfehlenErgebnis => ({ success: false, experimentell: true, message });

  const key = process.env.JEV_OPENROUTER_API_KEY?.trim() ?? '';
  if (!key) {
    return fehlschlag(
      'Jev nicht konfiguriert: JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses (REST-API bzw. MCP-Server). ' +
      'Ohne Key gibt es keine Empfehlung; Plan und Tasks bleiben unveraendert.',
    );
  }
  const url = process.env.JEV_API_URL?.trim() || JEV_STANDARD_URL;
  const modell = process.env.JEV_MODELL?.trim() || JEV_STANDARD_MODELL;
  const timeoutMs = zahlAusEnv('JEV_TIMEOUT_MS') ?? STANDARD_TIMEOUT_MS;
  const torRoh = typeof optionen.confidence_tor === 'number' ? optionen.confidence_tor : zahlAusEnv('JEV_CONFIDENCE_TOR');
  const tor = torRoh !== undefined && torRoh >= 0 && torRoh <= 1 ? torRoh : STANDARD_CONFIDENCE_TOR;
  const schreiben = optionen.schreiben !== false;
  const maxRoh = optionen.max_optionen;
  const maxModelle = typeof maxRoh === 'number' && Number.isFinite(maxRoh) && maxRoh >= 1 ? Math.floor(maxRoh) : undefined;
  const hinweise: string[] = [];

  // task_id ist Pflicht: kein stilles "alle offenen Tasks bewerten" mehr.
  const taskIds = (optionen.task_ids ?? []).filter((id) => typeof id === 'string' && id.trim() !== '');
  if (taskIds.length === 0) {
    return fehlschlag('task_id ist Pflicht: die zu bewertenden Task-IDs ausdruecklich angeben (String oder Array). Jev bewertet nur, was genannt ist.');
  }
  if (taskIds.length > MAX_TASKS) {
    return fehlschlag(`hoechstens ${MAX_TASKS} task_id je Aufruf (angegeben: ${taskIds.length}). Bitte aufteilen.`);
  }
  // plan_id ist Pflicht (Channel 23096): ein Projekt kann mehrere Plaene haben.
  const planRef = typeof optionen.plan_id === 'string' ? optionen.plan_id.trim() : '';
  if (!planRef) {
    return fehlschlag('plan_id ist Pflicht: den Plan ausdruecklich angeben (UUID oder Kurz-ID P<n>, siehe plan(list)). Jev bewertet genau die genannten Tasks dieses Plans.');
  }

  let kandidaten: JevKandidat[];
  let lage: JevLage;
  try {
    kandidaten = loeseKandidatenAuf(optionen.kandidaten);
    lage = pruefeLage(optionen.lage);
  } catch (err) {
    return fehlschlag(err instanceof Error ? err.message : String(err));
  }
  const gefiltert = filtereNachLage(kandidaten, lage);
  hinweise.push(...gefiltert.hinweise);
  if (gefiltert.kandidaten.length === 0) {
    return fehlschlag(`Alle Kandidaten durch den Vorfilter entfernt: ${gefiltert.hinweise.join(' ')}`);
  }
  kandidaten = gefiltert.kandidaten;
  const kandidatenAliase = kandidaten.map((k) => k.alias);

  try {
    // --- Plan und Tasks -----------------------------------------------------
    const plan = await getPlan(project, planRef);
    if (!plan) return fehlschlag(`Kein Plan gefunden fuer Projekt: ${project}`);
    const planMin = { id: plan.id, kurz_id: plan.kurz_id, name: plan.name, tasks: plan.tasks as Array<Record<string, unknown>> };
    const aufgeloest = taskIds.map((ref) => findeTaskImPlan(planMin, ref));
    const fehler = aufgeloest.filter((x): x is string => typeof x === 'string');
    if (fehler.length > 0) return fehlschlag(fehler.join('; '));
    const tasks = aufgeloest as Array<Record<string, unknown>>;

    // --- Registry (Effort-Stufen, spawnbar) --------------------------------
    const stufenJeAlias = new Map<string, EffortStufe[]>();
    let registryOk = true;
    try {
      const modelle = await (deps.listModels ?? registryModelle)();
      for (const m of modelle) stufenJeAlias.set(m.alias, (m.effortStufen ?? []).filter(istEffortStufe));
    } catch (err) {
      registryOk = false;
      hinweise.push(`model_registry nicht lesbar, Effort-Stufen aus dem Katalog: ${err instanceof Error ? err.message : String(err)}`);
    }
    const auswahl = baueAuswahl(kandidaten, stufenJeAlias, maxModelle);
    hinweise.push(...auswahl.hinweise);
    const modelle = auswahl.modelle;
    if (modelle.length === 0) return fehlschlag('Kein Modell uebrig (Kandidaten ohne erlaubte Stufe).');
    if (auswahl.ausgelassen.length > 0) {
      hinweise.push(`max_optionen ${maxModelle}: Modelle ausgelassen: ${auswahl.ausgelassen.join(', ')}`);
    }

    // --- Anfrage ------------------------------------------------------------
    const stateTasks = tasks.map((t, i) => {
      const eintrag: Record<string, unknown> = {
        task: i,
        title: kurz(t.title, 200),
        description: kurz(t.description, 700),
        priority: typeof t.priority === 'string' ? t.priority : undefined,
      };
      for (const [feld, erlaubt] of Object.entries(TASK_KATEGORIEN)) {
        const wert = t[feld];
        if (wert === undefined || wert === null) continue;
        if (typeof wert === 'string' && erlaubt.includes(wert)) eintrag[feld] = wert;
        else hinweise.push(`Task ${String(t.id)}: ${feld} "${String(wert)}" ungueltig (erlaubt: ${erlaubt.join(', ')}), weggelassen.`);
      }
      return eintrag;
    });
    // Nur das Kontingent der Familien, die zur Wahl stehen (Zustand klein halten)
    const familien = new Set(kandidaten.map((k) => k.familie));
    const situation: Partial<JevLage> = {};
    if (familien.has('anthropic')) situation.claude_quota = lage.claude_quota;
    if (familien.has('codex')) situation.codex_quota = lage.codex_quota;
    if (familien.has('google')) situation.paid_api = lage.paid_api;
    // --- Projektfakten und hinweise (JEV-8) -----------------------------------
    const schwelleTokens = zahlAusEnv('JEV_KONTEXT_PROJEKT_TOKENS') ?? STANDARD_SCHWELLE_PROJEKT_TOKENS;
    let fakten: ProjektFakten & { tokens_ca: number; schwelle_tokens: number; gross_fuer_200k: boolean } | undefined;
    try {
      const roh = await (deps.projektFakten ?? holeProjektFakten)(project);
      if (roh && roh.dateien > 0) {
        const tokensCa = Math.round(roh.zeichen / 4);
        fakten = { ...roh, tokens_ca: tokensCa, schwelle_tokens: schwelleTokens, gross_fuer_200k: tokensCa > schwelleTokens };
      }
    } catch (err) {
      hinweise.push(`Projektfakten nicht lesbar, Empfehlung laeuft ohne sie: ${err instanceof Error ? err.message : String(err)}`);
    }
    let hinweiseText: string | undefined;
    if (typeof optionen.hinweise === 'string' && optionen.hinweise.trim() !== '') {
      const roh = optionen.hinweise.trim();
      if (roh.length > MAX_HINWEISE_ZEICHEN) {
        hinweise.push(`hinweise auf ${MAX_HINWEISE_ZEICHEN} Zeichen gekuerzt (angegeben: ${roh.length}).`);
        hinweiseText = roh.slice(0, MAX_HINWEISE_ZEICHEN);
      } else {
        hinweiseText = roh;
      }
    }
    const hinweisSuffix = hinweiseText ? HINWEIS_ZUSATZ : '';
    const state = {
      plan: {
        name: kurz(plan.name, 200),
        goal: kurz(plan.description, 500),
        architecture: kurz(plan.architecture, 300),
        goals: (plan.goals ?? []).slice(0, 5).map((g) => kurz(g, 150)),
      },
      ...(fakten
        ? {
            project: {
              name: project,
              dateien: fakten.dateien,
              zeichen: fakten.zeichen,
              tokens_ca: fakten.tokens_ca,
              sprachen: fakten.sprachen,
              gross_fuer_200k: fakten.gross_fuer_200k,
            },
          }
        : {}),
      ...(hinweiseText ? { hinweise: hinweiseText } : {}),
      situation,
      tasks: stateTasks,
    };

    const modellCriteria = Object.fromEntries(modelle.map((m) => [m.kandidat.alias, m.kriterium]));
    const questions: Record<string, unknown> = {};
    tasks.forEach((_, i) => {
      if (modelle.length > 1) {
        questions[`model_${i}`] = {
          type: 'choice',
          instructions:
            `Choose the model that should run task ${i} of the plan in the state. ` +
            'Prefer the least expensive model whose condition is fully met, and choose a stronger model only when the task clearly needs it. ' +
            'For hard tasks a larger model at a moderate effort level usually costs less per solved task than a smaller model at its highest level.' +
            DIREKT_ZUSATZ +
            hinweisSuffix,
          criteria: modellCriteria,
        };
      }
      for (const m of modelle) {
        if (m.stufen.length < 2) continue;
        questions[`effort_${i}_${frageTeil(m.kandidat.alias)}`] = {
          type: 'choice',
          instructions:
            `Assume task ${i} of the plan in the state runs on the model ${m.kandidat.alias}, and choose its effort level. ` +
            'Prefer the lowest level whose condition is fully met; the highest levels rarely pay off.' +
            DIREKT_ZUSATZ +
            hinweisSuffix,
          criteria: Object.fromEntries(m.stufen.map((s) => [s.stufe, s.criterion])),
        };
      }
      questions[`langer_kontext_${i}`] = {
        type: 'noul',
        instructions:
          `Task ${i} of the plan in the state needs more than 200k tokens of context at once: ` +
          'it must read or keep a large codebase, many long files, or a very long working session in view.' +
          (fakten ? projektZusatz(fakten.gross_fuer_200k) : '') +
          hinweisSuffix,
      };
    });
    const fragen = Object.keys(questions).length;

    const f = deps.fetch ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const start = Date.now();
    let antwort: Response;
    try {
      antwort = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: modell, state, questions }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return fehlschlag(`Jev-Timeout nach ${timeoutMs} ms, nichts geschrieben.`);
      return fehlschlag(ohneKey(`Jev nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`, key));
    } finally {
      clearTimeout(timer);
    }
    if (!antwort.ok) {
      const text = await antwort.text().catch(() => '');
      return fehlschlag(ohneKey(`Jev-Fehler HTTP ${antwort.status}: ${kurz(text, 300)}`, key));
    }
    const daten = (await antwort.json()) as {
      answers?: Record<string, { choice?: unknown; confidence?: unknown; noul?: unknown }>;
      usage?: { input_tokens?: number; cost?: number };
    };
    const dauerMs = Date.now() - start;
    const answers = daten.answers ?? {};
    const zahl = (x: unknown) => (typeof x === 'number' ? x : 0);

    // --- Auswertung ---------------------------------------------------------
    let wrapper: WrapperZeile[] = [];
    try {
      wrapper = await (deps.listWrapperStatus ?? wrapperListe)(project);
    } catch (err) {
      hinweise.push(`wrapper_status nicht lesbar, wiederverwenden bleibt leer: ${err instanceof Error ? err.message : String(err)}`);
    }
    const stand = new Date().toISOString();
    const ergebnisse: Array<{ task_id: string; kurz_id: string | null; titel: string; empfehlung: JevEmpfehlung }> = [];

    tasks.forEach((t, i) => {
      const pRoh = answers[`langer_kontext_${i}`]?.noul;
      const p = typeof pRoh === 'number' ? pRoh : null;
      const kontext: JevKontext = p !== null && p >= SCHWELLE_LANGER_KONTEXT ? '1m' : '200k';
      const basis = { p_langer_kontext: p, quelle: 'cloud' as const, kandidaten: kandidatenAliase, stand, experimentell: true as const };

      // Stufe 1: Modell
      let m: ModellAuswahl | undefined;
      let confidence: number;
      let vermerk: typeof EINZIGE_OPTION | undefined;
      if (modelle.length === 1) {
        m = modelle[0];
        confidence = 1;
        vermerk = EINZIGE_OPTION;
      } else {
        const a = answers[`model_${i}`];
        m = modelle.find((x) => x.kandidat.alias === a?.choice);
        confidence = zahl(a?.confidence);
      }
      if (!m) {
        ergebnisse.push({ task_id: String(t.id), kurz_id: typeof t.kurz_id === 'string' ? t.kurz_id : null, titel: String(t.title ?? ''), empfehlung: { ...basis, unsicher: true, bester_vorschlag: null, confidence: 0, hinweis: 'Jev lieferte keine gueltige Modellwahl.' } });
        return;
      }

      // Stufe 2: Stufe des GEWAEHLTEN Modells
      let s: Stufe | undefined;
      let effortConfidence: number;
      let effortVermerk: typeof EINZIGE_OPTION | undefined;
      if (m.stufen.length === 1) {
        s = m.stufen[0];
        effortConfidence = 1;
        effortVermerk = EINZIGE_OPTION;
      } else {
        const a = answers[`effort_${i}_${frageTeil(m.kandidat.alias)}`];
        s = m.stufen.find((x) => x.stufe === a?.choice);
        effortConfidence = zahl(a?.confidence);
      }
      const k = m.kandidat;
      if (!s) {
        ergebnisse.push({ task_id: String(t.id), kurz_id: typeof t.kurz_id === 'string' ? t.kurz_id : null, titel: String(t.title ?? ''), empfehlung: { ...basis, unsicher: true, bester_vorschlag: { modell: k.alias, effort: null, kontext }, confidence, hinweis: 'Jev lieferte keine gueltige Stufe.' } });
        return;
      }

      let empfehlung: JevEmpfehlung;
      if (confidence < tor) {
        empfehlung = { ...basis, unsicher: true, bester_vorschlag: { modell: k.alias, effort: s.effort, kontext }, confidence, effort_confidence: effortConfidence };
      } else {
        const spawnbar = k.registryAlias ? (registryOk ? stufenJeAlias.has(k.registryAlias) : true) : false;
        const kollege = k.registryAlias
          ? wrapper.find((w) => w.status === 'idle' && !w.busy && typeof w.model === 'string'
            && ist1M(w.model) && w.model.replace(/\[1m\]$/, '') === k.registryAlias)
          : undefined;
        empfehlung = {
          modell: k.alias,
          effort: s.effort,
          kontext,
          spawn_alias: kontext === '1m' && k.einsMAlias ? k.einsMAlias : k.alias,
          confidence,
          effort_confidence: effortConfidence,
          ...(effortConfidence < tor ? { effort_unsicher: true as const } : {}),
          ...(vermerk ? { vermerk } : {}),
          ...(effortVermerk ? { effort_vermerk: effortVermerk } : {}),
          ...basis,
          wiederverwenden: kollege?.agentName ?? null,
          spawnbar,
        };
        if (kontext === '1m' && !k.einsMAlias) empfehlung.hinweis = `Fuer ${k.alias} ist kein 1M-Alias bekannt.`;
      }
      ergebnisse.push({ task_id: String(t.id), kurz_id: typeof t.kurz_id === 'string' ? t.kurz_id : null, titel: String(t.title ?? ''), empfehlung });
    });

    let geschrieben = 0;
    let warning: string | undefined;
    if (schreiben) {
      const map = new Map(ergebnisse.map((e) => [e.task_id, e.empfehlung]));
      ({ geschrieben, warning } = await schreibeEmpfehlungen(project, plan.id, map));
    }

    const unsicher = ergebnisse.filter((e) => e.empfehlung.unsicher).length;
    return {
      success: true,
      experimentell: true,
      message:
        `${ergebnisse.length} Task(s) bewertet, ${unsicher} unsicher (Tor ${tor}), ${fragen} Fragen in einem Aufruf. ` +
        (schreiben ? `${geschrieben} Empfehlung(en) in plans.tasks geschrieben.` : 'Nicht geschrieben (schreiben:false).') +
        ' Nur Empfehlung, kein Muss.',
      plan_id: plan.id,
      kandidaten: kandidatenAliase,
      modelle: modelle.map((x) => x.kandidat.alias),
      stufen: Object.fromEntries(modelle.map((x) => [x.kandidat.alias, x.stufen.map((s) => s.stufe)])),
      ausgelassen: auswahl.ausgelassen,
      confidence_tor: tor,
      lage,
      katalog: { quelle: KATALOG_QUELLE, stand: KATALOG_STAND },
      empfehlungen: ergebnisse,
      plan_ref: planKontext(plan).plan_ref,
      geschrieben,
      jev: {
        modell,
        fragen,
        dauer_ms: dauerMs,
        input_tokens: typeof daten.usage?.input_tokens === 'number' ? daten.usage.input_tokens : null,
        cost: typeof daten.usage?.cost === 'number' ? daten.usage.cost : null,
      },
      ...(fakten ? { projekt_fakten: fakten } : {}),
      ...(hinweiseText ? { hinweise_verwendet: hinweiseText } : {}),
      ...(hinweise.length > 0 ? { hinweise } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    return fehlschlag(ohneKey(`Empfehlung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, key));
  }
}
