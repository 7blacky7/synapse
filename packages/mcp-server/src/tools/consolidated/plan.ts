/**
 * Synapse MCP - Konsolidiertes Plan-Tool
 * Konsolidiert: get_project_plan, update_project_plan, add_plan_task
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, strArray, objArray } from './types.js';
import {
  getProjectPlan,
  updateProjectPlan,
  addPlanTask,
  addPlanTasksBatch,
  updatePlanTask,
  deletePlanTasks,
  listProjectPlans,
  createProjectPlan,
  activateProjectPlan,
  zurueckstellenPlan,
} from '../plans.js';
import { empfehleFuerPlan, passendeTasks, uebernehmeTask, verschiebeTasks, zurueckstelleTask, filtereWiedervorlageTasks } from '@synapse/core';
import type { ProjectTask } from '@synapse/core';

export const planTool: ConsolidatedTool = {
  definition: {
    name: 'plan',
    description: 'Verwaltet Projekt-Plaene: Abrufen, Aktualisieren, Tasks hinzufuegen. Mehrere Plaene je Projekt: plan_id (UUID oder Kurz-ID P<n>) optional bei allen Aktionen, ohne plan_id wirkt der AKTIVE Plan; Tasks auch per Kurz-ID P<n>-T<m>; list/create/aktivieren. empfehlen (EXPERIMENTELL): Modell + Effort + Kontext je Task per Jev vorschlagen — nur Empfehlung, kein Muss.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'update', 'add_task', 'add_tasks_batch', 'update_task', 'delete_task', 'empfehlen', 'list', 'create', 'aktivieren', 'passende_tasks', 'uebernehmen', 'verschieben', 'zurueckstellen'],
          description:
            'Aktion: "verschieben" (task_id String oder Array + ziel = Plan-UUID oder Kurz-ID) verschiebt Tasks atomar in einen anderen Plan; UUID und Felder bleiben, im Zielplan gibt es eine neue Kurz-ID, die alte bleibt als Alias gueltig, "passende_tasks" (agent_id Pflicht, plan_id optional) offene Tasks, deren Empfehlung zu deinem Profil passt (Familie gleich, Kontext >= empfohlen, Effort gleich oder eine Stufe hoeher); ohne/unsichere Empfehlung -> offen_fuer_koordinator, "uebernehmen" (plan_id + task_id + agent_id Pflicht) nimmt eine passende Task atomar (zugewiesen_an, in_progress), "list" alle Plaene des Projekts (Kurz-ID, Name, Ziel, aktiv, offen/erledigt), "create" neuer Plan (name, description, goals, architecture, aktiv?), "aktivieren" plan_id zum aktiven Plan machen, "get" zum Abrufen, "update" zum Aktualisieren, "add_task" um eine Task hinzuzufuegen, "add_tasks_batch" um mehrere Tasks atomar hinzuzufuegen, "update_task" um eine Task zu aendern (status/priority/title/description), "delete_task" um eine oder mehrere Tasks zu loeschen (id als String oder Array), "empfehlen" (EXPERIMENTELL) bewertet die per plan_id + task_id (beide PFLICHT, UUID oder Kurz-ID) genannten Tasks in EINEM Jev-Aufruf und schreibt je Task das Feld empfehlung {modell, effort, kontext 200k|1m, confidence, ...} — nur Empfehlung, kein Muss; unter dem Confidence-Tor unsicher statt Empfehlung',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        agent_id: {
          type: 'string',
          description:
            'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
        },
        plan_id: {
          type: 'string',
          description: 'Optional bei allen Aktionen: Plan-UUID oder Kurz-ID "P<n>" (siehe list). Ohne plan_id wirkt der AKTIVE Plan des Projekts (bisheriges Verhalten). Pflicht fuer aktivieren.',
        },
        plan_prioritaet: {
          type: 'string',
          enum: ['hoch', 'mittel', 'niedrig'],
          description: 'Plan-Prioritaet fuer create/update (Standard mittel). plan(list) und das Onboarding sortieren: aktiver Plan zuerst, dann hoch > mittel > niedrig, dann zuletzt geaendert. Nicht zu verwechseln mit priority (Task). Bei update an einem inaktiven Plan ist NUR die Prioritaet aenderbar.',
        },
        aktiv: {
          type: 'boolean',
          description: 'Nur fuer create: neuen Plan gleich aktiv schalten (Standard false; der erste Plan eines Projekts ist immer aktiv).',
        },
        // fuer "update"
        name: {
          type: 'string',
          description: 'Neuer Plan-Name',
        },
        description: {
          type: 'string',
          description: 'Neue Beschreibung',
        },
        goals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Neue Ziele',
        },
        architecture: {
          type: 'string',
          description: 'Architektur-Beschreibung',
        },
        // fuer "add_task"
        title: {
          type: 'string',
          description: 'Task-Titel',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Prioritaet (Standard: medium)',
        },
        // fuer "update_task" / "delete_task"
        task_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
          ],
          description: 'Task-ID (String fuer update_task/delete_task, Array fuer Batch-delete_task; bei empfehlen: PFLICHT, genau diese Task(s), hoechstens 50 — ohne task_id gibt es einen Fehler)',
        },
        ziel: {
          type: 'string',
          description: 'Nur fuer verschieben: Zielplan (UUID oder Kurz-ID P<n>).',
        },
        tage: {
          type: 'number',
          description: 'Nur fuer zurueckstellen: Wiedervorlage in N Tagen (0 = Zurueckstellung aufheben). Entweder tage ODER bis. Mit task_id wird die TASK zurueckgestellt (blendet sie aus plan(get), passende_tasks aus; plan(get, alle:true) oder task_id zeigt sie), ohne task_id der Plan. Der AKTIVE Plan kann nicht zurueckgestellt werden. Der Plan verschwindet bis dahin aus plan(list) und dem Onboarding; plan(get) mit plan_id geht immer.',
        },
        bis: {
          type: 'string',
          description: 'Nur fuer zurueckstellen: Wiedervorlage-Datum (2026-10-15 oder ISO-Zeitpunkt, muss in der Zukunft liegen).',
        },
        alle: {
          type: 'boolean',
          description: 'Nur fuer list und get: true zeigt auch zurueckgestellte Plaene bzw. Tasks (mit Vermerk zurueckgestellt/zurueckgestellt_bis).',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done', 'blocked'],
          description: 'Neuer Task-Status (fuer update_task)',
        },
        // fuer "add_tasks_batch"
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['title', 'description'],
          },
          minItems: 1,
          maxItems: 50,
          description: 'Tasks fuer Batch-Add (1..50 Items mit title, description, optional priority)',
        },
        // fuer "empfehlen"
        kandidaten: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Nur fuer empfehlen: Modelle zur Auswahl — Aliase (opus, sonnet, haiku, fable, gpt-6-astra, ...) und/oder Gruppen (abos = Claude-CLI + Codex-CLI, alle, anthropic|claude-abo, codex|codex-abo, google|gemini-api, legacy). Standard: nur Claude-CLI-Modelle (anthropic); Codex/Gemini nachziehen, sobald deren Runtime steht — bis dahin nur ausdruecklich waehlbar (spawnbar:false).',
        },
        lage: {
          type: 'object',
          properties: {
            claude_quota: { type: 'string', enum: ['plenty', 'low', 'exhausted'] },
            codex_quota: { type: 'string', enum: ['plenty', 'low', 'exhausted'] },
            paid_api: { type: 'string', enum: ['allowed', 'not allowed'] },
          },
          description: 'Nur fuer empfehlen: Kontingent-Lage als Kategorien (Standard plenty/plenty/not allowed). exhausted entfernt die Gruppe, paid_api "not allowed" entfernt Gemini.',
        },
        max_optionen: {
          type: 'number',
          description: 'Nur fuer empfehlen: Hoechstzahl der Modelle in der Modell-Choice (Standard unbegrenzt; jedes angefragte Modell kommt vor). Die Stufen fragt Jev je Modell getrennt.',
        },
        schreiben: {
          type: 'boolean',
          description: 'Nur fuer empfehlen: Empfehlung in plans.tasks schreiben (Standard true). false = nur anzeigen.',
        },
        confidence_tor: {
          type: 'number',
          description: 'Nur fuer empfehlen: unter dieser Confidence (0..1) gibt es keine Empfehlung, sondern unsicher + bester_vorschlag. Standard JEV_CONFIDENCE_TOR bzw. 0.5.',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');

    switch (action) {
      case 'get': {
        const result = await getProjectPlan(project, str(args, 'plan_id'));
        if (!result) return result;
        // DX-Befund 5: status-Filter, compact, limit gegen Vollabwurf.
        const a = args as Record<string, unknown>;
        const p = result as unknown as Record<string, unknown> & { plan?: { tasks?: Array<Record<string, unknown>> } | null };
        const rohTasks = Array.isArray(p.plan?.tasks) ? p.plan!.tasks! : [];
        // P3-T4: zurueckgestellte Tasks ausblenden (alle:true / ausdrueckliche task_id zeigt sie). Ohne Wiedervorlage unveraendert.
        const wv = filtereWiedervorlageTasks(rohTasks as unknown as ProjectTask[], {
          alle: a.alle === true,
          taskIds: strArray(args, 'task_id'),
        });
        const allTasks = wv.tasks as unknown as Array<Record<string, unknown>>;
        const statusFilter = typeof a.status === 'string' ? a.status : undefined;
        const filtered = statusFilter ? allTasks.filter((t) => t.status === statusFilter) : allTasks;
        const taskLimit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : undefined;
        const limited = taskLimit ? filtered.slice(0, taskLimit) : filtered;
        const compact = a.compact === true;
        const tasks = compact
          ? limited.map((t) => ({ id: t.id, kurz_id: t.kurz_id, title: t.title, status: t.status, priority: t.priority }))
          : limited;
        return {
          ...p,
          tasks,
          tasks_total: allTasks.length,
          tasks_returned: tasks.length,
          ...(wv.ausgeblendet > 0 ? { zurueckgestellt_ausgeblendet: wv.ausgeblendet, zurueckgestellt_hinweis: 'plan(get, alle: true) oder task_id zeigt zurueckgestellte Tasks.' } : {}),
          ...(statusFilter ? { tasks_status_filter: statusFilter } : {}),
        };
      }

      case 'update': {
        const result = await updateProjectPlan(project, {
          name: str(args, 'name'),
          description: str(args, 'description'),
          goals: strArray(args, 'goals'),
          architecture: str(args, 'architecture'),
          prioritaet: str(args, 'plan_prioritaet'),
        }, str(args, 'plan_id'));
        return result;
      }

      case 'add_task': {
        const title = reqStr(args, 'title');
        const description = reqStr(args, 'description');
        const priority = (str(args, 'priority') || 'medium') as
          | 'low'
          | 'medium'
          | 'high';

        const result = await addPlanTask(project, title, description, priority, str(args, 'plan_id'));
        return result;
      }

      case 'add_tasks_batch': {
        const tasks = objArray<{ title: string; description: string; priority?: string }>(args, 'tasks');
        if (!tasks || tasks.length === 0) {
          return { success: false, count: 0, tasks: [], message: 'tasks (Array) ist erforderlich' };
        }
        const normalized = tasks.map(t => ({
          title: String(t.title ?? ''),
          description: String(t.description ?? ''),
          priority: (t.priority as 'low' | 'medium' | 'high' | undefined) ?? undefined,
        }));
        const result = await addPlanTasksBatch(project, normalized, str(args, 'plan_id'));
        return result;
      }

      case 'update_task': {
        const taskId = reqStr(args, 'task_id');
        const updates: { title?: string; description?: string; status?: 'todo' | 'in_progress' | 'done' | 'blocked'; priority?: 'low' | 'medium' | 'high' } = {};
        const t = str(args, 'title'); if (t !== undefined) updates.title = t;
        const d = str(args, 'description'); if (d !== undefined) updates.description = d;
        const s = str(args, 'status'); if (s !== undefined) updates.status = s as 'todo' | 'in_progress' | 'done' | 'blocked';
        const p = str(args, 'priority'); if (p !== undefined) updates.priority = p as 'low' | 'medium' | 'high';
        const result = await updatePlanTask(project, taskId, updates, str(args, 'plan_id'));
        return result;
      }

      case 'delete_task': {
        const ids = strArray(args, 'task_id');
        if (!ids || ids.length === 0) {
          return { success: false, deleted: 0, message: 'task_id (String oder Array) ist erforderlich' };
        }
        const result = await deletePlanTasks(project, ids, str(args, 'plan_id'));
        return result;
      }

      case 'list': {
        return await listProjectPlans(project, args.alle === true);
      }

      case 'passende_tasks': {
        return await passendeTasks(project, str(args, 'agent_id') ?? '', str(args, 'plan_id'));
      }

      case 'uebernehmen': {
        return await uebernehmeTask(project, str(args, 'plan_id') ?? '', str(args, 'task_id') ?? '', str(args, 'agent_id') ?? '');
      }

      case 'verschieben': {
        const ids = strArray(args, 'task_id');
        return await verschiebeTasks(project, ids ?? [], str(args, 'ziel')) as unknown as Record<string, unknown>;
      }

      case 'zurueckstellen': {
        const zTask = str(args, 'task_id');
        if (zTask) {
          // P3-T4: task_id => Wiedervorlage fuer die Task (plan_id optional, Alias/Kurz-ID plan-uebergreifend)
          return await zurueckstelleTask(project, str(args, 'plan_id'), zTask, { tage: args.tage, bis: args.bis }) as unknown as Record<string, unknown>;
        }
        return await zurueckstellenPlan(project, str(args, 'plan_id'), { tage: args.tage, bis: args.bis });
      }

      case 'create': {
        return await createProjectPlan(project, {
          name: reqStr(args, 'name'),
          description: str(args, 'description'),
          goals: strArray(args, 'goals'),
          architecture: str(args, 'architecture'),
          aktiv: args.aktiv === true,
          prioritaet: str(args, 'plan_prioritaet'),
        });
      }

      case 'aktivieren': {
        return await activateProjectPlan(project, reqStr(args, 'plan_id'));
      }

      case 'empfehlen': {
        const ids = strArray(args, 'task_id');
        const tor = args.confidence_tor;
        return await empfehleFuerPlan(project, {
          plan_id: str(args, 'plan_id'),
          kandidaten: args.kandidaten,
          task_ids: ids && ids.length > 0 ? ids : undefined,
          schreiben: args.schreiben !== false,
          confidence_tor: typeof tor === 'number' ? tor : undefined,
          lage: args.lage as Record<string, unknown> | undefined,
          max_optionen: typeof args.max_optionen === 'number' ? args.max_optionen : undefined,
        }) as unknown as Record<string, unknown>;
      }

      default:
        throw new Error(`Unbekannte Aktion: ${action}`);
    }
  },
};
