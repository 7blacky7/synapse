/**
 * Selbstzuweisung von Tasks an Spezialisten (Aufgabe C, Channel 23094/23096).
 *
 * User-Vorgabe 29.09.2026: Jev BEWERTET nur (plan empfehlen). Die Spezialisten erkennen selbst,
 * welche Tasks zu ihnen passen, statt Tasks an andere weiterzureichen, die gar nicht empfohlen
 * wurden. Der Server setzt das durch:
 *   plan(passende_tasks, agent_id[, plan_id])      offene Tasks, deren Empfehlung zum Profil passt;
 *                                                   ohne/unsichere Empfehlung -> offen_fuer_koordinator
 *   plan(uebernehmen, plan_id, task_id, agent_id)  atomar: zugewiesen_an, zugewiesen_am, in_progress
 *
 * PASST-REGEL (Profil aus wrapper_status + model_registry, wie specialist(selbst)):
 *   - Modellfamilie gleich: spawn_alias der Empfehlung ohne [1m] == eigener Alias ohne [1m]
 *   - eigener Kontext >= empfohlenem (1M darf eine 200k-Task nehmen, umgekehrt nicht)
 *   - Effort gleich der empfohlenen Stufe oder GENAU eine Stufe hoeher (Reihenfolge der
 *     effort_stufen des eigenen Modells, sonst EFFORT_STUFEN)
 *   - Modelle ohne Effort (haiku) nur, wenn die Empfehlung ebenfalls keinen Effort hat
 * Offen = status 'todo' und noch nicht zugewiesen.
 *
 * ATOMAR ohne Sperre mit Client-Wartezeit (Regel regel-schema-60s-und-keine-sperre-mit-client-warten):
 * die Uebernahme prueft auf dem frisch gelesenen Stand und schreibt mit EINEM bedingten UPDATE
 * (tasks unveraendert, plans.ts aendereTasks). Hat ein anderer dazwischen uebernommen, scheitert
 * das UPDATE, der naechste Versuch liest neu und meldet "bereits zugewiesen".
 */

import { getWrapperStatus } from './wrapper-status.js';
import { getModel } from './model-registry.js';
import { EFFORT_STUFEN } from './effort.js';
import {
  getPlan, getAllePlaene, findeTaskInPlan, aendereTasks, planKontext, taskBis, taskSchlaeft,
} from './plans.js';
import type { ProjectPlan, ProjectTask } from '../types/index.js';

export interface AgentProfil {
  name: string;
  project: string;
  /** Alias wie in wrapper_status, z. B. 'opus[1m]' */
  model: string;
  /** Alias ohne [1m] */
  familie: string;
  /** gestartete Stufe (wrapper_status.effort), null = ohne Effort */
  effort: string | null;
  kontext: '200k' | '1m';
  /** Stufen des eigenen Modells (model_registry), Reihenfolge fuer "eine Stufe hoeher" */
  effort_stufen: string[];
}

interface EmpfehlungMin {
  modell?: unknown;
  spawn_alias?: unknown;
  effort?: unknown;
  kontext?: unknown;
  unsicher?: unknown;
}

const ohne1M = (alias: string): string => alias.replace(/\[1m\]$/, '');

/** Profil eines gestarteten Spezialisten — nur aus DB/Registry. Fehlertext statt Profil, wenn unbekannt. */
export async function ladeAgentProfil(project: string, agentId: string): Promise<AgentProfil | string> {
  if (!agentId?.trim()) return 'agent_id ist Pflicht: der eigene Spezialisten-Name.';
  const zeile = await getWrapperStatus(agentId.trim(), project);
  if (!zeile) {
    return `Kein gestarteter Spezialist "${agentId}" im Projekt ${project} (wrapper_status) — passende_tasks/uebernehmen gibt es nur fuer Spezialisten.`;
  }
  if (!zeile.model) return `wrapper_status nennt fuer "${agentId}" kein Modell.`;
  const eintrag = await getModel(zeile.model).catch(() => null);
  const einsM = zeile.model.endsWith('[1m]') || zeile.model.startsWith('fable') || (eintrag?.contextWindow ?? 0) >= 1_000_000;
  return {
    name: zeile.agentName,
    project,
    model: zeile.model,
    familie: ohne1M(zeile.model),
    effort: zeile.effort ?? null,
    kontext: einsM ? '1m' : '200k',
    effort_stufen: eintrag?.effortStufen ?? [],
  };
}

