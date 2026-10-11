/**
 * MODUL: Tech-Docs Service
 * ZWECK: Kuratierte Technologie-Dokumentation mit PostgreSQL + Qdrant
 *
 * Zwei Quellen-Typen (User-Vorgabe 11.10.2026, P12-T16):
 * - CONTEXT7 (source='context7'): automatisch geholte Framework-Docs. GLOBAL (project NULL,
 *   Qdrant tech_docs_cache), projektuebergreifend dedupliziert per content_hash.
 * - TECHDOCS (source='research'/'manual'): von KI-Agenten selbst recherchiert. PROJEKTGEBUNDEN
 *   (project Pflicht, Qdrant project_<p>_docs), dedupliziert je (project, content_hash).
 *
 * SCHREIBWEG: IMMER zuerst PostgreSQL, dann Qdrant (Regel regel-postgres-ist-die-wahrheit-qdrant-
 * ist-abgeleitet). Der Schreibvorgang gilt als erfolgreich, sobald die Zeile in PG steht; der
 * Vektor wird nachgereicht (embeddeTechDocNach). embedded_at bleibt NULL, bis er wirklich steht —
 * schlaegt das Embedding fehl, holt embeddeOffeneEintraege (embed-backlog.ts) es nach.
 *
 * Wissens-Airbag: get_docs_for_file() prueft ob indexierte Docs neuer als Agent-Cutoff sind
 * und liefert nur kuratierte research-Chunks automatisch.
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { getPool, getHintergrundPool } from '../db/client.js';
import { embed } from '../embeddings/index.js';
import type { EmbedOptions, EmbedPriority } from '../embeddings/index.js';
import { ensureCollection } from '../qdrant/collections.js';
import { insertVector, deleteVector, deleteVectors, deleteByFilter } from '../qdrant/operations.js';
import { COLLECTIONS } from '../types/index.js';
import { getAgentSession } from './chat.js';
import { getContext7Client } from './context7.js';
import { getLanguagesForFile } from '../parser/index.js';
import { EMBED_PENDING_HINT } from './embed-backlog.js';

export interface TechDoc {
  id: string;
  framework: string;
  version: string;
  section: string | null;
  content: string;
  type: string | null;
  category: string;
  contentHash: string;
  source: string;
  indexedAt: string;
  /** NULL = global (Context7), sonst das Projekt der TechDoc */
  project?: string | null;
  /** NULL = Vektor fehlt noch (Backlog) */
  embeddedAt?: string | null;
}

/** Ergebnis einer Tech-Doc Suche */
export interface TechDocResult {
  id: string;
  score: number | null;
  framework: string;
  version: string;
  section: string;
  content: string;
  type: string;
  source: string;
}

/** Chunk-Types fuer Tech-Docs */
export type TechDocType =
  | 'feature'
  | 'breaking-change'
  | 'migration'
  | 'gotcha'
  | 'code-example'
  | 'best-practice'
  | 'known-issue'
  | 'community';

/** Eingabe fuer speichereTechDoc */
export interface TechDocEingabe {
  framework: string;
  version: string;
  section: string;
  content: string;
  type: TechDocType;
  category?: string;
  /** 'context7' = global; 'research'/'manual' (Default 'research') = projektgebunden */
  source?: string;
  /** Pflicht fuer research/manual; bei context7 ignoriert (immer global) */
  project?: string | null;
}

export interface TechDocSpeicherOptionen {
  /**
   * true: wartet, bis der Vektor steht (z. B. wenn direkt danach gesucht wird). Ein Fehler
   * ist dann nur eine Warnung — die Zeile steht in PG, der Backlog holt den Vektor nach.
   * Default false: Embedding laeuft im Hintergrund.
   */
  embeddingAbwarten?: boolean;
  /** Prioritaet in der Embedding-Queue; Bulk-Pfade (Context7) setzen 'background'. */
  priority?: EmbedPriority;
  /**
   * P5-T15: true = KEIN nebenlaeufiges Einbetten, nur embedded_at NULL — der gedrosselte Backlog
   * (embeddeOffeneEintraege) holt es nach. Pflicht fuer Massen-Schreibwege (Context7-Chunks,
   * Importe): sonst stoesst jede Zeile einen eigenen Nachtrag an und flutet Pool und Queue.
   */
  nurBacklog?: boolean;
}

