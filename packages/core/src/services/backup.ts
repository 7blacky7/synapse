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
