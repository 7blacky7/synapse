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
import type { EmbedOptions } from '../embeddings/index.js';
import { getPool } from '../db/client.js';
import { ensureCollection } from '../qdrant/collections.js';
import {
  insertVector,
  searchVectors,
  deleteVector,
  deleteVectors,
} from '../qdrant/operations.js';
import {
  listeProposalsAusPg,
  leseProposalsNachIdsAusPg,
  holeProposalsPerEingabe,
  loeseProposalIdsAuf,
  mischeProposalTreffer,
  zuIdProblem,
  type ProposalIdProblem,
  type ProposalMitAufloesung,
} from './proposal-ids.js';
import type { Aufloesung } from './thought-ids.js';
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


  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `INSERT INTO proposals (id, project, file_path, suggested_content, description, author, status, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [id, project, filePath, suggestedContent, description, author, 'pending', tags, now, now]
  );

  // 2. Qdrant (Vektor-Index) — NEBENLAEUFIG seit EMBED-1.
  // Der Aufruf kehrt zurueck, sobald das Proposal in PostgreSQL steht; bis der Vektor da ist,
  // bleibt embedded_at NULL und der Backlog sieht den Eintrag.
  let warning: string | undefined;
  void embeddeProposalNach(project, id).catch(err => {
    console.error(`[Synapse] Proposal-Embedding fehlgeschlagen, Backlog holt es nach:`, err);
  });

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
    // PostgreSQL ist die Quelle der Wahrheit (nicht Qdrant); id: volle UUID oder eindeutiger Praefix
    const r = await holeProposalsPerEingabe(project, [id]);
    return (r.proposals[0] as Proposal | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Holt mehrere Proposals anhand ihrer IDs (Batch) — aus PostgreSQL.
 * ids: volle UUIDs oder eindeutige Praefixe (mind. 8 Zeichen); nicht aufloesbare fehlen im Ergebnis
 * (Details: holeProposalsMitProblemen).
 */
export async function getProposalsByIds(
  project: string,
  ids: string[]
): Promise<Proposal[]> {
  if (ids.length === 0) return [];
  const r = await holeProposalsPerEingabe(project, ids);
  return r.proposals as Proposal[];
}

/** Wie getProposalsByIds, meldet aber auch mehrdeutige/ungueltige/unbekannte Eingaben. */
export async function holeProposalsMitProblemen(
  project: string,
  ids: string[]
): Promise<{ proposals: ProposalMitAufloesung[]; probleme: Aufloesung[] }> {
  if (ids.length === 0) return { proposals: [], probleme: [] };
  return holeProposalsPerEingabe(project, ids);
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
  // PostgreSQL (Quelle der Wahrheit), neueste zuerst, Status-Filter in SQL.
  // Lightweight: suggestedContent wird NICHT mitgeliefert
  return (await listeProposalsAusPg(project, status)) as Proposal[];
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
  // Bestehenden Proposal aus PostgreSQL laden (Quelle der Wahrheit, auch ohne Vektor)
  const [bestehend] = await leseProposalsNachIdsAusPg(project, [id]);
  if (!bestehend) {
    return null;
  }

  const now = new Date().toISOString();

  // Der Vektor entsteht nicht mehr hier, sondern nebenlaeufig (siehe unten).

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler. Nur im eigenen Projekt.
  const pool = getPool();
  await pool.query('UPDATE proposals SET status = $1, updated_at = $2, embedded_at = NULL WHERE id = $3 AND project = $4', [status, now, id, project]);

  // 2. Qdrant — NEBENLAEUFIG seit EMBED-1.
  // Das UPDATE oben hat embedded_at genullt, die Zeile ist also fuer den Backlog sichtbar.
  //
  // ANMERKUNG FUER SPAETER: hier waere sogar das Embedding selbst ueberfluessig. Eine
  // Statusaenderung beruehrt weder description noch file_path — der Vektor ist danach exakt
  // derselbe, nur das Payload-Feld status ist veraltet. Richtig waere ein reines Payload-Update
  // in Qdrant statt eines Neu-Embeddings. Das ist ein eigener Eingriff und gehoert nicht in
  // diese Umstellung; nebenlaeufig kostet es jetzt wenigstens keine Wartezeit mehr.
  const warning: string | undefined = undefined;
  void embeddeProposalNach(project, id).catch(err => {
    console.error(`[Synapse] Proposal-Status-Embedding fehlgeschlagen, Backlog holt es nach:`, err);
  });

  console.error(`[Synapse] Proposal "${id}" Status geaendert zu "${status}"`);
  return { ...bestehend, status, updatedAt: now, warning };
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
    `UPDATE proposals SET description = $1, suggested_content = $2, status = $3, updated_at = $4, embedded_at = NULL WHERE id = $5 AND project = $6`,
    [mergedDescription, mergedSuggestedContent, mergedStatus, now, id, project]
  );

  // 4. Qdrant — NEBENLAEUFIG seit EMBED-1.
  // Das UPDATE oben hat embedded_at genullt: description ist Teil des Embedding-Textes, der
  // alte Vektor ist nach einer Aenderung also tatsaechlich falsch — anders als bei einer reinen
  // Statusaenderung. Die Zeile ist damit fuer den Backlog sichtbar.
  const warning: string | undefined = undefined;
  void embeddeProposalNach(project, id).catch(err => {
    console.error(`[Synapse] Proposal-Update-Embedding fehlgeschlagen, Backlog holt es nach:`, err);
  });

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

  // Existenz und Projekt-Zugehoerigkeit pruefen — in PostgreSQL (Quelle der Wahrheit)
  const [existing] = await leseProposalsNachIdsAusPg(project, [id]);

  if (!existing) {
    return { success: false };
  }

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler. Nur im eigenen Projekt.
  const pool = getPool();
  await pool.query('DELETE FROM proposals WHERE id = $1 AND project = $2', [id, project]);

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
 * Loescht mehrere Proposals anhand ihrer IDs (Batch)
 * PG: DELETE WHERE id = ANY($1::uuid[]) — atomar
 * Qdrant: deleteVectors(ids[]) — ein Call
 */
export async function deleteProposals(
  project: string,
  ids: string[]
): Promise<{ deleted: number; warning?: string }> {
  if (ids.length === 0) return { deleted: 0 };

  const collName = getCollectionName(project);

  // Existenz + Projekt-Zugehörigkeit prüfen — in PostgreSQL (Quelle der Wahrheit)
  const existing = await leseProposalsNachIdsAusPg(project, ids);
  const validIds = existing.map(r => r.id);

  if (validIds.length === 0) return { deleted: 0 };

  // 1. PostgreSQL (Write-Primary) — atomar, fail-fast. Nur im eigenen Projekt.
  const pool = getPool();
  const pgResult = await pool.query(
    'DELETE FROM proposals WHERE id = ANY($1::text[]) AND project = $2 RETURNING id',
    [validIds, project]
  );
  const deletedCount = pgResult.rowCount ?? 0;

  // 2. Qdrant — Warning bei Fehler
  let warning: string | undefined;
  try {
    await deleteVectors(collName, validIds);
  } catch (error) {
    console.error('[Synapse] Qdrant Batch-Proposal-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Delete fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] ${deletedCount} Proposals geloescht (Batch)`);
  return { deleted: deletedCount, warning };
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

  // Qdrant liefert Treffer + score; alle Felder kommen aus PostgreSQL (Quelle der Wahrheit).
  // suggestedContent bleibt leer (Lightweight). Treffer ohne PG-Zeile werden verworfen und gezaehlt.
  const zeilen = await leseProposalsNachIdsAusPg(project, results.map(r => String(r.id)));
  const gemischt = mischeProposalTreffer(results, zeilen);
  if (gemischt.verworfen > 0) {
    console.error(`[Synapse] searchProposals: ${gemischt.verworfen} Qdrant-Treffer ohne PG-Zeile verworfen (Projekt "${project}")`);
  }
  const ergebnis: SearchResult<ProposalPayload>[] = gemischt.treffer;
  if (gemischt.verworfen > 0) {
    (ergebnis as SearchResult<ProposalPayload>[] & { verworfen_ohne_pg?: number }).verworfen_ohne_pg = gemischt.verworfen;
  }
  return ergebnis;
}

