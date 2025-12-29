/**
 * Synapse Core - Konfiguration
 * Laedt Umgebungsvariablen und erstellt Config-Objekt
 */

import { config as dotenvConfig } from 'dotenv';
import { SynapseConfig } from './types/index.js';

// .env laden (sucht im aktuellen Verzeichnis und aufwaerts)
dotenvConfig();

/**
 * Laedt die Konfiguration aus Umgebungsvariablen
 */
export function loadConfig(): SynapseConfig {
  return {
    qdrant: {
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      apiKey: process.env.QDRANT_API_KEY || undefined,
    },
    embeddings: {
      provider: (process.env.EMBEDDING_PROVIDER as 'ollama' | 'openai') || 'ollama',
      ollama: {
        url: process.env.OLLAMA_URL || 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'nomic-embed-text',
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY || undefined,
        model: 'text-embedding-3-small',
      },
    },
    context7: {
      apiKey: process.env.CONTEXT7_API_KEY || undefined,
    },
    files: {
      maxSizeMB: parseFloat(process.env.MAX_FILE_SIZE_MB || '1'),
      chunkSize: parseInt(process.env.CHUNK_SIZE || '1000', 10),
      chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || '200', 10),
      debounceMs: parseInt(process.env.DEBOUNCE_MS || '500', 10),
    },
    api: {
      port: parseInt(process.env.API_PORT || '3456', 10),
      host: process.env.API_HOST || '0.0.0.0',
    },
  };
}

/** Globale Konfiguration (Singleton) */
let _config: SynapseConfig | null = null;

/**
 * Gibt die globale Konfiguration zurueck
 * Laedt sie beim ersten Aufruf
 */
export function getConfig(): SynapseConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Setzt die Konfiguration zurueck (fuer Tests)
 */
export function resetConfig(): void {
  _config = null;
}
