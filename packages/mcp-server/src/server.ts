/**
 * Synapse MCP - Server
 * MCP Server Implementation mit allen Tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  initProjekt,
  stopProjekt,
  listActiveProjects,
  cleanupProjekt,
  getProjectStatusWithStats,
  semanticCodeSearch,
  searchByPath,
  searchCodeWithPath,
  getProjectPlan,
  updateProjectPlan,
  addPlanTask,
  updatePlanTask,
  addThought,
  getThoughts,
  searchThoughts,
  deleteThought,
  detectProjectTechnologies,
  writeMemory,
  readMemory,
  listMemories,
  searchMemory,
  deleteMemory,
  readMemoryWithCode,
  findMemoriesForFile,
  getIndexStats,
  getDetailedStats,
  saveProjectIdea,
  confirmIdea,
  checkAgentOnboarding,
  listProposalsWrapper,
  getProposalWrapper,
  updateProposalStatusWrapper,
  deleteProposalWrapper,
  searchProposalsWrapper,
  migrateEmbeddings,
  restoreFromBackup,
  registerChatAgent,
  registerChatAgentsBatch,
  unregisterChatAgent,
  unregisterChatAgentsBatch,
  sendChatMessage,
  getChatMessages,
  listAgents,
  addTechDocTool,
  searchTechDocsTool,
  getDocsForFileTool,
  completeSetupTool,
  updateMemoryTool,
  updateThoughtTool,
  updateProposalTool,
  searchMediaWrapper,
  indexMediaWrapper,
  emitEventTool,
  acknowledgeEventTool,
  getPendingEventsTool,
  spawnSpecialistTool,
  stopSpecialistTool,
  specialistStatusTool,
  wakeSpecialistTool,
  updateSpecialistSkillTool,
  createChannelTool,
  joinChannelTool,
  leaveChannelTool,
  postToChannelTool,
  getChannelFeedTool,
  listChannelsTool,
  postToInboxTool,
  checkInboxTool,
  getAgentCapabilitiesTool,
  getProjectPath,
} from './tools/index.js';

import { getPendingEvents } from '@synapse/core';
import { ensureAgentsSchema, detectClaudeCli, heartbeatController, readStatus, postToInbox, postMessage, checkInbox } from '@synapse/agents';

/** Tracking: Wann hat ein Agent zuletzt Chat gelesen? */
const lastChatRead = new Map<string, string>();

/** Tracking: Wie oft hat ein Agent ein kritisches Event ignoriert? */
const eventIgnoreCount = new Map<string, { firstSeen: number; count: number }>();

/** Zählt ungelesene Chat-Nachrichten für einen Agenten */
async function getUnreadChatCount(
  agentId: string,
  project: string
): Promise<{ broadcasts: number; dms: Array<{ from: string; count: number }> } | null> {
  const lastRead = lastChatRead.get(agentId);
  if (!lastRead) return null; // Noch nie gelesen → kein Count (Onboarding zeigt Chat-Hinweis)

  try {
    const result = await getChatMessages(project, {
      agentId,
      since: lastRead,
      limit: 50,
    });

    if (!result.success || result.messages.length === 0) return null;

    let broadcasts = 0;
    const dmCounts = new Map<string, number>();

    for (const msg of result.messages) {
      if (msg.senderId === agentId) continue; // Eigene Nachrichten ignorieren
      if (msg.recipientId === agentId) {
        // DM an mich
        dmCounts.set(msg.senderId, (dmCounts.get(msg.senderId) || 0) + 1);
      } else if (!msg.recipientId) {
        // Broadcast
        broadcasts++;
      }
    }

    if (broadcasts === 0 && dmCounts.size === 0) return null;

    return {
      broadcasts,
      dms: Array.from(dmCounts.entries()).map(([from, count]) => ({ from, count })),
    };
  } catch {
    return null;
  }
}

/** Prüft ausstehende Events für einen Agenten und baut Hint-Text */
async function getUnackedEventHint(
  agentId: string,
  project: string
): Promise<{ events: Array<{id: number, eventType: string, priority: string, payload: string | null}>, hint: string } | null> {
  try {
    const pending = await getPendingEvents(project, agentId);
    if (!pending || pending.length === 0) return null;

    const events = pending.map(e => ({
      id: e.id,
      eventType: e.eventType,
      priority: e.priority,
      payload: e.payload,
    }));

    const hintParts: string[] = [];
    for (const e of pending) {
      if (e.priority === 'critical') {
        hintParts.push(`⛔ PFLICHT-EVENT: ${e.eventType} von ${e.sourceId}: ${e.payload}. Reagiere SOFORT mit acknowledge_event(event_id: ${e.id}, agent_id: "${agentId}")`);
      } else if (e.priority === 'high') {
        hintParts.push(`⚠️ EVENT: ${e.eventType} von ${e.sourceId}: ${e.payload}. Bitte mit acknowledge_event(event_id: ${e.id}, agent_id: "${agentId}") bestaetigen.`);
      } else {
        hintParts.push(`📋 EVENT: ${e.eventType}: ${e.payload}. acknowledge_event(event_id: ${e.id}, agent_id: "${agentId}")`);
      }
    }

    return { events, hint: hintParts.join('\n') };
  } catch {
    return null;
  }
}

