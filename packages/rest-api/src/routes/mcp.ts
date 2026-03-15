/**
 * Synapse API - MCP over HTTP Routes
 * Für Claude.ai Connectors (v0.2.0)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  searchCode,
  searchDocsWithFallback,
  listCollections,
  detectTechnologies,
  indexProjectTechnologies,
  getPlan,
  updatePlan,
  addTask,
  addThought,
  getThoughts,
  searchThoughts,
  deleteThought,
  writeMemory,
  getMemoryByName,
  listMemories,
  searchMemories,
  deleteMemory,
  getProjectStats,
  getCollectionStats,
  scrollVectors,
  readMemoryWithRelatedCode,
  findMemoriesForPath,
  searchDocuments,
  createProposal,
  getProposal,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  searchProposals,
  COLLECTIONS,
} from '@synapse/core';
import { minimatch } from 'minimatch';
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

// MCP Tool Definitionen (v0.2.0)
const MCP_TOOLS = [
  // ===== PROJEKT-MANAGEMENT =====
  {
    name: 'init_projekt',
    description: 'Initialisiert ein Projekt: FileWatcher, Technologie-Erkennung, Doku-Caching',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        name: { type: 'string', description: 'Optionaler Projekt-Name (Standard: Ordnername)' },
        index_docs: { type: 'boolean', description: 'Framework-Dokumentation vorladen (Standard: true)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'detect_technologies',
    description: 'Erkennt verwendete Technologien in einem Projekt (Frameworks, Libraries, Tools)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
      },
      required: ['path'],
    },
  },
  {
    name: 'index_tech_docs',
    description: 'Indexiert Framework-Dokumentation für erkannte Technologien',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        force_reindex: { type: 'boolean', description: 'Bereits gecachte Docs neu indexieren (Standard: false)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_projects',
    description: 'Listet alle aktiven/indexierten Projekte',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_index_stats',
    description: 'Zeigt Index-Statistiken für ein Projekt: Anzahl Dateien, Vektoren, aufgeteilt nach Collections',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
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
        project: { type: 'string', description: 'Projekt-Name' },
      },
      required: ['project'],
    },
  },

  // ===== CODE-SUCHE =====
  {
    name: 'semantic_code_search',
    description: 'Durchsucht den Code semantisch - findet konzeptuell ähnlichen Code',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        project: { type: 'string', description: 'Projekt-Name' },
        file_type: { type: 'string', description: 'Optional: Dateityp filtern' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
      },
      required: ['query', 'project'],
    },
  },
  {
    name: 'search_docs',
    description: 'Durchsucht Framework-Dokumentation (Cache und optional Context7)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage' },
        framework: { type: 'string', description: 'Optional: Framework filtern' },
        use_context7: { type: 'boolean', description: 'Context7 als Fallback nutzen' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
      },
      required: ['query'],
    },
  },

  // ===== PROJEKT-PLANUNG =====
  {
    name: 'get_project_plan',
    description: 'Ruft den Projekt-Plan ab (Ziele, Tasks, Architektur)',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        name: { type: 'string', description: 'Neuer Plan-Name' },
        description: { type: 'string', description: 'Neue Beschreibung' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Neue Ziele' },
        architecture: { type: 'string', description: 'Architektur-Beschreibung' },
      },
      required: ['project'],
    },
  },
  {
    name: 'add_plan_task',
    description: 'Fügt eine neue Task zum Projekt-Plan hinzu',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        title: { type: 'string', description: 'Task-Titel' },
        description: { type: 'string', description: 'Task-Beschreibung' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priorität' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        source: { type: 'string', description: 'Quelle (z.B. claude-web, gpt, user)' },
        content: { type: 'string', description: 'Inhalt des Gedankens' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags' },
      },
      required: ['project', 'source', 'content'],
    },
  },
  {
    name: 'get_thoughts',
    description: 'Ruft den Gedankenaustausch für ein Projekt ab',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        limit: { type: 'number', description: 'Max Anzahl (Standard: 50)' },
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
        query: { type: 'string', description: 'Suchanfrage' },
        project: { type: 'string', description: 'Optional: Projekt filtern' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        id: { type: 'string', description: 'ID des Gedankens' },
      },
      required: ['project', 'id'],
    },
  },

  // ===== MEMORY (LANGZEIT-SPEICHER) =====
  {
    name: 'write_memory',
    description: 'Speichert längere Dokumentation/Notizen persistent. Überschreibt bei gleichem Namen.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        name: { type: 'string', description: 'Eindeutiger Name für das Memory' },
        content: { type: 'string', description: 'Inhalt des Memories (beliebig lang)' },
        category: { type: 'string', enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'], description: 'Kategorie' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        name: { type: 'string', description: 'Name des Memories' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        category: { type: 'string', enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'], description: 'Optional: Kategorie' },
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
        query: { type: 'string', description: 'Suchanfrage' },
        project: { type: 'string', description: 'Optional: Projekt filtern' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        name: { type: 'string', description: 'Name des Memories' },
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
        filePath: { type: 'string', description: 'Dateipfad' },
        limit: { type: 'number', description: 'Max. Ergebnisse (Standard: 10)' },
      },
      required: ['project', 'filePath'],
    },
  },

  // ===== CODE-SUCHE (erweitert) =====
  {
    name: 'search_by_path',
    description: 'Exakte Pfadsuche ohne Embedding - findet Dateien nach Glob-Pattern. Beispiele: "backend/src/*", "**/*.ts", "**/utils/*"',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        path_pattern: { type: 'string', description: 'Glob-Pattern für Dateipfade (z.B. "src/**/*.ts", "backend/*")' },
        content_pattern: { type: 'string', description: 'Optional: Regex-Pattern für Content-Filter' },
        limit: { type: 'number', description: 'Maximale Anzahl Ergebnisse (Standard: 50)' },
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
        query: { type: 'string', description: 'Semantische Suchanfrage' },
        project: { type: 'string', description: 'Projekt-Name' },
        path_pattern: { type: 'string', description: 'Optional: Glob-Pattern für Pfad-Filter' },
        file_type: { type: 'string', description: 'Optional: Dateityp filtern' },
        limit: { type: 'number', description: 'Maximale Anzahl Ergebnisse (Standard: 10)' },
      },
      required: ['query', 'project'],
    },
  },
  {
    name: 'search_documents',
    description: 'Durchsucht indexierte Dokumente (PDF, Word, Excel) semantisch',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        project: { type: 'string', description: 'Projekt-Name' },
        document_type: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'all'], description: 'Optional: Dokumententyp filtern (Standard: all)' },
        limit: { type: 'number', description: 'Maximale Anzahl Ergebnisse (Standard: 10)' },
      },
      required: ['query', 'project'],
    },
  },

  // ===== PROJEKT-IDEEN =====
  {
    name: 'save_project_idea',
    description: 'Speichert eine Projektidee. Generiert automatisch einen Namen und fragt nach Bestätigung.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Die Projektidee' },
        project: { type: 'string', description: 'Optional: Projekt (Standard: "ideas")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'confirm_idea',
    description: 'Bestätigt eine vorgeschlagene Idee und speichert sie persistent',
    inputSchema: {
      type: 'object',
      properties: {
        temp_id: { type: 'string', description: 'Temporäre ID der vorgemerkten Idee' },
        custom_name: { type: 'string', description: 'Optional: Eigener Name statt des vorgeschlagenen' },
      },
      required: ['temp_id'],
    },
  },

  // ===== PROPOSALS (SCHATTENVORSCHLÄGE) =====
  {
    name: 'create_proposal',
    description: 'Erstellt einen Schattenvorschlag (Code-Änderungsvorschlag)',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        filePath: { type: 'string', description: 'Zieldatei für den Vorschlag' },
        suggestedContent: { type: 'string', description: 'Vorgeschlagener Dateiinhalt' },
        description: { type: 'string', description: 'Beschreibung des Vorschlags' },
        author: { type: 'string', description: 'Urheber (Agent-Name, User, etc.)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags' },
      },
      required: ['project', 'filePath', 'suggestedContent', 'description', 'author'],
    },
  },
  {
    name: 'list_proposals',
    description: 'Listet alle Vorschläge eines Projekts auf (nur Metadaten, ohne suggestedContent)',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        status: { type: 'string', enum: ['pending', 'reviewed', 'accepted', 'rejected'], description: 'Optional: Nach Status filtern' },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_proposal',
    description: 'Ruft einen einzelnen Vorschlag ab (mit vollem suggestedContent)',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        id: { type: 'string', description: 'Proposal-ID' },
      },
      required: ['project', 'id'],
    },
  },
  {
    name: 'update_proposal_status',
    description: 'Ändert den Status eines Vorschlags',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        id: { type: 'string', description: 'Proposal-ID' },
        status: { type: 'string', enum: ['pending', 'reviewed', 'accepted', 'rejected'], description: 'Neuer Status' },
      },
      required: ['project', 'id', 'status'],
    },
  },
  {
    name: 'delete_proposal',
    description: 'Löscht einen Vorschlag',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        id: { type: 'string', description: 'Proposal-ID' },
      },
      required: ['project', 'id'],
    },
  },
  {
    name: 'search_proposals',
    description: 'Durchsucht Vorschläge semantisch',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage' },
        project: { type: 'string', description: 'Optional: Projekt filtern' },
        limit: { type: 'number', description: 'Maximale Anzahl Ergebnisse (Standard: 10)' },
      },
      required: ['query'],
    },
  },
];

// Temporärer Speicher für unbestätigte Ideen (analog zu mcp-server/tools/ideas.ts)
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

/**
 * Verarbeitet MCP Tool Aufrufe
 */
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    // ===== PROJEKT-MANAGEMENT =====
    case 'init_projekt': {
      const projectPath = args.path as string;
      const projectName = (args.name as string) || projectPath.split(/[/\\]/).pop() || 'unknown';
      const indexDocs = args.index_docs !== false;

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
        message: `Projekt "${projectName}" - Docs indexiert (FileWatcher nicht verfügbar über HTTP)`,
      };
    }

    case 'detect_technologies': {
      const techs = await detectTechnologies(args.path as string);
      return { technologies: techs };
    }

    case 'index_tech_docs': {
      const techs = await detectTechnologies(args.path as string);
      const result = await indexProjectTechnologies(techs, args.force_reindex as boolean);
      return result;
    }

    case 'list_projects': {
      const collections = await listCollections();
      const projects = collections
        .filter(c => c.startsWith('project_'))
        .map(c => c.replace('project_', ''));
      return { projects };
    }

    case 'get_index_stats': {
      const project = args.project as string;
      const codeStats = await getProjectStats(project);
      let thoughtsCount = 0;
      let memoriesCount = 0;

      try {
        const thoughtsStats = await getCollectionStats('project_thoughts');
        thoughtsCount = thoughtsStats?.pointsCount ?? 0;
      } catch { /* Collection existiert nicht */ }

      try {
        const memoriesStats = await getCollectionStats('synapse_memories');
        memoriesCount = memoriesStats?.pointsCount ?? 0;
      } catch { /* Collection existiert nicht */ }

      return {
        project,
        totalFiles: codeStats?.fileCount ?? 0,
        totalVectors: (codeStats?.chunkCount ?? 0) + thoughtsCount + memoriesCount,
        collections: {
          code: { vectors: codeStats?.chunkCount ?? 0 },
          thoughts: { vectors: thoughtsCount },
          memories: { vectors: memoriesCount },
        },
      };
    }

    case 'get_detailed_stats': {
      const project = args.project as string;
      const collectionName = `project_${project}`;
      let codeByType: Record<string, number> = {};
      let totalChunks = 0;
      let thoughtsBySource: Record<string, number> = {};
      let totalThoughts = 0;
      let memoriesByCategory: Record<string, number> = {};
      let totalMemories = 0;

      try {
        const codePoints = await scrollVectors<{ file_type: string }>(collectionName, {}, 10000);
        totalChunks = codePoints.length;
        codeByType = codePoints.reduce((acc, p) => {
          const type = p.payload?.file_type || 'unknown';
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
      } catch { /* Collection existiert nicht */ }

      try {
        const thoughtPoints = await scrollVectors<{ source: string; project: string }>(
          'project_thoughts',
          { must: [{ key: 'project', match: { value: project } }] },
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
        const memoryPoints = await scrollVectors<{ category: string; project: string }>(
          'synapse_memories',
          { must: [{ key: 'project', match: { value: project } }] },
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

    // ===== CODE-SUCHE =====
    case 'semantic_code_search': {
      const results = await searchCode(
        args.query as string,
        args.project as string,
        args.file_type as string,
        (args.limit as number) || 10
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

    case 'search_docs': {
      const results = await searchDocsWithFallback(
        args.query as string,
        args.framework as string | undefined,
        args.use_context7 as boolean || false,
        (args.limit as number) || 10
      );
      return results.map(r => ({
        framework: r.payload.framework,
        title: r.payload.title,
        content: r.payload.content,
        url: r.payload.url,
        score: r.score,
      }));
    }

    // ===== PROJEKT-PLANUNG =====
    case 'get_project_plan': {
      const plan = await getPlan(args.project as string);
      return plan || { message: 'Kein Plan gefunden' };
    }

    case 'update_project_plan': {
      const result = await updatePlan(args.project as string, {
        name: args.name as string | undefined,
        description: args.description as string | undefined,
        goals: args.goals as string[] | undefined,
        architecture: args.architecture as string | undefined,
      });
      return result;
    }

    case 'add_plan_task': {
      const result = await addTask(
        args.project as string,
        args.title as string,
        args.description as string,
        args.priority as 'low' | 'medium' | 'high' | undefined
      );
      return result;
    }

    // ===== GEDANKENAUSTAUSCH =====
    case 'add_thought': {
      const result = await addThought(
        args.project as string,
        args.source as string,
        args.content as string,
        args.tags as string[] | undefined
      );
      return result;
    }

    case 'get_thoughts': {
      const thoughts = await getThoughts(
        args.project as string,
        (args.limit as number) || 50
      );
      return { thoughts };
    }

    case 'search_thoughts': {
      const results = await searchThoughts(
        args.query as string,
        args.project as string,
        (args.limit as number) || 10
      );
      return results;
    }

    case 'delete_thought': {
      await deleteThought(args.project as string, args.id as string);
      return {
        success: true,
        message: `Gedanke "${args.id}" geloescht`,
      };
    }

    // ===== MEMORY =====
    case 'write_memory': {
      const existing = await getMemoryByName(args.project as string, args.name as string);
      const memory = await writeMemory(
        args.project as string,
        args.name as string,
        args.content as string,
        args.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined,
        args.tags as string[] | undefined
      );
      return {
        success: true,
        memory: {
          name: memory.name,
          category: memory.category,
          sizeChars: memory.content.length,
        },
        isUpdate: !!existing,
        message: existing
          ? `Memory "${memory.name}" aktualisiert`
          : `Memory "${memory.name}" erstellt`,
      };
    }

    case 'read_memory': {
      const memory = await getMemoryByName(args.project as string, args.name as string);
      if (!memory) {
        return { success: false, message: `Memory "${args.name}" nicht gefunden` };
      }
      return { success: true, memory };
    }

    case 'list_memories': {
      const memories = await listMemories(
        args.project as string,
        args.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined
      );
      return {
        memories: memories.map(m => ({
          name: m.name,
          category: m.category,
          tags: m.tags,
          sizeChars: m.content.length,
          updatedAt: m.updatedAt,
        })),
      };
    }

    case 'search_memory': {
      const results = await searchMemories(
        args.query as string,
        args.project as string,
        (args.limit as number) || 10
      );
      return {
        results: results.map(r => ({
          name: r.payload.name,
          category: r.payload.category,
          score: r.score,
          preview: r.payload.content.substring(0, 200) + (r.payload.content.length > 200 ? '...' : ''),
        })),
      };
    }

    case 'delete_memory': {
      const deleted = await deleteMemory(args.project as string, args.name as string);
      return {
        success: deleted,
        message: deleted ? `Memory "${args.name}" gelöscht` : `Memory "${args.name}" nicht gefunden`,
      };
    }

    case 'read_memory_with_code': {
      const result = await readMemoryWithRelatedCode(
        args.project as string,
        args.name as string,
        {
          codeLimit: args.codeLimit as number | undefined,
          includeSemanticMatches: args.includeSemanticMatches as boolean | undefined,
        }
      );
      if (!result) {
        return { success: false, message: `Memory "${args.name}" nicht gefunden` };
      }
      return { success: true, ...result };
    }

    case 'find_memories_for_file': {
      const results = await findMemoriesForPath(
        args.project as string,
        args.filePath as string,
        (args.limit as number) || 10
      );
      return {
        success: true,
        results: results.map(r => ({
          name: r.memory.name,
          category: r.memory.category,
          matchType: r.matchType,
          score: r.score,
          preview: r.memory.content.substring(0, 200) + (r.memory.content.length > 200 ? '...' : ''),
        })),
        message: `${results.length} Memories für "${args.filePath}" gefunden`,
      };
    }

    // ===== CODE-SUCHE (erweitert) =====
    case 'search_by_path': {
      const project = args.project as string;
      const pathPattern = args.path_pattern as string;
      const contentPattern = args.content_pattern as string | undefined;
      const limit = (args.limit as number) || 50;
      const collectionName = COLLECTIONS.projectCode(project);

      try {
        const allPoints = await scrollVectors<{
          file_path: string;
          file_name: string;
          file_type: string;
          line_start: number;
          line_end: number;
          content: string;
        }>(collectionName, {}, 10000);

        let matches = allPoints.filter(point => {
          const filePath = point.payload?.file_path || '';
          const normalizedPath = filePath.replace(/\\/g, '/');
          return minimatch(normalizedPath, pathPattern, { matchBase: true });
        });

        if (contentPattern) {
          const regex = new RegExp(contentPattern, 'i');
          matches = matches.filter(point => {
            const content = point.payload?.content || '';
            return regex.test(content);
          });
        }

        const totalMatches = matches.length;
        const limited = matches.slice(0, limit);

        return {
          success: true,
          results: limited.map(p => ({
            filePath: p.payload.file_path,
            fileName: p.payload.file_name,
            fileType: p.payload.file_type,
            lineStart: p.payload.line_start,
            lineEnd: p.payload.line_end,
            content: p.payload.content,
          })),
          totalMatches,
          message: totalMatches > limit
            ? `${limit} von ${totalMatches} Treffern angezeigt`
            : `${totalMatches} Treffer gefunden`,
        };
      } catch (error) {
        return {
          success: false,
          results: [],
          totalMatches: 0,
          message: `Fehler bei Pfadsuche: ${error}`,
        };
      }
    }

    case 'search_code_with_path': {
      const project = args.project as string;
      const query = args.query as string;
      const pathPattern = args.path_pattern as string | undefined;
      const fileType = args.file_type as string | undefined;
      const limit = (args.limit as number) || 10;

      try {
        if (!pathPattern) {
          const results = await searchCode(query, project, fileType, limit);
          return {
            success: true,
            results: results.map(r => ({
              filePath: r.payload.file_path,
              fileName: r.payload.file_name,
              fileType: r.payload.file_type,
              lineStart: r.payload.line_start,
              lineEnd: r.payload.line_end,
              score: r.score,
              content: r.payload.content,
            })),
            message: `${results.length} Ergebnisse gefunden`,
          };
        }

        const results = await searchCode(query, project, fileType, limit * 5);
        const filtered = results.filter(r => {
          const normalizedPath = r.payload.file_path.replace(/\\/g, '/');
          return minimatch(normalizedPath, pathPattern, { matchBase: true });
        });

        return {
          success: true,
          results: filtered.slice(0, limit).map(r => ({
            filePath: r.payload.file_path,
            fileName: r.payload.file_name,
            fileType: r.payload.file_type,
            lineStart: r.payload.line_start,
            lineEnd: r.payload.line_end,
            score: r.score,
            content: r.payload.content,
          })),
          message: `${filtered.length} Ergebnisse für Pattern "${pathPattern}"`,
        };
      } catch (error) {
        return {
          success: false,
          results: [],
          message: `Fehler bei kombinierter Suche: ${error}`,
        };
      }
    }

    case 'search_documents': {
      const results = await searchDocuments(
        args.query as string,
        args.project as string,
        {
          documentType: (args.document_type as 'pdf' | 'docx' | 'xlsx' | 'all') || 'all',
          limit: (args.limit as number) || 10,
        }
      );
      return {
        success: true,
        results: results.map(r => ({
          filePath: r.filePath,
          fileName: r.fileName,
          documentType: r.documentType,
          content: r.content,
          score: r.score,
          chunkIndex: r.chunkIndex,
        })),
        message: `${results.length} Dokument-Ergebnisse gefunden`,
      };
    }

    // ===== PROJEKT-IDEEN =====
    case 'save_project_idea': {
      const content = args.content as string;
      const project = (args.project as string) || 'ideas';
      const tags = (args.tags as string[]) || [];

      if (!content || content.trim().length === 0) {
        return {
          success: false,
          message: 'Content darf nicht leer sein',
        };
      }

      const suggestedName = generateIdeaName(content);
      const tempId = generateTempId();
      const preview = generatePreview(content);

      pendingIdeas.set(tempId, {
        content,
        project,
        suggestedName,
        tags,
        createdAt: new Date(),
      });

      return {
        success: true,
        tempId,
        suggestedName,
        preview,
        project,
        confirmationRequired: true,
        message: `Idee vorgemerkt. Name: "${suggestedName}". Bitte mit confirm_idea bestätigen oder eigenen Namen angeben.`,
      };
    }

    case 'confirm_idea': {
      const tempId = args.temp_id as string;
      const customName = args.custom_name as string | undefined;
      const pendingIdea = pendingIdeas.get(tempId);

      if (!pendingIdea) {
        return {
          success: false,
          message: `Keine vorgemerkte Idee mit ID "${tempId}" gefunden. Ideen werden nach 30 Minuten automatisch gelöscht.`,
        };
      }

      const finalName = customName?.trim() || pendingIdea.suggestedName;

      const existing = await getMemoryByName(pendingIdea.project, finalName);
      if (existing) {
        return {
          success: false,
          name: finalName,
          project: pendingIdea.project,
          message: `Ein Memory mit dem Namen "${finalName}" existiert bereits. Bitte anderen Namen wählen.`,
        };
      }

      const memory = await writeMemory(
        pendingIdea.project,
        finalName,
        pendingIdea.content,
        'note',
        [...pendingIdea.tags, 'idea']
      );

      pendingIdeas.delete(tempId);

      return {
        success: true,
        name: finalName,
        project: pendingIdea.project,
        memory: {
          name: memory.name,
          category: memory.category,
          sizeChars: memory.content.length,
        },
        message: `Idee "${finalName}" erfolgreich gespeichert in Projekt "${pendingIdea.project}".`,
      };
    }

    // ===== PROPOSALS (SCHATTENVORSCHLÄGE) =====
    case 'create_proposal': {
      const proposal = await createProposal(
        args.project as string,
        args.filePath as string,
        args.suggestedContent as string,
        args.description as string,
        args.author as string,
        args.tags as string[] | undefined
      );
      return {
        success: true,
        proposal,
        message: `Proposal "${proposal.id}" erstellt für "${proposal.filePath}"`,
      };
    }

    case 'list_proposals': {
      const proposals = await listProposals(
        args.project as string,
        args.status as 'pending' | 'reviewed' | 'accepted' | 'rejected' | undefined
      );
      return {
        success: true,
        proposals: proposals.map(p => ({
          id: p.id,
          filePath: p.filePath,
          description: p.description,
          author: p.author,
          status: p.status,
          tags: p.tags,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
        count: proposals.length,
        message: `${proposals.length} Vorschläge gefunden`,
      };
    }

    case 'get_proposal': {
      const proposal = await getProposal(
        args.project as string,
        args.id as string
      );
      if (!proposal) {
        return { success: false, message: `Proposal "${args.id}" nicht gefunden` };
      }
      return { success: true, proposal };
    }

    case 'update_proposal_status': {
      const proposal = await updateProposalStatus(
        args.project as string,
        args.id as string,
        args.status as 'pending' | 'reviewed' | 'accepted' | 'rejected'
      );
      if (!proposal) {
        return { success: false, message: `Proposal "${args.id}" nicht gefunden` };
      }
      return {
        success: true,
        proposal,
        message: `Proposal "${proposal.id}" Status geändert zu "${proposal.status}"`,
      };
    }

    case 'delete_proposal': {
      const deleted = await deleteProposal(
        args.project as string,
        args.id as string
      );
      return {
        success: deleted,
        message: deleted ? `Proposal "${args.id}" gelöscht` : `Proposal "${args.id}" nicht gefunden`,
      };
    }

    case 'search_proposals': {
      const results = await searchProposals(
        args.query as string,
        args.project as string,
        (args.limit as number) || 10
      );
      return {
        success: true,
        results: results.map(r => ({
          id: r.id,
          filePath: r.payload.file_path,
          description: r.payload.description,
          author: r.payload.author,
          status: r.payload.status,
          tags: r.payload.tags,
          score: r.score,
        })),
        message: `${results.length} Proposals gefunden`,
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
