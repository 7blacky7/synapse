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

/**
 * Regeln, die den Weg zwischen Dateisystem und Datenbank BLOCKIEREN duerfen.
 * Das ist die kleine, scharfe Menge — nicht zu verwechseln mit dem Ausblenden.
 *
 * Enthalten sind:
 *   1. DEFAULT_IGNORES aus dem Code (Paketordner, .git, Secrets). Fest
 *      einprogrammiert, weil sie unter keinen Umstaenden in die Datenbank
 *      duerfen.
 *   2. Die DB-Regeln mit modus='gesperrt'. Dafuer da, dass ein neues Framework
 *      mit einem noch unbekannten Ordner nicht erst einen Code-Release braucht.
 *
 * AUSDRUECKLICH NICHT ENTHALTEN ist .gitignore. Was dort steht, ist meist
 * Aufraeum-Kram (Build-Ausgaben, Logdateien) und kein Schutzbeduerfnis; und die
 * Datei selbst will man aendern koennen. Ihre Muster wirken weiterhin ueber
 * loadGitignore auf die SICHTBARKEIT — nur eben nicht mehr auf die Existenz.
 *
 * NICHT enthalten sind die ausgeblendeten Regeln. Eine ausgeblendete Datei
 * laeuft voellig normal zwischen Platte und Datenbank hin und her; sie ist nur
 * in der Suche unsichtbar.
 */
export function ladeSperrRegeln(_projectPath: string, project?: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);

  const gesperrt = gepufferteSperrRegeln(project);
  if (gesperrt?.length) ig.add(gesperrt);
  return ig;
}

/**
 * Zwischenspeicher fuer die Sperr-Instanz, gekoppelt an die Regelliste.
 *
 * WARUM ES DAS BRAUCHT: eine einmal gebaute Ignore-Instanz ist ein Schnappschuss.
 * Wer sie beim Prozessstart erzeugt und in einer Variablen haelt, bekommt von
 * einer spaeter angelegten Regel nichts mit — eine frisch gesetzte Sperre wirkte
 * dadurch erst nach einem Daemon-Neustart. Am 28.07.2026 im Test aufgefallen:
 * die Datei landete trotz Sperre in der Datenbank. Eine Sperre, die erst nach
 * einem Neustart greift, ist keine Sperre.
 *
 * Verglichen wird die zusammengefuegte Regelliste. Die kommt aus
 * gepufferteSperrRegeln und wird dort ohnehin alle 30 Sekunden im Hintergrund
 * erneuert; hier entsteht also kein zusaetzlicher Datenbank-Zugriff.
 */
const sperrInstanzen = new Map<string, { schluessel: string; ig: Ignore }>();

/**
 * Prueft, ob ein Pfad GESPERRT ist — also weder in die Datenbank hinein noch aus
 * ihr heraus auf die Platte darf. Nicht zu verwechseln mit dem Ausblenden, das
 * ausschliesslich die Sichtbarkeit betrifft.
 */
export function istGesperrt(relativePath: string, projectPath: string, project?: string): boolean {
  const regeln = gepufferteSperrRegeln(project) ?? [];
  const schluessel = regeln.join('\n');
  const merker = project ?? '';
  const stand = sperrInstanzen.get(merker);
  let ig: Ignore;
  if (stand && stand.schluessel === schluessel) {
    ig = stand.ig;
  } else {
    ig = ladeSperrRegeln(projectPath, project);
    sperrInstanzen.set(merker, { schluessel, ig });
  }
  return shouldIgnore(ig, relativePath);
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
  /** Alle aktiven Muster — fuer die Sichtbarkeit (Suche, Baum, Embeddings). */
  muster: string[];
  /**
   * Nur die Muster mit modus='gesperrt'. Diese und NUR diese duerfen den Weg
   * zwischen Dateisystem und Datenbank blockieren. Ausgeblendete Pfade laufen
   * normal durch — sie sind unsichtbar, nicht abwesend.
   */
  gesperrt: string[];
  geladenAm: number;
  /**
   * Zeitpunkt, ab dem neu geladen werden MUSS. Normalerweise geladenAm plus
   * REGEL_GUELTIGKEIT_MS, bei einer laufenden Einblendungsfrist aber deren Ende —
   * sonst bliebe eine Datei ueber das zugesagte Fristende hinaus sichtbar.
   */
  gueltigBis: number;
}

