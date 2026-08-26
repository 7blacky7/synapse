/**
 * Symbol umbenennen — auf Basis der aufgeloesten Referenzen.
 *
 * WARUM ES DAS GIBT: Ein Umbenennen per Textersetzung ueber das ganze Projekt
 * ist gefaehrlich, weil derselbe Name an voellig unbeteiligten Stellen steht.
 * Gemessen am 26.08.2026: `update` kam 14 mal vor, 13 davon als
 * crypto.createHash('sha256').update(). Wer das ersetzt, zerlegt die Hashes.
 *
 * WAS ES ANDERS MACHT: Grundlage sind nicht alle Namensvorkommen, sondern die
 * Fundstellen, die getReferences nach dem Aussortieren uebrig laesst — plus die
 * Definition selbst. String-Literale bleiben unangetastet: ein Name in einem
 * String ist meistens etwas anderes (ein Schluessel, eine Meldung), und wo
 * nicht, ist es eine bewusste Entscheidung und keine mechanische.
 *
 * WAS ES NICHT KANN, und das ist die harte Grenze: Es loest keine Typen auf.
 * Zwei gleichnamige Methoden auf verschiedenen Klassen sind hier nicht
 * unterscheidbar. Wer die umbenennen will, braucht einen Sprachserver.
 * Deshalb ist die Vorschau der Normalfall und das Anwenden der Ausnahmefall.
 */

import { getPool } from '../db/client.js';
import { getReferences } from './code-intel.js';

/** Eine Zeile, die geaendert werden soll. */
export interface UmbenennungsStelle {
  file_path: string;
  line_number: number;
  vorher: string;
  nachher: string;
  /** Woher die Stelle stammt — die Definition selbst oder eine Verwendung. */
  herkunft: 'definition' | 'referenz';
}

/** Eine Stelle, die bewusst NICHT angefasst wird, mit Begruendung. */
export interface UebersprungeneStelle {
  file_path: string;
  line_number: number;
  grund: string;
  zeile: string;
}

/** Eine von mehreren gleichnamigen Definitionen. */
export interface Kandidat {
  file_path: string;
  line_start: number;
  symbol_type: string;
  parent_symbol: string | null;
}

export interface UmbenennungsPlan {
  name: string;
  neuer_name: string;
  /**
   * Wahr, wenn es mehrere gleichnamige Definitionen gibt — etwa Methoden
   * verschiedener Klassen oder Ueberladungen. Dann trifft die Vorschau eine
   * Auswahl, die sie nicht begruenden kann, und darf NICHT ungeprueft
   * angewendet werden.
   */
  mehrdeutig: boolean;
  /** Alle gefundenen Definitionen des Namens, wenn es mehr als eine gibt. */
  kandidaten: Kandidat[];
  stellen: UmbenennungsStelle[];
  uebersprungen: UebersprungeneStelle[];
  /** Fertige Operationen fuer files(action:"plan"). Leer, wenn nichts zu tun ist. */
  ops: Array<{
    file_path: string;
    action: 'replace_lines';
    line_start: number;
    line_end: number;
    content: string;
    anchor_text: string;
  }>;
  warnungen: string[];
  /** Wie viele gleichnamige Fundstellen bewusst draussen blieben. */
  namensgleiche_ignoriert: number;
}

/** Maskiert Sonderzeichen, damit ein Name als Regex-Literal sicher ist. */
function alsRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bereitet das Umbenennen vor, ohne etwas zu schreiben.
 *
 * Das Ergebnis enthaelt fertige Operationen fuer files(action:"plan"). Damit
 * laeuft die Ausfuehrung ueber denselben Weg wie jede andere Mehrfach-Aenderung
 * und erbt dessen Versionierung, Hash-Pruefung und restore_batch. Ein eigener
 * Schreibweg waere eine zweite Stelle, an der dieselben Fehler neu gemacht
 * werden koennten.
 */
