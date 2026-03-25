/**
 * MODUL: Proposals-System (Schattenvorschlaege)
 * ZWECK: Verwaltung von Code-Aenderungsvorschlaegen pro Projekt
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - filePath: string - Zieldatei fuer den Vorschlag
 *   - suggestedContent: string - Vorgeschlagener Dateiinhalt
 *   - description: string - Beschreibung des Vorschlags
 *   - author: string - Urheber (Agent-Name, User, etc.)
 *   - status: 'pending'|'reviewed'|'accepted'|'rejected' - Bearbeitungsstatus
 *   - tags: string[] - Optionale Tags fuer Filterung
 *   - query: string - Suchbegriff fuer semantische Suche
 *
 * OUTPUT:
 *   - Proposal: Gespeichertes Proposal-Objekt mit ID und Timestamps
 *   - Proposal[]: Liste (OHNE suggestedContent fuer Lightweight-Listing)
 *   - SearchResult<ProposalPayload>[]: Suchergebnisse (OHNE suggestedContent)
 *   - boolean: Erfolg bei Loeschung
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Schreibt/loescht in per-Projekt Collection "project_{name}_proposals"
 *   - Logs: Konsolenausgabe bei CRUD-Operationen
 *
 * ABHAENGIGKEITEN:
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - ../qdrant/collections.js (intern) - Collection-Verwaltung
 *   - ../qdrant/operations.js (intern) - CRUD-Operationen
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - listProposals() gibt NUR Metadaten zurueck (kein suggestedContent) - Lightweight-Listing
 *   - getProposal() gibt den vollen Inhalt inkl. suggestedContent zurueck
 *   - searchProposals() gibt Ergebnisse OHNE suggestedContent im Payload zurueck
 *   - Embedding wird aus "description + filePath" generiert fuer semantische Suche
 */

import { v4 as uuidv4 } from 'uuid';
import { embed } from '../embeddings/index.js';
import { getPool } from '../db/client.js';
import { ensureCollection } from '../qdrant/collections.js';
import {
  insertVector,
  searchVectors,
  scrollVectors,
  deleteVector,
  getVector,
  getVectors,
} from '../qdrant/operations.js';
import {
  Proposal,
  ProposalPayload,
  SearchResult,
  COLLECTIONS,
} from '../types/index.js';

/** Collection-Name wird jetzt per Projekt berechnet */
function getCollectionName(project: string): string {
  return COLLECTIONS.projectProposals(project);
}

/**
 * Erstellt einen neuen Proposal (Schattenvorschlag)
 *
 * Generiert UUID, embeddet "description + filePath" fuer semantische Suche
 * und speichert in der Proposals-Collection.
 */
export async function createProposal(
  project: string,
  filePath: string,
  suggestedContent: string,
  description: string,
  author: string,
  tags: string[] = []
): Promise<Proposal> {
  const COLLECTION_NAME = getCollectionName(project);
  await ensureCollection(COLLECTION_NAME);

  const now = new Date().toISOString();
  const id = uuidv4();

  const proposal: Proposal = {
    id,
    project,
    filePath,
    suggestedContent,
    description,
    author,
    status: 'pending',
    tags,
    createdAt: now,
    updatedAt: now,
  };

  // Embedding aus description + filePath generieren
  const vector = await embed(`${description} ${filePath}`);

  const payload: ProposalPayload = {
    project: proposal.project,
    file_path: proposal.filePath,
    suggested_content: proposal.suggestedContent,
    description: proposal.description,
    author: proposal.author,
    status: proposal.status,
    tags: proposal.tags,
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `INSERT INTO proposals (id, project, file_path, suggested_content, description, author, status, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [id, project, filePath, suggestedContent, description, author, 'pending', tags, now, now]
  );

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    await insertVector(COLLECTION_NAME, vector, payload, id);
  } catch (error) {
    console.error('[Synapse] Qdrant Proposal-Write fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Proposal "${id}" erstellt fuer "${filePath}" in Projekt "${project}"`);
  return { ...proposal, warning };
}

