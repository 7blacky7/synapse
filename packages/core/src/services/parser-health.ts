/**
 * MODUL: Parser-Gesundheit
 * ZWECK: Beantwortet zwei Fragen, die der Index bisher nicht beantworten konnte:
 *        "Was ist mit DIESER Datei los?" und "Wo klemmt es ueberhaupt?"
 *
 * WARUM ES DAS GIBT:
 * synapse-mega-html-benchmark/index.html stand mit 100.001 Zeilen im Index und
 * meldete functions=0, variables=0, statements=0. Von aussen ist das nicht davon
 * zu unterscheiden, dass in der Datei einfach nichts drin ist. Die Suche danach
 * kostete Stunden: erst wurde ein Groessenlimit vermutet, dann Regex-Backtracking
 * gemessen, am Ende lag es daran, dass eingebettetes JavaScript nur als Text
 * behandelt wurde. Mit diesem Modul waere der erste Aufruf gewesen:
 * "HTML-Parser, 100.001 Zeilen, 0 functions" — und die Suche haette dort begonnen,
 * wo der Fehler war.
 *
 * ⚠️ DIE WICHTIGSTE REGEL DIESES MODULS
 * Ein Vergleich gegen den eigenen Durchschnitt findet Ausreisser, aber NIEMALS
 * einen flaechendeckenden Ausfall. Als der HTML-Parser bei JEDER html-Datei 0
 * functions lieferte, war der Median selbst 0 — kein einziger Ausreisser, und
 * trotzdem alles kaputt. Deshalb steht neben jeder relativen Bewertung immer ein
 * ABSOLUTER Anker ("Datei ueber N Zeilen ohne eine einzige Funktion"), der ohne
 * Vergleichsgruppe auskommt.
 *
 * KOSTEN: Alle Zahlen kommen aus vorhandenen Indizes (code_symbols,
 * code_statements). Es wird nichts neu geparst und nichts pro Treffer gerechnet.
 */

import { getPool } from '../db/client.js';
import { getParserForFile, getSupportedExtensions } from '../parser/index.js';

/** Symboltypen, die reinen Text darstellen und keinen erkannten Code. */
const TEXT_TYPEN = new Set(['string', 'comment']);

/**
 * Ab dieser Zeilenzahl gilt eine Datei als gross genug, dass "keine einzige
 * Funktion" ein Befund ist und nicht einfach eine kurze Datei.
 */
const MIN_ZEILEN_FUER_BEFUND = 200;

/** Unter dieser Zeilenabdeckung ist eine grosse Datei auffaellig (in Prozent). */
const MIN_DECKUNG_PROZENT = 5;

export interface ParserGesundheitDatei {
  project: string;
  file_path: string;
  file_type: string | null;
  /** Sprache des zustaendigen Parsers, null wenn keiner zustaendig ist. */
  parser: string | null;
  /** Mit welcher Parser-Version der gespeicherte Stand erzeugt wurde. */
  parser_version: number | null;
  /** Version, die der zustaendige Parser heute hat. */
  parser_version_aktuell: number | null;
  /** true, wenn der gespeicherte Stand aelter ist als der heutige Parser. */
  veraltet: boolean;
  datei_bytes: number | null;
  zeilen_gesamt: number;
  symbole: {
    gesamt: number;
    funktionen: number;
    klassen: number;
    variablen: number;
    imports: number;
    /** strings + comments — reiner Text, kein erkannter Code. */
    text: number;
  };
  statements: number;
  call_edges: number;
  referenzen: number;
  /** Zeilen, in denen mindestens ein Symbol oder Statement BEGINNT. */
  belegte_zeilen: number;
  deckung_prozent: number;
  geparst_am: string | null;
  embedded: boolean;
  /** Offener Eintrag aus parse_failures, falls vorhanden. */
  letzter_ausfall: { grund: string; details: string | null; am: string } | null;
  /** Klartext-Begruendungen. Leer = unauffaellig. */
  befund: string[];
}

/** Tausenderpunkte, damit grosse Zahlen im Befundtext lesbar bleiben. */
function fmt(n: number): string {
  return n.toLocaleString('de-DE');
}

/**
 * Diagnose fuer EINE Datei. Braucht die Telemetrie-Tabelle nicht — alle Zahlen
 * werden live aus den vorhandenen Indizes aggregiert, was fuer eine einzelne
 * Datei ein indizierter Zugriff ist.
 */
