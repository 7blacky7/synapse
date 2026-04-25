/**
 * Synapse API - MCP over HTTP Routes
 * Fuer Claude.ai Connectors (v0.2.0)
 *
 * 14 konsolidierte Action-basierte Tools — identisch zum MCP-Server.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  // Code-Suche
  searchCode,
  searchDocsWithFallback,
  listCollections,
  scrollVectors,
  COLLECTIONS,
  // Projekt
  detectTechnologies,
  indexProjectTechnologies,
  getProjectStats,
  getCollectionStats,
  // Plan
  getPlan,
  updatePlan,
  addTask,
  // Thought
  addThought,
  getThoughts,
  getThoughtsByIds,
  searchThoughts,
  deleteThought,
  updateThought,
  // Memory
  writeMemory,
  getMemoryByName,
  getMemoriesByNames,
  listMemories,
  searchMemories,
  deleteMemory,
  readMemoryWithRelatedCode,
  findMemoriesForPath,
  updateMemory,
  // Proposals
  getProposal,
  getProposalsByIds,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  deleteProposals,
  searchProposals,
  updateProposal,
  // Chat
  registerChatAgent,
  registerAgentsBatch,
  unregisterChatAgent,
  unregisterAgentsBatch,
  listActiveAgents,
  sendChatMessage,
  getChatMessages,
  // Events
  emitEvent,
  acknowledgeEvent,
  getPendingEvents,
  // Tech-Docs
  addTechDoc,
  searchTechDocs,
  getDocsForFile,
  // Code Intelligence
  getProjectTree,
  getFunctions,
  getVariables,
  getSymbols,
  getReferences,
  fullTextSearchCode,
  getFileContent,
  // Media
  indexMediaDirectory,
  searchMedia,
  // Files (Code-Write)
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  getFileContentFromPg,
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplace,
  // Channels
  createChannel,
  joinChannel,
  leaveChannel,
  postChannelMessage,
  getChannelMessages,
  listChannels,
  // Inbox
  postToInbox,
  checkInbox,
  // Shell-Queue
  enqueueShellJob,
  waitForShellJob,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
  // Error Patterns (code_check)
  addErrorPattern,
  listErrorPatterns,
  deleteErrorPattern,
} from '@synapse/core';
import { minimatch } from 'minimatch';
import { GUIDE_OVERVIEW, TOOL_GUIDES } from './guide-content.js';
import { randomUUID } from 'crypto';

/**
 * Ermittelt das richtige Protokoll (HTTPS hinter Reverse Proxy)
 */
function getBaseUrl(request: FastifyRequest): string {
  // X-Forwarded-Proto Header prüfen
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (forwardedProto) {
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return `${protocol}://${request.hostname}`;
  }

  // Fallback: HTTPS erzwingen für öffentliche Domains
  const hostname = request.hostname;
  if (hostname.includes('.') && !hostname.startsWith('localhost') && !hostname.startsWith('127.') && !hostname.startsWith('192.168.') && !hostname.startsWith('172.') && !hostname.startsWith('10.')) {
    return `https://${hostname}`;
  }

  return `${request.protocol}://${hostname}`;
}