/** Passt die Empfehlung zum Profil? Bei nein mit Grund "empfohlen: X@s (k), du bist Y@t (k)". */
export function passtZuProfil(profil: Omit<AgentProfil, 'project'> & { project?: string }, e: EmpfehlungMin): { passt: boolean; grund?: string } {
  const eFamilie = ohne1M(String(e.spawn_alias ?? e.modell ?? ''));
  const eEffort = typeof e.effort === 'string' && e.effort ? e.effort : null;
  const eKontext = e.kontext === '1m' ? '1m' : '200k';
  const vergleich = `empfohlen: ${eFamilie}@${eEffort ?? 'ohne'} (${eKontext}), du bist ${profil.familie}@${profil.effort ?? 'ohne'} (${profil.kontext})`;
  if (eFamilie !== profil.familie) return { passt: false, grund: `Modellfamilie passt nicht — ${vergleich}` };
  if (eKontext === '1m' && profil.kontext !== '1m') return { passt: false, grund: `Kontext zu klein — ${vergleich}` };
  if (eEffort === null) {
    if (profil.effort !== null) return { passt: false, grund: `Empfehlung ohne Effort — ${vergleich}` };
    return { passt: true };
  }
  if (profil.effort === null) return { passt: false, grund: `Effort fehlt — ${vergleich}` };
  const reihe = profil.effort_stufen.length > 0 ? profil.effort_stufen : [...EFFORT_STUFEN];
  const iE = reihe.indexOf(eEffort);
  const iP = reihe.indexOf(profil.effort);
  if (iE < 0 || iP < 0 || (iP !== iE && iP !== iE + 1)) {
    return { passt: false, grund: `Effort passt nicht (gleich oder genau eine Stufe hoeher) — ${vergleich}` };
  }
  return { passt: true };
}

/** Grund, warum die Task nicht uebernommen werden kann — oder null. */
function hinderungsgrund(t: ProjectTask, profil: AgentProfil): string | null {
  if (typeof t.zugewiesen_an === 'string' && t.zugewiesen_an) return `Task ${t.kurz_id ?? t.id} ist bereits zugewiesen an ${t.zugewiesen_an}.`;
  if (t.status === 'done') return `Task ${t.kurz_id ?? t.id} ist erledigt (done).`;
  if (t.status !== 'todo') return `Task ${t.kurz_id ?? t.id} ist nicht offen (status ${t.status}).`;
  if (taskSchlaeft(t)) return `Task ${t.kurz_id ?? t.id} ist zurueckgestellt bis ${taskBis(t)?.toISOString()} (Wiedervorlage) — aufheben mit plan(zurueckstellen, task_id, tage:0).`;
  const e = t.empfehlung as EmpfehlungMin | undefined;
  if (!e || typeof e !== 'object') return `Task ${t.kurz_id ?? t.id} hat keine Empfehlung — sie gehoert dem Koordinator (plan empfehlen oder direkte Zuweisung).`;
  if (e.unsicher) return `Die Empfehlung fuer Task ${t.kurz_id ?? t.id} ist unsicher — sie gehoert dem Koordinator.`;
  const p = passtZuProfil(profil, e);
  return p.passt ? null : `Task ${t.kurz_id ?? t.id} passt nicht zu dir: ${p.grund}.`;
}

const kurzEmpfehlung = (e: EmpfehlungMin) => ({
  modell: e.spawn_alias ?? e.modell ?? null,
  effort: e.effort ?? null,
  kontext: e.kontext ?? null,
});

