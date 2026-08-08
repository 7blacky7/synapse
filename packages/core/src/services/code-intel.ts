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

  for (const row of filesResult.rows) {
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
      const kommentarAnzahl = loeseKommentarAnzahl(show_comments);
      if (kommentarAnzahl > 0) {
        // COUNT(*) OVER() zaehlt VOR dem LIMIT und liefert damit die echte Gesamtzahl
        // in derselben Abfrage — ohne zweiten Roundtrip je Datei.
        // Reihenfolge zaehlt: der OFFSET muss VOR dem optionalen Filter stehen,
        // damit dessen $-Nummer (ueber kommentarParams.length) weiter stimmt.
        const kommentarParams: unknown[] = [
          project,
          f.file_path,
          kommentarAnzahl,
          Math.max(0, Math.floor(comment_skip ?? 0)),
        ];
        let kommentarFilter = '';
        if (comment_contains) {
          kommentarParams.push(`%${comment_contains}%`);
          kommentarFilter = ` AND value ILIKE $${kommentarParams.length}`;
        }
        const commentResult = await pool.query(
          `SELECT value, line_start, COUNT(*) OVER() AS gesamt FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'comment'${kommentarFilter}
           ORDER BY line_start LIMIT $3 OFFSET $4`,
          kommentarParams
        );
        const ab = Math.max(0, Math.floor(comment_from ?? 0));
        const laenge = Math.max(1, Math.floor(comment_chars ?? 100));
        for (const zeileDb of commentResult.rows) {
          const voll = ersteZeileMitInhalt(zeileDb.value, comment_contains);
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
  lines.push(`${filesResult.rows.length} Dateien | Projekt: ${project}`);

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
  symbol_id: string;
  file_path: string;
  line_number: number;
  context: string | null;
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
  } | null;
  references: ReferenceInfo[];
  total_files: number;
  total_references: number;
  string_occurrences: StringOccurrenceInfo[];
  total_string_occurrences: number;
}

/**
 * Findet die Definition und alle Referenzen eines Symbols per Name.
 */
export async function getReferences(
  project: string,
  name: string
): Promise<ReferencesResult> {
  const pool = getPool();

  // Definition laden — non-string bevorzugen (echte Deklaration vor String-Literal)
  const defResult = await pool.query(
    `SELECT id, file_path, symbol_type, name, line_start, is_exported
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
      }
    : null;

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
  for (const row of callRows.rows) {
    const schluessel = `${row.file_path}:${row.line_number}`;
    if (bekannt.has(schluessel)) continue;
    bekannt.add(schluessel);
    const empfaenger = row.callee_receiver ? `${row.callee_receiver}.` : '';
    references.push({
      symbol_id: row.target_symbol_id ?? null,
      file_path: row.file_path,
      line_number: row.line_number,
      context: `${row.call_kind ?? 'call'}: ${empfaenger}${name}()`
        + (row.caller_scope ? ` in ${row.caller_scope}` : ''),
      kind: 'call' as const,
    });
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

  return {
    definition,
    references,
    total_files: uniqueFiles.size,
    total_references: references.length,
    string_occurrences: stringOccurrences,
    total_string_occurrences: stringOccurrences.length,
  };
}

// ─── fullTextSearchCode ───────────────────────────────────────────────────────

export interface FullTextSearchResult {
  file_path: string;
  file_type: string;
  headline: string;
  rank: number;
}

/**
 * Volltext-Suche in code_files via PostgreSQL tsvector.
 * Trennt Query-Woerter mit ' & ' fuer AND-Suche.
 * Gibt file_path, ts_headline und ts_rank zurueck.
 *
 * HINWEIS: Bewusst nicht "searchCode" (belegt durch code.ts — semantische Qdrant-Suche)
 */
export async function fullTextSearchCode(
  project: string,
  query: string,
  fileType?: string,
  limit: number = 20,
  filePath?: string
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

  const result = await pool.query(
    `SELECT
       file_path,
       file_type,
       ts_headline('english', content, plainto_tsquery('english', $2),
         'MaxWords=20, MinWords=5, ShortWord=3, HighlightAll=false,
          MaxFragments=2, FragmentDelimiter='' ... ''') AS headline,
       ts_rank(tsv, plainto_tsquery('english', $2)) AS rank
     FROM code_files
     WHERE project = $1
       AND NOT ignored
       AND tsv @@ plainto_tsquery('english', $2)
       ${typeFilter}
       ${pfadFilter}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map(row => ({
    file_path: row.file_path,
    file_type: row.file_type,
    headline: row.headline ?? '',
    rank: parseFloat(row.rank),
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

/**
 * Liefert Call-Edges der Ablauf-Ebene. Filterbar nach Datei und/oder
 * aufgerufenem Namen (callee_name). Sortiert nach Datei und Zeile.
 */
export async function getCallEdges(
  project: string,
  filePath?: string,
  calleeName?: string
): Promise<CallEdgeInfo[]> {
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

  const result = await pool.query(
    `SELECT id, file_path, caller_scope, statement_id, callee_name,
            callee_receiver, target_symbol_id, line_number, call_kind, confidence
       FROM code_call_edges
      WHERE ${conditions.join(' AND ')}
      ORDER BY file_path, line_number`,
    params
  );

  return result.rows.map(row => ({
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
