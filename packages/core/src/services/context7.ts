/**
 * Synapse Core - Context7 API Integration
 * Holt Framework-Dokumentation von Context7
 */

import { getConfig } from '../config.js';

export interface Context7Doc {
  framework: string;
  version?: string;
  content: string;
  url?: string;
  title?: string;
}

export interface Context7SearchResult {
  docs: Context7Doc[];
  cached: boolean;
}

/**
 * Context7 API Client
 */
export class Context7Client {
  private apiKey: string | undefined;
  private baseUrl = 'https://api.context7.com/v1';

  constructor() {
    const config = getConfig();
    this.apiKey = config.context7?.apiKey;
  }

  /**
   * Prüft ob Context7 verfügbar ist
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Sucht Dokumentation für ein Framework
   */
  async searchDocs(
    framework: string,
    query?: string,
    version?: string
  ): Promise<Context7Doc[]> {
    if (!this.apiKey) {
      console.warn('[Context7] Kein API-Key konfiguriert');
      return [];
    }

    try {
      const params = new URLSearchParams({
        framework,
        ...(query && { query }),
        ...(version && { version }),
      });

      const response = await fetch(`${this.baseUrl}/docs/search?${params}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error(`[Context7] API-Fehler: ${response.status}`);
        return [];
      }

      const data = await response.json();
      return this.formatDocs(data, framework, version);
    } catch (error) {
      console.error('[Context7] Fehler:', error);
      return [];
    }
  }

  /**
   * Holt Basis-Dokumentation für ein Framework
   * (Getting Started, Core Concepts, API Reference)
   */
  async getBaseDocs(framework: string, version?: string): Promise<Context7Doc[]> {
    if (!this.apiKey) {
      console.warn('[Context7] Kein API-Key konfiguriert');
      return [];
    }

    try {
      const params = new URLSearchParams({
        framework,
        type: 'base',
        ...(version && { version }),
      });

      const response = await fetch(`${this.baseUrl}/docs/base?${params}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error(`[Context7] API-Fehler: ${response.status}`);
        return [];
      }

      const data = await response.json();
      return this.formatDocs(data, framework, version);
    } catch (error) {
      console.error('[Context7] Fehler:', error);
      return [];
    }
  }

  /**
   * Formatiert API-Antwort in einheitliches Format
   */
  private formatDocs(data: any, framework: string, version?: string): Context7Doc[] {
    if (!data || !Array.isArray(data.results)) {
      return [];
    }

    return data.results.map((doc: any) => ({
      framework,
      version: version || doc.version,
      content: doc.content || doc.text || '',
      url: doc.url || doc.source,
      title: doc.title || doc.name,
    }));
  }
}

// Singleton-Instanz
let context7Client: Context7Client | null = null;

export function getContext7Client(): Context7Client {
  if (!context7Client) {
    context7Client = new Context7Client();
  }
  return context7Client;
}
