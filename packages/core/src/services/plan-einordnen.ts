/**
 * Tasks per Jev dem passenden Plan zuordnen (plan action 'einordnen').
 *
 * Je Block von hoechstens 50 Tasks EIN Jev-Aufruf (OpenRouter /api/v1/systemone, wie
 * jev-empfehlung.ts): state = { project, tasks: [{ i, title, description }] }, je Task eine
 * Frage plan_<i> (type choice) mit den Zielplaenen als criteria { '<Kurz-ID>': '<Name>: <Beschreibung>' }.
 * Antwort answers['plan_<i>'] = { choice, confidence }.
 *
 * Standard ist nur ein VORSCHLAG. Mit verschieben:true werden nur Tasks verschoben, deren
 * Confidence das Tor erreicht UND deren Vorschlag nicht der aktuelle Plan ist — gruppiert je
 * Zielplan ueber verschiebeTasks (Alias-Kurz-IDs bleiben). Eine choice, die kein Zielplan ist,
 * gilt als unsicher (nicht raten). Alles vor dem Verschieben ist read-only: scheitert ein
 * Jev-Aufruf, wird nichts verschoben.
 *
 * Der Key (JEV_OPENROUTER_API_KEY) wird nie ausgegeben oder geloggen.
 */

import { getPlan, getAllePlaene, verschiebeTasks, type PlanRef } from './plans.js';
import { planNummer, taskNummer } from './plan-kurz-ids.js';
import { JEV_STANDARD_URL, JEV_STANDARD_MODELL } from './jev-empfehlung.js';

const STANDARD_TIMEOUT_MS = 10_000;
const STANDARD_CONFIDENCE_TOR = 0.5;
/** Hoechstzahl task_id je Aufruf */
export const EINORDNEN_MAX_TASKS = 200;
/** Tasks je Jev-Aufruf */
export const EINORDNEN_BLOCK = 50;

export interface EinordnenOptionen {
  /** PFLICHT: Quellplan (UUID oder Kurz-ID P<n>) */
  plan_id?: string;
  /** PFLICHT: Tasks des Quellplans (UUID oder Kurz-ID, auch Alias), hoechstens 200 */
  task_ids?: string[];
  /** Kandidaten-Plaene (UUID oder Kurz-ID). Standard: alle Plaene des Projekts inkl. Quellplan. */
  ziele?: string[];
  /** Standard false = nur Vorschlag */
  verschieben?: boolean;
  /** Standard JEV_CONFIDENCE_TOR bzw. 0.5 */
  confidence_tor?: number;
}

interface PlanKurz {
  id: string;
  kurz_id?: string | null;
  name: string;
  description?: string;
  /** Aktiver Plan des Projekts (getPlan/getAllePlaene liefern das Feld) */
  aktiv?: boolean;
  tasks: Array<Record<string, unknown>>;
}

export interface EinordnenDeps {
  fetch?: typeof fetch;
  getPlan?: (project: string, planRef?: string | null) => Promise<PlanKurz | null>;
  getAllePlaene?: (project: string) => Promise<PlanKurz[]>;
  verschiebeTasks?: (
    project: string,
    taskRefs: string[],
    zielRef: string,
  ) => Promise<{
    success: boolean;
    message?: string;
    verschoben: Array<{ id: string; neu_kurz_id: string | null }>;
    uebersprungen?: Array<{ task_id: string; grund: string }>;
  }>;
}

export interface EinordnenZeile {
  task_id: string;
  kurz_id: string | null;
  titel: string;
  aktueller_plan: string | null;
  vorschlag: string | null;
  vorschlag_name: string | null;
  confidence: number;
  unsicher: boolean;
  verschoben?: boolean;
  neu_kurz_id?: string | null;
  hinweis?: string;
}