/**
 * Holt einen einzelnen Proposal mit vollem suggestedContent
 */
export async function getProposal(
  project: string,
  id: string
): Promise<Proposal | null> {
  try {
    const collName = getCollectionName(project);
    const result = await getVector<ProposalPayload>(collName, id);

    if (!result) {
      return null;
    }

    // Projekt-Zugehoerigkeit pruefen
    if (result.payload.project !== project) {
      return null;
    }

    return payloadToProposal(result.id, result.payload);
  } catch {
    return null;
  }
}

/**
 * Holt mehrere Proposals anhand ihrer IDs (Batch)
 * Nutzt Qdrant client.retrieve() fuer einen einzelnen Call statt N Einzel-Abfragen
 */
export async function getProposalsByIds(
  project: string,
  ids: string[]
): Promise<Proposal[]> {
  if (ids.length === 0) return [];

  const collName = getCollectionName(project);
  const results = await getVectors<ProposalPayload>(collName, ids);

  return results
    .filter(r => r.payload.project === project)
    .map(r => payloadToProposal(r.id, r.payload));
}

/**
 * Listet alle Proposals eines Projekts (Lightweight)
 *
 * WICHTIG: Gibt NUR Metadaten zurueck, suggestedContent wird auf '' gesetzt.
 * Fuer den vollen Inhalt getProposal() verwenden.
 */
export async function listProposals(
  project: string,
  status?: Proposal['status']
): Promise<Proposal[]> {
  const must: Array<Record<string, unknown>> = [
    { key: 'project', match: { value: project } },
  ];

  if (status) {
    must.push({ key: 'status', match: { value: status } });
  }

  const collName = getCollectionName(project);
  const results = await scrollVectors<ProposalPayload>(
    collName,
    { must },
    1000
  );

  // Lightweight: suggestedContent wird NICHT mitgeliefert
  return results.map((point) => ({
    ...payloadToProposal(point.id, point.payload),
    suggestedContent: '',
  }));
}

/**
 * Aktualisiert den Status eines Proposals
 *
 * Aendert Status (pending -> reviewed/accepted/rejected) und updatedAt.
 * Der Vektor wird mit dem aktualisierten Payload neu geschrieben.
 */