/**
 * Erstellt und konfiguriert den MCP Server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: 'synapse-mcp',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool-Liste registrieren
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ===== PROJEKT-MANAGEMENT =====
      {
        name: 'init_projekt',
        description: '⚠️ STOPP! Bevor du dieses Tool aufrufst: 1) Erstelle ZUERST eine .synapseignore Datei im Projekt-Root 2) Füge Muster für Dateien ein die NICHT indexiert werden sollen (große Dateien, generierte Dateien, etc.) 3) Syntax ist wie .gitignore. Beispiel-Inhalt für .synapseignore: "*.pdf\\n*.zip\\n*.min.js\\ndocs/archived/\\ntests/fixtures/\\n*.generated.*". Erst DANACH dieses Tool aufrufen!',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
            name: {
              type: 'string',
              description: 'Optionaler Projekt-Name (Standard: Ordnername)',
            },
            index_docs: {
              type: 'boolean',
              description: 'Framework-Dokumentation vorladen (Standard: true)',
            },
            agent_id: {
              type: 'string',
              description: 'Optionale Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln (category: rules Memories).',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'complete_setup',
        description: 'Markiert eine Setup-Phase als abgeschlossen. Wird nach dem Setup-Wizard aufgerufen.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            phase: { type: 'string', enum: ['initial', 'post-indexing'], description: 'Welche Phase abschliessen' },
          },
          required: ['project', 'phase'],
        },
      },
      {
        name: 'detect_technologies',
        description: 'Erkennt verwendete Technologien in einem Projekt (Frameworks, Libraries, Tools)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'cleanup_projekt',
        description: 'Bereinigt ein Projekt nach Änderungen an .synapseignore - löscht alle Dateien aus der Vektordatenbank die jetzt ignoriert werden sollen. Zeigt detailliertes Feedback: welche Dateien gelöscht wurden, nach Pattern gruppiert.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
            name: {
              type: 'string',
              description: 'Projekt-Name',
            },
          },
          required: ['path', 'name'],
        },
      },
      {
        name: 'get_index_stats',
        description: 'Zeigt Index-Statistiken für ein Projekt: Anzahl Dateien, Vektoren, aufgeteilt nach Collections (Code, Thoughts, Memories)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_detailed_stats',
        description: 'Detaillierte Statistiken: Code nach Dateityp, Thoughts nach Source, Memories nach Kategorie',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'stop_projekt',
        description: 'Stoppt den FileWatcher für ein Projekt und setzt Status auf stopped',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            path: {
              type: 'string',
              description: 'Optional: Absoluter Pfad zum Projekt (fuer Status-Update)',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'list_active_projects',
        description: 'Listet alle Projekte mit aktivem FileWatcher auf',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_project_status',
        description: 'Zeigt den persistenten Status eines Projekts (.synapse/status.json)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt',
            },
          },
          required: ['path'],
        },
      },
      // ===== CODE-SUCHE =====
      {
        name: 'semantic_code_search',
        description: 'Durchsucht den Code semantisch - findet konzeptuell aehnlichen Code',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage in natuerlicher Sprache',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            file_type: {
              type: 'string',
              description: 'Optional: Dateityp filtern (z.B. typescript, python)',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query', 'project'],
        },
      },
      {
        name: 'search_by_path',
        description: 'Exakte Pfadsuche ohne Embedding - findet Dateien nach Glob-Pattern. Beispiele: "backend/src/*", "**/*.ts", "**/utils/*"',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            path_pattern: {
              type: 'string',
              description: 'Glob-Pattern für Dateipfade (z.B. "src/**/*.ts", "backend/*")',
            },
            content_pattern: {
              type: 'string',
              description: 'Optional: Regex-Pattern für Content-Filter',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 50)',
            },
          },
          required: ['project', 'path_pattern'],
        },
      },
      {
        name: 'search_code_with_path',
        description: 'Kombinierte Suche: Semantisch + Pfad-Filter. Erst semantisch ranken, dann nach Pfad filtern.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Semantische Suchanfrage',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            path_pattern: {
              type: 'string',
              description: 'Optional: Glob-Pattern für Pfad-Filter',
            },
            file_type: {
              type: 'string',
              description: 'Optional: Dateityp filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query', 'project'],
        },
      },
      // ===== MEDIA-SUCHE =====
      {
        name: 'search_media',
        description: 'Cross-Modal Media-Suche: Findet Bilder und Videos per Text-Query (nutzt Google Gemini Embedding 2). Durchsucht die projekt-spezifische Media-Collection.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage in natuerlicher Sprache (z.B. "login form screenshot", "dashboard navigation video")',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding.',
            },
            media_type: {
              type: 'string',
              enum: ['image', 'video'],
              description: 'Optional: Nur Bilder oder nur Videos',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query', 'project'],
        },
      },
      {
        name: 'index_media',
        description: 'Indexiert Bilder und Videos in die projekt-spezifische Media-Collection (Google Gemini Embedding 2). Akzeptiert einzelne Dateien oder Verzeichnisse. Bereits indexierte Dateien werden uebersprungen.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zu einer Datei oder einem Verzeichnis mit Media-Dateien',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding.',
            },
            recursive: {
              type: 'boolean',
              description: 'Bei Verzeichnissen: rekursiv durchsuchen (Standard: true)',
            },
          },
          required: ['path', 'project'],
        },
      },
      // ===== PROJEKT-PLANUNG =====
      {
        name: 'get_project_plan',
        description: 'Ruft den Projekt-Plan ab (Ziele, Tasks, Architektur)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'update_project_plan',
        description: 'Aktualisiert den Projekt-Plan',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
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
          },
          required: ['project'],
        },
      },
      {
        name: 'add_plan_task',
        description: 'Fuegt eine neue Task zum Projekt-Plan hinzu',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            title: {
              type: 'string',
              description: 'Task-Titel',
            },
            description: {
              type: 'string',
              description: 'Task-Beschreibung',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Prioritaet (Standard: medium)',
            },
          },
          required: ['project', 'title', 'description'],
        },
      },

      // ===== GEDANKENAUSTAUSCH =====
      {
        name: 'add_thought',
        description: 'Speichert einen Gedanken/eine Idee im Gedankenaustausch (max. 10.000 Zeichen empfohlen)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            source: {
              type: 'string',
              description: 'Quelle (z.B. claude-code, gpt, user)',
            },
            content: {
              type: 'string',
              description: 'Inhalt des Gedankens',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optionale Tags',
            },
          },
          required: ['project', 'source', 'content'],
        },
      },
      {
        name: 'get_thoughts',
        description: 'Ruft den Gedankenaustausch fuer ein Projekt ab',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl (Standard: 50)',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'search_thoughts',
        description: 'Durchsucht Gedanken semantisch',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'delete_thought',
        description: 'Loescht einen Gedanken nach ID',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            id: {
              type: 'string',
              description: 'ID des Gedankens',
            },
          },
          required: ['project', 'id'],
        },
      },

      // ===== MEMORY (LANGZEIT-SPEICHER) =====
      {
        name: 'write_memory',
        description: 'Speichert längere Dokumentation/Notizen persistent. Überschreibt bei gleichem Namen. Für große Dokumente geeignet. Kategorie "rules" fuer Projekt-Regeln die neue Agenten beim Onboarding sehen.',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Eindeutiger Name für das Memory (z.B. "architecture-overview", "api-docs")',
            },
            content: {
              type: 'string',
              description: 'Inhalt des Memories (beliebig lang)',
            },
            category: {
              type: 'string',
              enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
              description: 'Kategorie (Standard: note). "rules" = Projekt-Regeln fuer Agent-Onboarding',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optionale Tags für bessere Suche',
            },
          },
          required: ['project', 'name', 'content'],
        },
      },
      {
        name: 'read_memory',
        description: 'Liest ein Memory nach Name',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Name des Memories',
            },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'list_memories',
        description: 'Listet alle Memories eines Projekts auf',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            category: {
              type: 'string',
              enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
              description: 'Optional: Nach Kategorie filtern. "rules" = Projekt-Regeln fuer Agent-Onboarding',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'search_memory',
        description: 'Durchsucht Memories semantisch',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'delete_memory',
        description: 'Löscht ein Memory',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Name des Memories',
            },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'read_memory_with_code',
        description: 'Liest ein Memory und findet verwandten Code basierend auf Dateipfaden im Content',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
            name: { type: 'string', description: 'Memory-Name' },
            codeLimit: { type: 'number', description: 'Max. Code-Chunks (Standard: 10)' },
            includeSemanticMatches: { type: 'boolean', description: 'Semantische Matches einbeziehen (Standard: true)' },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'find_memories_for_file',
        description: 'Findet Memories die auf eine bestimmte Datei verweisen',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
            filePath: { type: 'string', description: 'Dateipfad' },
            limit: { type: 'number', description: 'Max. Ergebnisse (Standard: 10)' },
          },
          required: ['project', 'filePath'],
        },
      },

      // ===== SCHATTENVORSCHLAEGE (PROPOSALS) =====
      {
        name: 'list_proposals',
        description: 'Listet alle Schattenvorschlaege eines Projekts auf (nur Metadaten, kein Content)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            status: {
              type: 'string',
              enum: ['pending', 'reviewed', 'accepted', 'rejected'],
              description: 'Optional: Nach Status filtern',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_proposal',
        description: 'Ruft einen einzelnen Schattenvorschlag mit vollem suggestedContent ab',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            id: {
              type: 'string',
              description: 'Proposal-ID',
            },
          },
          required: ['project', 'id'],
        },
      },
      {
        name: 'update_proposal_status',
        description: 'Aendert den Status eines Schattenvorschlags',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            id: {
              type: 'string',
              description: 'Proposal-ID',
            },
            status: {
              type: 'string',
              enum: ['reviewed', 'accepted', 'rejected'],
              description: 'Neuer Status',
            },
          },
          required: ['project', 'id', 'status'],
        },
      },
      {
        name: 'delete_proposal',
        description: 'Loescht einen Schattenvorschlag',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            id: {
              type: 'string',
              description: 'Proposal-ID',
            },
          },
          required: ['project', 'id'],
        },
      },
      {
        name: 'search_proposals',
        description: 'Durchsucht Schattenvorschlaege semantisch',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query'],
        },
      },

      // ===== UPDATE-TOOLS (EDIT-LAYER) =====
      {
        name: 'update_memory',
        description: 'Aktualisiert ein bestehendes Memory (Felder einzeln aenderbar). Aendert PostgreSQL und re-indexiert Qdrant.',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Name des Memories (eindeutiger Identifier)',
            },
            content: {
              type: 'string',
              description: 'Neuer Inhalt (optional)',
            },
            category: {
              type: 'string',
              enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
              description: 'Neue Kategorie (optional)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Neue Tags (optional, ersetzt bestehende)',
            },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'update_thought',
        description: 'Aktualisiert einen bestehenden Gedanken. Aendert PostgreSQL und re-indexiert Qdrant.',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            id: {
              type: 'string',
              description: 'ID des Gedankens',
            },
            content: {
              type: 'string',
              description: 'Neuer Inhalt (optional)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Neue Tags (optional, ersetzt bestehende)',
            },
          },
          required: ['project', 'id'],
        },
      },
      {
        name: 'update_proposal',
        description: 'Aktualisiert einen Schattenvorschlag. Aendert PostgreSQL und re-indexiert Qdrant.',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            id: {
              type: 'string',
              description: 'Proposal-ID',
            },
            content: {
              type: 'string',
              description: 'Neue Beschreibung (optional)',
            },
            suggested_content: {
              type: 'string',
              description: 'Neuer vorgeschlagener Inhalt (optional)',
            },
            status: {
              type: 'string',
              enum: ['pending', 'reviewed', 'accepted', 'rejected'],
              description: 'Neuer Status (optional)',
            },
          },
          required: ['project', 'id'],
        },
      },

      // ===== MIGRATION & BACKUP =====
      {
        name: 'migrate_embeddings',
        description: 'Migriert Embeddings bei Modellwechsel. Liest Payloads aus Qdrant, sichert als JSONL, loescht Collections, erstellt neu mit aktuellen Dimensionen, re-embedded alle Daten.',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name (wird fuer Code-Collection benoetigt)',
            },
            collections: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: Nur bestimmte Collections migrieren (Standard: alle Agenten-Collections + project_{name})',
            },
            dry_run: {
              type: 'boolean',
              description: 'Nur pruefen ohne zu migrieren (Standard: false)',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'restore_backup',
        description: 'Stellt Thoughts, Memories, Plans und/oder Proposals aus JSONL-Backup wieder her. Re-embedded mit aktuellem Modell.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['thoughts', 'memories', 'plans', 'proposals', 'all'],
              description: 'Was wiederherstellen (Standard: all)',
            },
            project: {
              type: 'string',
              description: 'Optional: Nur fuer ein bestimmtes Projekt wiederherstellen',
            },
          },
        },
      },

      // ===== TECH-DOCS =====
      {
        name: 'add_tech_doc',
        description: 'Indexiert ein Tech-Doc (Breaking Change, Migration, Gotcha etc.) in PostgreSQL + Qdrant. Duplikat-Check via content_hash.',
        inputSchema: {
          type: 'object',
          properties: {
            framework: { type: 'string', description: 'Framework/Sprache (z.B. react, python, express)' },
            version: { type: 'string', description: 'Version (z.B. 19.0, 3.12)' },
            section: { type: 'string', description: 'Abschnitt (z.B. hooks, routing, breaking-changes)' },
            content: { type: 'string', description: 'Inhalt des Docs' },
            type: { type: 'string', enum: ['feature', 'breaking-change', 'migration', 'gotcha', 'code-example', 'best-practice', 'known-issue', 'community'], description: 'Chunk-Type' },
            category: { type: 'string', enum: ['framework', 'language'], description: 'framework oder language (Standard: framework)' },
            source: { type: 'string', enum: ['research', 'context7', 'manual'], description: 'Quelle (Standard: research)' },
            project: { type: 'string', description: 'Optional: Projekt fuer projekt-spezifische Docs-Collection' },
          },
          required: ['framework', 'version', 'section', 'content', 'type'],
        },
      },
      {
        name: 'search_tech_docs',
        description: 'Durchsucht Tech-Docs semantisch. Filtert nach Framework, Type und Source.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Suchanfrage' },
            framework: { type: 'string', description: 'Optional: Framework filtern' },
            type: { type: 'string', description: 'Optional: Chunk-Type filtern (breaking-change, migration, etc.)' },
            source: { type: 'string', description: 'Optional: Quelle filtern (research, context7)' },
            project: { type: 'string', description: 'Optional: Projekt-Collection durchsuchen' },
            limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
            scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Suchbereich: project (Standard, nur Projekt-Collection), global (nur globale tech_docs_cache), all (beide, Duplikate gefiltert)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_docs_for_file',
        description: 'Wissens-Airbag: Holt relevante Tech-Docs fuer eine Datei. Prueft ob Docs neuer als Agent-Cutoff sind und liefert nur kuratierte research-Chunks (breaking-changes, migrations, gotchas).',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Dateipfad (z.B. src/api.ts)' },
            agent_id: { type: 'string', description: 'Agent-ID fuer Cutoff-Ermittlung' },
            project: { type: 'string', description: 'Projekt-Name' },
          },
          required: ['file_path', 'agent_id', 'project'],
        },
      },

      // ===== AGENTEN-CHAT =====
      {
        name: 'register_chat_agent',
        description: 'Registriert einen Agenten im Projekt-Chat. Cutoff-Datum wird bei bekannten Modellen automatisch erkannt.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Einzigartige Agent-ID' },
            project: { type: 'string', description: 'Projekt-Name' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (optional, fuer Specialist-System)' },
            model: { type: 'string', description: 'Modell-Name (z.B. claude-opus-4-6, gpt-4o)' },
            cutoff_date: { type: 'string', description: 'Wissens-Cutoff (YYYY-MM-DD), wird bei bekannten Modellen auto-erkannt' },
          },
          required: ['id', 'project'],
        },
      },
      {
        name: 'unregister_chat_agent',
        description: 'Meldet einen Agenten vom Chat ab',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent-ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'register_chat_agents_batch',
        description: 'Registriert mehrere Agenten auf einmal. Spart API-Calls bei vielen parallelen Agenten.',
        inputSchema: {
          type: 'object',
          properties: {
            agents: {
              type: 'array',
              description: 'Liste der Agenten',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Einzigartige Agent-ID' },
                  model: { type: 'string', description: 'Modell-Name (z.B. claude-haiku-4-5, claude-sonnet-4-6)' },
                },
                required: ['id'],
              },
            },
            project: { type: 'string', description: 'Projekt-Name' },
          },
          required: ['agents', 'project'],
        },
      },
      {
        name: 'unregister_chat_agents_batch',
        description: 'Meldet mehrere Agenten auf einmal ab.',
        inputSchema: {
          type: 'object',
          properties: {
            ids: {
              type: 'array',
              description: 'Liste der Agent-IDs',
              items: { type: 'string' },
            },
          },
          required: ['ids'],
        },
      },
      {
        name: 'send_chat_message',
        description: 'Sendet eine Nachricht. Ohne recipient_id = Broadcast an alle. Mit recipient_id = DM. Wenn der Empfaenger ein Spezialist ist, wird automatisch das Specialist-Inbox-System genutzt.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (optional, fuer Specialist-Routing)' },
            sender_id: { type: 'string', description: 'Absender Agent-ID' },
            content: { type: 'string', description: 'Nachrichteninhalt' },
            recipient_id: { type: 'string', description: 'Empfaenger Agent-ID (leer = Broadcast)' },
          },
          required: ['project', 'sender_id', 'content'],
        },
      },
      {
        name: 'get_chat_messages',
        description: 'Holt Chat-Nachrichten. Mit since fuer Polling (nur neue Nachrichten seit Zeitpunkt). Inkludiert automatisch Specialist-Inbox-Nachrichten wenn project_path angegeben.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (optional, fuer Specialist-Inbox)' },
            agent_id: { type: 'string', description: 'Eigene Agent-ID (filtert relevante DMs)' },
            since: { type: 'string', description: 'ISO-Timestamp, nur Nachrichten danach (fuer Polling)' },
            sender_id: { type: 'string', description: 'Optional: Nur Nachrichten von diesem Absender' },
            limit: { type: 'number', description: 'Max Nachrichten (Standard: 50)' },
          },
          required: ['project'],
        },
      },
      {
        name: 'list_chat_agents',
        description: 'Listet alle aktiven Agenten im Projekt-Chat. Inkludiert Spezialisten wenn project_path angegeben.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (optional, listet auch Spezialisten)' },
          },
          required: ['project'],
        },
      },

      // ===== AGENTEN-EVENTS =====
      {
        name: 'emit_event',
        description: 'Sendet ein Event an Agenten. Event-Typen: WORK_STOP, CRITICAL_REVIEW, ARCH_DECISION, TEAM_DISCUSSION, ANNOUNCEMENT. Priority: critical, high, normal. Scope: \'all\' oder \'agent:<id>\'.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            event_type: { type: 'string', description: 'Event-Typ: WORK_STOP, CRITICAL_REVIEW, ARCH_DECISION, TEAM_DISCUSSION, ANNOUNCEMENT' },
            priority: { type: 'string', description: 'Prioritaet: critical, high, normal' },
            scope: { type: 'string', description: 'Empfaenger: "all" oder "agent:<id>" (Standard: "all")' },
            source_id: { type: 'string', description: 'Absender Agent-ID' },
            payload: { type: 'string', description: 'Optionaler JSON-Payload mit weiteren Infos' },
            requires_ack: { type: 'boolean', description: 'Ob Agenten quittieren muessen (Standard: true)' },
          },
          required: ['project', 'event_type', 'priority', 'source_id'],
        },
      },
      {
        name: 'acknowledge_event',
        description: 'Bestaetigt ein Event. PFLICHT bei Events mit requires_ack=true.',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'number', description: 'Event-ID' },
            agent_id: { type: 'string', description: 'Eigene Agent-ID' },
            reaction: { type: 'string', description: 'Optionale Reaktion/Kommentar zum Event' },
          },
          required: ['event_id', 'agent_id'],
        },
      },
      {
        name: 'get_pending_events',
        description: 'Holt unbestaetigte Events fuer einen Agenten.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            agent_id: { type: 'string', description: 'Eigene Agent-ID' },
          },
          required: ['project', 'agent_id'],
        },
      },

      // ===== PROJEKT-IDEEN =====
      {
        name: 'save_project_idea',
        description: 'Speichert eine Projektidee. Generiert automatisch einen Namen und fragt nach Bestaetigung.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Die Projektidee',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt (Standard: "ideas")',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optionale Tags',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'confirm_idea',
        description: 'Bestaetigt eine vorgeschlagene Idee und speichert sie persistent',
        inputSchema: {
          type: 'object',
          properties: {
            temp_id: {
              type: 'string',
              description: 'Temporaere ID der vorgemerkten Idee',
            },
            custom_name: {
              type: 'string',
              description: 'Optional: Eigener Name statt des vorgeschlagenen',
            },
          },
          required: ['temp_id'],
        },
      },

      // ===== SPEZIALISTEN (AGENT-SPAWNING) =====
      {
        name: 'spawn_specialist',
        description: 'Spawnt einen persistenten Claude CLI Spezialisten mit eigenem Skill-System. Der Spezialist laeuft als detached Prozess und kommuniziert ueber Unix-Sockets.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Eindeutiger Name des Spezialisten' },
            model: { type: 'string', enum: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'], description: 'Claude Modell' },
            expertise: { type: 'string', description: 'Fachgebiet des Spezialisten' },
            task: { type: 'string', description: 'Aufgabe fuer den Spezialisten' },
            project: { type: 'string', description: 'Projekt-Name' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
            cwd: { type: 'string', description: 'Arbeitsverzeichnis (Standard: Projekt-Pfad)' },
            channel: { type: 'string', description: 'Channel fuer Kommunikation (Standard: {project}-general)' },
            allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Erlaubte Tools fuer den Spezialisten' },
          },
          required: ['name', 'model', 'expertise', 'task', 'project', 'project_path'],
        },
      },
      {
        name: 'stop_specialist',
        description: 'Stoppt einen laufenden Spezialisten und trennt die Verbindung',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name des Spezialisten' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
          },
          required: ['name', 'project_path'],
        },
      },
      {
        name: 'specialist_status',
        description: 'Zeigt Status aller Spezialisten oder eines einzelnen (inkl. Wrapper-Status und SKILL.md)',
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
            name: { type: 'string', description: 'Optional: Name eines einzelnen Spezialisten' },
          },
          required: ['project_path'],
        },
      },
      {
        name: 'wake_specialist',
        description: 'Sendet eine Nachricht an einen schlafenden Spezialisten und wartet auf Antwort',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name des Spezialisten' },
            message: { type: 'string', description: 'Nachricht an den Spezialisten' },
          },
          required: ['name', 'message'],
        },
      },
      {
        name: 'update_specialist_skill',
        description: 'Aktualisiert die SKILL.md eines Spezialisten (Regeln, Fehler oder Patterns hinzufuegen/entfernen)',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name des Spezialisten' },
            project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
            section: { type: 'string', enum: ['regeln', 'fehler', 'patterns'], description: 'Abschnitt der SKILL.md' },
            action: { type: 'string', enum: ['add', 'remove'], description: 'Hinzufuegen oder entfernen' },
            content: { type: 'string', description: 'Inhalt des Eintrags' },
          },
          required: ['name', 'project_path', 'section', 'action', 'content'],
        },
      },
      {
        name: 'get_agent_capabilities',
        description: 'Prueft ob Claude CLI verfuegbar ist und welche Specialist-Features aktiv sind',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // ===== SPECIALIST-CHANNELS =====
      {
        name: 'create_channel',
        description: 'Erstellt einen neuen Channel fuer Spezialisten-Kommunikation',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Channel-Name' },
            project: { type: 'string', description: 'Projekt-Name' },
            description: { type: 'string', description: 'Beschreibung des Channels' },
            created_by: { type: 'string', description: 'Ersteller (Agent-Name)' },
          },
          required: ['name', 'project', 'description', 'created_by'],
        },
      },
      {
        name: 'join_channel',
        description: 'Fuegt einen Agenten einem Channel hinzu',
        inputSchema: {
          type: 'object',
          properties: {
            channel_name: { type: 'string', description: 'Channel-Name' },
            agent_name: { type: 'string', description: 'Agent-Name' },
          },
          required: ['channel_name', 'agent_name'],
        },
      },
      {
        name: 'leave_channel',
        description: 'Entfernt einen Agenten aus einem Channel',
        inputSchema: {
          type: 'object',
          properties: {
            channel_name: { type: 'string', description: 'Channel-Name' },
            agent_name: { type: 'string', description: 'Agent-Name' },
          },
          required: ['channel_name', 'agent_name'],
        },
      },
      {
        name: 'post_to_channel',
        description: 'Postet eine Nachricht in einen Channel',
        inputSchema: {
          type: 'object',
          properties: {
            channel_name: { type: 'string', description: 'Channel-Name' },
            sender: { type: 'string', description: 'Absender (Agent-Name)' },
            content: { type: 'string', description: 'Nachrichteninhalt' },
          },
          required: ['channel_name', 'sender', 'content'],
        },
      },
      {
        name: 'get_channel_feed',
        description: 'Holt Nachrichten aus einem Channel (chronologisch, aelteste zuerst)',
        inputSchema: {
          type: 'object',
          properties: {
            channel_name: { type: 'string', description: 'Channel-Name' },
            limit: { type: 'number', description: 'Max. Nachrichten (Standard: 20)' },
            since_id: { type: 'number', description: 'Nur Nachrichten nach dieser ID' },
            preview: { type: 'boolean', description: 'Inhalte auf 200 Zeichen kuerzen (Standard: false)' },
          },
          required: ['channel_name'],
        },
      },
      {
        name: 'list_channels',
        description: 'Listet alle Channels auf (optional nach Projekt gefiltert)',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Optional: Projekt-Name zum Filtern' },
          },
        },
      },

      // ===== SPECIALIST-INBOX =====
      {
        name: 'post_to_inbox',
        description: 'Sendet eine Direktnachricht an einen Spezialisten',
        inputSchema: {
          type: 'object',
          properties: {
            from_agent: { type: 'string', description: 'Absender Agent-Name' },
            to_agent: { type: 'string', description: 'Empfaenger Agent-Name' },
            content: { type: 'string', description: 'Nachrichteninhalt' },
          },
          required: ['from_agent', 'to_agent', 'content'],
        },
      },
      {
        name: 'check_inbox',
        description: 'Prueft und markiert ungelesene Inbox-Nachrichten eines Agenten als gelesen',
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Agent-Name' },
          },
          required: ['agent_name'],
        },
      },
    ],
  }));

  // Tool-Aufrufe verarbeiten
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Globale Parameter fuer Agent-Onboarding extrahieren
    const agentId = args?.agent_id as string | undefined;
    const projectName = args?.project as string | undefined;

    // Helper: Ergebnis mit Onboarding erweitern
    const withOnboarding = async (result: Record<string, unknown>) => {
      if (!agentId || !projectName) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const onboarding = await checkAgentOnboarding(projectName, agentId);
      const enhanced: Record<string, unknown> = { ...result };

      // Onboarding-Regeln bei erstem Besuch
      if (onboarding?.isFirstVisit && onboarding.rules && onboarding.rules.length > 0) {
        enhanced.agentOnboarding = {
          isFirstVisit: true,
          message: '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:',
          rules: onboarding.rules,
        };
      }

      // Pending Events anzeigen (VOR Chat)
      const pendingEvents = await getUnackedEventHint(agentId, projectName);
      if (pendingEvents) {
        enhanced.pendingEvents = {
          count: pendingEvents.events.length,
          events: pendingEvents.events,
          hint: pendingEvents.hint,
        };
      }

      // Ungelesene Chat-Nachrichten anzeigen
      const unread = await getUnreadChatCount(agentId, projectName);
      if (unread) {
        const parts: string[] = [];
        if (unread.broadcasts > 0) parts.push(`${unread.broadcasts} Broadcasts`);
        for (const dm of unread.dms) parts.push(`${dm.count} DM von ${dm.from}`);
        enhanced.unreadChat = {
          ...unread,
          hint: `📨 Ungelesene Nachrichten: ${parts.join(', ')}. Lies mit: get_chat_messages(project: "${projectName}", agent_id: "${agentId}")`,
        };
      }

      // Aktive Agenten anzeigen (kompakte Einblendung)
      try {
        const agentList = await listAgents(projectName);
        if (agentList.success && agentList.agents.length > 0) {
          const others = agentList.agents.filter(a => a.id !== agentId);
          if (others.length > 0) {
            enhanced.activeAgents = {
              count: others.length + 1,
              agents: agentList.agents.map(a => ({
                id: a.id,
                model: a.model,
                isYou: a.id === agentId,
              })),
              hint: `👥 Aktive Agenten: ${agentList.agents.map(a => a.id === agentId ? `${a.id} (du)` : a.id).join(', ')}`,
            };
          }
        }
      } catch { /* Agenten-Liste darf nicht crashen */ }

      // Eskalation: Agent ignoriert kritische Events
      if (pendingEvents) {
        const hasCritical = pendingEvents.events.some(e => e.priority === 'critical');
        const hasHigh = pendingEvents.events.some(e => e.priority === 'high');

        if (hasCritical || hasHigh) {
          const key = agentId;
          const now = Date.now();
          const existing = eventIgnoreCount.get(key);

          if (!existing) {
            // Erstes Mal gesehen — Grace Period starten
            eventIgnoreCount.set(key, { firstSeen: now, count: 1 });
          } else {
            existing.count++;
            // Grace Period: 30 Sekunden nach erstem Sehen
            const elapsed = now - existing.firstSeen;
            if (elapsed > 30000 && existing.count >= 3) {
              // Eskalation an Koordinator
              try {
                const eventList = pendingEvents.events.map(e => `${e.eventType}(${e.priority})`).join(', ');
                await sendChatMessage(
                  projectName,
                  'system',
                  `⚠️ ESKALATION: Agent "${agentId}" ignoriert ${pendingEvents.events.length} Event(s) seit ${existing.count} Tool-Calls: ${eventList}`,
                  'koordinator'
                );
                console.error(`[Synapse] Eskalation: ${agentId} ignoriert Events seit ${existing.count} Calls`);
              } catch { /* Eskalation darf nicht crashen */ }
            }
          }
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(enhanced, null, 2) }] };
    };

    try {
      switch (name) {
        // ===== PROJEKT-MANAGEMENT =====
        case 'init_projekt': {
          const result = await initProjekt(
            args?.path as string,
            args?.name as string | undefined,
            args?.index_docs !== false,
            agentId
          );
          // Pfad wird automatisch in initProjekt gecacht
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'complete_setup': {
          const { getCachedProjectPath } = await import('./tools/onboarding.js');
          const setupProjectPath = getCachedProjectPath(args?.project as string);
          if (!setupProjectPath) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Projekt-Pfad nicht gefunden. Wurde init_projekt aufgerufen?' }, null, 2) }] };
          }
          const result = await completeSetupTool(
            args?.project as string,
            args?.phase as 'initial' | 'post-indexing',
            setupProjectPath
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'detect_technologies': {
          const result = await detectProjectTechnologies(args?.path as string);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'cleanup_projekt': {
          const result = await cleanupProjekt(
            args?.path as string,
            args?.name as string
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_index_stats': {
          const result = await getIndexStats(args?.project as string);
          return withOnboarding(result);
        }

        case 'get_detailed_stats': {
          const result = await getDetailedStats(args?.project as string);
          return withOnboarding(result);
        }

        case 'stop_projekt': {
          const projectName = args?.project as string;
          const projectPath = args?.path as string | undefined;

          // Stop all running specialists before stopping the project
          const resolvedPath = projectPath ?? getProjectPath(projectName);
          if (resolvedPath) {
            try {
              const agentStatus = await readStatus(resolvedPath);
              for (const name of Object.keys(agentStatus.specialists)) {
                if (heartbeatController.isConnected(name)) {
                  try {
                    await heartbeatController.sendStop(name);
                    await heartbeatController.disconnectFromWrapper(name);
                  } catch { /* best effort */ }
                }
              }
            } catch { /* no status file yet — nothing to clean */ }
          }

          const stopped = await stopProjekt(projectName, projectPath);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: stopped,
                project: projectName,
                message: stopped
                  ? `FileWatcher für "${projectName}" gestoppt, Status auf 'stopped' gesetzt`
                  : `Projekt "${projectName}" war nicht aktiv`,
              }, null, 2),
            }],
          };
        }

        case 'list_active_projects': {
          const projects = listActiveProjects();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                count: projects.length,
                projects,
                message: projects.length > 0
                  ? `${projects.length} aktive Projekte: ${projects.join(', ')}`
                  : 'Keine aktiven Projekte',
              }, null, 2),
            }],
          };
        }

        case 'get_project_status': {
          const { path: projectPath } = args as { path: string };
          const result = await getProjectStatusWithStats(projectPath);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== CODE-SUCHE =====
        case 'semantic_code_search': {
          const result = await semanticCodeSearch(
            args?.query as string,
            args?.project as string,
            args?.file_type as string | undefined,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'search_by_path': {
          const result = await searchByPath(
            args?.project as string,
            args?.path_pattern as string,
            {
              contentPattern: args?.content_pattern as string | undefined,
              limit: args?.limit as number | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'search_code_with_path': {
          const result = await searchCodeWithPath(
            args?.query as string,
            args?.project as string,
            {
              pathPattern: args?.path_pattern as string | undefined,
              fileType: args?.file_type as string | undefined,
              limit: args?.limit as number | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'search_media': {
          const result = await searchMediaWrapper(
            args?.query as string,
            args?.project as string,
            args?.media_type as 'image' | 'video' | undefined,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'index_media': {
          const result = await indexMediaWrapper(
            args?.path as string,
            args?.project as string,
            args?.recursive as boolean | undefined
          );
          return withOnboarding(result);
        }

        // ===== PROJEKT-PLANUNG =====
        case 'get_project_plan': {
          const result = await getProjectPlan(args?.project as string);
          return withOnboarding(result);
        }

        case 'update_project_plan': {
          const result = await updateProjectPlan(
            args?.project as string,
            {
              name: args?.name as string | undefined,
              description: args?.description as string | undefined,
              goals: args?.goals as string[] | undefined,
              architecture: args?.architecture as string | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'add_plan_task': {
          const result = await addPlanTask(
            args?.project as string,
            args?.title as string,
            args?.description as string,
            args?.priority as 'low' | 'medium' | 'high' | undefined
          );
          return withOnboarding(result);
        }

        // ===== GEDANKENAUSTAUSCH =====
        case 'add_thought': {
          const result = await addThought(
            args?.project as string,
            args?.source as string,
            args?.content as string,
            args?.tags as string[] | undefined
          );
          return withOnboarding(result);
        }

        case 'get_thoughts': {
          const result = await getThoughts(
            args?.project as string,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'search_thoughts': {
          const result = await searchThoughts(
            args?.query as string,
            args?.project as string,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'delete_thought': {
          const result = await deleteThought(
            args?.project as string,
            args?.id as string
          );
          return withOnboarding(result);
        }

        // ===== MEMORY =====
        case 'write_memory': {
          const result = await writeMemory(
            args?.project as string,
            args?.name as string,
            args?.content as string,
            args?.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined,
            args?.tags as string[] | undefined
          );
          return withOnboarding({ message: result });
        }

        case 'read_memory': {
          const result = await readMemory(
            args?.project as string,
            args?.name as string
          );
          return withOnboarding(result);
        }

        case 'list_memories': {
          const result = await listMemories(
            args?.project as string,
            args?.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined
          );
          return withOnboarding(result);
        }

        case 'search_memory': {
          const result = await searchMemory(
            args?.query as string,
            args?.project as string,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'delete_memory': {
          const result = await deleteMemory(
            args?.project as string,
            args?.name as string
          );
          return withOnboarding({ message: result });
        }

        case 'read_memory_with_code': {
          const result = await readMemoryWithCode(
            args?.project as string,
            args?.name as string,
            {
              codeLimit: args?.codeLimit as number | undefined,
              includeSemanticMatches: args?.includeSemanticMatches as boolean | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'find_memories_for_file': {
          const result = await findMemoriesForFile(
            args?.project as string,
            args?.filePath as string,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        // ===== TECH-DOCS =====
        case 'add_tech_doc': {
          const result = await addTechDocTool(
            args?.framework as string,
            args?.version as string,
            args?.section as string,
            args?.content as string,
            args?.type as 'feature' | 'breaking-change' | 'migration' | 'gotcha' | 'code-example' | 'best-practice' | 'known-issue' | 'community',
            args?.category as string | undefined,
            args?.source as string | undefined,
            args?.project as string | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'search_tech_docs': {
          const result = await searchTechDocsTool(
            args?.query as string,
            {
              framework: args?.framework as string | undefined,
              type: args?.type as string | undefined,
              source: args?.source as string | undefined,
              project: args?.project as string | undefined,
              limit: args?.limit as number | undefined,
              scope: args?.scope as 'global' | 'project' | 'all' | undefined,
            }
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_docs_for_file': {
          const result = await getDocsForFileTool(
            args?.file_path as string,
            args?.agent_id as string,
            args?.project as string
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== AGENTEN-CHAT =====
        case 'register_chat_agent': {
          const agentRegId = args?.id as string;
          const agentRegProjectPath = args?.project_path as string | undefined;
          const result = await registerChatAgent(
            agentRegId,
            args?.project as string,
            args?.model as string | undefined,
            args?.cutoff_date as string | undefined
          );
          // Chat-Read-Timestamp ab jetzt tracken
          lastChatRead.set(agentRegId, new Date().toISOString());
          // Specialist-System: Pruefen ob dieser Agent ein Spezialist ist
          const regEnriched: Record<string, unknown> = { ...result };
          if (agentRegProjectPath) {
            try {
              const specStatus = await readStatus(agentRegProjectPath);
              if (specStatus.specialists[agentRegId]) {
                regEnriched.specialistInfo = {
                  isSpecialist: true,
                  specialistStatus: specStatus.specialists[agentRegId].status,
                };
              }
            } catch { /* Specialist-Status nicht verfuegbar */ }
          }
          return { content: [{ type: 'text', text: JSON.stringify(regEnriched, null, 2) }] };
        }

        case 'unregister_chat_agent': {
          const result = await unregisterChatAgent(args?.id as string);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'register_chat_agents_batch': {
          const agentsList = args?.agents as Array<{ id: string; model?: string; cutoffDate?: string }>;
          const result = await registerChatAgentsBatch(agentsList, args?.project as string);
          const now = new Date().toISOString();
          for (const a of agentsList) lastChatRead.set(a.id, now);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'unregister_chat_agents_batch': {
          const result = await unregisterChatAgentsBatch(args?.ids as string[]);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'send_chat_message': {
          const senderId = args?.sender_id as string;
          const recipientId = args?.recipient_id as string | undefined;
          const content = args?.content as string;
          const project = args?.project as string;
          const sendProjectPath = args?.project_path as string | undefined;

          // Dual-path: Specialist-Routing wenn project_path angegeben
          if (sendProjectPath) {
            try {
              const specStatus = await readStatus(sendProjectPath);

              // Recipient ist ein Spezialist → direkt in die Inbox routen
              if (recipientId && specStatus.specialists[recipientId]) {
                const inboxResult = await postToInbox(senderId, recipientId, content);
                const target = `DM an ${recipientId}`;
                const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
                try {
                  await server.sendLoggingMessage({
                    level: 'info',
                    data: `📨 Chat [${senderId} → ${target}] (specialist-inbox): ${preview}`,
                  });
                } catch { /* Logging nicht verfuegbar */ }
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({ success: true, routed: 'specialist_inbox', ...inboxResult }, null, 2),
                  }],
                };
              }

              // Broadcast und Spezialisten laufen → auch in general-channel posten
              if (!recipientId) {
                const runningCount = Object.values(specStatus.specialists).filter(s => s.status === 'running').length;
                if (runningCount > 0) {
                  try {
                    await postMessage(`${project}-general`, senderId, content);
                  } catch { /* Channel existiert noch nicht */ }
                }
              }
            } catch { /* Specialist-Status nicht verfuegbar, legacy fallback */ }
          }

          // Legacy-Pfad (auch als Fallback wenn kein project_path)
          const result = await sendChatMessage(project, senderId, content, recipientId);

          // Broadcast-Notification an den Client: Neue Chat-Nachricht!
          if (result.success) {
            const target = recipientId ? `DM an ${recipientId}` : 'Broadcast';
            const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
            try {
              await server.sendLoggingMessage({
                level: 'info',
                data: `📨 Chat [${senderId} → ${target}]: ${preview}`,
              });
            } catch { /* Logging nicht verfuegbar */ }
          }

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_chat_messages': {
          const getMsgProjectPath = args?.project_path as string | undefined;
          const getMsgAgentId = args?.agent_id as string | undefined;
          const result = await getChatMessages(
            args?.project as string,
            {
              agentId: getMsgAgentId,
              since: args?.since as string | undefined,
              senderId: args?.sender_id as string | undefined,
              limit: args?.limit as number | undefined,
            }
          );
          // Timestamp aktualisieren — Agent hat Chat gelesen
          if (agentId) {
            lastChatRead.set(agentId, new Date().toISOString());
          }

          // Dual-path: Specialist-Inbox-Nachrichten anfuegen wenn project_path vorhanden
          if (getMsgProjectPath && getMsgAgentId) {
            try {
              const specStatus = await readStatus(getMsgProjectPath);
              if (Object.keys(specStatus.specialists).length > 0) {
                const inboxMessages = await checkInbox(getMsgAgentId);
                if (inboxMessages.length > 0) {
                  const inboxResult: Record<string, unknown> = {
                    ...(typeof result === 'object' && result !== null ? result : { messages: [] }),
                    specialistInbox: inboxMessages.map(m => ({
                      id: m.id,
                      from: m.fromAgent,
                      content: m.content,
                      createdAt: m.createdAt,
                    })),
                  };
                  return { content: [{ type: 'text', text: JSON.stringify(inboxResult, null, 2) }] };
                }
              }
            } catch { /* Specialist-Inbox nicht verfuegbar */ }
          }

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'list_chat_agents': {
          const listProjectPath = args?.project_path as string | undefined;
          const result = await listAgents(args?.project as string);

          // Dual-path: Spezialisten anfuegen wenn project_path vorhanden
          if (listProjectPath) {
            try {
              const specStatus = await readStatus(listProjectPath);
              const specialists = Object.entries(specStatus.specialists).map(([name, s]) => ({
                id: name,
                isSpecialist: true,
                status: s.status,
                model: s.model,
                currentTask: s.currentTask,
                lastActivity: s.lastActivity,
              }));
              if (specialists.length > 0) {
                const enrichedList: Record<string, unknown> = {
                  ...(typeof result === 'object' && result !== null ? result : {}),
                  specialists,
                };
                return { content: [{ type: 'text', text: JSON.stringify(enrichedList, null, 2) }] };
              }
            } catch { /* Specialist-Status nicht verfuegbar */ }
          }

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== AGENTEN-EVENTS =====
        case 'emit_event': {
          const result = await emitEventTool(
            args?.project as string,
            args?.event_type as string,
            args?.priority as string,
            (args?.scope as string | undefined) ?? 'all',
            args?.source_id as string,
            args?.payload as string | undefined,
            args?.requires_ack as boolean | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'acknowledge_event': {
          const result = await acknowledgeEventTool(
            args?.event_id as number,
            args?.agent_id as string,
            args?.reaction as string | undefined
          );
          // Eskalations-Counter zuruecksetzen bei erfolgreichem Ack
          if (result.success) {
            eventIgnoreCount.delete(args?.agent_id as string);
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_pending_events': {
          const result = await getPendingEventsTool(
            args?.project as string,
            args?.agent_id as string
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== PROJEKT-IDEEN =====
        case 'save_project_idea': {
          const result = await saveProjectIdea(
            args?.content as string,
            args?.project as string | undefined,
            args?.tags as string[] | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'confirm_idea': {
          const result = await confirmIdea(
            args?.temp_id as string,
            args?.custom_name as string | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== SCHATTENVORSCHLAEGE (PROPOSALS) =====
        case 'list_proposals': {
          const { project, status } = args as { project: string; status?: string };
          const result = await listProposalsWrapper(project, status);
          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          return withOnboarding(parsed);
        }

        case 'get_proposal': {
          const { project, id } = args as { project: string; id: string };
          const result = await getProposalWrapper(project, id);
          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          return withOnboarding(parsed);
        }

        case 'update_proposal_status': {
          const { project, id, status } = args as { project: string; id: string; status: string };
          const result = await updateProposalStatusWrapper(project, id, status);
          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          return withOnboarding(parsed);
        }

        case 'delete_proposal': {
          const { project, id } = args as { project: string; id: string };
          const result = await deleteProposalWrapper(project, id);
          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          return withOnboarding(parsed);
        }

        case 'search_proposals': {
          const { query, project, limit } = args as { query: string; project: string; limit?: number };
          const result = await searchProposalsWrapper(query, project, limit);
          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          return withOnboarding(parsed);
        }

        // ===== UPDATE-TOOLS (EDIT-LAYER) =====
        case 'update_memory': {
          const changes: { content?: string; category?: 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other'; tags?: string[] } = {};
          if (args?.content) changes.content = args.content as string;
          if (args?.category) changes.category = args.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other';
          if (args?.tags) changes.tags = args.tags as string[];
          const result = await updateMemoryTool(
            args?.project as string,
            args?.name as string,
            changes
          );
          return withOnboarding(result);
        }

        case 'update_thought': {
          const changes: { content?: string; tags?: string[] } = {};
          if (args?.content) changes.content = args.content as string;
          if (args?.tags) changes.tags = args.tags as string[];
          const result = await updateThoughtTool(
            args?.project as string,
            args?.id as string,
            changes
          );
          return withOnboarding(result);
        }

        case 'update_proposal': {
          const changes: { content?: string; suggestedContent?: string; status?: string } = {};
          if (args?.content) changes.content = args.content as string;
          if (args?.suggested_content) changes.suggestedContent = args.suggested_content as string;
          if (args?.status) changes.status = args.status as string;
          const result = await updateProposalTool(
            args?.project as string,
            args?.id as string,
            changes
          );
          return withOnboarding(result);
        }

        // ===== MIGRATION & BACKUP =====
        case 'migrate_embeddings': {
          const result = await migrateEmbeddings(
            args?.project as string,
            {
              collections: args?.collections as string[] | undefined,
              dryRun: args?.dry_run as boolean | undefined,
            }
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'restore_backup': {
          const result = await restoreFromBackup(
            (args?.type as 'thoughts' | 'memories' | 'plans' | 'proposals' | 'all') || 'all',
            args?.project as string
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== SPEZIALISTEN (AGENT-SPAWNING) =====
        case 'spawn_specialist': {
          return await spawnSpecialistTool(
            args?.name as string,
            args?.model as 'opus' | 'sonnet' | 'haiku' | 'opus[1m]' | 'sonnet[1m]',
            args?.expertise as string,
            args?.task as string,
            args?.project as string,
            args?.project_path as string,
            args?.cwd as string | undefined,
            args?.channel as string | undefined,
            args?.allowed_tools as string[] | undefined,
          );
        }

        case 'stop_specialist': {
          return await stopSpecialistTool(
            args?.name as string,
            args?.project_path as string,
          );
        }

        case 'specialist_status': {
          return await specialistStatusTool(
            args?.project_path as string,
            args?.name as string | undefined,
          );
        }

        case 'wake_specialist': {
          return await wakeSpecialistTool(
            args?.name as string,
            args?.message as string,
          );
        }

        case 'update_specialist_skill': {
          return await updateSpecialistSkillTool(
            args?.name as string,
            args?.project_path as string,
            args?.section as 'regeln' | 'fehler' | 'patterns',
            args?.action as 'add' | 'remove',
            args?.content as string,
          );
        }

        case 'get_agent_capabilities': {
          return getAgentCapabilitiesTool();
        }

        // ===== SPECIALIST-CHANNELS =====
        case 'create_channel': {
          return await createChannelTool(
            args?.name as string,
            args?.project as string,
            args?.description as string,
            args?.created_by as string,
          );
        }

        case 'join_channel': {
          return await joinChannelTool(
            args?.channel_name as string,
            args?.agent_name as string,
          );
        }

        case 'leave_channel': {
          return await leaveChannelTool(
            args?.channel_name as string,
            args?.agent_name as string,
          );
        }

        case 'post_to_channel': {
          return await postToChannelTool(
            args?.channel_name as string,
            args?.sender as string,
            args?.content as string,
          );
        }

        case 'get_channel_feed': {
          return await getChannelFeedTool(
            args?.channel_name as string,
            args?.limit as number | undefined,
            args?.since_id as number | undefined,
            args?.preview as boolean | undefined,
          );
        }

        case 'list_channels': {
          return await listChannelsTool(
            args?.project as string | undefined,
          );
        }

        // ===== SPECIALIST-INBOX =====
        case 'post_to_inbox': {
          return await postToInboxTool(
            args?.from_agent as string,
            args?.to_agent as string,
            args?.content as string,
          );
        }

        case 'check_inbox': {
          return await checkInboxTool(
            args?.agent_name as string,
          );
        }

        default:
          throw new Error(`Unbekanntes Tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Startet den MCP Server
 */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error('[Synapse MCP] Server gestartet (v0.2.0)');

  // Step 1: Ensure agents DB schema exists before any tools are used
  await ensureAgentsSchema();

  // Step 2: Reconnect to running specialists and clean up orphans for all known projects
  const cliInfo = detectClaudeCli();
  if (cliInfo.available) {
    for (const projectName of listActiveProjects()) {
      const projectPath = getProjectPath(projectName);
      if (!projectPath) continue;

      const orphans = await heartbeatController.cleanupOrphans(projectPath);
      if (orphans.length > 0) {
        console.error(`[Synapse] Cleaned up ${orphans.length} orphaned agent sockets for "${projectName}"`);
      }

      const reconnected = await heartbeatController.reconnectAll(projectPath);
      if (reconnected.connected.length > 0) {
        console.error(`[Synapse] Reconnected to ${reconnected.connected.length} running specialists for "${projectName}"`);
      }
      if (reconnected.cleaned.length > 0) {
        console.error(`[Synapse] Cleaned up ${reconnected.cleaned.length} stale specialist entries for "${projectName}"`);
      }
    }
  }
}
