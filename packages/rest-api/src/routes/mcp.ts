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
  searchCodeBatch,
  searchDocsWithFallback,
  listCollections,
  scrollVectors,
  COLLECTIONS,
  // Projekt
  detectTechnologies,
  indexProjectTechnologies,
  getProjectStats,
  setProjectEnabled,
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
  createProposal,
  getProposal,
  getProposalsByIds,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  deleteProposals,
  searchProposals,
  updateProposal,
  // Onboarding (geteilt mit MCP-Server via agent_onboardings-Tabelle in PG)
  registerAgent,
  getRulesForNewAgent,
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
  getStatements,
  getCallEdges,
  getExecutionFlow,
  getEntrypoints,
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
  searchReplaceBatch,
  applyContentRange,
  // File-Versionierung (Schritt 1)
  listFileVersions,
  getFileVersion,
  restoreFileVersion,
  restoreBatch,
  listFileHistory,
  // Multi-File Plan/Commit (Schritt 2)
  planBatch,
  commitBatch,
  cancelBatch,
  getBatchPlan,
  // Project-Init-Queue (Self-Service Project-Bootstrap)
  isValidProjectName,
  enqueueProjectInitJob,
  waitForProjectInitJob,
  expirePendingProjectInitJobs,
  getProjectInitJob,
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
  // Daemon-Heartbeat (Auto-Routing shell ↔ workspace)
  isDaemonAliveForProject,
  // Error Patterns (code_check)
  addErrorPattern,
  listErrorPatterns,
  deleteErrorPattern,
  resolveAgentId,
} from '@synapse/core';
import { minimatch } from 'minimatch';
import { GUIDE_OVERVIEW, TOOL_GUIDES, logToolCall, queryToolCalls } from '@synapse/core';
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
    description: 'Lifecycle des eigenen Synapse-Projekts auf dem User-PC: Initialisierung, Setup, Tech-Detection, Aufraeumen, Status, Listing. Self-Service-Init: action="init" + name (ohne path) queued den Anlage-Job an den FileWatcher-Daemon auf dem Ziel-PC, der das Projekt unter SYNAPSE_WORKSPACE_ROOT (default ~/dev) anlegt und registriert. Status-Polling via init_status mit job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'init_status', 'complete_setup', 'detect_tech', 'cleanup', 'stop', 'status', 'list', 'enable', 'disable'],
          description: 'Aktion: init | init_status | complete_setup | detect_tech | cleanup | stop | status | list | enable | disable. enable/disable schalten das Projekt in PG (Source of Truth) — Parser-Worker und FileWatcher-Daemon folgen.',
        },
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner. Bei action="init" optional — ohne path queued der Job an den Daemon und resolved gegen WORKSPACE_ROOT/name.' },
        name: { type: 'string', description: 'Projekt-Name. Pflicht fuer init wenn kein path gegeben. Erlaubt: 2-64 Zeichen [a-zA-Z0-9_-], beginnt mit Buchstabe/Ziffer.' },
        index_docs: { type: 'boolean', description: 'Framework-Dokumentation vorladen (Standard: true, fuer init)' },
        project: { type: 'string', description: 'Projekt-Name (fuer complete_setup, stop, list nutzt dies)' },
        phase: { type: 'string', enum: ['initial', 'post-indexing'], description: 'Setup-Phase (fuer complete_setup)' },
        agent_id: { type: 'string', description: 'Optionale Agent-ID fuer Onboarding (fuer init)' },
        hostname: { type: 'string', description: 'Optional fuer init: Ziel-Hostname falls mehrere Daemons im selben PG haengen.' },
        template: { type: 'string', description: 'Optional fuer init: Skeleton-Template ("node"|"python"|"blank"). Aktuell informational, Daemon legt nur Basisordner + README an.' },
        job_id: { type: 'string', description: 'Erforderlich fuer init_status: Job-ID aus der ersten init-Antwort.' },
      },
      required: ['action'],
    },
  },
  // 2. search
  {
    name: 'search',
    description: 'Semantische Lese-Suche in den eigenen Daten des Synapse-Projekts (Code-Vektor-Index, eigene Notizen, Tech-Doku, Pfade). Nur Read-Only. Kein Zugriff auf fremde Datenbanken, keine externen Quellen.',
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
    description: 'Eigenes Projekt-Notizbuch (Memories) im lokalen Synapse-Workspace verwalten: anlegen, lesen, listen, aktualisieren, eintragen-entfernen, dateispezifisches Lookup. Wirkt ausschliesslich auf die User-eigene lokale Datenbank dieses Projekts. Keine externen Systeme.',
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
        limit: { type: 'number', description: 'Max. Ergebnisse (optional, Standard: 10 fuer find_for_file; list: Standard 100)' },
        names_only: { type: 'boolean', description: 'Nur fuer list: ausschliesslich Memory-Namen liefern (minimaler Context)' },
        codeLimit: { type: 'number', description: 'Max. Code-Chunks (optional, Standard: 10 fuer read_with_code)' },
        includeSemanticMatches: { type: 'boolean', description: 'Semantische Matches einbeziehen (optional, Standard: true fuer read_with_code)' },
        dry_run: { type: 'boolean', description: 'Preview-Modus — NUR aktiv wenn name/id ein Array ist (Batch-Delete). Bei Single-String wird sofort geloescht, dry_run wird ignoriert. Wenn die UI eine Bestaetigung erzwingen soll, ruf erst mit Array + dry_run:true auf, dann mit Array ohne dry_run.' },
        max_items: { type: 'number', description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)' },
        items: {
          type: 'array',
          description: 'Bulk-Mode fuer write: 1..50 Memories in einem Call. Jedes Item: { name, content, category?, tags? }. Best-effort — bei Fehler eines Items wird der naechste weitergeschrieben, das Ergebnis enthaelt per-Item-Status.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              content: { type: 'string' },
              category: { type: 'string', enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'content'],
          },
        },
      },
      required: ['action', 'project'],
    },
  },
  // 4. thought
  {
    name: 'thought',
    description: 'Kurze Notizen (Thoughts) im eigenen Projekt-Notizbuch ablegen, suchen, lesen, aktualisieren oder bereinigen. Lokale Synapse-Datenbank des Users, project-scoped. Keine fremden Daten, keine externen Systeme. add/add_batch akzeptieren optional task_id (Verknuepfung mit Plan-Task) + task_status (setzt zugleich den Status der verlinkten Task — spart einen plan(update_task)-Call).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'add_batch', 'get', 'delete', 'update', 'search'],
          description: 'Aktion: add (speichern), add_batch (mehrere atomar speichern), get (abrufen), search (suchen), update (aktualisieren), delete (loeschen)',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.' },
        source: { type: 'string', description: 'Quelle (z.B. claude-code, gpt, user) - fuer action "add" oder "add_batch"' },
        content: { type: 'string', description: 'Inhalt des Gedankens - fuer action "add" oder "update"' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags - fuer action "add" oder "update"' },
        items: {
          type: 'array',
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              task_id: { type: 'string', description: 'Optional: Task-ID fuer Verknuepfung pro Item' },
            },
            required: ['content'],
          },
          minItems: 1,
          maxItems: 50,
          description: 'Items fuer add_batch (1..50 Gedanken). source gilt fuer alle Items.',
        },
        task_id: { type: 'string', description: 'Optional fuer add: Verknuepft den Thought mit einer Plan-Task (Spalte task_id). Suche und Plan-Lookups koennen darauf filtern.' },
        task_status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'], description: 'Optional fuer add/add_batch: setzt zugleich den Status der via task_id verlinkten Task. Spart einen separaten plan(update_task)-Call.' },
        trigger_respawn: { type: 'boolean', description: 'Optional fuer add: Spezialist signalisiert sein Auto-Handoff. Server prueft Context-Stand gegen Korridor und triggert sofortigen Respawn (ohne auf 95% zu warten). Nur wirksam wenn source einem aktiven Spezialisten entspricht. Fuer Subagenten/Koordinator wirkungslos.' },
        },
        id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'ID des Gedankens - fuer action "get" (einzeln oder Array), "delete" oder "update"',
        },
        query: { type: 'string', description: 'Suchanfrage - fuer action "search"' },
        limit: { type: 'number', description: 'Maximale Anzahl Ergebnisse (Standard: 50 fuer get, 10 fuer search)' },
        dry_run: { type: 'boolean', description: 'Preview-Modus — NUR aktiv wenn name/id ein Array ist (Batch-Delete). Bei Single-String wird sofort geloescht, dry_run wird ignoriert. Wenn die UI eine Bestaetigung erzwingen soll, ruf erst mit Array + dry_run:true auf, dann mit Array ohne dry_run.' },
        max_items: { type: 'number', description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)' },
      },
      required: ['action'],
    },
  },
  // 5. plan
  {
    name: 'plan',
    description: 'Eigenen Projekt-Plan + Tasks im lokalen Synapse-Workspace verwalten: abrufen, aktualisieren, Tasks anlegen (einzeln oder Batch), Tasks aendern, Tasks entfernen. Project-scoped, eigene User-Datenbank. Keine externen Systeme, keine freien Pfade.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'update', 'add_task', 'add_tasks_batch', 'update_task', 'delete_task'],
          description: 'Aktion: "get" zum Abrufen, "update" zum Aktualisieren, "add_task" um eine Task hinzuzufuegen, "add_tasks_batch" um mehrere Tasks atomar hinzuzufuegen, "update_task" um eine Task zu aendern, "delete_task" um eine oder mehrere Tasks zu loeschen (id als String oder Array)',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.' },
        name: { type: 'string', description: 'Neuer Plan-Name' },
        description: { type: 'string', description: 'Neue Beschreibung' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Neue Ziele' },
        architecture: { type: 'string', description: 'Architektur-Beschreibung' },
        title: { type: 'string', description: 'Task-Titel' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Prioritaet (Standard: medium)' },
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
          description: 'Tasks fuer add_tasks_batch (1..50 Items)',
        },
        task_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
          ],
          description: 'Task-ID (String fuer update_task/delete_task, Array fuer Batch-delete_task)',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done', 'blocked'],
          description: 'Neuer Task-Status (fuer update_task); bei action=get: optionaler Task-Filter',
        },
        compact: { type: 'boolean', description: 'Nur fuer get: Tasks ohne description liefern (id/title/status/priority) — Context-sparend' },
        limit: { type: 'number', description: 'Nur fuer get: max. Anzahl Tasks in der Antwort' },
      },
      required: ['action', 'project'],
    },
  },
  // 6. proposal
  {
    name: 'proposal',
    description: 'Eigene Code-Aenderungs-Vorschlaege (Proposals) im Projekt-Workspace anlegen (single oder Bulk via items[]), listen, lesen, aktualisieren, Status setzen, entfernen. Vorschlaege bleiben innerhalb der lokalen Synapse-DB, werden nicht automatisch auf den Code angewendet. Keine externen Systeme.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update_status', 'delete', 'update'],
          description: 'Aktion: create (Anlegen, single oder items[]), list, get, update_status, delete, update',
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
        suggested_content: { type: 'string', description: 'Neuer vorgeschlagener Inhalt (fuer update). Bei create: vorgeschlagener Datei-Inhalt.' },
        dry_run: { type: 'boolean', description: 'Preview-Modus — NUR aktiv wenn name/id ein Array ist (Batch-Delete). Bei Single-String wird sofort geloescht, dry_run wird ignoriert. Wenn die UI eine Bestaetigung erzwingen soll, ruf erst mit Array + dry_run:true auf, dann mit Array ohne dry_run.' },
        max_items: { type: 'number', description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)' },
        file_path: { type: 'string', description: 'Datei-Pfad (relativ) auf den sich der Proposal bezieht (fuer create).' },
        author: { type: 'string', description: 'Autor des Proposals (fuer create).' },
        description: { type: 'string', description: 'Kurzbeschreibung des Vorschlags (fuer create).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags (fuer create).' },
        items: {
          type: 'array',
          description: 'Bulk-Mode fuer create: 1..50 Proposals in einem Call. Jedes Item: { file_path, suggested_content, description, author, tags? }. project gilt fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              suggested_content: { type: 'string' },
              description: { type: 'string' },
              author: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['file_path', 'suggested_content', 'description', 'author'],
          },
        },
      },
      required: ['action', 'project'],
    },
  },
  // 7. chat
  {
    name: 'chat',
    description: 'Lokales Agenten-Adressbuch der eigenen Synapse-Instanz: Sub-Hilfsagenten registrieren / abmelden, Direktnachrichten + Inbox. Wirkt nur auf vom User selbst registrierte Agenten in dieser Datenbank. Keine externen Identities, keine externen Messaging-Systeme.',
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
        cutoff_date: { type: 'string', description: 'Wissens-Cutoff. Format YYYY-MM-DD (auch YYYY-MM und YYYY akzeptiert, wird automatisch gepadded). NICHT nur Jahr-Monat ohne Tag im Postgres-DATE-Feld.' },
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
        agent_name: { type: 'string', description: 'Agent-Name (fuer inbox_check). NICHT agent_id verwenden — das ist eine andere Aktion-Param.' },
      },
      required: ['action'],
    },
  },
  // 8. channel
  {
    name: 'channel',
    description: 'Channels (Gruppen-Notizboards) zwischen Sub-Hilfsagenten im eigenen Synapse-Projekt verwalten: anlegen, beitreten, verlassen, posten, lesen, listen. Lokale Datenbank, project-scoped. Keine externen Chat-Systeme.',
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
        messages: {
          type: 'array',
          description: 'Bulk-Mode fuer post: 1..20 Nachrichten in einem Channel in einem Call. Jedes Item: { content }. project + channel_name + sender gelten fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: { content: { type: 'string' } },
            required: ['content'],
          },
        },
      },
      required: ['action'],
    },
  },
  // 9. event
  {
    name: 'event',
    description: 'Lokale Steuersignale fuer eigene Sub-Hilfsagenten: emit (Signal absetzen), ack (Signal bestaetigen), pending (offene Signale lesen). Wirkt nur innerhalb der eigenen Synapse-Instanz. Keine externen Systeme, keine OS-Signals.',
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
        events: {
          type: 'array',
          description: 'Bulk-Mode fuer emit: 1..50 Events in einem Call. Jedes Item: { event_type, priority, scope?, payload?, requires_ack? }. project + source_id gelten fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              event_type: { type: 'string' },
              priority: { type: 'string' },
              scope: { type: 'string' },
              payload: { type: 'string' },
              requires_ack: { type: 'boolean' },
            },
            required: ['event_type', 'priority'],
          },
        },
      },
      required: ['action'],
    },
  },
  // 10. specialist
  {
    name: 'specialist',
    description: 'Lifecycle persistenter Sub-Hilfsagenten (Spezialisten) im eigenen Projekt-Workspace: anlegen (spawn / spawn_batch), ansprechen (wake), Skill-Konfiguration aktualisieren, pausieren (stop) oder endgueltig deprovisionieren (purge). Spezialisten sind vom User explizit konfigurierte lokale Helfer-Instanzen, gestartet als Subprozess via Claude-CLI auf dem Projekt-PC. Wirkt ausschliesslich auf registrierte Spezialisten-Namen im angegebenen project_path. Keine freien Dateipfade, keine Wildcards, keine Shell-Kommandos, keine externen Systeme.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'spawn_batch', 'stop', 'purge', 'status', 'wake', 'update_skill', 'capabilities'],
          description: 'Die auszufuehrende Aktion',
        },
        name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Name des Spezialisten (erforderlich fuer: spawn, stop, status, wake, update_skill). Array erlaubt fuer: status',
        },
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'gemini-flash-lite', 'gemini-flash', 'gemini-pro'], description: 'Modell-Alias (erforderlich fuer: spawn). Aliases werden via model_registry-Tabelle aufgeloest. CLAUDE: opus/sonnet/haiku = 200k, opus[1m]/sonnet[1m] = 1M Context. ⚠️ ABO-LIMIT: Nur EIN Modell-Typ darf gleichzeitig auf 1M laufen (sonst rate-limit-Block). GOOGLE: gemini-flash-lite/gemini-flash/gemini-pro = 1M Context, ~3-75x billiger als Claude (braucht GOOGLE_API_KEY).' },
        expertise: { type: 'string', description: 'Fachgebiet des Spezialisten (erforderlich fuer: spawn)' },
        task: { type: 'string', description: 'Aufgabe fuer den Spezialisten (erforderlich fuer: spawn)' },
        project: { type: 'string', description: 'Projekt-Name (erforderlich fuer: spawn)' },
        project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner. Bei REST-API OPTIONAL — wird vom Daemon aus dem Projektkontext (projects-Tabelle) anhand von project ermittelt. Nur fuer lokale MCP-Direktnutzung erforderlich.' },
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
    description: 'Eigene Tech-Doku-Bibliothek im Projekt-Workspace verwalten: Wissens-Snippets indexieren, semantisch suchen, dateispezifische Warnungen abrufen (Wissens-Airbag). Lokale Datenbank, keine Web-Crawls, keine externen Systeme.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'search', 'get_for_file'],
          description: 'Aktion: add (Indexieren), search (Suchen), get_for_file (Wissens-Airbag)',
        },
        framework: { type: 'string', description: 'Framework/Sprache (z.B. react, python, express); bei get_for_file: optionaler Framework-Filter' },
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
        docs: {
          type: 'array',
          description: 'Bulk-Mode fuer add: 1..50 Tech-Docs in einem Call. Jedes Item: { framework, version, section, content, type, category?, source? }. project gilt fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              framework: { type: 'string' },
              version: { type: 'string' },
              section: { type: 'string' },
              content: { type: 'string' },
              type: { type: 'string', enum: ['feature', 'breaking-change', 'migration', 'gotcha', 'code-example', 'best-practice', 'known-issue', 'community'] },
              category: { type: 'string', enum: ['framework', 'language'] },
              source: { type: 'string', enum: ['research', 'context7', 'manual'] },
            },
            required: ['framework', 'version', 'section', 'content', 'type'],
          },
        },
      },
      required: ['action'],
    },
  },
  // 12. admin
  {
    name: 'admin',
    description: 'Wartungs- und Statistik-Operationen der eigenen Synapse-Instanz: Index-Statistiken, Backup-Restore innerhalb der eigenen DB, Ideen-Eingang, Indexierung lokaler Mediendateien im Projekt-Verzeichnis. Wirkt nur auf die User-eigene lokale Synapse-Datenbank. Keine externen Systeme.',
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
  // watcher-Tool entfernt aus REST-Schema (2026-05-02): der REST-Handler lehnte
  // ohnehin mit "nur via MCP" ab. Web-KIs sollen es nicht im tools/list sehen,
  // damit keine falschen Erwartungen entstehen. Daemon-Steuerung erfolgt durch
  // den User lokal via Tray oder den lokalen MCP-Server.
  // 14. code_intel
  {
    name: 'code_intel',
    description: 'Strukturierte Lese-Abfragen ueber den eigenen Code-Index des Projekts: Dateibaum, Funktionen, Variablen, Symbole, Querverweise, Suche, Dateiinhalt sowie die Ablauf-Ebene (Statements, Call-Kanten, Execution-Flow, Entrypoints). Read-Only auf eigene indexierte Projekt-Daten. SUCHE: action="search" hat ZWEI Modi: Default = PG-Volltext (lexikalisch); semantic:true = Qdrant-Embedding (konzeptuell). Antwort enthaelt mode-Feld. BATCH-SUCHE: action="search_batch" + queries[] (1..10) macht alle Queries semantisch in EINEM Call — Embeddings gebatched zu Google, parallel gegen Qdrant. Ideal wenn KI mehrere Discovery-Aspekte gleichzeitig abklopfen will. Damit deckt code_intel sowohl exakte als auch konzeptuelle Suche ab — das alte separate search(action:"code") wird nicht mehr gebraucht.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tree', 'functions', 'variables', 'symbols', 'references', 'search', 'search_batch', 'file', 'statements', 'calls', 'flow', 'entrypoints'],
          description: 'Aktion: tree|functions|variables|symbols|references|search|search_batch|file|statements|calls|flow|entrypoints',
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
        file_path: { type: 'string', description: 'Datei-Pfad-Filter (LIKE-Pattern, fuer functions/variables/symbols/file/statements/calls/entrypoints)' },
        name: { type: 'string', description: 'Symbol-Name-Filter (fuer functions/variables/symbols/references)' },
        exported_only: { type: 'boolean', description: 'Nur exportierte Funktionen zurueckgeben (fuer functions)' },
        with_values: { type: 'boolean', description: 'Wert-Spalte einschliessen (fuer variables)' },
        symbol_type: {
          type: 'string',
          enum: ['function', 'variable', 'string', 'comment', 'import', 'export', 'class', 'interface', 'enum', 'const_object', 'todo', 'route', 'sql_query', 'table', 'column', 'index', 'view', 'trigger', 'constraint'],
          description: 'Symbol-Typ fuer symbols-Action',
        },
        query: { type: 'string', description: 'Suchbegriff fuer search-Action' },
        semantic: { type: 'boolean', description: 'search: true = Qdrant-Embedding-Suche (konzeptuell/fuzzy). Default false = PG-Volltext (lexikalisch/exakt).' },
        queries: { type: 'array', items: { type: 'string' }, description: 'search_batch: 1..10 semantische Queries in EINEM Call. Embeddings werden gebatched an Google → spart N-1 API-Roundtrips. Antwort enthaelt results[] mit {query, count, hits}.' },
        limit_per_query: { type: 'number', description: 'search_batch: Max Hits pro Query (Default 5)' },
        file_type: { type: 'string', description: 'Dateityp-Filter fuer search-Action (z.B. "ts", "js")' },
        limit: { type: 'number', description: 'Max. Ergebnisse (search: Standard 20; entrypoints: Standard 200)' },
        include_declarations: { type: 'boolean', description: 'entrypoints: auch reine Deklarations-/Re-Export-Statements und SQL-Dateien liefern (Standard: false = nur echte Seiteneffekte)' },
        from_line: { type: 'number', description: 'file: Start-Zeile (1-basiert, Standard: 1)' },
        to_line: { type: 'number', description: 'file: End-Zeile inklusiv (Standard: letzte Zeile). Auto-Reduce bei > 80k Zeichen.' },
        truncate_long_lines: { type: 'number', description: 'file: Zeilen laenger als N Zeichen kuerzen + Marker. 0 = aus (Standard).' },
        scope: { type: 'string', description: 'Scope-Name-Filter fuer statements/flow (z.B. Funktionsname). Ohne scope bei flow: Top-Level-Ausfuehrung der Datei.' },
        callee: { type: 'string', description: 'callee_name-Filter fuer calls-Action (aufgerufener Funktions-/Methodenname).' },
        top_level_only: { type: 'boolean', description: 'Nur Top-Level-Statements zurueckgeben (fuer statements).' },
      },
      required: ['action', 'project'],
    },
  },

  // 15. files
  {
    name: 'files',
    description: 'Datei-CRUD im eigenen Projekt-Verzeichnis. Pfade sind relativ zum Projekt-Root und werden gegen Path-Traversal validiert. FileWatcher synchronisiert die Aenderungen automatisch. ENTSCHEIDUNGS-MATRIX (Write-Ops): (1) Datei darf NICHT existieren → action="create" (ohne upsert). (2) Datei wurde gelesen, gezielt modifizieren → action="update" mit anchor_text/anchor_contains aus dem gelesenen Snapshot (PFLICHT — Drift-Schutz; ohne Anker = Error). (3) Datei generieren/regenerieren ohne Pre-Read (Templates, Migrations, Codegen) → action="create" mit upsert:true (akzeptierst Drift-Risiko bewusst). (4) Punktuelle Aenderung statt Komplett-Rewrite → search_replace / replace_lines / insert_after / delete_lines. Multi-File Plan/Commit (action="plan"+"commit") fuer atomare Edits ueber mehrere Dateien mit Hash-Konflikt-Erkennung; auto_commit:true wechselt bei Multi-File auf per-File-Atomicity. restore_batch rollt komplette Plan-Sets zurueck. Erweiterte Optionen: agent_note, feature_tag/parent_version_id/git_commit_sha (Versions-Anreicherung). Keine freien absoluten Pfade, keine externen Systeme.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'move', 'copy', 'read', 'replace_lines', 'insert_after', 'delete_lines', 'search_replace', 'search_replace_batch', 'versions', 'get_version', 'restore', 'restore_batch', 'plan', 'commit', 'cancel', 'plan_status', 'history'],
          description: 'Datei-Aktion. versions/get_version/restore/restore_batch arbeiten auf der Versionshistorie. plan/commit/cancel/plan_status implementieren atomare Multi-File-Edits ueber mehrere Dateien. history listet Aenderungen mit Begruendung (Crash-Recovery) — agent_id wirkt dort als EXAKTER Filter, fuer die volle Projekt-History weglassen.',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        file_path: { type: 'string', description: 'Dateipfad relativ zum Projekt-Root. PFLICHT fuer create/update/delete/move/copy/read/replace_lines/insert_after/delete_lines/search_replace/search_replace_batch/versions/get_version/restore — OHNE file_path schlagen diese Aktionen fehl (niemals weglassen!). Nur plan/commit/cancel/plan_status/history/restore_batch brauchen es nicht (Pfade stehen dort in ops[]/batch_id).' },
        content: { type: 'string', description: 'Dateiinhalt. PFLICHT fuer create/update/replace_lines/insert_after.' },
        new_path: { type: 'string', description: 'Neuer Pfad (fuer move, copy)' },
        line_start: { type: 'number', description: 'Start-Zeile (fuer replace_lines, delete_lines)' },
        line_end: { type: 'number', description: 'End-Zeile (fuer replace_lines, delete_lines)' },
        after_line: { type: 'number', description: 'Nach dieser Zeile einfuegen (fuer insert_after)' },
        search: { type: 'string', description: 'Suchtext (fuer search_replace)' },
        replace: { type: 'string', description: 'Ersetzungstext (fuer search_replace)' },
        edits: {
          type: 'array',
          description: 'Edits fuer search_replace_batch (1..50 Elemente)',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Exakter Suchstring' },
              replace: { type: 'string', description: 'Ersetzungsstring' },
              replace_all: { type: 'boolean', description: 'Alle Vorkommen ersetzen (default: false)' },
            },
            required: ['search', 'replace'],
          },
        },
        from_line: { type: 'number', description: 'read: Start-Zeile (1-basiert, Standard: 1)' },
        to_line: { type: 'number', description: 'read: End-Zeile inklusiv (Standard: letzte Zeile). Auto-Reduce bei > 80k Zeichen.' },
        truncate_long_lines: { type: 'number', description: 'read: Zeilen laenger als N Zeichen kuerzen + Marker. 0 = aus (Standard).' },
        version_id: { type: 'string', description: 'Versions-ID (BIGSERIAL als String). Pflicht fuer get_version/restore. Bei history (): zeigt Korrektur-Chain ab dieser Version (rekursiv via parent_version_id).' },
        batch_id: { type: 'string', description: 'Batch-ID (fuer restore_batch — rollt alle Files einer Multi-File-Batch zurueck).' },
        plan_id: { type: 'string', description: 'Plan-ID (fuer commit, cancel, plan_status). String wegen BIGSERIAL.' },
        agent_id: { type: 'string', description: 'Optional: Audit-Agent fuer file_versions. Bei Web-KI-Calls ohne Wrapper wird agent_id aus User-Agent/X-Openai-Session abgeleitet (z.B. "gpt-<8charsessionid>"). DARF weggelassen oder leer sein — Server ergaenzt automatisch. AUSNAHME action=history: dort wirkt agent_id als EXAKTER Read-Filter — fuer die volle Projekt-History weglassen!' },
        agent_filter: { type: 'string', description: 'Nur fuer history: expliziter exakter Agent-Filter (bevorzugt gegenueber agent_id-als-Filter)' },
        ops: {
          type: 'array',
          description: 'Multi-File Edit-Plan: 1..100 Operationen ueber mehrere Dateien. Aktionen: create, update, search_replace, search_replace_batch, replace_lines, insert_after, delete_lines, delete (ganze Datei), move (-> new_path), copy (-> new_path).',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              action: { type: 'string', enum: ['create', 'update', 'search_replace', 'search_replace_batch', 'replace_lines', 'insert_after', 'delete_lines', 'delete', 'move', 'copy'] },
              new_path: { type: 'string' },
              reason: { type: 'string' },
              content: { type: 'string' },
              search: { type: 'string' },
              replace: { type: 'string' },
              replace_all: { type: 'boolean' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    search: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean' },
                  },
                  required: ['search', 'replace'],
                },
              },
              line_start: { type: 'number' },
              line_end: { type: 'number' },
              after_line: { type: 'number' },
              shift_mode: { type: 'string', enum: ['auto', 'absolute'], description: 'Default "auto" = line-Ops auf gleicher Datei werden reverse-order appliziert (User gibt Zeilen aus Pre-Plan-Snapshot an). "absolute" = Op wird in Plan-Reihenfolge mit den angegebenen Zeilen auf den aktuellen Buffer-Stand bezogen.' },
              anchor_text: { type: 'string', description: 'Pre-flight Drift-Verifikation. Bei update: PFLICHT (anchor_text ODER anchor_contains) — Substring des aktuellen Datei-Inhalts. Bei line-Ops: Zielzeile muss diesen Text enthalten (.trim()-vergleich). Mismatch -> harter Error, KEINE Mutation.' },
              anchor_contains: { type: 'string', description: 'Wie anchor_text. Bei update: PFLICHT-Alternative zu anchor_text. Bei line-Ops: Substring-Match auf der Ziel-Zeile.' },
              upsert: { type: 'boolean', description: '(optional, nur fuer action="create"): wenn true und die Datei existiert bereits, wird der content als update ueberschrieben statt zu failen. Default false — bewusst opt-in damit KI nicht versehentlich existierende Files killt.' },
            },
            required: ['file_path', 'action'],
          },
        },
        open_for_coedit: { type: 'boolean', description: 'Optional fuer plan: ob andere Agenten Co-Edits vorschlagen duerfen (default true). Aktuell informational; Co-Edit-Mechanik kommt in Schritt 3.' },
        auto_commit: { type: 'boolean', description: '(optional fuer plan): wenn true, wird direkt nach plan() automatisch commit() aufgerufen — spart einen Tool-Call wenn kein User-Review vor commit gewuenscht. Versionierung bleibt aktiv (file_versions + batch_id), Rollback via restore_batch jederzeit moeglich.' },
        agent_note: { type: 'string', description: '(optional fuer plan/commit): KI-eigene Beobachtungen/Analyse zum Batch (zusaetzlich zum reason des Users). Wird in alle file_versions dieser Batch geschrieben. Empfohlen ab ≥3 Ops oder Multi-File Batches.' },
        reason: { type: 'string', description: 'Optionale Begruendung — landet in file_versions.reason und ist via "history"-Action abrufbar. Fuer Crash-Recovery nuetzlich.' },
        since: { type: 'string', description: 'history: ISO-Timestamp ab dem Eintraege gelistet werden.' },
        limit: { type: 'number', description: 'versions: Max Eintraege (Standard 50, Max 500).' },
        feature_tag: { type: 'string', description: 'Logischer Feature-Group-Tag (z.B. "idea-thought-task-link"). Wird in file_versions.feature_tag gespeichert. history(feature_tag=...) filtert danach.' },
        parent_version_id: { type: 'string', description: 'Referenziert vorherige Version, die dieses Edit korrigiert/ersetzt. BIGINT als String. Erlaubt Korrektur-Chain-Tracking.' },
        git_commit_sha: { type: 'string', description: 'Optionaler Git-Commit-SHA, der diese Aenderung im File-System repraesentiert.' },
      },
      required: ['action', 'project'],
    },
  },
  // 15b. files_batch — alias for files Multi-File-Plan/Commit (OpenAI-Cache-Buster)
  {
    name: 'files_batch',
    description: 'Atomare Multi-File-Edits ueber mehrere Dateien (Plan-Phase Trockenlauf, dann Commit alle gemeinsam). Identische Implementierung wie files-Tool, aber als eigenes Tool exponiert weil manche MCP-Clients (z.B. ChatGPT) die action-Enum vom files-Tool aggressiv cachen und neue Werte (plan/commit/cancel) nicht erkennen. Nutze dieses Tool wenn files(action: "plan") nicht mehr klappt. Erweiterte Optionen: auto_commit:true (plan+commit in einem Call), agent_note (KI-Beobachtungen pro Batch), ops[].anchor_text/anchor_contains (Pre-flight Drift-Schutz auf der Ziel-Zeile), feature_tag/parent_version_id/git_commit_sha (Versions-Anreicherung + history-Filter).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['plan', 'commit', 'cancel', 'plan_status', 'history', 'restore', 'restore_batch'],
          description: 'plan: Trockenlauf, gibt plan_id zurueck. commit: alle Ops atomar ausfuehren. cancel: Plan verwerfen. plan_status: Plan-Details. history: Aenderungs-Log. restore/restore_batch: Versionierungs-Rollback.',
        },
        project: { type: 'string', description: 'Projekt-Name' },
        ops: {
          description: 'Multi-File Edit-Plan (1..100 Operationen). Jede Op: { file_path, action, ...op-spezifische Felder }. Aktionen: create, update, search_replace, search_replace_batch, replace_lines (line_start/line_end/content), insert_after (after_line/content), delete_lines (line_start/line_end), delete (ganze Datei), move (file_path -> new_path), copy (file_path -> new_path). Multi-Op-auf-gleicher-Datei: per Default shift_mode="auto" → line-Ops werden reverse-order appliziert; ueberlappende Ranges sind ein harter Error vor jeder Mutation.',
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              action: { type: 'string', enum: ['create', 'update', 'search_replace', 'search_replace_batch', 'replace_lines', 'insert_after', 'delete_lines', 'delete', 'move', 'copy'] },
              content: { type: 'string' },
              search: { type: 'string' },
              replace: { type: 'string' },
              replace_all: { type: 'boolean' },
              line_start: { type: 'number' },
              line_end: { type: 'number' },
              after_line: { type: 'number' },
              shift_mode: { type: 'string', enum: ['auto', 'absolute'], description: 'Default "auto" = line-Ops auf gleicher Datei werden reverse-order appliziert (User gibt Zeilen aus Pre-Plan-Snapshot an). "absolute" = Op wird in Plan-Reihenfolge mit den angegebenen Zeilen auf den aktuellen Buffer-Stand bezogen.' },
              anchor_text: { type: 'string', description: '(optional): Pre-flight Verifikation — pruefe dass die Ziel-Zeile (line_start fuer replace/delete, after_line fuer insert) exakt diesen Text enthaelt (.trim()-vergleich). Mismatch -> harter Error, KEINE Mutation.' },
              anchor_contains: { type: 'string', description: '(optional): Wie anchor_text, aber Substring-Match statt Exact.' },
              upsert: { type: 'boolean', description: '(optional, nur fuer action="create"): wenn true und die Datei existiert bereits, wird der content als update ueberschrieben statt zu failen. Default false — bewusst opt-in damit KI nicht versehentlich existierende Files killt.' },
              new_path: { type: 'string' },
              reason: { type: 'string' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    search: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean' },
                  },
                  required: ['search', 'replace'],
                },
              },
            },
            required: ['file_path', 'action'],
          },
        },
        plan_id: { type: 'string', description: 'Pflicht fuer commit, cancel, plan_status' },
        version_id: { type: 'string', description: 'Pflicht fuer restore' },
        batch_id: { type: 'string', description: 'Pflicht fuer restore_batch' },
        agent_id: { type: 'string', description: 'Optionale Agent-ID (Audit-Trail). AUSNAHME action=history: wirkt als exakter Read-Filter — fuer volle Projekt-History weglassen.' },
        agent_filter: { type: 'string', description: 'Nur fuer history: expliziter exakter Agent-Filter (bevorzugt gegenueber agent_id-als-Filter)' },
        open_for_coedit: { type: 'boolean', description: 'plan: ob Co-Edits erlaubt sind (default true)' },
        auto_commit: { type: 'boolean', description: 'plan + commit in einem Call (default false). Versionierung bleibt aktiv.' },
        agent_note: { type: 'string', description: '(optional): KI-eigene Beobachtungen pro Batch (zusaetzlich zum User-reason).' },
        reason: { type: 'string', description: 'Optional fuer Audit-Trail (file_versions.reason)' },
        since: { type: 'string', description: 'history: ISO-Timestamp ab dem Eintraege gelistet werden' },
        file_path: { type: 'string', description: 'history: Filter auf einen Pfad (optional)' },
        limit: { type: 'number', description: 'history: Max Eintraege (Standard 50)' },
        feature_tag: { type: 'string', description: 'Logischer Feature-Group-Tag (z.B. "idea-thought-task-link"). history(feature_tag=...) filtert danach.' },
        parent_version_id: { type: 'string', description: 'Referenziert vorherige Version. BIGINT als String.' },
        git_commit_sha: { type: 'string', description: 'Optionaler Git-Commit-SHA.' },
      },
      required: ['action', 'project'],
    },
  },
  // 16. shell
  {
    name: 'shell',
    description: 'Shell-Kommando im Projekt-Verzeichnis ausfuehren. AUTO-ROUTING (Default): laeuft ein lokaler FileWatcher-Daemon (frischer Heartbeat <30s) → Job geht via shell-queue an den Daemon (echtes FS, native Tools, git/sudo/GPU verfuegbar). Sonst → exec im Workspace-Docker-Container auf der synapse-api (isoliert, Source read-only). Antwort enthaelt executed_via: "local"|"workspace" damit die KI sieht wo es lief. EXPLIZIT erzwingen: isolated:true (oder target:"workspace") zwingt Container — sinnvoll fuer isolierte Tests, Build-Sandboxing, dependency-Experimente. target:"local" zwingt Daemon (Error wenn keiner aktiv). cwd ist auf das Projekt-Root + optional cwd_relative beschraenkt. WICHTIG: Source-Files in beiden Modi via files-Tool editieren (Auto-Versionierung; im Workspace ist Source mode 0444). shell ist fuer install/build/test/git/etc.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['exec', 'get_stream', 'history', 'get', 'log', 'activity'], description: 'Default: exec. log + id liefert Zeilenrange (1-100); log + id + query liefert Such-Treffer mit Zeilennummern.' },
        id: { type: 'string', description: 'Job-UUID (Pflicht fuer get/log). NICHT die stream_id aus der exec-Antwort — die Job-UUID liefert shell(history).' },
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
        agent_ids: { type: 'array', items: { type: 'string' }, description: 'activity: Filter auf Agenten (Namen ODER IDs, z.B. ["sub-r0"]). Ohne = alle.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'activity: Filter auf Tools (z.B. ["files","memory"]). Ohne = alle Tools interleaved.' },
        detail: { type: 'string', enum: ['meta', 'summary', 'full'], description: 'activity: Rueckgabe-Tiefe. meta(Default)=ohne result; summary=+Vorschau; full=result bis Cap.' },
        mutations_only: { type: 'boolean', description: 'activity: nur Schreibzugriffe (files.create/update, memory.write, ...).' },
        errors_only: { type: 'boolean', description: 'activity: nur fehlgeschlagene Calls.' },
        since: { type: 'string', description: 'activity: ISO-Timestamp — nur Eintraege ab dann.' },
        cwd_relative: { type: 'string', description: 'Unterpfad innerhalb des Projekt-Roots' },
        agent_id: { type: 'string', description: 'exec: Attribution — welcher Agent den Job absetzt. Taucht in shell(history) + shell(activity) auf. Optional: Cloud leitet es aus dem Header ab, Spezialisten aus SYNAPSE_AGENT_NAME.' },
        target: { type: 'string', enum: ['auto', 'local', 'workspace'], description: 'exec: "auto" (Default, Heartbeat-basiert) | "local" (Daemon erzwingen) | "workspace" (Docker-Container erzwingen)' },
        isolated: { type: 'boolean', description: 'exec: Kurzform fuer target="workspace" — fuer isolierte Tests im Docker-Container (Default false)' },
        workspace: { type: 'string', description: 'exec: WS3 — benannter Ziel-Workspace im Container-Modus (Default "main"). Mit workspace:"server" laeuft das Kommando im server-Container des Projekts (DNS synapse-ws-<projekt>-server). Wirkt nur bei target=workspace/isolated.' },
      },
      required: ['action'],
    },
  },
  // 17. code_check
  {
    name: 'code_check',
    description: 'Eigene Fehler-Pattern-Bibliothek im Projekt-Workspace: bekannte Fehler + Loesungen registrieren, listen, eintragen-entfernen. Patterns werden bei lokalen Code-Schreib-Operationen automatisch herangezogen. Eigene lokale Datenbank, keine externen Systeme.',
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
  // 20. workspace — pro-Projekt Docker-Container fuer Shell + File-Sync (server-seitig auf Unraid)
  {
    name: 'workspace',
    description: 'Lifecycle-Management der pro-Projekt Docker-Sandbox-Container (synapse-workspace:latest) auf dem Synapse-Server. ⚠️ FUER SHELL-AUSFUEHRUNG: nutze IMMER das shell-Tool (Auto-Routing: lokaler Daemon vs Workspace; isolated:true fuer Container-Erzwingung). Dieses workspace-Tool ist nur fuer Lifecycle: list (Status aller Container), start/stop (manuell), pin/unpin (vor Idle-Eviction schuetzen), materialize (FULL sync PG→Container — selten noetig, Auto-Sync laeuft via PG-LISTEN/NOTIFY). exec-Action existiert noch, aber lieber shell({isolated:true}) verwenden — gleiche Engine, einheitliche Antwort, executed_via-Feld. WORKFLOW: Files via files-Tool in code_files → automatisch in Container synchronisiert. Source-Files im /workspace sind READ-ONLY (mode 0444); install/build schreiben in /workspace/node_modules bzw. /workspace/dist (writable). Lifecycle: Idle-Stop nach 10 Min, LRU-Eviction bei Cap. 🌐 NETZWERK: Jede Workspace-Response liefert dns_name (z.B. "synapse-ws-<project>"). Andere proxynet-Container (insbesondere ki-browser) erreichen den Workspace via http://<dns_name>:<port> — NIE die Container-IP nutzen, die wechselt bei Restart. Actions: list, start, stop, pin, unpin, materialize, exec (deprecated → shell), commit (deprecated → files-Tool), configure (cpu_limit/mem_limit_mb/pids_limit/tmpfs_mb/image pro Projekt setzen — greift beim naechsten Container-Start; fuer Build-/Test-Szenarien z.B. mem_limit_mb: 2048, tmpfs_mb: 1024), reset_home (HOME-Volume /home/synapse zuruecksetzen — Selbstheilung wenn npm/pip/cargo/rustup-Caches oder Configs im persistenten Home kaputt sind; stoppt den Container, /workspace bleibt unberuehrt), make_writable (Pfad unterhalb /workspace fuer Build-Artefakte freigeben — chown auf synapse via root-exec; noetig weil der PG-Sync Source-Files als root/0444 anlegt, das Volume selbst ist rw; z.B. path: compiler/target). 🔀 WS3 MULTI-WORKSPACE + WS4 ROLLEN: Benannte Workspaces pro Projekt (Cap ENV SYNAPSE_WS_PER_PROJECT_CAP, Default 6). Rolle = Template (role_set/role_list/role_delete; project weglassen = global), Workspace = Instanz: start/exec mit role:"db-postgres" + name:"db-1" instanziiert ein Template — beliebig oft (db-1, db-2, app, qa, ...), init_command faehrt Dienste nach jedem Start hoch. So entstehen Multi-Geraete-Setups (db ↔ app ↔ wine-qa) im selben proxynet (Param name, Default "main") — z.B. Backend in name:"server", App/Client in name:"app". Alle teilen /workspace (eine Quelle, ein Sync), haben aber EIGENES Home-Volume, eigene Caps und eigenes Image (configure mit name). Sie erreichen sich gegenseitig ueber proxynet-DNS: main = http://synapse-ws-<projekt>:<port> (unveraendert), benannte = http://synapse-ws-<projekt>-<name>:<port>. Use-Case: Backend in "server" starten (exec mit expose_ports), aus "app" oder main per curl dagegen testen — Netzwerk-Integrationstest wie im echten Einsatz, ohne die Sandbox zu verlassen. 🔐 WS5 CONTAINER-BUILDS: Rolle container-builder (Tier-2-Image synapse-workspace-podman:latest) baut/testet Dockerfiles + docker-compose der User-Projekte mit rootless Podman (docker = podman-Alias, daemonless, fuse-overlayfs, Storage im HOME-Volume). Privilegierte Rollen-Optionen (devices/security_opts via role_set) wirken NUR wenn die Rolle in ENV SYNAPSE_WS_PRIVILEGED_ROLES (Komma-Liste) allowlisted ist — sonst verweigert der Orchestrator den Container-Start hart. Kein --privileged, kein docker.sock-Mount — gibt es bewusst nicht.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'start', 'stop', 'pin', 'unpin', 'exec', 'materialize', 'commit', 'configure', 'reset_home', 'make_writable', 'role_set', 'role_list', 'role_delete'], description: 'Aktion' },
        role: { type: 'string', description: 'WS4 Rollen-Template. Bei start/exec: Template fuer die ERST-Anlage der Instanz (name frei waehlbar; eine Rolle ist beliebig oft instanziierbar — db-1, db-2, app, qa, ...). Bei role_set/role_delete: Name der Rolle (^[a-z0-9][a-z0-9-]{0,29}$). Rollen sind NIE fest: role_set ueberschreibt; project weglassen = globale Rolle, projekt-scoped schlaegt global.' },
        init_command: { type: 'string', description: 'Nur role_set: Kommando das nach JEDEM Container-Start einer Instanz dieser Rolle laeuft (User synapse, 120s Timeout) — Dienste-Bootstrap, z.B. initdb + pg_ctl start. Fehler -> last_error, Container bleibt nutzbar.' },
        description: { type: 'string', description: 'Nur role_set: Kurzbeschreibung der Rolle.' },
        devices: { type: 'array', items: { type: 'string' }, description: 'Nur role_set (WS5): Geraete-Whitelist der Rolle — erlaubt sind ausschliesslich /dev/fuse, /dev/kvm, /dev/net/tun. Wirkt NUR wenn die Rolle in ENV SYNAPSE_WS_PRIVILEGED_ROLES steht, sonst verweigert der Start. Leeren: role_delete + role_set neu (leeres Array wird als nicht-gesetzt behandelt).' },
        security_opts: { type: 'array', items: { type: 'string' }, description: 'Nur role_set (WS5): SecurityOpt-Whitelist — erlaubt sind ausschliesslich seccomp=unconfined, apparmor=unconfined, label=disable. Gleiches ENV-Gate wie devices. --privileged und docker.sock existieren bewusst NICHT.' },
        name: { type: 'string', description: 'WS3: Benannter Workspace innerhalb des Projekts (Default "main"). Cap pro Projekt via ENV SYNAPSE_WS_PER_PROJECT_CAP (Default 6), Regex ^[a-z0-9][a-z0-9-]{0,19}$. Gilt fuer start/stop/pin/unpin/exec/configure/reset_home. DNS: main=synapse-ws-<projekt>, sonst synapse-ws-<projekt>-<name>.' },
        path: { type: 'string', description: 'make_writable: relativer Pfad unterhalb /workspace, der fuer User synapse schreibbar gemacht wird (chown -R + u+rwX, mkdir -p inklusive). Fuer BUILD-ARTEFAKTE gedacht (z.B. compiler/target, build, dist) — der PG-Sync legt Source-Files als root/0444 an, das /workspace-Volume selbst ist rw. Kein "..", nicht "." (Komplett-Freigabe verboten). Source-Edits weiterhin via files-Tool.' },
        project: { type: 'string', description: 'Projekt-Name (Pflicht ausser bei list)' },
        command: { type: 'string', description: 'Shell-Kommando fuer exec (Pflicht bei exec)' },
        timeout_ms: { type: 'number', description: 'exec: Hard-Timeout in ms (Default 60000)' },
        working_dir: { type: 'string', description: 'exec: alternativer WorkingDir (Default /workspace)' },
        expose_ports: { type: 'array', items: { type: 'number' }, description: 'exec: gewuenschte Container-Ports — Response liefert internal_urls mit DNS-Namen "http://synapse-ws-<project>:<port>", erreichbar von anderen proxynet-Containern (z.B. ki-browser). Kein Host-Port, keine Konflikte.' },
        ignore_patterns: { type: 'array', items: { type: 'string' }, description: 'materialize/commit: glob-Patterns die uebersprungen werden (Default: node_modules, .git, dist, build, target, .next, coverage, __pycache__, ...)' },
        cpu_limit: { type: 'number', description: 'configure: CPU-Kerne (0-32, z.B. 2)' },
        mem_limit_mb: { type: 'number', description: 'configure: RAM-Limit in MB (min 128)' },
        pids_limit: { type: 'number', description: 'configure: max. Prozesse (min 16)' },
        tmpfs_mb: { type: 'number', description: 'configure: /tmp-Groesse in MB (min 16, Default 256)' },
        image: { type: 'string', description: 'configure: Docker-Image fuer dieses Projekt (Default synapse-workspace:latest)' },
      },
      required: ['action'],
    },
  },
  // 21. skills (EXPERIMENTAL) — Zugriff auf User-eigene Skill-DB (Qdrant collection 'skills')
  {
    name: 'skills',
    description: 'EXPERIMENTAL: Direkter Lese-Zugriff auf die User-Skill-Datenbank (Qdrant collection "skills" auf Unraid). Ersetzt das vorherige Pattern "via shell ein Node-Skript starten" — KI kann jetzt direkt search/list/get. ⚠️ EXPERIMENTAL weil die Skill-DB in einer kommenden Iteration umgebaut wird (Trennung private vs allgemeine Skills) — die Action-Signatur kann sich aendern. Actions: search (semantic, default 5 hits; optional skill_name-Filter → nur innerhalb eines Skills semantisch suchen), list (alle skill_names + section_counts, optional gefiltert auf 1 skill_name fuer dessen Sections), get_section (skill_name + section → content + tags), get_full (alle sections eines skills bulk, deterministisch, alphabetisch sortiert).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'list', 'get_section', 'get_full'], description: 'search | list | get_section | get_full' },
        query: { type: 'string', description: 'search: Suchbegriff (semantisch)' },
        skill_name: { type: 'string', description: 'search (optional, filter): nur innerhalb 1 Skills semantisch suchen. list (optional, filter): nur Sections eines Skills. get_section/get_full: Pflicht.' },
        section: { type: 'string', description: 'get_section: Section-Name (Pflicht)' },
        limit: { type: 'number', description: 'search: max Hits (Default 5, Max 20)' },
      },
      required: ['action'],
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
 * Liest ein Number-Array. Akzeptiert Array, JSON-String, Single-Number/-String.
 * Strings werden via Number() konvertiert (NaN-filter).
 */