export async function updateProposalStatus(
  project: string,
  id: string,
  status: Proposal['status']
): Promise<Proposal | null> {
  const collName = getCollectionName(project);

  // Bestehenden Proposal laden (mit Vektor)
  const existing = await getVector<ProposalPayload>(collName, id);

  if (!existing) {
    return null;
  }

  // Projekt-Zugehoerigkeit pruefen
  if (existing.payload.project !== project) {
    return null;
  }

  const now = new Date().toISOString();

  // Payload aktualisieren
  const updatedPayload: ProposalPayload = {
    ...existing.payload,
    status,
    updated_at: now,
  };

  // Neuen Vektor generieren (bleibt gleich da description/filePath unveraendert)
  const vector = await embed(`${updatedPayload.description} ${updatedPayload.file_path}`);

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('UPDATE proposals SET status = $1, updated_at = $2 WHERE id = $3', [status, now, id]);

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    await deleteVector(collName, id);
    await insertVector(collName, vector, updatedPayload, id);
  } catch (error) {
    console.error('[Synapse] Qdrant Proposal-Status-Update fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Proposal "${id}" Status geaendert zu "${status}"`);
  return { ...payloadToProposal(id, updatedPayload), warning };
}

/**
 * Aktualisiert einen bestehenden Proposal (partielle Aenderungen)
 * PostgreSQL first, dann Qdrant bei content/suggestedContent-Aenderung
 */
export async function updateProposal(
  project: string,
  id: string,
  changes: { content?: string; suggestedContent?: string; status?: string }
): Promise<Proposal | null> {
  // 1. Bestehenden Proposal aus PostgreSQL laden
  const pool = getPool();
  const existing = await pool.query(
    'SELECT id, project, file_path, suggested_content, description, author, status, tags, created_at, updated_at FROM proposals WHERE project = $1 AND id = $2',
    [project, id]
  );

  if (existing.rows.length === 0) {
    console.error(`[Synapse] updateProposal: Proposal "${id}" nicht gefunden in Projekt "${project}"`);
    return null;
  }

  const row = existing.rows[0];
  const now = new Date().toISOString();

  // 2. Felder mergen (nur gesetzte changes ueberschreiben)
  // content mappt auf description (Proposal-Beschreibung)
  const mergedDescription = changes.content ?? row.description;
  const mergedSuggestedContent = changes.suggestedContent ?? row.suggested_content;
  const mergedStatus = changes.status ?? row.status;

  // 3. PostgreSQL UPDATE (Write-Primary) — fail-fast: wirft bei Fehler
  await pool.query(
    `UPDATE proposals SET description = $1, suggested_content = $2, status = $3, updated_at = $4 WHERE id = $5`,
    [mergedDescription, mergedSuggestedContent, mergedStatus, now, id]
  );

  // 4. Qdrant Vektor upserten — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    const collName = getCollectionName(project);
    await ensureCollection(collName);
    const vector = await embed(`${mergedDescription} ${row.file_path}`);
    const payload: ProposalPayload = {
      project,
      file_path: row.file_path,
      suggested_content: mergedSuggestedContent,
      description: mergedDescription,
      author: row.author,
      status: mergedStatus,
      tags: row.tags || [],
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: now,
    };
    await deleteVector(collName, id);
    await insertVector(collName, vector, payload, id);
  } catch (error) {
    console.error('[Synapse] Qdrant Proposal-Update fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  // 5. Aktualisierter Proposal zurueckgeben
  const updatedProposal: Proposal = {
    id,
    project,
    filePath: row.file_path,
    suggestedContent: mergedSuggestedContent,
    description: mergedDescription,
    author: row.author,
    status: mergedStatus as Proposal['status'],
    tags: row.tags || [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: now,
    warning,
  };

  console.error(`[Synapse] Proposal "${id}" aktualisiert fuer Projekt "${project}"`);
  return updatedProposal;
}

/**
 * Loescht einen Proposal
 */
export async function deleteProposal(
  project: string,
  id: string
): Promise<{ success: boolean; warning?: string }> {
  const collName = getCollectionName(project);

  // Existenz und Projekt-Zugehoerigkeit pruefen
  const existing = await getVector<ProposalPayload>(collName, id);

  if (!existing || existing.payload.project !== project) {
    return { success: false };
  }

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('DELETE FROM proposals WHERE id = $1', [id]);

  // 2. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
  let warning: string | undefined;
  try {
    await deleteVector(collName, id);
  } catch (error) {
    console.error('[Synapse] Qdrant Proposal-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Proposal "${id}" geloescht fuer Projekt "${project}"`);
  return { success: true, warning };
}

/**
 * Durchsucht Proposals semantisch
 *
 * Ergebnisse enthalten KEIN suggestedContent im Payload.
 */
export async function searchProposals(
  query: string,
  project: string,
  limit: number = 10
): Promise<SearchResult<ProposalPayload>[]> {
  const collName = getCollectionName(project);
  const queryVector = await embed(query);

  const filter: Record<string, unknown> = {
    must: [
      { key: 'project', match: { value: project } },
    ],
  };

  const results = await searchVectors<ProposalPayload>(
    collName,
    queryVector,
    limit,
    filter
  );

  // suggestedContent aus den Ergebnissen entfernen (Lightweight)
  return results.map((result) => ({
    ...result,
    payload: {
      ...result.payload,
      suggested_content: '',
    },
  }));
}

/**
 * Konvertiert Qdrant-Payload zu Proposal-Objekt (camelCase)
 */
function payloadToProposal(id: string, payload: ProposalPayload): Proposal {
  return {
    id,
    project: payload.project,
    filePath: payload.file_path,
    suggestedContent: payload.suggested_content,
    description: payload.description,
    author: payload.author,
    status: payload.status as Proposal['status'],
    tags: payload.tags || [],
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
  };
}
