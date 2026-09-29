/**
 * MODUL: Code-Intelligence Service
 * ZWECK: Strukturierte Code-Abfragen via PostgreSQL — kein Qdrant
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - filePath: string - Optionaler Datei-Pfad-Filter
 *   - name: string - Optionaler Symbol-Name-Filter
 *   - query: string - Suchbegriff fuer Volltext-Suche
 *
 * OUTPUT:
 *   - string: Formatierter Projekt-Baum (getProjectTree)
 *   - Array<object>: Symbol-Listen (getFunctions, getVariables, getSymbols)
 *   - object: Referenz-Info (getReferences)
 *   - Array<object>: Volltext-Suchergebnisse (fullTextSearchCode)
 *   - object | null: Dateiinhalt (getFileContent)
 *
 * ABHÄNGIGKEITEN:
 *   - ../db/client.js (intern) - PostgreSQL-Verbindung
 *
 * HINWEISE:
 *   - Alle Abfragen sind PG-only (kein Qdrant)
 *   - Projekt-Isolation: Alle Queries filtern nach project
 *   - fullTextSearchCode ist bewusst abweichend benannt von searchCode (code.ts)
 */

import { getPool } from '../db/client.js';

// ─── getProjectTree ───────────────────────────────────────────────────────────

/**
 * Tree-Optionen — jeder Aspekt einzeln steuerbar.
 * KI entscheidet selbst welche Details sie braucht.
 */
export interface TreeOptions {
  /** Verzeichnis-Filter (zeigt nur Dateien unter diesem Pfad) */
  path?: string;
  /** false = nur Dateien direkt im Verzeichnis, true = auch Unterverzeichnisse (Standard: true) */
  recursive?: boolean;
  /** Max. Verzeichnis-Tiefe relativ zum path (0 = nur das Verzeichnis selbst) */
  depth?: number;
  /** Zeilenzahl pro Datei anzeigen (Standard: true) */
  show_lines?: boolean;
  /** Funktions-/Variablen-Counts anzeigen (Standard: true) */
  show_counts?: boolean;
  /**
   * Kommentare unter Dateien anzeigen (Standard: false).
   * false/weg = keine, true = einer je Datei, Zahl N = bis zu N,
   * '*' oder 'all' = alle bis KOMMENTAR_OBERGRENZE.
   * Wird gekappt, steht das ausdruecklich in der Ausgabe.
   */
  show_comments?: boolean | number | string;
  /**
   * Nur Kommentare zeigen, die diesen Text enthalten (Gross-/Kleinschreibung egal).
   * Wirkt nur zusammen mit show_comments. Damit wird der Baum zur Suche:
   * show_comments:'*' + comment_contains:'@SYN-' listet alle Navigationsmarken
   * eines Projekts mit Datei und Zeilennummer.
   */
  comment_contains?: string;
  /** Anzeigelaenge je Kommentarzeile in Zeichen (Standard 100). */
  comment_chars?: number;
  /**
   * Startpunkt im Kommentartext (Standard 0). Zusammen mit comment_chars ein
   * Fenster: comment_from:5 + comment_chars:20 zeigt die Zeichen 5 bis 24.
   * Ein Ausschnitt, der nicht am Anfang beginnt, wird mit einer Ellipse markiert.
   */
  comment_from?: number;
  /**
   * Die ersten N Kommentare je Datei ueberspringen (Standard 0). Damit wird die
   * Anzeige zur Blaetterfunktion: comment_skip:9 + show_comments:6 liefert die
   * Kommentare 10 bis 15. Bewusst KEINE Auswahl ueber Indexlisten — ein Index
   * verschiebt sich, sobald jemand oben in der Datei einen Kommentar einfuegt,
   * eine notierte Auswahl zeigt beim naechsten Mal etwas anderes. Wer stabile
   * Adressen braucht, nimmt die Zeilennummer und code_intel(action:'file').
   */
  comment_skip?: number;
  /** Funktionsnamen auflisten (Standard: false) */
  show_functions?: boolean;
  /** Import-Statements auflisten (Standard: false) */
  show_imports?: boolean;
  /** Nur Dateien mit bestimmtem Typ (z.B. 'typescript', 'sql') */
  file_type?: string;
}

/**
 * Obergrenze fuer angezeigte Kommentare JE DATEI. Schuetzt den Baum vor Dateien
 * wie der 100k-Zeilen-Benchmarkdatei, die allein 11668 Kommentare traegt.
 * Wird sie erreicht, sagt die Ausgabe das — eine stille Kappung liest sich wie
 * Vollstaendigkeit und ist damit schlimmer als gar keine Anzeige.
 */
const KOMMENTAR_OBERGRENZE = 50;

/** Loest show_comments in eine Anzahl auf. Unbekannte Werte gelten als 'aus'. */
function loeseKommentarAnzahl(wert: boolean | number | string | undefined): number {
  if (wert === undefined || wert === null || wert === false) return 0;
  if (wert === true) return 1;
  if (typeof wert === 'number') {
    return Number.isFinite(wert) && wert > 0 ? Math.min(Math.floor(wert), KOMMENTAR_OBERGRENZE) : 0;
  }
  const s = String(wert).trim().toLowerCase();
  if (s === '' || s === 'false' || s === '0' || s === 'nein') return 0;
  if (s === 'true' || s === 'ja') return 1;
  if (s === '*' || s === 'all' || s === 'alle') return KOMMENTAR_OBERGRENZE;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, KOMMENTAR_OBERGRENZE) : 0;
}

/**
 * Erste Zeile MIT Inhalt eines Kommentarwerts, ohne fuehrende JSDoc-Sternchen.
 * Ein Blockkommentar beginnt mit einer leeren Sternchenzeile — wer schlicht die
 * erste Zeile nimmt, bekommt fuer jede Datei denselben nichtssagenden Rest.
 */
function ersteZeileMitInhalt(wert: string | null | undefined, treffer?: string): string {
  const zeilen = (wert ?? '')
    .split('\n')
    .map((zeile: string) => zeile.replace(/^\s*\*+\s?/, '').trim().replace(/\s+/g, ' '))
    .filter((zeile: string) => zeile.length > 0);
  // Ab der interessanten Zeile wird der REST des Kommentars angehaengt, zu einer
  // Zeile verbunden. Sonst koennte comment_chars nie ueber die erste Zeile hinaus
  // reichen — und ein grosser Wert waere wirkungslos, statt mehr zu zeigen.
  const abIndex = (start: number) => zeilen.slice(start).join(' ');
  // Wurde gefiltert, ist die TREFFENDE Zeile die interessante — nicht die erste.
  // Ein Blockkommentar kann 500 Zeichen lang sein; wer nach 'GET' sucht und die
  // Kopfzeile zu sehen bekommt, erkennt nicht, warum der Treffer zustande kam.
  if (treffer) {
    const gesucht = treffer.toLowerCase();
    const pos = zeilen.findIndex((zeile: string) => zeile.toLowerCase().includes(gesucht));
    if (pos >= 0) return abIndex(pos);
  }
  return abIndex(0);
}

/** Maskiert %, _ und Backslash fuer ein LIKE/ILIKE mit ESCAPE '\'. */
function alsLikeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (zeichen) => '\\' + zeichen);
}

/** Eine Trefferzeile innerhalb eines (evtl. mehrzeiligen) Symbolwerts. */
export interface TrefferZeile {
  /** Echte Zeilennummer in der Datei. */
  line: number;
  /** Inhalt DIESER Zeile, ohne fuehrende Kommentar-Sternchen, Leerraum verdichtet. */
  text: string;
}

/**
 * Findet die Zeilen eines Symbolwerts, die den Suchtext enthalten (Gross-/
 * Kleinschreibung egal), und rechnet ihre ECHTE Zeilennummer aus.
 *
 * WARUM: Parser verschmelzen benachbarte //-Zeilen zu EINEM comment-Symbol,
 * Text mit \n getrennt, line_start = erste Zeile. Wer line_start meldet, zeigt
 * auf den Blockkopf statt auf den Treffer (Befund 28.09.2026, softcleanToeva:
 * seed.mjs meldete Z38 statt Z39, seed.ts Z1 statt Z10). Die i-te Zeile des
 * Werts steht an line_start + i — nachgemessen an allen 7 Faellen dort.
 * Schreibt ein Parser ein Symbol pro Zeile, ist i schlicht 0: dieselbe
 * Rechnung stimmt dann weiter.
 *
 * dateiZeilen (optional) ist der Dateiinhalt zur GEGENPROBE: steht der Treffer
 * nicht in der errechneten Zeile (etwa weil ein Parser Leerzeilen weglaesst),
 * wird im Bereich line_start..line_end die naechste passende Zeile genommen.
 */
export function findeTrefferZeilen(
  wert: string | null | undefined,
  lineStart: number,
  lineEnd: number | null | undefined,
  gesucht: string,
  dateiZeilen?: string[]
): TrefferZeile[] {
  const nadel = gesucht.toLowerCase();
  if (!wert || !nadel) return [];
  const teile = wert.split('\n');
  const obergrenze = lineEnd && lineEnd >= lineStart ? lineEnd : lineStart + teile.length - 1;
  const enthaelt = (zeile: string | undefined) => (zeile ?? '').toLowerCase().includes(nadel);
  const ergebnis: TrefferZeile[] = [];
  const vergeben = new Set<number>();
  for (let i = 0; i < teile.length; i++) {
    if (!enthaelt(teile[i])) continue;
    let zeile = Math.min(lineStart + i, obergrenze);
    if (dateiZeilen && (vergeben.has(zeile) || !enthaelt(dateiZeilen[zeile - 1]))) {
      for (let z = lineStart; z <= obergrenze; z++) {
        if (!vergeben.has(z) && enthaelt(dateiZeilen[z - 1])) { zeile = z; break; }
      }
    }
    vergeben.add(zeile);
    ergebnis.push({
      line: zeile,
      text: teile[i].replace(/^\s*\*+\s?/, '').trim().replace(/\s+/g, ' '),
    });
  }
  return ergebnis;
}

/** Trefferfelder fuer symbols(value_contains): erste Trefferzeile plus alle. */
function trefferFelder(
  wert: string | null | undefined,
  lineStart: number,
  lineEnd: number | null | undefined,
  gesucht: string
): { match_line: number; match_lines: TrefferZeile[] } {
  const zeilen = findeTrefferZeilen(wert, lineStart, lineEnd, gesucht);
  // Kein zeilenweiser Treffer (Suchtext ueber einen Umbruch hinweg): dann ist
  // der Block selbst die Fundstelle.
  return { match_line: zeilen[0]?.line ?? lineStart, match_lines: zeilen };
}

/**
 * Gibt einen formatierten Projekt-Baum zurueck.
 * Dateien werden nach Verzeichnis gruppiert, Pfade relativ zum Projekt-Root.
 * Jeder Aspekt ist einzeln steuerbar ueber TreeOptions.
 */