// =====================================================================
// MCP Tool Definitionen — 14 konsolidierte Action-basierte Tools
// Schemas identisch zum MCP-Server (packages/mcp-server/src/tools/consolidated/)
// =====================================================================
const MCP_TOOLS = [
  // 1. project
  {
    name: 'project',
    description: 'Verwende fuer alle Projekt-Management-Operationen: init, setup, tech-Erkennung, cleanup, status und Listing',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'complete_setup', 'detect_tech', 'cleanup', 'stop', 'status', 'list'],
          description: 'Aktion: init | complete_setup | detect_tech | cleanup | stop | status | list',
        },
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (fuer init, detect_tech, cleanup, status)' },
        name: { type: 'string', description: 'Optionaler Projekt-Name (fuer init, cleanup) oder erforderlich fuer cleanup' },
        index_docs: { type: 'boolean', description: 'Framework-Dokumentation vorladen (Standard: true, fuer init)' },
        project: { type: 'string', description: 'Projekt-Name (fuer complete_setup, stop, list nutzt dies)' },
        phase: { type: 'string', enum: ['initial', 'post-indexing'], description: 'Setup-Phase (fuer complete_setup)' },
        agent_id: { type: 'string', description: 'Optionale Agent-ID fuer Onboarding (fuer init)' },
      },
      required: ['action'],
    },
  },
  // 2. search
  {
    name: 'search',
    description: 'Konsolidierte Such-Funktion mit action-Parameter fuer Code, Paths, Memory, Thoughts, Proposals, Tech-Docs und Media',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['code', 'path', 'code_with_path', 'memory', 'thoughts', 'proposals', 'tech_docs', 'media'],
          description: 'Such-Aktion: code|path|code_with_path|memory|thoughts|proposals|tech_docs|media',
        },
        query: { type: 'string', description: 'Suchanfrage (erforderlich fuer die meisten Actions)' },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
        limit: { type: 'number', description: 'Max. Ergebnisse (Standard: 10 oder 50)' },
        file_type: { type: 'string', description: 'Dateityp-Filter (fuer code, code_with_path)' },
        path_pattern: { type: 'string', description: 'Glob-Pattern fuer Pfad-Filter (fuer path, code_with_path)' },
        content_pattern: { type: 'string', description: 'Regex-Pattern fuer Content-Filter (fuer path)' },
        media_type: { type: 'string', enum: ['image', 'video'], description: 'Media-Typ-Filter (image|video, fuer media)' },
        framework: { type: 'string', description: 'Framework-Filter (fuer tech_docs)' },
        type: { type: 'string', description: 'Tech-Doc-Type-Filter (fuer tech_docs)' },
        source: { type: 'string', description: 'Source-Filter (fuer tech_docs)' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Suchbereich (project|global|all, fuer tech_docs)' },
        category: { type: 'string', description: 'Memory-Kategorie-Filter (fuer memory)' },
      },
      required: ['action'],
    },
  },
  // 3. memory
  {
    name: 'memory',
    description: 'Verwende fuer alle Memory-Operationen: write, read, read_with_code, list, delete, update und find_for_file',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'read_with_code', 'list', 'delete', 'update', 'find_for_file'],
          description: 'Aktion: write | read | read_with_code | list | delete | update | find_for_file',
        },
        project: { type: 'string', description: 'Projekt-Name (erforderlich fuer alle Aktionen)' },
        name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Memory-Name (erforderlich fuer read, read_with_code, delete, update). Array erlaubt fuer: read',
        },
        content: { type: 'string', description: 'Memory-Inhalt (erforderlich fuer write, optional fuer update)' },
        category: {
          type: 'string',
          enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
          description: 'Kategorie (optional fuer write, optional fuer update)',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags (optional fuer write, optional fuer update)' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding (optional)' },
        file_path: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Dateipfad (erforderlich fuer find_for_file). Array erlaubt fuer: find_for_file',
        },
        limit: { type: 'number', description: 'Max. Ergebnisse (optional, Standard: 10 fuer find_for_file)' },
        codeLimit: { type: 'number', description: 'Max. Code-Chunks (optional, Standard: 10 fuer read_with_code)' },
        includeSemanticMatches: { type: 'boolean', description: 'Semantische Matches einbeziehen (optional, Standard: true fuer read_with_code)' },
        dry_run: { type: 'boolean', description: 'Preview: Zeigt was geloescht wuerde ohne tatsaechlich zu loeschen (nur fuer delete mit Array)' },
        max_items: { type: 'number', description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)' },
      },
      required: ['action', 'project'],
    },
  },
  // 4. thought
  {
    name: 'thought',
    description: 'Gedankenaustausch zwischen KIs - speichern, abrufen, suchen, aktualisieren, loeschen',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'get', 'delete', 'update', 'search'],
          description: 'Aktion: add (speichern), get (abrufen), search (suchen), update (aktualisieren), delete (loeschen)',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.' },
        source: { type: 'string', description: 'Quelle (z.B. claude-code, gpt, user) - fuer action "add"' },
        content: { type: 'string', description: 'Inhalt des Gedankens - fuer action "add" oder "update"' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags - fuer action "add" oder "update"' },
        id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'ID des Gedankens - fuer action "get" (einzeln oder Array), "delete" oder "update"',
        },
        query: { type: 'string', description: 'Suchanfrage - fuer action "search"' },
        limit: { type: 'number', description: 'Maximale Anzahl Ergebnisse (Standard: 50 fuer get, 10 fuer search)' },
        dry_run: { type: 'boolean', description: 'Preview: Zeigt was geloescht wuerde ohne tatsaechlich zu loeschen (nur fuer delete mit Array)' },
        max_items: { type: 'number', description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)' },
      },
      required: ['action'],
    },
  },
  // 5. plan
  {
    name: 'plan',
    description: 'Verwaltet Projekt-Plaene: Abrufen, Aktualisieren, Tasks hinzufuegen',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'update', 'add_task'],
          description: 'Aktion: "get" zum Abrufen, "update" zum Aktualisieren, "add_task" um eine Task hinzuzufuegen',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.' },
        name: { type: 'string', description: 'Neuer Plan-Name' },
        description: { type: 'string', description: 'Neue Beschreibung' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Neue Ziele' },
        architecture: { type: 'string', description: 'Architektur-Beschreibung' },
        title: { type: 'string', description: 'Task-Titel' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Prioritaet (Standard: medium)' },
      },
      required: ['action', 'project'],
    },
  },
  // 6. proposal
  {
    name: 'proposal',
    description: 'Konsolidiertes Proposal-Management: list, get, update_status, delete, update',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'update_status', 'delete', 'update'],
          description: 'Aktion: list (Auflistung), get (Abrufen), update_status (Status aendern), delete (Loeschen), update (Aktualisieren)',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
        id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Proposal-ID (fuer get, update_status, delete, update). Array erlaubt fuer: get',
        },
        status: {
          type: 'string',
          enum: ['pending', 'reviewed', 'accepted', 'rejected'],
          description: 'Status (fuer list: Filter; fuer update_status: Neuer Status; fuer update: Optional)',
        },
        content: { type: 'string', description: 'Neue Beschreibung (fuer update)' },
        suggested_content: { type: 'string', description: 'Neuer vorgeschlagener Inhalt (fuer update)' },
        dry_run: { type: 'boolean', description: 'Preview: Zeigt was geloescht wuerde ohne tatsaechlich zu loeschen (nur fuer delete mit Array)' },
        max_items: { type: 'number', description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)' },
      },
      required: ['action', 'project'],
    },
  },
  // 7. chat
  {
    name: 'chat',
    description: 'Verwaltetes Chat-System fuer Agenten mit verschiedenen Aktionen: Registrierung, Messaging, Inbox-Handling',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'unregister', 'register_batch', 'unregister_batch', 'send', 'get', 'list', 'inbox_send', 'inbox_check'],
          description: 'Die auszufuehrende Aktion (register, unregister, register_batch, unregister_batch, send, get, list, inbox_send, inbox_check)',
        },
        id: { type: 'string', description: 'Agent-ID (fuer register, unregister)' },
        project: { type: 'string', description: 'Projekt-Name' },
        project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        model: { type: 'string', description: 'Modell-Name (z.B. claude-opus-4-6)' },
        cutoff_date: { type: 'string', description: 'Wissens-Cutoff (YYYY-MM-DD)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Liste der Agent-IDs (fuer unregister_batch)' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, model: { type: 'string' } },
            required: ['id'],
          },
          description: 'Liste der Agenten (fuer register_batch)',
        },
        sender_id: { type: 'string', description: 'Absender Agent-ID' },
        content: { type: 'string', description: 'Nachrichteninhalt' },
        recipient_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Empfaenger Agent-ID (optional, fuer DM). Array erlaubt fuer: send (Multicast)',
        },
        agent_id: { type: 'string', description: 'Eigene Agent-ID' },
        since: { type: 'string', description: 'ISO-Timestamp fuer Polling' },
        sender_id_filter: { type: 'string', description: 'Optional: Nur Nachrichten von diesem Absender' },
        limit: { type: 'number', description: 'Max. Nachrichten (Standard: 50)' },
        from_agent: { type: 'string', description: 'Absender Agent-Name' },
        to_agent: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Empfaenger Agent-Name. Array erlaubt fuer: inbox_send (Multicast)',
        },
        agent_name: { type: 'string', description: 'Agent-Name' },
      },
      required: ['action'],
    },
  },
  // 8. channel
  {
    name: 'channel',
    description: 'Verwaltet Channels fuer Spezialisten-Kommunikation (create, join, leave, post, feed, list)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'join', 'leave', 'post', 'feed', 'list'],
          description: 'Die auszufuehrende Aktion',
        },
        name: { type: 'string', description: 'Channel-Name (fuer create)' },
        project: { type: 'string', description: 'Projekt-Name (fuer create und list)' },
        description: { type: 'string', description: 'Beschreibung des Channels (fuer create)' },
        created_by: { type: 'string', description: 'Ersteller (Agent-Name, fuer create)' },
        channel_name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Channel-Name (fuer join, leave, post, feed). Array erlaubt fuer: join, leave',
        },
        agent_name: { type: 'string', description: 'Agent-Name (fuer join, leave)' },
        sender: { type: 'string', description: 'Absender (Agent-Name, fuer post)' },
        content: { type: 'string', description: 'Nachrichteninhalt (fuer post)' },
        limit: { type: 'number', description: 'Max. Nachrichten (Standard: 20, fuer feed)' },
        since_id: { type: 'number', description: 'Nur Nachrichten nach dieser ID (fuer feed)' },
        preview: { type: 'boolean', description: 'Inhalte auf 200 Zeichen kuerzen (fuer feed)' },
      },
      required: ['action'],
    },
  },
  // 9. event
  {
    name: 'event',
    description: 'Verwaltet Events fuer Agenten. Actions: emit (Sendet Event), ack (Bestaetigt Event), pending (Holt unbestaetigte Events).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['emit', 'ack', 'pending'],
          description: 'Action: "emit", "ack", oder "pending"',
        },
        project: { type: 'string', description: 'Projekt-Name (erforderlich fuer emit und pending)' },
        event_type: { type: 'string', description: 'Event-Typ fuer emit: WORK_STOP, CRITICAL_REVIEW, ARCH_DECISION, TEAM_DISCUSSION, ANNOUNCEMENT' },
        priority: { type: 'string', description: 'Prioritaet fuer emit: critical, high, normal' },
        scope: { type: 'string', description: 'Empfaenger fuer emit: "all" oder "agent:<id>" (Standard: "all")' },
        source_id: { type: 'string', description: 'Absender Agent-ID (erforderlich fuer emit)' },
        payload: { type: 'string', description: 'Optionaler JSON-Payload fuer emit' },
        requires_ack: { type: 'boolean', description: 'Ob Agenten quittieren muessen (Standard: true, nur fuer emit)' },
        event_id: {
          oneOf: [
            { type: 'number' },
            { type: 'array', items: { type: 'number' }, minItems: 1 },
          ],
          description: 'Event-ID (erforderlich fuer ack). Array erlaubt fuer Batch-Ack',
        },
        agent_id: { type: 'string', description: 'Eigene Agent-ID (erforderlich fuer ack und pending)' },
        reaction: { type: 'string', description: 'Optionale Reaktion/Kommentar (nur fuer ack)' },
      },
      required: ['action'],
    },
  },
  // 10. specialist
  {
    name: 'specialist',
    description: 'Konsolidiertes Tool fuer Spezialisten-Management. Unterstuetzt Spawning, Stopping, Status-Checks, Wake-Calls, Skill-Updates und Capabilities-Checks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'stop', 'status', 'wake', 'update_skill', 'capabilities'],
          description: 'Die auszufuehrende Aktion',
        },
        name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Name des Spezialisten (erforderlich fuer: spawn, stop, status, wake, update_skill). Array erlaubt fuer: status',
        },
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'], description: 'Claude Modell (erforderlich fuer: spawn). MODELLE: opus/sonnet/haiku = 200k Context. opus[1m]/sonnet[1m] = 1M Context (fuer langlaufende Code-Arbeit ohne Handoff-Risiko). ⚠️ ABO-LIMIT: Nur EIN Modell-Typ darf gleichzeitig auf 1M laufen — Koordinator opus[1m] + Spezialisten opus[1m] OK, aber NIEMALS sonnet[1m] dazu mischen (rate-limit-Block).' },
        expertise: { type: 'string', description: 'Fachgebiet des Spezialisten (erforderlich fuer: spawn)' },
        task: { type: 'string', description: 'Aufgabe fuer den Spezialisten (erforderlich fuer: spawn)' },
        project: { type: 'string', description: 'Projekt-Name (erforderlich fuer: spawn)' },
        project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (erforderlich fuer: spawn, stop, status, update_skill)' },
        cwd: { type: 'string', description: 'Arbeitsverzeichnis (optional fuer: spawn, Standard: Projekt-Pfad)' },
        channel: { type: 'string', description: 'Channel fuer Kommunikation (optional fuer: spawn, Standard: {project}-general)' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Erlaubte Tools fuer den Spezialisten (optional fuer: spawn)' },
        keep_alive: { type: 'boolean', description: '⚠️ WICHTIG: keep_alive: true setzen fuer langlaufende Spezialisten. Aktiviert (a) periodisches Wecken im Idle UND (b) Auto-Respawn bei Crash (Context-Limit, OOM). Ohne keep_alive stirbt der Wrapper mit dem Agenten — kein Comeback, manueller Spawn noetig. Standard: false (nur fuer kurze One-Shot-Tasks).' },
        message: { type: 'string', description: 'Nachricht an den Spezialisten (erforderlich fuer: wake)' },
        section: { type: 'string', enum: ['regeln', 'fehler', 'patterns'], description: 'Abschnitt der SKILL.md (legacy, optional fuer: update_skill). Alternative: file' },
        file: { type: 'string', enum: ['rules', 'errors', 'patterns', 'context'], description: 'Ziel-Datei (neu, optional fuer: update_skill). Alternative zu section (legacy).' },
        skill_action: { type: 'string', enum: ['add', 'remove'], description: 'Hinzufuegen oder entfernen (erforderlich fuer: update_skill)' },
        content: { type: 'string', description: 'Inhalt des Eintrags (erforderlich fuer: update_skill)' },
      },
      required: ['action'],
    },
  },
  // 11. docs
  {
    name: 'docs',
    description: 'Konsolidiertes MCP-Tool fuer Tech-Docs: Indexieren, Suchen, Wissens-Airbag',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'search', 'get_for_file'],
          description: 'Aktion: add (Indexieren), search (Suchen), get_for_file (Wissens-Airbag)',
        },
        framework: { type: 'string', description: 'Framework/Sprache (z.B. react, python, express)' },
        version: { type: 'string', description: 'Version (z.B. 19.0, 3.12)' },
        section: { type: 'string', description: 'Abschnitt (z.B. hooks, routing, breaking-changes)' },
        content: { type: 'string', description: 'Inhalt des Docs' },
        type: {
          type: 'string',
          enum: ['feature', 'breaking-change', 'migration', 'gotcha', 'code-example', 'best-practice', 'known-issue', 'community'],
          description: 'Chunk-Type',
        },
        category: { type: 'string', enum: ['framework', 'language'], description: 'framework oder language (Standard: framework)' },
        source: { type: 'string', enum: ['research', 'context7', 'manual'], description: 'Quelle (Standard: research)' },
        query: { type: 'string', description: 'Suchanfrage' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Suchbereich: project (nur Projekt-Collection), global (nur globale), all (beide)' },
        file_path: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Dateipfad (z.B. src/api.ts). Array erlaubt fuer get_for_file (Multi-File-Analyse)',
        },
        agent_id: { type: 'string', description: 'Agent-ID fuer Cutoff-Ermittlung' },
        project: { type: 'string', description: 'Projekt-Name (optional)' },
      },
      required: ['action'],
    },
  },
  // 12. admin
  {
    name: 'admin',
    description: 'Konsolidiertes Admin/Utility-Tool mit verschiedenen Actions fuer Projekt-Management, Statistiken, Ideen und Media-Indexierung',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['migrate', 'restore', 'save_idea', 'confirm_idea', 'index_media', 'index_stats', 'detailed_stats'],
          description: 'Die auszufuehrende Admin-Action',
        },
        project: { type: 'string', description: 'Projekt-Name (erforderlich fuer alle Actions ausser confirm_idea)' },
        collections: { type: 'array', items: { type: 'string' }, description: 'Optional fuer migrate: Nur bestimmte Collections migrieren' },
        dry_run: { type: 'boolean', description: 'Optional fuer migrate: Nur pruefen ohne zu migrieren (Standard: false)' },
        backup_type: {
          type: 'string',
          enum: ['thoughts', 'memories', 'plans', 'proposals', 'all'],
          description: 'Optional fuer restore: Was wiederherstellen (Standard: all)',
        },
        title: { type: 'string', description: 'Erforderlich fuer save_idea: Titel der Idee' },
        description: { type: 'string', description: 'Erforderlich fuer save_idea: Beschreibung der Idee' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional fuer save_idea: Tags fuer die Idee' },
        idea_id: { type: 'string', description: 'Erforderlich fuer confirm_idea: ID der zu bestaetigenden Idee' },
        custom_name: { type: 'string', description: 'Optional fuer confirm_idea: Eigener Name statt des vorgeschlagenen' },
        path: { type: 'string', description: 'Erforderlich fuer index_media: Absoluter Pfad zu Datei oder Verzeichnis' },
        recursive: { type: 'boolean', description: 'Optional fuer index_media: Rekursiv durchsuchen (Standard: true)' },
        agent_id: { type: 'string', description: 'Optional fuer index_media/index_stats/detailed_stats: Agent-ID fuer Onboarding' },
        role: {
          type: 'string',
          enum: ['koordinator', 'spezialist', 'subagent'],
          description: 'Agenten-Rolle fuer rollenspezifisches Onboarding (optional, Fallback: Erkennung ueber agent_id)',
        },
      },
      required: ['action'],
    },
  },
  // 13. watcher
  {
    name: 'watcher',
    description: 'FileWatcher-Daemon steuern: status (laeuft er?), start (starten falls nicht aktiv), stop (stoppen)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop'],
          description: 'status: Daemon-Status pruefen. start: Daemon starten (wenn nicht aktiv). stop: Daemon stoppen.',
        },
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        name: { type: 'string', description: 'Projekt-Name (nur bei start noetig)' },
      },
      required: ['action', 'path'],
    },
  },
  // 14. code_intel
  {
    name: 'code_intel',
    description: 'Strukturierte Code-Abfragen aus PostgreSQL: Dateibaum, Funktionen, Variablen, Symbole, Referenzen, Volltext-Suche und Dateiinhalt.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tree', 'functions', 'variables', 'symbols', 'references', 'search', 'file'],
          description: 'Aktion: tree|functions|variables|symbols|references|search|file',
        },
        project: { type: 'string', description: 'Projekt-Name (erforderlich)' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
        path: { type: 'string', description: 'Verzeichnis-Pfad-Prefix zum Filtern (fuer tree und file)' },
        recursive: { type: 'boolean', description: 'Unterverzeichnisse einschliessen (Standard: true, fuer tree). false = nur Dateien direkt im Verzeichnis.' },
        depth: { type: 'number', description: 'Max. Verzeichnis-Tiefe relativ zum path (0 = nur das Verzeichnis, 1 = +1 Ebene, fuer tree)' },
        show_lines: { type: 'boolean', description: 'Zeilenzahl pro Datei anzeigen (Standard: true, fuer tree)' },
        show_counts: { type: 'boolean', description: 'Funktions-/Variablen-Counts anzeigen (Standard: true, fuer tree)' },
        show_comments: { type: 'boolean', description: 'Kommentare unter Dateien anzeigen (Standard: false, fuer tree)' },
        show_functions: { type: 'boolean', description: 'Funktionsnamen auflisten (Standard: false, fuer tree)' },
        show_imports: { type: 'boolean', description: 'Import-Statements auflisten (Standard: false, fuer tree)' },
        file_path: { type: 'string', description: 'Datei-Pfad-Filter (LIKE-Pattern, fuer functions/variables/symbols/file)' },
        name: { type: 'string', description: 'Symbol-Name-Filter (fuer functions/variables/symbols/references)' },
        exported_only: { type: 'boolean', description: 'Nur exportierte Funktionen zurueckgeben (fuer functions)' },
        with_values: { type: 'boolean', description: 'Wert-Spalte einschliessen (fuer variables)' },
        symbol_type: {
          type: 'string',
          enum: ['function', 'variable', 'string', 'comment', 'import', 'export', 'class', 'interface', 'enum', 'const_object', 'todo'],
          description: 'Symbol-Typ fuer symbols-Action',
        },
        query: { type: 'string', description: 'Suchbegriff fuer search-Action (Volltext)' },
        file_type: { type: 'string', description: 'Dateityp-Filter fuer search-Action (z.B. "ts", "js")' },
        limit: { type: 'number', description: 'Max. Ergebnisse fuer search-Action (Standard: 20)' },
      },
      required: ['action', 'project'],
    },
  },

  // 15. files
  {
    name: 'files',
    description: 'Datei-CRUD in PostgreSQL: Erstellen, Aktualisieren, Loeschen, Verschieben, Kopieren. Aenderungen werden vom FileWatcher automatisch auf das lokale Dateisystem synchronisiert.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'move', 'copy', 'read', 'replace_lines', 'insert_after', 'delete_lines', 'search_replace'],
          description: 'Datei-Aktion',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        file_path: { type: 'string', description: 'Dateipfad (relativ zum Projekt-Root)' },
        content: { type: 'string', description: 'Dateiinhalt (fuer create, update, replace_lines, insert_after)' },
        new_path: { type: 'string', description: 'Neuer Pfad (fuer move, copy)' },
        line_start: { type: 'number', description: 'Start-Zeile (fuer replace_lines, delete_lines)' },
        line_end: { type: 'number', description: 'End-Zeile (fuer replace_lines, delete_lines)' },
        after_line: { type: 'number', description: 'Nach dieser Zeile einfuegen (fuer insert_after)' },
        search: { type: 'string', description: 'Suchtext (fuer search_replace)' },
        replace: { type: 'string', description: 'Ersetzungstext (fuer search_replace)' },
      },
      required: ['action', 'project', 'file_path'],
    },
  },
  // 16. shell
  {
    name: 'shell',
    description: 'Projekt-scoped Shell-Ausfuehrung via Queue (REST-API → PostgreSQL → FileWatcher-Daemon). Command wird lokal auf dem Projekt-PC ausgefuehrt, solange der Daemon laeuft.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['exec', 'get_stream', 'history', 'get', 'log'], description: 'Default: exec. log + id liefert Zeilenrange (1-100); log + id + query liefert Such-Treffer mit Zeilennummern.' },
        id: { type: 'string', description: 'Job-UUID (Pflicht fuer get/log)' },
        limit: { type: 'number', description: 'history: max Jobs (Default 20, Max 200)' },
        offset: { type: 'number', description: 'history: Skip N (Default 0)' },
        status: { type: 'string', enum: ['pending', 'running', 'done', 'failed', 'rejected', 'timeout'], description: 'history: Filter auf Status' },
        from_line: { type: 'number', description: 'log: ab Zeile N (1-basiert)' },
        to_line: { type: 'number', description: 'log: bis Zeile M inkl.' },
        query: { type: 'string', description: 'log: Such-Pattern (Substring oder Regex)' },
        regex: { type: 'boolean', description: 'log: query als Regex (Default false)' },
        case_sensitive: { type: 'boolean', description: 'log: case-sensitive (Default false)' },
        max_matches: { type: 'number', description: 'log: max Treffer (Default 200, Max 2000)' },
        project: { type: 'string', description: 'Projekt-Name (Pflicht fuer exec)' },
        command: { type: 'string', description: 'Shell-Kommando (Pflicht fuer exec)' },
        stream_id: { type: 'string', description: 'Pflicht fuer get_stream (noch nicht implementiert via REST)' },
        timeout_ms: { type: 'number', description: 'Default 30000' },
        tail_lines: { type: 'number', description: 'Default 5' },
        cwd_relative: { type: 'string', description: 'Unterpfad innerhalb des Projekt-Roots' },
      },
      required: ['action'],
    },
  },
  // 17. code_check
  {
    name: 'code_check',
    description: 'Fehler-Pattern-System: Bekannte Fehler speichern und verwalten. Patterns werden automatisch bei Write-Operationen geprueft.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add_pattern', 'list_patterns', 'delete_pattern'], description: 'Action' },
        description: { type: 'string', description: 'Erforderlich fuer add_pattern: Was ist der Fehler' },
        fix: { type: 'string', description: 'Erforderlich fuer add_pattern: Wie sieht der Fix aus' },
        severity: { type: 'string', enum: ['error', 'warning', 'info'], description: 'Optional fuer add_pattern (Standard: warning)' },
        found_in_model: { type: 'string', description: 'Erforderlich fuer add_pattern: Modell' },
        found_by: { type: 'string', description: 'Erforderlich fuer add_pattern: Agent-ID' },
        model_scope: { type: 'string', description: 'Optional fuer list_patterns' },
        id: { type: 'string', description: 'Erforderlich fuer delete_pattern' },
        limit: { type: 'number', description: 'Optional fuer list_patterns (Standard: 20)' },
        agent_id: { type: 'string', description: 'Agent-ID' },
      },
      required: ['action'],
    },
  },
  // 18. guide — Web-KI-Onboarding + Tool-Dokumentation (nur REST-API)
  {
    name: 'guide',
    description: 'Zeigt Quick-Start fuer Web-KIs + detaillierte Nutzungs-Anleitung fuer alle Tools. Ohne Parameter: Uebersicht. Mit tool_name: Deep-Dive. Mit tool_name + action_name: Action-Details. Dieses Tool ist nur via REST-API verfuegbar und verbraucht KEINEN Kontext auf lokalen MCP-Sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Name des Tools fuer Detail-Doku (z.B. "code_intel", "shell", "files"). Weglassen fuer Uebersicht.' },
        action_name: { type: 'string', description: 'Optional: Spezifische Action innerhalb eines Multi-Action-Tools (z.B. "tree" bei code_intel).' },
      },
    },
  },
];

