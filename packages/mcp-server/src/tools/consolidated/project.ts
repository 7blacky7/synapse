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
    description: 'Verwende für alle Projekt-Management-Operationen: init, setup, tech-Erkennung, cleanup, status und Listing',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'complete_setup', 'detect_tech', 'cleanup', 'stop', 'status', 'list'],
          description: 'Aktion: init | complete_setup | detect_tech | cleanup | stop | status | list',
        },
        path: {
          type: 'string',
          description: 'Absoluter Pfad zum Projekt-Ordner (für init, detect_tech, cleanup, status)',
        },
        name: {
          type: 'string',
          description: 'Optionaler Projekt-Name (für init, cleanup) oder erforderlich für cleanup',
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
          const path = reqStr(args, 'path');
          const name = str(args, 'name');
          const indexDocs = bool(args, 'index_docs') !== false;
          const agentId = str(args, 'agent_id');

          const result = await initProjekt(path, name, indexDocs, agentId);
          return result;
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
