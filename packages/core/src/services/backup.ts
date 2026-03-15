/**
 * MODUL: Backup-System
 * ZWECK: JSONL-Backup fuer Agenten-Daten bei Embedding-Modellwechsel
 *
 * INPUT:
 *   - collectionName: string - Name der Qdrant-Collection
 *   - targetPath: string - Pfad fuer JSONL-Datei
 *
 * OUTPUT:
 *   - number - Anzahl gesicherter/gelesener Eintraege
 *   - BackupEntry[] - Gelesene Backup-Daten
 *
 * NEBENEFFEKTE:
 *   - Dateisystem: Schreibt/liest JSONL-Dateien in ~/.synapse/backup/
 *   - Logs: Konsolenausgabe bei Backup/Restore
 *
 * ABHÄNGIGKEITEN:
 *   - ../qdrant/operations.js (intern) - scrollVectors
 *   - fs, path, os (extern) - Dateisystem
 *
 * HINWEISE:
 *   - Nur Agenten-Daten sichern (Thoughts, Memories, Plans, Proposals)
 *   - Code-Collections werden NICHT gesichert (Filesystem-Neuindexierung)
 *   - Backup dient als Sicherheitsnetz bei Dimensions-Migration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scrollVectors } from '../qdrant/operations.js';
import { COLLECTIONS } from '../types/index.js';
import { getPool } from '../db/client.js';

const SYNAPSE_HOME = path.join(os.homedir(), '.synapse');
const BACKUP_DIR = path.join(SYNAPSE_HOME, 'backup');

export interface BackupEntry {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Gibt das Backup-Verzeichnis zurueck und erstellt es bei Bedarf
 */
export function getBackupDir(): string {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

/**
 * Sichert alle Payloads einer Qdrant-Collection als JSONL-Datei
 * Gibt Anzahl gesicherter Eintraege zurueck
 */
export async function dumpCollectionToFile(
  collectionName: string,
  targetPath: string
): Promise<number> {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let allPoints: Array<{ id: string; payload: Record<string, unknown> }> = [];

  try {
    allPoints = await scrollVectors<Record<string, unknown>>(
      collectionName,
      {},
      10000
    );
  } catch (error) {
    console.error(`[Synapse Backup] Konnte Collection "${collectionName}" nicht lesen: ${error}`);
    return 0;
  }

  if (allPoints.length === 0) {
    console.error(`[Synapse Backup] Collection "${collectionName}" ist leer, nichts zu sichern`);
    return 0;
  }

  const lines = allPoints.map(point =>
    JSON.stringify({ id: point.id, payload: point.payload })
  );
  fs.writeFileSync(targetPath, lines.join('\n') + '\n', 'utf-8');

  console.error(`[Synapse Backup] ${allPoints.length} Eintraege aus "${collectionName}" gesichert -> ${targetPath}`);
  return allPoints.length;
}

/**
 * Liest eine JSONL-Backup-Datei zurueck
 */
export function readBackupFile(filePath: string): BackupEntry[] {
  if (!fs.existsSync(filePath)) {
    console.error(`[Synapse Backup] Datei nicht gefunden: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries: BackupEntry[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as BackupEntry);
    } catch {
      console.error(`[Synapse Backup] Korrupte Zeile uebersprungen`);
    }
  }

  return entries;
}

/**
 * Gibt Backup-Statistiken zurueck
 */
export function getBackupStats(): Array<{
  file: string;
  entries: number;
  sizeBytes: number;
  modified: string;
}> {
  const dir = getBackupDir();
  const stats: Array<{ file: string; entries: number; sizeBytes: number; modified: string }> = [];

  if (!fs.existsSync(dir)) return stats;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries = content.split('\n').filter(l => l.trim()).length;
    stats.push({
      file,
      entries,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return stats;
}

/**
 * Sichert alle Per-Projekt Collections als JSONL-Backups
 * Nutzt die neuen Collection-Namen (project_{name}_memories etc.)
 */
export async function backupProject(project: string): Promise<{
  collections: Array<{ name: string; entries: number; path: string }>;
  totalEntries: number;
}> {
  const dir = getBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results: Array<{ name: string; entries: number; path: string }> = [];
  let totalEntries = 0;

  const collectionsToBackup = [
    { name: COLLECTIONS.projectMemories(project), label: 'memories' },
    { name: COLLECTIONS.projectThoughts(project), label: 'thoughts' },
    { name: COLLECTIONS.projectPlans(project), label: 'plans' },
    { name: COLLECTIONS.projectProposals(project), label: 'proposals' },
  ];

  for (const col of collectionsToBackup) {
    const filePath = path.join(dir, `${col.name}_${timestamp}.jsonl`);
    const count = await dumpCollectionToFile(col.name, filePath);
    if (count > 0) {
      results.push({ name: col.label, entries: count, path: filePath });
      totalEntries += count;
    }
  }

  // PostgreSQL-Backup (alle Projekt-Daten als JSON)
  try {
    const pool = getPool();
    const tables = ['memories', 'thoughts', 'plans', 'proposals'];
    for (const table of tables) {
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE project = $1`, [project]
      );
      if (result.rows.length > 0) {
        const pgPath = path.join(dir, `psql_${project}_${table}_${timestamp}.jsonl`);
        const lines = result.rows.map(row => JSON.stringify(row));
        fs.writeFileSync(pgPath, lines.join('\n') + '\n', 'utf-8');
        console.error(`[Synapse Backup] PostgreSQL ${table}: ${result.rows.length} Eintraege -> ${pgPath}`);
      }
    }
  } catch (error) {
    console.error('[Synapse Backup] PostgreSQL-Backup fehlgeschlagen:', error);
  }

  console.error(`[Synapse Backup] Projekt "${project}": ${totalEntries} Eintraege gesichert (${results.length} Collections)`);
  return { collections: results, totalEntries };
}