export async function getProjectTree(
  project: string,
  options: TreeOptions = {}
): Promise<string> {
  const pool = getPool();
  const {
    path: dirPath,
    recursive = true,
    depth,
    show_lines = true,
    show_counts = true,
    show_comments = false,
    comment_contains,
    comment_chars,
    comment_from,
    comment_skip,
    show_functions = false,
    show_imports = false,
    file_type,
  } = options;

  // Projekt-Root-Pfad aus projects-Tabelle holen
  let projectRoot = '';
  try {
    const rootResult = await pool.query<{ path: string }>(
      `SELECT path FROM projects WHERE name = $1 ORDER BY last_access DESC LIMIT 1`,
      [project]
    );
    if (rootResult.rows.length > 0) {
      projectRoot = rootResult.rows[0].path;
      if (!projectRoot.endsWith('/')) projectRoot += '/';
    }
  } catch {
    // Tabelle existiert noch nicht — Fallback: leerer Root (relative Pfade direkt)
  }

  // Basis-Query
  const params: unknown[] = [project];
  let where = 'WHERE cf.project = $1';
  if (dirPath) {
    if (recursive) {
      // Rekursiv: alle Dateien die den Pfad enthalten
      params.push(`%${dirPath}%`);
      where += ` AND cf.file_path LIKE $${params.length}`;
    } else {
      // Nicht-rekursiv: nur Dateien direkt in diesem Verzeichnis
      // Pfad muss den dir enthalten, aber danach darf kein weiterer / kommen (ausser am Ende des file_path)
      params.push(`%${dirPath}%`);
      where += ` AND cf.file_path LIKE $${params.length}`;
      // Nachfilterung in JS (PG LIKE kann nicht "kein / nach dem Match" pruefen)
    }
  }
  if (file_type) {
    params.push(file_type);
    where += ` AND cf.file_type = $${params.length}`;
  }

  // Counts nur laden wenn gewuenscht (spart Subqueries)
  const countCols = show_counts
    ? `, (SELECT COUNT(*) FROM code_symbols cs WHERE cs.project = cf.project AND cs.file_path = cf.file_path AND cs.symbol_type = 'function') AS fn_count,
         (SELECT COUNT(*) FROM code_symbols cs WHERE cs.project = cf.project AND cs.file_path = cf.file_path AND cs.symbol_type = 'variable') AS var_count`
    : '';
  const lineCols = show_lines
    ? `, (length(cf.content) - length(replace(cf.content, E'\\n', '')) + 1) AS line_count`
    : '';

  const filesResult = await pool.query(
    // IGN-4: ausgeblendete Dateien (code_files.ignored) gehoeren nicht in den
    // Baum. Der Filter sitzt in der Unterabfrage, damit die dynamisch gebaute
    // WHERE-Klausel unveraendert bleibt.
    `SELECT cf.file_path, cf.file_name, cf.file_type ${lineCols} ${countCols}
     FROM (SELECT * FROM code_files WHERE NOT ignored) cf ${where} ORDER BY cf.file_path`,
    params
  );

  if (filesResult.rows.length === 0) {
    return `Kein Code indexiert fuer Projekt "${project}"${dirPath ? ` unter ${dirPath}` : ''}.`;
  }

  // Dateien nach Verzeichnis gruppieren
  // Bei dirPath: Basis-Tiefe berechnen fuer relative depth-Filterung
  const dirMap = new Map<string, Array<typeof filesResult.rows[0]>>();
  let baseDirDepth = 0;
  if (dirPath) {
    baseDirDepth = dirPath.split('/').filter(Boolean).length;
  }

  // ⚠️ comment_contains FILTERT DIE DATEIEN, nicht nur die Kommentarzeilen.
  // Gemessen 28.09.2026 (softcleanToeva): tree(path:"apps/backend",
  // show_comments:50, comment_contains:"VOR AUSLIEFERUNG") listete alle 147
  // Dateien, obwohl nur 2 einen Treffer trugen — die Suche ging im Baum unter.
  // Zweiter Befund desselben Tages: angezeigt wurde line_start des Symbols und
  // dessen Anfang. Benachbarte //-Zeilen stehen aber als EIN Symbol in der DB
  // (Text mit \n getrennt, line_start = erste Zeile) — die gesuchte Zeile liegt
  // oft weiter unten. Deshalb wird hier je Treffer die ECHTE Zeile bestimmt.
  // Das funktioniert unveraendert, wenn ein Parser ein Symbol pro Zeile schreibt.
  const filterText = comment_contains?.trim() ? comment_contains.trim() : undefined;
  // comment_contains allein ist eine Suche. Ohne show_comments zeigte sie
  // frueher schlicht nichts an; jetzt gilt dann die Obergrenze je Datei.
  const kommentarAnzahl = loeseKommentarAnzahl(show_comments)
    || (filterText ? KOMMENTAR_OBERGRENZE : 0);
  const trefferJeDatei = new Map<string, TrefferZeile[]>();
  if (filterText && kommentarAnzahl > 0) {
    const pfade = filesResult.rows.map((r) => r.file_path as string);
    const trefferRows = await pool.query<{
      file_path: string; value: string | null; line_start: number; line_end: number | null;
    }>(
      `SELECT file_path, value, line_start, line_end FROM code_symbols
       WHERE project = $1 AND symbol_type = 'comment' AND file_path = ANY($2::text[])
         AND value ILIKE $3 ESCAPE '\\'
       ORDER BY file_path, line_start`,
      [project, pfade, `%${alsLikeLiteral(filterText)}%`]
    );
    // Dateiinhalt nur fuer die Trefferdateien — zur Gegenprobe der Zeilennummer.
    const trefferPfade = [...new Set(trefferRows.rows.map((r) => r.file_path))];
    const inhalte = new Map<string, string[]>();
    if (trefferPfade.length > 0) {
      const inhaltRows = await pool.query<{ file_path: string; content: string | null }>(
        `SELECT file_path, content FROM code_files WHERE project = $1 AND file_path = ANY($2::text[])`,
        [project, trefferPfade]
      );
      for (const r of inhaltRows.rows) {
        if (r.content != null) inhalte.set(r.file_path, r.content.split('\n'));
      }
    }
    for (const r of trefferRows.rows) {
      let zeilen = findeTrefferZeilen(r.value, r.line_start, r.line_end, filterText, inhalte.get(r.file_path));
      // Treffer ueber einen Zeilenumbruch hinweg: dann gibt es keine einzelne
      // Trefferzeile — der Block selbst ist die Fundstelle.
      if (zeilen.length === 0) {
        zeilen = [{ line: r.line_start, text: ersteZeileMitInhalt(r.value, filterText) }];
      }
      const liste = trefferJeDatei.get(r.file_path) ?? [];
      for (const z of zeilen) if (!liste.some((v) => v.line === z.line)) liste.push(z);
      trefferJeDatei.set(r.file_path, liste);
    }
    for (const liste of trefferJeDatei.values()) liste.sort((a, b) => a.line - b.line);
  }

  for (const row of filesResult.rows) {
    // comment_contains: Dateien ohne Treffer gehoeren nicht in das Suchergebnis.
    if (filterText && !trefferJeDatei.has(row.file_path)) continue;
    const relPath = row.file_path;  // bereits relativ
    row._relPath = relPath;
    const dir = relPath.substring(0, relPath.lastIndexOf('/') + 1) || '/';
    const dirDepth = dir.split('/').filter(Boolean).length;

    // Nicht-rekursiv: nur Dateien deren Verzeichnis-Tiefe == baseDirDepth
    if (!recursive && dirPath && dirDepth > baseDirDepth) continue;

    // Depth-Filter: relativ zum Basis-Verzeichnis
    if (depth !== undefined) {
      const relativeDepth = dirDepth - baseDirDepth;
      if (relativeDepth > depth) continue;
    }

    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(row);
  }

  const lines: string[] = [];

  for (const [dir, files] of dirMap) {
    // Verzeichnis-Header
    const dirMeta: string[] = [`${files.length} Dateien`];
    if (show_counts) {
      const fnTotal = files.reduce((s, f) => s + parseInt(f.fn_count ?? '0', 10), 0);
      const varTotal = files.reduce((s, f) => s + parseInt(f.var_count ?? '0', 10), 0);
      if (fnTotal > 0) dirMeta.push(`${fnTotal}fn`);
      if (varTotal > 0) dirMeta.push(`${varTotal}var`);
    }
    lines.push(`${dir} (${dirMeta.join(', ')})`);

    // Dateien
    for (const f of files) {
      const fileMeta: string[] = [];
      if (show_lines && f.line_count) fileMeta.push(`${f.line_count}Z`);
      if (show_counts) {
        const fn = parseInt(f.fn_count ?? '0', 10);
        const v = parseInt(f.var_count ?? '0', 10);
        if (fn > 0) fileMeta.push(`${fn}fn`);
        if (v > 0) fileMeta.push(`${v}var`);
      }
      const metaStr = fileMeta.length > 0 ? ` (${fileMeta.join(', ')})` : '';
      lines.push(`  ${f.file_name}${metaStr}`);

      // Kommentare
      if (kommentarAnzahl > 0 && filterText) {
        // Gefiltert: die vorab gesammelten TREFFERZEILEN dieser Datei, jede mit
        // ihrer echten Zeilennummer und dem Inhalt genau dieser Zeile.
        const alle = trefferJeDatei.get(f.file_path) ?? [];
        const uebersprungen = Math.min(Math.max(0, Math.floor(comment_skip ?? 0)), alle.length);
        const gezeigt = alle.slice(uebersprungen, uebersprungen + kommentarAnzahl);
        const ab = Math.max(0, Math.floor(comment_from ?? 0));
        const laenge = Math.max(1, Math.floor(comment_chars ?? 100));
        for (const treffer of gezeigt) {
          const rest = treffer.text.slice(ab);
          const fenster = rest.slice(0, laenge);
          if (!fenster) continue;
          const comment = (ab > 0 ? '…' : '') + fenster + (rest.length > laenge ? '…' : '');
          lines.push(`    /** Z${treffer.line}: ${comment} */`);
        }
        const nichtGezeigt = alle.length - gezeigt.length - uebersprungen;
        if (alle.length > 0 && (uebersprungen > 0 || nichtGezeigt > 0)) {
          const teile: string[] = [];
          if (uebersprungen > 0) teile.push(`${uebersprungen} uebersprungen`);
          if (nichtGezeigt > 0) teile.push(`${nichtGezeigt} weitere nicht gezeigt`);
          lines.push(`    /** ... ${teile.join(', ')} (von ${alle.length} Treffern) */`);
        }
      } else if (kommentarAnzahl > 0) {
        // COUNT(*) OVER() zaehlt VOR dem LIMIT und liefert damit die echte Gesamtzahl
        // in derselben Abfrage — ohne zweiten Roundtrip je Datei.
        const kommentarParams: unknown[] = [
          project,
          f.file_path,
          kommentarAnzahl,
          Math.max(0, Math.floor(comment_skip ?? 0)),
        ];
        const commentResult = await pool.query(
          `SELECT value, line_start, COUNT(*) OVER() AS gesamt FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'comment'
           ORDER BY line_start LIMIT $3 OFFSET $4`,
          kommentarParams
        );
        const ab = Math.max(0, Math.floor(comment_from ?? 0));
        const laenge = Math.max(1, Math.floor(comment_chars ?? 100));
        for (const zeileDb of commentResult.rows) {
          const voll = ersteZeileMitInhalt(zeileDb.value);
          // Fenster ueber den Text. Ein Ausschnitt, der nicht am Anfang beginnt oder
          // vor dem Ende aufhoert, bekommt eine Ellipse — sonst sieht ein Schnitt aus
          // wie der echte Text, und genau das ist der Fehler, den wir hier bekaempfen.
          const rest = voll.slice(ab);
          const fenster = rest.slice(0, laenge);
          if (!fenster) continue;
          const comment = (ab > 0 ? '…' : '') + fenster + (rest.length > laenge ? '…' : '');
          lines.push(`    /** Z${zeileDb.line_start}: ${comment} */`);
        }
        const gesamt = commentResult.rows.length > 0 ? parseInt(commentResult.rows[0].gesamt, 10) : 0;
        const uebersprungen = Math.max(0, Math.floor(comment_skip ?? 0));
        const nichtGezeigt = gesamt - commentResult.rows.length - uebersprungen;
        // Nur melden, wenn es ueberhaupt Kommentare gibt: "9 uebersprungen (von 0)"
        // waere eine Meldung ueber nichts.
        if (gesamt > 0 && (uebersprungen > 0 || nichtGezeigt > 0)) {
          // Ausdruecklich ausweisen: eine stille Kappung liest sich wie Vollstaendigkeit.
          const teile: string[] = [];
          if (uebersprungen > 0) teile.push(`${uebersprungen} uebersprungen`);
          if (nichtGezeigt > 0) teile.push(`${nichtGezeigt} weitere nicht gezeigt`);
          lines.push(`    /** ... ${teile.join(', ')} (von ${gesamt}) */`);
        }
      }

      // Funktionen
      if (show_functions) {
        const funcsResult = await pool.query(
          `SELECT name, is_exported FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'function'
           ORDER BY line_start`,
          [project, f.file_path]
        );
        if (funcsResult.rows.length > 0) {
          const names = funcsResult.rows
            .map((fn: { name: string; is_exported: boolean }) => (fn.is_exported ? `+${fn.name}` : fn.name))
            .join(', ');
          lines.push(`    fn: ${names}`);
        }
      }

      // Imports
      if (show_imports) {
        const importsResult = await pool.query(
          `SELECT name, value FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'import'
           ORDER BY line_start`,
          [project, f.file_path]
        );
        if (importsResult.rows.length > 0) {
          for (const imp of importsResult.rows) {
            lines.push(`    from "${imp.value}": ${imp.name}`);
          }
        }
      }
    }
  }

  lines.push(`---`);
  if (filterText) {
    // Die Trefferzahl gehoert in die Fusszeile: sie ist die Antwort auf die Suche,
    // die Dateizahl des Verzeichnisses dagegen nur der Suchraum.
    const gezeigteDateien = [...dirMap.values()].flat();
    const trefferGesamt = gezeigteDateien.reduce(
      (summe, datei) => summe + (trefferJeDatei.get(datei.file_path)?.length ?? 0), 0);
    lines.push(
      `${gezeigteDateien.length} Dateien mit Treffer (von ${filesResult.rows.length} durchsucht) | `
      + `${trefferGesamt} Trefferzeilen fuer "${filterText}" | Projekt: ${project}`
    );
  } else {
    lines.push(`${filesResult.rows.length} Dateien | Projekt: ${project}`);
  }

  return lines.join('\n');
}

