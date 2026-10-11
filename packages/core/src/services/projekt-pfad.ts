/**
 * MODUL: Projekt-Pfade (P15-T36, 11.10.2026)
 * ZWECK: EINE Normalisierung und Pruefung fuer alle Pfade, die von Clients hereinkommen:
 *        files/files_batch ueber MCP-REST (rest-api routes/mcp.ts) und MCP-stdio (mcp-server files.ts),
 *        REST /api/projects/:name/files (routes/files.ts), Plaene (planBatch), Co-Edit-Beitraege
 *        (addCoeditContribution), plan_update im selben Plan und Reservierungen.
 *
 * REGELN (Konzept 36b53139, User-Entscheidung dc7dcfb8):
 *   - '..' zaehlt NUR als ganzes Segment. 'a..b.ts', '...', '..a', '[...all]' sind normale Namen.
 *   - '..' innerhalb des Projekts wird aufgeloest ('x/../y' -> 'y'), '.' und leere Segmente entfallen.
 *   - Backslash ist Trenner (wie bei Reservierungen und shouldIgnore schon vorher).
 *   - Gross-/Kleinschreibung und Unicode bleiben byte-gleich (kein NFC/NFD), kein trim.
 *   - ABGELEHNT wird nur: Ausbruch ueber den Projekt-Root, absoluter Pfad (STRENG, auch wenn er unter
 *     dem Projekt-Root liegt - es wird nichts umgerechnet), Steuerzeichen U+0000-U+001F/U+007F, leer.
 *   - F3: Schreibziele auf GESPERRTEN Pfaden (DEFAULT_IGNORES + Projektregeln modus 'gesperrt', siehe
 *     watcher/ignore.ts ladeSperrRegeln) werden abgelehnt. Solche Pfade gehen weder in die Datenbank noch
 *     auf die Platte; vorher entstand eine Zeile in code_files, die der Daemon nie schrieb. Loeschen, die
 *     Quelle von move/copy und alles Lesende bleiben erlaubt. Ausgeblendete Regeln sperren NICHT.
 *
 * BESTAND: Gegen alle 97.822 code_files-Pfade (Live, 11.10.2026) trocken geprueft: 0 Abweichungen,
 * idempotent. Bestehende Zeilen werden nie migriert.
 */

import * as path from 'path';
import {
  aktualisiereIgnoreRegeln,
  erklaereSperre,
  gepufferteSperrRegeln,
} from '../watcher/ignore.js';

export type PfadFehlerGrund = 'ausbruch' | 'absolut' | 'steuerzeichen' | 'leer';

/**
 * Antwortform fuer Tool-Aufrufe (success:false, nichts geschrieben). Type-Alias statt Interface, damit sie
 * an Record<string, unknown> zuweisbar ist (Tool-Handler-Signaturen).
 */
export type PfadFehlerAntwort = {
  success: false;
  error: 'pfad_ungueltig' | 'pfad_gesperrt';
  message: string;
  grund?: PfadFehlerGrund;
  eingabe?: string;
  pfad?: string;
  regel?: string | null;
  herkunft?: 'standard' | 'datenbank' | null;
};

export class PfadUngueltig extends Error {
  readonly code = 'pfad_ungueltig' as const;
  constructor(readonly grund: PfadFehlerGrund, readonly eingabe: string, message: string) {
    super(message);
    this.name = 'PfadUngueltig';
  }
  antwort(): PfadFehlerAntwort {
    return { success: false, error: this.code, grund: this.grund, eingabe: this.eingabe, message: this.message };
  }
}

export class PfadGesperrt extends Error {
  readonly code = 'pfad_gesperrt' as const;
  constructor(
    readonly pfad: string,
    readonly regel: string | null,
    readonly herkunft: 'standard' | 'datenbank' | null,
    message: string,
  ) {
    super(message);
    this.name = 'PfadGesperrt';
  }
  antwort(): PfadFehlerAntwort {
    return { success: false, error: this.code, pfad: this.pfad, regel: this.regel, herkunft: this.herkunft, message: this.message };
  }
}

