/**
 * MODUL: Ignore Handler
 * ZWECK: Filtert Dateipfade anhand von .gitignore, .synapseignore und fest codierten Standard-Ignores
 *
 * INPUT:
 *   - projectPath: string - Projektverzeichnis fuer .gitignore/.synapseignore Suche
 *   - filePath: string - Zu pruefender Dateipfad (relativ oder absolut)
 *   - ig: Ignore - Vorgeladene Ignore-Instanz fuer performante Batch-Pruefung
 *
 * OUTPUT:
 *   - Ignore: Instanz mit allen kombinierten Ignore-Regeln (loadGitignore)
 *   - boolean: Ob eine Datei ignoriert werden soll (shouldIgnore)
 *
 * NEBENEFFEKTE:
 *   - Filesystem: Liest .gitignore und .synapseignore aus projectPath (beim Laden)
 *
 * ABHAENGIGKEITEN:
 *   - ignore (npm) - Gitignore-kompatibles Pattern-Matching
 */

import * as fs from 'fs';
import * as path from 'path';
import ignoreLib from 'ignore';
import type { Ignore } from 'ignore';

const ignore = ignoreLib.default || ignoreLib;

/** Standard-Ignores die immer gelten */
const DEFAULT_IGNORES = [
  // Versionskontrolle
  '.git',
  '.svn',
  '.hg',

  // Dependencies
  'node_modules',
  'vendor',
  'bower_components',
  '__pycache__',
  '.venv',
  'venv',
  'env',

  // Build Output
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'target',
  '.svelte-kit',
  '.astro',
  '.vercel',
  '.netlify',
  '.docusaurus',
  '.expo',
  '.serverless',
  '.serena',

  // IDE/Editor
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',
  '*~',
  '.DS_Store',
  'Thumbs.db',

  // Logs
  '*.log',
  'logs',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',

  // Cache
  '.cache',
  '.eslintcache',
  '.parcel-cache',
  '.turbo',

  // Test Coverage
  'coverage',
  '.nyc_output',

  // Secrets/Config
  '.env',
  '.env.*',
  '*.pem',
  '*.key',

  // Lock Files (oft gross und wenig informativ)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
];

/**
 * Laedt die geltenden Ignore-Regeln und erstellt eine Ignore-Instanz.
 *
 * Drei Quellen, in dieser Reihenfolge (spaetere Regel gewinnt, wie bei gitignore):
 *   1. DEFAULT_IGNORES aus dem Code — immer aktiv, nicht abschaltbar.
 *   2. .gitignore vom Dateisystem — bleibt bestehen, sonst muesste man
 *      node_modules/dist doppelt pflegen.
 *   3. Die aktiven Regeln aus project_ignore_rules (IGN-1), sofern der
 *      Projektname bekannt und der Zwischenspeicher gefuellt ist.
 *
 * Die Datei .synapseignore wird nur noch als NOTNAGEL gelesen: solange fuer das
 * Projekt keine Regeln in der Datenbank stehen. Damit laeuft ein noch nicht
 * migriertes Projekt unveraendert weiter — und es gibt keinen Zustand, in dem
 * ploetzlich gar nichts ignoriert wird.
 */
export function loadGitignore(projectPath: string, project?: string): Ignore {
  const ig = ignore();

  // Standard-Ignores hinzufuegen
  ig.add(DEFAULT_IGNORES);

  // .gitignore laden wenn vorhanden
  const gitignorePath = path.join(projectPath, '.gitignore');

  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
      console.error(`[Synapse] .gitignore geladen: ${gitignorePath}`);
    } catch (error) {
      console.warn(`[Synapse] Fehler beim Laden von .gitignore:`, error);
    }
  }

  // Regeln aus der Datenbank (IGN-1) — die eigentliche Quelle.
  const ausDatenbank = gepufferteIgnoreRegeln(project);
  if (ausDatenbank && ausDatenbank.length > 0) {
    ig.add(ausDatenbank);
    return ig;
  }

  // NOTNAGEL: .synapseignore vom Dateisystem. Greift nur, solange fuer das
  // Projekt keine Regeln in der Datenbank stehen (nicht migriert, oder die
  // Datenbank war beim Start nicht erreichbar).
  const synapseignorePath = path.join(projectPath, '.synapseignore');

  if (fs.existsSync(synapseignorePath)) {
    try {
      const content = fs.readFileSync(synapseignorePath, 'utf-8');
      ig.add(content);
      console.error(`[Synapse] .synapseignore vom Dateisystem geladen (keine Regeln in der Datenbank): ${synapseignorePath}`);
    } catch (error) {
      console.warn(`[Synapse] Fehler beim Laden von .synapseignore:`, error);
    }
  }

  return ig;
}