function numArray(a: Record<string, unknown>, k: string): number[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  const toNum = (x: unknown): number | null => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '') {
      const n = Number(x);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  if (Array.isArray(v)) {
    const out = v.map(toNum).filter((x): x is number => x !== null);
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const out = parsed.map(toNum).filter((x): x is number => x !== null);
          return out.length > 0 ? out : undefined;
        }
      } catch { /* fall through */ }
    }
    const single = toNum(trimmed);
    return single !== null ? [single] : undefined;
  }
  const single = toNum(v);
  return single !== null ? [single] : undefined;
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
// Aus Request-Headern eine Agent-ID ableiten (Web-KIs ohne Wrapper-Kontext).
// OpenAI/ChatGPT: User-Agent "openai-mcp/*" + X-Openai-Session "v1/<token>".
//   → agent_id = "gpt-" + first8(session-token), pro ChatGPT-Konversation stabil.
// Claude: liefert keinen stable User-/Session-Identifier — hier kein Auto-Detect.
function deriveAgentIdFromHeaders(headers: Record<string, unknown>): string | undefined {
  const ua = String(headers['user-agent'] || '').toLowerCase();
  if (ua.startsWith('openai-mcp')) {
    const session = String(headers['x-openai-session'] || '');
    const m = session.match(/v1\/([A-Za-z0-9]{8})/);
    if (m) return `gpt-${m[1].toLowerCase()}`;
    return 'gpt-web';
  }
  return undefined;
}