export async function getParserGesundheitDatei(
  project: string,
  filePath: string
): Promise<ParserGesundheitDatei | null> {
  const pool = getPool();

  // Zeilen werden in der Datenbank gezaehlt, damit der Inhalt nicht uebertragen
  // werden muss — bei einer 7-MB-Datei waere das sonst 7 MB fuer eine Zahl.
  const dateiRes = await pool.query(
    `SELECT file_type, file_size, parser_version, parsed_at, indexed_at,
            (length(content) - length(replace(content, E'\n', ''))) + 1 AS zeilen_gesamt
       FROM code_files
      WHERE project = $1 AND file_path = $2`,
    [project, filePath]
  );
  if (dateiRes.rows.length === 0) return null;
  const datei = dateiRes.rows[0];

  const [symRes, stmtRes, belegtRes, kantenRes, refRes] = await Promise.all([
    pool.query(
      `SELECT symbol_type, count(*)::int AS n
         FROM code_symbols WHERE project = $1 AND file_path = $2 GROUP BY symbol_type`,
      [project, filePath]
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM code_statements WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT line_start FROM code_symbols    WHERE project = $1 AND file_path = $2
         UNION
         SELECT line_start FROM code_statements WHERE project = $1 AND file_path = $2
       ) AS belegte`,
      [project, filePath]
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM code_call_edges WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM code_references WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    ),
  ]);

  let gesamt = 0, funktionen = 0, klassen = 0, variablen = 0, imports = 0, text = 0;
  for (const r of symRes.rows) {
    const n: number = r.n;
    gesamt += n;
    if (r.symbol_type === 'function') funktionen += n;
    else if (r.symbol_type === 'class' || r.symbol_type === 'interface' || r.symbol_type === 'struct') klassen += n;
    else if (r.symbol_type === 'variable' || r.symbol_type === 'const_object') variablen += n;
    else if (r.symbol_type === 'import') imports += n;
    if (TEXT_TYPEN.has(r.symbol_type)) text += n;
  }

  const statements: number = stmtRes.rows[0].n;
  const belegte: number = belegtRes.rows[0].n;
  const zeilen: number = Number(datei.zeilen_gesamt) || 0;

  const parser = getParserForFile(filePath);
  const versionAktuell = parser ? (parser.version ?? 1) : null;
  const versionGespeichert: number | null = datei.parser_version;
  const veraltet =
    parser !== null &&
    versionAktuell !== null &&
    (versionGespeichert === null || versionGespeichert < versionAktuell);

  const ausfall = await ladeAusfall(pool, project, filePath);

  const ergebnis: ParserGesundheitDatei = {
    project,
    file_path: filePath,
    file_type: datei.file_type ?? null,
    parser: parser?.language ?? null,
    parser_version: versionGespeichert,
    parser_version_aktuell: versionAktuell,
    veraltet,
    datei_bytes: datei.file_size ?? null,
    zeilen_gesamt: zeilen,
    symbole: { gesamt, funktionen, klassen, variablen, imports, text },
    statements,
    call_edges: kantenRes.rows[0].n,
    referenzen: refRes.rows[0].n,
    belegte_zeilen: belegte,
    deckung_prozent: zeilen > 0 ? Math.round((belegte / zeilen) * 1000) / 10 : 0,
    geparst_am: datei.parsed_at ? new Date(datei.parsed_at).toISOString() : null,
    embedded: datei.indexed_at !== null,
    letzter_ausfall: ausfall,
    befund: [],
  };

  ergebnis.befund = erzeugeBefund(ergebnis);
  return ergebnis;
}

/**
 * Offener Ausfall-Eintrag. parse_failures wird erst beim ersten Ausfall angelegt,
 * darf hier also fehlen — ein fehlendes Protokoll ist kein Fehler.
 */
async function ladeAusfall(
  pool: ReturnType<typeof getPool>,
  project: string,
  filePath: string
): Promise<{ grund: string; details: string | null; am: string } | null> {
  try {
    const da = await pool.query(`SELECT to_regclass('public.parse_failures') AS t`);
    if (!da.rows[0]?.t) return null;
    const r = await pool.query(
      `SELECT grund, details, aufgetreten_am FROM parse_failures
        WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    );
    if (r.rows.length === 0) return null;
    return {
      grund: r.rows[0].grund,
      details: r.rows[0].details ?? null,
      am: new Date(r.rows[0].aufgetreten_am).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Uebersetzt die Kennzahlen in lesbare Saetze. Bewusst KEIN blosses Flag: wer
 * nur "auffaellig: true" liest, weiss nicht, ob er lokal nachsehen muss. Und ein
 * gespeicherter Schwellwert veraltet still — genau der Fehlertyp, den dieses
 * Modul aufdecken soll. Deshalb entsteht die Bewertung bei jeder Abfrage neu.
 *
 * ALLE REGELN HIER SIND ABSOLUT und kommen ohne Vergleichsgruppe aus. Das ist
 * Absicht: ein Parser, der flaechendeckend versagt, verschiebt seinen eigenen
 * Median mit und wuerde relativ nie auffallen.
 */
function erzeugeBefund(d: ParserGesundheitDatei): string[] {
  const befund: string[] = [];

  if (d.parser === null) {
    // Keine Beanstandung: fuer diese Endung ist gar kein Parser zustaendig.
    befund.push(`Kein Parser fuer diese Endung zustaendig — 0 Symbole sind hier normal.`);
    return befund;
  }

  if (d.letzter_ausfall) {
    befund.push(
      `Letzter Parse ist fehlgeschlagen (${d.letzter_ausfall.grund}` +
        `${d.letzter_ausfall.details ? `: ${d.letzter_ausfall.details}` : ''}) am ` +
        `${d.letzter_ausfall.am.slice(0, 10)}.`
    );
  }

  if (d.geparst_am === null) {
    befund.push(`Noch nicht geparst — die Datei steht im Backlog.`);
  }

  // TOTALAUSFALL: nicht eine einzige Zeile ist belegt.
  //
  // ⚠️ HIER STAND URSPRUENGLICH "0 functions und 0 statements". Das war falsch und
  // erzeugte Fehlalarme: CSS, Markdown, YAML und Markup haben konstruktiv keine
  // Funktionen. graph.css (271 Zeilen) wurde so als kaputt gemeldet, obwohl der
  // CSS-Parser sauber 62 Selektoren geliefert hatte. Ein Melder, der staendig
  // Unsinn meldet, wird ignoriert — und ist damit schlimmer als keiner.
  // Gezaehlt wird deshalb, ob UEBERHAUPT etwas erkannt wurde, nicht ob es
  // ausgerechnet Funktionen waren.
  if (d.zeilen_gesamt >= MIN_ZEILEN_FUER_BEFUND && d.belegte_zeilen === 0) {
    befund.push(
      `${fmt(d.zeilen_gesamt)} Zeilen, aber nichts erkannt — kein Symbol, kein Statement, ` +
        `keine belegte Zeile.`
    );
  }

  // Genau der Zustand der llama-Benchmark-HTML: viele Symbole, aber nur Text.
  if (d.symbole.gesamt > 0 && d.symbole.text === d.symbole.gesamt && d.zeilen_gesamt >= MIN_ZEILEN_FUER_BEFUND) {
    befund.push(
      `Alle ${fmt(d.symbole.gesamt)} Symbole sind Text (string/comment) — ` +
        `kein einziges Code-Symbol. Typisch fuer einen Parser, der die Datei nur ` +
        `in Woerter zerlegt statt sie zu verstehen.`
    );
  }

  // Symbolerkennung faellt aus, Ablauf-Ebene laeuft: zwei getrennte Wege im Parser.
  // Mindestgroesse, weil ein Einzeiler-Skript voellig zu Recht 0 Symbole und ein
  // Statement hat — drei solche .sh-Dateien mit je einer Zeile standen sonst in
  // der Liste der Auffaelligkeiten.
  if (d.symbole.gesamt === 0 && d.statements > 0 && d.zeilen_gesamt >= MIN_ZEILEN_FUER_BEFUND) {
    befund.push(
      `0 Symbole, aber ${fmt(d.statements)} Statements — die Symbolerkennung faellt aus, ` +
        `waehrend die Ablauf-Ebene liefert.`
    );
  }

  if (
    d.zeilen_gesamt >= MIN_ZEILEN_FUER_BEFUND &&
    d.deckung_prozent < MIN_DECKUNG_PROZENT &&
    d.belegte_zeilen > 0
  ) {
    befund.push(
      `Nur ${d.deckung_prozent} % der Zeilen sind belegt ` +
        `(${fmt(d.belegte_zeilen)} von ${fmt(d.zeilen_gesamt)}).`
    );
  }

  if (d.veraltet) {
    // HIER STAND BIS 29fbe29: "wird derzeit NICHT automatisch nachgezogen" fuer den
    // NULL-Fall. Das stimmte, solange der Backlog parser_version NULL ausschloss.
    // Seit dem Nachzieh-Fix zaehlt NULL mit — getVersionierteExtensions() liefert nur
    // Endungen mit Version ueber 1, ein NULL dort ist also ein Beweis fuer einen alten
    // Stand und kein Unbekanntes. Der einzige verbliebene Grund, aus dem eine faellige
    // Datei liegen bleibt, ist ein in der Registry deaktiviertes Projekt.
    befund.push(
      (d.parser_version === null
        ? `Parse-Stand ohne Versionsangabe, aktuell ist Version ${d.parser_version_aktuell}`
        : `Geparst mit Parser-Version ${d.parser_version}, aktuell ist ${d.parser_version_aktuell}`) +
        ` — faellig fuer den Nachzug, sofern das Projekt in der Registry aktiviert ist.`
    );
  }

  if (!d.embedded) {
    befund.push(`Embedding steht noch aus — die semantische Suche findet diese Datei nicht.`);
  }

  return befund;
}


// ===========================================================================
// PROJEKT-UEBERSICHT: "Wo klemmt es ueberhaupt?"
// ===========================================================================

/** Ein auffaelliger Einzelfall in der Uebersicht. Bewusst schmal gehalten. */
export interface ParserUebersichtDatei {
  file_path: string;
  parser: string | null;
  zeilen_gesamt: number;
  funktionen: number;
  statements: number;
  deckung_prozent: number;
  /** Der wichtigste Grund. Details liefert health mit file_path. */
  befund: string;
}

/**
 * Befund ueber ALLE Dateien eines Parsers hinweg.
 *
 * ⚠️ DAS IST DER WICHTIGE TEIL. Eine datei-weise Bewertung findet nur
 * Ausreisser. Als der HTML-Parser bei JEDER html-Datei 0 functions lieferte,
 * gab es keinen Ausreisser — der Durchschnitt war selbst 0. Erst die Summe
 * ueber den gesamten Parser macht einen flaechendeckenden Ausfall sichtbar.
 */
export interface ParserBefundGesamt {
  parser: string;
  dateien: number;
  zeilen_gesamt: number;
  funktionen_gesamt: number;
  statements_gesamt: number;
  symbole_gesamt: number;
  text_symbole_gesamt: number;
  befund: string[];
}

export interface ParserGesundheitUebersicht {
  project: string;
  erfasste_dateien: number;
  telemetrie_stand: string | null;
  /** Parser-weite Befunde — zuerst lesen, sie wiegen schwerer als Einzelfaelle. */
  parser_befunde: ParserBefundGesamt[];
  /** Auffaellige Einzeldateien, groesste zuerst. */
  dateien: ParserUebersichtDatei[];
  hinweis?: string;
}

/** Ab dieser Gesamtzeilenzahl je Parser ist "nichts erkannt" ein Befund. */
const MIN_ZEILEN_PARSER_BEFUND = 1000;

/**
 * Endung -> Sprache + heutige Version, abgeleitet aus der Parser-Registry.
 * Bewusst ueber getParserForFile statt ueber eine eigene Liste: so bleibt die
 * Registry die einzige Quelle der Wahrheit, inklusive ihrer Sonderfaelle.
 */
function extensionMap(): Array<{ ext: string; language: string; version: number }> {
  const raus: Array<{ ext: string; language: string; version: number }> = [];
  const gesehen = new Set<string>();
  for (const ext of getSupportedExtensions()) {
    const ohnePunkt = (ext.startsWith('.') ? ext.slice(1) : ext).toLowerCase();
    if (gesehen.has(ohnePunkt)) continue;
    const parser = getParserForFile(`datei.${ohnePunkt}`);
    if (!parser) continue;
    gesehen.add(ohnePunkt);
    raus.push({ ext: ohnePunkt, language: parser.language, version: parser.version ?? 1 });
  }
  return raus;
}

/**
 * Fuellt parse_coverage aus den bereits vorhandenen Daten.
 *
 * WARUM DAS SEIN MUSS: Die Tabelle fuellt sich sonst nur bei NEUEN Parse-
 * Vorgaengen. Die Altfaelle, die wir suchen, werden aber gerade NICHT mehr
 * geparst — die llama-Benchmark-HTML steht seit Monaten unveraendert im Index.
 * Ohne Backfill zeigte die Uebersicht ausgerechnet die Faelle nicht, fuer die
 * sie gebaut wurde, und niemand wuerde ihr mehr trauen.
 *
 * KOSTEN: ein INSERT..SELECT, kein Reparse. Die Zeilen werden in der Datenbank
 * gezaehlt, nicht geschaetzt und nicht von der Platte gelesen — der Inhalt liegt
 * ohnehin in code_files. Gemessen: 6,2 s fuer 11.223 Dateien (326 MB, 4,1 Mio
 * Zeilen). Eine Schaetzung ueber die Dateigroesse waere billiger gewesen, aber
 * nicht schneller genug, um die Ungenauigkeit zu rechtfertigen.
 */
export async function backfillParserCoverage(
  project?: string
): Promise<{ project: string | null; zeilen: number; dauer_ms: number }> {
  const pool = getPool();
  const t0 = Date.now();
  const map = extensionMap();

  const params: unknown[] = [
    map.map(m => m.ext),
    map.map(m => m.language),
  ];
  let projektFilter = '';
  if (project) {
    params.push(project);
    projektFilter = `AND cf.project = $${params.length}`;
  }

  const res = await pool.query(
    `INSERT INTO parse_coverage (
       project, file_path, file_type, parser, parser_version, datei_bytes,
       zeilen_gesamt, belegte_zeilen, n_symbole, n_funktionen, n_klassen,
       n_variablen, n_imports, n_text_symbole, n_statements, n_call_edges, gemessen_am)
     SELECT cf.project, cf.file_path, cf.file_type, pm.language, cf.parser_version, cf.file_size,
            (length(cf.content) - length(replace(cf.content, E'\n', ''))) + 1,
            COALESCE(bel.n, 0),
            COALESCE(sym.gesamt, 0), COALESCE(sym.fn, 0), COALESCE(sym.klassen, 0),
            COALESCE(sym.variablen, 0), COALESCE(sym.imports, 0), COALESCE(sym.text, 0),
            COALESCE(st.n, 0), COALESCE(ce.n, 0), NOW()
       FROM code_files cf
       LEFT JOIN unnest($1::text[], $2::text[]) AS pm(ext, language)
              ON pm.ext = lower(reverse(split_part(reverse(cf.file_path), '.', 1)))
       LEFT JOIN LATERAL (
              SELECT count(*)::int AS gesamt,
                     count(*) FILTER (WHERE s.symbol_type = 'function')::int AS fn,
                     count(*) FILTER (WHERE s.symbol_type IN ('class','interface','struct'))::int AS klassen,
                     count(*) FILTER (WHERE s.symbol_type IN ('variable','const_object'))::int AS variablen,
                     count(*) FILTER (WHERE s.symbol_type = 'import')::int AS imports,
                     count(*) FILTER (WHERE s.symbol_type IN ('string','comment'))::int AS text
                FROM code_symbols s
               WHERE s.project = cf.project AND s.file_path = cf.file_path) AS sym ON TRUE
       LEFT JOIN LATERAL (
              SELECT count(*)::int AS n FROM code_statements t
               WHERE t.project = cf.project AND t.file_path = cf.file_path) AS st ON TRUE
       LEFT JOIN LATERAL (
              SELECT count(*)::int AS n FROM code_call_edges c
               WHERE c.project = cf.project AND c.file_path = cf.file_path) AS ce ON TRUE
       LEFT JOIN LATERAL (
              SELECT count(*)::int AS n FROM (
                     SELECT line_start FROM code_symbols s2
                      WHERE s2.project = cf.project AND s2.file_path = cf.file_path
                     UNION
                     SELECT line_start FROM code_statements t2
                      WHERE t2.project = cf.project AND t2.file_path = cf.file_path) AS u) AS bel ON TRUE
      WHERE cf.content IS NOT NULL ${projektFilter}
     ON CONFLICT (project, file_path) DO UPDATE SET
       file_type = EXCLUDED.file_type, parser = EXCLUDED.parser,
       parser_version = EXCLUDED.parser_version, datei_bytes = EXCLUDED.datei_bytes,
       zeilen_gesamt = EXCLUDED.zeilen_gesamt, belegte_zeilen = EXCLUDED.belegte_zeilen,
       n_symbole = EXCLUDED.n_symbole, n_funktionen = EXCLUDED.n_funktionen,
       n_klassen = EXCLUDED.n_klassen, n_variablen = EXCLUDED.n_variablen,
       n_imports = EXCLUDED.n_imports, n_text_symbole = EXCLUDED.n_text_symbole,
       n_statements = EXCLUDED.n_statements, n_call_edges = EXCLUDED.n_call_edges,
       gemessen_am = NOW()`,
    params
  );

  return { project: project ?? null, zeilen: res.rowCount ?? 0, dauer_ms: Date.now() - t0 };
}

/**
 * Projekt-Uebersicht: erst die parser-weiten Befunde, dann die auffaelligen
 * Einzeldateien. Die Antwort bleibt klein — nur Kennzahlen und je ein Satz.
 */
export async function getParserGesundheitUebersicht(
  project: string,
  optionen?: { limit?: number; parser?: string }
): Promise<ParserGesundheitUebersicht> {
  const pool = getPool();
  // Harte Obergrenze im SQL, nicht erst beim Mappen: ein fehlendes Limit hat hier
  // schon einmal 1,75 MB Antwort erzeugt (siehe getSymbols in code-intel.ts).
  const limit = Math.min(Math.max(optionen?.limit ?? 20, 1), 100);

  const da = await pool.query(`SELECT to_regclass('public.parse_coverage') AS t`);
  if (!da.rows[0]?.t) {
    return {
      project, erfasste_dateien: 0, telemetrie_stand: null,
      parser_befunde: [], dateien: [],
      hinweis: 'Tabelle parse_coverage existiert noch nicht — ensureSchema ausfuehren.',
    };
  }

  const params: unknown[] = [project];
  let parserFilter = '';
  if (optionen?.parser) {
    params.push(optionen.parser);
    parserFilter = `AND parser = $${params.length}`;
  }

  const [standRes, parserRes, dateiRes] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS n, max(gemessen_am) AS stand FROM parse_coverage WHERE project = $1`,
      [project]
    ),
    pool.query(
      `SELECT parser, file_type, count(*)::int AS dateien,
              COALESCE(sum(zeilen_gesamt), 0)::bigint AS zeilen,
              COALESCE(sum(n_funktionen), 0)::bigint AS fn,
              COALESCE(sum(n_statements), 0)::bigint AS stmt,
              COALESCE(sum(n_symbole), 0)::bigint AS sym,
              COALESCE(sum(n_text_symbole), 0)::bigint AS text
         FROM parse_coverage
        WHERE project = $1 AND parser IS NOT NULL ${parserFilter}
        GROUP BY parser, file_type`,
      params
    ),
    pool.query(
      `SELECT file_path, parser, zeilen_gesamt, belegte_zeilen, n_symbole,
              n_funktionen, n_text_symbole, n_statements
         FROM parse_coverage
        WHERE project = $1 AND parser IS NOT NULL ${parserFilter}
          AND ( (zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND} AND belegte_zeilen = 0)
             OR (n_symbole > 0 AND n_text_symbole = n_symbole AND zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND})
             OR (n_symbole = 0 AND n_statements > 0 AND zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND})
             OR (zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND} AND belegte_zeilen > 0
                 AND belegte_zeilen * 100 < zeilen_gesamt * ${MIN_DECKUNG_PROZENT}) )
        ORDER BY zeilen_gesamt DESC
        LIMIT ${limit}`,
      params
    ),
  ]);

  return {
    project,
    erfasste_dateien: standRes.rows[0].n,
    telemetrie_stand: standRes.rows[0].stand ? new Date(standRes.rows[0].stand).toISOString() : null,
    parser_befunde: bewerteParser(parserRes.rows),
    dateien: dateiRes.rows.map(mappeUebersichtDatei),
  };
}

interface ParserZeile {
  parser: string;
  file_type: string | null;
  dateien: number;
  zeilen: string;
  fn: string;
  stmt: string;
  sym: string;
  text: string;
}

/**
 * Fasst die Zeilen je Parser zusammen und prueft ABSOLUTE Anker.
 * Kein Vergleich gegen einen Durchschnitt — siehe Modulkopf.
 */
function bewerteParser(zeilen: ParserZeile[]): ParserBefundGesamt[] {
  const jeParser = new Map<string, { g: ParserBefundGesamt; typen: Map<string, { fn: number; dateien: number }> }>();

  for (const z of zeilen) {
    let eintrag = jeParser.get(z.parser);
    if (!eintrag) {
      eintrag = {
        g: {
          parser: z.parser, dateien: 0, zeilen_gesamt: 0, funktionen_gesamt: 0,
          statements_gesamt: 0, symbole_gesamt: 0, text_symbole_gesamt: 0, befund: [],
        },
        typen: new Map(),
      };
      jeParser.set(z.parser, eintrag);
    }
    const fn = Number(z.fn);
    eintrag.g.dateien += z.dateien;
    eintrag.g.zeilen_gesamt += Number(z.zeilen);
    eintrag.g.funktionen_gesamt += fn;
    eintrag.g.statements_gesamt += Number(z.stmt);
    eintrag.g.symbole_gesamt += Number(z.sym);
    eintrag.g.text_symbole_gesamt += Number(z.text);
    eintrag.typen.set(z.file_type ?? '?', { fn, dateien: z.dateien });
  }

  const raus: ParserBefundGesamt[] = [];
  for (const { g, typen } of jeParser.values()) {
    // DER FALL, DER RELATIV NIE AUFFAELLT: alles kaputt, also nichts auffaellig.
    // Gemessen wird "gar nichts erkannt", nicht "keine Funktionen" — sonst waeren
    // reine Markup- und Stylesheet-Parser dauerhaft falsch beschuldigt.
    if (g.symbole_gesamt === 0 && g.statements_gesamt === 0 && g.zeilen_gesamt >= MIN_ZEILEN_PARSER_BEFUND) {
      g.befund.push(
        `FLAECHENDECKEND: ueber alle ${fmt(g.dateien)} Dateien (${fmt(g.zeilen_gesamt)} Zeilen) ` +
          `liefert dieser Parser ueberhaupt nichts — kein Symbol, kein Statement. ` +
          `Kein Einzelfall, der Parser selbst greift nicht.`
      );
    }

    // Auch das ist ein flaechendeckender Ausfall, nur ein subtilerer: der Parser
    // liefert etwas, aber nur Woerter. Genau dieser Zustand hat monatelang
    // niemandem auffallen koennen.
    if (g.symbole_gesamt > 0 && g.text_symbole_gesamt === g.symbole_gesamt && g.statements_gesamt === 0) {
      g.befund.push(
        `FLAECHENDECKEND: die gesamte Ausgabe ueber ${fmt(g.dateien)} Dateien besteht aus Text ` +
          `(${fmt(g.symbole_gesamt)} string/comment, kein einziges Code-Symbol, keine Statements) — ` +
          `der Parser zerlegt die Dateien nur in Woerter.`
      );
    }

    // Liefert bei einem Dateityp normal, bei einem anderen nie.
    if (typen.size > 1) {
      const leer = [...typen.entries()].filter(([, v]) => v.fn === 0).map(([t]) => t);
      const voll = [...typen.entries()].filter(([, v]) => v.fn > 0).map(([t]) => t);
      if (leer.length > 0 && voll.length > 0) {
        g.befund.push(
          `Liefert bei ${voll.join(', ')} Funktionen, bei ${leer.join(', ')} dagegen keine einzige — ` +
            `Verdacht auf eine Luecke fuer diese Endung.`
        );
      }
    }

    raus.push(g);
  }

  // Parser mit Befund zuerst, danach die groessten.
  raus.sort((a, b) => (b.befund.length - a.befund.length) || (b.zeilen_gesamt - a.zeilen_gesamt));
  return raus;
}

function mappeUebersichtDatei(r: {
  file_path: string; parser: string | null; zeilen_gesamt: number; belegte_zeilen: number;
  n_symbole: number; n_funktionen: number; n_text_symbole: number; n_statements: number;
}): ParserUebersichtDatei {
  const deckung = r.zeilen_gesamt > 0
    ? Math.round((r.belegte_zeilen / r.zeilen_gesamt) * 1000) / 10
    : 0;

  let befund: string;
  if (r.belegte_zeilen === 0) {
    befund = `${fmt(r.zeilen_gesamt)} Zeilen, aber nichts erkannt.`;
  } else if (r.n_symbole > 0 && r.n_text_symbole === r.n_symbole) {
    befund = `Alle ${fmt(r.n_symbole)} Symbole sind Text — kein Code-Symbol.`;
  } else if (r.n_symbole === 0 && r.n_statements > 0) {
    befund = `0 Symbole, aber ${fmt(r.n_statements)} Statements — Symbolerkennung faellt aus.`;
  } else {
    befund = `Nur ${deckung} % der Zeilen belegt.`;
  }

  return {
    file_path: r.file_path,
    parser: r.parser,
    zeilen_gesamt: r.zeilen_gesamt,
    funktionen: r.n_funktionen,
    statements: r.n_statements,
    deckung_prozent: deckung,
    befund,
  };
}


// ===========================================================================
// SCHREIBPFAD: bei jedem Parse fortschreiben
// ===========================================================================

/**
 * Schreibt die Coverage-Kennzahlen einer gerade geparsten Datei fort.
 *
 * ⚠️ KOSTEN — DIE WICHTIGSTE EIGENSCHAFT DIESER FUNKTION:
 * Alles hier ist O(Symbole + Statements + Dateilaenge), jeweils EIN Durchlauf.
 * Es wird nichts pro Treffer gesucht und nichts pro Treffer gezaehlt. Der Anlass
 * fuer diese Vorsicht ist real: eine Zeilenberechnung, die pro Treffer ab
 * Position 0 durchzaehlte, liess eine 7-MB-Datei ueber 45 Minuten laufen.
 *
 * BEWUSST NICHT erstelleZeilenIndex(): die Funktion ist zwar ebenfalls O(n),
 * legt aber ein Array mit einer Zahl je Zeile an (bei index.html 100.001
 * Eintraege), das hier niemand braucht. Wo ein Symbol liegt, WEISS der Parser
 * bereits — line_start ist gesetzt, es wird keine Position neu berechnet.
 *
 * Fehler werden geschluckt: Telemetrie darf einen Indexlauf niemals stoppen.
 */
export async function schreibeParserCoverage(
  project: string,
  filePath: string,
  fileType: string | null,
  parser: { language: string; version?: number },
  ergebnis: {
    symbols: Array<{ symbol_type: string; line_start: number }>;
    statements?: Array<{ line_start: number }>;
    callEdges?: unknown[];
  },
  content: string,
  dauerMs?: number
): Promise<void> {
  try {
    const belegte = new Set<number>();
    let gesamt = 0, funktionen = 0, klassen = 0, variablen = 0, imports = 0, text = 0;

    for (const s of ergebnis.symbols) {
      gesamt++;
      belegte.add(s.line_start);
      switch (s.symbol_type) {
        case 'function': funktionen++; break;
        case 'class': case 'interface': case 'struct': klassen++; break;
        case 'variable': case 'const_object': variablen++; break;
        case 'import': imports++; break;
      }
      if (TEXT_TYPEN.has(s.symbol_type)) text++;
    }

    const statements = ergebnis.statements ?? [];
    for (const st of statements) belegte.add(st.line_start);

    // Zeilen zaehlen: ein Durchlauf, kein Zwischenspeicher.
    let zeilen = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) zeilen++;
    }

    await getPool().query(
      `INSERT INTO parse_coverage (
         project, file_path, file_type, parser, parser_version, datei_bytes,
         zeilen_gesamt, belegte_zeilen, n_symbole, n_funktionen, n_klassen,
         n_variablen, n_imports, n_text_symbole, n_statements, n_call_edges,
         dauer_ms, gemessen_am)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       ON CONFLICT (project, file_path) DO UPDATE SET
         file_type = EXCLUDED.file_type, parser = EXCLUDED.parser,
         parser_version = EXCLUDED.parser_version, datei_bytes = EXCLUDED.datei_bytes,
         zeilen_gesamt = EXCLUDED.zeilen_gesamt, belegte_zeilen = EXCLUDED.belegte_zeilen,
         n_symbole = EXCLUDED.n_symbole, n_funktionen = EXCLUDED.n_funktionen,
         n_klassen = EXCLUDED.n_klassen, n_variablen = EXCLUDED.n_variablen,
         n_imports = EXCLUDED.n_imports, n_text_symbole = EXCLUDED.n_text_symbole,
         n_statements = EXCLUDED.n_statements, n_call_edges = EXCLUDED.n_call_edges,
         dauer_ms = EXCLUDED.dauer_ms, gemessen_am = NOW()`,
      [
        project, filePath, fileType, parser.language, parser.version ?? 1,
        Buffer.byteLength(content, 'utf8'), zeilen, belegte.size, gesamt,
        funktionen, klassen, variablen, imports, text,
        statements.length, (ergebnis.callEdges ?? []).length, dauerMs ?? null,
      ]
    );
  } catch (err) {
    console.error(
      `[parser-health] Coverage nicht gespeichert (${project}/${filePath}):`,
      (err as Error).message
    );
  }
}