/**
 * Prueft ob ein Pfad ignoriert werden soll.
 *
 * Wichtig: Die `ignore`-Library interpretiert einen Pfad OHNE Trailing-Slash als Datei.
 * Patterns wie "beispiele" gefolgt von Globs ignorieren dann auch Subdirectories, obwohl
 * Negations-Patterns wie "!beispiele" + Glob + "*.moo" die Dateien darin explizit
 * einschliessen sollten. Chokidar wuerde so den gesamten Unterbaum skippen — Dateien
 * in diesen Dirs werden nie gesehen.
 *
 * Fix: Pfad sowohl als File- als auch als Directory-Variante testen. Nur wenn beide
 * Varianten ignoriert sind, gilt der Pfad wirklich als ignoriert. Das entspricht der
 * gitignore-Semantik und erlaubt Chokidar in Subdirs zu descenden, deren Inhalte per
 * Negations-Patterns wieder eingeschlossen sind.
 */
export function shouldIgnore(ig: Ignore, relativePath: string): boolean {
  // Leere Pfade nicht ignorieren
  if (!relativePath) {
    return false;
  }

  // Normalisiere Pfad (Windows -> Unix), Trailing-Slash entfernen falls vorhanden
  const normalized = relativePath.replace(/\\/g, '/').replace(/\/$/, '');

  // Als Datei UND als Directory pruefen
  return ig.ignores(normalized) && ig.ignores(normalized + '/');
}

/**
 * Erstellt Standard-Ignore Instanz (ohne .gitignore)
 */
export function createDefaultIgnore(): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  return ig;
}

/**
 * Gibt die Standard-Ignores zurueck
 */
export function getDefaultIgnores(): string[] {
  return [...DEFAULT_IGNORES];
}

// ─── IGN-3: Regeln aus PostgreSQL ────────────────────────────────────────────
//
// Der Watcher prueft die Regeln bei jedem Datei-Ereignis — ein Datenbank-Zugriff
// pro Ereignis waere zu teuer und im synchronen Pfad ohnehin nicht moeglich.
// Deshalb ein Zwischenspeicher je Projekt mit kurzer Gueltigkeit: ist sie
// abgelaufen, wird im Hintergrund nachgeladen, waehrend der Aufrufer mit dem
// letzten Stand weiterarbeitet. Die Gueltigkeit ist bewusst kuerzer als die dem
// Nutzer zugesagte Minute, damit ein Umschalten sicher innerhalb dieser Minute wirkt.

/** Gueltigkeit des Zwischenspeichers. Kuerzer als die zugesagte Minute. */
const REGEL_GUELTIGKEIT_MS = 30_000;

interface RegelStand {
  muster: string[];
  geladenAm: number;
}

const regelSpeicher = new Map<string, RegelStand>();
const laufendeAbfragen = new Set<string>();

/**
 * Liefert die zwischengespeicherten Regeln eines Projekts, oder null wenn noch
 * nie welche geladen wurden. Stoesst bei abgelaufenem Stand ein Nachladen im
 * Hintergrund an, blockiert dabei aber nicht — der Aufrufer ist synchron.
 */
export function gepufferteIgnoreRegeln(project?: string): string[] | null {
  if (!project) return null;
  const stand = regelSpeicher.get(project);
  if (!stand) return null;
  if (Date.now() - stand.geladenAm > REGEL_GUELTIGKEIT_MS && !laufendeAbfragen.has(project)) {
    void aktualisiereIgnoreRegeln(project);
  }
  return stand.muster;
}

