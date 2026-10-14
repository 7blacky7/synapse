/**
 * MODUL: watcher/datenweg.ts (P9-T27, letzter Schritt: Daemon ohne DATABASE_URL)
 * ZWECK: Alle PostgreSQL-Zugriffe des FileWatchers (startFileWatcher in ./index.ts) hinter EINER
 *        Schnittstelle. Vorgabe ist pgWatcherDatenweg — exakt die bisherigen Abfragen, nur hierher
 *        verschoben. Der lokale Daemon im API-Weg uebergibt stattdessen einen Datenweg, der dieselben
 *        Schritte ueber die Synapse-API ausfuehrt (file-watcher-daemon-ts/src/daemon-sync-api.ts);
 *        die API ruft serverseitig wieder genau diese PG-Funktionen auf (routes/daemon-sync.ts).
 *        Damit bleibt die Semantik des Abgleichs (Delta + Vollabgleich, Hash-Drift-Schutz,
 *        Soft-Delete) an einer Stelle definiert.
 *
 * ZUGRIFFE:
 *   watcher_events  ereignisseAufraeumen (TTL 7 Tage), ereignisProtokollieren (best effort)
 *   code_files      codeZeileVorhanden (Rename-Erkennung beim UNLINK), geaenderte, geloeschte,
 *                   inhalt, geloeschtAbschliessen (Qdrant-Vektoren + harte Loeschung der Zeile)
 *   file_versions   hashBekannt (SYNC-1: Plattenstand ist ein bekannter frueherer Stand)
 */

import { getPool } from '../db/client.js';

/** Zeile mit geaendertem/neuem Inhalt (ohne content — der kommt erst bei Bedarf ueber inhalt()). */
export interface PgFsZeile {
  file_path: string;
  content_hash: string | null;
  updated_at: string | Date;
}

/** Soft-geloeschte Zeile. */
export interface PgFsLoeschZeile {
  id: string;
  file_path: string;
  updated_at: string | Date;
}

/** Ergebnis einer Abfrage: Delta seit der Untergrenze plus (optional) eine Seite des Vollabgleichs. */
export interface PgFsSeiten<T> {
  delta: T[];
  voll: T[];
}

export interface WatcherDatenweg {
  /** 'pg' = direkte Verbindung (Vorgabe), 'api' = ueber die Synapse-API (Daemon ohne DB). */
  readonly art: 'pg' | 'api';
  /** watcher_events des Projekts aelter als 7 Tage loeschen (einmal beim Start). */
  ereignisseAufraeumen(project: string): Promise<void>;
  /** Ein Watcher-Ereignis protokollieren. Best effort, wirft nie, blockiert nie. */
  ereignisProtokollieren(project: string, kind: string, filePath: string, details?: unknown): void;
  /** Gibt es fuer den Pfad eine nicht geloeschte code_files-Zeile? (UNLINK: Rename schon erkannt?) */
  codeZeileVorhanden(project: string, filePath: string): Promise<boolean>;
  /** Geaenderte Zeilen seit untergrenze; vollNach != null liefert zusaetzlich eine Seite des Vollabgleichs. */
  geaenderte(project: string, a: { untergrenze: string; vollNach: string | null; limit: number }): Promise<PgFsSeiten<PgFsZeile>>;
  /** Soft-geloeschte Zeilen seit untergrenze; geloeschtNach != null zusaetzlich eine Seite des Vollabgleichs. */
  geloeschte(project: string, a: { untergrenze: string; geloeschtNach: string | null; limit: number }): Promise<PgFsSeiten<PgFsLoeschZeile>>;
  /** Kennt file_versions diesen Inhalt als frueheren Stand der Datei? */
  hashBekannt(project: string, filePath: string, hash: string): Promise<boolean>;
  /** Aktueller Inhalt einer nicht geloeschten Zeile (null/undefined = keine Zeile oder kein Inhalt). */
  inhalt(project: string, filePath: string): Promise<string | null | undefined>;
  /** Nach dem Loeschen auf der Platte: Vektoren der Datei entfernen und die Zeile hart loeschen. */
  geloeschtAbschliessen(project: string, id: string, filePath: string): Promise<boolean>;
}