// eslint-disable-next-line no-control-regex
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;

/**
 * Normalisiert einen projekt-relativen Pfad. Rein (ohne Dateisystem/DB), synchron, idempotent.
 * Wirft PfadUngueltig mit grund ausbruch | absolut | steuerzeichen | leer.
 */
export function normalisiereProjektPfad(roh: string): { pfad: string; geaendert: boolean } {
  if (typeof roh !== 'string' || roh.length === 0) {
    throw new PfadUngueltig('leer', typeof roh === 'string' ? roh : String(roh ?? ''), 'file_path ist leer.');
  }
  const steuer = STEUERZEICHEN.exec(roh);
  if (steuer) {
    const codepoint = 'U+' + steuer[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new PfadUngueltig(
      'steuerzeichen',
      roh,
      `Pfad ${JSON.stringify(roh)} enthaelt das Steuerzeichen ${codepoint} an Position ${steuer.index} - meist ein Kopierfehler (Zeilenumbruch/Tab im Pfad). Abgelehnt, nichts geschrieben.`,
    );
  }
  const p = roh.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(p)) {
    throw new PfadUngueltig(
      'absolut',
      roh,
      `Pfad "${roh}" ist absolut. Pfade sind projekt-relativ, z. B. "src/a.ts" - absolute Pfade werden auch dann nicht umgerechnet, wenn sie unter dem Projekt-Root liegen. Abgelehnt, nichts geschrieben.`,
    );
  }
  const teile: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (teile.length === 0) {
        throw new PfadUngueltig(
          'ausbruch',
          roh,
          `Pfad "${roh}" verlaesst das Projekt: ".." fuehrt ueber den Projekt-Root hinaus. Pfade sind projekt-relativ, z. B. "src/a.ts". Abgelehnt, nichts geschrieben.`,
        );
      }
      teile.pop();
      continue;
    }
    teile.push(segment);
  }
  if (teile.length === 0) {
    throw new PfadUngueltig('leer', roh, `file_path ist leer (nach Normalisierung von "${roh}" bleibt kein Pfad uebrig).`);
  }
  const pfad = teile.join('/');
  return { pfad, geaendert: pfad !== roh };
}

/**
 * Daemon-Schutz (PG -> Platte): liegt ein gespeicherter Pfad sicher innerhalb der Projektwurzel?
 * Absolute Pfade, leere Pfade und Null-Bytes gelten als ausserhalb.
 */
export function liegtImProjekt(projektWurzel: string, relativ: string): boolean {
  if (typeof relativ !== 'string' || relativ === '' || relativ.includes('\0') || path.isAbsolute(relativ)) return false;
  const wurzel = path.resolve(projektWurzel);
  const ziel = path.resolve(wurzel, relativ);
  return ziel.startsWith(wurzel + path.sep);
}

/** Aktionen, deren file_path ein Schreibziel ist. */
const INHALT_AKTIONEN = new Set([
  'create', 'update', 'search_replace', 'search_replace_batch', 'replace_lines', 'insert_after', 'delete_lines',
]);
/** Aktionen, deren new_path ein Schreibziel ist (die Quelle file_path bleibt frei). */
const ZIEL_AKTIONEN = new Set(['move', 'copy']);

function schreibZiel(action: string, filePath: unknown, newPath: unknown): string | undefined {
  const ziel = INHALT_AKTIONEN.has(action) ? filePath : ZIEL_AKTIONEN.has(action) ? newPath : undefined;
  return typeof ziel === 'string' && ziel !== '' ? ziel : undefined;
}

/** Laedt die Sperr-Regeln des Projekts, falls dieser Prozess sie noch nie geladen hat (sonst Cache, 30 s). */
async function sperrRegelnBereit(project: string): Promise<void> {
  if (gepufferteSperrRegeln(project) === null) await aktualisiereIgnoreRegeln(project);
}