export interface TechDocSpeicherErgebnis {
  success: boolean;
  id: string;
  duplicate: boolean;
  message: string;
  warning?: string;
  embeddings_pending?: boolean;
  embeddings_hint?: string;
}

/** Ein Context7-Chunk fuer speichereContext7Chunks */
export interface Context7Chunk {
  section: string;
  content: string;
  /** Default 'code-example' */
  type?: TechDocType;
}

/**
 * Beobachter fuer Context7-Abrufe aus der Suche (Auto-Fetch). Die Context7-Automatik
 * (P12-T17) merkt sich darueber die abgefragten Queries je Bibliothek.
 * Bewusst als Registrierung statt Import: so haengen die Module beim Bauen nicht aneinander.
 */
export type Context7AbfrageBeobachter = (
  framework: string,
  query: string,
  gespeichert: number
) => void | Promise<void>;

let context7AbfrageBeobachter: Context7AbfrageBeobachter | null = null;

/** Registriert (oder entfernt mit null) den Beobachter fuer Context7-Abrufe aus der Suche. */
export function setzeContext7AbfrageBeobachter(fn: Context7AbfrageBeobachter | null): void {
  context7AbfrageBeobachter = fn;
}

/** Meldet einen Context7-Abruf an den Beobachter — fire-and-forget, Fehler nur geloggt. */
export function meldeContext7Abfrage(framework: string, query: string, gespeichert: number): void {
  const fn = context7AbfrageBeobachter;
  if (!fn) return;
  try {
    void Promise.resolve(fn(framework, query, gespeichert)).catch((err) => {
      console.error('[Synapse TechDocs] Context7-Abfrage-Beobachter fehlgeschlagen:', err);
    });
  } catch (err) {
    console.error('[Synapse TechDocs] Context7-Abfrage-Beobachter fehlgeschlagen:', err);
  }
}

/** Ziel-Collection einer Tech-Doc-Zeile: projektgebunden oder global. */
function zielCollection(project: string | null | undefined): string {
  return project ? COLLECTIONS.projectDocs(project) : COLLECTIONS.techDocs;
}

/**
 * P12-T16: PG-first-Speichern fuer ALLE Tech-Docs (TechDocs und Context7).
 *
 * 1. PostgreSQL (fail-fast): INSERT mit project + embedded_at NULL. Duplikat je
 *    (COALESCE(project,''), content_hash) ist kein Fehler, sondern duplicate:true.
 * 2. Vektor nachreichen (embeddeTechDocNach) — ohne await, ausser embeddingAbwarten.
 */
