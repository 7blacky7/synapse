/**
 * P7-T53: Beteiligung liegt im Task-JSON; Aktivitaet wird nur beim Lesen ergaenzt.
 * Kein Import aus plans.ts: derselbe Helfer bedient Lese- und atomare Schreibwege.
 */
import { getPool } from '../db/client.js';
import type { ProjectTask } from '../types/index.js';

export interface TaskBeteiligter { agent_id: string; seit: string; identity_id?: string; art?: 'identity' | 'legacy' }
export function beteiligterSchluessel(x: TaskBeteiligter): string {
  return x.identity_id ? 'identity:' + x.identity_id : 'legacy:' + x.agent_id;
}
export interface SichtbarerBeteiligter extends TaskBeteiligter { status: 'aktiv' | 'inaktiv' }

/** Eine explizite Liste (auch []) gewinnt vor den Legacy-Feldern. */
export function taskBeteiligte(task: ProjectTask): TaskBeteiligter[] {
  const roh = Array.isArray(task.beteiligte) ? task.beteiligte
    : typeof task.zugewiesen_an === 'string' && task.zugewiesen_an
      ? [{ agent_id: task.zugewiesen_an, seit: task.zugewiesen_am ?? task.updatedAt ?? task.createdAt }]
      : [];
  const gesehen = new Set<string>();
  return (roh as TaskBeteiligter[]).flatMap((x) => {
    if (!x || typeof x.agent_id !== 'string' || !x.agent_id.trim() || gesehen.has(beteiligterSchluessel({ ...x, agent_id: x.agent_id.trim() }))) return [];
    const agent_id = x.agent_id.trim();
    gesehen.add(beteiligterSchluessel({ ...x, agent_id }));
    return [{ agent_id, seit: typeof x.seit === 'string' ? x.seit : task.updatedAt,
      ...(x.identity_id ? { identity_id: x.identity_id, art: 'identity' as const } : {}) }];
  });
}

/** Legacy-Felder spiegeln den ersten Beteiligten; Status wird nie persistiert. */
export function mitTaskBeteiligten(task: ProjectTask, beteiligte: TaskBeteiligter[]): ProjectTask {
  const legacy = beteiligte.find(x => !x.identity_id);
  return { ...task, beteiligte: beteiligte.map(x => ({ ...x })),
    zugewiesen_an: legacy?.agent_id ?? null, zugewiesen_am: legacy?.seit ?? null };
}

/** Eine projektgebundene Abfrage fuer alle Beteiligten der uebergebenen Tasks. */
export async function sichtbareTaskBeteiligte(project: string, tasks: ProjectTask[]): Promise<ProjectTask[]> {
  const identities = [...new Set(tasks.flatMap(t => taskBeteiligte(t).flatMap(x => x.identity_id ? [x.identity_id] : [])))];
  const idAktiv = new Set<string>();
  if (identities.length) {
    const r = await getPool().query<{ identity_id: string }>(
      "SELECT identity_id FROM agent_identitaet_sitzungen WHERE project=$1 AND identity_id=ANY($2::text[]) AND status='active'",
      [project, identities]);
    for (const x of r.rows) idAktiv.add(x.identity_id);
  }
  const ids = [...new Set(tasks.flatMap(t => taskBeteiligte(t).filter(x => !x.identity_id).map(x => x.agent_id)))];
  if (!ids.length && !identities.length) return tasks.map(t => ({ ...t, beteiligte: [] }));
  const { rows } = await getPool().query<{ agent_id: string; aktiv: boolean }>(
    `SELECT x.agent_id,
       CASE WHEN w.agent_name IS NOT NULL THEN w.status IN ('running','idle')
         AND w.last_activity > NOW() - INTERVAL '4 hours'
       ELSE COALESCE(s.status = 'active', false) END AS aktiv
     FROM unnest($2::text[]) AS x(agent_id)
     LEFT JOIN agent_sessions s ON s.id = x.agent_id AND s.project = $1
     LEFT JOIN wrapper_status w ON w.agent_name = x.agent_id AND w.project = $1`,
    [project, ids],
  );
  const aktiv = new Set(rows.filter(r => r.aktiv).map(r => r.agent_id));
  return tasks.map(t => ({ ...t, beteiligte: taskBeteiligte(t).map(x => ({
    ...x, status: (x.identity_id ? idAktiv.has(x.identity_id) : aktiv.has(x.agent_id)) ? 'aktiv' : 'inaktiv',
  })) }));
}

export function beteiligungsHinweise(project: string, task: ProjectTask): string[] {
  const beteiligte = task.beteiligte as SichtbarerBeteiligter[] | undefined;
  if (!beteiligte?.length) return [];
  return [
    'Bereits beteiligt: ' + beteiligte.map(x => x.agent_id + ' seit ' + x.seit + ' (' + x.status + ')').join(', ') + '.',
    "Gesamten Schatten pruefen (Platzhalter ersetzen): code_intel({action:'file',project:'" + project + "',agent_id:'<eigene ID>',file_path:'<datei>',schatten:'alle'}); " +
      "code_intel({action:'functions',project:'" + project + "',agent_id:'<eigene ID>',file_path:'<datei>',schatten:'<plan_id>'}); " +
      "code_intel({action:'search',project:'" + project + "',agent_id:'<eigene ID>',query:'<begriff>',schatten:'alle'}); " +
      "code_intel({action:'tree',project:'" + project + "',agent_id:'<eigene ID>',show_ghosts:true}).",
    "Einzelne Aenderungen: files({action:'history',project:'" + project + "',agent_id:'<eigene ID>',task_id:'" + (task.kurz_id ?? task.id) + "'}); " +
      "thought({action:'search',project:'" + project + "',agent_id:'<eigene ID>',query:'" + (task.kurz_id ?? task.id) + "',task_id:'" + (task.kurz_id ?? task.id) + "'}); " +
      "files({action:'plan_status',project:'" + project + "',agent_id:'<eigene ID>',plan_id:'<plan_id>',op_indices:[0]}) zeigt Inhalt und Diff je Op.",
    "Bei Bedenken/Ergaenzungen additiv per files(plan_update/coedit_add) mit anchor_text und task_id beitragen; gemeinsame Dateien per Co-Edit bearbeiten, nie fremde Ops ueberschreiben.",
    ...(beteiligte.length >= 3 ? ['Ab 3 Beteiligten koennen Datei-Ueberlappungen zunehmen; gemeinsame Ops und Schatten vor dem Schreiben ansehen. Keine Hoechstzahl.'] : []),
  ];
}