// ───────────────────────── Praefix-IDs (P10-T29) ─────────────────────────

/** update per volle UUID ODER Praefix. Nicht aufloesbar/mehrdeutig -> nichts wird geaendert. */
export async function aendereProposalPerId(
  project: string,
  idEingabe: string,
  changes: { content?: string; suggestedContent?: string; status?: string }
): Promise<(Proposal & { aufgeloeste_id?: string }) | ProposalIdProblem> {
  const [a] = await loeseProposalIdsAuf(project, [idEingabe]);
  if (a.status !== 'ok' || !a.id) return zuIdProblem(a);
  const p = await updateProposal(project, a.id, changes);
  if (!p) return zuIdProblem({ eingabe: idEingabe, status: 'nicht_gefunden' });
  return a.gekuerzt ? { ...p, aufgeloeste_id: a.id } : p;
}

/** Status setzen per volle UUID ODER Praefix. Nicht aufloesbar/mehrdeutig -> nichts wird geaendert. */
export async function setzeProposalStatusPerId(
  project: string,
  idEingabe: string,
  status: Proposal['status']
): Promise<(Proposal & { aufgeloeste_id?: string }) | ProposalIdProblem> {
  const [a] = await loeseProposalIdsAuf(project, [idEingabe]);
  if (a.status !== 'ok' || !a.id) return zuIdProblem(a);
  const p = await updateProposalStatus(project, a.id, status);
  if (!p) return zuIdProblem({ eingabe: idEingabe, status: 'nicht_gefunden' });
  return a.gekuerzt ? { ...p, aufgeloeste_id: a.id } : p;
}