// ─── getFunctions ─────────────────────────────────────────────────────────────

export interface FunctionInfo {
  id: string;
  file_path: string;
  name: string;
  line_start: number;
  line_end: number | null;
  params: string | null;
  return_type: string | null;
  is_exported: boolean;
  parent_name: string | null;
  usage_count: number;
}

/**
 * Gibt alle Funktionen eines Projekts zurueck.
 * Beinhaltet usage_count (aus code_references) und parent_name (aus self-join).
 */
export async function getFunctions(
  project: string,
  filePath?: string,
  name?: string,
  exportedOnly?: boolean
): Promise<FunctionInfo[]> {
  const pool = getPool();

  const params: unknown[] = [project];
  const conditions: string[] = ['cs.project = $1', "cs.symbol_type = 'function'"];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`cs.file_path LIKE $${params.length}`);
  }
  if (name) {
    params.push(`%${name}%`);
    conditions.push(`cs.name ILIKE $${params.length}`);
  }
  if (exportedOnly) {
    conditions.push('cs.is_exported = true');
  }

  const where = conditions.join(' AND ');

  const result = await pool.query(
    `SELECT
       cs.id,
       cs.file_path,
       cs.name,
       cs.line_start,
       cs.line_end,
       cs.params,
       cs.return_type,
       cs.is_exported,
       parent.name AS parent_name,
       COUNT(cr.id) AS usage_count
     FROM code_symbols cs
     LEFT JOIN code_symbols parent ON parent.id = cs.parent_symbol
     LEFT JOIN code_references cr ON cr.symbol_id = cs.id
     WHERE ${where}
     GROUP BY cs.id, cs.file_path, cs.name, cs.line_start, cs.line_end,
              cs.params, cs.return_type, cs.is_exported, parent.name
     ORDER BY cs.file_path, cs.line_start`,
    params
  );

  return result.rows.map(row => ({
    id: row.id,
    file_path: row.file_path,
    name: row.name,
    line_start: row.line_start,
    line_end: row.line_end,
    params: row.params,
    return_type: row.return_type,
    is_exported: row.is_exported,
    parent_name: row.parent_name ?? null,
    usage_count: parseInt(row.usage_count, 10),
  }));
}

// ─── getVariables ─────────────────────────────────────────────────────────────

export interface VariableInfo {
  id: string;
  file_path: string;
  name: string;
  line_start: number;
  line_end: number | null;
  is_exported: boolean;
  value?: string | null;
}

/**
 * Gibt alle Variablen eines Projekts zurueck.
 * value wird nur zurueckgegeben wenn withValues=true.
 */
export async function getVariables(
  project: string,
  filePath?: string,
  name?: string,
  withValues?: boolean
): Promise<VariableInfo[]> {
  const pool = getPool();

  const params: unknown[] = [project];
  const conditions: string[] = ['cs.project = $1', "cs.symbol_type = 'variable'"];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`cs.file_path LIKE $${params.length}`);
  }
  if (name) {
    params.push(`%${name}%`);
    conditions.push(`cs.name ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');
  // DX-Befund 8b: value serverseitig kuerzen — grosse Konstanten (Template-
  // Literals, const-Objekte) sprengen sonst ungekuerzt den Caller-Context.
  const valueCol = withValues
    ? `, CASE WHEN length(cs.value) > 500 THEN left(cs.value, 500) || ' …[value gekuerzt, ' || length(cs.value) || ' Zeichen gesamt]' ELSE cs.value END AS value`
    : '';

  const result = await pool.query(
    `SELECT
       cs.id,
       cs.file_path,
       cs.name,
       cs.line_start,
       cs.line_end,
       cs.is_exported
       ${valueCol}
     FROM code_symbols cs
     WHERE ${where}
     ORDER BY cs.file_path, cs.line_start`,
    params
  );

  return result.rows.map(row => {
    const info: VariableInfo = {
      id: row.id,
      file_path: row.file_path,
      name: row.name,
      line_start: row.line_start,
      line_end: row.line_end,
      is_exported: row.is_exported,
    };
    if (withValues) info.value = row.value ?? null;
    return info;
  });
}

// ─── getSymbols ───────────────────────────────────────────────────────────────

export interface SymbolInfo {
  id: string;
  file_path: string;
  symbol_type: string;
  name: string | null;
  line_start: number;
  line_end: number | null;
  is_exported: boolean;
  value: string | null;
  /**
   * Nur bei value_contains: die erste Dateizeile, in der der Suchtext steht.
   * Bei mehrzeiligen Symbolen ist das NICHT line_start — dort beginnt der Block.
   */
  match_line?: number;
  /** Nur bei value_contains: alle Trefferzeilen mit Nummer und Inhalt DIESER Zeile. */
  match_lines?: TrefferZeile[];
}

/**
 * Generische Symbol-Abfrage fuer beliebige symbol_type Werte.
 */
export async function getSymbols(
  project: string,
  symbolType: string,
  filePath?: string,
  name?: string,
  /**
   * Max. Treffer. 0 = ohne Limit (nur fuer interne Vollabfragen wie den Graphen).
   * WARUM ES DAS BRAUCHT: ohne Limit lieferte ein einzelner symbols-Call auf eine
   * grosse Datei alles — an einer 100k-Zeilen-HTML waren das 9120 Symbole bzw.
   * 1,75 MB Antwort, obwohl limit:4 angefordert war. Fuer eine aufrufende KI ist
   * das ein gesprengtes Kontextfenster ohne Vorwarnung.
   */
  limit: number = 100,
  /**
   * Sucht im INHALT (Spalte value) statt im Namen. Notwendig fuer alles, was gar
   * keinen Namen hat: Kommentare, Strings und TODOs tragen name=NULL, ein Filter
   * auf cs.name findet dort GRUNDSAETZLICH nichts — auch dann nicht, wenn der
   * gesuchte Text sichtbar im Symbol steht.
   */
  valueContains?: string
): Promise<SymbolInfo[]> {
  const pool = getPool();

  const params: unknown[] = [project, symbolType];
  const conditions: string[] = ['cs.project = $1', 'cs.symbol_type = $2'];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`cs.file_path LIKE $${params.length}`);
  }
  if (name) {
    params.push(`%${name}%`);
    conditions.push(`cs.name ILIKE $${params.length}`);
  }
  if (valueContains) {
    params.push(`%${valueContains}%`);
    conditions.push(`cs.value ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');

  const result = await pool.query(
    `SELECT
       cs.id,
       cs.file_path,
       cs.symbol_type,
       cs.name,
       cs.line_start,
       cs.line_end,
       cs.is_exported,
       cs.value
     FROM code_symbols cs
     WHERE ${where}
     ORDER BY cs.file_path, cs.line_start
     ${limit > 0 ? `LIMIT ${Math.min(Math.floor(limit), 1000)}` : ''}`,
    params
  );

  return result.rows.map(row => ({
    id: row.id,
    file_path: row.file_path,
    symbol_type: row.symbol_type,
    name: row.name ?? null,
    line_start: row.line_start,
    line_end: row.line_end,
    is_exported: row.is_exported,
    value: row.value ?? null,
    // Bei value_contains die ZEILE, die trifft — nicht line_start des Symbols.
    // Ein mehrzeiliges Symbol (verschmolzene //-Zeilen, Blockkommentar) beginnt
    // oft etliche Zeilen vor der gesuchten Stelle (Befund 28.09.2026).
    ...(valueContains ? trefferFelder(row.value, row.line_start, row.line_end, valueContains) : {}),
  }));
}

// ─── getReferences ────────────────────────────────────────────────────────────

export interface ReferenceInfo {
  /**
   * Woher die Fundstelle stammt: 'reference' = Verwendung, die der Parser in
   * code_references eingetragen hat; 'call' = Aufrufkante aus code_call_edges.
   * Beides beantwortet "wo wird das benutzt", steht aber in getrennten Tabellen.
   */
  kind?: 'reference' | 'call';
  symbol_id: string | null;
  file_path: string;
  line_number: number;
  context: string | null;
  /**
   * Gesetzt, wenn die Fundstelle ueber einen Import-Alias zustande kommt
   * (import { X as Y }, from m import X as Y, import a.X as Y): der Name Y.
   */
  via_alias?: string;
  /**
   * import_specifier/export_specifier = die Zeile "X as Y" selbst; sie enthaelt
   * X und wird beim Umbenennen mit umbenannt. alias_usage = Verwendung von Y;
   * sie enthaelt X NICHT und bleibt beim Umbenennen gueltig, weil der Alias
   * bestehen bleibt.
   */
  alias_role?: 'import_specifier' | 'export_specifier' | 'alias_usage';
}

export interface StringOccurrenceInfo {
  file_path: string;
  line_number: number;
}

export interface ReferencesResult {
  definition: {
    id: string;
    file_path: string;
    symbol_type: string;
    name: string;
    line_start: number;
    is_exported: boolean;
    /** Eltern-Symbol (Klasse/Objekt), zu dem das Symbol gehoert. NULL = freistehend. */
    parent_symbol: string | null;
  } | null;
  references: ReferenceInfo[];
  total_files: number;
  total_references: number;
  string_occurrences: StringOccurrenceInfo[];
  total_string_occurrences: number;
  /**
   * Aufrufe, die nur DENSELBEN NAMEN tragen, aber erkennbar etwas anderes
   * meinen — Methodenaufrufe auf einem fremden Empfaenger, waehrend die
   * gesuchte Definition freisteht. Sie stehen hier und nicht unter
   * references, werden aber bewusst mitgeliefert: still verschwundene
   * Treffer waeren genauso irrefuehrend wie falsche.
   */
  name_matches: ReferenceInfo[];
  total_name_matches: number;
  /**
   * true, wenn references auf das Limit gekuerzt wurde. total_references und
   * total_files zaehlen IMMER den vollen Bestand — eine gekappte Liste gibt
   * sich damit zu erkennen, statt vollstaendig auszusehen.
   */
  gekappt: boolean;
}

// ─── Importe mit Alias ────────────────────────────────────────────────────────

/** Ein Import-/Export-Specifier "X as Y", gefunden im Dateitext. */
export interface AliasSpecifier {
  art: 'import' | 'export';
  sprache: 'ts' | 'python' | 'kotlin';
  /** Der lokale bzw. neue Name Y. */
  alias: string;
  /** Zeile des Specifiers selbst — bei mehrzeiligen Importen NICHT die Anfangszeile. */
  zeile: number;
  /** Erste und letzte Zeile des ganzen Statements. */
  statementStart: number;
  statementEnde: number;
  /** Modulquelle ('./dispatch.service.js', 'app.mod', 'com.x.y'); fehlt bei lokalem export { X as Y }. */
  quelle?: string;
}

const TS_ENDUNGEN = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const PY_ENDUNGEN = /\.pyi?$/i;
const KT_ENDUNGEN = /\.kts?$/i;

function sprachwahl(dateiPfad: string): AliasSpecifier['sprache'] | null {
  if (TS_ENDUNGEN.test(dateiPfad)) return 'ts';
  if (PY_ENDUNGEN.test(dateiPfad)) return 'python';
  if (KT_ENDUNGEN.test(dateiPfad)) return 'kotlin';
  return null;
}

function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (zeichen) => '\\' + zeichen);
}

