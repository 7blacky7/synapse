/**
 * P22-T75: Kontextfenster eines Codex-Modells aus dem Modell-Cache der Codex-CLI (models_cache.json im CODEX_HOME bzw.
 * ~/.codex). Der Wrapper laeuft im selben Container wie die CLI und liest dieselbe Quelle wie die API-Auslese (cli-modelle.ts,
 * Feld context_window). Ohne Datei/Treffer: null, dann gilt der sichtbare Rueckfall (models.ts, kontextQuelle 'fallback').
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Reines Lesen: context_window des Slugs aus dem geparsten Cache. */
export function kontextAusCodexCache(roh: unknown, slug: string): number | null {
  const modelle = (roh as { models?: unknown } | null)?.models;
  if (!Array.isArray(modelle)) return null;
  for (const m of modelle as Array<Record<string, unknown>>) {
    if (m?.slug !== slug) continue;
    const n = Number(m.context_window);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  return null;
}

const cache = new Map<string, { mtime: number; roh: unknown }>();

/** Cache-Datei neu lesen, sobald sich die Aenderungszeit aendert (Hot-Path: nur ein stat). */
export function leseCodexKontext(slug: string, home: string = process.env.CODEX_HOME || join(homedir(), '.codex')): number | null {
  const datei = join(home, 'models_cache.json');
  try {
    const mtime = statSync(datei).mtimeMs;
    let eintrag = cache.get(datei);
    if (!eintrag || eintrag.mtime !== mtime) {
      eintrag = { mtime, roh: JSON.parse(readFileSync(datei, 'utf8')) };
      cache.set(datei, eintrag);
    }
    return kontextAusCodexCache(eintrag.roh, slug);
  } catch {
    return null;
  }
}