export interface ProposalLoeschErgebnis {
  success: boolean;
  deleted: number;
  /** volle IDs, die geloescht wurden (bzw. geloescht wuerden bei dryRun) */
  ids: string[];
  /** Eingaben, die nicht ok waren (mehrdeutig/ungueltig/unbekannt) — dafuer geschah nichts */
  probleme: ProposalIdProblem[];
  aufgeloest?: Array<{ eingabe: string; id: string }>;
  dry_run?: boolean;
  warning?: string;
}

/** delete per volle UUID(s) ODER Praefixe; mehrdeutige/ungueltige/unbekannte werden NICHT geloescht. */
export async function loescheProposalsPerId(
  project: string,
  eingaben: string[],
  optionen: { dryRun?: boolean } = {}
): Promise<ProposalLoeschErgebnis> {
  const aufl = await loeseProposalIdsAuf(project, eingaben);
  const probleme = aufl.filter(a => a.status !== 'ok').map(zuIdProblem);
  const ids = [...new Set(aufl.filter(a => a.status === 'ok' && a.id).map(a => a.id as string))];
  const aufgeloest = aufl
    .filter(a => a.status === 'ok' && a.gekuerzt && a.id)
    .map(a => ({ eingabe: a.eingabe, id: a.id as string }));
  const extra = aufgeloest.length > 0 ? { aufgeloest } : {};
  if (optionen.dryRun) {
    return { success: ids.length > 0, deleted: 0, ids, probleme, dry_run: true, ...extra };
  }
  if (ids.length === 0) return { success: false, deleted: 0, ids: [], probleme, ...extra };
  const r = await deleteProposals(project, ids);
  return { success: r.deleted > 0, deleted: r.deleted, ids, probleme, warning: r.warning, ...extra };
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


/**
 * EMBED-1: traegt den Vektor eines Proposals nach.
 *
 * Gerufen von createProposal OHNE await und vom Backlog fuer alles, was dabei liegengeblieben
 * ist. embedded_at wird ERST nach erfolgreichem insertVector gesetzt; faellt das Embedding aus,
 * bleibt die Spalte NULL und der Backlog holt den Eintrag erneut.
 */
export async function embeddeProposalNach(
  project: string,
  id: string,
  embedOptions: EmbedOptions = {},
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT file_path, suggested_content, description, author, status, tags, created_at, updated_at
       FROM proposals WHERE id = $1 AND project = $2`,
    [id, project]
  );
  if (rows.length === 0) return; // zwischenzeitlich geloescht
  const row = rows[0];

  const COLLECTION_NAME = getCollectionName(project);
  await ensureCollection(COLLECTION_NAME);

  // Derselbe Text wie im Schreibpfad: description + file_path. Wer das hier aendert, ohne es
  // dort zu aendern, bekommt zwei verschiedene Vektoren fuer denselben Eintrag — je nachdem,
  // ob er beim Schreiben oder ueber den Backlog entstanden ist.
  const vector = await embed(`${row.description} ${row.file_path}`, embedOptions);
  const payload: ProposalPayload = {
    project,
    file_path: row.file_path,
    suggested_content: row.suggested_content,
    description: row.description,
    author: row.author,
    status: row.status,
    tags: row.tags ?? [],
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };

  await deleteVector(COLLECTION_NAME, id).catch(() => { /* existierte noch nicht */ });
  await insertVector(COLLECTION_NAME, vector, payload, id);

  await pool.query('UPDATE proposals SET embedded_at = NOW() WHERE id = $1', [id]);
}