/** Offene Tasks, deren Empfehlung zum Profil passt; ohne plan_id ueber alle Plaene. */
export async function passendeTasks(project: string, agentId: string, planRef?: string | null, jetzt: Date = new Date()): Promise<Record<string, unknown>> {
  try {
    const profil = await ladeAgentProfil(project, agentId);
    if (typeof profil === 'string') return { success: false, message: profil };
    const plaene: ProjectPlan[] = planRef
      ? [await getPlan(project, planRef)].filter((p): p is ProjectPlan => !!p)
      : await getAllePlaene(project);
    const passend: Array<Record<string, unknown>> = [];
    const offenFuerKoordinator: Array<Record<string, unknown>> = [];
    let nichtPassend = 0;
    let zurueckgestellt = 0;
    for (const plan of plaene) {
      const kopf = { plan_id: plan.id, plan_kurz_id: plan.kurz_id ?? null, plan_name: plan.name };
      for (const t of plan.tasks) {
        if (t.status !== 'todo' || (typeof t.zugewiesen_an === 'string' && t.zugewiesen_an)) continue;
        if (taskSchlaeft(t, jetzt)) { zurueckgestellt++; continue; }
        const zeile = { ...kopf, task_id: t.id, kurz_id: t.kurz_id ?? null, titel: t.title };
        const e = t.empfehlung as EmpfehlungMin | undefined;
        if (!e || typeof e !== 'object') {
          offenFuerKoordinator.push({ ...zeile, grund: 'keine Empfehlung' });
        } else if (e.unsicher) {
          offenFuerKoordinator.push({ ...zeile, grund: 'unsicher' });
        } else if (passtZuProfil(profil, e).passt) {
          passend.push({ ...zeile, empfehlung: kurzEmpfehlung(e) });
        } else {
          nichtPassend++;
        }
      }
    }
    return {
      success: true,
      profil,
      passend,
      offen_fuer_koordinator: offenFuerKoordinator,
      nicht_passend: nichtPassend,
      ...(zurueckgestellt > 0 ? { zurueckgestellt_ausgeblendet: zurueckgestellt } : {}),
      message: passend.length > 0
        ? `${passend.length} passende Task(s). Uebernehmen mit plan(action:'uebernehmen', plan_id, task_id, agent_id).`
        : 'Nichts passt zu deinem Profil. Melde dich im Channel und warte — Tasks nicht an andere weitergeben.',
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Uebernimmt eine Task atomar, wenn sie offen, empfohlen und passend ist. */
export async function uebernehmeTask(project: string, planRef: string, taskRef: string, agentId: string): Promise<Record<string, unknown>> {
  if (!planRef?.trim()) return { success: false, message: 'plan_id ist Pflicht (UUID oder Kurz-ID P<n>, siehe plan(list) bzw. passende_tasks).' };
  if (!taskRef?.trim()) return { success: false, message: 'task_id ist Pflicht (UUID oder Kurz-ID P<n>-T<m>).' };
  try {
    const profil = await ladeAgentProfil(project, agentId);
    if (typeof profil === 'string') return { success: false, message: profil };
    const plan = await getPlan(project, planRef.trim());
    if (!plan) return { success: false, message: `Kein Plan gefunden fuer Projekt: ${project}` };
    const gefunden = findeTaskInPlan(plan, taskRef.trim());
    if (typeof gefunden === 'string') return { success: false, message: gefunden };
    const zielId = gefunden.id;
    const r = await aendereTasks(project, plan.id, (tasks) => {
      const i = tasks.findIndex((t) => t.id === zielId);
      if (i === -1) throw new Error(`Task ${taskRef} ist waehrenddessen verschwunden.`);
      const grund = hinderungsgrund(tasks[i], profil);
      if (grund) throw new Error(grund);
      const jetzt = new Date().toISOString();
      const neu = [...tasks];
      neu[i] = { ...tasks[i], zugewiesen_an: profil.name, zugewiesen_am: jetzt, status: 'in_progress', updatedAt: jetzt };
      return { tasks: neu, ergebnis: null };
    });
    if (!r) return { success: false, message: `Plan ${planRef} ist waehrenddessen verschwunden.` };
    const task = r.plan.tasks.find((t) => t.id === zielId)!;
    return {
      success: true,
      task,
      ...planKontext(r.plan),
      message: `Task ${task.kurz_id ?? task.id} "${task.title}" gehoert jetzt ${profil.name} (in_progress).`,
      ...(r.warning ? { warning: r.warning } : {}),
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