function zeileAnPosition(inhalt: string, pos: number): number {
  let zeile = 1;
  for (let i = 0; i < pos && i < inhalt.length; i++) if (inhalt.charCodeAt(i) === 10) zeile++;
  return zeile;
}

function verzeichnisVon(pfad: string): string {
  const i = pfad.lastIndexOf('/');
  return i >= 0 ? pfad.slice(0, i) : '';
}

function normalisierePfad(pfad: string): string {
  const teile: string[] = [];
  for (const teil of pfad.split('/')) {
    if (!teil || teil === '.') continue;
    if (teil === '..') teile.pop();
    else teile.push(teil);
  }
  return teile.join('/');
}

function ohneEndung(pfad: string): string {
  return pfad.replace(TS_ENDUNGEN, '').replace(PY_ENDUNGEN, '').replace(KT_ENDUNGEN, '');
}

/**
 * Sucht im Dateitext alle Specifier "name as alias". Bewusst eng gefasst: nur
 * INNERHALB von Import-/Export-Statements, damit ein TypeScript-Cast wie
 * "wert as Typ" nie als Alias gilt.
 * TS/JS: import { X as Y } from '…', export { X as Y } [from '…'] (auch mehrzeilig).
 * Python: from mod import X as Y (auch geklammert und mehrzeilig).
 * Kotlin: import a.b.X as Y.
 */
export function findeAliasSpecifier(inhalt: string, dateiPfad: string, name: string): AliasSpecifier[] {
  const sprache = sprachwahl(dateiPfad);
  if (!sprache || !name || !inhalt.includes(name)) return [];
  const n = regexLiteral(name);
  const funde: AliasSpecifier[] = [];

  if (sprache === 'kotlin') {
    const muster = new RegExp(`^[ \\t]*import[ \\t]+((?:\\w+\\.)*)${n}[ \\t]+as[ \\t]+([A-Za-z_]\\w*)`, 'gm');
    let m: RegExpExecArray | null;
    while ((m = muster.exec(inhalt)) !== null) {
      if (m[2] === name) continue;
      const zeile = zeileAnPosition(inhalt, m.index);
      funde.push({
        art: 'import', sprache, alias: m[2], zeile, statementStart: zeile, statementEnde: zeile,
        quelle: m[1].replace(/\.$/, '') || undefined,
      });
    }
    return funde;
  }

  // Statement finden, dann in seinem Specifier-Teil nach "name as alias" suchen.
  const statement = sprache === 'ts'
    ? /\b(import|export)\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\3)?/g
    : /^[ \t]*(from)[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;
  const specifier = sprache === 'ts'
    ? new RegExp(`(?:^|[\\s,{])(?:type\\s+)?(${n})\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g')
    : new RegExp(`(?:^|[\\s,(])(${n})\\s+as\\s+([A-Za-z_]\\w*)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = statement.exec(inhalt)) !== null) {
    const art: 'import' | 'export' = m[1] === 'export' ? 'export' : 'import';
    const teil = sprache === 'ts' ? m[2] : m[3];
    const quelle = sprache === 'ts' ? m[4] : m[2];
    // "import { … }" ohne from gibt es nicht — dann war es kein Import.
    if (sprache === 'ts' && art === 'import' && !quelle) continue;
    const teilStart = sprache === 'ts'
      ? m.index + m[0].indexOf('{') + 1
      : m.index + m[0].length - teil.length;
    const statementStart = zeileAnPosition(inhalt, m.index);
    const statementEnde = zeileAnPosition(inhalt, m.index + m[0].length);
    specifier.lastIndex = 0;
    let s: RegExpExecArray | null;
    while ((s = specifier.exec(teil)) !== null) {
      const alias = s[2];
      if (alias === name) continue;
      const pos = teilStart + s.index + s[0].indexOf(s[1]);
      funde.push({ art, sprache, alias, zeile: zeileAnPosition(inhalt, pos), statementStart, statementEnde, quelle });
    }
  }
  return funde;
}

/**
 * Passt die Import-Quelle zu einer der Dateien, in denen der Name definiert ist?
 * true = ja ODER nicht entscheidbar; false = erkennbar ein anderes Modul (dann
 * ist die Namensgleichheit Zufall, etwa derselbe Name aus einem npm-Paket).
 */
