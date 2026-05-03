/**
 * Konsolidiertes Project Tool
 *
 * Vereint 7 separate MCP-Tools in einem einzigen Tool mit action-Parameter:
 * - init_projekt → "init"
 * - complete_setup → "complete_setup"
 * - detect_technologies → "detect_tech"
 * - cleanup_projekt → "cleanup"
 * - stop_projekt → "stop"
 * - get_project_status → "status"
 * - list_active_projects → "list"
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConsolidatedTool, str, reqStr, bool } from './types.js';
import { resolveAgentId } from '@synapse/core';
import {
  initProjekt,
  stopProjekt,
  listActiveProjects,
  cleanupProjekt,
  getProjectStatusWithStats,
} from '../index.js';

const projectTool: ConsolidatedTool = {
  definition: {
    name: 'project',
    description: 'Projekt-Management: init, setup, tech-Erkennung, cleanup, status und Listing. Self-Service-Init: action="init" + name (ohne path) queued den Anlage-Job an den FileWatcher-Daemon, der das Projekt unter SYNAPSE_WORKSPACE_ROOT (default ~/dev) anlegt und registriert. init_status mit job_id pollt den Status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'init_status', 'complete_setup', 'detect_tech', 'cleanup', 'stop', 'status', 'list'],
          description: 'Aktion: init | init_status | complete_setup | detect_tech | cleanup | stop | status | list',
        },
        path: {
          type: 'string',
          description: 'Absoluter Pfad zum Projekt-Ordner. Bei init optional — ohne path queued der Job an den Daemon und resolved gegen WORKSPACE_ROOT/name.',
        },
        name: {
          type: 'string',
          description: 'Projekt-Name. Pflicht fuer init wenn kein path gegeben. Erlaubt: 2-64 Zeichen [a-zA-Z0-9_-], beginnt mit Buchstabe/Ziffer.',
        },
        index_docs: {
          type: 'boolean',
          description: 'Framework-Dokumentation vorladen (Standard: true, für init)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name (für complete_setup, stop, list nutzt dies)',
        },
        phase: {
          type: 'string',
          enum: ['initial', 'post-indexing'],
          description: 'Setup-Phase (für complete_setup)',
        },
        agent_id: {
          type: 'string',
          description: 'Optionale Agent-ID für Onboarding (für init)',
        },
        hostname: {
          type: 'string',
          description: 'Optional fuer init: Ziel-Hostname falls mehrere Daemons im selben PG haengen.',
        },
        template: {
          type: 'string',
          description: 'Optional fuer init: Skeleton-Template ("node"|"python"|"blank"). Aktuell informational.',
        },
        job_id: {
          type: 'string',
          description: 'Erforderlich fuer init_status: Job-ID aus der ersten init-Antwort.',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = str(args, 'action');

    if (!action) {
      return {
        success: false,
        message: 'Parameter "action" ist erforderlich',
      };
    }

    try {
      switch (action) {
        case 'init': {
          const explicitPath = str(args, 'path');
          const requestedName = str(args, 'name');
          const indexDocs = bool(args, 'index_docs') !== false;
          const agentId = resolveAgentId(str(args, 'agent_id')) ?? undefined;

          // Self-Service: Wenn kein path aber ein name gegeben ist, queue an den
          // Daemon (auch lokal — er kennt WORKSPACE_ROOT). Web-KIs nutzen das via
          // REST, lokaler MCP nutzt es genauso wenn der User nur einen Namen gibt.
          if (!explicitPath) {
            if (!requestedName) {
              return { success: false, message: 'Mindestens "name" oder "path" muss gesetzt sein.' };
            }
            const { isValidProjectName, enqueueProjectInitJob, waitForProjectInitJob, expirePendingProjectInitJobs } = await import('@synapse/core');
            if (!isValidProjectName(requestedName)) {
              return {
                success: false,
                error: 'invalid_name',
                message: `Projekt-Name "${requestedName}" ist ungueltig. Erlaubt: 2-64 Zeichen, [a-zA-Z0-9_-], beginnt mit Buchstabe/Ziffer.`,
              };
            }
            // Auto-Start des Daemons: lokal will der User nicht erst den Tray
            // hochfahren muessen. Best-effort — wenn das fehlschlaegt, bleibt
            // die daemon_unreachable Antwort der Backstop.
            try {
              const { ensureDaemon } = await import('../../daemon-client.js');
              await ensureDaemon();
            } catch (daemonErr) {
              console.error('[project init] ensureDaemon fehlgeschlagen:', (daemonErr as Error).message);
            }
            const { id: jobId } = await enqueueProjectInitJob({
              name: requestedName,
              hostname: str(args, 'hostname'),
              template: str(args, 'template'),
              requested_by: agentId,
            });
            const job = await waitForProjectInitJob(jobId, 35_000);
            // Sicherheits-Cleanup falls kein Daemon laeuft — markiert >30s alte
            // pending Jobs als timeout. Damit hat dieser Job (oder Folge-Calls)
            // klaren Status statt fuer immer in pending zu haengen.
            if (job.status === 'pending' || job.status === 'running') {
              try { await expirePendingProjectInitJobs(30); } catch { /* best-effort */ }
            }
            if (job.status === 'done' && job.resolved_path) {
              const result = await initProjekt(job.resolved_path, job.name, indexDocs, agentId);
              return { ...result, job_id: job.id, message: job.message ?? (result as { message?: string }).message };
            }
            // Wait gelaufen aber Job noch pending/running = Daemon hat nicht abgeholt.
            if (job.status === 'pending' || job.status === 'running') {
              return {
                success: false,
                error: 'daemon_unreachable',
                job_id: job.id,
                status: job.status,
                message: 'FileWatcher-Daemon auf dem Ziel-PC hat den Job nicht abgeholt. Pruefe ob der Tray laeuft. Status erneut abrufen mit project(action: "init_status", job_id: "<id>").',
              };
            }
            return {
              success: false,
              error: job.error ?? job.status,
              job_id: job.id,
              status: job.status,
              message: job.message ?? `Project-Init fehlgeschlagen mit Status "${job.status}".`,
            };
          }

          const result = await initProjekt(explicitPath, requestedName, indexDocs, agentId);
          return result;
        }

        case 'init_status': {
          const { getProjectInitJob } = await import('@synapse/core');
          const jobId = reqStr(args, 'job_id');
          const job = await getProjectInitJob(jobId);
          if (!job) return { success: false, error: 'not_found', message: `Job ${jobId} nicht gefunden.` };
          return {
            success: job.status === 'done',
            project: job.name,
            path: job.resolved_path,
            status: job.status,
            error: job.error,
            message: job.message,
          };
        }

        case 'complete_setup': {
          const project = reqStr(args, 'project');
          const phase = str(args, 'phase') as 'initial' | 'post-indexing' | undefined;

          if (!phase) {
            return {
              success: false,
              message: 'Parameter "phase" ist erforderlich',
            };
          }

          const { getCachedProjectPath } = await import('../onboarding.js');
          const setupProjectPath = getCachedProjectPath(project);

          if (!setupProjectPath) {
            return {
              success: false,
              message: 'Projekt-Pfad nicht gefunden. Wurde "init" aufgerufen?',
            };
          }

          const { completeSetupTool } = await import('../index.js');
          const result = await completeSetupTool(project, phase, setupProjectPath);
          return result;
        }

        case 'detect_tech': {
          const path = reqStr(args, 'path');
          const { detectProjectTechnologies } = await import('../index.js');
          const result = await detectProjectTechnologies(path);
          return result;
        }

        case 'cleanup': {
          const path = reqStr(args, 'path');
          const name = reqStr(args, 'name');
          const result = await cleanupProjekt(path, name);
          return result;
        }

        case 'stop': {
          const project = reqStr(args, 'project');
          const path = str(args, 'path');

          const { readStatus } = await import('@synapse/agents');
          const { heartbeatController } = await import('@synapse/agents');
          const { getProjectPath } = await import('../index.js');

          const resolvedPath = path ?? getProjectPath(project);
          if (resolvedPath) {
            try {
              const agentStatus = await readStatus(resolvedPath);
              for (const name of Object.keys(agentStatus.specialists)) {
                if (heartbeatController.isConnected(name)) {
                  try {
                    await heartbeatController.sendStop(name);
                    await heartbeatController.disconnectFromWrapper(name);
                  } catch {
                    // best effort
                  }
                }
              }
            } catch {
              // no status file yet
            }
          }

          const stopped = await stopProjekt(project, path);
          return {
            success: stopped,
            project,
            message: stopped
              ? `FileWatcher für "${project}" gestoppt, Status auf 'stopped' gesetzt`
              : `Projekt "${project}" war nicht aktiv`,
          };
        }

        case 'status': {
          const path = reqStr(args, 'path');
          const result = await getProjectStatusWithStats(path);
          return result;
        }

        case 'list': {
          const projects = listActiveProjects();
          return {
            success: true,
            count: projects.length,
            projects,
            message: projects.length > 0
              ? `${projects.length} aktive Projekte: ${projects.join(', ')}`
              : 'Keine aktiven Projekte',
          };
        }

        default:
          return {
            success: false,
            message: `Unbekannte action: "${action}". Gültig sind: init | complete_setup | detect_tech | cleanup | stop | status | list`,
          };
      }
    } catch (error) {
      return {
        success: false,
        message: `Fehler bei action "${action}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { projectTool };
