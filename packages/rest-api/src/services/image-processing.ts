/**
 * Synapse - Image Processing Service
 * Integration mit ai_photoshop CLI + Qdrant Bildspeicher
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Temp-Verzeichnis fuer Bilder
export const IMAGE_TEMP_DIR = join(tmpdir(), 'synapse-images');

// Sicherstellen dass Temp-Dir existiert
if (!existsSync(IMAGE_TEMP_DIR)) {
  mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
}

interface ImageResult {
  success: boolean;
  data?: any;
  error?: string;
  path?: string;
}

// ============================================================================
// TEMP-BILD MANAGEMENT
// ============================================================================

/**
 * Speichert Base64-Bild als temporaere Datei
 * Gibt den vollstaendigen Pfad zurueck den Claude lesen kann
 */
export function saveBase64AsTemp(base64Data: string, format: string = 'png'): string {
  const id = randomUUID().substring(0, 8);
  const filename = `image_${id}.${format}`;
  const filepath = join(IMAGE_TEMP_DIR, filename);

  // Data URL Prefix entfernen wenn vorhanden (z.B. "data:image/png;base64,")
  let cleanBase64 = base64Data;
  if (base64Data.includes(',')) {
    cleanBase64 = base64Data.split(',')[1];
  }

  // Base64 decodieren und speichern
  const buffer = Buffer.from(cleanBase64, 'base64');
  writeFileSync(filepath, buffer);

  console.log(`[ImageProcessing] Temp-Bild gespeichert: ${filepath}`);
  return filepath;
}

/**
 * Loescht temporaere Bilddatei
 */
export function deleteTempImage(filepath: string): void {
  try {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
      console.log(`[ImageProcessing] Temp-Bild geloescht: ${filepath}`);
    }
  } catch (err) {
    console.error(`[ImageProcessing] Fehler beim Loeschen: ${err}`);
  }
}

// ============================================================================
// AI_PHOTOSHOP CLI
// ============================================================================

/**
 * Fuehrt ai_photoshop CLI Command aus
 */
async function runAiPhotoshop(args: string[]): Promise<ImageResult> {
  return new Promise((resolve) => {
    const process = spawn('python', ['-m', 'ai_photoshop.cli', ...args], {
      cwd: 'F:\\m',
      shell: true
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      if (code !== 0 && !stdout) {
        console.error('[ImageProcessing] CLI Error:', stderr);
        resolve({ success: false, error: stderr || `Exit code ${code}` });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({ success: true, data: result });
      } catch {
        resolve({ success: true, data: { raw: stdout } });
      }
    });

    process.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Laedt Bild in ai_photoshop
 */
export async function loadImage(imagePath: string): Promise<ImageResult> {
  return runAiPhotoshop(['load', imagePath]);
}

/**
 * Analysiert das geladene Bild - gibt Objekte zurueck
 */
export async function analyzeImage(method: 'auto' | 'contour' | 'color' | 'edge' = 'auto'): Promise<ImageResult> {
  return runAiPhotoshop(['analyze', '--method', method]);
}

/**
 * Smart Cut - Automatisches Ausschneiden aller Objekte
 */
export async function smartCut(imagePath: string, outputDir: string): Promise<ImageResult> {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  return runAiPhotoshop(['smart-cut', imagePath, outputDir]);
}

/**
 * Waehlt Objekt nach ID
 */
export async function selectObject(objectId: number): Promise<ImageResult> {
  return runAiPhotoshop(['select-object', objectId.toString()]);
}

/**
 * Extrahiert Auswahl als Datei
 */
export async function extractSelection(outputPath: string, padding: number = 0): Promise<ImageResult> {
  return runAiPhotoshop(['extract', outputPath, '--padding', padding.toString()]);
}

/**
 * Extrahiert Auswahl als Base64
 */
export async function extractSelectionBase64(format: string = 'PNG', padding: number = 0): Promise<ImageResult> {
  return runAiPhotoshop(['extract-base64', '--format', format, '--padding', padding.toString()]);
}

/**
 * Wendet Filter an
 */
export async function applyFilter(
  filterName: string,
  params?: { strength?: number; factor?: number; intensity?: number }
): Promise<ImageResult> {
  const args = ['filter', filterName];

  if (params?.strength !== undefined) {
    args.push('--strength', params.strength.toString());
  }
  if (params?.factor !== undefined) {
    args.push('--factor', params.factor.toString());
  }
  if (params?.intensity !== undefined) {
    args.push('--intensity', params.intensity.toString());
  }

  return runAiPhotoshop(args);
}

/**
 * Zeichnet auf das Bild
 */
export async function draw(stampName: string, params: object): Promise<ImageResult> {
  return runAiPhotoshop(['draw', stampName, '--params', JSON.stringify(params)]);
}

/**
 * Speichert aktuelles Bild
 */
export async function saveImage(outputPath: string): Promise<ImageResult> {
  return runAiPhotoshop(['save', outputPath]);
}

/**
 * Exportiert als Base64
 */
export async function toBase64(format: string = 'PNG'): Promise<ImageResult> {
  return runAiPhotoshop(['to-base64', '--format', format]);
}

/**
 * Listet verfuegbare Filter
 */
export async function listFilters(): Promise<ImageResult> {
  return runAiPhotoshop(['list-filters']);
}

/**
 * Status abfragen
 */
export async function getStatus(): Promise<ImageResult> {
  return runAiPhotoshop(['status']);
}

/**
 * Session zuruecksetzen
 */
export async function resetSession(): Promise<ImageResult> {
  return runAiPhotoshop(['reset']);
}

// ============================================================================
// TEMP DIR CLEANUP
// ============================================================================

/**
 * Bereinigt alte Temp-Bilder (aelter als 1 Stunde)
 */
export function cleanupOldTempImages(): void {
  const fs = require('fs');
  const path = require('path');
  const oneHourAgo = Date.now() - (60 * 60 * 1000);

  try {
    const files = fs.readdirSync(IMAGE_TEMP_DIR);
    for (const file of files) {
      const filepath = path.join(IMAGE_TEMP_DIR, file);
      const stats = fs.statSync(filepath);
      if (stats.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filepath);
        console.log(`[ImageProcessing] Altes Temp-Bild bereinigt: ${file}`);
      }
    }
  } catch (err) {
    // Ignore
  }
}

// Cleanup alle 30 Minuten
setInterval(cleanupOldTempImages, 30 * 60 * 1000);