export function aliasQuellePasst(
  spec: AliasSpecifier,
  importDatei: string,
  definitionsDateien: Iterable<string>
): boolean {
  const defs = [...definitionsDateien].map(ohneEndung);
  if (defs.length === 0 || !spec.quelle) return true;

  if (spec.sprache === 'ts') {
    const q = spec.quelle;
    if (q.startsWith('.')) {
      const ziel = ohneEndung(normalisierePfad(`${verzeichnisVon(importDatei)}/${q}`));
      return defs.some((d) => d === ziel || d === `${ziel}/index`);
    }
    // Paket oder Pfad-Alias (@/…): nur der letzte Pfadteil ist vergleichbar.
    const letzter = ohneEndung(q.split('/').pop() ?? q);
    return defs.some((d) => {
      const teile = d.split('/');
      const ende = teile[teile.length - 1];
      return ende === letzter || (ende === 'index' && teile[teile.length - 2] === letzter);
    });
  }

  if (spec.sprache === 'python') {
    const punkte = (spec.quelle.match(/^\.*/)?.[0] ?? '').length;
    const rest = spec.quelle.slice(punkte).replace(/\./g, '/');
    if (punkte > 0) {
      let basis = verzeichnisVon(importDatei);
      for (let i = 1; i < punkte; i++) basis = verzeichnisVon(basis);
      const ziel = normalisierePfad(rest ? `${basis}/${rest}` : basis);
      return defs.some((d) => d === ziel || d === `${ziel}/__init__`);
    }
    return defs.some((d) => d === rest || d.endsWith(`/${rest}`)
      || d === `${rest}/__init__` || d.endsWith(`/${rest}/__init__`));
  }

  // Kotlin: Paket und Verzeichnis stimmen per Konvention ueberein, muessen es
  // aber nicht. Nur ein klarer Widerspruch im Standard-Layout schliesst aus.
  const paketPfad = spec.quelle.replace(/\./g, '/');
  if (defs.some((d) => d.includes(`/${paketPfad}/`) || d.startsWith(`${paketPfad}/`))) return true;
  return !defs.some((d) => /\/(?:kotlin|java)\//.test(d));
}

/** Eine Alias-Fundstelle samt Einordnung fuer getReferences. */
interface AliasFund {
  eintrag: ReferenceInfo;
  /** false = Import aus einem erkennbar anderen Modul -> name_matches. */
  passt: boolean;
  /** Nur beim Specifier: Anfangszeile des Statements (dort traegt der Linker ein). */
  statementStart?: number;
}

/**
 * Verwendungen des lokalen Alias in der importierenden Datei: Aufrufkanten
 * (callee_name = Alias) plus jede weitere Zeile, in der der Alias als eigenes
 * Wort steht — etwa als Callback uebergeben. Kommentarzeilen und das
 * Import-Statement selbst zaehlen nicht.
 */
async function findeAliasVerwendungen(
  project: string,
  dateiPfad: string,
  spec: AliasSpecifier,
  zeilen: string[],
  symbolId: string | null
): Promise<ReferenceInfo[]> {
  const kanten = await getPool().query<{ line_number: number; call_kind: string | null; caller_scope: string | null }>(
    `SELECT line_number, call_kind, caller_scope FROM code_call_edges
     WHERE project = $1 AND file_path = $2 AND callee_name = $3 AND callee_receiver IS NULL`,
    [project, dateiPfad, spec.alias]
  );
  const aufrufJeZeile = new Map(kanten.rows.map((k) => [k.line_number, k]));
  const muster = new RegExp(`(?<![\\w$.])${regexLiteral(spec.alias)}(?![\\w$])`);
  const kommentar = spec.sprache === 'python' ? /^\s*#/ : /^\s*(?:\/\/|\/?\*)/;
  const ergebnis: ReferenceInfo[] = [];
  for (let i = 0; i < zeilen.length; i++) {
    const nr = i + 1;
    if (nr >= spec.statementStart && nr <= spec.statementEnde) continue;
    const aufruf = aufrufJeZeile.get(nr);
    if (!aufruf && (kommentar.test(zeilen[i]) || !muster.test(zeilen[i]))) continue;
    ergebnis.push({
      kind: aufruf ? 'call' : 'reference',
      symbol_id: symbolId,
      file_path: dateiPfad,
      line_number: nr,
      context: aufruf
        ? `${aufruf.call_kind ?? 'call'}: ${spec.alias}()` + (aufruf.caller_scope ? ` in ${aufruf.caller_scope}` : '')
        : zeilen[i].trim().slice(0, 200),
      via_alias: spec.alias,
      alias_role: 'alias_usage',
    });
  }
  return ergebnis;
}

/**
 * Alle Fundstellen von "name", die ueber einen Import-Alias laufen: die
 * Specifier-Zeilen selbst und die Verwendungen des Alias. Siehe getReferences.
 */
async function findeAliasReferenzen(
  project: string,
  name: string,
  definitionsDateien: Set<string>,
  symbolId: string | null
): Promise<AliasFund[]> {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  // Vorfilter in PG: nur Dateien, in denen "name as" ueberhaupt vorkommt.
  const dateien = await getPool().query<{ file_path: string; content: string }>(
    `SELECT file_path, content FROM code_files
     WHERE project = $1 AND NOT ignored AND strpos(content, $2) > 0 AND content ~ $3`,
    [project, name, `${regexLiteral(name)}\\s+as\\s`]
  );
  const funde: AliasFund[] = [];
  for (const datei of dateien.rows) {
    const specs = findeAliasSpecifier(datei.content, datei.file_path, name);
    if (specs.length === 0) continue;
    const zeilen = datei.content.split('\n');
    for (const spec of specs) {
      const passt = aliasQuellePasst(spec, datei.file_path, definitionsDateien);
      funde.push({
        passt,
        statementStart: spec.statementStart,
        eintrag: {
          kind: 'reference',
          symbol_id: symbolId,
          file_path: datei.file_path,
          line_number: spec.zeile,
          context: (zeilen[spec.zeile - 1] ?? '').trim().slice(0, 200) || null,
          via_alias: spec.alias,
          alias_role: spec.art === 'import' ? 'import_specifier' : 'export_specifier',
        },
      });
      // Nur ein IMPORT bindet den Alias lokal; export { X as Y } benennt nach aussen um.
      if (spec.art !== 'import') continue;
      for (const v of await findeAliasVerwendungen(project, datei.file_path, spec, zeilen, symbolId)) {
        funde.push({ passt, eintrag: v });
      }
    }
  }
  return funde;
}

/**
 * Findet die Definition und alle Referenzen eines Symbols per Name.
 *
 * ⚠️ WAS DIESE FUNKTION IST UND WAS NICHT (gemessen am 26.08.2026):
 * Sie loest Symbole NICHT auf wie ein Sprachserver, sie sucht ueber den Namen.
 * Bei einem haeufigen Namen war das Ergebnis dadurch unbrauchbar: `update`
 * lieferte 14 Treffer, von denen 13 `crypto.createHash('sha256').update()`
 * waren — die Hash-Methode von Node, die mit der gesuchten Funktion nichts zu
 * tun hat. Eine Liste, die zu 93 Prozent falsch ist, ist schlimmer als keine:
 * sie sieht aus wie eine Antwort.
 *
 * Die Angabe zum Aussortieren lag laengst in code_call_edges und wurde nur
 * nicht gelesen: Ein Aufruf mit `call_kind='method'` und gefuelltem
 * `callee_receiver` richtet sich an ein Objekt. Steht die gesuchte Definition
 * frei (kein parent_name), kann er sie nicht meinen. Ist `target_symbol_id`
 * aufgeloest und zeigt anderswohin, erst recht nicht.
 *
 * Was dadurch NICHT besser wird: zwei gleichnamige Methoden auf verschiedenen
 * Klassen bleiben ununterscheidbar, solange niemand Typen aufloest. Dafuer
 * bleibt ein Sprachserver zustaendig.
 *
 * @param includeNameMatches Nur fuer den Rohbestand: liefert die aussortierten
 *   Namensgleichen zusaetzlich unter references. Standard ist aus — wer nichts
 *   angibt, soll das Richtige bekommen, nicht das Vollstaendige.
 * @param limit Max. Eintraege unter references (Standard 200, <= 0 = unbegrenzt).
 *   Gekappt wird nie still: total_references zaehlt weiterhin alle, gekappt
 *   markiert die Kuerzung. Wer wirklich alles braucht (Umbenennen!), gibt 0 an.
 */
export async function getReferences(
  project: string,
  name: string,
  includeNameMatches = false,
  limit = 200
): Promise<ReferencesResult> {
  const pool = getPool();

  // Definition laden — non-string bevorzugen (echte Deklaration vor String-Literal)
  const defResult = await pool.query(
    `SELECT id, file_path, symbol_type, name, line_start, is_exported, parent_symbol
     FROM code_symbols
     WHERE project = $1 AND name = $2
     ORDER BY CASE WHEN symbol_type = 'string' THEN 1 ELSE 0 END, line_start
     LIMIT 1`,
    [project, name]
  );

  const definition = defResult.rows[0]
    ? {
        id: defResult.rows[0].id,
        file_path: defResult.rows[0].file_path,
        symbol_type: defResult.rows[0].symbol_type,
        name: defResult.rows[0].name,
        line_start: defResult.rows[0].line_start,
        is_exported: defResult.rows[0].is_exported,
        parent_symbol: defResult.rows[0].parent_symbol ?? null,
      }
    : null;

  // ALLE gleichnamigen Symbole, nicht nur das oben gewaehlte. Ein Name traegt
  // haeufig mehrere Eintraege — etwa die Funktion selbst und ihren export.
  // Ein aufgeloester Aufruf zeigt dann auf irgendeinen davon, und ein Vergleich
  // gegen nur einen erklaert die echten Treffer faelschlich fuer fremd (bei
  // getReferences selbst gemessen: beide Aufrufer fielen heraus).
  const eigeneSymbolIds = new Set<string>();
  const idRows = await pool.query<{ id: string; file_path: string; symbol_type: string }>(
    `SELECT id, file_path, symbol_type FROM code_symbols
     WHERE project = $1 AND name = $2 AND symbol_type <> 'string'`,
    [project, name]
  );
  // Dateien, in denen der Name DEFINIERT oder re-exportiert wird. Import-Symbole
  // tragen bei Python/Kotlin denselben Namen und zaehlen hier nicht mit.
  const definitionsDateien = new Set<string>();
  for (const zeile of idRows.rows) {
    eigeneSymbolIds.add(zeile.id);
    if (zeile.symbol_type !== 'import') definitionsDateien.add(zeile.file_path);
  }

  // Gehoert die Definition selbst zu einem Objekt? Dann sind Methodenaufrufe
  // plausibel und duerfen nicht aussortiert werden.
  const definitionIstMethode = Boolean(definition?.parent_symbol)
    || definition?.symbol_type === 'class'
    || definition?.symbol_type === 'interface';

  // Alle Referenzen laden (ueber code_references JOIN code_symbols)
  const refsResult = await pool.query(
    `SELECT cr.symbol_id, cr.file_path, cr.line_number, cr.context
     FROM code_references cr
     JOIN code_symbols cs ON cs.id = cr.symbol_id
     WHERE cr.project = $1 AND cs.name = $2
     ORDER BY cr.file_path, cr.line_number`,
    [project, name]
  );

  const references: ReferenceInfo[] = refsResult.rows.map(row => ({
    symbol_id: row.symbol_id,
    file_path: row.file_path,
    line_number: row.line_number,
    context: row.context ?? null,
    kind: 'reference' as const,
  }));

  // ⚠️ AUCH DIE AUFRUFKANTEN. code_references enthaelt Verwendungsstellen, die der
  // Parser dort eintraegt — ein METHODENAUFRUF landet dagegen in code_call_edges.
  // Wer "wo wird das benutzt" fragt, meint beides.
  // GEMESSEN (unraid-cloud, 08.08.2026, Befund von codex-sol): der Aufruf
  // scanner.itemsAddedAfter(cursor) stand mit confidence 1 UND aufgeloestem
  // target_symbol_id in code_call_edges — references lieferte trotzdem 0 Treffer
  // und damit die Auskunft "wird nirgends verwendet". Das ist die teuerste Sorte
  // Fehler: eine leere Liste sieht aus wie eine Antwort.
  // Betrifft JEDE Sprache, deren Parser Call-Kanten schreibt, nicht nur Kotlin.
  const callRows = await pool.query(
    `SELECT ce.file_path, ce.line_number, ce.caller_scope, ce.callee_receiver,
            ce.call_kind, ce.target_symbol_id
     FROM code_call_edges ce
     WHERE ce.project = $1 AND ce.callee_name = $2
     ORDER BY ce.file_path, ce.line_number`,
    [project, name]
  );

  // Dieselbe Stelle kann in beiden Tabellen stehen — dann gewinnt der bereits
  // vorhandene Eintrag, damit niemand eine Fundstelle doppelt gezaehlt bekommt.
  const bekannt = new Set(references.map(r => `${r.file_path}:${r.line_number}`));
  const nameMatches: ReferenceInfo[] = [];
  for (const row of callRows.rows) {
    const schluessel = `${row.file_path}:${row.line_number}`;
    if (bekannt.has(schluessel)) continue;
    bekannt.add(schluessel);
    const empfaenger = row.callee_receiver ? `${row.callee_receiver}.` : '';
    const eintrag: ReferenceInfo = {
      symbol_id: row.target_symbol_id ?? null,
      file_path: row.file_path,
      line_number: row.line_number,
      context: `${row.call_kind ?? 'call'}: ${empfaenger}${name}()`
        + (row.caller_scope ? ` in ${row.caller_scope}` : ''),
      kind: 'call' as const,
    };

    // Aufgeloest und zeigt auf KEINES der gleichnamigen Symbole: gehoert nicht hierher.
    const zeigtWoandersHin = Boolean(
      row.target_symbol_id && !eigeneSymbolIds.has(row.target_symbol_id)
    );
    // Methodenaufruf auf einem Objekt, waehrend die Definition freisteht:
    // dann ist die Namensgleichheit Zufall (crypto.createHash().update()).
    const fremderEmpfaenger = Boolean(
      row.call_kind === 'method' && row.callee_receiver && !definitionIstMethode
    );

    if (definition && (zeigtWoandersHin || fremderEmpfaenger)) {
      nameMatches.push(eintrag);
      if (includeNameMatches) references.push(eintrag);
      continue;
    }
    references.push(eintrag);
  }

  // ⚠️ IMPORTE MIT ALIAS. Befund 28.09.2026 (softcleanToeva, alarm.service.ts:28-29):
  //   import { handleAccept as dispatchHandleAccept, handleReject as dispatchHandleReject } from './dispatch.service.js'
  // references(handleReject) lieferte 0 Treffer, keine name_matches — die
  // Funktion sah aus wie toter Code, obwohl sie aufgerufen wird.
  // URSACHE IM INDEX: der TS-Parser speichert je Import-Specifier nur den
  // LOKALEN Namen (el.name), der Originalname (el.propertyName) faellt weg. Der
  // Linker verknuepft deshalb den Alias statt des Originals, und jede
  // Aufrufkante traegt callee_name = Alias. Python und Kotlin behalten am
  // Import den Originalnamen, ihre Aufrufe laufen aber ebenso unter dem Alias.
  // LOESUNG OHNE NEUINDEXIERUNG: der Specifier "X as Y" wird im Dateitext
  // gesucht. Seine Zeile zaehlt als Referenz auf X, die Verwendungen von Y in
  // derselben Datei ebenfalls — beide mit via_alias gekennzeichnet.
  const aliasFunde = await findeAliasReferenzen(project, name, definitionsDateien, definition?.id ?? null);
  const gleicheStelle = (r: ReferenceInfo, datei: string, zeile: number) =>
    r.file_path === datei && r.line_number === zeile;
  for (const fund of aliasFunde) {
    const e = fund.eintrag;
    // Python/Kotlin: der Linker hat die Import-Zeile schon eingetragen — unter
    // der ANFANGSZEILE des Statements. Dann wird dieser Eintrag uebernommen
    // statt eine zweite Fundstelle fuer denselben Import zu erzeugen.
    if (fund.statementStart !== undefined) {
      const alt = references.find((r) => !r.via_alias && r.kind !== 'call'
        && gleicheStelle(r, e.file_path, fund.statementStart!));
      if (alt) {
        bekannt.delete(`${alt.file_path}:${alt.line_number}`);
        alt.line_number = e.line_number;
        alt.context = e.context;
        alt.via_alias = e.via_alias;
        alt.alias_role = e.alias_role;
        bekannt.add(`${e.file_path}:${e.line_number}`);
        continue;
      }
    }
    const schluessel = `${e.file_path}:${e.line_number}`;
    if (bekannt.has(schluessel)) {
      const vorhanden = references.find((r) => gleicheStelle(r, e.file_path, e.line_number));
      if (vorhanden && !vorhanden.via_alias) {
        vorhanden.via_alias = e.via_alias;
        vorhanden.alias_role = e.alias_role;
      }
      continue;
    }
    bekannt.add(schluessel);
    if (fund.passt) {
      references.push(e);
    } else {
      // Import aus einem erkennbar ANDEREN Modul: gleicher Name, anderes Ding.
      e.context = `${e.context ?? ''} [Import-Quelle passt nicht zur Definition]`;
      nameMatches.push(e);
      if (includeNameMatches) references.push(e);
    }
  }
  references.sort((a, b) =>
    a.file_path === b.file_path
      ? a.line_number - b.line_number
      : a.file_path.localeCompare(b.file_path));

  // String-Literale: separate Liste aller Vorkommen (Parser speichert jedes String-Literal
  // als eigenes code_symbol mit symbol_type='string').
  const stringRows = await pool.query(
    `SELECT file_path, line_start
     FROM code_symbols
     WHERE project = $1 AND name = $2 AND symbol_type = 'string'
     ORDER BY file_path, line_start`,
    [project, name]
  );
  const stringOccurrences: StringOccurrenceInfo[] = stringRows.rows.map(row => ({
    file_path: row.file_path,
    line_number: row.line_start,
  }));

  // Eindeutige Dateien zaehlen
  const uniqueFiles = new Set(references.map(r => r.file_path));

  nameMatches.sort((a, b) =>
    a.file_path === b.file_path
      ? a.line_number - b.line_number
      : a.file_path.localeCompare(b.file_path));

  // Nur eine Kostprobe ausliefern. name_matches ist eine Begruendung dafuer,
  // dass etwas AUSSORTIERT wurde — dafuer genuegen ein paar Beispiele und die
  // Gesamtzahl. Vollstaendig ausgegeben trieb allein diese Liste die Antwort
  // bei einem haeufigen Namen ueber die Grenze dessen, was ein Aufrufer noch
  // verarbeiten kann. Wer alle braucht, setzt include_name_matches.
  const NAME_MATCH_PROBE = 10;

  // Kappen erst NACH dem Zaehlen: total_references und total_files beschreiben
  // den vollen Bestand; nur die ausgelieferte Liste wird begrenzt.
  const wirksamesLimit = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const gekappt = references.length > wirksamesLimit;

  return {
    definition,
    references: gekappt ? references.slice(0, limit) : references,
    total_files: uniqueFiles.size,
    total_references: references.length,
    string_occurrences: stringOccurrences,
    total_string_occurrences: stringOccurrences.length,
    name_matches: includeNameMatches ? nameMatches : nameMatches.slice(0, NAME_MATCH_PROBE),
    total_name_matches: nameMatches.length,
    gekappt,
  };
}

// ─── fullTextSearchCode ───────────────────────────────────────────────────────

/** Eine Zeile, in der ein Suchwort steht (1-basiert, gezaehlt wie code_intel(file)). */
export interface SuchTrefferZeile {
  line: number;
  /** Zeileninhalt ohne \r; bei langen Zeilen ein Ausschnitt um den ersten Treffer. */
  text: string;
  /** Nur bei mehreren Suchwoertern: welche davon in dieser Zeile stehen. */
  words?: string[];
  /** Nur bei Zeilen ueber SUCH_ZEILE_MAX_ZEICHEN: text ist ein Ausschnitt. */
  text_gekuerzt?: true;
  /** Nur bei gekuerzter Zeile: volle Laenge in Zeichen. */
  line_length?: number;
  /** Nur bei gekuerzter Zeile: 1-basierte Spalte des ersten Treffers. */
  column?: number;
}

export interface FullTextSearchResult {
  file_path: string;
  file_type: string;
  headline: string;
  rank: number;
  /** Trefferzeilen (Fenster aus match_skip/match_limit). */
  matches: SuchTrefferZeile[];
  /** Alle Zeilen mit mindestens einem Suchwort — unabhaengig vom Fenster. */
  total_matches: number;
  /** Nur bei mehreren Suchwoertern: Zeilen, in denen ALLE stehen. */
  total_matches_all_words?: number;
  /** true, wenn hinter dem Fenster noch Trefferzeilen liegen. */
  matches_gekappt: boolean;
}

/** Ein Suchwort der Anfrage und die Begriffe, die es in einer Zeile vertreten (Wort, Stamm). */
export interface SuchWort {
  wort: string;
  begriffe: string[];
}

export interface SuchZeilenOptionen {
  /** Max. Trefferzeilen je Datei (Standard 20, 0 = nur zaehlen). */
  limit?: number;
  /** Die ersten N Trefferzeilen je Datei ueberspringen (Standard 0). */
  skip?: number;
}

const SUCH_ZEILEN_STANDARD = 20;
const SUCH_ZEILEN_MAX = 1000;
const SUCH_ZEILE_MAX_ZEICHEN = 200;

/**
 * Findet die Zeilen, in denen die Suchwoerter stehen.
 *
 * Warum: die Volltextsuche nannte nur die Datei und einen ts_headline-Ausschnitt.
 * Wer wissen wollte, WO das Wort steht, griff zu grep -n (gemessen bis zu 90 Aufrufe
 * je Agent). Jetzt traegt jeder Treffer die Zeilen fuer code_intel(file, from_line).
 *
 * Regeln:
 *  - case-insensitive Teilstring je Begriff; ein Wort gilt als gefunden, wenn einer
 *    seiner Begriffe (das Wort selbst oder sein englischer Stamm) in der Zeile steht.
 *  - Eine Zeile zaehlt einmal, egal wie oft das Wort darin steht.
 *  - Ein Suchwort: Zeilen in Dateireihenfolge. Mehrere: Zeilen mit MEHR Woertern zuerst
 *    (alle Woerter ganz oben), innerhalb gleicher Anzahl in Dateireihenfolge.
 *  - Zeilen werden an \n getrennt wie in code_intel(file); ein \r am Ende faellt weg.
 *
 * Laufzeit: kein split der ganzen Datei. Die Zeilenanfaenge werden einmal per indexOf
 * bestimmt, die Treffer per RegExp gesucht, nach einem Treffer springt die Suche an
 * das Zeilenende. Text wird nur fuer die ausgelieferten Zeilen herausgeschnitten.
 */
export function findeSuchZeilen(
  content: string,
  woerter: SuchWort[],
  optionen: SuchZeilenOptionen = {}
): Pick<FullTextSearchResult, 'matches' | 'total_matches' | 'total_matches_all_words' | 'matches_gekappt'> {
  // NaN (z. B. parseInt aus der REST-Query) zaehlt wie "nicht gesetzt".
  const ganz = (v: number | undefined, standard: number): number =>
    v !== undefined && Number.isFinite(v) ? Math.floor(v) : standard;
  const limit = Math.min(Math.max(0, ganz(optionen.limit, SUCH_ZEILEN_STANDARD)), SUCH_ZEILEN_MAX);
  const skip = Math.max(0, ganz(optionen.skip, 0));

  const anfaenge: number[] = [0];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) anfaenge.push(i + 1);
  const zeileVon = (pos: number): number => {
    let lo = 0;
    let hi = anfaenge.length - 1;
    while (lo < hi) {
      const mitte = (lo + hi + 1) >> 1;
      if (anfaenge[mitte] <= pos) lo = mitte; else hi = mitte - 1;
    }
    return lo;
  };
  const zeilenEnde = (idx: number): number =>
    idx + 1 < anfaenge.length ? anfaenge[idx + 1] - 1 : content.length;

  const funde = new Map<number, { woerter: Set<number>; spalte: number }>();
  woerter.forEach((w, wi) => {
    // Laengere Begriffe zuerst, damit die Alternation den genaueren trifft.
    const begriffe = [...new Set(w.begriffe.filter(b => b.length > 0))].sort((a, b) => b.length - a.length);
    if (begriffe.length === 0) return;
    const re = new RegExp(begriffe.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const idx = zeileVon(m.index);
      const spalte = m.index - anfaenge[idx];
      const fund = funde.get(idx);
      if (fund) {
        fund.woerter.add(wi);
        if (spalte < fund.spalte) fund.spalte = spalte;
      } else {
        funde.set(idx, { woerter: new Set([wi]), spalte });
      }
      re.lastIndex = zeilenEnde(idx) + 1;
    }
  });

  const mehrere = woerter.length > 1;
  const sortiert = [...funde.entries()].sort((a, b) =>
    mehrere ? (b[1].woerter.size - a[1].woerter.size) || (a[0] - b[0]) : a[0] - b[0]
  );
  const fenster = sortiert.slice(skip, skip + limit);

  const matches = fenster.map(([idx, fund]): SuchTrefferZeile => {
    const roh = content.slice(anfaenge[idx], zeilenEnde(idx)).replace(/\r$/, '');
    const zeile: SuchTrefferZeile = { line: idx + 1, text: roh };
    if (roh.length > SUCH_ZEILE_MAX_ZEICHEN) {
      // Ausschnitt so legen, dass der erste Treffer mit etwas Vorlauf sichtbar ist.
      const von = Math.max(0, Math.min(fund.spalte - 60, roh.length - SUCH_ZEILE_MAX_ZEICHEN));
      const bis = von + SUCH_ZEILE_MAX_ZEICHEN;
      zeile.text = (von > 0 ? '…' : '') + roh.slice(von, bis) + (bis < roh.length ? '…' : '');
      zeile.text_gekuerzt = true;
      zeile.line_length = roh.length;
      zeile.column = fund.spalte + 1;
    }
    if (mehrere) zeile.words = [...fund.woerter].sort((a, b) => a - b).map(i => woerter[i].wort);
    return zeile;
  });

  return {
    matches,
    total_matches: sortiert.length,
    ...(mehrere ? { total_matches_all_words: sortiert.filter(([, f]) => f.woerter.size === woerter.length).length } : {}),
    matches_gekappt: skip + fenster.length < sortiert.length,
  };
}

