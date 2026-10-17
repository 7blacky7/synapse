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
    provider: 'ollama' | 'openai' | 'mistral' | 'jina' | 'voyage' | 'google' | 'cohere';
    ollama: {
      url: string;
      model: string;
    };
    openai: {
      apiKey?: string;
      model: string;
    };
    /** Generischer API-Key (Fallback fuer alle Provider) */
    apiKey?: string;
    /** Model-Override (ueberschreibt Provider-Default) */
    model?: string;
    /** Base-URL Override (ueberschreibt Provider-Preset) */
    baseUrl?: string;
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
  database: {
    url: string;
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
// MEDIA CHUNKS (Bilder, Videos)
// ===========================================

export interface MediaChunkPayload {
  file_path: string;
  file_name: string;
  file_type: string;
  media_type: string;
  media_category: 'image' | 'video';
  media_size_bytes: number;
  project: string;
  updated_at: string;
  content: string;
  [key: string]: unknown;
}

export interface MediaSearchResult extends SearchResult<MediaChunkPayload> {}

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
  warning?: string;
  /** Kurz-ID "P<n>" (Task 137fabaf). null im Bestand vor scripts/plaene-kurz-ids.mjs */
  kurz_id?: string | null;
  /** Genau ein Plan je Projekt ist aktiv; ohne plan_id wirkt der aktive */
  aktiv?: boolean;
  /** Anzahl Plaene des Projekts (fuer den Hinweis "weitere Plaene: plan(list)") */
  plaene_im_projekt?: number;
  /** Plan-Prioritaet (P3-T2): hoch | mittel | niedrig, Standard mittel (nicht die Task-priority) */
  prioritaet?: 'hoch' | 'mittel' | 'niedrig';
  /** Wiedervorlage (P3-T3): ISO-Zeitpunkt, bis dahin aus list/Onboarding ausgeblendet */
  zurueckgestellt_bis?: string;
  /** Ziel-Branch für den GIT-Commit, nicht Synapse files commit; fehlt er, gilt der aktuelle Arbeitsbranch. */
  git_branch?: string | null;
  git_branch_hinweis?: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
  warning?: string;
  /** Kurz-ID "P<n>-T<m>" (Task 137fabaf), stabil und nie wiederverwendet */
  kurz_id?: string;
  /** Ziel-Branch für den GIT-Commit; sonst vom Plan geerbt. */
  git_branch?: string | null;
  git_branch_hinweis?: string;
  /** Weitere Felder (z. B. empfehlung) bleiben beim Schreiben erhalten */
  [key: string]: unknown;
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
  source_identity_id?: string;
  content: string;
  tags: string[];
  timestamp: string;
  warning?: string;
  task_id?: string;
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
  source_identity_id?: string;
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
  /**
   * Asset-Art (P4-T67, Etappe D). Fehlt bei allen Nicht-Assets — dann ist das Ereignis
   * exakt wie vor dem Umbau. 'nur_asset': NUR der Asset-Weg (Binaerdatei), der Code-Weg
   * sieht das Ereignis nicht. 'zusaetzlich': bisheriger Weg unveraendert, Asset-Inspektion
   * kommt dazu (Media, Text-Assets wie .gltf).
   */
  asset?: 'nur_asset' | 'zusaetzlich';
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
// SCHATTENVORSCHLÄGE
// ===========================================

export interface Proposal {
  id: string;
  project: string;
  filePath: string;
  suggestedContent: string;
  description: string;
  author: string;
  author_identity_id?: string;
  status: 'pending' | 'reviewed' | 'accepted' | 'rejected';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  warning?: string;
}

export interface ProposalPayload {
  project: string;
  file_path: string;
  suggested_content: string;
  description: string;
  author: string;
  author_identity_id?: string;
  status: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ProposalSearchResult extends SearchResult<ProposalPayload> {}

// ===========================================
// CHANNELS & INBOX
// ===========================================

export interface ChannelMessage {
  id: number;
  channelName: string;
  sender: string;
  senderIdentityId?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface InboxMessage {
  id: number;
  fromAgent: string;
  toAgent: string;
  fromIdentityId?: string | null;
  toIdentityId?: string | null;
  content: string;
  processed: boolean;
  createdAt: Date;
}

// ===========================================
// COLLECTION NAMEN
// ===========================================

export const COLLECTIONS = {
  /** Code pro Projekt: project_{name}_code */
  projectCode: (project: string) => `project_${project}_code`,
  /** Media pro Projekt: project_{name}_media (Bilder, Videos) */
  projectMedia: (project: string) => `project_${project}_media`,
  /** Memories pro Projekt */
  projectMemories: (project: string) => `project_${project}_memories`,
  /** Thoughts pro Projekt */
  projectThoughts: (project: string) => `project_${project}_thoughts`,
  /** Plans pro Projekt */
  projectPlans: (project: string) => `project_${project}_plans`,
  /** Einzelne Tasks pro Projekt (P3-T15). */
  projectTasks: (project: string) => `project_${project}_tasks`,
  /** Proposals pro Projekt */
  projectProposals: (project: string) => `project_${project}_proposals`,
  /** Docs pro Projekt */
  projectDocs: (project: string) => `project_${project}_docs`,
  /** Dokumentations-Cache (global, bleibt) */
  techDocs: 'tech_docs_cache',
  /** Error-Patterns (global, nicht per-Projekt) */
  globalErrorPatterns: 'global_error_patterns',
} as const;
