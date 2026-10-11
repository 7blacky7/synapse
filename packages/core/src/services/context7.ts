/**
 * MODUL: Context7 Client
 * ZWECK: REST-API Integration fuer Framework-Dokumentation von https://context7.com/api/v2
 *
 * INPUT:
 *   - framework: string - Bibliotheks-Name (z.B. "react", "express")
 *   - libraryId: string - Context7 Library-ID (holeDocs/holeGesamtDocs, z.B. "/websites/hono_dev")
 *   - query: string - Suchtext fuer /v2/context
 *   - tokens: number - Umfang des Gesamtabrufs (nur holeGesamtDocs)
 *   - art: Context7Aufrufart - 'interaktiv' (Standard) | 'neu' | 'update' (Automatik), siehe Kontingent
 *
 * OUTPUT:
 *   - Context7Bibliothek[]: sucheBibliotheken() — ALLE Metadaten aus /v2/libs/search
 *     (id, title, lastUpdateDate, versions, trustScore, benchmarkScore, totalSnippets, ...)
 *   - Context7Bibliothek | null: resolveLibrary() — beste Bibliothek samt Metadaten
 *   - string | null: resolveLibraryId() — nur die ID (Altweg, unveraendert)
 *   - Context7Doc[]: searchDocs() / holeDocs() / holeGesamtDocs() — Array mit { framework, version?, content, url?, title? }
 *
 * KONTINGENT: JEDER HTTP-Aufruf MIT API-Key wird vorher ueber reserviereContext7Aufruf()
 *   (context7-kontingent.ts) gegen Monatsbudget/Stufe/Tagesgrenze gezaehlt — Automatik,
 *   Such-Auto-Fetch und alle anderen Aufrufer. Abgelehnt -> Context7Fehler mit istBudget (kein
 *   Netzaufruf). Ohne Key laufen Aufrufe anonym (eigenes, strengeres Rate-Limit bei Context7,
 *   nicht auf dem Konto) und werden nur geloggt. 429/Quota-Antwort -> Pause fuer alle Aufrufe
 *   (setzeContext7Pause) + Context7Fehler mit istKontingent.
 *
 * NEBENEFFEKTE:
 *   - Netzwerk: GET /v2/libs/search, /v2/context und /v1/<libraryId> (context7.com)
 *   - PostgreSQL: Zaehler in context7_automatik_stand (ueber context7-kontingent.ts)
 *   - Logs: Konsolenausgabe bei Fehlern und Cache-Hits
 *
 * FEHLER: sucheBibliotheken(), holeDocs() und holeGesamtDocs() WERFEN Context7Fehler.
 *   resolveLibrary()/resolveLibraryId()/searchDocs() fangen wie bisher alles ab (-> null bzw. []),
 *   die Suche liefert dann nur den Cache.
 *
 * ABHAENGIGKEITEN:
 *   - ../config.js (intern) - context7.apiKey (optional, lockert Rate-Limits)
 *   - ./context7-kontingent.js (intern) - Zaehler/Budget
 *
 * API-Endpunkte:
 *   /v2/libs/search — Library-Name → Library-ID + Metadaten
 *   /v2/context     — Docs fuer eine Library-ID abrufen (~5 Snippets je Query; tokens/page
 *                     werden ignoriert, gemessen 11.10.2026)
 *   /v1/<id>        — Gesamtabruf, tokens=N bestimmt den Umfang (gemessen 11.10.2026 an
 *                     /websites/hono_dev: tokens=10000 -> ~91 Snippets/30 KB, tokens=30000 ->
 *                     361 Snippets/131 KB). Standard der Automatik (User-Entscheidung 11.10.2026:
 *                     immer das Maximum), siehe SYNAPSE_CONTEXT7_TOKENS in context7-automatik.ts.
 *
 * CHUNKING: Snippets werden an den "-----"-Trennzeilen geschnitten (ein Snippet = ein Chunk),
 *   ohne Trenner nach Markdown-Ueberschriften bzw. Absaetzen.
 */

import { getConfig } from '../config.js';
import { reserviereContext7Aufruf, setzeContext7Pause, type Context7Aufrufart } from './context7-kontingent.js';

export interface Context7Doc {
  framework: string;
  version?: string;
  content: string;
  url?: string;
  title?: string;
}

/** Eine Bibliothek, wie /v2/libs/search sie liefert. Nichts wird verworfen. */
export interface Context7Bibliothek {
  id: string;
  title: string;
  description?: string;
  branch?: string;
  /** ISO-Zeitpunkt der letzten Aktualisierung bei Context7 — Grundlage des Update-Checks. */
  lastUpdateDate?: string;
  state?: string;
  totalTokens?: number;
  totalSnippets?: number;
  stars?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions: string[];
}

/**
 * Fehler eines Context7-Aufrufs.
 * istKontingent = Context7 selbst meldet Rate-Limit/Quota (Pause ist bereits gesetzt).
 * istBudget = eigenes Kontingent (Monatsbudget/Stufe/Tagesgrenze/Pause) hat den Aufruf verhindert.
 */
