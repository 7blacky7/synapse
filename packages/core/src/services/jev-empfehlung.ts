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
import { COLLECTIONS } from '../types/index.js';
import { getQdrantClient } from '../qdrant/client.js';
import { listModels as registryModelle } from './model-registry.js';
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
  /** Standard true. false = nur anzeigen. */
  schreiben?: boolean;
  /** Standard JEV_CONFIDENCE_TOR bzw. 0.5 */
  confidence_tor?: number;
  /** Kontingent/paid_api; Standard plenty/plenty/not allowed */
  lage?: Partial<Record<keyof JevLage, unknown>>;
  /** Hoechstzahl der Modelle in der Modell-Choice. Standard unbegrenzt. */
  max_optionen?: number;
}

interface WrapperZeile { agentName: string; model: string | null; status: string; busy: boolean }

export interface JevDeps {
  fetch?: typeof fetch;
  listModels?: () => Promise<Array<{ alias: string; effortStufen?: string[] | null }>>;
  listWrapperStatus?: (project: string) => Promise<WrapperZeile[]>;
  qdrantSync?: (project: string, planId: string, tasks: unknown[], updatedAt: string) => Promise<void>;
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
  empfehlungen?: Array<{ task_id: string; titel: string; empfehlung: JevEmpfehlung }>;
  geschrieben?: number;
  jev?: { modell: string; fragen: number; dauer_ms: number; input_tokens: number | null; cost: number | null };
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
  return model.endsWith('[1m]') || model.startsWith('fable');
}

/** Fehlertext ohne Key (falls ein Upstream ihn je zurueckspiegelt) */
function ohneKey(text: string, key: string): string {
  return key ? text.split(key).join('***') : text;
}

interface PlanZeile {
  id: string;
  name: string;
  description: string | null;
  goals: string[] | null;
  architecture: string | null;
  tasks: Array<Record<string, unknown>> | null;
}

async function lesePlan(project: string): Promise<PlanZeile | null> {
  const { rows } = await getPool().query<PlanZeile>(
    `SELECT id, name, description, goals, architecture, tasks FROM plans WHERE project = $1
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [project],
  );
  return rows[0] ?? null;
}

async function qdrantSyncStandard(project: string, planId: string, tasks: unknown[], updatedAt: string): Promise<void> {
  await getQdrantClient().setPayload(COLLECTIONS.projectPlans(project), {
    wait: true,
    points: [planId],
    payload: { tasks, updated_at: updatedAt },
  });
}

/**
 * Schreibt empfehlung je Task-ID. Nur wenn tasks seit dem Lesen unveraendert ist
 * (Vergleich im UPDATE), sonst neu lesen und nochmal — hoechstens drei Versuche.
 */
async function schreibeEmpfehlungen(
  project: string,
  empfehlungen: Map<string, JevEmpfehlung>,
  qdrantSync: NonNullable<JevDeps['qdrantSync']>,
): Promise<{ geschrieben: number; warning?: string }> {
  for (let versuch = 0; versuch < 3; versuch++) {
    const plan = await lesePlan(project);
    if (!plan) throw new Error(`Plan fuer Projekt ${project} ist verschwunden, nichts geschrieben.`);
    const alt = Array.isArray(plan.tasks) ? plan.tasks : [];
    let geschrieben = 0;
    const neu = alt.map((t) => {
      const e = typeof t.id === 'string' ? empfehlungen.get(t.id) : undefined;
      if (!e) return t;
      geschrieben++;
      return { ...t, empfehlung: e };
    });
    const jetzt = new Date().toISOString();
    const res = await getPool().query(
      'UPDATE plans SET tasks = $1::jsonb, updated_at = $2 WHERE id = $3 AND tasks = $4::jsonb',
      [JSON.stringify(neu), jetzt, plan.id, JSON.stringify(alt)],
    );
    if (res.rowCount === 1) {
      let warning: string | undefined;
      try {
        await qdrantSync(project, plan.id, neu, jetzt);
      } catch (err) {
        warning = `Qdrant-Payload nicht nachgezogen (PG ist geschrieben): ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[Synapse] jev-empfehlung: ${warning}`);
      }
      return { geschrieben, warning };
    }
  }
  throw new Error('Plan-Tasks wurden waehrenddessen mehrfach geaendert, Empfehlungen nicht geschrieben.');
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
    const plan = await lesePlan(project);
    if (!plan) return fehlschlag(`Kein Plan gefunden fuer Projekt: ${project}`);
    const alleTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const fehlend = taskIds.filter((id) => !alleTasks.some((t) => t.id === id));
    if (fehlend.length > 0) return fehlschlag(`Task nicht gefunden: ${fehlend.join(', ')}`);
    const tasks = taskIds.map((id) => alleTasks.find((t) => t.id === id)!);

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
    const state = {
      plan: {
        name: kurz(plan.name, 200),
        goal: kurz(plan.description, 500),
        architecture: kurz(plan.architecture, 300),
        goals: (plan.goals ?? []).slice(0, 5).map((g) => kurz(g, 150)),
      },
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
            'For hard tasks a larger model at a moderate effort level usually costs less per solved task than a smaller model at its highest level.',
          criteria: modellCriteria,
        };
      }
      for (const m of modelle) {
        if (m.stufen.length < 2) continue;
        questions[`effort_${i}_${frageTeil(m.kandidat.alias)}`] = {
          type: 'choice',
          instructions:
            `Assume task ${i} of the plan in the state runs on the model ${m.kandidat.alias}, and choose its effort level. ` +
            'Prefer the lowest level whose condition is fully met; the highest levels rarely pay off.',
          criteria: Object.fromEntries(m.stufen.map((s) => [s.stufe, s.criterion])),
        };
      }
      questions[`langer_kontext_${i}`] = {
        type: 'noul',
        instructions:
          `Task ${i} of the plan in the state needs more than 200k tokens of context at once: ` +
          'it must read or keep a large codebase, many long files, or a very long working session in view.',
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
    const ergebnisse: Array<{ task_id: string; titel: string; empfehlung: JevEmpfehlung }> = [];

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
        ergebnisse.push({ task_id: String(t.id), titel: String(t.title ?? ''), empfehlung: { ...basis, unsicher: true, bester_vorschlag: null, confidence: 0, hinweis: 'Jev lieferte keine gueltige Modellwahl.' } });
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
        ergebnisse.push({ task_id: String(t.id), titel: String(t.title ?? ''), empfehlung: { ...basis, unsicher: true, bester_vorschlag: { modell: k.alias, effort: null, kontext }, confidence, hinweis: 'Jev lieferte keine gueltige Stufe.' } });
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
      ergebnisse.push({ task_id: String(t.id), titel: String(t.title ?? ''), empfehlung });
    });

    let geschrieben = 0;
    let warning: string | undefined;
    if (schreiben) {
      const map = new Map(ergebnisse.map((e) => [e.task_id, e.empfehlung]));
      ({ geschrieben, warning } = await schreibeEmpfehlungen(project, map, deps.qdrantSync ?? qdrantSyncStandard));
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
      geschrieben,
      jev: {
        modell,
        fragen,
        dauer_ms: dauerMs,
        input_tokens: typeof daten.usage?.input_tokens === 'number' ? daten.usage.input_tokens : null,
        cost: typeof daten.usage?.cost === 'number' ? daten.usage.cost : null,
      },
      ...(hinweise.length > 0 ? { hinweise } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    return fehlschlag(ohneKey(`Empfehlung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, key));
  }
}
