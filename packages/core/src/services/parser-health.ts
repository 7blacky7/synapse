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
import { getParserForFile, getSupportedExtensions, kenntAblaufEbene } from '../parser/index.js';

/** Symboltypen, die reinen Text darstellen und keinen erkannten Code. */
const TEXT_TYPEN = new Set(['string', 'comment']);

/**
 * Ab dieser Zeilenzahl gilt eine Datei als gross genug, dass "keine einzige
 * Funktion" ein Befund ist und nicht einfach eine kurze Datei.
 */
const MIN_ZEILEN_FUER_BEFUND = 200;

/** Unter dieser Zeilenabdeckung ist eine grosse Datei auffaellig (in Prozent). */
const MIN_DECKUNG_PROZENT = 5;

/**
 * Ab wie viel Material der Vergleich zweier Endungen desselben Parsers ueberhaupt
 * etwas aussagt. Eine der beiden Schwellen genuegt.
 *
 * WARUM ES DIESE GRENZE BRAUCHT: ohne sie meldete die Uebersicht fuer das Projekt
 * synapse "Liefert bei sh Funktionen, bei fish dagegen keine einzige — Verdacht auf
 * eine Luecke fuer diese Endung". Die Stichprobe bestand aus EINER .fish-Datei mit
 * 16 Zeilen, und die enthaelt nur set und alias, also konstruktiv keine Funktion.
 * Gegenprobe am Parser selbst: eine .fish-Datei mit zwei Funktionen liefert beide
 * (gruss, _intern) — es gibt keine Luecke.
 *
 * Ein Fehlalarm ist hier teurer als ein uebersehener Fall: dieses Modul existiert,
 * damit man seinen Befunden glaubt. Wer zweimal einer Warnung nachgeht, die aus
 * einer einzigen Datei stammt, liest die dritte nicht mehr.
 */