interface PendingIdea {
  content: string;
  project: string;
  suggestedName: string;
  tags: string[];
  createdAt: Date;
}

const pendingIdeas = new Map<string, PendingIdea>();

// Cleanup alte Ideen nach 30 Minuten
setInterval(() => {
  const now = Date.now();
  for (const [id, idea] of pendingIdeas.entries()) {
    if (now - idea.createdAt.getTime() > 30 * 60 * 1000) {
      pendingIdeas.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Generiert einen eindeutigen Namen aus dem Content
 */
function generateIdeaName(content: string): string {
  const stopwords = new Set([
    'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'fuer', 'mit', 'von', 'zu', 'auf',
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'on', 'in', 'is', 'are', 'be',
    'that', 'this', 'it', 'as', 'at', 'by', 'from', 'into', 'of', 'about', 'should',
    'could', 'would', 'will', 'can', 'may', 'might', 'must', 'shall', 'need', 'want',
    'ich', 'du', 'wir', 'sie', 'er', 'es', 'man', 'kann', 'soll', 'will', 'wird',
  ]);

  const words = content
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u00E4\u00F6\u00FC\u00C4\u00D6\u00DC\u00DF\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  const keywords = words.slice(0, 3);
  const date = new Date().toISOString().split('T')[0];
  const namePart = keywords.length > 0 ? keywords.join('-') : 'idea';
  return `idea-${namePart}-${date}`;
}

/**
 * Generiert eine kurze Vorschau des Contents
 */
function generatePreview(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.substring(0, maxLength).trim() + '...';
}

/**
 * Generiert eine eindeutige temporäre ID
 */
function generateTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// SSE Verbindungen speichern
const sseConnections = new Map<string, FastifyReply>();

/**
 * Sendet SSE Nachricht
 */
function sendSSEMessage(reply: FastifyReply, message: object): void {
  const data = JSON.stringify(message);
  reply.raw.write(`data: ${data}\n\n`);
}

// =====================================================================
// Hilfsfunktionen fuer Argument-Zugriff
//
// Hintergrund: Web-KI-Connectors (ChatGPT, Claude.ai) serialisieren
// JSON-Bodies nicht immer mit nativer Type-Erhaltung — Arrays kommen
// teilweise als JSON-Strings ("[\"a\",\"b\"]"), Booleans als "true"/
// "false"-Strings, Numbers als "42"-Strings durch. Wenn der Server
// diese 1:1 weiterreicht, wirft PG malformed-array-literal Fehler
// und der gesamte Request hangt 30s im Cloudflare-Timeout.
//
// Loesung: Defensive Coercion — die Helpers akzeptieren beide Formen
// und normalisieren auf die TypeScript-Typen.
// =====================================================================
function str(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' ? v : undefined;
}
function reqStr(a: Record<string, unknown>, k: string): string {
  const v = str(a, k);
  if (!v) throw new Error(`Parameter "${k}" ist erforderlich`);
  return v;
}
function num(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function bool(a: Record<string, unknown>, k: string): boolean | undefined {
  const v = a[k];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

/**
 * Liest ein String-Array aus den Args. Akzeptiert:
 *   - natives Array (string[]), filtert non-strings raus
 *   - JSON-String "[\"a\",\"b\"]" (Connector-Quirk)
 *   - einzelner String "a"  → ["a"]  (Convenience, wenn Caller statt Array
 *     einen einzelnen Wert sendet)
 * Returnt undefined wenn der Wert fehlt oder leer/unparseabar ist.
 */
function strArray(a: Record<string, unknown>, k: string): string[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === 'string');
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const out = parsed.filter((x): x is string => typeof x === 'string');
          return out.length > 0 ? out : undefined;
        }
      } catch { /* fall through to single-string */ }
    }
    return [trimmed];
  }
  return undefined;
}

/**
 * Wie strArray, aber returnt [] statt undefined wenn nichts da ist.
 * Fuer Felder wo der Service ein Array erwartet (statt undefined).
 */
function strArrayOrEmpty(a: Record<string, unknown>, k: string): string[] {
  return strArray(a, k) ?? [];
}

/**
 * Liest ein Array von Objekten — gleiche Coercion-Regeln wie strArray
 * (Array, JSON-String, Single-Object). Optional mit Validator.
 */
function objArray<T extends Record<string, unknown>>(
  a: Record<string, unknown>,
  k: string,
): T[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.filter((x): x is T => typeof x === 'object' && x !== null && !Array.isArray(x));
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const out = parsed.filter((x): x is T => typeof x === 'object' && x !== null && !Array.isArray(x));
        return out.length > 0 ? out : undefined;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return [parsed as T];
      }
    } catch { /* fall through */ }
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return [v as T];
  }
  return undefined;
}

