/**
 * P8-T30: lesende Plan-Routen fuer das Projektdetail der Web-UI (Tasks / Plan).
 * Quelle sind dieselben Core-Dienste wie beim plan-Tool (list/get/search); geschrieben wird hier nichts.
 *   GET /api/projects/:name/plaene[?alle=true]     -> plan(list)
 *   GET /api/projects/:name/plaene/:ref            -> plan(get, plan_id) mit allen Tasks (ohne Beschreibung)
 *   GET /api/projects/:name/plan-tasks/:ref        -> eine Task mit Volltext und Verknuepfungen
 *   GET /api/projects/:name/plan-suche?query=...   -> plan(search, art:tasks)
 */

import type { FastifyInstance } from 'fastify';
import {
  listPlansDetail,
  getPlan,
  getAllePlaene,
  findeTaskInPlan,
  filtereWiedervorlageTasks,
  planRefVon,
  searchTasks,
  taskVerknuepfungen,
} from '@synapse/core';
import type { ProjectTask } from '@synapse/core';

const TASK_STATUS = ['todo', 'in_progress', 'done', 'blocked'];

function fehler(message: string) {
  return { success: false, error: { message } };
}

/** Kompakte Task-Zeile fuer die Planansicht: ohne Beschreibung, mit Laenge, damit die Liste klein bleibt. */
export function taskZeile(task: ProjectTask) {
  const roh = task as Record<string, unknown>;
  return {
    id: task.id,
    kurz_id: task.kurz_id ?? null,
    title: task.title,
    status: task.status,
    priority: task.priority,
    git_branch: task.git_branch ?? null,
    beteiligte: Array.isArray(roh.beteiligte) ? roh.beteiligte : [],
    empfehlung: roh.empfehlung ?? null,
    zurueckgestellt: roh.zurueckgestellt === true,
    zurueckgestellt_bis: typeof roh.zurueckgestellt_bis === 'string' ? roh.zurueckgestellt_bis : null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    beschreibung_laenge: (task.description ?? '').length,
  };
}

export async function projektPlanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { name: string }; Querystring: { alle?: string } }>('/api/projects/:name/plaene', async (request, reply) => {
    try {
      const { plaene, ausgeblendet } = await listPlansDetail(request.params.name, { alle: request.query.alle === 'true' });
      return { success: true, plaene, ausgeblendet };
    } catch (error) {
      return reply.status(500).send(fehler(String(error instanceof Error ? error.message : error)));
    }
  });

  fastify.get<{ Params: { name: string; ref: string } }>('/api/projects/:name/plaene/:ref', async (request, reply) => {
    const { name, ref } = request.params;
    try {
      const plan = await getPlan(name, ref);
      if (!plan) return reply.status(404).send(fehler(`Kein Plan gefunden fuer: ${name}`));
      const { tasks } = filtereWiedervorlageTasks(plan.tasks, { alle: true });
      return {
        success: true,
        plan: {
          ...planRefVon(plan),
          id: plan.id,
          kurz_id: plan.kurz_id ?? null,
          name: plan.name,
          description: plan.description,
          goals: plan.goals ?? [],
          architecture: plan.architecture ?? null,
          aktiv: plan.aktiv === true,
          prioritaet: plan.prioritaet ?? 'mittel',
          zurueckgestellt_bis: plan.zurueckgestellt_bis ?? null,
          git_branch: plan.git_branch ?? null,
          tasks: tasks.map(taskZeile),
        },
      };
    } catch (error) {
      return reply.status(404).send(fehler(String(error instanceof Error ? error.message : error)));
    }
  });

  fastify.get<{ Params: { name: string; ref: string } }>('/api/projects/:name/plan-tasks/:ref', async (request, reply) => {
    const { name, ref } = request.params;
    try {
      const plaene = await getAllePlaene(name);
      for (const plan of plaene) {
        const fund = findeTaskInPlan(plan, ref);
        if (typeof fund === 'string') continue;
        const [task] = filtereWiedervorlageTasks([fund], { alle: true }).tasks;
        return {
          success: true,
          plan: planRefVon(plan),
          task: { ...taskZeile(task), description: task.description ?? '' },
          verknuepfungen: await taskVerknuepfungen(name, fund.id),
        };
      }
      return reply.status(404).send(fehler(`Task ${ref} nicht gefunden in Projekt ${name}`));
    } catch (error) {
      return reply.status(500).send(fehler(String(error instanceof Error ? error.message : error)));
    }
  });

  fastify.get<{ Params: { name: string }; Querystring: { query?: string; status?: string; plan_id?: string; alle?: string; limit?: string } }>('/api/projects/:name/plan-suche', async (request, reply) => {
    const { query, status, plan_id, alle, limit } = request.query;
    if (!query || !query.trim()) return reply.status(400).send(fehler('query ist erforderlich'));
    if (status && !TASK_STATUS.includes(status)) return reply.status(400).send(fehler('Ungueltiger status'));
    try {
      const ergebnis = await searchTasks(query, request.params.name, {
        status: status || undefined,
        plan_id: plan_id || undefined,
        alle: alle === 'true',
        limit: limit ? Math.min(Math.max(Number(limit) || 20, 1), 100) : 30,
      });
      return ergebnis;
    } catch (error) {
      return reply.status(500).send(fehler(String(error instanceof Error ? error.message : error)));
    }
  });
}
