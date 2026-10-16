/** P7-T53: Alle Agenten koennen Tasks gemeinsam bearbeiten. Profile sind nur Empfehlungen. */
import { getPool } from '../db/client.js';
import { taskBeteiligte, mitTaskBeteiligten, sichtbareTaskBeteiligte, beteiligungsHinweise } from './plan-beteiligung.js';
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
  quelle?: 'wrapper_status' | 'agent_sessions';
  profil_unvollstaendig?: boolean;
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

/** Wrapper-Profil, sonst bekannte Session-Daten; fehlende Daten sind kein Zugangstor. */
export async function ladeAgentProfil(project: string, agentId: string): Promise<AgentProfil | string> {
  if (!agentId?.trim()) return 'agent_id ist Pflicht: die eigene Agent-ID.';
  const name = agentId.trim();
  const zeile = await getWrapperStatus(name, project);
  const session = zeile?.model ? null : (await getPool().query<{ model: string | null }>(
    'SELECT model FROM agent_sessions WHERE id = $1 AND project = $2', [name, project],
  )).rows[0];
  const model = zeile?.model ?? session?.model;
  if (!model) return 'Profil unbekannt';
  const eintrag = await getModel(model).catch(() => null);
  return {
    name, project, model, familie: ohne1M(eintrag?.alias ?? model),
    effort: zeile?.effort ?? null,
    kontext: model.endsWith('[1m]') || model.startsWith('fable') || (eintrag?.contextWindow ?? 0) >= 1_000_000 ? '1m' : '200k',
    effort_stufen: eintrag?.effortStufen ?? [],
    quelle: zeile?.model ? 'wrapper_status' : 'agent_sessions',
    profil_unvollstaendig: !zeile?.model,
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

/** Fachlicher Task-Status bleibt wirksam; Profil und Beteiligung sperren nie. */
function hinderungsgrund(t: ProjectTask): string | null {
  if (t.status === 'done') return `Task ${t.kurz_id ?? t.id} ist erledigt (done).`;
  if (t.status === 'blocked') return `Task ${t.kurz_id ?? t.id} ist blockiert.`;
  if (taskSchlaeft(t)) return `Task ${t.kurz_id ?? t.id} ist zurueckgestellt bis ${taskBis(t)?.toISOString()} (Wiedervorlage).`;
  return null;
}

const kurzEmpfehlung = (e: EmpfehlungMin) => ({
  modell: e.spawn_alias ?? e.modell ?? null,
  effort: e.effort ?? null,
  kontext: e.kontext ?? null,
});

/** Alle offenen/laufenden Tasks bleiben sichtbar, mit unverbindlicher Profilbewertung. */
export async function passendeTasks(project: string, agentId: string, planRef?: string | null, jetzt: Date = new Date()): Promise<Record<string, unknown>> {
  if (!agentId?.trim()) return { success: false, message: 'agent_id ist Pflicht.' };
  try {
    const profil = await ladeAgentProfil(project, agentId);
    const plaene: ProjectPlan[] = planRef
      ? [await getPlan(project, planRef)].filter((p): p is ProjectPlan => !!p)
      : await getAllePlaene(project);
    const tasks: Array<Record<string, unknown>> = [];
    const passend: Array<Record<string, unknown>> = [];
    const offenFuerKoordinator: Array<Record<string, unknown>> = [];
    let nichtPassend = 0, zurueckgestellt = 0;
    for (const plan of plaene) {
      for (const t of plan.tasks) {
        if (t.status !== 'todo' && t.status !== 'in_progress') continue;
        if (taskSchlaeft(t, jetzt)) { zurueckgestellt++; continue; }
        const e = t.empfehlung as EmpfehlungMin | undefined;
        const grund = !e ? 'keine Empfehlung' : e.unsicher ? 'unsicher'
          : typeof profil === 'string' ? profil
          : profil.profil_unvollstaendig ? 'Profil teilweise bekannt: Modell ' + profil.model + ', Effort/Kontext nicht vollstaendig bekannt'
          : null;
        const bewertung = grund ? { passt: null, grund } : passtZuProfil(profil as AgentProfil, e!);
        const zeile = {
          plan_id: plan.id, plan_kurz_id: plan.kurz_id ?? null, plan_name: plan.name,
          task_id: t.id, kurz_id: t.kurz_id ?? null, titel: t.title, status: t.status,
          beteiligte: t.beteiligte, zugewiesen_an: t.zugewiesen_an ?? null,
          profil_hinweis: { ...bewertung, hinweis: bewertung.passt === true ? 'passt' : bewertung.passt === false ? 'passt nicht: ' + bewertung.grund : grund },
          hinweise: beteiligungsHinweise(project, t), ...(e ? { empfehlung: kurzEmpfehlung(e) } : {}),
          ...(grund ? { grund } : {}),
        };
        tasks.push(zeile);
        if (bewertung.passt === true) passend.push(zeile);
        else if (bewertung.passt === null) offenFuerKoordinator.push(zeile);
        else nichtPassend++;
      }
    }
    return {
      success: true, profil, tasks, passend, offen_fuer_koordinator: offenFuerKoordinator,
      nicht_passend: nichtPassend,
      ...(zurueckgestellt > 0 ? { zurueckgestellt_ausgeblendet: zurueckgestellt } : {}),
      message: `${tasks.length} offene/laufende Task(s). Jeder Agent darf sich per plan(uebernehmen) anmelden; Profilhinweise sind Empfehlungen.`,
    };
  } catch (err) { return { success: false, message: err instanceof Error ? err.message : String(err) }; }
}

/** Gemeinsamer atomarer Schreibweg: neu lesen und bedingt aktualisieren, nie fremde Beteiligte verlieren. */
async function aendereBeteiligung(project: string, planRef: string | null | undefined, taskRef: string, agentId: string, anmelden: boolean): Promise<Record<string, unknown>> {
  if (!agentId?.trim()) return { success: false, message: 'agent_id ist Pflicht.' };
  if (!taskRef?.trim()) return { success: false, message: 'task_id ist Pflicht (UUID oder P<n>-T<m>).' };
  try {
    const plan = planRef ? await getPlan(project, planRef)
      : (await getAllePlaene(project)).find(p => typeof findeTaskInPlan(p, taskRef.trim()) !== 'string') ?? null;
    if (!plan) return { success: false, message: `Kein Plan gefunden fuer Projekt: ${project}` };
    const gefunden = findeTaskInPlan(plan, taskRef.trim());
    if (typeof gefunden === 'string') return { success: false, message: gefunden };
    const id = agentId.trim();
    const r = await aendereTasks(project, plan.id, tasks => {
      const i = tasks.findIndex(t => t.id === gefunden.id);
      if (i < 0) throw new Error('Task ist waehrenddessen verschwunden.');
      const task = tasks[i], vorher = taskBeteiligte(task);
      const dabei = vorher.some(x => x.agent_id === id);
      if ((anmelden && dabei) || (!anmelden && !dabei)) return { tasks, ergebnis: { bereits: dabei } };
      if (anmelden) { const grund = hinderungsgrund(task); if (grund) throw new Error(grund); }
      const jetzt = new Date().toISOString();
      const beteiligte = anmelden ? [...vorher, { agent_id: id, seit: jetzt }] : vorher.filter(x => x.agent_id !== id);
      const neu = [...tasks];
      neu[i] = { ...mitTaskBeteiligten(task, beteiligte),
        status: anmelden ? task.status === 'todo' ? 'in_progress' : task.status
          : beteiligte.length === 0 && task.status !== 'done' ? 'todo' : task.status,
        updatedAt: jetzt };
      return { tasks: neu, ergebnis: { bereits: dabei } };
    });
    if (!r) return { success: false, message: 'Plan ist waehrenddessen verschwunden.' };
    const [task] = await sichtbareTaskBeteiligte(project, [r.plan.tasks.find(t => t.id === gefunden.id)!]);
    return { success: true, task, ...planKontext(r.plan), hinweise: beteiligungsHinweise(project, task),
      bereits_angemeldet: anmelden && r.ergebnis.bereits,
      message: anmelden ? `Agent ${id} ist an Task ${task.kurz_id ?? task.id} beteiligt.` : `Agent ${id} ist von Task ${task.kurz_id ?? task.id} abgemeldet.`,
      ...(r.warning ? { warning: r.warning } : {}) };
  } catch (err) { return { success: false, message: err instanceof Error ? err.message : String(err) }; }
}

export async function uebernehmeTask(project: string, planRef: string, taskRef: string, agentId: string): Promise<Record<string, unknown>> {
  if (!planRef?.trim()) return { success: false, message: 'plan_id ist Pflicht (UUID oder P<n>).' };
  return aendereBeteiligung(project, planRef, taskRef, agentId, true);
}

export async function meldeTaskAb(project: string, planRef: string | null | undefined, taskRef: string, agentId: string): Promise<Record<string, unknown>> {
  return aendereBeteiligung(project, planRef, taskRef, agentId, false);
}