/**
 * Volltext-Suche in code_files via PostgreSQL tsvector.
 * Trennt Query-Woerter mit ' & ' fuer AND-Suche.
 * Gibt file_path, ts_headline, ts_rank und die Trefferzeilen (matches) zurueck.
 *
 * HINWEIS: Bewusst nicht "searchCode" (belegt durch code.ts — semantische Qdrant-Suche)
 */
export async function fullTextSearchCode(
  project: string,
  query: string,
  fileType?: string,
  limit: number = 20,
  filePath?: string,
  zeilen: { match_limit?: number; match_skip?: number } = {}
): Promise<FullTextSearchResult[]> {
  const pool = getPool();

  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const params: unknown[] = [project, cleanQuery];
  let typeFilter = '';
  if (fileType) {
    params.push(fileType);
    typeFilter = `AND file_type = $${params.length}`;
  }
  // ⚠️ file_path wurde bis 08.08.2026 STILL VERWORFEN: der Parameter stand im
  // Tool-Schema, die Funktion kannte ihn nicht, und die Suche lieferte munter
  // Treffer aus dem ganzen Projekt. Eine Antwort, die nach einer Antwort aussieht.
  // LIKE statt Gleichheit, damit ein Verzeichnis-Praefix genauso funktioniert wie
  // ein vollstaendiger Pfad — dieselbe Semantik wie bei functions/symbols/calls.
  let pfadFilter = '';
  if (filePath) {
    params.push(`%${filePath}%`);
    pfadFilter = `AND file_path LIKE $${params.length}`;
  }
  params.push(limit);

  // CI-2 (15.08.2026): ZWEI Spalten, ODER-verknuepft.
  //   tsv         'english' — mit Stemming, findet zu "Request" auch requests/requesting.
  //   tsv_zerlegt 'simple'  — an Bezeichnergrenzen zerlegt, findet this./Log./System.out.
  // Beide sind noetig: die Zerlegung ALLEIN waere bei gestemmten Woertern schlechter als
  // vorher (Request: 2.399 verpasste Dateien statt 1.386), 'english' allein findet keinen
  // einzigen punktgetrennten Bezeichner. Gemessen ueber 87.942 Dateien.
  // Die Anfrage wird fuer die zweite Spalte GENAUSO zerlegt wie der Text — sonst sucht man
  // 'system.out' in einem Index, der nur 'system' und 'out' kennt.
  const ZERLEGEN = `regexp_replace($2, '[^A-Za-z0-9]+', ' ', 'g')`;

  // Suchwoerter fuer die Trefferzeilen: an allem ausser Buchstaben, Ziffern, _ und $
  // getrennt (registerAgent bleibt ein Wort, @SYN- wird zu syn). Dazu je Wort der
  // englische Stamm, damit "requesting" auch die Zeile mit "requests" nennt — dieselbe
  // Datei hat die Volltextsuche ja genau darueber gefunden.
  const woerterRoh = [...new Set(cleanQuery.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter(w => w.length > 0))];
  const staemme = pool.query<{ w: string; q: string }>(
    `SELECT w, plainto_tsquery('english', w)::text AS q FROM unnest($1::text[]) AS w`,
    [woerterRoh]
  );
  // Scheitert die Hauptabfrage, darf diese hier nicht als unbehandelte Ablehnung enden.
  staemme.catch(() => {});

  const result = await pool.query(
    `SELECT
       file_path,
       file_type,
       content,
       ts_headline('english', content, plainto_tsquery('english', $2),
         'MaxWords=20, MinWords=5, ShortWord=3, HighlightAll=false,
          MaxFragments=2, FragmentDelimiter='' ... ''') AS headline,
       GREATEST(
         ts_rank(tsv, plainto_tsquery('english', $2)),
         ts_rank(tsv_zerlegt, plainto_tsquery('simple', ${ZERLEGEN}))
       ) AS rank
     FROM code_files
     WHERE project = $1
       AND NOT ignored
       AND (
         tsv @@ plainto_tsquery('english', $2)
         OR tsv_zerlegt @@ plainto_tsquery('simple', ${ZERLEGEN})
       )
       ${typeFilter}
       ${pfadFilter}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params
  );

  const stammVon = new Map((await staemme).rows.map(r => [r.w, r.q]));
  const woerter: SuchWort[] = woerterRoh.map(w => ({
    wort: w,
    begriffe: [w, ...[...(stammVon.get(w) ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]).filter(s => s.length >= 3)],
  }));

  return result.rows.map(row => ({
    file_path: row.file_path,
    file_type: row.file_type,
    headline: row.headline ?? '',
    rank: parseFloat(row.rank),
    ...findeSuchZeilen(row.content ?? '', woerter, { limit: zeilen.match_limit, skip: zeilen.match_skip }),
  }));
}

// ─── getFileContent ───────────────────────────────────────────────────────────

/** Max. Zeichen im content-Feld bevor Auto-Reduce greift. */
const FILE_CONTENT_MAX_CHARS = 80_000;

export interface FileContentResult {
  file_path: string;
  file_type: string;
  file_size: number;
  content: string;
  /** Gesamtzahl der Zeilen in der Datei (unabhaengig von from/to). */
  total_lines: number;
  /** Tatsaechlich gelieferte Zeilen-Range (1-basiert, inklusiv). */
  returned_range: { from: number; to: number; eof: boolean };
}

/**
 * Optionen fuer getFileContent und applyContentRange.
 */
export interface FileContentOptions {
  /** 1-basierte Start-Zeile (Standard: 1). */
  from?: number;
  /** 1-basierte End-Zeile inklusiv (Standard: letzte Zeile). */
  to?: number;
  /**
   * Zeilen die laenger als dieser Wert sind werden auf diesen Wert gekuerzt
   * und mit einem Marker versehen. 0 = deaktiviert (Standard).
   */
  truncate_long_lines?: number;
}

/**
 * Wendet Zeilen-Range, truncate_long_lines und Auto-Reduce auf rohen Datei-
 * Inhalt an. Kann unabhaengig von der DB-Abfrage genutzt werden.
 */
export function applyContentRange(
  rawContent: string,
  options: FileContentOptions = {}
): { content: string; total_lines: number; returned_range: { from: number; to: number; eof: boolean } } {
  const lines = rawContent.split('\n');
  const total_lines = lines.length;

  const from = Math.max(1, options.from ?? 1);
  const toRequested = options.to ?? total_lines;
  const truncAt = options.truncate_long_lines ?? 0;

  // truncate_long_lines ZUERST anwenden (damit Auto-Reduce korrekt zaehlt)
  const processedLines = truncAt > 0
    ? lines.map(line =>
        line.length > truncAt
          ? line.slice(0, truncAt) + `…[truncated, full length ${line.length} chars]…`
          : line
      )
    : lines;

  // Zeilen-Range ausschneiden (0-basiert intern)
  const fromIdx = from - 1;
  const toIdx = Math.min(toRequested, total_lines) - 1;
  let selectedLines = processedLines.slice(fromIdx, toIdx + 1);
  let actualTo = Math.min(toRequested, total_lines);

  // Auto-Reduce: Wenn Content > FILE_CONTENT_MAX_CHARS → auf passende Zeilen kuerzen
  let joined = selectedLines.join('\n');
  if (joined.length > FILE_CONTENT_MAX_CHARS) {
    let charCount = 0;
    let fitCount = 0;
    for (let i = 0; i < selectedLines.length; i++) {
      const lineLen = selectedLines[i].length + (i > 0 ? 1 : 0); // +1 fuer \n (ausser erste Zeile)
      if (charCount + lineLen > FILE_CONTENT_MAX_CHARS) break;
      charCount += lineLen;
      fitCount++;
    }
    if (fitCount === 0) fitCount = 1; // mindestens 1 Zeile liefern
    selectedLines = selectedLines.slice(0, fitCount);
    actualTo = from + fitCount - 1;
    joined = selectedLines.join('\n');
  }

  return {
    content: joined,
    total_lines,
    returned_range: {
      from,
      to: actualTo,
      eof: actualTo >= total_lines,
    },
  };
}

/**
 * Laedt den Inhalt einer Datei aus PostgreSQL.
 * filePath wird als LIKE-Pattern verwendet ('%filePath%').
 * Gibt null zurueck wenn nicht gefunden.
 *
 * Unterstuetzt optionale Range- und Truncation-Parameter:
 * - from / to: Zeilen-Range (1-basiert, inklusiv)
 * - truncate_long_lines: Zeilen auf N Zeichen kuerzen
 * - Auto-Reduce bei > 80k Zeichen im content
 */
export async function getFileContent(
  project: string,
  filePath: string,
  options?: FileContentOptions
): Promise<FileContentResult | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT file_path, file_type, file_size, content
     FROM code_files
     WHERE project = $1 AND file_path LIKE $2
     ORDER BY file_path
     LIMIT 1`,
    [project, `%${filePath}%`]
  );

  if (!result.rows[0]) return null;
  const row = result.rows[0];

  const ranged = applyContentRange(row.content ?? '', options);

  return {
    file_path: row.file_path,
    file_type: row.file_type,
    file_size: row.file_size ?? 0,
    ...ranged,
  };
}