function pruefeSchreibZielGeladen(project: string, pfad: string): void {
  const sperre = erklaereSperre(pfad, project);
  if (!sperre.gesperrt) return;
  const quelle = sperre.herkunft === 'datenbank' ? 'Projektregel modus gesperrt' : 'Standard-Sperre im Code';
  const weg = sperre.herkunft === 'datenbank'
    ? ' Aufheben nur ueber die Regel selbst (ignore action:"list" zeigt sie).'
    : ' Standard-Sperren stehen fest im Code (watcher/ignore.ts DEFAULT_IGNORES).';
  throw new PfadGesperrt(
    pfad,
    sperre.regel,
    sperre.herkunft,
    `Pfad "${pfad}" ist gesperrt (Regel "${sperre.regel ?? '?'}", ${quelle}). Gesperrte Pfade gehen weder in die Datenbank noch auf die Platte - ein Schreiben ueber files ergaebe eine Datei, die es nirgends gibt. Nichts geschrieben. Lesen und Loeschen bleiben moeglich.${weg}`,
  );
}

/** F3: wirft PfadGesperrt, wenn pfad (bereits normalisiert) ein gesperrtes Schreibziel ist. */
export async function pruefeSchreibZiel(project: string, pfad: string): Promise<void> {
  await sperrRegelnBereit(project);
  pruefeSchreibZielGeladen(project, pfad);
}

/**
 * Tool-Eingang (files/files_batch, routes/files.ts): normalisiert args.file_path und args.new_path (nur
 * Strings, Arrays wie bei Reservierungen bleiben unberuehrt) und schreibt sie ZURUECK in args, damit
 * alle nachfolgenden Schritte denselben Pfad sehen. Prueft danach F3 fuer das Schreibziel der Action.
 * Liefert null (ok) oder die fertige Fehlerantwort.
 */
export async function pruefeFilesPfadArgs(project: string, args: Record<string, unknown>): Promise<PfadFehlerAntwort | null> {
  const action = typeof args.action === 'string' ? args.action : '';
  try {
    for (const key of ['file_path', 'new_path'] as const) {
      const wert = args[key];
      if (typeof wert !== 'string' || wert === '') continue;
      args[key] = normalisiereProjektPfad(wert).pfad;
    }
    const ziel = schreibZiel(action, args.file_path, args.new_path);
    if (ziel) await pruefeSchreibZiel(project, ziel);
    return null;
  } catch (fehler) {
    if (fehler instanceof PfadUngueltig || fehler instanceof PfadGesperrt) return fehler.antwort();
    throw fehler;
  }
}

/**
 * Plan-/Co-Edit-Eingang: normalisiert file_path und new_path jeder Op (Kopie, keine Mutation) und prueft
 * F3 fuer das Schreibziel. Fehler tragen "Op <i>: " wie die bisherige Pflichtpruefung ("Op i: file_path fehlt").
 */
export async function normalisiereOps<T extends { file_path: string; action: string; new_path?: string }>(
  project: string,
  ops: readonly T[],
): Promise<T[]> {
  let sperreGeladen = false;
  const ergebnis: T[] = new Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || !op.file_path) throw new Error(`Op ${i}: file_path fehlt`);
    try {
      const filePath = normalisiereProjektPfad(op.file_path).pfad;
      const newPath = typeof op.new_path === 'string' && op.new_path !== ''
        ? normalisiereProjektPfad(op.new_path).pfad
        : op.new_path;
      const ziel = schreibZiel(op.action, filePath, newPath);
      if (ziel) {
        if (!sperreGeladen) {
          await sperrRegelnBereit(project);
          sperreGeladen = true;
        }
        pruefeSchreibZielGeladen(project, ziel);
      }
      ergebnis[i] = filePath === op.file_path && newPath === op.new_path
        ? op
        : { ...op, file_path: filePath, ...(newPath !== undefined ? { new_path: newPath } : {}) };
    } catch (fehler) {
      if (fehler instanceof PfadUngueltig || fehler instanceof PfadGesperrt) {
        const meldung = new Error(`Op ${i}: ${fehler.message}`) as Error & { code?: string };
        meldung.code = fehler.code;
        throw meldung;
      }
      throw fehler;
    }
  }
  return ergebnis;
}