export async function speichereTechDoc(
  eingabe: TechDocEingabe,
  optionen: TechDocSpeicherOptionen = {}
): Promise<TechDocSpeicherErgebnis> {
  const { version, section, content, type } = eingabe;
  const framework = eingabe.framework.toLowerCase();
  const category = eingabe.category ?? 'framework';
  const source = eingabe.source ?? 'research';
  const istContext7 = source === 'context7';

  // Context7 ist IMMER global — ein uebergebenes Projekt wird bewusst verworfen.
  // TechDocs (research/manual) sind IMMER projektgebunden — ohne Projekt kein Speichern.
  const project = istContext7 ? null : (eingabe.project?.trim() || null);
  if (!istContext7 && !project) {
    return {
      success: false,
      id: '',
      duplicate: false,
      message:
        `project fehlt: TechDocs mit source "${source}" sind projektgebunden ` +
        `(nur source "context7" ist global). Bitte project angeben.`,
    };
  }

  const contentHash = createHash('sha256').update(content).digest('hex');
  const id = uuidv4();
  const now = new Date().toISOString();
  const pool = getPool();

  // 1. PostgreSQL (Source of Truth). ON CONFLICT DO NOTHING greift am Unique-Index
  //    uq_tech_docs_project_hash — der Duplikat-Check ist damit atomar, ohne Vorab-SELECT.
  let neueId: string | null;
  try {
    const res = await pool.query(
      `INSERT INTO tech_docs (id, framework, version, section, content, type, category, content_hash, source, indexed_at, project, embedded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [id, framework, version, section, content, type, category, contentHash, source, now, project]
    );
    neueId = res.rows[0]?.id ?? null;
  } catch (error) {
    console.error('[Synapse TechDocs] PostgreSQL INSERT fehlgeschlagen:', error);
    return { success: false, id: '', duplicate: false, message: `DB-Fehler beim Speichern: ${error}` };
  }

  if (!neueId) {
    let vorhandeneId = '';
    try {
      const vorhanden = await pool.query(
        `SELECT id FROM tech_docs WHERE COALESCE(project, '') = $1 AND content_hash = $2 LIMIT 1`,
        [project ?? '', contentHash]
      );
      vorhandeneId = vorhanden.rows[0]?.id ?? '';
    } catch (error) {
      console.error('[Synapse TechDocs] PostgreSQL Duplikat-Lookup fehlgeschlagen:', error);
    }
    return {
      success: true,
      id: vorhandeneId,
      duplicate: true,
      message: `Duplikat: ${framework} ${version} ${section} existiert bereits${project ? ` in Projekt "${project}"` : ' (global)'}`,
    };
  }

  // 2. Qdrant (Vektor-Index) — nachgereicht. Bis dahin embedded_at NULL = Backlog-Bedingung.
  const embedOptions: EmbedOptions = optionen.priority ? { priority: optionen.priority } : {};
  let warning: string | undefined;
  let pending = true;
  if (optionen.embeddingAbwarten) {
    try {
      await embeddeTechDocNach(project, id, embedOptions);
      pending = false;
    } catch (error) {
      console.error('[Synapse TechDocs] Embedding fehlgeschlagen, Backlog holt es nach:', error);
      warning = `Embedding fehlgeschlagen (Backlog holt es nach): ${error}`;
    }
  } else if (!optionen.nurBacklog) {
    void embeddeTechDocNach(project, id, embedOptions).catch((err) => {
      console.error(`[Synapse TechDocs] Embedding fuer "${id}" fehlgeschlagen, Backlog holt es nach:`, err);
    });
  }

  console.error(`[Synapse TechDocs] ${framework} ${version} ${section} (${type}) gespeichert${project ? ` [${project}]` : ' [global]'}`);
  return {
    success: true,
    id,
    duplicate: false,
    message: `${framework} ${version} ${section} indexiert`,
    warning,
    ...(pending ? { embeddings_pending: true, embeddings_hint: EMBED_PENDING_HINT } : {}),
  };
}

/**
 * EMBED-1/P12-T16: traegt den Vektor einer Tech-Doc nach.
 *
 * Gerufen von speichereTechDoc/updateTechDoc und vom Backlog. Liest die Zeile frisch aus PG:
 * Inhalt UND Projekt (= Ziel-Collection) kommen aus der Quelle der Wahrheit, nicht vom Aufrufer.
 * Der project-Parameter ist nur da, damit der Backlog alle Tabellen gleich aufrufen kann.
 * embedded_at wird ERST nach erfolgreichem insertVector gesetzt.
 */
export async function embeddeTechDocNach(
  _project: string | null,
  id: string,
  embedOptions: EmbedOptions = {}
): Promise<void> {
  // P5-T15: Nachtraege sind Hintergrundarbeit -> eigener Pool, nie die Verbindungen der Tool-Anfragen
  const pool = getHintergrundPool();
  const { rows } = await pool.query(
    `SELECT framework, version, section, content, type, category, source, content_hash, indexed_at, project
       FROM tech_docs WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return; // zwischenzeitlich geloescht — nichts nachzutragen
  const row = rows[0];

  const collectionName = zielCollection(row.project);
  await ensureCollection(collectionName);

  // Embedding-Text unveraendert wie bisher in addTechDoc.
  const vector = await embed(`${row.framework} ${row.version} ${row.section ?? ''} ${row.content}`, embedOptions);

  // Gleiche id wie die PG-Zeile: delete + insert wirkt als upsert.
  await deleteVector(collectionName, id).catch(() => { /* existierte noch nicht */ });
  await insertVector(collectionName, vector, {
    framework: row.framework,
    version: row.version,
    section: row.section,
    content: row.content,
    type: row.type,
    category: row.category,
    source: row.source,
    content_hash: row.content_hash,
    indexed_at: new Date(row.indexed_at).toISOString(),
  }, id);

  await pool.query('UPDATE tech_docs SET embedded_at = NOW() WHERE id = $1', [id]);
}

/**
 * Fuegt ein Tech-Doc hinzu (PG-first, siehe speichereTechDoc). Signatur bleibt fuer die
 * bestehenden Aufrufer (MCP/REST docs add, Context7-Auto-Fetch) unveraendert.
 */
export async function addTechDoc(
  framework: string,
  version: string,
  section: string,
  content: string,
  type: TechDocType,
  category: string = 'framework',
  source: string = 'research',
  project?: string
): Promise<TechDocSpeicherErgebnis> {
  return speichereTechDoc({ framework, version, section, content, type, category, source, project });
}

/**
 * P12-T16/T17: speichert Context7-Chunks EINER Bibliothek PG-first und GLOBAL (project NULL).
 * Duplikate (globaler content_hash) sind kein Fehler. Leere Chunks werden uebersprungen.
 * ids = alle betroffenen Zeilen (neue UND bereits vorhandene), neueIds = nur die neuen.
 */
export async function speichereContext7Chunks(
  framework: string,
  version: string,
  chunks: Context7Chunk[],
  optionen: { embeddingAbwarten?: boolean } = {}
): Promise<{ gespeichert: number; duplikate: number; fehlgeschlagen: number; ids: string[]; neueIds: string[] }> {
  const ergebnis = { gespeichert: 0, duplikate: 0, fehlgeschlagen: 0, ids: [] as string[], neueIds: [] as string[] };
  for (const chunk of chunks) {
    if (!chunk.content || chunk.content.trim().length === 0) continue;
    const r = await speichereTechDoc(
      {
        framework,
        version: version || 'latest',
        section: chunk.section || 'context7',
        content: chunk.content,
        type: chunk.type ?? 'code-example',
        category: 'framework',
        source: 'context7',
      },
      // P5-T15: Massen-Schreibweg -> nur embedded_at NULL, der gedrosselte Backlog bettet nach.
      // Wer direkt danach sucht (embeddingAbwarten), bettet wie bisher sofort ein.
      { embeddingAbwarten: optionen.embeddingAbwarten, priority: 'background', nurBacklog: !optionen.embeddingAbwarten }
    );
    if (!r.success) ergebnis.fehlgeschlagen++;
    else if (r.duplicate) {
      ergebnis.duplikate++;
      if (r.id) ergebnis.ids.push(r.id);
    } else {
      ergebnis.gespeichert++;
      ergebnis.ids.push(r.id);
      ergebnis.neueIds.push(r.id);
    }
  }
  return ergebnis;
}

/**
 * P12-T17: loescht alle globalen Context7-Chunks EINER Bibliothek — PG zuerst, dann die
 * Punkte in tech_docs_cache. Zusaetzlich ein Filter-Delete fuer verwaiste Altpunkte, die nie
 * eine PG-Zeile hatten (frueherer Qdrant-only-Weg des docs-indexers).
 * Nur auf ausdruecklichen Aufruf — die Context7-Automatik loescht nie selbst (User 11.10.2026).
 * @returns Anzahl geloeschter PG-Zeilen
 */
export async function loescheContext7Bibliothek(framework: string): Promise<number> {
  const fw = framework.toLowerCase();
  const pool = getPool();
  const { rows } = await pool.query(
    `DELETE FROM tech_docs
      WHERE framework = $1 AND source = 'context7' AND project IS NULL
      RETURNING id`,
    [fw]
  );
  const ids: string[] = rows.map((r: { id: string }) => r.id);

  try {
    for (let i = 0; i < ids.length; i += 500) {
      await deleteVectors(COLLECTIONS.techDocs, ids.slice(i, i + 500));
    }
    await deleteByFilter(COLLECTIONS.techDocs, {
      must: [
        { key: 'framework', match: { value: fw } },
        { key: 'source', match: { value: 'context7' } },
      ],
    });
  } catch (error) {
    // PG ist bereits bereinigt; verbliebene Punkte sind verwaist und fallen beim Re-Embedding weg.
    console.error(`[Synapse TechDocs] Qdrant-Delete fuer Context7 "${fw}" fehlgeschlagen:`, error);
  }

  console.error(`[Synapse TechDocs] Context7 "${fw}": ${ids.length} Chunks geloescht`);
  return ids.length;
}

/**
 * Sucht in Tech-Docs (semantisch ueber Qdrant)
 *
 * scope (P12-T16): project -> TechDocs des Projekts (project_<p>_docs), global -> Context7
 * (tech_docs_cache), all -> beides. Die Suche bleibt bewusst auf den Collections: dort liegen
 * auch die Altvektoren, deren PG-Zeile bis zum Migrationsskript noch project NULL hat.
 */
export async function searchTechDocs(
  query: string,
  options: {
    framework?: string;
    type?: string;
    source?: string;
    project?: string;
    limit?: number;
    scope?: 'global' | 'project' | 'all';
  } = {}
): Promise<Array<TechDocResult>> {
  const { framework, type, source, project, limit: rawLimit = 10, scope = 'project' } = options;
  const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : rawLimit;

  const { getConfig } = await import('../config.js');
  const qdrantUrl = getConfig().qdrant.url;
  const queryVector = await embed(query, { art: 'query' });

  const must: Array<Record<string, unknown>> = [];
  if (framework) must.push({ key: 'framework', match: { value: framework.toLowerCase() } });
  if (type) must.push({ key: 'type', match: { value: type } });
  if (source) must.push({ key: 'source', match: { value: source } });

  /** Fuehrt eine Qdrant-Suche in einer Collection durch */
  async function searchInCollection(collectionName: string): Promise<TechDocResult[]> {
    const searchBody: Record<string, unknown> = {
      vector: queryVector,
      limit,
      with_payload: true,
    };
    if (must.length > 0) {
      searchBody.filter = { must };
    }

    console.error(`[Synapse TechDocs] Suche in "${collectionName}" mit ${queryVector.length}d Vektor, limit=${limit}`);

    const response = await fetch(`${qdrantUrl}/collections/${collectionName}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(searchBody),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Qdrant search failed: ${response.status} ${errBody}`);
    }

    const data = await response.json() as { result: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
    return data.result.map(r => ({
      id: r.id as string,
      score: r.score,
      framework: r.payload.framework as string,
      version: r.payload.version as string,
      section: r.payload.section as string,
      content: r.payload.content as string,
      type: r.payload.type as string,
      source: r.payload.source as string,
    }));
  }

  // Scope-basierte Suche
  let mapped: TechDocResult[];

  if (scope === 'global') {
    mapped = await searchInCollection(COLLECTIONS.techDocs);
  } else if (scope === 'all') {
    const projectCollection = project ? COLLECTIONS.projectDocs(project) : null;
    const [globalResults, projectResults] = await Promise.all([
      searchInCollection(COLLECTIONS.techDocs),
      projectCollection ? searchInCollection(projectCollection) : Promise.resolve([] as TechDocResult[]),
    ]);
    // Duplikate per id filtern (eine PG-Zeile gehoert in genau eine Collection, Altbestand
    // vor dem Migrationsskript kann aber in beiden liegen)
    const seen = new Set<string>();
    const merged: TechDocResult[] = [];
    for (const r of [...projectResults, ...globalResults]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }
    mapped = merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  } else {
    // scope === 'project' (Default)
    mapped = await searchInCollection(zielCollection(project));
  }

  // Context7 Auto-Fetch: Wenn keine guten Ergebnisse und Framework bekannt (nur bei project/all scope)
  const hasGoodResults = mapped.some(r => (r.score ?? 0) >= 0.60);
  if (!hasGoodResults && framework && scope !== 'global') {
    console.error(`[Synapse TechDocs] Keine guten Ergebnisse (Score < 0.60) — versuche Context7 Auto-Fetch fuer "${framework}"...`);

    const context7 = getContext7Client();
    if (context7.isAvailable()) {
      const c7Docs = await context7.searchDocs(framework, query);

      if (c7Docs.length > 0) {
        console.error(`[Synapse TechDocs] Context7 liefert ${c7Docs.length} Docs — speichere global (PG-first)...`);

        const fetched: TechDocResult[] = [];
        for (const doc of c7Docs) {
          // Context7 IMMER global — generische Docs fuer alle Projekte
          const result = await speichereTechDoc({
            framework: doc.framework || framework,
            version: doc.version || 'latest',
            section: doc.title || 'context7-fetch',
            content: doc.content,
            type: 'code-example',
            category: 'framework',
            source: 'context7',
          });

          if (result.success && !result.duplicate) {
            fetched.push({
              id: result.id,
              score: null,  // Kein echter Relevanz-Score — Auto-Fetch ohne Matching
              framework: (doc.framework || framework).toLowerCase(),
              version: doc.version || 'latest',
              section: doc.title || 'context7-fetch',
              content: doc.content,
              type: 'code-example',
              source: 'context7',
            });
          }
        }

        meldeContext7Abfrage(framework.toLowerCase(), query, fetched.length);

        if (fetched.length > 0) {
          console.error(`[Synapse TechDocs] ${fetched.length} Docs von Context7 gespeichert und zurueckgegeben`);
          return fetched;
        }
      } else {
        console.error(`[Synapse TechDocs] Context7 hat keine Docs fuer "${framework}"`);
      }
    } else {
      console.error(`[Synapse TechDocs] Context7 nicht verfuegbar (kein API-Key)`);
    }
  }

  return mapped;
}

/**
 * Wissens-Airbag: Holt relevante Tech-Docs fuer eine Datei
 * Prueft ob Docs neuer als Agent-Cutoff sind und liefert nur kuratierte research-Chunks
 *
 * @param filePath - Dateipfad (z.B. "src/api.ts")
 * @param agentId - Agent-ID fuer Cutoff-Ermittlung
 * @param project - Projekt-Name
 */
export async function getDocsForFile(
  filePath: string,
  agentId: string,
  project: string,
  opts?: { limit?: number; frameworks?: string[] }
): Promise<{
  warnings: Array<{ framework: string; version: string; docs: Array<{ section: string; type: string; content: string }> }>;
  agentCutoff: string | null;
}> {
  // 1. Agent-Cutoff ermitteln
  const session = await getAgentSession(agentId);
  const agentCutoff = session?.cutoffDate || null;

  if (!agentCutoff) {
    return { warnings: [], agentCutoff: null };
  }

  // 2. Datei -> Sprach-Parser (Registry, Single Source of Truth) -> Sprach-Hints.
  //    Framework-Docs (react, fastify, ...) laufen NICHT hier, sondern via context7 + docs(search).
  let frameworkHints = getLanguagesForFile(filePath);
  // DX-Befund 7: optionaler expliziter Framework-Filter (z.B. nur 'fastify')
  const requested = opts?.frameworks?.map((f) => f.toLowerCase()).filter(Boolean);
  if (requested && requested.length > 0) {
    frameworkHints = frameworkHints.filter((h) => requested.includes(h));
  }

  if (frameworkHints.length === 0) {
    return { warnings: [], agentCutoff };
  }

  // 3. Relevante Docs aus PostgreSQL holen (nur research, neuer als Cutoff).
  //    P12-T16: TechDocs sind projektgebunden. project IS NULL bleibt erlaubt — das ist der
  //    Altbestand ohne Zuordnung (bis zum Migrationsskript ALLE Zeilen, danach die research-
  //    Zeilen, die der User noch zuordnen muss). Ohne diese Klausel liefe der Airbag leer.
  const pool = getPool();
  let result;
  try {
    result = await pool.query(
      `SELECT framework, version, section, type, content
       FROM tech_docs
       WHERE framework = ANY($1)
         AND indexed_at > $2
         AND source = 'research'
         AND (project = $3 OR project IS NULL)
         AND type IN ('breaking-change', 'migration', 'gotcha', 'known-issue')
       ORDER BY framework, indexed_at DESC`,
      [frameworkHints, agentCutoff, project]
    );
  } catch (error) {
    console.error('[Synapse TechDocs] PostgreSQL SELECT fehlgeschlagen:', error);
    return { warnings: [], agentCutoff };
  }

  if (result.rows.length === 0) {
    return { warnings: [], agentCutoff };
  }

  // 4. Nach Framework gruppieren — DX-Befund 7: Dedupe (Section + Content-
  // Praefix) und hartes Limit pro Framework, sonst ist der Wissens-Airbag
  // selbst ein Context-Killer (z.B. dieselbe CVE mehrfach in Varianten).
  const perFrameworkLimit = Math.max(1, opts?.limit ?? 5);
  const grouped = new Map<string, { version: string; docs: Array<{ section: string; type: string; content: string }> }>();
  const seenSection = new Set<string>();
  const seenContent = new Set<string>();

  for (const row of result.rows) {
    const key = row.framework;
    if (!grouped.has(key)) {
      grouped.set(key, { version: row.version, docs: [] });
    }
    const bucket = grouped.get(key)!;
    if (bucket.docs.length >= perFrameworkLimit) continue;
    const secKey = `${key}::${String(row.section).trim().toLowerCase()}`;
    const contentKey = `${key}::${String(row.content).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)}`;
    if (seenSection.has(secKey) || seenContent.has(contentKey)) continue;
    seenSection.add(secKey);
    seenContent.add(contentKey);
    bucket.docs.push({
      section: row.section,
      type: row.type,
      content: row.content,
    });
  }

  const warnings = Array.from(grouped.entries())
    .filter(([, data]) => data.docs.length > 0)
    .map(([framework, data]) => ({
      framework,
      version: data.version,
      docs: data.docs,
    }));

  return { warnings, agentCutoff };
}

/**
 * Loescht ein Tech-Doc aus PostgreSQL + Qdrant.
 * Die Collection ergibt sich aus dem Projekt der PG-Zeile. Ein uebergebenes project wird
 * zusaetzlich bereinigt, falls es abweicht — Altzeilen ohne Projekt in PG haben ihren
 * Vektor noch in project_<p>_docs, bis das Migrationsskript gelaufen ist.
 */
export async function deleteTechDoc(
  id: string,
  project?: string
): Promise<{ success: boolean; warning?: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { success: false, warning: `Ungueltige Tech-Doc-ID "${id}" — vollstaendige UUID erwartet (kein Praefix-Match)` };
  }
  // 1. PostgreSQL (Write-Primary)
  const pool = getPool();
  let zeilenProjekt: string | null = null;
  try {
    const delRes = await pool.query('DELETE FROM tech_docs WHERE id = $1 RETURNING project', [id]);
    if (delRes.rowCount === 0) {
      return { success: false, warning: `Kein Tech-Doc mit id "${id}" gefunden — nichts geloescht` };
    }
    zeilenProjekt = delRes.rows[0]?.project ?? null;
  } catch (error) {
    console.error('[Synapse TechDocs] PostgreSQL DELETE fehlgeschlagen:', error);
    return { success: false, warning: `DB-Fehler beim Loeschen: ${error}` };
  }

  // 2. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
  let warning: string | undefined;
  const ziele = new Set<string>([zielCollection(zeilenProjekt)]);
  if (project) ziele.add(COLLECTIONS.projectDocs(project));
  for (const collectionName of ziele) {
    try {
      await deleteVector(collectionName, id);
    } catch (error) {
      console.error(`[Synapse TechDocs] Qdrant-Delete in "${collectionName}" fehlgeschlagen:`, error);
      warning = `Qdrant-Delete fehlgeschlagen: ${error}`;
    }
  }

  console.error(`[Synapse TechDocs] Doc "${id}" geloescht`);
  return { success: true, warning };
}

/**
 * Aktualisiert ein bestehendes Tech-Doc — PG zuerst, Vektor wird nachgereicht.
 * Nur uebergebene Felder werden geaendert (Merge mit dem Bestand). indexed_at wird neu
 * gesetzt, damit der Wissens-Airbag die Aktualisierung als "neuer als Cutoff" erkennt;
 * embedded_at wird NULL, bis der neue Vektor steht.
 * Altzeile ohne Projekt + uebergebenes project + kein Context7: die Zeile wird diesem Projekt
 * zugeordnet (TechDocs sind projektgebunden).
 */
export async function updateTechDoc(
  id: string,
  updates: {
    framework?: string;
    version?: string;
    section?: string;
    content?: string;
    type?: TechDocType;
    category?: string;
  },
  project?: string
): Promise<{ success: boolean; message: string; warning?: string; embeddings_pending?: boolean; embeddings_hint?: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { success: false, message: `Ungueltige Tech-Doc-ID "${id}" — vollstaendige UUID erwartet (kein Praefix-Match)` };
  }
  const pool = getPool();

  // 1. Bestehenden Datensatz laden (fuer nicht geaenderte Felder + Merge)
  let existing;
  try {
    existing = await pool.query(
      'SELECT framework, version, section, content, type, category, source, project FROM tech_docs WHERE id = $1',
      [id]
    );
  } catch (error) {
    console.error('[Synapse TechDocs] PostgreSQL SELECT (update) fehlgeschlagen:', error);
    return { success: false, message: `DB-Fehler beim Laden: ${error}` };
  }
  if (existing.rows.length === 0) {
    return { success: false, message: `Tech-Doc "${id}" nicht gefunden` };
  }
  const cur = existing.rows[0];

  // 2. Felder mergen (nur uebergebene ueberschreiben)
  const framework = (updates.framework ?? cur.framework).toLowerCase();
  const version = updates.version ?? cur.version;
  const section = updates.section ?? cur.section;
  const content = updates.content ?? cur.content;
  const type = updates.type ?? cur.type;
  const category = updates.category ?? cur.category;
  const zeilenProjekt: string | null =
    cur.project ?? (cur.source !== 'context7' && project ? project : null);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const now = new Date().toISOString();

  // 3. PostgreSQL (Source of Truth)
  try {
    await pool.query(
      `UPDATE tech_docs
       SET framework = $2, version = $3, section = $4, content = $5,
           type = $6, category = $7, content_hash = $8, indexed_at = $9,
           project = $10, embedded_at = NULL
       WHERE id = $1`,
      [id, framework, version, section, content, type, category, contentHash, now, zeilenProjekt]
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return { success: false, message: `Duplikat: dieser Inhalt existiert bereits${zeilenProjekt ? ` in Projekt "${zeilenProjekt}"` : ' (global)'}` };
    }
    console.error('[Synapse TechDocs] PostgreSQL UPDATE fehlgeschlagen:', error);
    return { success: false, message: `DB-Fehler beim Aktualisieren: ${error}` };
  }

  // 4. Abweichende Alt-Collection bereinigen, dann Vektor nachreichen.
  if (project && COLLECTIONS.projectDocs(project) !== zielCollection(zeilenProjekt)) {
    await deleteVector(COLLECTIONS.projectDocs(project), id).catch(() => { /* nicht vorhanden */ });
  }
  void embeddeTechDocNach(zeilenProjekt, id).catch((err) => {
    console.error(`[Synapse TechDocs] Re-Embedding fuer "${id}" fehlgeschlagen, Backlog holt es nach:`, err);
  });

  console.error(`[Synapse TechDocs] Doc "${id}" aktualisiert`);
  return {
    success: true,
    message: `Tech-Doc "${id}" aktualisiert`,
    embeddings_pending: true,
    embeddings_hint: EMBED_PENDING_HINT,
  };
}