export class Context7Fehler extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly istKontingent: boolean,
    readonly istBudget: boolean = false,
  ) {
    super(message);
    this.name = 'Context7Fehler';
  }
}

const BASE_URL = 'https://context7.com/api';

/** Einmal je Prozess melden, dass ohne Key anonym (ungezaehlt) aufgerufen wird. */
let anonymGemeldet = false;

/** 429 ist immer Kontingent; 402/403 nur, wenn der Text nach Limit/Quota klingt. */
function istKontingentAntwort(status: number, text: string): boolean {
  if (status === 429) return true;
  if (status === 402 || status === 403) return /quota|limit|rate|credit|plan/i.test(text);
  return false;
}

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
   * GET mit Kontingent-Pruefung und einheitlicher Fehlerbehandlung: wirft Context7Fehler bei
   * abgelehntem Kontingent, Netz- und HTTP-Fehlern.
   */
  private async hole(url: URL, was: string, art: Context7Aufrufart): Promise<Response> {
    if (this.apiKey) {
      // Nur Aufrufe MIT Key gehen gegen das Konto und werden gezaehlt. Ist die Buchfuehrung selbst
      // nicht erreichbar, wird NICHT aufgerufen — lieber kein Abruf als ein ungezaehlter.
      let reservierung: Awaited<ReturnType<typeof reserviereContext7Aufruf>>;
      try {
        reservierung = await reserviereContext7Aufruf(art);
      } catch (error) {
        throw new Context7Fehler(`${was}: Kontingent-Zaehler nicht erreichbar (${(error as Error).message})`, null, false, true);
      }
      if (!reservierung.ok) {
        throw new Context7Fehler(`${was}: nicht ausgefuehrt, Kontingent (${reservierung.grund})`, null, false, true);
      }
    } else if (!anonymGemeldet) {
      // Ohne Key laeuft Context7 anonym mit eigenem, strengerem Rate-Limit — nichts zu zaehlen
      console.error('[Context7] kein API-Key gesetzt: Aufrufe laufen anonym und werden nicht gegen das Monatsbudget gezaehlt');
      anonymGemeldet = true;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), { headers: this.getHeaders() });
    } catch (error) {
      throw new Context7Fehler(`${was}: Netzwerkfehler (${(error as Error).message})`, null, false);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const meldung = `${was} fehlgeschlagen: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ''}`;
      const kontingent = istKontingentAntwort(response.status, text);
      if (kontingent) {
        await setzeContext7Pause(meldung).catch((e: unknown) =>
          console.error(`[Context7] Pause nicht gespeichert: ${(e as Error).message}`));
      }
      throw new Context7Fehler(meldung, response.status, kontingent);
    }
    return response;
  }

  /**
   * Sucht Bibliotheken zu einem Namen und liefert ALLE Treffer mit Metadaten.
   * Leeres Array = nichts gefunden; Fehler (Kontingent, Netz, HTTP) werfen Context7Fehler.
   */
  async sucheBibliotheken(framework: string, art: Context7Aufrufart = 'interaktiv'): Promise<Context7Bibliothek[]> {
    const url = new URL(`${BASE_URL}/v2/libs/search`);
    url.searchParams.set('query', `${framework} documentation`);
    url.searchParams.set('libraryName', framework);

    const response = await this.hole(url, `Library-Suche "${framework}"`, art);
    const data = await response.json() as { results?: Array<Partial<Context7Bibliothek>> };

    return (data.results ?? [])
      .filter((r): r is Partial<Context7Bibliothek> & { id: string } => typeof r?.id === 'string' && r.id.length > 0)
      .map((r) => ({
        id: r.id,
        title: r.title ?? r.id,
        description: r.description,
        branch: r.branch,
        lastUpdateDate: r.lastUpdateDate,
        state: r.state,
        totalTokens: r.totalTokens,
        totalSnippets: r.totalSnippets,
        stars: r.stars,
        trustScore: r.trustScore,
        benchmarkScore: r.benchmarkScore,
        versions: Array.isArray(r.versions) ? r.versions.filter((v): v is string => typeof v === 'string') : [],
      }));
  }

  /**
   * Waehlt aus Suchtreffern die beste Bibliothek (hoechster benchmarkScore — wie bisher).
   * Ist bevorzugteId unter den Treffern, gewinnt sie: ein Update-Check vergleicht so dieselbe
   * Bibliothek und springt nicht zwischen gleichnamigen Quellen hin und her.
   */
  waehleBibliothek(treffer: Context7Bibliothek[], bevorzugteId?: string | null): Context7Bibliothek | null {
    if (treffer.length === 0) return null;
    if (bevorzugteId) {
      const gleich = treffer.find((t) => t.id === bevorzugteId);
      if (gleich) return gleich;
    }
    return [...treffer].sort((a, b) => (b.benchmarkScore || 0) - (a.benchmarkScore || 0))[0];
  }

  /**
   * Resolved einen Framework-Namen zur besten Bibliothek samt Metadaten (null bei Fehler/nichts).
   */
  async resolveLibrary(framework: string): Promise<Context7Bibliothek | null> {
    try {
      console.error(`[Context7] Resolve Library fuer "${framework}"...`);
      const best = this.waehleBibliothek(await this.sucheBibliotheken(framework));
      if (!best) {
        console.error(`[Context7] Keine Library gefunden fuer "${framework}"`);
        return null;
      }
      console.error(`[Context7] Library-ID: ${best.id} (${best.title}, ${best.totalSnippets ?? '?'} Snippets, Stand ${best.lastUpdateDate ?? '?'})`);
      return best;
    } catch (error) {
      console.error(`[Context7] resolveLibrary Fehler:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * Resolved einen Framework-Namen zu einer Context7 Library-ID
   */
  async resolveLibraryId(framework: string): Promise<string | null> {
    return (await this.resolveLibrary(framework))?.id ?? null;
  }

  /**
   * Holt Docs fuer eine bekannte Library-ID ueber /v2/context (eine Query, ~5 Snippets).
   * Wirft Context7Fehler; leeres Array = keine verwertbaren Docs.
   */
  async holeDocs(
    libraryId: string,
    framework: string,
    query: string,
    art: Context7Aufrufart = 'interaktiv',
  ): Promise<Context7Doc[]> {
    const url = new URL(`${BASE_URL}/v2/context`);
    url.searchParams.set('query', query);
    url.searchParams.set('libraryId', libraryId);

    console.error(`[Context7] Query Docs: ${libraryId} — "${query}"...`);
    const text = await (await this.hole(url, `Docs-Abfrage ${libraryId}`, art)).text();
    if (!text || text.length < 50) return [];
    return this.splitIntoChunks(text, framework);
  }

  /**
   * Gesamtabruf ueber /v1/<libraryId>?tokens=N&type=txt (deutlich mehr Snippets als /v2/context).
   * Wirft Context7Fehler. Ein einziger Aufruf — der Umfang kostet kein zusaetzliches Kontingent.
   */
  async holeGesamtDocs(
    libraryId: string,
    framework: string,
    tokens: number,
    art: Context7Aufrufart = 'interaktiv',
  ): Promise<Context7Doc[]> {
    const url = new URL(`${BASE_URL}/v1/${libraryId.replace(/^\/+/, '')}`);
    url.searchParams.set('tokens', String(tokens));
    url.searchParams.set('type', 'txt');

    console.error(`[Context7] Gesamtabruf: ${libraryId} (tokens=${tokens})...`);
    const text = await (await this.hole(url, `Gesamtabruf ${libraryId}`, art)).text();
    if (!text || text.length < 50) return [];
    return this.splitIntoChunks(text, framework);
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
      const chunks = await this.holeDocs(libraryId, framework, query || `${framework} getting started`);
      if (chunks.length === 0) {
        console.error(`[Context7] Keine verwertbaren Docs erhalten`);
        return [];
      }
      console.error(`[Context7] ${chunks.length} Doc-Chunks erhalten`);
      return chunks;
    } catch (error) {
      console.error(`[Context7] searchDocs Fehler:`, error instanceof Error ? error.message : error);
      return [];
    }
  }

  /**
   * Teilt einen grossen Text-Block in sinnvolle Chunks auf
   */
  private splitIntoChunks(text: string, framework: string): Context7Doc[] {
    // Context7 trennt Snippets mit einer Zeile aus Bindestrichen ("-----...") — das ist die
    // natuerliche Grenze: ein Snippet = ein Chunk (Ueberschrift, Source-Zeile, Beschreibung, Code).
    const snippets = text.split(/^-{8,}\s*$/m).map((s) => s.trim()).filter((s) => s.length >= 100);
    if (snippets.length > 1) {
      return snippets.map((snippet, i) => {
        const headingMatch = snippet.match(/^#{1,3}\s+(.+)/m);
        const urlMatch = snippet.match(/^Source:\s*(\S+)/m);
        return {
          framework,
          content: snippet,
          title: headingMatch ? headingMatch[1].trim() : `${framework} docs chunk ${i + 1}`,
          url: urlMatch ? urlMatch[1] : undefined,
        };
      });
    }
    const sauber = text.replace(/^-{8,}\s*$/gm, '');

    // Nach Markdown-Headings splitten
    const sections = sauber.split(/\n(?=#{1,3}\s)/);

    if (sections.length <= 1) {
      // Kein Heading-Split moeglich — nach Doppel-Newline splitten
      const paragraphs = sauber.split(/\n\n+/);
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
        const urlMatch = section.match(/^Source:\s*(\S+)/m);

        return {
          framework,
          content: section.trim(),
          title,
          url: urlMatch ? urlMatch[1] : undefined,
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