/** Bisheriges Verhalten: dieselben Abfragen wie vorher inline in startFileWatcher. */
export const pgWatcherDatenweg: WatcherDatenweg = {
  art: 'pg',

  async ereignisseAufraeumen(project) {
    await getPool().query(
      `DELETE FROM watcher_events WHERE project = $1 AND created_at < NOW() - INTERVAL '7 days'`,
      [project],
    );
  },

  ereignisProtokollieren(project, kind, filePath, details) {
    try {
      getPool().query(
        'INSERT INTO watcher_events (project, event_type, file_path, details) VALUES ($1, $2, $3, $4)',
        [project, kind, filePath, details ? JSON.stringify(details) : null],
      ).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  },

  async codeZeileVorhanden(project, filePath) {
    const res = await getPool().query(
      'SELECT 1 FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL',
      [project, filePath],
    );
    return Boolean(res.rows[0]);
  },

  async geaenderte(project, a) {
    const pool = getPool();
    // Kandidaten OHNE content laden — nur den Hash (OOM-Schutz, siehe startFileWatcher).
    const delta = await pool.query<PgFsZeile>(
      `SELECT file_path, content_hash, updated_at FROM code_files
       WHERE project = $1 AND updated_at >= $2 AND content IS NOT NULL AND deleted_at IS NULL`,
      [project, a.untergrenze],
    );
    // Keyset-Paging statt eines synchronen Hash-Laufs ueber zehntausende Dateien.
    const voll = a.vollNach != null ? await pool.query<PgFsZeile>(
      `SELECT file_path, content_hash, updated_at FROM code_files
       WHERE project = $1 AND file_path > $2 AND content IS NOT NULL AND deleted_at IS NULL
       ORDER BY file_path LIMIT $3`, [project, a.vollNach, a.limit],
    ) : { rows: [] as PgFsZeile[] };
    return { delta: delta.rows, voll: voll.rows };
  },

  async geloeschte(project, a) {
    const pool = getPool();
    const delta = await pool.query<PgFsLoeschZeile>(
      `SELECT id, file_path, updated_at FROM code_files
       WHERE project = $1 AND deleted_at IS NOT NULL AND deleted_at >= $2`,
      [project, a.untergrenze],
    );
    const voll = a.geloeschtNach != null ? await pool.query<PgFsLoeschZeile>(
      `SELECT id, file_path, updated_at FROM code_files
       WHERE project = $1 AND deleted_at IS NOT NULL AND file_path > $2 ORDER BY file_path LIMIT $3`,
      [project, a.geloeschtNach, a.limit],
    ) : { rows: [] as PgFsLoeschZeile[] };
    return { delta: delta.rows, voll: voll.rows };
  },

  async hashBekannt(project, filePath, hash) {
    const bekannt = await getPool().query(
      `SELECT 1 FROM file_versions
        WHERE project = $1 AND file_path = $2 AND content_hash = $3
        LIMIT 1`,
      [project, filePath, hash],
    );
    return (bekannt.rowCount ?? 0) > 0;
  },

  async inhalt(project, filePath) {
    const res = await getPool().query<{ content: string | null }>(
      `SELECT content FROM code_files
       WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL`,
      [project, filePath],
    );
    return res.rows[0]?.content;
  },

  async geloeschtAbschliessen(project, id, filePath) {
    const geloescht = await getPool().query(
      'DELETE FROM code_files WHERE id::text=$1 AND project=$2 AND file_path=$3 AND deleted_at IS NOT NULL RETURNING id',
      [id, project, filePath],
    );
    if (!geloescht.rowCount) return false;
    try {
      // Dynamisch wie bisher (Zyklus types/qdrant -> watcher vermeiden).
      const { COLLECTIONS } = await import('../types/index.js');
      const { deleteByFilePath } = await import('../qdrant/index.js');
      await deleteByFilePath(COLLECTIONS.projectCode(project), filePath, project);  // relativ fuer Qdrant
    } catch { /* wie bisher: Qdrant-Fehler halten die PG-Loeschung nicht auf */ }
    return true;
  },
};