// ─── Ablauf-Ebene (Statements / Call-Edges / Flow / Entrypoints) ──────────────

export interface StatementInfo {
  id: string;
  file_path: string;
  scope_type: string | null;
  scope_name: string | null;
  statement_type: string;
  node_kind: string | null;
  line_start: number;
  line_end: number | null;
  order_index: number;
  depth: number;
  parent_statement_id: string | null;
  text: string | null;
  callee: string | null;
  receiver: string | null;
  assigned_to: string | null;
  condition_text: string | null;
  is_top_level: boolean;
  is_awaited: boolean;
}

export interface CallEdgeInfo {
  id: string;
  file_path: string;
  caller_scope: string | null;
  statement_id: string | null;
  callee_name: string;
  callee_receiver: string | null;
  target_symbol_id: string | null;
  line_number: number;
  call_kind: string | null;
  confidence: number | null;
}

/**
 * Liefert Statements der Ablauf-Ebene. Filterbar nach Datei, Scope und
 * optional nur Top-Level. Sortiert nach Datei, Scope, order_index, line_start.
 */
export async function getStatements(
  project: string,
  filePath?: string,
  scopeName?: string,
  topLevelOnly?: boolean,
  limit?: number,
): Promise<StatementInfo[]> {
  const pool = getPool();
  const params: unknown[] = [project];
  const conditions: string[] = ['project = $1'];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`file_path LIKE $${params.length}`);
  }
  if (scopeName) {
    params.push(scopeName);
    conditions.push(`scope_name = $${params.length}`);
  }
  if (topLevelOnly) {
    conditions.push('is_top_level = true');
  }

  // Sort: file → scope (NULL=top-level first) → depth (parents before children) → order_index.
  // Verhindert dass Child-Statements (order_index=0 im inner scope) zwischen Top-Level rutschen.
  let sql =
    `SELECT id, file_path, scope_type, scope_name, statement_type, node_kind,
            line_start, line_end, order_index, depth, parent_statement_id,
            text, callee, receiver, assigned_to, condition_text,
            is_top_level, is_awaited
       FROM code_statements
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path, scope_name NULLS FIRST, depth, order_index, line_start`;
  if (limit && limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await pool.query(sql, params);

  return result.rows.map(row => ({
    id: String(row.id),
    file_path: row.file_path,
    scope_type: row.scope_type,
    scope_name: row.scope_name,
    statement_type: row.statement_type,
    node_kind: row.node_kind,
    line_start: row.line_start,
    line_end: row.line_end,
    order_index: row.order_index,
    depth: row.depth,
    parent_statement_id: row.parent_statement_id != null ? String(row.parent_statement_id) : null,
    text: row.text,
    callee: row.callee,
    receiver: row.receiver,
    assigned_to: row.assigned_to,
    condition_text: row.condition_text,
    is_top_level: row.is_top_level,
    is_awaited: row.is_awaited,
  }));
}