// =====================================================================
// handleToolCall — Kompakter Dispatcher fuer 14 konsolidierte Tools
// =====================================================================
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const action = str(args, 'action');

  switch (name) {
    // =================================================================
    // 1. PROJECT
    // =================================================================
    case 'project': {
      switch (action) {
        case 'init': {
          const projectPath = reqStr(args, 'path');
          const projectName = str(args, 'name') || projectPath.split(/[/\\]/).pop() || 'unknown';
          const indexDocs = bool(args, 'index_docs') !== false;

          let techs: Awaited<ReturnType<typeof detectTechnologies>> = [];
          let docsIndexed = 0;

          if (indexDocs) {
            techs = await detectTechnologies(projectPath);
            const result = await indexProjectTechnologies(techs);
            docsIndexed = result.indexed;
          }

          return {
            success: true,
            project: projectName,
            path: projectPath,
            technologies: techs,
            docsIndexed,
            message: `Projekt "${projectName}" - Docs indexiert (FileWatcher nicht verfuegbar ueber HTTP)`,
          };
        }
        case 'complete_setup':
          return { success: false, error: 'Action "complete_setup" ist nur ueber MCP Server (stdio) verfuegbar' };
        case 'detect_tech': {
          const techs = await detectTechnologies(reqStr(args, 'path'));
          return { technologies: techs };
        }
        case 'cleanup':
          return { success: false, error: 'Action "cleanup" ist nur ueber MCP Server (stdio) verfuegbar — FileWatcher benoetigt' };
        case 'stop':
          return { success: false, error: 'Action "stop" ist nur ueber MCP Server (stdio) verfuegbar — FileWatcher benoetigt' };
        case 'status': {
          const project = reqStr(args, 'path');
          const codeStats = await getProjectStats(project.split(/[/\\]/).pop() || project);
          return { success: true, stats: codeStats };
        }
        case 'list': {
          const collections = await listCollections();
          const projects = collections
            .filter(c => c.startsWith('project_'))
            .map(c => c.replace('project_', ''));
          return { success: true, count: projects.length, projects };
        }
        default:
          return { success: false, error: `Unbekannte project action: "${action}"` };
      }
    }

    // =================================================================
    // 2. SEARCH
    // =================================================================
    case 'search': {
      switch (action) {
        case 'code': {
          const results = await searchCode(
            reqStr(args, 'query'),
            reqStr(args, 'project'),
            str(args, 'file_type'),
            num(args, 'limit') ?? 10
          );
          return results.map(r => ({
            filePath: r.payload.file_path,
            fileName: r.payload.file_name,
            fileType: r.payload.file_type,
            lineStart: r.payload.line_start,
            lineEnd: r.payload.line_end,
            score: r.score,
            content: r.payload.content,
          }));
        }
        case 'path': {
          const project = reqStr(args, 'project');
          const pathPattern = reqStr(args, 'path_pattern');
          const contentPattern = str(args, 'content_pattern');
          const limit = num(args, 'limit') ?? 50;
          const collectionName = COLLECTIONS.projectCode(project);

          const allPoints = await scrollVectors<{
            file_path: string; file_name: string; file_type: string;
            line_start: number; line_end: number; content: string;
          }>(collectionName, {}, 10000);

          let matches = allPoints.filter(point => {
            const fp = point.payload?.file_path || '';
            return minimatch(fp.replace(/\\/g, '/'), pathPattern, { matchBase: true });
          });
          if (contentPattern) {
            let regex: RegExp;
            try {
              regex = new RegExp(contentPattern, 'i');
            } catch {
              return { success: false, error: `Ungueltiges Regex-Pattern: ${contentPattern}` };
            }
            matches = matches.filter(p => regex.test(p.payload?.content || ''));
          }
          const totalMatches = matches.length;
          return {
            success: true,
            results: matches.slice(0, limit).map(p => ({
              filePath: p.payload.file_path, fileName: p.payload.file_name,
              fileType: p.payload.file_type, lineStart: p.payload.line_start,
              lineEnd: p.payload.line_end, content: p.payload.content,
            })),
            totalMatches,
            message: totalMatches > limit
              ? `${limit} von ${totalMatches} Treffern angezeigt`
              : `${totalMatches} Treffer gefunden`,
          };
        }
        case 'code_with_path': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const pathPattern = str(args, 'path_pattern');
          const fileType = str(args, 'file_type');
          const limit = num(args, 'limit') ?? 10;

          if (!pathPattern) {
            const results = await searchCode(query, project, fileType, limit);
            return {
              success: true,
              results: results.map(r => ({
                filePath: r.payload.file_path, fileName: r.payload.file_name,
                fileType: r.payload.file_type, lineStart: r.payload.line_start,
                lineEnd: r.payload.line_end, score: r.score, content: r.payload.content,
              })),
              message: `${results.length} Ergebnisse gefunden`,
            };
          }
          const results = await searchCode(query, project, fileType, limit * 5);
          const filtered = results.filter(r =>
            minimatch(r.payload.file_path.replace(/\\/g, '/'), pathPattern, { matchBase: true })
          );
          return {
            success: true,
            results: filtered.slice(0, limit).map(r => ({
              filePath: r.payload.file_path, fileName: r.payload.file_name,
              fileType: r.payload.file_type, lineStart: r.payload.line_start,
              lineEnd: r.payload.line_end, score: r.score, content: r.payload.content,
            })),
            message: `${filtered.length} Ergebnisse fuer Pattern "${pathPattern}"`,
          };
        }
        case 'memory': {
          const results = await searchMemories(
            reqStr(args, 'query'),
            reqStr(args, 'project'),
            num(args, 'limit') ?? 10
          );
          return {
            results: results.map(r => ({
              name: r.payload.name, category: r.payload.category, score: r.score,
              preview: r.payload.content.substring(0, 200) + (r.payload.content.length > 200 ? '...' : ''),
            })),
          };
        }
        case 'thoughts': {
          return await searchThoughts(
            reqStr(args, 'query'),
            str(args, 'project') ?? '',
            num(args, 'limit') ?? 10
          );
        }
        case 'proposals': {
          const results = await searchProposals(
            reqStr(args, 'query'),
            str(args, 'project') ?? '',
            num(args, 'limit') ?? 10
          );
          return {
            success: true,
            results: results.map(r => ({
              id: r.id, filePath: r.payload.file_path, description: r.payload.description,
              author: r.payload.author, status: r.payload.status, tags: r.payload.tags, score: r.score,
            })),
            message: `${results.length} Proposals gefunden`,
          };
        }
        case 'tech_docs': {
          const query = reqStr(args, 'query');
          const results = await searchTechDocs(query, {
            framework: str(args, 'framework'),
            type: str(args, 'type'),
            source: str(args, 'source'),
            project: str(args, 'project'),
            limit: num(args, 'limit'),
            scope: str(args, 'scope') as 'global' | 'project' | 'all' | undefined,
          });
          return { success: true, results, message: `${results.length} Tech-Docs gefunden` };
        }
        case 'media': {
          const results = await searchMedia(
            reqStr(args, 'query'),
            reqStr(args, 'project'),
            str(args, 'media_type') as 'image' | 'video' | undefined,
            num(args, 'limit')
          );
          return { success: true, results };
        }
        default:
          return { success: false, error: `Unbekannte search action: "${action}"` };
      }
    }

    // =================================================================
    // 3. MEMORY
    // =================================================================
    case 'memory': {
      const project = reqStr(args, 'project');
      switch (action) {
        case 'write': {
          const memName = reqStr(args, 'name');
          const content = reqStr(args, 'content');
          const category = str(args, 'category') as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined;
          const tags = strArray(args, 'tags');
          const existing = await getMemoryByName(project, memName);
          const memory = await writeMemory(project, memName, content, category, tags);
          return {
            success: true,
            memory: { name: memory.name, category: memory.category, sizeChars: memory.content.length },
            isUpdate: !!existing,
            message: existing ? `Memory "${memory.name}" aktualisiert` : `Memory "${memory.name}" erstellt`,
          };
        }
        case 'read': {
          const names = strArray(args, 'name');
          if (names && names.length > 1) {
            const results = await getMemoriesByNames(project, names);
            return { success: true, memories: results, count: results.length };
          }
          const memName = reqStr(args, 'name');
          const memory = await getMemoryByName(project, memName);
          if (!memory) return { success: false, message: `Memory "${memName}" nicht gefunden` };
          return { success: true, memory };
        }
        case 'read_with_code': {
          const result = await readMemoryWithRelatedCode(project, reqStr(args, 'name'), {
            codeLimit: num(args, 'codeLimit'),
            includeSemanticMatches: bool(args, 'includeSemanticMatches'),
          });
          if (!result) return { success: false, message: `Memory "${args.name}" nicht gefunden` };
          return { success: true, ...result };
        }
        case 'list': {
          const category = str(args, 'category') as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined;
          const memories = await listMemories(project, category);
          return {
            memories: memories.map(m => ({
              name: m.name, category: m.category, tags: m.tags,
              sizeChars: m.content.length, updatedAt: m.updatedAt,
            })),
          };
        }
        case 'delete': {
          const names = strArray(args, 'name');
          if (names && names.length > 1) {
            const dryRun = bool(args, 'dry_run') ?? false;
            const maxItems = num(args, 'max_items') ?? 10;
            if (names.length > maxItems) {
              return { success: false, message: `Batch-Delete: Max ${maxItems} Items erlaubt, ${names.length} angegeben` };
            }
            if (dryRun) {
              return { success: true, dry_run: true, would_delete: names, count: names.length };
            }
            const results = await Promise.allSettled(names.map(n => deleteMemory(project, n)));
            const deleted = results.filter(r => r.status === 'fulfilled').length;
            return { success: true, deleted, total: names.length };
          }
          const deleted = await deleteMemory(project, reqStr(args, 'name'));
          return { success: deleted.success, message: deleted.success ? `Memory "${args.name}" geloescht` : `Memory "${args.name}" nicht gefunden`, warning: deleted.warning };
        }
        case 'update': {
          const memName = reqStr(args, 'name');
          const changes: { content?: string; category?: 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other'; tags?: string[] } = {};
          const newContent = str(args, 'content');
          if (newContent !== undefined) changes.content = newContent;
          const newCategory = str(args, 'category');
          if (newCategory !== undefined) changes.category = newCategory as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other';
          const newTags = strArray(args, 'tags');
          if (newTags !== undefined) changes.tags = newTags;
          const result = await updateMemory(project, memName, changes);
          return result;
        }
        case 'find_for_file': {
          const filePaths = strArray(args, 'file_path');
          if (filePaths && filePaths.length > 1) {
            const settled = await Promise.allSettled(filePaths.map(fp => findMemoriesForPath(project, fp)));
            const results: unknown[] = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors };
          }
          const filePath = reqStr(args, 'file_path');
          const limit = num(args, 'limit') ?? 10;
          const results = await findMemoriesForPath(project, filePath, limit);
          return {
            success: true,
            results: results.map(r => ({
              name: r.memory.name, category: r.memory.category, matchType: r.matchType, score: r.score,
              preview: r.memory.content.substring(0, 200) + (r.memory.content.length > 200 ? '...' : ''),
            })),
            message: `${results.length} Memories fuer "${filePath}" gefunden`,
          };
        }
        default:
          return { success: false, error: `Unbekannte memory action: "${action}"` };
      }
    }

    // =================================================================
    // 4. THOUGHT
    // =================================================================
    case 'thought': {
      switch (action) {
        case 'add': {
          return await addThought(
            reqStr(args, 'project'), reqStr(args, 'source'),
            reqStr(args, 'content'), strArrayOrEmpty(args, 'tags')
          );
        }
        case 'get': {
          const project = reqStr(args, 'project');
          if (args.id !== undefined) {
            const ids = strArray(args, 'id');
            const isBatch = Array.isArray(args.id);
            if (!ids || ids.length === 0) {
              return { success: false, thought: null, message: 'id ist erforderlich' };
            }
            const result = await getThoughtsByIds(project, ids);
            if (!isBatch) {
              return result.length > 0
                ? { success: true, thought: result[0], message: '1 Gedanke geladen' }
                : { success: false, thought: null, message: `Gedanke "${args.id}" nicht gefunden` };
            }
            return { success: true, thoughts: result, count: result.length };
          }
          const thoughts = await getThoughts(project, num(args, 'limit') ?? 50);
          return { thoughts };
        }
        case 'search': {
          return await searchThoughts(
            reqStr(args, 'query'),
            str(args, 'project') ?? '',
            num(args, 'limit') ?? 10
          );
        }
        case 'delete': {
          const project = reqStr(args, 'project');
          const ids = strArray(args, 'id');
          if (ids && ids.length > 1) {
            const dryRun = bool(args, 'dry_run') ?? false;
            const maxItems = num(args, 'max_items') ?? 10;
            if (ids.length > maxItems) {
              return { success: false, message: `Batch-Delete: Max ${maxItems} Items erlaubt, ${ids.length} angegeben` };
            }
            if (dryRun) {
              return { success: true, dry_run: true, would_delete: ids, count: ids.length };
            }
            const results = await Promise.allSettled(ids.map(id => deleteThought(project, id)));
            const deleted = results.filter(r => r.status === 'fulfilled').length;
            return { success: true, deleted, total: ids.length };
          }
          const result = await deleteThought(project, reqStr(args, 'id'));
          return { success: result.success, message: `Gedanke "${args.id}" geloescht`, warning: result.warning };
        }
        case 'update': {
          const project = reqStr(args, 'project');
          const id = reqStr(args, 'id');
          const changes: { content?: string; tags?: string[] } = {};
          const newContent = str(args, 'content');
          if (newContent !== undefined) changes.content = newContent;
          const newTags = strArray(args, 'tags');
          if (newTags !== undefined) changes.tags = newTags;
          const result = await updateThought(project, id, changes);
          return result;
        }
        default:
          return { success: false, error: `Unbekannte thought action: "${action}"` };
      }
    }

    // =================================================================
    // 5. PLAN
    // =================================================================
    case 'plan': {
      const project = reqStr(args, 'project');
      switch (action) {
        case 'get':
          return (await getPlan(project)) || { message: 'Kein Plan gefunden' };
        case 'update':
          return await updatePlan(project, {
            name: str(args, 'name'),
            description: str(args, 'description'),
            goals: strArray(args, 'goals'),
            architecture: str(args, 'architecture'),
          });
        case 'add_task':
          return await addTask(
            project, reqStr(args, 'title'), reqStr(args, 'description'),
            (str(args, 'priority') || 'medium') as 'low' | 'medium' | 'high'
          );
        default:
          return { success: false, error: `Unbekannte plan action: "${action}"` };
      }
    }

    // =================================================================
    // 6. PROPOSAL
    // =================================================================
    case 'proposal': {
      const project = reqStr(args, 'project');
      switch (action) {
        case 'list': {
          const proposals = await listProposals(project, str(args, 'status') as 'pending' | 'reviewed' | 'accepted' | 'rejected' | undefined);
          return {
            success: true,
            proposals: proposals.map(p => ({
              id: p.id, filePath: p.filePath, description: p.description,
              author: p.author, status: p.status, tags: p.tags,
              createdAt: p.createdAt, updatedAt: p.updatedAt,
            })),
            count: proposals.length,
            message: `${proposals.length} Vorschlaege gefunden`,
          };
        }
        case 'get': {
          const ids = strArray(args, 'id');
          if (ids && ids.length > 1) {
            const results = await getProposalsByIds(project, ids);
            return { success: true, proposals: results, count: results.length };
          }
          const proposal = await getProposal(project, reqStr(args, 'id'));
          if (!proposal) return { success: false, message: `Proposal "${args.id}" nicht gefunden` };
          return { success: true, proposal };
        }
        case 'update_status': {
          const ids = strArray(args, 'id');
          if (ids && ids.length > 1) {
            const status = reqStr(args, 'status');
            const settled = await Promise.allSettled(
              ids.map(id => updateProposalStatus(project, id, status as 'pending' | 'reviewed' | 'accepted' | 'rejected'))
            );
            const results: unknown[] = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors };
          }
          const proposal = await updateProposalStatus(
            project, reqStr(args, 'id'),
            reqStr(args, 'status') as 'pending' | 'reviewed' | 'accepted' | 'rejected'
          );
          if (!proposal) return { success: false, message: `Proposal "${args.id}" nicht gefunden` };
          return { success: true, proposal, message: `Proposal "${proposal.id}" Status geaendert zu "${proposal.status}"` };
        }
        case 'delete': {
          const ids = strArray(args, 'id');
          if (ids && ids.length > 1) {
            const dryRun = bool(args, 'dry_run') ?? false;
            const maxItems = num(args, 'max_items') ?? 10;
            if (ids.length > maxItems) {
              return { success: false, message: `Batch-Delete: Max ${maxItems} Items erlaubt, ${ids.length} angegeben` };
            }
            if (dryRun) {
              return { success: true, dry_run: true, would_delete: ids, count: ids.length };
            }
            const settled = await Promise.allSettled(ids.map(id => deleteProposal(project, id)));
            const deleted = settled.filter(r => r.status === 'fulfilled').length;
            return { success: true, deleted, total: ids.length };
          }
          const deleted = await deleteProposal(project, reqStr(args, 'id'));
          return {
            success: deleted.success,
            message: deleted.success ? `Proposal "${args.id}" geloescht` : `Proposal "${args.id}" nicht gefunden`,
            ...(deleted.warning ? { warning: deleted.warning } : {}),
          };
        }
        case 'update': {
          const id = reqStr(args, 'id');
          const changes: { content?: string; suggestedContent?: string; status?: string } = {};
          if (args.content) changes.content = str(args, 'content');
          if (args.suggested_content) changes.suggestedContent = str(args, 'suggested_content');
          if (args.status) changes.status = str(args, 'status');
          const result = await updateProposal(project, id, changes);
          return result;
        }
        default:
          return { success: false, error: `Unbekannte proposal action: "${action}"` };
      }
    }

    // =================================================================
    // 7. CHAT
    // =================================================================
    case 'chat': {
      switch (action) {
        case 'register': {
          const session = await registerChatAgent(
            reqStr(args, 'id'), reqStr(args, 'project'),
            str(args, 'model'), str(args, 'cutoff_date')
          );
          return { ...session, action: 'register' };
        }
        case 'unregister': {
          await unregisterChatAgent(reqStr(args, 'id'));
          return { success: true, action: 'unregister' };
        }
        case 'register_batch': {
          const agents = objArray<{ id: string; model?: string; cutoffDate?: string }>(args, 'agents');
          if (!agents || agents.length === 0) throw new Error('Parameter "agents" muss ein Array mit mindestens einem Eintrag sein');
          const results = await registerAgentsBatch(agents, reqStr(args, 'project'));
          return { success: true, count: results.length, agents: results, action: 'register_batch' };
        }
        case 'unregister_batch': {
          const ids = strArray(args, 'ids');
          if (!ids || ids.length === 0) throw new Error('Parameter "ids" muss ein Array mit mindestens einem Eintrag sein');
          await unregisterAgentsBatch(ids);
          return { success: true, count: ids.length, action: 'unregister_batch' };
        }
        case 'send': {
          const sendProject = reqStr(args, 'project');
          const senderId = reqStr(args, 'sender_id');
          const content = reqStr(args, 'content');
          const recipientIds = strArray(args, 'recipient_id');
          if (recipientIds && recipientIds.length > 1) {
            const settled = await Promise.allSettled(
              recipientIds.map(rid => sendChatMessage(sendProject, senderId, content, rid))
            );
            const results: unknown[] = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors, action: 'send' };
          }
          const result = await sendChatMessage(sendProject, senderId, content, str(args, 'recipient_id'));
          return { ...result, action: 'send' };
        }
        case 'get': {
          const messages = await getChatMessages(reqStr(args, 'project'), {
            agentId: str(args, 'agent_id'),
            since: str(args, 'since'),
            senderId: str(args, 'sender_id_filter'),
            limit: num(args, 'limit'),
          });
          return { success: true, messages, count: messages.length, action: 'get' };
        }
        case 'list': {
          const agents = await listActiveAgents(reqStr(args, 'project'));
          return { success: true, agents, count: agents.length, action: 'list' };
        }
        case 'inbox_send': {
          const fromAgent = reqStr(args, 'from_agent');
          const toAgentParam = args.to_agent;
          const inboxContent = reqStr(args, 'content');
          if (Array.isArray(toAgentParam)) {
            const results = await Promise.all(
              toAgentParam.map((t: string) => postToInbox(fromAgent, t, inboxContent))
            );
            return { success: true, results, count: results.length, action: 'inbox_send' };
          }
          const inboxResult = await postToInbox(fromAgent, reqStr(args, 'to_agent'), inboxContent);
          return { success: true, ...inboxResult, action: 'inbox_send' };
        }
        case 'inbox_check': {
          const inboxAgent = reqStr(args, 'agent_name');
          const inboxMessages = await checkInbox(inboxAgent);
          return { success: true, messages: inboxMessages, count: inboxMessages.length, action: 'inbox_check' };
        }
        default:
          return { success: false, error: `Unbekannte chat action: "${action}"` };
      }
    }

    // =================================================================
    // 8. CHANNEL — nur ueber MCP Server (stdio) verfuegbar
    // =================================================================
    case 'channel': {
      const projectParam = (args.project as string | undefined);
      if (!projectParam && action !== 'list') return { success: false, error: 'Parameter "project" ist erforderlich' };
      const project = projectParam ?? '';
      switch (action) {
        case 'create': {
          const chName = reqStr(args, 'name');
          const chDesc = (args.description as string | undefined) ?? null;
          const createdBy = reqStr(args, 'created_by');
          const channel = await createChannel(project, chName, chDesc, createdBy);
          return { success: true, channel, action: 'create' };
        }
        case 'join': {
          const chParam = args.channel_name;
          const agName = reqStr(args, 'agent_name');
          if (Array.isArray(chParam)) {
            const results = await Promise.all(chParam.map((ch: string) => joinChannel(project, ch, agName)));
            return { success: true, results, action: 'join' };
          }
          const joined = await joinChannel(project, reqStr(args, 'channel_name'), agName);
          return { success: joined, action: 'join' };
        }
        case 'leave': {
          const chParam2 = args.channel_name;
          const agName2 = reqStr(args, 'agent_name');
          if (Array.isArray(chParam2)) {
            const results = await Promise.all(chParam2.map((ch: string) => leaveChannel(project, ch, agName2)));
            return { success: true, results, action: 'leave' };
          }
          const left = await leaveChannel(project, reqStr(args, 'channel_name'), agName2);
          return { success: left, action: 'leave' };
        }
        case 'post': {
          const chName2 = reqStr(args, 'channel_name');
          const sender = reqStr(args, 'sender');
          const postContent = reqStr(args, 'content');
          const postResult = await postChannelMessage(project, chName2, sender, postContent);
          if (!postResult) return { success: false, error: `Channel "${chName2}" nicht gefunden` };
          return { success: true, messageId: postResult.id, createdAt: postResult.createdAt, action: 'post' };
        }
        case 'feed': {
          const chName3 = reqStr(args, 'channel_name');
          const feedLimit = args.limit !== undefined ? Number(args.limit) : 20;
          const sinceId = args.since_id !== undefined ? Number(args.since_id) : 0;
          const preview = args.preview === true;
          const msgs = await getChannelMessages(project, chName3, { limit: feedLimit, sinceId, preview });
          return { success: true, channel: chName3, messages: msgs, count: msgs.length, action: 'feed' };
        }
        case 'list': {
          const chProject = (args.project as string | undefined);
          const channels = await listChannels(chProject || undefined);
          return { success: true, channels, count: channels.length, action: 'list' };
        }
        default:
          return { success: false, error: `Unbekannte channel action: "${action}"` };
      }
    }

    // =================================================================
    // 9. EVENT
    // =================================================================
    case 'event': {
      switch (action) {
        case 'emit': {
          const result = await emitEvent(
            reqStr(args, 'project'),
            reqStr(args, 'event_type') as 'WORK_STOP' | 'CRITICAL_REVIEW' | 'ARCH_DECISION' | 'TEAM_DISCUSSION' | 'ANNOUNCEMENT',
            reqStr(args, 'priority') as 'critical' | 'high' | 'normal',
            str(args, 'scope') ?? 'all',
            reqStr(args, 'source_id'),
            str(args, 'payload'),
            bool(args, 'requires_ack')
          );
          return result;
        }
        case 'ack': {
          const agentId = reqStr(args, 'agent_id');
          const reaction = str(args, 'reaction');
          if (Array.isArray(args.event_id)) {
            const eventIds = args.event_id as number[];
            const settled = await Promise.allSettled(
              eventIds.map(eid => acknowledgeEvent(eid, agentId, reaction))
            );
            const results: unknown[] = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors };
          }
          const eventId = num(args, 'event_id');
          if (eventId === undefined) throw new Error('Parameter "event_id" ist erforderlich fuer action "ack"');
          return await acknowledgeEvent(eventId, agentId, reaction);
        }
        case 'pending': {
          const events = await getPendingEvents(reqStr(args, 'project'), reqStr(args, 'agent_id'));
          return { success: true, events, count: events.length };
        }
        default:
          return { success: false, error: `Unbekannte event action: "${action}"` };
      }
    }

    // =================================================================
    // 10. SPECIALIST — nur ueber MCP Server (stdio) verfuegbar
    // =================================================================
    case 'specialist':
      return { success: false, error: 'Specialist-Tool ist nur ueber MCP Server (stdio) verfuegbar — benoetigt Claude CLI Subprozesse' };

    // =================================================================
    // 11. DOCS
    // =================================================================
    case 'docs': {
      switch (action) {
        case 'add': {
          const result = await addTechDoc(
            reqStr(args, 'framework'), reqStr(args, 'version'),
            reqStr(args, 'section'), reqStr(args, 'content'),
            reqStr(args, 'type') as Parameters<typeof addTechDoc>[4],
            str(args, 'category'), str(args, 'source'), str(args, 'project')
          );
          return result;
        }
        case 'search': {
          const results = await searchTechDocs(reqStr(args, 'query'), {
            framework: str(args, 'framework'),
            type: str(args, 'type'),
            source: str(args, 'source'),
            project: str(args, 'project'),
            limit: num(args, 'limit'),
            scope: str(args, 'scope') as 'global' | 'project' | 'all' | undefined,
          });
          return { success: true, results, message: `${results.length} Tech-Docs gefunden` };
        }
        case 'get_for_file': {
          const agentId = reqStr(args, 'agent_id');
          const project = reqStr(args, 'project');
          const filePaths = strArray(args, 'file_path');
          if (filePaths && filePaths.length > 1) {
            const settled = await Promise.allSettled(
              filePaths.map(fp => getDocsForFile(fp, agentId, project))
            );
            const results: unknown[] = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors };
          }
          const result = await getDocsForFile(reqStr(args, 'file_path'), agentId, project);
          return { success: true, ...result };
        }
        default:
          return { success: false, error: `Unbekannte docs action: "${action}"` };
      }
    }

    // =================================================================
    // 12. ADMIN
    // =================================================================
    case 'admin': {
      switch (action) {
        case 'migrate':
          return { success: false, error: 'Action "migrate" ist nur ueber MCP Server (stdio) verfuegbar' };
        case 'restore':
          return { success: false, error: 'Action "restore" ist nur ueber MCP Server (stdio) verfuegbar' };
        case 'save_idea': {
          const title = reqStr(args, 'title');
          const description = reqStr(args, 'description');
          const project = str(args, 'project') || 'ideas';
          const tags = strArrayOrEmpty(args, 'tags');
          const content = `## ${title}\n\n${description}`;

          const suggestedName = generateIdeaName(content);
          const tempId = generateTempId();
          const preview = generatePreview(content);

          pendingIdeas.set(tempId, {
            content, project, suggestedName, tags, createdAt: new Date(),
          });

          return {
            success: true, tempId, suggestedName, preview, project,
            confirmationRequired: true,
            message: `Idee vorgemerkt. Name: "${suggestedName}". Bitte mit admin(action:"confirm_idea") bestaetigen.`,
          };
        }
        case 'confirm_idea': {
          const ideaId = reqStr(args, 'idea_id');
          const customName = str(args, 'custom_name');
          const pendingIdea = pendingIdeas.get(ideaId);

          if (!pendingIdea) {
            return { success: false, message: `Keine vorgemerkte Idee mit ID "${ideaId}" gefunden. Ideen werden nach 30 Minuten automatisch geloescht.` };
          }

          const finalName = customName?.trim() || pendingIdea.suggestedName;
          const existing = await getMemoryByName(pendingIdea.project, finalName);
          if (existing) {
            return { success: false, name: finalName, project: pendingIdea.project, message: `Ein Memory mit dem Namen "${finalName}" existiert bereits.` };
          }

          const memory = await writeMemory(pendingIdea.project, finalName, pendingIdea.content, 'note', [...pendingIdea.tags, 'idea']);
          pendingIdeas.delete(ideaId);

          return {
            success: true, name: finalName, project: pendingIdea.project,
            memory: { name: memory.name, category: memory.category, sizeChars: memory.content.length },
            message: `Idee "${finalName}" erfolgreich gespeichert in Projekt "${pendingIdea.project}".`,
          };
        }
        case 'index_media': {
          const path = reqStr(args, 'path');
          const project = reqStr(args, 'project');
          const recursive = bool(args, 'recursive') !== false;
          const result = await indexMediaDirectory(path, project, { recursive });
          return result;
        }
        case 'index_stats': {
          const project = reqStr(args, 'project');
          const codeStats = await getProjectStats(project);
          let thoughtsCount = 0;
          let memoriesCount = 0;
          let mediaCount = 0;
          let mediaImages = 0;
          let mediaVideos = 0;

          try {
            const thoughtsStats = await getCollectionStats(COLLECTIONS.projectThoughts(project));
            thoughtsCount = thoughtsStats?.pointsCount ?? 0;
          } catch { /* Collection existiert nicht */ }
          try {
            const memoriesStats = await getCollectionStats(COLLECTIONS.projectMemories(project));
            memoriesCount = memoriesStats?.pointsCount ?? 0;
          } catch { /* Collection existiert nicht */ }
          try {
            const mediaStats = await getCollectionStats(COLLECTIONS.projectMedia(project));
            mediaCount = mediaStats?.pointsCount ?? 0;
            if (mediaCount > 0) {
              const mediaPoints = await scrollVectors<{ media_category: string }>(
                COLLECTIONS.projectMedia(project), {}, 10000
              );
              for (const p of mediaPoints) {
                if (p.payload?.media_category === 'image') mediaImages++;
                else if (p.payload?.media_category === 'video') mediaVideos++;
              }
            }
          } catch { /* Collection existiert nicht */ }

          return {
            project,
            totalFiles: codeStats?.fileCount ?? 0,
            totalVectors: (codeStats?.chunkCount ?? 0) + mediaCount + thoughtsCount + memoriesCount,
            collections: {
              code: { vectors: codeStats?.chunkCount ?? 0 },
              media: { vectors: mediaCount, images: mediaImages, videos: mediaVideos },
              thoughts: { vectors: thoughtsCount },
              memories: { vectors: memoriesCount },
            },
          };
        }
        case 'detailed_stats': {
          const project = reqStr(args, 'project');
          let codeByType: Record<string, number> = {};
          let totalChunks = 0;
          let thoughtsBySource: Record<string, number> = {};
          let totalThoughts = 0;
          let memoriesByCategory: Record<string, number> = {};
          let totalMemories = 0;

          try {
            const codePoints = await scrollVectors<{ file_type: string }>(COLLECTIONS.projectCode(project), {}, 10000);
            totalChunks = codePoints.length;
            codeByType = codePoints.reduce((acc, p) => {
              const type = p.payload?.file_type || 'unknown';
              acc[type] = (acc[type] || 0) + 1;
              return acc;
            }, {} as Record<string, number>);
          } catch { /* Collection existiert nicht */ }

          try {
            const thoughtPoints = await scrollVectors<{ source: string }>(
              COLLECTIONS.projectThoughts(project),
              {},
              10000
            );
            totalThoughts = thoughtPoints.length;
            thoughtsBySource = thoughtPoints.reduce((acc, p) => {
              const source = p.payload?.source || 'unknown';
              acc[source] = (acc[source] || 0) + 1;
              return acc;
            }, {} as Record<string, number>);
          } catch { /* Collection existiert nicht */ }

          try {
            const memoryPoints = await scrollVectors<{ category: string }>(
              COLLECTIONS.projectMemories(project),
              {},
              10000
            );
            totalMemories = memoryPoints.length;
            memoriesByCategory = memoryPoints.reduce((acc, p) => {
              const cat = p.payload?.category || 'unknown';
              acc[cat] = (acc[cat] || 0) + 1;
              return acc;
            }, {} as Record<string, number>);
          } catch { /* Collection existiert nicht */ }

          return {
            project,
            code: { totalChunks, byFileType: codeByType },
            thoughts: { total: totalThoughts, bySource: thoughtsBySource },
            memories: { total: totalMemories, byCategory: memoriesByCategory },
          };
        }
        default:
          return { success: false, error: `Unbekannte admin action: "${action}"` };
      }
    }

    // =================================================================
    // 13. WATCHER — nur ueber MCP Server (stdio) verfuegbar
    // =================================================================
    case 'watcher':
      return { success: false, error: 'Watcher-Tool ist nur ueber MCP Server (stdio) verfuegbar — benoetigt lokale Dateisystem-Zugriffe' };

    // =================================================================
    // 14. CODE_INTEL
    // =================================================================
    case 'code_intel': {
      const project = reqStr(args, 'project');
      switch (action) {
        case 'tree': {
          const tree = await getProjectTree(project, {
            path: str(args, 'path') ?? str(args, 'file_path'),
            recursive: bool(args, 'recursive'),
            depth: num(args, 'depth'),
            show_lines: bool(args, 'show_lines'),
            show_counts: bool(args, 'show_counts'),
            show_comments: bool(args, 'show_comments'),
            show_functions: bool(args, 'show_functions'),
            show_imports: bool(args, 'show_imports'),
            file_type: str(args, 'file_type'),
          });
          return { success: true, tree, project };
        }
        case 'functions': {
          const functions = await getFunctions(project, str(args, 'file_path'), str(args, 'name'), bool(args, 'exported_only'));
          return { success: true, functions, count: functions.length, project };
        }
        case 'variables': {
          const variables = await getVariables(project, str(args, 'file_path'), str(args, 'name'), bool(args, 'with_values'));
          return { success: true, variables, count: variables.length, project };
        }
        case 'symbols': {
          const symbolType = reqStr(args, 'symbol_type');
          const symbols = await getSymbols(project, symbolType, str(args, 'file_path'), str(args, 'name'));
          return { success: true, symbols, count: symbols.length, symbol_type: symbolType, project };
        }
        case 'references': {
          const result = await getReferences(project, reqStr(args, 'name'));
          return { success: true, ...result, project };
        }
        case 'search': {
          const results = await fullTextSearchCode(project, reqStr(args, 'query'), str(args, 'file_type'), num(args, 'limit') ?? 20);
          return { success: true, results, count: results.length, project };
        }
        case 'file': {
          const filePath = str(args, 'file_path') ?? str(args, 'path');
          if (!filePath) throw new Error('Parameter "file_path" oder "path" ist erforderlich fuer action "file"');
          const file = await getFileContent(project, filePath);
          if (!file) return { success: false, message: `Datei nicht gefunden: ${filePath}`, project };
          return { success: true, ...file, project };
        }
        default:
          return { success: false, error: `Unbekannte code_intel action: "${action}"` };
      }
    }

    // =================================================================
    case 'files': {
      const project = reqStr(args, 'project');
      const filePath = reqStr(args, 'file_path');
      const agentId = str(args, 'agent_id');

      switch (action) {
        case 'create': {
          const content = reqStr(args, 'content');
          const result = await createFileInPg(project, filePath, content, agentId);
          const response: Record<string, unknown> = { success: true, message: `Datei "${filePath}" erstellt (${content.length} Zeichen)` };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }
        case 'update': {
          const content = reqStr(args, 'content');
          const result = await updateFileInPg(project, filePath, content, agentId);
          const response: Record<string, unknown> = { success: true, message: `Datei "${filePath}" aktualisiert (${content.length} Zeichen)` };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }
        case 'delete': {
          await softDeleteFile(project, filePath);
          return { success: true, message: `Datei "${filePath}" geloescht` };
        }
        case 'move': {
          const newPath = reqStr(args, 'new_path');
          await moveFileInPg(project, filePath, newPath);
          return { success: true, message: `Datei verschoben: "${filePath}" → "${newPath}"` };
        }
        case 'copy': {
          const newPath = reqStr(args, 'new_path');
          await copyFileInPg(project, filePath, newPath);
          return { success: true, message: `Datei kopiert: "${filePath}" → "${newPath}"` };
        }
        case 'read': {
          const content = await getFileContentFromPg(project, filePath);
          if (content === null) {
            return { success: false, error: `Datei "${filePath}" nicht gefunden in Projekt "${project}"` };
          }
          return { success: true, file_path: filePath, content, size: content.length };
        }
        case 'replace_lines': {
          const currentContent = await getFileContentFromPg(project, filePath);
          if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
          const lineStart = num(args, 'line_start');
          const lineEnd = num(args, 'line_end');
          const content = reqStr(args, 'content');
          if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
          const newContent = replaceLines(currentContent, lineStart, lineEnd, content);
          const result = await updateFileInPg(project, filePath, newContent, agentId);
          const response: Record<string, unknown> = { success: true, message: `Zeilen ${lineStart}-${lineEnd} in "${filePath}" ersetzt` };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }
        case 'insert_after': {
          const currentContent = await getFileContentFromPg(project, filePath);
          if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
          const afterLine = num(args, 'after_line');
          const content = reqStr(args, 'content');
          if (afterLine === undefined) return { success: false, error: 'after_line erforderlich' };
          const newContent = insertAfterLine(currentContent, afterLine, content);
          const result = await updateFileInPg(project, filePath, newContent, agentId);
          const response: Record<string, unknown> = { success: true, message: `Inhalt nach Zeile ${afterLine} in "${filePath}" eingefuegt` };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }
        case 'delete_lines': {
          const currentContent = await getFileContentFromPg(project, filePath);
          if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
          const lineStart = num(args, 'line_start');
          const lineEnd = num(args, 'line_end');
          if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
          const newContent = deleteLines(currentContent, lineStart, lineEnd);
          const result = await updateFileInPg(project, filePath, newContent, agentId);
          const response: Record<string, unknown> = { success: true, message: `Zeilen ${lineStart}-${lineEnd} in "${filePath}" geloescht` };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }
        case 'search_replace': {
          const currentContent = await getFileContentFromPg(project, filePath);
          if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
          const searchStr = reqStr(args, 'search');
          const replaceStr = reqStr(args, 'replace');
          const { content: newContent, count } = searchReplace(currentContent, searchStr, replaceStr);
          if (count === 0) return { success: true, count: 0, message: `Kein Vorkommen von "${searchStr}" in "${filePath}"` };
          const result = await updateFileInPg(project, filePath, newContent, agentId);
          const response: Record<string, unknown> = { success: true, count, message: `${count} Vorkommen ersetzt in "${filePath}"` };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }
        default:
          return { success: false, error: `Unbekannte files action: "${action}"` };
      }
    }

    // =================================================================
    // 15. SHELL — Queue-basiert via Daemon (REST-API-Pfad)
    // =================================================================
    case 'shell': {
      const shellAction = str(args, 'action') ?? 'exec';

      if (shellAction === 'get_stream') {
        return { success: false, error: 'get_stream via REST-API noch nicht implementiert' };
      }

      if (shellAction === 'history') {
        const jobs = await getShellJobs({
          project: str(args, 'project'),
          limit: num(args, 'limit'),
          offset: num(args, 'offset'),
          status: str(args, 'status') as 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout' | undefined,
        });
        return { success: true, count: jobs.length, jobs };
      }

      if (shellAction === 'get') {
        const job = await getShellJobById(reqStr(args, 'id'));
        if (!job) {
          return { success: false, error: 'unknown_job', message: `Job ${reqStr(args, 'id')} nicht gefunden` };
        }
        return { success: true, job };
      }

      if (shellAction === 'log') {
        const id = reqStr(args, 'id');
        const query = str(args, 'query');
        if (query) {
          const result = await searchShellJobLog(id, query, {
            regex: args.regex === true,
            case_sensitive: args.case_sensitive === true,
            max_matches: num(args, 'max_matches'),
          });
          if (!result) return { success: false, error: 'unknown_job', message: `Job ${id} nicht gefunden` };
          return { success: true, ...result };
        }
        const result = await getShellJobLogLines(id, num(args, 'from_line'), num(args, 'to_line'));
        if (!result) return { success: false, error: 'unknown_job', message: `Job ${id} nicht gefunden` };
        return { success: true, ...result };
      }

      if (shellAction !== 'exec') {
        return { success: false, error: `Unbekannte shell action: "${shellAction}"` };
      }

      const timeoutMs = num(args, 'timeout_ms') ?? 30000;
      const { id, stream_id } = await enqueueShellJob({
        project: reqStr(args, 'project'),
        command: reqStr(args, 'command'),
        cwd_relative: str(args, 'cwd_relative'),
        timeout_ms: timeoutMs,
        tail_lines: num(args, 'tail_lines'),
      });

      const result = await waitForShellJob(id, timeoutMs + 5000);

      // Wichtig fuer Web-KI-Connectors: explizites success-Flag +
      // actionable message - sonst hangt der Connector beim
      // project_inactive/unknown_project-Fall stillschweigend.
      return {
        success: !result.error,
        status: result.status,
        stream_id: result.stream_id,
        exit_code: result.exit_code,
        tail: result.tail,
        error: result.error,
        message: result.message,
      };
    }

    // =================================================================
    // 17. CODE_CHECK
    // =================================================================
    case 'code_check': {
      const ccAction = reqStr(args, 'action');
      switch (ccAction) {
        case 'add_pattern': {
          const description = reqStr(args, 'description');
          const fix = reqStr(args, 'fix');
          const severity = str(args, 'severity') ?? 'warning';
          const foundInModel = reqStr(args, 'found_in_model');
          const foundBy = reqStr(args, 'found_by');
          const result = await addErrorPattern(description, fix, severity, foundBy, foundInModel);
          return { success: true, ...result, message: `Pattern gespeichert (scope: ${result.modelScope})` };
        }
        case 'list_patterns': {
          const modelScope = str(args, 'model_scope');
          const limit = num(args, 'limit') ?? 20;
          const patterns = await listErrorPatterns(modelScope, limit);
          return { success: true, patterns, count: patterns.length };
        }
        case 'delete_pattern': {
          const id = reqStr(args, 'id');
          const deleted = await deleteErrorPattern(id);
          return { success: deleted, message: deleted ? 'Pattern geloescht' : 'Pattern nicht gefunden' };
        }
        default:
          return { success: false, error: `Unbekannte code_check action: "${ccAction}"` };
      }
    }

    // =================================================================
    // 18. GUIDE — Web-KI-Onboarding + Tool-Dokumentation
    // =================================================================
    case 'guide': {
      const toolName = str(args, 'tool_name');
      const actionName = str(args, 'action_name');

      if (!toolName) {
        return {
          success: true,
          scope: 'overview',
          content: GUIDE_OVERVIEW,
          available_tools: Object.keys(TOOL_GUIDES),
          tip: 'Rufe guide({ tool_name: "<name>" }) fuer Detail-Doku zu einem einzelnen Tool auf.',
        };
      }

      const toolGuide = TOOL_GUIDES[toolName];
      if (!toolGuide) {
        return {
          success: false,
          error: `Kein Guide fuer Tool "${toolName}" gefunden.`,
          available_tools: Object.keys(TOOL_GUIDES),
        };
      }

      if (actionName) {
        const action = toolGuide.actions?.[actionName];
        if (!action) {
          return {
            success: false,
            error: `Kein Guide fuer Action "${actionName}" in Tool "${toolName}" gefunden.`,
            available_actions: toolGuide.actions ? Object.keys(toolGuide.actions) : [],
          };
        }
        return {
          success: true,
          scope: 'action',
          tool: toolName,
          action: actionName,
          guide: action,
        };
      }

      return {
        success: true,
        scope: 'tool',
        tool: toolName,
        guide: toolGuide,
        tip: toolGuide.actions
          ? `Dieses Tool hat mehrere Actions: ${Object.keys(toolGuide.actions).join(', ')}. Rufe guide({ tool_name: "${toolName}", action_name: "<action>" }) fuer Detail-Doku.`
          : undefined,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /mcp/sse - SSE Endpoint für MCP
   */
  fastify.get('/mcp/sse', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = randomUUID();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });

    sseConnections.set(sessionId, reply);

    const baseUrl = getBaseUrl(request);
    sendSSEMessage(reply, {
      jsonrpc: '2.0',
      method: 'endpoint',
      params: { endpoint: `${baseUrl}/mcp/messages?sessionId=${sessionId}` },
    });

    const keepalive = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, 30000);

    request.raw.on('close', () => {
      clearInterval(keepalive);
      sseConnections.delete(sessionId);
    });

    return reply;
  });

  /**
   * POST /mcp/messages - JSON-RPC Endpoint für MCP
   */
  fastify.post<{
    Querystring: { sessionId?: string };
    Body: { jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown> };
  }>('/mcp/messages', async (request, reply) => {
    const { jsonrpc, id, method, params } = request.body;
    const sessionId = request.query.sessionId;

    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', '*');

    if (jsonrpc !== '2.0') {
      return reply.status(400).send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
    }

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'synapse-mcp', version: '0.2.0' },
          };
          break;

        case 'tools/list':
          result = { tools: MCP_TOOLS };
          break;

        case 'tools/call': {
          const toolName = params?.name as string;
          const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
          const toolResult = await handleToolCall(toolName, toolArgs);
          result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
          break;
        }

        case 'notifications/initialized':
          return reply.status(202).send();

        default:
          return reply.status(400).send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }

      const response = { jsonrpc: '2.0', id, result };

      if (sessionId && sseConnections.has(sessionId)) {
        sendSSEMessage(sseConnections.get(sessionId)!, response);
      }

      return response;
    } catch (error) {
      return reply.status(500).send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } });
    }
  });

  /**
   * POST / - Root MCP JSON-RPC Endpoint
   */
  fastify.post<{
    Body: { jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown> };
  }>('/', async (request, reply) => {
    const { jsonrpc, id, method, params } = request.body || {};

    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', '*');

    if (!jsonrpc) {
      return reply.status(400).send({ error: 'Not a JSON-RPC request' });
    }

    if (jsonrpc !== '2.0') {
      return reply.status(400).send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
    }

    console.log(`[MCP] Request: ${method}`);

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'synapse-mcp', version: '0.2.0' },
          };
          break;

        case 'tools/list':
          result = { tools: MCP_TOOLS };
          break;

        case 'tools/call': {
          const toolName = params?.name as string;
          const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
          const toolResult = await handleToolCall(toolName, toolArgs);
          result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
          break;
        }

        case 'notifications/initialized':
          return reply.status(202).send();

        case 'ping':
          result = {};
          break;

        default:
          return reply.status(400).send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }

      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      console.error(`[MCP] Error:`, error);
      return reply.status(500).send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } });
    }
  });

  /**
   * OPTIONS Handler für CORS Preflight
   */
  fastify.options('/mcp/*', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');
    return reply.status(204).send();
  });

  fastify.options('/', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');
    return reply.status(204).send();
  });
}
