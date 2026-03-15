/**
 * Synapse MCP - Migration Tools
 * Manuelle Embedding-Migration und Backup-Restore
 */

import {
  getEmbeddingDimension,
  embed,
  getCollectionVectorSize,
  collectionExists,
  scrollVectors,
  deleteCollection,
  ensureCollection,
  insertVector,
  readBackupFile,
  getBackupDir,
  getBackupStats,
  COLLECTIONS,
} from '@synapse/core';
import type { BackupEntry } from '@synapse/core';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Ermittelt das Text-Feld fuer Re-Embedding anhand des Collection-Typs
 */
function getEmbeddingTextField(
  collectionName: string,
  payload: Record<string, unknown>
): string {
  if (collectionName === 'project_thoughts') {
    return (payload.content as string) || '';
  }
  if (collectionName === 'synapse_memories') {
    return (payload.content as string) || '';
  }
  if (collectionName === 'project_plans') {
    const name = (payload.name as string) || '';
    const desc = (payload.description as string) || '';
    const goals = (payload.goals as string[]) || [];
    return `${name} ${desc} ${goals.join(' ')}`.trim();
  }
  if (collectionName === 'synapse_proposals') {
    return (payload.description as string) || '';
  }
  // Code-Collections: content-Feld
  return (payload.content as string) || JSON.stringify(payload);
}

interface MigrationDetail {
  collection: string;
  oldDim: number | null;
  newDim: number;
  migratedCount: number;
  failedCount: number;
}

/**
 * Migriert Embeddings bei Modellwechsel
 * Liest Payloads aus Qdrant, sichert als JSONL, loescht Collection, erstellt neu, re-embedded
 */
export async function migrateEmbeddings(
  project: string,
  options: { collections?: string[]; dryRun?: boolean } = {}
): Promise<{
  success: boolean;
  message: string;
  details: MigrationDetail[];
  backupDir: string;
}> {
  const newDim = await getEmbeddingDimension();
  const { dryRun = false } = options;

  // Standard: Alle Per-Projekt Collections
  const collectionsToCheck = options.collections ?? [
    COLLECTIONS.projectThoughts(project),
    COLLECTIONS.projectMemories(project),
    COLLECTIONS.projectPlans(project),
    COLLECTIONS.projectProposals(project),
    COLLECTIONS.projectCode(project),
  ];

  const details: MigrationDetail[] = [];
  const backupDir = getBackupDir();

  for (const collectionName of collectionsToCheck) {
    if (!(await collectionExists(collectionName))) {
      console.error(`[Migration] "${collectionName}" existiert nicht, ueberspringe`);
      continue;
    }

    const oldDim = await getCollectionVectorSize(collectionName);
    if (oldDim === newDim) {
      console.error(`[Migration] "${collectionName}": Dimensionen stimmen (${newDim}d), ueberspringe`);
      continue;
    }

    console.error(`[Migration] "${collectionName}": ${oldDim}d -> ${newDim}d`);

    // Payloads auslesen
    let points: Array<{ id: string; payload: Record<string, unknown> }> = [];
    try {
      points = await scrollVectors<Record<string, unknown>>(collectionName, {}, 10000);
    } catch {
      console.error(`[Migration] Konnte "${collectionName}" nicht lesen`);
    }

    if (dryRun) {
      details.push({
        collection: collectionName,
        oldDim,
        newDim,
        migratedCount: points.length,
        failedCount: 0,
      });
      continue;
    }

    let migratedCount = 0;
    let failedCount = 0;

    // JSONL-Backup sichern
    if (points.length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `${collectionName}_${timestamp}.jsonl`);
      const lines = points.map(p => JSON.stringify({ id: p.id, payload: p.payload }));
      fs.writeFileSync(backupPath, lines.join('\n') + '\n', 'utf-8');
      console.error(`[Migration] Backup: ${points.length} Eintraege -> ${backupPath}`);
    }

    // Collection loeschen und neu erstellen
    await deleteCollection(collectionName);
    await ensureCollection(collectionName, newDim);

    // Re-embedden
    for (const point of points) {
      try {
        const text = getEmbeddingTextField(collectionName, point.payload);
        if (!text) {
          failedCount++;
          continue;
        }
        const vector = await embed(text);
        await insertVector(collectionName, vector, point.payload, point.id);
        migratedCount++;

        if (migratedCount % 25 === 0) {
          console.error(`[Migration] "${collectionName}": ${migratedCount}/${points.length}`);
        }
      } catch (error) {
        failedCount++;
        console.error(`[Migration] Fehler bei ${point.id}: ${error}`);
      }
    }

    details.push({
      collection: collectionName,
      oldDim,
      newDim,
      migratedCount,
      failedCount,
    });
  }

  const totalMigrated = details.reduce((s, d) => s + d.migratedCount, 0);
  const totalFailed = details.reduce((s, d) => s + d.failedCount, 0);

  return {
    success: totalFailed === 0,
    message: dryRun
      ? `Dry-Run: ${details.length} Collections wuerden migriert (${totalMigrated} Eintraege)`
      : `Migration abgeschlossen: ${totalMigrated} migriert, ${totalFailed} fehlgeschlagen`,
    details,
    backupDir,
  };
}

