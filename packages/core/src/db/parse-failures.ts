/**
 * MODUL: Parse-Ausfaelle
 * ZWECK: Macht sichtbar, wenn eine Datei nicht geparst werden konnte.
 *
 * WARUM ES DIESE TABELLE GIBT:
 * llama.cpp-cuda/.../spine_mem_pool.cpp stand vom 23.05.2026 bis zum 25.07.2026
 * mit 0 Symbolen im Index, weil der C++-Parser an ihr haengenblieb. Nichts hat je
 * darauf hingewiesen — im Index ist ein Parser-Ausfall nicht davon zu
 * unterscheiden, dass eine Datei einfach nichts enthaelt. Zwei Monate stiller
 * Ausfall. Ein Fehler, den nur sieht wer zufaellig hinschaut, ist kein Fehler,
 * der auffaellt.
 *
 * REGEL: Ein Eintrag verschwindet, sobald dieselbe Datei wieder erfolgreich
 * geparst wird. Eine Tabelle voller laengst reparierter Faelle waere nach
 * kurzer Zeit wertlos, weil ihr niemand mehr traut.
 */

import type { Pool } from 'pg';

let tabelleGeprueft = false;
let tabelleExistiert: boolean | null = null;

async function stelleTabelleSicher(pool: Pool): Promise<void> {
  if (tabelleGeprueft) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parse_failures (
      id            BIGSERIAL PRIMARY KEY,
      project       TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      grund         TEXT NOT NULL,
      details       TEXT,
      parser        TEXT,
      dauer_ms      INTEGER,
      datei_bytes   INTEGER,
      aufgetreten_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project, file_path)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_parse_failures_projekt ON parse_failures(project)`);
  tabelleGeprueft = true;
  tabelleExistiert = true;
}

export interface ParseAusfall {
  project: string;
  filePath: string;
  grund: 'timeout' | 'fehler';
  details?: string;
  parser?: string;
  dauerMs?: number;
  dateiBytes?: number;
}

/** Haelt einen Ausfall fest. Ein bestehender Eintrag zur selben Datei wird aktualisiert. */
export async function vermerkeAusfall(pool: Pool, a: ParseAusfall): Promise<void> {
  try {
    await stelleTabelleSicher(pool);
    await pool.query(
      `INSERT INTO parse_failures (project, file_path, grund, details, parser, dauer_ms, datei_bytes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project, file_path) DO UPDATE
            SET grund = EXCLUDED.grund, details = EXCLUDED.details, parser = EXCLUDED.parser,
                dauer_ms = EXCLUDED.dauer_ms, datei_bytes = EXCLUDED.datei_bytes,
                aufgetreten_am = NOW()`,
      [a.project, a.filePath, a.grund, a.details ?? null, a.parser ?? null, a.dauerMs ?? null, a.dateiBytes ?? null]
    );
  } catch (err) {
    // Die Protokollierung darf den Indexlauf niemals stoppen.
    console.error(`[parse-failures] konnte Ausfall nicht vermerken (${a.project}/${a.filePath}):`, (err as Error).message);
  }
}

/**
 * Loescht den Eintrag, nachdem dieselbe Datei wieder erfolgreich geparst wurde.
 * Wird nach JEDEM erfolgreichen Parse aufgerufen und ist im Normalfall ein
 * No-op auf einer leeren Tabelle.
 */
export async function loeseAusfallAuf(pool: Pool, project: string, filePath: string): Promise<void> {
  // Nicht ueber ein prozesslokales Flag entscheiden: ein Prozess, der selbst nie
  // einen Ausfall hatte, muesste sonst nie aufraeumen — obwohl ein anderer
  // Prozess (Daemon, REST-API, CLI) sehr wohl Eintraege geschrieben haben kann.
  if (tabelleExistiert === null) {
    try {
      const r = await pool.query(`SELECT to_regclass('public.parse_failures') AS t`);
      tabelleExistiert = r.rows[0]?.t !== null;
    } catch {
      tabelleExistiert = false;
    }
  }
  if (!tabelleExistiert) return;
  try {
    await pool.query(`DELETE FROM parse_failures WHERE project = $1 AND file_path = $2`, [project, filePath]);
  } catch (err) {
    console.error(`[parse-failures] konnte Eintrag nicht aufloesen (${project}/${filePath}):`, (err as Error).message);
  }
}