export interface EinordnenErgebnis {
  success: boolean;
  message: string;
  plan_ref?: PlanRef;
  confidence_tor?: number;
  verschieben?: boolean;
  ergebnisse?: EinordnenZeile[];
  zusammenfassung?: {
    je_plan: Record<string, number>;
    unsicher: number;
    bleibt: number;
    verschoben: number;
    aufrufe: number;
    dauer_ms: number;
    input_tokens: number | null;
    cost: number | null;
  };
  hinweise?: string[];
}

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

function ohneKey(text: string, key: string): string {
  return key ? text.split(key).join('***') : text;
}

/** Task des Quellplans zu UUID oder Kurz-ID (auch alte Alias-Kurz-IDs) */
function findeTask(plan: PlanKurz, ref: string): Record<string, unknown> | string {
  const r = ref.trim();
  if (taskNummer(r)) {
    const gross = r.toUpperCase();
    const t = plan.tasks.find((x) => {
      const k = typeof x.kurz_id === 'string' ? x.kurz_id.toUpperCase() : '';
      const alias = Array.isArray(x.alias_kurz_ids) ? (x.alias_kurz_ids as unknown[]).map((a) => String(a).toUpperCase()) : [];
      return k === gross || alias.includes(gross);
    });
    return t ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id}`;
  }
  return plan.tasks.find((x) => x.id === r) ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
}

function findeZielPlan(alle: PlanKurz[], ref: string): PlanKurz | undefined {
  const r = ref.trim();
  const nr = planNummer(r);
  return nr !== null && nr !== undefined
    ? alle.find((p) => planNummer(p.kurz_id) === nr)
    : alle.find((p) => p.id === r);
}

export async function ordneTasksEin(
  project: string,
  optionen: EinordnenOptionen = {},
  deps: EinordnenDeps = {},
): Promise<EinordnenErgebnis> {
  const fehlschlag = (message: string): EinordnenErgebnis => ({ success: false, message });

  const key = process.env.JEV_OPENROUTER_API_KEY?.trim() ?? '';
  if (!key) {
    return fehlschlag(
      'Jev nicht konfiguriert: JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses (REST-API bzw. MCP-Server). ' +
      'Ohne Key gibt es keinen Vorschlag; nichts wurde verschoben.',
    );
  }
  const url = process.env.JEV_API_URL?.trim() || JEV_STANDARD_URL;
  const modell = process.env.JEV_MODELL?.trim() || JEV_STANDARD_MODELL;
  const timeoutMs = zahlAusEnv('JEV_TIMEOUT_MS') ?? STANDARD_TIMEOUT_MS;
  const torRoh = typeof optionen.confidence_tor === 'number' ? optionen.confidence_tor : zahlAusEnv('JEV_CONFIDENCE_TOR');
  const tor = torRoh !== undefined && torRoh >= 0 && torRoh <= 1 ? torRoh : STANDARD_CONFIDENCE_TOR;
  const verschieben = optionen.verschieben === true;
  const hinweise: string[] = [];

  const taskIds = (optionen.task_ids ?? []).filter((id) => typeof id === 'string' && id.trim() !== '');
  if (taskIds.length === 0) {
    return fehlschlag('task_id ist Pflicht: die einzuordnenden Task-IDs ausdruecklich angeben (String oder Array).');
  }
  if (taskIds.length > EINORDNEN_MAX_TASKS) {
    return fehlschlag(`hoechstens ${EINORDNEN_MAX_TASKS} task_id je Aufruf (angegeben: ${taskIds.length}). Bitte aufteilen.`);
  }
  const planRef = typeof optionen.plan_id === 'string' ? optionen.plan_id.trim() : '';
  if (!planRef) {
    return fehlschlag('plan_id ist Pflicht: den Quellplan ausdruecklich angeben (UUID oder Kurz-ID P<n>, siehe plan(list)).');
  }

  try {
    const lesePlan = deps.getPlan ?? (getPlan as unknown as NonNullable<EinordnenDeps['getPlan']>);
    const leseAlle = deps.getAllePlaene ?? (getAllePlaene as unknown as NonNullable<EinordnenDeps['getAllePlaene']>);
    const quelle = await lesePlan(project, planRef);
    if (!quelle) return fehlschlag(`Kein Plan gefunden fuer Projekt: ${project}`);
    const alle = await leseAlle(project);
    const aktivDerQuelle = quelle.aktiv ?? alle.find((p) => p.id === quelle.id)?.aktiv ?? false;

    // --- Zielplaene ---------------------------------------------------------
    let ziele: PlanKurz[];
    if (optionen.ziele && optionen.ziele.length > 0) {
      ziele = [];
      const unbekannt: string[] = [];
      for (const ref of optionen.ziele) {
        const p = findeZielPlan(alle, String(ref));
        if (!p) unbekannt.push(String(ref));
        else if (!ziele.some((z) => z.id === p.id)) ziele.push(p);
      }
      if (unbekannt.length > 0) {
        return fehlschlag(`Unbekannte ziele: ${unbekannt.join(', ')}. Vorhanden: ${alle.map((p) => p.kurz_id ?? p.id).join(', ')}.`);
      }
    } else {
      ziele = [...alle];
    }
    const ohneKurz = ziele.filter((p) => !p.kurz_id);
    if (ohneKurz.length > 0) {
      hinweise.push(`Plaene ohne Kurz-ID ausgelassen: ${ohneKurz.map((p) => p.name).join(', ')}.`);
      ziele = ziele.filter((p) => p.kurz_id);
    }
    if (ziele.length === 0) return fehlschlag('Keine Zielplaene (mit Kurz-ID) vorhanden.');
    const kriterien: Record<string, string> = Object.fromEntries(
      ziele.map((p) => [p.kurz_id as string, `${kurz(p.name, 200)}: ${kurz(p.description, 400)}`]),
    );
    const kurzZuPlan = new Map(ziele.map((p) => [p.kurz_id as string, p]));
    const aktuellKurz = quelle.kurz_id ?? null;

    // --- Tasks --------------------------------------------------------------
    const aufgeloest = taskIds.map((ref) => findeTask(quelle, ref));
    const fehler = aufgeloest.filter((x): x is string => typeof x === 'string');
    if (fehler.length > 0) return fehlschlag(fehler.join('; '));
    const tasks = aufgeloest as Array<Record<string, unknown>>;

    // --- Jev, Blocks a 50 ---------------------------------------------------
    const f = deps.fetch ?? fetch;
    const zeilen: EinordnenZeile[] = [];
    let dauerMs = 0;
    let aufrufe = 0;
    let inputTokens: number | null = null;
    let cost: number | null = null;

    for (let start = 0; start < tasks.length; start += EINORDNEN_BLOCK) {
      const block = tasks.slice(start, start + EINORDNEN_BLOCK);
      const state = {
        project,
        tasks: block.map((t, i) => ({ i, title: kurz(t.title, 160), description: kurz(t.description, 400) })),
      };
      const questions: Record<string, unknown> = {};
      block.forEach((_, i) => {
        questions[`plan_${i}`] = {
          type: 'choice',
          instructions:
            `Choose the plan that task ${i} in the state belongs to. ` +
            'Judge by what the task changes or checks, not by single words.',
          criteria: kriterien,
        };
      });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const t0 = Date.now();
      let antwort: Response;
      try {
        antwort = await f(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: modell, state, questions }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) return fehlschlag(`Jev-Timeout nach ${timeoutMs} ms, nichts verschoben.`);
        return fehlschlag(ohneKey(`Jev nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`, key));
      } finally {
        clearTimeout(timer);
      }
      if (!antwort.ok) {
        const text = await antwort.text().catch(() => '');
        return fehlschlag(ohneKey(`Jev-Fehler HTTP ${antwort.status}: ${kurz(text, 300)}`, key));
      }
      const daten = (await antwort.json()) as {
        answers?: Record<string, { choice?: unknown; confidence?: unknown }>;
        usage?: { input_tokens?: number; cost?: number };
      };
      dauerMs += Date.now() - t0;
      aufrufe++;
      if (typeof daten.usage?.input_tokens === 'number') inputTokens = (inputTokens ?? 0) + daten.usage.input_tokens;
      if (typeof daten.usage?.cost === 'number') cost = (cost ?? 0) + daten.usage.cost;
      const answers = daten.answers ?? {};

      block.forEach((t, i) => {
        const a = answers[`plan_${i}`];
        const gewaehlt = typeof a?.choice === 'string' ? a.choice : null;
        const confidence = typeof a?.confidence === 'number' ? a.confidence : 0;
        const zeile: EinordnenZeile = {
          task_id: String(t.id),
          kurz_id: typeof t.kurz_id === 'string' ? t.kurz_id : null,
          titel: String(t.title ?? ''),
          aktueller_plan: aktuellKurz,
          vorschlag: null,
          vorschlag_name: null,
          confidence,
          unsicher: true,
        };
        if (gewaehlt && kurzZuPlan.has(gewaehlt)) {
          zeile.vorschlag = gewaehlt;
          zeile.vorschlag_name = kurzZuPlan.get(gewaehlt)!.name;
          zeile.unsicher = confidence < tor;
        } else {
          zeile.hinweis = 'Jev lieferte keinen gueltigen Zielplan.';
        }
        zeilen.push(zeile);
      });
    }

    // --- Verschieben (nur sichere, nur echte Wechsel) -------------------------
    let verschoben = 0;
    if (verschieben) {
      const jeZiel = new Map<string, EinordnenZeile[]>();
      for (const z of zeilen) {
        if (z.unsicher || !z.vorschlag || z.vorschlag === aktuellKurz) continue;
        jeZiel.set(z.vorschlag, [...(jeZiel.get(z.vorschlag) ?? []), z]);
      }
      const schiebe = deps.verschiebeTasks ?? (verschiebeTasks as unknown as NonNullable<EinordnenDeps['verschiebeTasks']>);
      for (const [ziel, gruppe] of jeZiel) {
        const r = await schiebe(project, gruppe.map((z) => z.task_id), ziel);
        if (!r.success) {
          hinweise.push(`Verschieben nach ${ziel} fehlgeschlagen: ${r.message ?? 'unbekannter Fehler'}`);
          continue;
        }
        const neu = new Map(r.verschoben.map((v) => [v.id, v.neu_kurz_id]));
        for (const z of gruppe) {
          if (neu.has(z.task_id)) {
            z.verschoben = true;
            z.neu_kurz_id = neu.get(z.task_id) ?? null;
            verschoben++;
          }
        }
      }
    }

    const jePlan: Record<string, number> = {};
    for (const z of zeilen) {
      if (z.vorschlag) jePlan[z.vorschlag] = (jePlan[z.vorschlag] ?? 0) + 1;
    }
    const unsicher = zeilen.filter((z) => z.unsicher).length;
    const bleibt = zeilen.filter((z) => !z.unsicher && z.vorschlag === aktuellKurz).length;
    return {
      success: true,
      message:
        `${zeilen.length} Task(s) eingeordnet in ${aufrufe} Jev-Aufruf(en), ${unsicher} unsicher (Tor ${tor}), ${bleibt} bleiben. ` +
        (verschieben ? `${verschoben} verschoben.` : 'Nur Vorschlag (verschieben:true verschiebt die sicheren).'),
      plan_ref: { id: quelle.id, kurz_id: quelle.kurz_id ?? null, name: quelle.name, aktiv: aktivDerQuelle },
      confidence_tor: tor,
      verschieben,
      ergebnisse: zeilen,
      zusammenfassung: { je_plan: jePlan, unsicher, bleibt, verschoben, aufrufe, dauer_ms: dauerMs, input_tokens: inputTokens, cost },
      ...(hinweise.length > 0 ? { hinweise } : {}),
    };
  } catch (err) {
    return fehlschlag(ohneKey(`Einordnen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, key));
  }
}