export interface CallEdgesResult {
  calls: CallEdgeInfo[];
  /** Gesamtzahl passender Kanten — unabhaengig vom Limit. */
  total: number;
  /** true, wenn calls auf das Limit gekuerzt wurde. */
  gekappt: boolean;
}

/**
 * Liefert Call-Edges der Ablauf-Ebene. Filterbar nach Datei und/oder
 * aufgerufenem Namen (callee_name). Sortiert nach Datei und Zeile.
 *
 * @param limit Max. Kanten (Standard 200, <= 0 = unbegrenzt). Ohne Grenze
 *   sprengte ein haeufiger callee die Antwort (~88k Zeichen); total zaehlt
 *   immer alle, gekappt macht die Kuerzung sichtbar — nie still abschneiden.
 */
export async function getCallEdges(
  project: string,
  filePath?: string,
  calleeName?: string,
  limit = 200
): Promise<CallEdgesResult> {
  const pool = getPool();
  const params: unknown[] = [project];
  const conditions: string[] = ['project = $1'];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`file_path LIKE $${params.length}`);
  }
  if (calleeName) {
    params.push(calleeName);
    conditions.push(`callee_name = $${params.length}`);
  }

  // COUNT(*) OVER() liefert die Gesamtzahl im selben Roundtrip, auch wenn
  // LIMIT die ausgelieferten Zeilen begrenzt.
  let limitKlausel = '';
  if (limit > 0) {
    params.push(limit);
    limitKlausel = ` LIMIT $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, file_path, caller_scope, statement_id, callee_name,
            callee_receiver, target_symbol_id, line_number, call_kind, confidence,
            COUNT(*) OVER() AS gesamt
       FROM code_call_edges
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path, line_number${limitKlausel}`,
    params
  );

  const total = result.rows.length > 0 ? Number(result.rows[0].gesamt) : 0;
  const calls = result.rows.map(row => ({
    id: String(row.id),
    file_path: row.file_path,
    caller_scope: row.caller_scope,
    statement_id: row.statement_id != null ? String(row.statement_id) : null,
    callee_name: row.callee_name,
    callee_receiver: row.callee_receiver,
    target_symbol_id: row.target_symbol_id,
    line_number: row.line_number,
    call_kind: row.call_kind,
    confidence: row.confidence != null ? Number(row.confidence) : null,
  }));

  return { calls, total, gekappt: calls.length < total };
}

export interface ExecutionFlowResult {
  file_path: string;
  scope_name: string | null;
  statements: StatementInfo[];
}

/**
 * Liefert die geordnete Ausfuehrungsreihenfolge einer Datei (oder eines
 * Scopes innerhalb der Datei). Standardmaessig die TOP-LEVEL-Ausfuehrung
 * (scope_type = 'module'), d.h. was beim Laden der Datei passiert.
 * Wenn scopeName gesetzt ist, wird der Ablauf dieses Scopes (z.B. Funktion)
 * geliefert. Sortiert nach order_index — der Reihenfolge im Quelltext.
 */
export async function getExecutionFlow(
  project: string,
  filePath: string,
  scopeName?: string
): Promise<ExecutionFlowResult> {
  const pool = getPool();
  const params: unknown[] = [project, `%${filePath}%`];
  let scopeCond: string;
  if (scopeName) {
    params.push(scopeName);
    scopeCond = `scope_name = $${params.length}`;
  } else {
    // Top-Level-Ausfuehrung der Datei
    scopeCond = `is_top_level = true`;
  }

  const result = await pool.query(
    `SELECT id, file_path, scope_type, scope_name, statement_type, node_kind,
            line_start, line_end, order_index, depth, parent_statement_id,
            text, callee, receiver, assigned_to, condition_text,
            is_top_level, is_awaited
       FROM code_statements
      WHERE project = $1 AND file_path LIKE $2 AND ${scopeCond} AND depth = 0
      ORDER BY order_index, line_start`,
    params
  );

  const statements: StatementInfo[] = result.rows.map(row => ({
    id: String(row.id),
    file_path: row.file_path,
    scope_type: row.scope_type,
    scope_name: row.scope_name,
    statement_type: row.statement_type,
    node_kind: row.node_kind,
    line_start: row.line_start,
    line_end: row.line_end,
    order_index: row.order_index,
    depth: row.depth,
    parent_statement_id: row.parent_statement_id != null ? String(row.parent_statement_id) : null,
    text: row.text,
    callee: row.callee,
    receiver: row.receiver,
    assigned_to: row.assigned_to,
    condition_text: row.condition_text,
    is_top_level: row.is_top_level,
    is_awaited: row.is_awaited,
  }));

  return {
    file_path: statements[0]?.file_path ?? filePath,
    scope_name: scopeName ?? null,
    statements,
  };
}

export interface EntrypointInfo {
  file_path: string;
  line_start: number;
  order_index: number;
  statement_type: string;
  is_awaited: boolean;
  callee: string | null;
  text: string | null;
}

/**
 * Liefert projektweit alle Top-Level (Modul-Scope, depth 0) ausfuehrbaren
 * Statements — die "Entrypoints", also was beim Importieren/Ausfuehren der
 * jeweiligen Datei passiert.
 *
 * Default (includeDeclarations=false): reine Deklarations-/Re-Export-Statements
 * ("export interface/type/declare", "export *", "export {...}"), SQL-Kommentare
 * und .sql-Dateien (Migrations) werden ausgefiltert — uebrig bleiben echte
 * Seiteneffekte wie main().catch(...), dotenvConfig() etc.
 * includeDeclarations=true stellt das alte ungefilterte Verhalten wieder her.
 */
export async function getEntrypoints(
  project: string,
  filePath?: string,
  limit: number = 200,
  includeDeclarations = false
): Promise<EntrypointInfo[]> {
  const pool = getPool();
  const params: unknown[] = [project];
  // Entrypoints = echte ausfuehrende Top-Level-Statements. KEINE Imports
  // (variable+text~"import"/"require"), KEINE reine Typ-Deklarationen.
  // Behalten: call, await, expression, new, throw, return-at-top-level.
  const conditions: string[] = [
    'project = $1',
    'is_top_level = true',
    'depth = 0',
    `statement_type IN ('call','await','expression','new','if','for','while','switch','try','throw')`,
    `(text IS NULL OR (text NOT LIKE 'import %' AND text NOT LIKE 'interface %' AND text NOT LIKE 'type %' AND text NOT LIKE 'const enum %' AND text NOT LIKE 'declare %'))`,
  ];

  if (!includeDeclarations) {
    // BUGFIX 2026-06-12 (Koordinator3): Die indizierten Texte beginnen real mit
    // "export ..." — die alten NOT-LIKE-Filter ('interface %', 'type %') griffen
    // dadurch nie und entrypoints lieferte hunderte Deklarations-Zeilen.
    // Zusaetzlich: SQL-Migrations sind keine Runtime-Entrypoints des Projekts.
    conditions.push(
      `(text IS NULL OR (text NOT LIKE 'export interface %' AND text NOT LIKE 'export type %' AND text NOT LIKE 'export declare %' AND text NOT LIKE 'export * %' AND text NOT LIKE 'export {%' AND text NOT LIKE '--%'))`,
      `file_path NOT LIKE '%.sql'`,
      `(text IS NOT NULL AND btrim(text) <> '')`
    );
  }

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`file_path LIKE $${params.length}`);
  }
  params.push(limit);

  const result = await pool.query(
    `SELECT file_path, line_start, order_index, statement_type, is_awaited, callee, text
       FROM code_statements
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path, order_index, line_start
      LIMIT $${params.length}`,
    params
  );

  return result.rows.map(row => ({
    file_path: row.file_path,
    line_start: row.line_start,
    order_index: row.order_index,
    statement_type: row.statement_type,
    is_awaited: row.is_awaited,
    callee: row.callee,
    text: row.text,
  }));
}