/**
 * Stellt Daten aus JSONL-Backup wieder her
 * Re-embedded mit aktuellem Modell
 */
export async function restoreFromBackup(
  type: 'thoughts' | 'memories' | 'plans' | 'proposals' | 'all',
  project: string
): Promise<{
  success: boolean;
  restored: number;
  failed: number;
  message: string;
  files: string[];
}> {
  const newDim = await getEmbeddingDimension();
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    return { success: false, restored: 0, failed: 0, message: 'Kein Backup-Verzeichnis gefunden', files: [] };
  }

  // Passende Backup-Dateien finden
  const typeToPrefix: Record<string, string> = {
    thoughts: 'project_thoughts_',
    memories: 'synapse_memories_',
    plans: 'project_plans_',
    proposals: 'synapse_proposals_',
  };

  const typesToRestore = type === 'all'
    ? Object.keys(typeToPrefix)
    : [type];

  const typeToCollection: Record<string, string> = {
    thoughts: COLLECTIONS.projectThoughts(project),
    memories: COLLECTIONS.projectMemories(project),
    plans: COLLECTIONS.projectPlans(project),
    proposals: COLLECTIONS.projectProposals(project),
  };

  let totalRestored = 0;
  let totalFailed = 0;
  const processedFiles: string[] = [];

  for (const t of typesToRestore) {
    const prefix = typeToPrefix[t];
    const collectionName = typeToCollection[t];

    // Neueste Backup-Datei fuer diesen Typ finden
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    if (files.length === 0) {
      console.error(`[Restore] Kein Backup fuer "${t}" gefunden`);
      continue;
    }

    const latestFile = files[0];
    const filePath = path.join(backupDir, latestFile);
    console.error(`[Restore] Verwende Backup: ${latestFile}`);

    const entries = readBackupFile(filePath);
    if (entries.length === 0) continue;

    // Optional nach Projekt filtern
    const filtered = project
      ? entries.filter(e => (e.payload.project as string) === project)
      : entries;

    // Collection sicherstellen
    await ensureCollection(collectionName, newDim);

    // Eintraege wiederherstellen
    for (const entry of filtered) {
      try {
        const text = getEmbeddingTextField(collectionName, entry.payload);
        if (!text) {
          totalFailed++;
          continue;
        }
        const vector = await embed(text);
        await insertVector(collectionName, vector, entry.payload, entry.id);
        totalRestored++;

        if (totalRestored % 25 === 0) {
          console.error(`[Restore] ${totalRestored} wiederhergestellt...`);
        }
      } catch (error) {
        totalFailed++;
        console.error(`[Restore] Fehler bei ${entry.id}: ${error}`);
      }
    }

    processedFiles.push(latestFile);
  }

  return {
    success: totalFailed === 0,
    restored: totalRestored,
    failed: totalFailed,
    message: `Restore: ${totalRestored} wiederhergestellt, ${totalFailed} fehlgeschlagen`,
    files: processedFiles,
  };
}