const MIN_DATEIEN_FUER_TYP_BEFUND = 3;
const MIN_ZEILEN_FUER_TYP_BEFUND = 200;

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
  /** Gespeicherter Parse-Stand liegt UEBER der aktuellen Parser-Version (siehe Befund). */
  version_aus_der_zukunft: boolean;
  /**
   * Zeitpunkt des Soft-Deletes, sonst null. Ohne dieses Feld diagnostizierte health
   * eine zum Loeschen vorgemerkte Datei wie eine lebende und sagte kein Wort dazu.
   */
  geloescht_am: string | null;
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
    `SELECT file_type, file_size, parser_version, parsed_at, indexed_at, deleted_at,
            (length(content) - length(replace(content, E'\n', ''))) + 1 AS zeilen_gesamt,
            -- Nur der Anfang: die Inhaltserkennung sieht ohnehin bloss die ersten
            -- Hundert Zeichen an, die ganze Datei zu laden waere hier Verschwendung.
            left(content, 2000) AS anfang
       FROM code_files
      WHERE project = $1 AND file_path = $2`,
    [project, filePath]
  );
  if (dateiRes.rows.length === 0) return null;
  const datei = dateiRes.rows[0];

  const [symRes, stmtRes, belegtRes, kantenRes, refRes, chunkRes] = await Promise.all([
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
         -- SPANNE statt Startzeile: ein Symbol von Zeile 1 bis 740 belegt 740
         -- Zeilen, nicht eine. Vorher galt preludeB.dhall deshalb als zu 2,4
         -- Prozent gedeckt. LEAST begrenzt auf die Datei, damit ein falsches
         -- line_end die Deckung nicht ueber 100 Prozent treibt; COALESCE faengt
         -- fehlendes line_end ab, dann zaehlt wie bisher die Startzeile.
         SELECT generate_series(line_start, LEAST(COALESCE(line_end, line_start), $3)) FROM code_symbols WHERE project = $1 AND file_path = $2
         UNION
         SELECT generate_series(line_start, LEAST(COALESCE(line_end, line_start), $3)) FROM code_statements WHERE project = $1 AND file_path = $2
       ) AS belegte`,
      // $3 begrenzt die Spanne auf die Dateilaenge — ohne diesen dritten Parameter
      // ist die Abfrage zur Laufzeit kaputt, und der Build sagt dazu nichts.
      [project, filePath, Number(datei.zeilen_gesamt) || 0]
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM code_call_edges WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM code_references WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    ),
    // Chunks ohne Vektor. Braucht es fuer das embedded-Feld: indexed_at allein
    // beantwortet die Frage nicht (siehe Kommentar dort).
    pool.query(
      `SELECT count(*)::int AS n FROM code_chunks
        WHERE project = $1 AND file_path = $2 AND embedded_at IS NULL`,
      [project, filePath]
    ),
  ]);
  const offeneChunks: number = chunkRes.rows[0].n;

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

  // Der Inhalt MUSS mit: seit der Inhaltserkennung findet getParserForFile auch
  // Dateien ohne Endung. Ohne ihn meldete health "Kein Parser fuer diese Endung
  // zustaendig" und wies im selben Objekt drei Symbole aus (gefunden an
  // dhall/Prelude/Bool/fold).
  const parser = getParserForFile(filePath, datei.anfang ?? undefined);
  const versionAktuell = parser ? (parser.version ?? 1) : null;
  const versionGespeichert: number | null = datei.parser_version;
  const veraltet =
    parser !== null &&
    versionAktuell !== null &&
    (versionGespeichert === null || versionGespeichert < versionAktuell);
  // Der umgekehrte Fall ist keine Kleinigkeit: ein GESPEICHERTER Stand ueber dem
  // aktuellen kann durch normales Parsen gar nicht entstehen. Er heisst, dass zwei
  // verschiedene Staende auf dieselbe Datenbank sehen — etwa ein lokal gebautes
  // dist und ein aelteres Container-Image. Bisher ging das als "nicht veraltet"
  // durch, und der Index sah aktuell aus.
  const versionAusDerZukunft =
    parser !== null &&
    versionAktuell !== null &&
    versionGespeichert !== null &&
    versionGespeichert > versionAktuell;

  const ausfall = await ladeAusfall(pool, project, filePath);

  const ergebnis: ParserGesundheitDatei = {
    project,
    file_path: filePath,
    file_type: datei.file_type ?? null,
    parser: parser?.language ?? null,
    parser_version: versionGespeichert,
    parser_version_aktuell: versionAktuell,
    veraltet,
    version_aus_der_zukunft: versionAusDerZukunft,
    geloescht_am: datei.deleted_at ? new Date(datei.deleted_at).toISOString() : null,
    datei_bytes: datei.file_size ?? null,
    zeilen_gesamt: zeilen,
    symbole: { gesamt, funktionen, klassen, variablen, imports, text },
    statements,
    call_edges: kantenRes.rows[0].n,
    referenzen: refRes.rows[0].n,
    belegte_zeilen: belegte,
    deckung_prozent: zeilen > 0 ? Math.round((belegte / zeilen) * 1000) / 10 : 0,
    geparst_am: datei.parsed_at ? new Date(datei.parsed_at).toISOString() : null,
    // NICHT indexed_at allein. Das Feld sagte bis zum 28.07.2026 "embedded: true",
    // sobald indexed_at gesetzt war — und drei Ausgaenge in parseAndEmbed setzen
    // genau das und kehren VOR dem Embed-Block zurueck (leere Datei, PARSER_MAX_BYTES,
    // kein Parser zustaendig). Fuer icon.png meldete health deshalb "embedded: true",
    // waehrend alle 26 Chunks der Datei ohne embedded_at dastanden. Ausgerechnet den
    // Fall, den man hier sehen will, verdeckte das Feld.
    embedded: datei.indexed_at !== null && offeneChunks === 0,
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

  // Steht VOR der Parser-Pruefung, sonst faellt der Hinweis ausgerechnet bei den
  // Dateien weg, fuer die kein Parser zustaendig ist — die werden genauso geloescht.
  if (d.geloescht_am !== null) {
    befund.push(
      `Zum Loeschen vorgemerkt seit ${d.geloescht_am.slice(0, 10)} (deleted_at gesetzt). ` +
        `Alle Zahlen unten beschreiben einen Stand, den es bald nicht mehr gibt — der ` +
        `Watcher raeumt die Datei nach. Bleibt sie in diesem Zustand stehen, laeuft fuer ` +
        `dieses Projekt kein Watcher.`
    );
  }

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

  if (d.version_aus_der_zukunft) {
    befund.push(
      `Parse-Stand ${d.parser_version} liegt UEBER der aktuellen Parser-Version ` +
        `${d.parser_version_aktuell}. Durch normales Parsen kann das nicht entstehen — ` +
        `vermutlich sehen zwei verschiedene Staende auf dieselbe Datenbank, etwa ein ` +
        `lokal gebautes dist und ein aelteres Container-Image. Bis das geklaert ist, sagt ` +
        `weder "veraltet" noch "aktuell" etwas ueber diese Datei.`
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
  /** Nur Dateien, die es noch gibt — siehe LEBENDE_DATEI. */
  erfasste_dateien: number;
  /**
   * Eintraege in diesem Projekt OHNE lebende Datei. Aus allen Zahlen oben
   * herausgerechnet, hier aber ausgewiesen: wuerde man sie nur stillschweigend
   * wegrechnen, waere ein Rueckfall wieder unsichtbar.
   */
  karteileichen: number;
  /**
   * Dasselbe ueber ALLE Projekte. Steht hier, weil der Dichte-Massstab
   * projektuebergreifend gebildet wird: eine Leiche in einem FREMDEN Projekt
   * verzieht den Massstab dieses Projekts mit.
   */
  karteileichen_gesamt: number;
  telemetrie_stand: string | null;
  /** Parser-weite Befunde — zuerst lesen, sie wiegen schwerer als Einzelfaelle. */
  parser_befunde: ParserBefundGesamt[];
  /** Auffaellige Einzeldateien, groesste zuerst. */
  dateien: ParserUebersichtDatei[];
  hinweis?: string;
}

/**
 * Bedingung fuer "zu diesem Eintrag gibt es eine LEBENDE Datei".
 *
 * WARUM ES DAS BRAUCHT: parse_coverage war die einzige datei-abgeleitete Tabelle
 * ohne Fremdschluessel und wurde beim Loeschen nie mitgeraeumt — gemessen 3.944
 * Karteileichen gegen 1.533 echte Dateien, waehrend health befund:[] meldete. Der
 * Fremdschluessel in schema.ts verhindert den Zustand inzwischen, ABER: CASCADE
 * feuert nur beim HARTEN Delete. deleteCodeFile macht einen SOFT-Delete
 * (deleted_at = NOW()), der harte kommt erst spaeter ueber den Watcher — und laeuft
 * der fuer ein Projekt nicht, bleibt der Eintrag stehen. Eine Bedingung, die
 * deleted_at ignoriert, zaehlt diese toten Dateien weiter mit.
 *
 * GEMESSEN am 31.07.2026: werden 74.325 Dateien eines Projekts soft-geloescht, war
 * die Antwort dieses Moduls davor ZEICHENGLEICH mit dem gesunden Stand — 41 Befunde
 * vorher, 41 nachher, erfasste_dateien unveraendert. Der Rueckfall war fuer health
 * also nicht sichtbar. Ein Riegel, dessen Bruch niemand sieht, ist nur ein halber.
 *
 * ⚠️ EINE REGEL, EIN ORT. Die Bedingung wird an vier Stellen gebraucht — dreimal
 * LESEND mit dem Alias pc, einmal SCHREIBEND mit Parametern (schreibeParserCoverage).
 * Deshalb steht hier eine Funktion und keine feste Zeichenkette: eine Regel, die an
 * zwei Stellen ausgeschrieben wird, laeuft frueher oder spaeter auseinander — in
 * diesem Projekt an einem einzigen Tag zweimal passiert.
 */
function lebendeDatei(projektAusdruck: string, pfadAusdruck: string): string {
  return `EXISTS (SELECT 1 FROM code_files cf
                    WHERE cf.project = ${projektAusdruck}
                      AND cf.file_path = ${pfadAusdruck}
                      AND cf.deleted_at IS NULL)`;
}

/** Lesende Form fuer Abfragen, die parse_coverage unter dem Alias pc fuehren. */
const LEBENDE_DATEI = lebendeDatei('pc.project', 'pc.file_path');

/** Ab dieser Gesamtzeilenzahl je Parser ist "nichts erkannt" ein Befund. */
const MIN_ZEILEN_PARSER_BEFUND = 1000;

/**
 * Zweite, niedrigere Schwelle fuer den Fall TOTALE LEERE — dort zaehlt zusaetzlich
 * die Zahl der Dateien.
 *
 * WARUM ES SIE BRAUCHT: der groovy-Parser stuerzte bei 8 von 10 echten Gradle-Dateien
 * ab und lieferte projektweit NICHTS. health schwieg dazu, weil 358 Zeilen unter der
 * 1000er-Schwelle lagen — ausgerechnet der flaechendeckende Ausfall, fuer den dieses
 * Modul gebaut wurde, blieb unsichtbar. Ein Parser, der ueber MEHRERE Dateien hinweg
 * gar nichts liefert, ist auch bei 358 Zeilen ein Befund.
 * Die Dateizahl muss mit hinein, sonst meldet jede einzelne Zwei-Zeilen-Datei einen
 * Ausfall (dlang: 14 Dateien mit zusammen rund 20 Zeilen, dort ist 0 korrekt).
 */
const MIN_ZEILEN_LEERE_BEFUND = 150;
const MIN_DATEIEN_LEERE_BEFUND = 3;
/**
 * Ein Parser gilt auf der Ablauf-Ebene als verdaechtig, wenn seine Statement-Dichte
 * um mehr als diesen Faktor unter dem Median der Parser liegt, die ueberhaupt
 * Statements liefern. 20 ist bewusst konservativ: an echtem Material (49 Parser,
 * 74.322 Dateien) trennt der Wert scala (Faktor 333 darunter) und html (46) von der
 * Lisp-Familie, wo eine niedrige Dichte strukturell RICHTIG ist — clojure 15,3,
 * julia 18,8, racket 19,5 je 1000 Zeilen gegen einen Median von 209,6.
 */
const MAX_FAKTOR_UNTER_MEDIAN = 20;
/** Unter so wenigen vergleichenden Parsern ist ein Median keine Aussage. */
const MIN_PARSER_FUER_DICHTEVERGLEICH = 5;

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
      -- deleted_at MUSS mit: ohne diese Bedingung legt der Backfill fuer JEDE
      -- soft-geloeschte Datei die Coverage-Zeile neu an und macht das explizite
      -- DELETE aus dem Loesch-Pfad (services/code.ts) wieder zunichte. Der
      -- Fremdschluessel faengt das nicht ab: die code_files-Zeile existiert ja
      -- noch, sie ist nur zum Loeschen vorgemerkt.
      WHERE cf.content IS NOT NULL AND cf.deleted_at IS NULL ${projektFilter}
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
      project, erfasste_dateien: 0, karteileichen: 0, karteileichen_gesamt: 0,
      telemetrie_stand: null, parser_befunde: [], dateien: [],
      hinweis: 'Tabelle parse_coverage existiert noch nicht — ensureSchema ausfuehren.',
    };
  }

  const params: unknown[] = [project];
  let parserFilter = '';
  if (optionen?.parser) {
    params.push(optionen.parser);
    parserFilter = `AND parser = $${params.length}`;
  }

  const [standRes, parserRes, dateiRes, massstab] = await Promise.all([
    // LEFT JOIN statt EXISTS: EIN Durchlauf liefert beides — die lebenden Eintraege
    // und die Karteileichen. Zwei getrennte Abfragen waeren ein zweiter Scan fuer
    // eine Zahl, die im Normalfall 0 ist.
    pool.query(
      `SELECT count(*) FILTER (WHERE cf.file_path IS NOT NULL)::int AS n,
              count(*) FILTER (WHERE cf.file_path IS NULL)::int AS tot,
              max(pc.gemessen_am) FILTER (WHERE cf.file_path IS NOT NULL) AS stand
         FROM parse_coverage pc
         LEFT JOIN code_files cf
                ON cf.project = pc.project AND cf.file_path = pc.file_path
               AND cf.deleted_at IS NULL
        WHERE pc.project = $1`,
      [project]
    ),
    pool.query(
      `SELECT parser, file_type, count(*)::int AS dateien,
              COALESCE(sum(zeilen_gesamt), 0)::bigint AS zeilen,
              COALESCE(sum(n_funktionen), 0)::bigint AS fn,
              COALESCE(sum(n_statements), 0)::bigint AS stmt,
              COALESCE(sum(n_symbole), 0)::bigint AS sym,
              COALESCE(sum(n_text_symbole), 0)::bigint AS text
         FROM parse_coverage pc
        WHERE project = $1 AND parser IS NOT NULL ${parserFilter}
          AND ${LEBENDE_DATEI}
        GROUP BY parser, file_type`,
      params
    ),
    pool.query(
      `SELECT file_path, parser, zeilen_gesamt, belegte_zeilen, n_symbole,
              n_funktionen, n_text_symbole, n_statements
         FROM parse_coverage pc
        WHERE project = $1 AND parser IS NOT NULL ${parserFilter}
          AND ${LEBENDE_DATEI}
          AND ( (zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND} AND belegte_zeilen = 0)
             OR (n_symbole > 0 AND n_text_symbole = n_symbole AND zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND})
             OR (n_symbole = 0 AND n_statements > 0 AND zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND})
             OR (zeilen_gesamt >= ${MIN_ZEILEN_FUER_BEFUND} AND belegte_zeilen > 0
                 AND belegte_zeilen * 100 < zeilen_gesamt * ${MIN_DECKUNG_PROZENT}) )
        ORDER BY zeilen_gesamt DESC
        LIMIT ${limit}`,
      params
    ),
    // Gehoert in dieses Promise.all und nicht ans Ende: die Abfrage braucht von den
    // drei anderen nichts. Vorher stand das await mitten im return und lief deshalb
    // erst, wenn alles andere fertig war.
    ermittleMedianDichte(),
  ]);

  const karteileichen: number = standRes.rows[0].tot;
  const hinweise: string[] = [];
  if (karteileichen > 0) {
    hinweise.push(
      `${fmt(karteileichen)} Eintraege in parse_coverage haben in diesem Projekt keine lebende ` +
        `Datei mehr — geloescht oder mit deleted_at vorgemerkt. Sie sind aus allen Zahlen ` +
        `oben herausgerechnet. Der Fremdschluessel in schema.ts sollte das verhindern; ist ` +
        `die Zahl groesser als 0, greift entweder der Loesch-Pfad nicht oder ein Backfill hat ` +
        `die Zeilen neu angelegt.`
    );
  }
  if (massstab.waisen_gesamt > 0) {
    hinweise.push(
      `Projektuebergreifend stehen ${fmt(massstab.waisen_gesamt)} solche Eintraege in der ` +
        `Tabelle. Fuer den Dichte-Massstab zaehlen sie nicht mit, verfaelschen ihn also nicht — ` +
        `sie zeigen aber, dass irgendwo Dateien verschwinden, ohne ihre Telemetrie mitzunehmen.`
    );
  }

  return {
    project,
    erfasste_dateien: standRes.rows[0].n,
    karteileichen,
    karteileichen_gesamt: massstab.waisen_gesamt,
    telemetrie_stand: standRes.rows[0].stand ? new Date(standRes.rows[0].stand).toISOString() : null,
    parser_befunde: bewerteParser(parserRes.rows, massstab.median),
    dateien: dateiRes.rows.map(mappeUebersichtDatei),
    ...(hinweise.length > 0 ? { hinweis: hinweise.join(' ') } : {}),
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
 * Median der Statement-Dichte ueber ALLE Projekte, gebildet je Parser.
 *
 * WARUM PROJEKTUEBERGREIFEND: was eine normale Dichte ist, entscheidet die Sprache,
 * nicht das Projekt. Im Arbeitszyklus "ein Repo rein, testen, wieder raus" enthaelt
 * ein Projekt nur eine Handvoll Sprachen — an einem frisch angelegten Solidity-Projekt
 * gemessen lieferten genau DREI Parser Statements (typescript, solidity, shell), also
 * weniger als MIN_PARSER_FUER_DICHTEVERGLEICH. Aus dem Projekt allein gebildet waere
 * der Massstab dort null gewesen, und der Befund haette ausgerechnet in dem Ablauf
 * geschwiegen, fuer den er gebraucht wird.
 *
 * Parser mit sehr wenig Material bleiben draussen: ihre Dichte ist Zufall und wuerde
 * den Median verziehen. Faellt die Abfrage aus, kommt null zurueck und es wird kein
 * Befund erfunden.
 *
 * ⚠️ WAS SICH AM 31.07.2026 GEAENDERT HAT — und was ausdruecklich NICHT:
 * Gefiltert wird NICHT nach Projekt (das wuerde den Massstab zerstoeren, siehe oben),
 * sondern danach, ob es zu einem Eintrag noch eine lebende Datei gibt. Die Tabelle
 * enthielt Eintraege geloeschter Dateien, und die verschoben nicht die Anzeige EINES
 * Projekts, sondern den Massstab ALLER — also die Schwelle, ab der ueberhaupt ein
 * Befund entsteht.
 * GEMESSEN am realen Bestand: faellt das groesste Projekt weg (58.229 von 70.895
 * Eintraegen, 82 Prozent) und bleiben seine Zeilen stehen, meldet der ungefilterte
 * Median 209,6 statt 264,6 — die Ausloeseschwelle liegt damit bei 10,5 statt 13,2
 * Statements je 1000 Zeilen, ein Unterschied von 26 Prozent.
 * GEGENPROBE, weil ein Filter den Massstab auch aushungern kann: im selben Fall
 * sinkt die Zahl der vergleichenden Parser von 37 auf 15, bleibt also klar ueber
 * MIN_PARSER_FUER_DICHTEVERGLEICH. Der Befund verstummt nicht.
 *
 * Die Waisenzahl faellt bei dieser Abfrage ohnehin ab und wird mitgegeben, statt sie
 * in einem zweiten Scan noch einmal zu holen.
 */
async function ermittleMedianDichte(): Promise<{ median: number | null; waisen_gesamt: number }> {
  try {
    const { rows } = await getPool().query<{ st: string; z: string; tot: string }>(
      `SELECT COALESCE(sum(pc.n_statements) FILTER (WHERE cf.file_path IS NOT NULL), 0) AS st,
              COALESCE(sum(pc.zeilen_gesamt) FILTER (WHERE cf.file_path IS NOT NULL), 0) AS z,
              count(*) FILTER (WHERE cf.file_path IS NULL) AS tot
         FROM parse_coverage pc
         LEFT JOIN code_files cf
                ON cf.project = pc.project AND cf.file_path = pc.file_path
               AND cf.deleted_at IS NULL
        GROUP BY pc.parser`
    );
    // HAVING und ORDER BY stehen jetzt hier statt im SQL: die Abfrage muss ohnehin
    // ALLE Gruppen liefern, damit die Waisen mitgezaehlt werden koennen. Die Auswahl
    // ist Zeile fuer Zeile dieselbe wie vorher.
    const waisenGesamt = rows.reduce((s, z) => s + Number(z.tot), 0);
    const dichten = rows
      .filter(z => Number(z.st) > 0 && Number(z.z) >= MIN_ZEILEN_PARSER_BEFUND)
      .map(z => (1000 * Number(z.st)) / Number(z.z))
      .filter(d => Number.isFinite(d) && d > 0)
      .sort((a, b) => a - b);
    return {
      median:
        dichten.length >= MIN_PARSER_FUER_DICHTEVERGLEICH
          ? dichten[Math.floor(dichten.length / 2)]
          : null,
      waisen_gesamt: waisenGesamt,
    };
  } catch (error) {
    console.error(
      '[Synapse] Dichte-Massstab nicht ermittelbar, Ablauf-Befund entfaellt:',
      (error as Error).message
    );
    return { median: null, waisen_gesamt: 0 };
  }
}

/**
 * Fasst die Zeilen je Parser zusammen und prueft ABSOLUTE Anker.
 * Kein Vergleich gegen einen Durchschnitt — siehe Modulkopf.
 */
function bewerteParser(
  zeilen: ParserZeile[],
  medianDichte: number | null
): ParserBefundGesamt[] {
  const jeParser = new Map<
    string,
    { g: ParserBefundGesamt; typen: Map<string, { fn: number; dateien: number; zeilen: number }> }
  >();

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
    eintrag.typen.set(z.file_type ?? '?', { fn, dateien: z.dateien, zeilen: Number(z.zeilen) });
  }

  // Vergleichsmassstab fuer die Ablauf-Ebene: der Median der Statement-Dichte ueber
  // alle Parser, die ueberhaupt Statements liefern. Datenformate (yaml, toml, css,
  // markdown, cmake, makefile) fallen dadurch VON SELBST heraus, ohne Pflegeliste —
  // sie liefern konstruktiv keine Statements und wuerden sonst dauerhaft falsch
  // beschuldigt. Genau daran waere ein einfaches "Funktionen da, Statements null"
  // gescheitert.
  // Der Massstab kommt von aussen (siehe ermittleMedianDichte): er wird PROJEKT-
  // UEBERGREIFEND gebildet, weil eine normale Statement-Dichte an der SPRACHE haengt
  // und nicht am Projekt.
  const raus: ParserBefundGesamt[] = [];
  for (const { g, typen } of jeParser.values()) {
    // DER FALL, DER RELATIV NIE AUFFAELLT: alles kaputt, also nichts auffaellig.
    // Gemessen wird "gar nichts erkannt", nicht "keine Funktionen" — sonst waeren
    // reine Markup- und Stylesheet-Parser dauerhaft falsch beschuldigt.
    if (
      g.symbole_gesamt === 0 &&
      g.statements_gesamt === 0 &&
      (g.zeilen_gesamt >= MIN_ZEILEN_PARSER_BEFUND ||
        (g.dateien >= MIN_DATEIEN_LEERE_BEFUND && g.zeilen_gesamt >= MIN_ZEILEN_LEERE_BEFUND))
    ) {
      g.befund.push(
        `FLAECHENDECKEND: ueber alle ${fmt(g.dateien)} Dateien (${fmt(g.zeilen_gesamt)} Zeilen) ` +
          `liefert dieser Parser ueberhaupt nichts — kein Symbol, kein Statement. ` +
          `Kein Einzelfall, der Parser selbst greift nicht.`
      );
    }

    // Auch das ist ein flaechendeckender Ausfall, nur ein subtilerer: der Parser
    // liefert etwas, aber nur Woerter. Genau dieser Zustand hat monatelang
    // niemandem auffallen koennen.
    // "FLAECHENDECKEND" behauptet Flaeche — dann muss auch welche da sein. Ohne die
    // Mindestgroesse stand das Wort ueber EINER Datei mit 13 Zeilen (webserver-oauth/html).
    if (
      g.symbole_gesamt > 0 &&
      g.text_symbole_gesamt === g.symbole_gesamt &&
      g.statements_gesamt === 0 &&
      (g.dateien >= MIN_DATEIEN_LEERE_BEFUND || g.zeilen_gesamt >= MIN_ZEILEN_LEERE_BEFUND)
    ) {
      g.befund.push(
        `FLAECHENDECKEND: die gesamte Ausgabe ueber ${fmt(g.dateien)} Dateien besteht aus Text ` +
          `(${fmt(g.symbole_gesamt)} string/comment, kein einziges Code-Symbol, keine Statements) — ` +
          `der Parser zerlegt die Dateien nur in Woerter.`
      );
    }

    // Liefert bei einem Dateityp normal, bei einem anderen nie.
    // Die leere Seite braucht genug Material, sonst ist "keine einzige Funktion"
    // keine Aussage ueber den Parser, sondern ueber die Datei (siehe
    // MIN_DATEIEN_FUER_TYP_BEFUND). Die volle Seite braucht keine Schwelle: eine
    // gefundene Funktion ist ein Positivbeweis, egal wie klein die Stichprobe ist.
    if (typen.size > 1) {
      const leerEintraege = [...typen.entries()].filter(
        ([, v]) =>
          v.fn === 0 &&
          (v.dateien >= MIN_DATEIEN_FUER_TYP_BEFUND || v.zeilen >= MIN_ZEILEN_FUER_TYP_BEFUND)
      );
      const leer = leerEintraege.map(([t]) => t);
      const voll = [...typen.entries()].filter(([, v]) => v.fn > 0).map(([t]) => t);
      if (leer.length > 0 && voll.length > 0) {
        const basis = leerEintraege
          .map(([t, v]) => `${t}: ${fmt(v.dateien)} Dateien, ${fmt(v.zeilen)} Zeilen`)
          .join('; ');
        g.befund.push(
          `Liefert bei ${voll.join(', ')} Funktionen, bei ${leer.join(', ')} dagegen keine einzige — ` +
            `Verdacht auf eine Luecke fuer diese Endung (Datenbasis ${basis}).`
        );
      }
    }

    // DER FALL, DEN KEINE DER PRUEFUNGEN OBEN SEHEN KANN: der Parser liefert Symbole,
    // aber die Ablauf-Ebene ist praktisch tot. FLAECHENDECKEND verlangt, dass GAR
    // nichts kommt; der Endungsvergleich braucht eine zweite Endung. Ein Parser mit
    // nur einer Endung, der eine von zwei Dimensionen sauber liefert und die andere
    // verliert, sah damit gesund aus — scala stand so mit 363 Statements auf 580.621
    // Zeilen im Index, waehrend 61.394 gefundene Funktionen alles in Ordnung
    // erscheinen liessen. Es gab dafuer sogar die umgekehrte Pruefung ("0 Symbole,
    // aber N Statements"), nur nicht diese Richtung.
    //
    // BEWUSST OFFEN: ein Parser mit Symbolen und EXAKT null Statements bleibt
    // unauffaellig. Ohne Sprachwissen ist er nicht von einem Datenformat zu
    // unterscheiden, und ein Fehlalarm ueber yaml/css jede Woche waere teurer als
    // die Luecke. Wer sie schliessen will, braucht eine Angabe am Parser selbst,
    // ob er Statements ueberhaupt kennt.
    if (
      medianDichte !== null &&
      g.statements_gesamt > 0 &&
      g.zeilen_gesamt >= MIN_ZEILEN_PARSER_BEFUND
    ) {
      const dichte = (1000 * g.statements_gesamt) / g.zeilen_gesamt;
      if (dichte * MAX_FAKTOR_UNTER_MEDIAN < medianDichte) {
        g.befund.push(
          `ABLAUF-EBENE FAST TOT: ${dichte.toFixed(1)} Statements je 1000 Zeilen, waehrend ` +
            `der Median der liefernden Parser bei ${medianDichte.toFixed(1)} liegt ` +
            `(Faktor ${Math.round(medianDichte / dichte)} darunter). Symbole kommen dagegen ` +
            `an (${fmt(g.symbole_gesamt)}) — Verdacht, dass Statements nur in Sonderfaellen ` +
            `erfasst werden. Datenbasis: ${fmt(g.dateien)} Dateien, ${fmt(g.zeilen_gesamt)} Zeilen.`
        );
      }
    }

    // DER TOTALAUSFALL: gar keine Statements. Der Dichte-Befund oben kann ihn nicht
    // sehen, weil er durch null teilen muesste — und lange blieb er ungemeldet, weil
    // ein kaputter Parser ohne Sprachwissen nicht von yaml oder css zu unterscheiden
    // war. Seit LanguageParser.hatAblaufEbene sagt der Parser selbst, ob seine
    // Sprache Anweisungen kennt; Datenformate stehen ausdruecklich auf false.
    //
    // BELEGT AN DREI FAELLEN: scala lieferte 363 Statements auf 580.621 Zeilen,
    // jsonnet und dhall exakt null bei 343 bzw. 379 gefundenen Funktionen. In allen
    // drei Faellen meldete health vorher befund:[] — die Symbole kamen ja an.
    if (
      g.statements_gesamt === 0 &&
      g.symbole_gesamt > 0 &&
      g.zeilen_gesamt >= MIN_ZEILEN_PARSER_BEFUND &&
      kenntAblaufEbene(g.parser)
    ) {
      g.befund.push(
        `ABLAUF-EBENE FEHLT GANZ: kein einziges Statement ueber ${fmt(g.dateien)} Dateien ` +
          `und ${fmt(g.zeilen_gesamt)} Zeilen. Symbole kommen dagegen an ` +
          `(${fmt(g.symbole_gesamt)}, darunter ${fmt(g.funktionen_gesamt)} Funktionen) — der ` +
          `Parser versteht die Dateien also, aber eine ganze Ebene fehlt. Diese Sprache kennt ` +
          `Anweisungen; ist das ein Irrtum, gehoert hatAblaufEbene=false an den Parser.`
      );
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
 *
 * ⚠️ SCHREIBT NUR FUER LEBENDE DATEIEN. Ohne diese Bedingung schreibt ein Parse, der
 * sich mit einem Loeschen ueberholt, die gerade geraeumte Zeile wieder zurueck — und
 * macht damit das explizite DELETE im Loesch-Pfad (services/code.ts) wirkungslos. Der
 * Fremdschluessel faengt es nicht ab: beim SOFT-Delete existiert die code_files-Zeile
 * ja noch, sie ist nur tot.
 * Die Pruefung sitzt IM Statement (SELECT ... WHERE EXISTS) und nicht in einer eigenen
 * Abfrage davor. Eine Abfrage davor haette zwischen Pruefung und Schreiben genau die
 * Luecke gelassen, die hier geschlossen werden soll — und die Luecke ist der ganze Fall.
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

    const geschrieben = await getPool().query(
      `INSERT INTO parse_coverage (
         project, file_path, file_type, parser, parser_version, datei_bytes,
         zeilen_gesamt, belegte_zeilen, n_symbole, n_funktionen, n_klassen,
         n_variablen, n_imports, n_text_symbole, n_statements, n_call_edges,
         dauer_ms, gemessen_am)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()
        WHERE ${lebendeDatei('$1', '$2')}
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

    // WARUM HIER EINE LOGZEILE STEHT UND KEIN STILLES WEITER:
    // Wird uebersprungen, bleibt NIRGENDWO eine Spur. Der Karteileichen-Zaehler der
    // Uebersicht kann diesen Fall prinzipiell nicht zeigen — er zaehlt geschriebene
    // Zeilen ohne lebende Datei, und hier wird ja gerade nichts geschrieben. Das ist
    // die einzige Stelle des PTZ-11-Umbaus, deren Ergebnis sonst voellig unsichtbar
    // waere, und ein stiller Verzicht ist schlimmer als ein lauter.
    // ZUR MENGE, damit das Log nicht zulaeuft: es feuert nur, wenn sich ein Parse und
    // ein Loeschen ueberholen — nicht einmal je Datei eines geloeschten Projekts, denn
    // fuer tote Dateien wird gar kein Parse mehr angestossen. Wird es doch laut, ist
    // genau das die Nachricht: dann parst etwas dauerhaft Dateien, die es nicht mehr gibt.
    if (geschrieben.rowCount === 0) {
      console.error(
        `[parser-health] Coverage uebersprungen, Datei ist geloescht oder zum Loeschen ` +
          `vorgemerkt: ${project}/${filePath}`
      );
    }
  } catch (err) {
    console.error(
      `[parser-health] Coverage nicht gespeichert (${project}/${filePath}):`,
      (err as Error).message
    );
  }
}
