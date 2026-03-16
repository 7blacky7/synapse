/**
 * MODUL: Context7 Client
 * ZWECK: REST-API Integration fuer Framework-Dokumentation von https://context7.com/api/v2
 *
 * INPUT:
 *   - framework: string - Bibliotheks-Name (z.B. "react", "express")
 *   - libraryId?: string - Direkte Context7 Library-ID (ueberspringt Suche)
 *   - maxTokens?: number - Maximale Tokens fuer den Docs-Abruf
 *
 * OUTPUT:
 *   - string | null: resolveLibraryId() — Context7 Library-ID oder null
 *   - Context7Doc[]: fetchDocs() — Array mit { framework, version?, content, url?, title? }
 *
 * NEBENEFFEKTE:
 *   - Netzwerk: GET /v2/libs/search und GET /v2/context (context7.com)
 *   - Logs: Konsolenausgabe bei Fehlern und Cache-Hits
 *
 * ABHAENGIGKEITEN:
 *   - ../config.js (intern) - context7.apiKey (optional, lockert Rate-Limits)
 *
 * API-Endpunkte:
 *   /v2/libs/search — Library-Name → Library-ID resolven
 *   /v2/context     — Docs fuer eine Library-ID abrufen
 */

import { getConfig } from '../config.js';

export interface Context7Doc {
  framework: string;
  version?: string;
  content: string;
  url?: string;
  title?: string;
}

const BASE_URL = 'https://context7.com/api';

/**
 * Context7 REST-API Client
 */
export class Context7Client {
  private apiKey: string | undefined;

  constructor() {
    const config = getConfig();
    this.apiKey = config.context7?.apiKey;
  }

  isAvailable(): boolean {
    return true; // Funktioniert auch ohne Key (Rate-Limits sind lockerer mit Key)
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Context7-Source': 'synapse',
      'X-Context7-Server-Version': '1.0.0',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Resolved einen Framework-Namen zu einer Context7 Library-ID
   */
  async resolveLibraryId(framework: string): Promise<string | null> {
    try {
      console.error(`[Context7] Resolve Library-ID fuer "${framework}"...`);

      const url = new URL(`${BASE_URL}/v2/libs/search`);
      url.searchParams.set('query', `${framework} documentation`);
      url.searchParams.set('libraryName', framework);

      const response = await fetch(url.toString(), { headers: this.getHeaders() });

      if (!response.ok) {
        console.error(`[Context7] Library-Suche fehlgeschlagen: ${response.status}`);
        return null;
      }

      const data = await response.json() as {
        results?: Array<{
          id: string;
          title: string;
          totalSnippets: number;
          benchmarkScore: number;
        }>;
      };

      if (!data.results || data.results.length === 0) {
        console.error(`[Context7] Keine Library gefunden fuer "${framework}"`);
        return null;
      }

      // Beste Library waehlen (hoechtster benchmarkScore)
      const best = data.results.sort((a, b) => (b.benchmarkScore || 0) - (a.benchmarkScore || 0))[0];
      console.error(`[Context7] Library-ID: ${best.id} (${best.title}, ${best.totalSnippets} Snippets)`);
      return best.id;
    } catch (error) {
      console.error(`[Context7] resolveLibraryId Fehler:`, error);
      return null;
    }
  }

  /**
   * Sucht Dokumentation fuer ein Framework
   */
  async searchDocs(
    framework: string,
    query?: string,
  ): Promise<Context7Doc[]> {
    try {
      // Schritt 1: Library-ID resolven
      const libraryId = await this.resolveLibraryId(framework);
      if (!libraryId) {
        return [];
      }

      // Schritt 2: Docs abfragen ueber /v2/context
      const searchQuery = query || `${framework} getting started`;
      console.error(`[Context7] Query Docs: ${libraryId} — "${searchQuery}"...`);

      const url = new URL(`${BASE_URL}/v2/context`);
      url.searchParams.set('query', searchQuery);
      url.searchParams.set('libraryId', libraryId);

      const response = await fetch(url.toString(), { headers: this.getHeaders() });

      if (!response.ok) {
        console.error(`[Context7] Docs-Abfrage fehlgeschlagen: ${response.status}`);
        return [];
      }

      const text = await response.text();
      if (!text || text.length < 50) {
        console.error(`[Context7] Keine verwertbaren Docs erhalten`);
        return [];
      }

      // Docs in Chunks aufteilen
      const chunks = this.splitIntoChunks(text, framework);
      console.error(`[Context7] ${chunks.length} Doc-Chunks erhalten`);
      return chunks;
    } catch (error) {
      console.error(`[Context7] searchDocs Fehler:`, error);
      return [];
    }
  }

  /**
   * Teilt einen grossen Text-Block in sinnvolle Chunks auf
   */
  private splitIntoChunks(text: string, framework: string): Context7Doc[] {
    // Nach Markdown-Headings splitten
    const sections = text.split(/\n(?=#{1,3}\s)/);

    if (sections.length <= 1) {
      // Kein Heading-Split moeglich — nach Doppel-Newline splitten
      const paragraphs = text.split(/\n\n+/);
      const merged: string[] = [];
      let current = '';
      for (const p of paragraphs) {
        current += (current ? '\n\n' : '') + p;
        if (current.length >= 500) {
          merged.push(current);
          current = '';
        }
      }
      if (current.length >= 100) merged.push(current);

      return merged.map((chunk, i) => ({
        framework,
        content: chunk,
        title: `${framework} docs chunk ${i + 1}`,
      }));
    }

    return sections
      .filter(s => s.trim().length >= 100)
      .map(section => {
        const headingMatch = section.match(/^#{1,3}\s+(.+)/);
        const title = headingMatch ? headingMatch[1].trim() : `${framework} docs`;

        return {
          framework,
          content: section.trim(),
          title,
        };
      });
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