export async function planeUmbenennung(
  project: string,
  name: string,
  neuerName: string
): Promise<UmbenennungsPlan> {
  const warnungen: string[] = [];

  if (name === neuerName) {
    return {
      name, neuer_name: neuerName, mehrdeutig: false, kandidaten: [],
      stellen: [], uebersprungen: [], ops: [],
      warnungen: ['Alter und neuer Name sind gleich — nichts zu tun.'],
      namensgleiche_ignoriert: 0,
    };
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(neuerName)) {
    warnungen.push(
      `"${neuerName}" ist kein gewoehnlicher Bezeichner. Das kann gewollt sein, `
      + 'macht den Code aber in vielen Sprachen ungueltig.'
    );
  }

  const refs = await getReferences(project, name);
  if (!refs.definition) {
    return {
      name, neuer_name: neuerName, mehrdeutig: false, kandidaten: [],
      stellen: [], uebersprungen: [], ops: [],
      warnungen: [`Kein Symbol "${name}" im Projekt gefunden.`],
      namensgleiche_ignoriert: 0,
    };
  }

  // ⚠️ MEHRERE DEFINITIONEN DESSELBEN NAMENS. getReferences waehlt genau eine
  // aus (LIMIT 1) — und zwar ohne Begruendung, es ist schlicht die erste.
  // Gemessen am 26.08.2026: 'erstelle' ist in pg_client.moo FUENFMAL definiert,
  // auf fuenf verschiedenen Objekten. Die Vorschau meldete daraufhin eine
  // einzige Fundstelle und keine Warnung — wer sie angewendet haette, haette
  // eine von fuenf Methoden umbenannt und nichts davon gemerkt.
  // Auswaehlen kann diese Funktion hier nicht, dazu braeuchte es Typen. Sagen
  // kann sie es.
  const kandidatenRows = await getPool().query<{
    file_path: string; line_start: number; symbol_type: string; parent_symbol: string | null;
  }>(
    `SELECT file_path, line_start, symbol_type, parent_symbol
       FROM code_symbols
      WHERE project = $1 AND name = $2 AND symbol_type <> 'string'
        AND symbol_type NOT IN ('import', 'export')
      ORDER BY file_path, line_start`,
    [project, name]
  );
  const kandidaten: Kandidat[] = kandidatenRows.rows.map((z) => ({
    file_path: z.file_path,
    line_start: z.line_start,
    symbol_type: z.symbol_type,
    parent_symbol: z.parent_symbol ?? null,
  }));
  const mehrdeutig = kandidaten.length > 1;
  if (mehrdeutig) {
    warnungen.push(
      `⚠️ "${name}" ist ${kandidaten.length} mal definiert `
      + `(${[...new Set(kandidaten.map((k) => k.file_path))].length} Datei(en)). `
      + 'Diese Vorschau bezieht sich auf EINE davon und kann nicht entscheiden, '
      + 'welche gemeint ist — dafuer muessten Typen aufgeloest werden. '
      + 'NICHT ungeprueft anwenden: die Fundstellen unter kandidaten vergleichen '
      + 'und im Zweifel Datei fuer Datei von Hand vorgehen.'
    );
  }

  // Die Definition gehoert dazu — sonst zeigen die umbenannten Verwendungen
  // anschliessend ins Leere.
  const zuAendern = new Map<string, { file_path: string; line_number: number; herkunft: 'definition' | 'referenz' }>();
  const schluessel = (f: string, l: number) => `${f}:${l}`;
  zuAendern.set(schluessel(refs.definition.file_path, refs.definition.line_start), {
    file_path: refs.definition.file_path,
    line_number: refs.definition.line_start,
    herkunft: 'definition',
  });
  for (const referenz of refs.references) {
    const k = schluessel(referenz.file_path, referenz.line_number);
    if (zuAendern.has(k)) continue;
    zuAendern.set(k, {
      file_path: referenz.file_path,
      line_number: referenz.line_number,
      herkunft: 'referenz',
    });
  }

  if (refs.total_name_matches > 0) {
    warnungen.push(
      `${refs.total_name_matches} gleichnamige Fundstelle(n) bleiben unveraendert — `
      + 'sie gehoeren erkennbar zu etwas anderem (Methodenaufruf auf fremdem '
      + 'Empfaenger). Nachsehen lohnt: references liefert sie unter name_matches.'
    );
  }
  if (refs.total_string_occurrences > 0) {
    warnungen.push(
      `${refs.total_string_occurrences} Vorkommen in Zeichenketten bleiben unveraendert. `
      + 'Wenn der Name dort als Schluessel oder Tabellenspalte steht, muss er von Hand nach.'
    );
  }

  // Dateien einmal laden, nicht je Fundstelle.
  const dateien = [...new Set([...zuAendern.values()].map((s) => s.file_path))];
  const inhalte = new Map<string, string[]>();
  const pool = getPool();
  for (const pfad of dateien) {
    const { rows } = await pool.query<{ content: string }>(
      'SELECT content FROM code_files WHERE project = $1 AND file_path = $2 LIMIT 1',
      [project, pfad]
    );
    if (rows[0]?.content != null) inhalte.set(pfad, rows[0].content.split('\n'));
  }

  const muster = new RegExp(`\\b${alsRegexLiteral(name)}\\b`, 'g');
  const stellen: UmbenennungsStelle[] = [];
  const uebersprungen: UebersprungeneStelle[] = [];

  for (const stelle of [...zuAendern.values()].sort((a, b) =>
    a.file_path === b.file_path ? a.line_number - b.line_number : a.file_path.localeCompare(b.file_path)
  )) {
    const zeilen = inhalte.get(stelle.file_path);
    if (!zeilen) {
      uebersprungen.push({
        file_path: stelle.file_path, line_number: stelle.line_number,
        grund: 'Dateiinhalt nicht im Index', zeile: '',
      });
      continue;
    }
    const zeile = zeilen[stelle.line_number - 1];
    if (zeile == null) {
      uebersprungen.push({
        file_path: stelle.file_path, line_number: stelle.line_number,
        grund: 'Zeile existiert nicht mehr — Index veraltet', zeile: '',
      });
      continue;
    }

    const treffer = zeile.match(muster);
    if (!treffer) {
      uebersprungen.push({
        file_path: stelle.file_path, line_number: stelle.line_number,
        grund: 'Name steht nicht (mehr) in dieser Zeile', zeile: zeile.trim().slice(0, 120),
      });
      continue;
    }
    // Mehrfach in EINER Zeile: dann ist nicht zu entscheiden, welches Vorkommen
    // gemeint ist — dieselbe Vorsicht, die search_replace bei multiple_matches walten laesst.
    if (treffer.length > 1) {
      uebersprungen.push({
        file_path: stelle.file_path, line_number: stelle.line_number,
        grund: `Name steht ${treffer.length} mal in dieser Zeile — von Hand pruefen`,
        zeile: zeile.trim().slice(0, 120),
      });
      continue;
    }

    stellen.push({
      file_path: stelle.file_path,
      line_number: stelle.line_number,
      vorher: zeile,
      nachher: zeile.replace(muster, neuerName),
      herkunft: stelle.herkunft,
    });
  }

  if (uebersprungen.length > 0) {
    warnungen.push(
      `${uebersprungen.length} Fundstelle(n) uebersprungen — Einzelheiten unter uebersprungen. `
      + 'Sie muessen von Hand nach, sonst bleibt das Umbenennen halb.'
    );
  }

  return {
    name,
    neuer_name: neuerName,
    mehrdeutig,
    kandidaten: mehrdeutig ? kandidaten : [],
    stellen,
    uebersprungen,
    // anchor_text laesst den Schreibweg selbst pruefen, dass die Zeile noch so
    // aussieht wie beim Planen. Ohne das koennte zwischen Vorschau und
    // Anwenden etwas dazwischenkommen.
    ops: stellen.map((s) => ({
      file_path: s.file_path,
      action: 'replace_lines' as const,
      line_start: s.line_number,
      line_end: s.line_number,
      content: s.nachher,
      anchor_text: s.vorher.trim(),
    })),
    warnungen,
    namensgleiche_ignoriert: refs.total_name_matches,
  };
}
