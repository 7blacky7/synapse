/**
 * Synapse Core - Typen
 * Alle gemeinsamen Typdefinitionen
 */

// ===========================================
// KONFIGURATION
// ===========================================

export interface SynapseConfig {
  qdrant: {
    url: string;
    apiKey?: string;
  };
  embeddings: {
    provider: 'ollama' | 'openai';
    ollama: {
      url: string;
      model: string;
    };
    openai: {
      apiKey?: string;
      model: string;
    };
  };
  context7?: {
    apiKey?: string;
  };
  files: {
    maxSizeMB: number;
    chunkSize: number;
    chunkOverlap: number;
    debounceMs: number;
  };
  api: {
    port: number;
    host: string;
  };
}

// ===========================================
// CODE CHUNKS
// ===========================================

export interface CodeChunk {
  id: string;
  filePath: string;
  fileName: string;
  fileType: string;
  lineStart: number;
  lineEnd: number;
  project: string;
  chunkIndex: number;
  totalChunks: number;
  updatedAt: string;
  content: string;
}

export interface CodeChunkPayload {
  file_path: string;
  file_name: string;
  file_type: string;
  line_start: number;
  line_end: number;
  project: string;
  chunk_index: number;
  total_chunks: number;
  updated_at: string;
  content: string;
  [key: string]: unknown;
}

// ===========================================
// PROJEKT-PLAENE
// ===========================================

export interface ProjectPlan {
  id: string;
  project: string;
  name: string;
  description: string;
  goals: string[];
  architecture?: string;
  tasks: ProjectTask[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPlanPayload {
  project: string;
  name: string;
  description: string;
  goals: string[];
  architecture?: string;
  tasks: ProjectTask[];
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

// ===========================================
// GEDANKENAUSTAUSCH
// ===========================================

export interface Thought {
  id: string;
  project: string;
  source: ThoughtSource;
  content: string;
  tags: string[];
  timestamp: string;
}

export type ThoughtSource =
  | 'claude-code'
  | 'claude-web'
  | 'claude-desktop'
  | 'gpt'
  | 'codex'
  | 'user'
  | string;

export interface ThoughtPayload {
  project: string;
  source: string;
  content: string;
  tags: string[];
  timestamp: string;
  [key: string]: unknown;
}

// ===========================================
// DOKUMENTATION
// ===========================================

export interface DocEntry {
  id: string;
  framework: string;
  version: string;
  title: string;
  content: string;
  url?: string;
  cachedAt: string;
}

export interface DocEntryPayload {
  framework: string;
  version: string;
  title: string;
  content: string;
  url?: string;
  cached_at: string;
  [key: string]: unknown;
}

// ===========================================
// SUCHERGEBNISSE
// ===========================================

export interface SearchResult<T> {
  id: string;
  score: number;
  payload: T;
}

export interface CodeSearchResult extends SearchResult<CodeChunkPayload> {}
export interface ThoughtSearchResult extends SearchResult<ThoughtPayload> {}
export interface DocSearchResult extends SearchResult<DocEntryPayload> {}

// ===========================================
// FILEWATCHER EVENTS
// ===========================================

export interface FileEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  project: string;
}

// ===========================================
// EMBEDDING
// ===========================================

export interface EmbeddingResult {
  vector: number[];
  model: string;
  tokens?: number;
}

// ===========================================
// COLLECTION NAMEN
// ===========================================

export const COLLECTIONS = {
  /** Code pro Projekt: project_{name} */
  projectCode: (name: string) => `project_${name}`,
  /** Dokumentations-Cache */
  techDocs: 'tech_docs_cache',
  /** Projekt-Plaene */
  projectPlans: 'project_plans',
  /** Gedankenaustausch */
  projectThoughts: 'project_thoughts',
} as const;