/**
 * Laedt die aktiven Regeln eines Projekts aus project_ignore_rules in den
 * Zwischenspeicher. Liefert die Anzahl der Regeln, bei einem Fehler -1.
 *
 * WICHTIG bei einem Datenbank-Fehler: der bisherige Stand bleibt stehen. Auf
 * "nichts ignorieren" zurueckzufallen waere gefaehrlich — der naechste Scan
 * zoege dann heruntergeladene Pakete in den Index. Lieber kurz veraltet als
 * kurz blind.
 */
export async function aktualisiereIgnoreRegeln(project: string): Promise<number> {
  if (!project) return -1;
  laufendeAbfragen.add(project);
  try {
    const { getPool } = await import('../db/client.js');
    const ergebnis = await getPool().query<{ pattern: string }>(
      'SELECT pattern FROM project_ignore_rules WHERE project = $1 AND enabled ORDER BY sort_order, id',
      [project],
    );
    regelSpeicher.set(project, {
      muster: ergebnis.rows.map((zeile) => zeile.pattern),
      geladenAm: Date.now(),
    });
    return ergebnis.rowCount ?? 0;
  } catch (error) {
    console.error(
      `[Synapse] Ignore-Regeln fuer "${project}" nicht ladbar, bisheriger Stand bleibt gueltig:`,
      (error as Error).message,
    );
    return -1;
  } finally {
    laufendeAbfragen.delete(project);
  }
}

/**
 * Verwirft den zwischengespeicherten Stand. Das Pflege-Tool ruft das nach jeder
 * Regel-Aenderung auf, damit sie im eigenen Prozess sofort wirkt; andere
 * Prozesse ziehen spaetestens nach REGEL_GUELTIGKEIT_MS nach.
 */
export function verwirfIgnoreRegeln(project?: string): void {
  if (project) regelSpeicher.delete(project);
  else regelSpeicher.clear();
}

/**
 * Prueft einen Pfad und sagt, WELCHE Regel ihn ignoriert.
 *
 * Beantwortet die Frage "warum sehe ich diese Datei nicht", ohne dass jemand
 * Ignore-Dateien von Hand durchsuchen muss. Genau daran ist am 2026-07-25 Zeit
 * verloren gegangen: die entscheidende Zeile war beim Lesen abgeschnitten, und
 * der Fehler wurde deshalb erst im Code gesucht statt in den Regeln.
 */
export function erklaereIgnore(
  projectPath: string,
  relativePath: string,
  project?: string,
): { ignoriert: boolean; regel: string | null; herkunft: 'standard' | 'gitignore' | 'datenbank' | null } {
  const quellen: Array<{ herkunft: 'standard' | 'gitignore' | 'datenbank'; muster: string[] }> = [
    { herkunft: 'standard', muster: [...DEFAULT_IGNORES] },
  ];

  const gitignorePfad = path.join(projectPath, '.gitignore');
  if (fs.existsSync(gitignorePfad)) {
    try {
      quellen.push({
        herkunft: 'gitignore',
        muster: fs.readFileSync(gitignorePfad, 'utf-8').split('\n')
          .map((zeile) => zeile.trim())
          .filter((zeile) => zeile && !zeile.startsWith('#')),
      });
    } catch { /* nicht lesbar — dann eben ohne */ }
  }

  const ausDatenbank = gepufferteIgnoreRegeln(project);
  if (ausDatenbank?.length) quellen.push({ herkunft: 'datenbank', muster: ausDatenbank });

  // Die zuletzt zutreffende Regel gewinnt (gitignore-Semantik), deshalb wird
  // ueber alle Quellen durchgelaufen und der letzte Treffer behalten.
  let treffer: { regel: string; herkunft: 'standard' | 'gitignore' | 'datenbank' } | null = null;
  for (const quelle of quellen) {
    for (const muster of quelle.muster) {
      if (shouldIgnore(ignore().add(muster), relativePath)) {
        treffer = { regel: muster, herkunft: quelle.herkunft };
      }
    }
  }

  const ignoriert = shouldIgnore(loadGitignore(projectPath, project), relativePath);
  return {
    ignoriert,
    regel: ignoriert ? treffer?.regel ?? null : null,
    herkunft: ignoriert ? treffer?.herkunft ?? null : null,
  };
}