const regelSpeicher = new Map<string, RegelStand>();
const laufendeAbfragen = new Set<string>();

/**
 * Liefert die zwischengespeicherten Regeln eines Projekts, oder null wenn noch
 * nie welche geladen wurden. Stoesst bei abgelaufenem Stand ein Nachladen im
 * Hintergrund an, blockiert dabei aber nicht — der Aufrufer ist synchron.
 */
export function gepufferteIgnoreRegeln(project?: string): string[] | null {
  return gepufferterStand(project)?.muster ?? null;
}

/**
 * Liefert NUR die gesperrten Muster eines Projekts. Getrennt von den
 * ausgeblendeten, weil die beiden verschiedene Dinge tun:
 *
 *   gesperrt      darf den Weg zwischen Dateisystem und Datenbank blockieren
 *   ausgeblendet  darf das ausdruecklich NICHT — nur die Sichtbarkeit
 *
 * Bis zum 28.07.2026 galt beides als dasselbe. Eine Datei unter einer
 * Ausblend-Regel wurde in der Datenbank angelegt, kam aber nie auf die Platte;
 * der Daemon versuchte es nicht einmal. Wer das nicht wusste, bekam ein
 * erfolgreiches Ergebnis und eine Datei, die es nirgends gab.
 */
export function gepufferteSperrRegeln(project?: string): string[] | null {
  return gepufferterStand(project)?.gesperrt ?? null;
}

/** Gemeinsamer Zugriff samt Nachladen im Hintergrund. */
function gepufferterStand(project?: string): RegelStand | null {
  if (!project) return null;
  const stand = regelSpeicher.get(project);
  if (!stand) return null;
  if (Date.now() > stand.gueltigBis && !laufendeAbfragen.has(project)) {
    void aktualisiereIgnoreRegeln(project);
  }
  return stand;
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
    // eingeblendet_bis hebt eine Ausblend-Regel voruebergehend auf. Die Pruefung
    // laeuft ueber NOW() in der Datenbank, damit die Zeitrechnung an EINER Stelle
    // stattfindet und nicht von der Uhr des jeweiligen Prozesses abhaengt.
    const ergebnis = await getPool().query<{
      pattern: string;
      modus: string;
      befristet_offen: boolean;
      restsekunden: number | null;
    }>(
      `SELECT pattern,
              modus,
              (modus = 'ausgeblendet' AND eingeblendet_bis IS NOT NULL AND eingeblendet_bis > NOW()) AS befristet_offen,
              CASE WHEN eingeblendet_bis > NOW()
                   THEN EXTRACT(EPOCH FROM (eingeblendet_bis - NOW()))
              END AS restsekunden
         FROM project_ignore_rules
        WHERE project = $1 AND enabled
        ORDER BY sort_order, id`,
      [project],
    );
    // Eine Regel mit laufender Frist zaehlt nicht zur Sichtbarkeitsmenge — genau
    // das ist die Einblendung.
    const sichtbarkeit = ergebnis.rows.filter((zeile) => !zeile.befristet_offen);
    // Laeuft demnaechst eine Frist ab, muss der Zwischenspeicher SPAETESTENS dann
    // erneuert werden. Sonst bliebe die Datei ueber das Fristende hinaus sichtbar,
    // und eine Zusage "eine Stunde" waere in Wahrheit "eine Stunde plus was der
    // Puffer noch haelt".
    const naechsteFrist = ergebnis.rows
      .map((zeile) => (zeile.restsekunden === null ? null : Number(zeile.restsekunden)))
      .filter((sek): sek is number => sek !== null && sek > 0)
      .sort((a, b) => a - b)[0];
    regelSpeicher.set(project, {
      muster: sichtbarkeit.map((zeile) => zeile.pattern),
      gesperrt: ergebnis.rows.filter((zeile) => zeile.modus === 'gesperrt').map((zeile) => zeile.pattern),
      geladenAm: Date.now(),
      gueltigBis:
        naechsteFrist !== undefined
          ? Date.now() + Math.min(naechsteFrist * 1000, REGEL_GUELTIGKEIT_MS)
          : Date.now() + REGEL_GUELTIGKEIT_MS,
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