// =====================================================================
// REST-Onboarding — Projekt-Regeln einmal pro (Agent, Projekt, Prozess)
// =====================================================================
// Gleiches Gedaechtnis wie der MCP-Server: registerAgent() schreibt in die
// PG-Tabelle agent_onboardings (PK agent_id, project, server_instance_id) —
// lokaler MCP-stdio-Pfad und REST-API-Pfad teilen sich damit den Stand.
// Bewusst OHNE Dateisystem-Check (status.json existiert im Container nicht)
// und ohne ensureHandoffRules (Auto-Inject bleibt Sache des MCP-Servers).
const REST_INSTANCE_ID = randomUUID();

type RestAgentRole = 'koordinator' | 'spezialist' | 'subagent';

async function attachRestOnboarding(
  result: unknown,
  args: Record<string, unknown>
): Promise<unknown> {
  const agentId = typeof args.agent_id === 'string' ? args.agent_id : undefined;
  const project = typeof args.project === 'string' ? args.project : undefined;
  if (!agentId || !project) return result;
  // Nur plain Objects erweiterbar — Arrays/Primitives unveraendert durchreichen
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;

  try {
    const isFirstVisit = await registerAgent(project, agentId, REST_INSTANCE_ID);
    if (!isFirstVisit) return result;

    // Rollenerkennung identisch zum MCP-Server (tools/onboarding.ts)
    const role: RestAgentRole =
      args.role === 'koordinator' || args.role === 'spezialist' || args.role === 'subagent'
        ? args.role
        : agentId === 'koordinator' || agentId.startsWith('koordinator-')
          ? 'koordinator'
          : agentId.startsWith('spezialist-') || agentId.startsWith('specialist-')
            ? 'spezialist'
            : 'subagent';

    const allRules = await getRulesForNewAgent(project);
    const rules = allRules
      .filter((m) => {
        const tags = m.tags || [];
        if (tags.includes('coordinator-only') && role !== 'koordinator') return false;
        if (tags.includes('specialist-only') && role !== 'spezialist') return false;
        if (tags.includes('subagent-only') && role !== 'subagent') return false;
        return true;
      })
      .map((m) => ({ name: m.name, content: m.content }));

    if (rules.length === 0) {
      return { ...result, agentOnboarding: { isFirstVisit: true } };
    }

    return {
      ...result,
      agentOnboarding: {
        isFirstVisit: true,
        message: '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:',
        rules,
      },
    };
  } catch {
    // Onboarding darf nie den Tool-Call brechen
    return result;
  }
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const action = str(args, 'action');

  switch (name) {
    // =================================================================
    // 1. PROJECT
    // =================================================================
    case 'project': {
      switch (action) {
        case 'init': {
          const explicitPath = str(args, 'path');
          const requestedName = str(args, 'name');
          const indexDocs = bool(args, 'index_docs') !== false;
          const requestedBy = resolveAgentId(str(args, 'agent_id')) ?? undefined;

          // Self-Service: Wenn kein path gegeben ist aber ein Name, queue an den
          // FileWatcher-Daemon auf dem Ziel-PC. Der legt das Verzeichnis unter
          // SYNAPSE_WORKSPACE_ROOT an, registriert es in PG, startet den Watcher.
          if (!explicitPath) {
            if (!requestedName) {
              return {
                success: false,
                error: 'missing_arguments',
                message: 'Mindestens "name" oder "path" muss gesetzt sein.',
              };
            }
            if (!isValidProjectName(requestedName)) {
              return {
                success: false,
                error: 'invalid_name',
                message: `Projekt-Name "${requestedName}" ist ungueltig. Erlaubt: 2-64 Zeichen, [a-zA-Z0-9_-], beginnt mit Buchstabe/Ziffer.`,
              };
            }
            const hostname = str(args, 'hostname');
            const template = str(args, 'template');
            const { id: jobId } = await enqueueProjectInitJob({
              name: requestedName,
              hostname,
              template,
              requested_by: requestedBy,
            });
            const job = await waitForProjectInitJob(jobId, 35_000);
            // Sicherheits-Cleanup falls kein Daemon laeuft — markiert >30s alte
            // pending Jobs als timeout (verhindert dass Jobs ewig haengen).
            if (job.status === 'pending' || job.status === 'running') {
              try { await expirePendingProjectInitJobs(30); } catch { /* best-effort */ }
            }

            if (job.status === 'done' && job.resolved_path) {
              let techs: Awaited<ReturnType<typeof detectTechnologies>> = [];
              let docsIndexed = 0;
              if (indexDocs) {
                try {
                  techs = await detectTechnologies(job.resolved_path);
                  const result = await indexProjectTechnologies(techs);
                  docsIndexed = result.indexed;
                } catch {
                  // Tech-Detection vom REST-Container aus kann ohne FS-Zugriff scheitern — kein Fail.
                }
              }
              return {
                success: true,
                project: job.name,
                path: job.resolved_path,
                technologies: techs,
                docsIndexed,
                job_id: job.id,
                message: job.message ?? `Projekt "${job.name}" angelegt unter ${job.resolved_path}.`,
              };
            }

            // pending nach Wait = Daemon hat sich nicht gemeldet
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

          // Bestehender Pfad-Modus (Doku-Indexierung ohne Anlegen).
          const projectName = requestedName || explicitPath.split(/[/\\]/).pop() || 'unknown';
          let techs: Awaited<ReturnType<typeof detectTechnologies>> = [];
          let docsIndexed = 0;

          if (indexDocs) {
            techs = await detectTechnologies(explicitPath);
            const result = await indexProjectTechnologies(techs);
            docsIndexed = result.indexed;
          }

          return {
            success: true,
            project: projectName,
            path: explicitPath,
            technologies: techs,
            docsIndexed,
            message: `Projekt "${projectName}" - Docs indexiert (FileWatcher nicht verfuegbar ueber HTTP)`,
          };
        }
        case 'init_status': {
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
          // Akzeptiert path ODER project (Web-KIs uebergeben oft project statt path).
          const raw = str(args, 'project') ?? str(args, 'path');
          if (!raw) return { success: false, error: 'project oder path erforderlich' };
          const projectName = raw.split(/[/\\]/).pop() || raw;
          const codeStats = await getProjectStats(projectName);
          return { success: true, stats: codeStats };
        }
        case 'list': {
          const collections = await listCollections();
          const projects = collections
            .filter(c => c.startsWith('project_'))
            .map(c => c.replace('project_', ''));
          return { success: true, count: projects.length, projects };
        }
        case 'enable':
        case 'disable': {
          const project = str(args, 'project') ?? str(args, 'name');
          if (!project) return { success: false, error: 'project erforderlich' };
          const enabled = action === 'enable';
          await setProjectEnabled(project, enabled);
          return {
            success: true,
            project,
            enabled,
            message: `Projekt "${project}" ${enabled ? 'aktiviert' : 'deaktiviert'} (PG = Source of Truth). Parser-Worker folgt sofort, FileWatcher-Daemon beim naechsten Sync.`,
          };
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
          // Bulk-Mode: items[] vorhanden → mehrere Memories in einem Call.
          type WriteItem = {
            name?: string;
            content?: string;
            category?: 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other';
            tags?: string[];
          };
          const items = objArray<WriteItem>(args, 'items');
          if (items && items.length > 0) {
            const results: Array<{ index: number; ok: boolean; name?: string; isUpdate?: boolean; error?: string }> = [];
            let applied = 0;
            let failed = 0;
            for (let i = 0; i < items.length; i++) {
              const it = items[i];
              try {
                if (!it.name || typeof it.name !== 'string') throw new Error('name fehlt oder ist kein String');
                if (!it.content || typeof it.content !== 'string') throw new Error('content fehlt oder ist kein String');
                const tags = Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string') : [];
                const existing = await getMemoryByName(project, it.name);
                await writeMemory(project, it.name, it.content, it.category ?? 'note', tags);
                results.push({ index: i, ok: true, name: it.name, isUpdate: !!existing });
                applied++;
              } catch (err) {
                results.push({ index: i, ok: false, name: typeof it.name === 'string' ? it.name : undefined, error: (err as Error).message });
                failed++;
              }
            }
            return {
              success: failed === 0,
              total: items.length,
              applied,
              failed,
              results,
              message: `${applied}/${items.length} Memories gespeichert${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
            };
          }
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
          const all = await listMemories(project, category);
          // DX-Befund 3: ohne Limit war list bei 200+ Memories ein Context-Killer.
          const listLimit = Math.max(1, num(args, 'limit') ?? 100);
          const sliced = all.slice(0, listLimit);
          const namesOnly = args.names_only === true;
          return {
            memories: namesOnly
              ? sliced.map(m => m.name)
              : sliced.map(m => ({
                  name: m.name, category: m.category, tags: m.tags,
                  sizeChars: m.content.length, updatedAt: m.updatedAt,
                })),
            total: all.length,
            truncated: all.length > sliced.length,
            ...(all.length > sliced.length
              ? { tip: `${all.length} Memories insgesamt, ${sliced.length} geliefert — limit erhoehen, category filtern, names_only: true nutzen oder gezielt search(action: "memory").` }
              : {}),
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
          const project = reqStr(args, 'project');
          const source = resolveAgentId(str(args, 'source'));
          if (!source) throw new Error('Parameter "source" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
          const result = await addThought(
            project, source,
            reqStr(args, 'content'), strArrayOrEmpty(args, 'tags'),
            str(args, 'task_id'),
            str(args, 'task_status') as Parameters<typeof addThought>[5]
          );
          // Anti-Echo (DX-Befund 4): nicht den kompletten Content zurueckspielen,
          // den der Agent gerade selbst geschrieben hat — id + Preview reichen.
          const t = result as unknown as { id: string; tags?: string[]; timestamp?: string; content: string };
          const trimmed = {
            success: true,
            id: t.id,
            tags: t.tags,
            timestamp: t.timestamp,
            content_length: t.content.length,
            content_preview: t.content.length > 120 ? `${t.content.slice(0, 120)}…` : t.content,
            message: `Gedanke gespeichert von "${source}"`,
          };
          if (args.trigger_respawn === true) {
            const { maybeTriggerRespawn } = await import('@synapse/core');
            const decision = await maybeTriggerRespawn(project, source);
            return {
              ...trimmed,
              respawn: { triggered: decision.triggered, message: decision.message },
            };
          }
          return trimmed;
        }
        case 'add_batch': {
          const project = reqStr(args, 'project');
          const source = resolveAgentId(str(args, 'source'));
          if (!source) throw new Error('Parameter "source" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
          const items = objArray<{ content: string; tags?: string[] }>(args, 'items');
          if (!items || items.length === 0) {
            return { success: false, count: 0, thoughts: [], message: 'items (Array) ist erforderlich' };
          }
          if (items.length > 50) {
            return { success: false, count: 0, thoughts: [], message: `Batch-Limit: Max 50 Items, ${items.length} angegeben` };
          }
          const normalized = items
            .map(it => ({
              content: String(it.content ?? ''),
              tags: Array.isArray(it.tags) ? it.tags.map(String) : undefined,
              task_id: typeof (it as unknown as { task_id?: unknown }).task_id === 'string' ? (it as unknown as { task_id: string }).task_id : undefined,
            }))
            .filter(it => it.content.length > 0);
          if (normalized.length === 0) {
            return { success: false, count: 0, thoughts: [], message: 'Keine gueltigen Items (content fehlt oder leer)' };
          }
          const { addThoughtsBatch } = await import('@synapse/core');
          const result = await addThoughtsBatch(
            project,
            source as Parameters<typeof addThoughtsBatch>[1],
            normalized,
            str(args, 'task_status') as Parameters<typeof addThoughtsBatch>[3]
          );
          return {
            success: true,
            count: result.thoughts.length,
            ids: result.thoughts.map(t => t.id),
            // Anti-Echo (DX-Befund 4): nur Previews statt vollem Content
            thoughts: result.thoughts.map(t => ({
              id: t.id,
              tags: t.tags,
              content_preview: t.content.length > 120 ? `${t.content.slice(0, 120)}…` : t.content,
            })),
            warning: result.warning,
            message: `${result.thoughts.length} Gedanken gespeichert von "${source}" (Batch)`,
          };
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
        case 'get': {
          const plan = await getPlan(project);
          if (!plan) return { message: 'Kein Plan gefunden' };
          // DX-Befund 5: Vollabwurf vermeiden — status-Filter, compact, limit.
          const p = plan as unknown as Record<string, unknown> & { tasks?: Array<Record<string, unknown>> };
          const allTasks = Array.isArray(p.tasks) ? p.tasks : [];
          const statusFilter = str(args, 'status');
          const filtered = statusFilter ? allTasks.filter(t => t.status === statusFilter) : allTasks;
          const taskLimit = num(args, 'limit');
          const limited = taskLimit && taskLimit > 0 ? filtered.slice(0, taskLimit) : filtered;
          const compact = args.compact === true;
          const tasks = compact
            ? limited.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }))
            : limited;
          return {
            ...p,
            tasks,
            tasks_total: allTasks.length,
            tasks_returned: tasks.length,
            ...(statusFilter ? { tasks_status_filter: statusFilter } : {}),
            ...(compact || tasks.length < allTasks.length
              ? { tip: 'Task-Liste gefiltert/kompakt — volle Descriptions via plan(get) ohne compact/status/limit.' }
              : {}),
          };
        }
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
        case 'update_task': {
          const taskId = reqStr(args, 'task_id');
          const { updateTask } = await import('@synapse/core');
          const updates: { title?: string; description?: string; status?: 'todo' | 'in_progress' | 'done' | 'blocked'; priority?: 'low' | 'medium' | 'high' } = {};
          const t = str(args, 'title'); if (t !== undefined) updates.title = t;
          const d = str(args, 'description'); if (d !== undefined) updates.description = d;
          const s = str(args, 'status'); if (s !== undefined) updates.status = s as 'todo' | 'in_progress' | 'done' | 'blocked';
          const p = str(args, 'priority'); if (p !== undefined) updates.priority = p as 'low' | 'medium' | 'high';
          const task = await updateTask(project, taskId, updates);
          if (!task) return { success: false, task: null, message: `Task nicht gefunden: ${taskId}` };
          return { success: true, task, message: 'Task aktualisiert' };
        }
        case 'delete_task': {
          const ids = strArray(args, 'task_id');
          if (!ids || ids.length === 0) {
            return { success: false, deleted: 0, message: 'task_id (String oder Array) ist erforderlich' };
          }
          if (ids.length > 50) {
            return { success: false, deleted: 0, message: `Batch-Limit: Max 50 Task-IDs, ${ids.length} angegeben` };
          }
          const { deleteTasks } = await import('@synapse/core');
          const result = await deleteTasks(project, ids);
          if (result.deleted === 0) {
            return { success: false, deleted: 0, message: `Keine passende Task gefunden in Projekt: ${project}` };
          }
          return { success: true, deleted: result.deleted, warning: result.warning, message: `${result.deleted} Tasks geloescht` };
        }
        case 'add_tasks_batch': {
          const tasks = objArray<{ title: string; description: string; priority?: string }>(args, 'tasks');
          if (!tasks || tasks.length === 0) {
            return { success: false, count: 0, tasks: [], message: 'tasks (Array) ist erforderlich' };
          }
          if (tasks.length > 50) {
            return { success: false, count: 0, tasks: [], message: `Batch-Limit: Max 50 Tasks, ${tasks.length} angegeben` };
          }
          const normalized = tasks
            .map(t => ({
              title: String(t.title ?? ''),
              description: String(t.description ?? ''),
              priority: (t.priority as 'low' | 'medium' | 'high' | undefined) ?? undefined,
            }))
            .filter(t => t.title.length > 0 && t.description.length > 0);
          if (normalized.length === 0) {
            return { success: false, count: 0, tasks: [], message: 'Keine gueltigen Tasks (title/description fehlt oder leer)' };
          }
          const { addTasksBatch } = await import('@synapse/core');
          const result = await addTasksBatch(project, normalized);
          if (result.tasks.length === 0) {
            return { success: false, count: 0, tasks: [], message: `Kein Plan gefunden fuer Projekt: ${project}` };
          }
          return {
            success: true,
            count: result.tasks.length,
            tasks: result.tasks,
            warning: result.warning,
            message: `${result.tasks.length} Tasks hinzugefuegt`,
          };
        }
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
        case 'create': {
          // Bulk-Mode
          type CreateItem = {
            file_path?: string;
            suggested_content?: string;
            description?: string;
            author?: string;
            tags?: string[];
          };
          const items = objArray<CreateItem>(args, 'items');
          if (items && items.length > 0) {
            const results: Array<{ index: number; ok: boolean; id?: string; error?: string }> = [];
            let applied = 0;
            let failed = 0;
            for (let i = 0; i < items.length; i++) {
              const it = items[i];
              try {
                if (!it.file_path) throw new Error('file_path fehlt');
                if (!it.suggested_content) throw new Error('suggested_content fehlt');
                if (!it.description) throw new Error('description fehlt');
                const resolvedAuthor = resolveAgentId(it.author ?? undefined);
                if (!resolvedAuthor) throw new Error('author fehlt (oder SYNAPSE_AGENT_NAME setzen)');
                const tags = Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string') : [];
                const proposal = await createProposal(project, it.file_path, it.suggested_content, it.description, resolvedAuthor, tags);
                results.push({ index: i, ok: true, id: proposal.id });
                applied++;
              } catch (err) {
                results.push({ index: i, ok: false, error: (err as Error).message });
                failed++;
              }
            }
            return {
              success: failed === 0,
              total: items.length,
              applied,
              failed,
              results,
              message: `${applied}/${items.length} Proposals erstellt${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
            };
          }
          // Single-Mode
          const filePath = reqStr(args, 'file_path');
          const suggested = reqStr(args, 'suggested_content');
          const desc = reqStr(args, 'description');
          const rawAuthor = str(args, 'author');
          const author = resolveAgentId(rawAuthor);
          if (!author) throw new Error('Parameter "author" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
          const tags = strArray(args, 'tags') ?? [];
          const proposal = await createProposal(project, filePath, suggested, desc, author, tags);
          return { success: true, proposal };
        }
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
          const senderId = resolveAgentId(str(args, 'sender_id'));
          if (!senderId) throw new Error('Parameter "sender_id" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
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
            agentId: str(args, 'agent_id') ?? undefined, // READ-FILTER: kein resolveAgentId
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
          const rawCreatedBy = str(args, 'created_by');
          const createdBy = resolveAgentId(rawCreatedBy);
          if (!createdBy) throw new Error('Parameter "created_by" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
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
          const rawSender = str(args, 'sender');
          const sender = resolveAgentId(rawSender);
          if (!sender) throw new Error('Parameter "sender" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
          // Bulk-Mode
          type PostItem = { content?: string };
          const messages = objArray<PostItem>(args, 'messages');
          if (messages && messages.length > 0) {
            const results: Array<{ index: number; ok: boolean; messageId?: number; error?: string }> = [];
            let applied = 0;
            let failed = 0;
            for (let i = 0; i < messages.length; i++) {
              const m = messages[i];
              try {
                if (!m.content) throw new Error('content fehlt');
                const r = await postChannelMessage(project, chName2, sender, m.content);
                if (!r) {
                  results.push({ index: i, ok: false, error: `Channel "${chName2}" nicht gefunden` });
                  failed++;
                } else {
                  results.push({ index: i, ok: true, messageId: r.id });
                  applied++;
                }
              } catch (err) {
                results.push({ index: i, ok: false, error: (err as Error).message });
                failed++;
              }
            }
            return {
              success: failed === 0,
              total: messages.length, applied, failed, results,
              message: `${applied}/${messages.length} Nachrichten in "${chName2}" gepostet${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
              action: 'post',
            };
          }
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
          const project = reqStr(args, 'project');
          const rawSourceId = str(args, 'source_id');
          const sourceId = resolveAgentId(rawSourceId);
          if (!sourceId) throw new Error('Parameter "source_id" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
          // Bulk-Mode
          type EmitItem = { event_type?: string; priority?: string; scope?: string; payload?: string; requires_ack?: boolean };
          const events = objArray<EmitItem>(args, 'events');
          if (events && events.length > 0) {
            const results: Array<{ index: number; ok: boolean; event_id?: number; error?: string }> = [];
            let applied = 0;
            let failed = 0;
            for (let i = 0; i < events.length; i++) {
              const e = events[i];
              try {
                if (!e.event_type) throw new Error('event_type fehlt');
                if (!e.priority) throw new Error('priority fehlt');
                const r = await emitEvent(
                  project,
                  e.event_type as 'WORK_STOP' | 'CRITICAL_REVIEW' | 'ARCH_DECISION' | 'TEAM_DISCUSSION' | 'ANNOUNCEMENT',
                  e.priority as 'critical' | 'high' | 'normal',
                  e.scope ?? 'all',
                  sourceId,
                  e.payload,
                  e.requires_ack,
                );
                const eid = (r as { event_id?: number; eventId?: number }).event_id ?? (r as { eventId?: number }).eventId;
                results.push({ index: i, ok: true, event_id: eid });
                applied++;
              } catch (err) {
                results.push({ index: i, ok: false, error: (err as Error).message });
                failed++;
              }
            }
            return {
              success: failed === 0,
              total: events.length,
              applied,
              failed,
              results,
              message: `${applied}/${events.length} Events emittiert${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
            };
          }
          const result = await emitEvent(
            project,
            reqStr(args, 'event_type') as 'WORK_STOP' | 'CRITICAL_REVIEW' | 'ARCH_DECISION' | 'TEAM_DISCUSSION' | 'ANNOUNCEMENT',
            reqStr(args, 'priority') as 'critical' | 'high' | 'normal',
            str(args, 'scope') ?? 'all',
            sourceId,
            str(args, 'payload'),
            bool(args, 'requires_ack')
          );
          return result;
        }
        case 'ack': {
          const rawAckAgentId = str(args, 'agent_id');
          const agentId = resolveAgentId(rawAckAgentId);
          if (!agentId) throw new Error('Parameter "agent_id" ist erforderlich fuer ack (oder SYNAPSE_AGENT_NAME setzen)');
          const reaction = str(args, 'reaction');
          const eventIds = numArray(args, 'event_id');
          if (eventIds && eventIds.length > 1) {
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
    case 'specialist': {
      // Specialist-Calls werden via PG-Queue an den lokalen FileWatcher-Daemon
      // delegiert (wo Claude-CLI + Projekt-FS verfuegbar sind).
      // status + capabilities lesen direkt aus PG ohne Queue.
      const { enqueueSpecialistJob, waitForSpecialistJob, getPool, getWrapperStatus, listWrapperStatus, postToInbox } = await import('@synapse/core');

      // capabilities ist projekt-agnostisch — direkt aus PG ableiten.
      // projects-Tabelle = registrierte Daemons je hostname.
      // wrapper_status-Tabelle = aktive Spezialisten (running/idle).
      // model_registry = welche Modelle SUPPORTED sind (unabhaengig davon was aktuell laeuft).
      if (action === 'capabilities') {
        const pool = getPool();
        const [hostsRes, wrappersRes, modelsRes] = await Promise.all([
          pool.query<{ hostname: string; project_count: string; last_seen: string | null }>(
            `SELECT hostname, COUNT(*)::text AS project_count, MAX(last_access)::text AS last_seen
             FROM projects WHERE path NOT LIKE '/virtual/%'
             GROUP BY hostname ORDER BY last_seen DESC NULLS LAST`,
          ),
          pool.query<{ provider: string | null; model: string | null; status: string; n: string }>(
            `SELECT provider, model, status, COUNT(*)::text AS n
             FROM wrapper_status GROUP BY provider, model, status`,
          ),
          pool.query<{ alias: string; full_id: string; provider: string; context_window: number; env_required: string[]; runtime_binary: string }>(
            `SELECT alias, full_id, provider, context_window, env_required, runtime_binary
             FROM model_registry WHERE enabled = true
             ORDER BY provider, alias`,
          ),
        ]);
        const totalActive = wrappersRes.rows
          .filter(r => r.status === 'active' || r.status === 'idle' || r.status === 'busy')
          .reduce((s, r) => s + Number(r.n), 0);
        const supportedProviders = Array.from(new Set(modelsRes.rows.map(r => r.provider)));
        const activeProviders = Array.from(new Set(wrappersRes.rows.map(r => r.provider).filter(Boolean)));
        return {
          success: true,
          daemons: hostsRes.rows.map(r => ({ hostname: r.hostname, projects: Number(r.project_count), lastSeen: r.last_seen })),
          wrappers: {
            total: wrappersRes.rows.reduce((s, r) => s + Number(r.n), 0),
            active: totalActive,
            byProviderModel: wrappersRes.rows,
          },
          supportedModels: modelsRes.rows,
          features: {
            specialists: hostsRes.rows.length > 0,
            channels: true,
            inbox: true,
            providers: supportedProviders,
            activeProviders,
          },
          message: hostsRes.rows.length > 0
            ? `${hostsRes.rows.length} Daemon-Host(s) registriert, ${totalActive} aktive Wrapper. ${modelsRes.rows.length} Modelle supported (${supportedProviders.join(' + ')}).`
            : 'Keine Daemons registriert.',
        };
      }

      const project = reqStr(args, 'project');

      // project_path-Auflösung: REST-Web-KIs muessen den Pfad nicht kennen.
      // Lookup aus projects-Tabelle (Daemon-registriert) wenn nicht uebergeben.
      // Falsche Hostpfade (z.B. /home/moritz statt /home/blacky) wuerden EACCES
      // ausloesen — daher beim REST-Pfad IMMER den daemon-bekannten Pfad nehmen,
      // egal was der Caller schickt.
      try {
        // WICHTIG: '/virtual/%' raus — die REST-API selbst registriert sich als
        // virtuelles Projekt mit /virtual/<container-name>. Wir wollen den ECHTEN
        // User-Host-Pfad (z.B. /home/blacky/dev/synapse), nicht den Container-Stub.
        const pgRes = await getPool().query<{ path: string }>(
          `SELECT path FROM projects
           WHERE name = $1 AND path NOT LIKE '/virtual/%'
           ORDER BY last_access DESC NULLS LAST
           LIMIT 1`,
          [project],
        );
        if (pgRes.rows.length > 0) {
          (args as Record<string, unknown>).project_path = pgRes.rows[0].path;
        }
      } catch { /* fallthrough — nutzt was Caller geschickt hat */ }

      // status: direkt aus PG wrapper_status lesen — kein Daemon-Roundtrip noetig
      if (action === 'status') {
        const name = str(args, 'name');
        const THREE_MIN_MS = 3 * 60 * 1000;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toSpecialist = (row: any) => ({
          name: row.agentName,
          model: row.model ?? '',
          status: row.status,
          pid: row.innerPid ?? 0,
          wrapperPid: row.wrapperPid ?? 0,
          socket: row.socketPath ?? '',
          tokens: {
            input: row.tokensInput ?? 0,
            output: row.tokensOutput ?? 0,
            percent: row.tokensPercent ?? 0,
          },
          contextCeiling: row.contextCeiling ?? 0,
          lastActivity: row.lastActivity instanceof Date
            ? row.lastActivity.toISOString()
            : String(row.lastActivity),
          channels: row.channels ?? [],
          currentTask: row.currentTask ?? null,
          busy: row.busy ?? false,
          ...(row.provider != null && { provider: row.provider }),
          ...(row.modelFullId != null && { modelFullId: row.modelFullId }),
        });

        if (name) {
          // Einzelner Spezialist
          const row = await getWrapperStatus(name, project).catch(() => null);
          if (!row) {
            return { success: false, message: `Spezialist "${name}" nicht gefunden.` };
          }
          const connected = Date.now() - row.lastActivity.getTime() < THREE_MIN_MS
            && row.status !== 'crashed' && row.status !== 'stopped';
          return {
            success: true,
            specialist: toSpecialist(row),
            connected,
            wrapperStatus: { via: 'pg', lastActivity: row.lastActivity.toISOString() },
            skill: '(Skill-Daten nur via lokalen MCP-Server verfuegbar)',
          };
        }

        // Alle Spezialisten des Projekts
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = await listWrapperStatus(project).catch(() => [] as any[]);
        const specialists: Record<string, unknown> = {};
        for (const row of rows) {
          specialists[row.agentName] = toSpecialist(row);
        }
        return {
          success: true,
          specialists,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runningCount: rows.filter((r: any) => r.status === 'running').length,
          lastUpdate: rows[0]?.lastActivity instanceof Date
            ? rows[0].lastActivity.toISOString()
            : new Date().toISOString(),
        };
      }

      // wake: PG NOTIFY (fast path) + Inbox (persistent fallback) — kein Daemon-Roundtrip
      if (action === 'wake') {
        const name = reqStr(args, 'name');
        const message = reqStr(args, 'message');
        const topic = `synapse_specialist_wake_${name}`;
        const payload = JSON.stringify({ message, from: 'rest-api', project, timestamp: Date.now() });
        let notifyOk = false;
        let inboxId: number | undefined;
        const wakeErrors: string[] = [];

        // Fast path: PG NOTIFY (wrapper.ts hat LISTEN synapse_specialist_wake_<name>)
        try {
          await getPool().query('SELECT pg_notify($1, $2)', [topic, payload]);
          notifyOk = true;
        } catch (e) {
          wakeErrors.push(`notify: ${(e as Error).message}`);
        }

        // Persistent fallback: Inbox (wird beim naechsten Heartbeat verarbeitet)
        try {
          const r = await postToInbox('rest-api', name, message);
          inboxId = r.id;
        } catch (e) {
          wakeErrors.push(`inbox: ${(e as Error).message}`);
        }

        const ok = notifyOk || inboxId != null;
        return {
          success: ok,
          name,
          notified: notifyOk,
          inboxId,
          errors: wakeErrors.length > 0 ? wakeErrors : undefined,
          message: ok
            ? `Wake gesendet an "${name}" (notify=${notifyOk}, inbox=${inboxId != null})`
            : `Wake-Fehler fuer "${name}": ${wakeErrors.join(', ')}`,
        };
      }

      const actionStr = String(action ?? '');
      const queueableActions = ['spawn', 'spawn_batch', 'stop', 'purge', 'update_skill'];
      if (!queueableActions.includes(actionStr)) {
        return { success: false, error: `Unbekannte specialist action: "${actionStr}"` };
      }

      try {
        const { id } = await enqueueSpecialistJob({
          project,
          action: actionStr as 'spawn' | 'spawn_batch' | 'stop' | 'purge' | 'update_skill',
          args: args as Record<string, unknown>,
        });
        const result = await waitForSpecialistJob(id, 60_000);
        if (result.status === 'done') {
          return result.result ?? { success: true, message: 'Spezialist-Aktion erfolgreich' };
        }
        return {
          success: false,
          status: result.status,
          error: result.error,
          message: result.message ?? 'Spezialist-Aktion fehlgeschlagen oder timeout. Pruefe ob FileWatcher-Daemon laeuft und das Projekt aktiv ist.',
        };
      } catch (err) {
        return { success: false, error: 'queue_failure', message: String(err) };
      }
    }


    // =================================================================
    // 11. DOCS
    // =================================================================
    case 'docs': {
      switch (action) {
        case 'add': {
          // Bulk-Mode
          type DocItem = { framework?: string; version?: string; section?: string; content?: string; type?: string; category?: string; source?: string };
          const docs = objArray<DocItem>(args, 'docs');
          const project = str(args, 'project');
          if (docs && docs.length > 0) {
            const results: Array<{ index: number; ok: boolean; id?: string; duplicate?: boolean; error?: string }> = [];
            let applied = 0;
            let failed = 0;
            for (let i = 0; i < docs.length; i++) {
              const d = docs[i];
              try {
                if (!d.framework) throw new Error('framework fehlt');
                if (!d.version) throw new Error('version fehlt');
                if (!d.section) throw new Error('section fehlt');
                if (!d.content) throw new Error('content fehlt');
                if (!d.type) throw new Error('type fehlt');
                const r = await addTechDoc(
                  d.framework, d.version, d.section, d.content,
                  d.type as Parameters<typeof addTechDoc>[4],
                  d.category, d.source, project,
                );
                results.push({ index: i, ok: r.success, id: r.id, duplicate: r.duplicate });
                if (r.success) applied++; else failed++;
              } catch (err) {
                results.push({ index: i, ok: false, error: (err as Error).message });
                failed++;
              }
            }
            return {
              success: failed === 0,
              total: docs.length, applied, failed, results,
              message: `${applied}/${docs.length} Docs indexiert${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
            };
          }
          const result = await addTechDoc(
            reqStr(args, 'framework'), reqStr(args, 'version'),
            reqStr(args, 'section'), reqStr(args, 'content'),
            reqStr(args, 'type') as Parameters<typeof addTechDoc>[4],
            str(args, 'category'), str(args, 'source'), project
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
          const rawAgentId = str(args, 'agent_id');
          const agentId = resolveAgentId(rawAgentId);
          if (!agentId) throw new Error('agent_id erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
          const project = reqStr(args, 'project');
          const filePaths = strArray(args, 'file_path');
          if (filePaths && filePaths.length > 1) {
            const settled = await Promise.allSettled(
              filePaths.map(fp => getDocsForFile(fp, agentId, project, { limit: num(args, 'limit'), frameworks: str(args, 'framework') ? [str(args, 'framework') as string] : undefined }))
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
        case 'search_batch': {
          // Mehrere semantic Queries in EINEM Call — alle Embeddings in 1 Google-Batch.
          const queriesRaw = (args as Record<string, unknown>).queries;
          if (!Array.isArray(queriesRaw) || queriesRaw.length === 0) {
            return { success: false, error: 'invalid_queries', message: 'queries[] muss ein Array mit >=1 String sein.' };
          }
          if (queriesRaw.length > 10) {
            return { success: false, error: 'too_many_queries', message: `Max 10 queries pro Batch (got ${queriesRaw.length}).` };
          }
          const queries = queriesRaw.map((q) => String(q)).filter((q) => q.trim().length > 0);
          const fileType = str(args, 'file_type');
          const limitPerQuery = num(args, 'limit_per_query') ?? 5;
          const items = await searchCodeBatch(queries, project, fileType, limitPerQuery);
          const results = items.map((it) => ({
            query: it.query,
            count: it.count,
            hits: it.hits.map((h) => ({
              file_path: h.payload.file_path,
              file_type: h.payload.file_type,
              line_start: h.payload.line_start,
              line_end: h.payload.line_end,
              score: h.score,
              content: h.payload.content,
            })),
          }));
          return { success: true, mode: 'semantic', queries_count: queries.length, results, project };
        }
        case 'search': {
          const query = reqStr(args, 'query');
          const fileType = str(args, 'file_type');
          const limit = num(args, 'limit') ?? 20;
          // semantic:true → Qdrant Embedding-Suche (konzeptuell). Default = PG-Volltext (lexikalisch).
          if (args.semantic === true) {
            const sem = await searchCode(query, project, fileType, limit);
            const results = sem.map(r => ({
              file_path: r.payload.file_path,
              file_type: r.payload.file_type,
              line_start: r.payload.line_start,
              line_end: r.payload.line_end,
              score: r.score,
              content: r.payload.content,
            }));
            return { success: true, results, count: results.length, mode: 'semantic', project };
          }
          const results = await fullTextSearchCode(project, query, fileType, limit);
          return { success: true, results, count: results.length, mode: 'fulltext', project };
        }
        case 'file': {
          const filePath = str(args, 'file_path') ?? str(args, 'path');
          if (!filePath) throw new Error('Parameter "file_path" oder "path" ist erforderlich fuer action "file"');
          const file = await getFileContent(project, filePath, {
            from: num(args, 'from_line'),
            to: num(args, 'to_line'),
            truncate_long_lines: num(args, 'truncate_long_lines'),
          });
          if (!file) return { success: false, message: `Datei nicht gefunden: ${filePath}`, project };
          return { success: true, ...file, project };
        }
        case 'statements': {
          const statements = await getStatements(project, str(args, 'file_path'), str(args, 'scope'), bool(args, 'top_level_only'), num(args, 'limit'));
          return { success: true, statements, count: statements.length, project };
        }
        case 'calls': {
          const callEdges = await getCallEdges(project, str(args, 'file_path'), str(args, 'callee'));
          return { success: true, call_edges: callEdges, count: callEdges.length, project };
        }
        case 'flow': {
          const filePath = str(args, 'file_path') ?? str(args, 'path');
          if (!filePath) throw new Error('Parameter "file_path" ist erforderlich fuer action "flow"');
          const flow = await getExecutionFlow(project, filePath, str(args, 'scope'));
          return { success: true, ...flow, project };
        }
        case 'entrypoints': {
          const entrypoints = await getEntrypoints(project, str(args, 'file_path'), num(args, 'limit'), args.include_declarations === true);
          return { success: true, entrypoints, count: entrypoints.length, project };
        }
        default:
          return { success: false, error: `Unbekannte code_intel action: "${action}"` };
      }
    }

    // =================================================================
    case 'files_batch':
    case 'files': {
      const project = reqStr(args, 'project');
      const agentId = resolveAgentId(str(args, 'agent_id')) ?? undefined;
      // History-Enrichment (additive, alle nullable)
      const featureTag = str(args, 'feature_tag');
      const parentVersionId = str(args, 'parent_version_id');
      const gitCommitSha = str(args, 'git_commit_sha');
      const agentNote = str(args, 'agent_note');
      const enrichment = (featureTag || parentVersionId || gitCommitSha || agentNote)
        ? { feature_tag: featureTag ?? null, parent_version_id: parentVersionId ?? null, git_commit_sha: gitCommitSha ?? null, agent_note: agentNote ?? null }
        : undefined;

      // Versionierungs-Actions arbeiten ohne file_path (oder mit anderen IDs).
      // Vor der file_path-Pflicht abfangen.
      if (action === 'get_version') {
        const versionId = reqStr(args, 'version_id');
        const v = await getFileVersion(versionId);
        if (!v) return { success: false, message: `Version ${versionId} nicht gefunden.` };
        return { success: true, version: v };
      }
      if (action === 'restore') {
        const versionId = reqStr(args, 'version_id');
        const r = await restoreFileVersion(versionId, agentId);
        return {
          success: true,
          ...r,
          message: `Datei "${r.file_path}" auf Version ${r.restored_from} zurueckgerollt. Vorheriger Stand wurde als neue Version gesnapshottet.`,
        };
      }
      if (action === 'restore_batch') {
        const batchId = reqStr(args, 'batch_id');
        const restored = await restoreBatch(batchId, agentId);
        return {
          success: true,
          batch_id: batchId,
          files_restored: restored.length,
          files: restored,
          message: `Batch ${batchId} zurueckgerollt: ${restored.length} Datei(en).`,
        };
      }

      // Multi-File Plan/Commit (Schritt 2) — kein file_path noetig.
      if (action === 'plan') {
        const opsRaw = (args as Record<string, unknown>).ops;
        if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
          return { success: false, error: 'invalid_ops', message: 'ops[] muss ein Array mit mindestens 1 Element sein.' };
        }
        const opsTyped = opsRaw as import('@synapse/core').FileBatchOp[];

        // auto_commit + Multi-File: per-File-Atomicity. Wir gruppieren nach file_path
        // und committen jede Datei isoliert — ein Fehler auf File X bricht nicht
        // die Ops auf File Y ab.
        const filePaths = new Set(opsTyped.map((o) => o.file_path));
        if (args.auto_commit === true && filePaths.size > 1) {
          const byFile = new Map<string, import('@synapse/core').FileBatchOp[]>();
          for (const op of opsTyped) {
            const list = byFile.get(op.file_path) ?? [];
            list.push(op);
            byFile.set(op.file_path, list);
          }
          const committed: Array<{ file_path: string; batch_id: string; ops: number }> = [];
          const failed: Array<{ file_path: string; error: string; message: string }> = [];
          for (const [filePath, fileOps] of byFile) {
            try {
              const plan = await planBatch({
                project,
                agent_id: agentId,
                ops: fileOps,
                open_for_coedit: typeof args.open_for_coedit === 'boolean' ? args.open_for_coedit as boolean : undefined,
                reason: str(args, 'reason'),
              });
              const c = await commitBatch({ plan_id: plan.plan_id, agent_id: agentId, agent_note: str(args, 'agent_note') });
              if (c.success) {
                committed.push({ file_path: filePath, batch_id: String(c.batch_id ?? plan.plan_id), ops: fileOps.length });
              } else {
                failed.push({ file_path: filePath, error: c.error ?? 'commit_failed', message: c.message ?? 'commit failed' });
              }
            } catch (err) {
              failed.push({ file_path: filePath, error: 'plan_failed', message: (err as Error).message });
            }
          }
          return {
            success: failed.length === 0,
            mode: 'per_file_atomic',
            committed,
            failed,
            committed_count: committed.length,
            failed_count: failed.length,
            message: failed.length === 0
              ? `${committed.length}/${byFile.size} Datei(en) committed.`
              : `${committed.length}/${byFile.size} committed, ${failed.length} fehlgeschlagen — Details in "failed[]".`,
          };
        }

        // Single-File ODER auto_commit:false → klassischer Plan-Pfad (atomic).
        let result;
        try {
          result = await planBatch({
            project,
            agent_id: agentId,
            ops: opsTyped,
            open_for_coedit: typeof args.open_for_coedit === 'boolean' ? args.open_for_coedit as boolean : undefined,
            reason: str(args, 'reason'),
          });
        } catch (err) {
          return { success: false, error: 'plan_failed', message: (err as Error).message };
        }
        // auto_commit:true -> direkt commit, ABER nur wenn alle Previews ok sind.
        const allPreviewsOk = result.previews?.every(p => p.ok) ?? true;
        if (args.auto_commit === true && allPreviewsOk) {
          const c = await commitBatch({ plan_id: result.plan_id, agent_id: agentId, agent_note: str(args, 'agent_note') });
          if (c.success) {
            return { ...c, plan: result, auto_committed: true, message: `Plan ${result.plan_id} angelegt + sofort committed (auto_commit) — ${c.committed} Datei(en) geaendert. batch_id=${c.batch_id}.` };
          }
          return { ...c, plan: result, auto_committed: false, message: `Plan ${result.plan_id} angelegt, auto-commit fehlgeschlagen — Plan bleibt offen, kann manuell committet oder cancelt werden.` };
        }
        return {
          success: true,
          ...result,
          message: `Plan ${result.plan_id} angelegt: ${result.total_ops} Op(s) ueber ${result.files_touched.length} Datei(en).`,
        };
      }
      if (action === 'commit') {
        const planId = reqStr(args, 'plan_id');
        try {
          const result = await commitBatch({ plan_id: planId, agent_id: agentId, agent_note: str(args, 'agent_note') });
          if (result.success) {
            return { ...result, message: `Plan ${result.plan_id} committed — ${result.committed} Datei(en) geaendert. batch_id=${result.batch_id}.` };
          }
          return result;
        } catch (err) {
          return { success: false, error: 'commit_failed', message: (err as Error).message };
        }
      }
      if (action === 'cancel') {
        const planId = reqStr(args, 'plan_id');
        const result = await cancelBatch(planId);
        return {
          success: result.ok,
          plan_id: planId,
          status: result.status,
          message: result.ok ? `Plan ${planId} abgebrochen.` : `Plan ${planId} nicht abbrechbar (Status: ${result.status}).`,
        };
      }
      if (action === 'plan_status') {
        const planId = reqStr(args, 'plan_id');
        const plan = await getBatchPlan(planId);
        if (!plan) return { success: false, error: 'plan_not_found', message: `Plan ${planId} nicht gefunden.` };
        return {
          success: true,
          plan_id: plan.id,
          project: plan.project,
          status: plan.status,
          owner_agent_id: plan.owner_agent_id,
          ops_count: Array.isArray(plan.ops) ? plan.ops.length : 0,
          files_touched: Object.keys(plan.expected_hashes ?? {}),
          previews: plan.previews,
          reason: plan.reason,
          expires_at: plan.expires_at,
          committed_at: plan.committed_at,
        };
      }
      if (action === 'history') {
        const limit = num(args, 'limit') ?? 50;
        // DX-Befund 1: agent_filter ist der explizite Filter; agent_id bleibt
        // aus Kompatibilitaet wirksam, aber 0-Treffer liefern jetzt einen tip.
        const agentFilter = str(args, 'agent_filter') ?? str(args, 'agent_id') ?? undefined;
        const entries = await listFileHistory(project, {
          agent_id: agentFilter, // READ-FILTER: kein resolveAgentId
          file_path: str(args, 'file_path'),
          since: str(args, 'since'),
          limit,
          // Enrichment-Filter
          feature_tag: str(args, 'feature_tag'),
          version_id: str(args, 'version_id'),
        });
        return {
          success: true,
          project,
          count: entries.length,
          entries,
          tip: entries.length > 0
            ? 'Eintraege chronologisch (neueste zuerst). reason = "Warum" der Aenderung. Voller Inhalt: files(action: "get_version", version_id). feature_tag und parent_version_id zeigen Feature-Group bzw. Korrektur-Chain.'
            : (agentFilter
                ? `0 Treffer MIT Agent-Filter "${agentFilter}" — agent_id/agent_filter wirken bei history als EXAKTER Filter. Fuer die volle Projekt-History beide weglassen.`
                : 'Keine Eintraege fuer diese Filter.'),
        };
      }

      const filePath = reqStr(args, 'file_path');

      if (action === 'versions') {
        const limit = num(args, 'limit') ?? 50;
        const versions = await listFileVersions(project, filePath, limit);
        return {
          success: true,
          project,
          file_path: filePath,
          count: versions.length,
          versions,
          tip: versions.length > 0
            ? `Voller Inhalt mit files(action: "get_version", version_id: "<id>"). Rollback mit files(action: "restore", version_id: "<id>").`
            : 'Keine Versionen — Datei wurde noch nicht editiert oder existiert nicht.',
        };
      }

      switch (action) {
        case 'create': {
          const content = reqStr(args, 'content');
          const result = await createFileInPg(project, filePath, content, agentId, str(args, 'reason'), undefined, undefined, enrichment);
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
          const result = await updateFileInPg(project, filePath, content, agentId, undefined, undefined, str(args, 'reason'), enrichment);
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
          const rawContent = await getFileContentFromPg(project, filePath);
          if (rawContent === null) {
            return { success: false, error: `Datei "${filePath}" nicht gefunden in Projekt "${project}"` };
          }
          const ranged = applyContentRange(rawContent, {
            from: num(args, 'from_line'),
            to: num(args, 'to_line'),
            truncate_long_lines: num(args, 'truncate_long_lines'),
          });
          return {
            success: true,
            file_path: filePath,
            size: rawContent.length,
            ...ranged,
          };
        }
        case 'replace_lines': {
          const currentContent = await getFileContentFromPg(project, filePath);
          if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
          const lineStart = num(args, 'line_start');
          const lineEnd = num(args, 'line_end');
          const content = reqStr(args, 'content');
          if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
          const newContent = replaceLines(currentContent, lineStart, lineEnd, content);
          const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, str(args, 'reason'), enrichment);
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
          const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, str(args, 'reason'), enrichment);
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
          const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, str(args, 'reason'), enrichment);
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
          const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, str(args, 'reason'), enrichment);
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
        case 'search_replace_batch': {
          const currentContent = await getFileContentFromPg(project, filePath);
          if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
          const rawEdits = args['edits'];
          if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
            return { success: false, error: 'edits muss ein nicht-leeres Array sein' };
          }
          const { content: newContent, result: batchResult } = searchReplaceBatch(currentContent, rawEdits as Array<{ search: string; replace: string; replace_all?: boolean }>);
          if (batchResult.applied === 0) {
            return {
              success: false,
              ...batchResult,
              message: `Keine Edits angewendet in "${filePath}"`,
            };
          }
          const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, str(args, 'reason'), enrichment);
          const response: Record<string, unknown> = {
            success: true,
            ...batchResult,
            message: `${batchResult.applied}/${batchResult.total} Edits angewendet in "${filePath}"`,
          };
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
        const jobId = reqStr(args, 'id');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
          return { success: false, error: 'invalid_job_id', message: `"${jobId}" ist keine Job-UUID${/^[0-9a-f]{16}$/i.test(jobId) ? ' (das ist eine stream_id)' : ''} — nutze das id-Feld der exec-Antwort oder shell(history).` };
        }
        const job = await getShellJobById(reqStr(args, 'id'));
        if (!job) {
          return { success: false, error: 'unknown_job', message: `Job ${reqStr(args, 'id')} nicht gefunden` };
        }
        return { success: true, job };
      }

      if (shellAction === 'log') {
        const id = reqStr(args, 'id');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return { success: false, error: 'invalid_job_id', message: `"${id}" ist keine Job-UUID${/^[0-9a-f]{16}$/i.test(id) ? ' (das ist eine stream_id)' : ''} — nutze das id-Feld der exec-Antwort oder shell(history).` };
        }
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

      if (shellAction === 'activity') {
        const a = args as Record<string, unknown>;
        const rows = await queryToolCalls({
          project: str(args, 'project'),
          agentId: strArray(a, 'agent_ids'),
          tool: strArray(a, 'tools'),
          status: (a.errors_only === true || a.errors_only === 'true') ? 'error' : undefined,
          mutationsOnly: a.mutations_only === true || a.mutations_only === 'true',
          since: str(args, 'since'),
          limit: num(args, 'limit'),
          detail: (str(args, 'detail') as 'meta' | 'summary' | 'full' | undefined) ?? 'meta',
        });
        return { success: true, count: rows.length, detail: str(args, 'detail') ?? 'meta', activity: rows };
      }

      if (shellAction !== 'exec') {
        return { success: false, error: `Unbekannte shell action: "${shellAction}"` };
      }

      const project = reqStr(args, 'project');
      const command = reqStr(args, 'command');
      const cwdRel = str(args, 'cwd_relative');
      const timeoutMs = num(args, 'timeout_ms') ?? 30000;
      const tailLines = num(args, 'tail_lines');

      // Auto-Routing: target=auto|local|workspace (Default auto). isolated=true ist
      // Kurzform fuer target=workspace. Auto entscheidet anhand daemon_heartbeats:
      // frischer Heartbeat (<30s) → local (shell-queue), sonst → workspace (Docker).
      const targetArg = (str(args, 'target') ?? 'auto').toLowerCase();
      const isolated = args.isolated === true;
      let target: 'local' | 'workspace';
      if (isolated || targetArg === 'workspace') {
        target = 'workspace';
      } else if (targetArg === 'local') {
        target = 'local';
      } else {
        const alive = await isDaemonAliveForProject(project).catch(() => false);
        target = alive ? 'local' : 'workspace';
      }

      if (target === 'workspace') {
        const { getWorkspaceOrchestrator } = await import('../services/workspace-orchestrator.js');
        const orch = getWorkspaceOrchestrator();
        if (!orch || !orch.isAvailable()) {
          return {
            success: false,
            executed_via: 'workspace',
            error: 'workspace_unavailable',
            message: 'Workspace-Orchestrator nicht verfuegbar (Docker-Socket fehlt oder deaktiviert) UND kein lokaler Daemon aktiv.',
          };
        }
        try {
          const r = await orch.exec(project, command, {
            timeoutMs,
            workingDir: cwdRel ? `/workspace/${cwdRel.replace(/^\/+/, '')}` : undefined,
            workspace: str(args, 'workspace'),
          });
          const tail = tailLines && r.stdout
            ? r.stdout.split('\n').slice(-tailLines)
            : r.stdout.split('\n');
          return {
            success: r.exitCode === 0 && !r.timedOut,
            executed_via: 'workspace',
            status: r.timedOut ? 'timeout' : (r.exitCode === 0 ? 'done' : 'failed'),
            exit_code: r.exitCode,
            tail,
            stderr_tail: r.stderr ? r.stderr.split('\n').slice(-20) : undefined,
            duration_ms: r.durationMs,
          };
        } catch (err) {
          return {
            success: false,
            executed_via: 'workspace',
            error: 'workspace_exec_failed',
            message: (err as Error).message,
          };
        }
      }

      // target === 'local' — bestehender Queue-Pfad
      const { id, stream_id } = await enqueueShellJob({
        project,
        command,
        cwd_relative: cwdRel,
        timeout_ms: timeoutMs,
        tail_lines: tailLines,
        // Attribution: args.agent_id ist im Cloud-Pfad bereits aus dem Header
        // befuellt (deriveAgentIdFromHeaders) bzw. vom Caller gesetzt; Spezialist
        // faellt ueber resolveAgentId auf SYNAPSE_AGENT_NAME zurueck.
        agent_id: resolveAgentId(str(args, 'agent_id')),
      });

      const result = await waitForShellJob(id, timeoutMs + 5000);

      return {
        success: !result.error,
        executed_via: 'local',
        id, // Job-UUID fuer shell(get)/shell(log) — DX-Befund 2
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
          const rawFoundBy = str(args, 'found_by');
          const foundBy = resolveAgentId(rawFoundBy);
          if (!foundBy) throw new Error('found_by erforderlich (oder SYNAPSE_AGENT_NAME setzen)');
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

    case 'workspace': {
      const { getWorkspaceOrchestrator } = await import('../services/workspace-orchestrator.js');
      const orch = getWorkspaceOrchestrator();
      if (!orch || !orch.isAvailable()) {
        return { success: false, error: 'Workspace-Orchestrator nicht verfuegbar (Docker-Socket fehlt oder ausgeschaltet)' };
      }
      // Helper: jede workspace-Response bekommt dns_name damit ki-browser
      // den DNS-Namen statt der wechselnden IP nutzt. WS3: pro (project, name).
      const dnsForProject = (p: string, ws = 'main'): string => orch.internalUrl(p, 0, ws).replace(/:0$/, '').replace(/^http:\/\//, '');
      const wsArg = str(args, 'name') ?? 'main';
      switch (action) {
        case 'list': {
          const workspaces = await orch.listWorkspaces();
          const enriched = workspaces.map((w) => ({ ...w, dns_name: dnsForProject(w.project, w.name) }));
          return { success: true, workspaces: enriched, count: enriched.length };
        }
        case 'start': {
          const project = reqStr(args, 'project');
          const containerId = await orch.ensureProjectRunning(project, wsArg, str(args, 'role'));
          return { success: true, project, workspace: wsArg, container_id: containerId, dns_name: dnsForProject(project, wsArg), dns_hint: `Andere proxynet-Container (z.B. ki-browser oder andere Workspaces dieses Projekts) erreichen diesen Workspace via http://${dnsForProject(project, wsArg)}:<port>. Niemals IP verwenden — die wechselt bei Restart.` };
        }
        case 'stop': {
          const project = reqStr(args, 'project');
          await orch.stopProject(project, 'mcp-manual', wsArg);
          return { success: true, project, workspace: wsArg, stopped: true };
        }
        case 'pin': {
          const project = reqStr(args, 'project');
          await orch.pin(project, true, wsArg);
          return { success: true, project, workspace: wsArg, pinned: true };
        }
        case 'unpin': {
          const project = reqStr(args, 'project');
          await orch.pin(project, false, wsArg);
          return { success: true, project, workspace: wsArg, pinned: false };
        }
        case 'exec': {
          const project = reqStr(args, 'project');
          const command = reqStr(args, 'command');
          const exposePorts = Array.isArray((args as Record<string, unknown>).expose_ports)
            ? ((args as Record<string, unknown>).expose_ports as unknown[]).map(Number).filter(Number.isFinite)
            : undefined;
          const result = await orch.exec(project, command, {
            timeoutMs: num(args, 'timeout_ms'),
            workingDir: str(args, 'working_dir'),
            exposePorts,
            workspace: wsArg,
            role: str(args, 'role'),
          });
          return { success: true, project, workspace: wsArg, dns_name: dnsForProject(project, wsArg), ...result };
        }
        case 'materialize': {
          const project = reqStr(args, 'project');
          const ignorePatterns = Array.isArray((args as Record<string, unknown>).ignore_patterns)
            ? (args as Record<string, unknown>).ignore_patterns as string[] : undefined;
          const r = await orch.materialize(project, { ignorePatterns });
          return { success: true, project, ...r };
        }
        case 'commit': {
          const project = reqStr(args, 'project');
          const ignorePatterns = Array.isArray((args as Record<string, unknown>).ignore_patterns)
            ? (args as Record<string, unknown>).ignore_patterns as string[] : undefined;
          const r = await orch.commit(project, { ignorePatterns });
          return { success: true, project, ...r };
        }
        case 'configure': {
          const project = reqStr(args, 'project');
          const r = await orch.configure(project, {
            cpuLimit: num(args, 'cpu_limit'),
            memLimitMb: num(args, 'mem_limit_mb'),
            pidsLimit: num(args, 'pids_limit'),
            tmpfsMb: num(args, 'tmpfs_mb'),
            image: str(args, 'image'),
          }, wsArg);
          return {
            success: true,
            project,
            workspace: wsArg,
            ...r,
            hint: r.requiresRestart
              ? 'Workspace ist aktiv — Aenderungen greifen nach workspace(stop) + start/exec.'
              : 'Aenderungen greifen beim naechsten Container-Start.',
          };
        }
        case 'reset_home': {
          const project = reqStr(args, 'project');
          const r = await orch.resetHome(project, wsArg);
          return {
            success: true,
            project,
            workspace: wsArg,
            ...r,
            hint: 'Container gestoppt + HOME-Volume entfernt. Naechster workspace-Zugriff startet mit frischem /home/synapse (Caches/Toolchains im Home sind weg, /workspace unveraendert).',
          };
        }
        case 'make_writable': {
          const project = reqStr(args, 'project');
          const r = await orch.makeWritable(project, reqStr(args, 'path'), wsArg);
          return {
            success: true,
            project,
            workspace: wsArg,
            ...r,
            hint: 'Pfad gehoert jetzt synapse (u+rwX) — gedacht fuer Build-Artefakte (target/, build/, dist/). Source-Edits weiter via files-Tool: der PG-Sync setzt synchronisierte Dateien wieder auf root/0444.',
          };
        }
        case 'role_set': {
          const role = await orch.roleSet({
            project: str(args, 'project') ?? null,   // weggelassen = globale Rolle
            role: reqStr(args, 'role'),
            image: str(args, 'image'),
            cpuLimit: num(args, 'cpu_limit'),
            memLimitMb: num(args, 'mem_limit_mb'),
            pidsLimit: num(args, 'pids_limit'),
            tmpfsMb: num(args, 'tmpfs_mb'),
            initCommand: str(args, 'init_command'),
            description: str(args, 'description'),
            devices: strArray(args, 'devices'),
            securityOpts: strArray(args, 'security_opts'),
          });
          return { success: true, role, hint: 'Rolle = Template. Instanziieren: workspace(start|exec, name: "<instanz>", role: "<rolle>") — beliebig oft (db-1, db-2, ...). Template-Aenderungen wirken ab dem naechsten Container-Start der Instanzen.' };
        }
        case 'role_list': {
          const roles = await orch.roleList(str(args, 'project'));
          return { success: true, count: roles.length, roles, hint: 'project-Param zeigt globale + projekt-scoped Rollen; projekt-scoped schlaegt global bei gleichem Namen.' };
        }
        case 'role_delete': {
          const deleted = await orch.roleDelete(reqStr(args, 'role'), str(args, 'project') ?? null);
          return { success: true, deleted, hint: deleted ? 'Rolle entfernt — bestehende Instanzen behalten ihre Row-Konfiguration, nur der init_command-Lookup laeuft kuenftig ins Leere.' : 'Keine Rolle mit diesem Namen im angegebenen Scope (project weglassen = global).' };
        }
        default:
          return { success: false, error: `Unbekannte workspace action: "${action}"` };
      }
    }

    case 'skills': {
      const { searchSkills, listSkills, getSkillSection, getSkillFull } = await import('@synapse/core');
      switch (action) {
        case 'search': {
          const query = reqStr(args, 'query');
          const limit = Math.min(num(args, 'limit') ?? 5, 20);
          const skillNameFilter = str(args, 'skill_name'); // optional: nur innerhalb 1 Skill
          const hits = await searchSkills(query, limit, skillNameFilter);
          return { success: true, experimental: true, count: hits.length, scope: skillNameFilter ? `skill:${skillNameFilter}` : 'all', hits };
        }
        case 'list': {
          const skillName = str(args, 'skill_name');
          const skills = await listSkills(skillName);
          return { success: true, experimental: true, count: skills.length, skills };
        }
        case 'get_section': {
          const sec = await getSkillSection(reqStr(args, 'skill_name'), reqStr(args, 'section'));
          if (!sec) return { success: false, experimental: true, error: 'not_found', message: 'skill_name + section nicht gefunden' };
          return { success: true, experimental: true, ...sec };
        }
        case 'get_full': {
          const sections = await getSkillFull(reqStr(args, 'skill_name'));
          if (sections.length === 0) return { success: false, experimental: true, error: 'not_found', message: 'skill_name nicht gefunden' };
          return { success: true, experimental: true, skill_name: sections[0].skill_name, section_count: sections.length, sections };
        }
        default:
          return { success: false, error: `Unbekannte skills action: "${action}"` };
      }
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
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');

    if (jsonrpc !== '2.0') {
      return reply.status(400).send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
    }

    const derivedAgentId = deriveAgentIdFromHeaders(request.headers as Record<string, unknown>);

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'synapse-mcp', version: '0.3.0' },
          };
          break;

        case 'tools/list':
          result = { tools: MCP_TOOLS };
          break;

        case 'tools/call': {
          const toolName = params?.name as string;
          const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
          // Auto-Detect: Web-KIs ohne Wrapper-Kontext bekommen agent_id aus
          // dem User-Agent/Session-Header (siehe deriveAgentIdFromHeaders).
          // Setzt nur wenn der Caller nicht selbst eine ID mitschickt.
          if (derivedAgentId && !toolArgs.agent_id) {
            toolArgs.agent_id = derivedAgentId;
          }
          const _t0 = Date.now();
          let _logOk = true;
          let _logErr: string | null = null;
          let _logResult: string | null = null;
          try {
            const toolResult = await attachRestOnboarding(await handleToolCall(toolName, toolArgs), toolArgs);
            _logResult = JSON.stringify(toolResult);
            result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
          } catch (toolErr) {
            // Tool-Fehler (z.B. fehlender Pflicht-Parameter wie file_path) als
            // MCP tool-result mit isError zurueckgeben — NICHT als HTTP 500.
            // Sonst wertet der Cloud-MCP-Layer (claude.ai) das 5xx als retryable
            // Transport-Fehler ("502 retry_after"), und die KI haelt einen reinen
            // Parameter-Fehler faelschlich fuer einen Server-/Bridge-Ausfall.
            // Mit isError sieht die KI die Klartext-Meldung und kann den Parameter
            // ergaenzen, statt auf FS/Fallback auszuweichen.
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            console.error(`[MCP] Tool-Fehler (${toolName}): ${msg}`);
            _logOk = false;
            _logErr = msg;
            result = { content: [{ type: 'text', text: `Fehler im Tool "${toolName}": ${msg}` }], isError: true };
          }
          // Activity-Log (best-effort, non-blocking) — Cloud-Pfad.
          void logToolCall({
            project: typeof toolArgs.project === 'string' ? toolArgs.project : null,
            agentId: resolveAgentId(typeof toolArgs.agent_id === 'string' ? toolArgs.agent_id : null) ?? derivedAgentId ?? null,
            source: 'cloud',
            tool: toolName,
            action: typeof toolArgs.action === 'string' ? toolArgs.action : null,
            argsPreview: JSON.stringify(toolArgs).slice(0, 500),
            ok: _logOk,
            error: _logErr,
            durationMs: Date.now() - _t0,
            result: _logResult,
          });
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
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');

    if (!jsonrpc) {
      return reply.status(400).send({ error: 'Not a JSON-RPC request' });
    }

    if (jsonrpc !== '2.0') {
      return reply.status(400).send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
    }

    const derivedAgentId = deriveAgentIdFromHeaders(request.headers as Record<string, unknown>);

    console.log(`[MCP] Request: ${method}`);

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'synapse-mcp', version: '0.3.0' },
          };
          break;

        case 'tools/list':
          result = { tools: MCP_TOOLS };
          break;

        case 'tools/call': {
          const toolName = params?.name as string;
          const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
          // Auto-Detect: Web-KIs ohne Wrapper-Kontext bekommen agent_id aus
          // dem User-Agent/Session-Header (siehe deriveAgentIdFromHeaders).
          // Setzt nur wenn der Caller nicht selbst eine ID mitschickt.
          if (derivedAgentId && !toolArgs.agent_id) {
            toolArgs.agent_id = derivedAgentId;
          }
          const _t0 = Date.now();
          let _logOk = true;
          let _logErr: string | null = null;
          let _logResult: string | null = null;
          try {
            const toolResult = await attachRestOnboarding(await handleToolCall(toolName, toolArgs), toolArgs);
            _logResult = JSON.stringify(toolResult);
            result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
          } catch (toolErr) {
            // Tool-Fehler (z.B. fehlender Pflicht-Parameter wie file_path) als
            // MCP tool-result mit isError zurueckgeben — NICHT als HTTP 500.
            // Sonst wertet der Cloud-MCP-Layer (claude.ai) das 5xx als retryable
            // Transport-Fehler ("502 retry_after"), und die KI haelt einen reinen
            // Parameter-Fehler faelschlich fuer einen Server-/Bridge-Ausfall.
            // Mit isError sieht die KI die Klartext-Meldung und kann den Parameter
            // ergaenzen, statt auf FS/Fallback auszuweichen.
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            console.error(`[MCP] Tool-Fehler (${toolName}): ${msg}`);
            _logOk = false;
            _logErr = msg;
            result = { content: [{ type: 'text', text: `Fehler im Tool "${toolName}": ${msg}` }], isError: true };
          }
          // Activity-Log (best-effort, non-blocking) — Cloud-Pfad.
          void logToolCall({
            project: typeof toolArgs.project === 'string' ? toolArgs.project : null,
            agentId: resolveAgentId(typeof toolArgs.agent_id === 'string' ? toolArgs.agent_id : null) ?? derivedAgentId ?? null,
            source: 'cloud',
            tool: toolName,
            action: typeof toolArgs.action === 'string' ? toolArgs.action : null,
            argsPreview: JSON.stringify(toolArgs).slice(0, 500),
            ok: _logOk,
            error: _logErr,
            durationMs: Date.now() - _t0,
            result: _logResult,
          });
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
