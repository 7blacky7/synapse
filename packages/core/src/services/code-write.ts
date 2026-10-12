/**
 * MODUL: Code-Write Service
 * ZWECK: Zeilenbasierte String-Operationen + PG File CRUD fuer den REST API Code-Editor
 *
 * FUNKTIONEN:
 *   String-Operationen (pure, kein PG):
 *     replaceLines     — Zeilen ersetzen (1-basiert, inklusiv)
 *     insertAfterLine  — Nach Zeile einfuegen (0 = Anfang)
 *     deleteLines      — Zeilen loeschen (1-basiert, inklusiv)
 *     searchReplace    — Suchen + Ersetzen, gibt { content, count, fuzzyMatches? } zurueck
 *     contentHash      — SHA-256 Hash
 *
 *   PG-Operationen:
 *     createFileInPg      — INSERT in code_files + fire-and-forget parseAndEmbed
 *     updateFileInPg      — UPDATE code_files + fire-and-forget parseAndEmbed
 *     softDeleteFile      — SET deleted_at = NOW()
 *     moveFileInPg        — UPDATE file_path in allen Tabellen (Transaktion) + Qdrant cleanup
 *     copyFileInPg        — Datei kopieren via createFileInPg
 *     getFileContentFromPg — SELECT content
 *
 * HINWEISE:
 *   - Alle PG-Queries nutzen exakte file_path Matches (relative Pfade)
 *   - parseAndEmbed wird fire-and-forget aufgerufen
 *   - moveFileInPg verwendet BEGIN/COMMIT/ROLLBACK (FK-Reihenfolge: symbols/references/chunks → files)
 */

import * as crypto from 'crypto';
import { getPool } from '../db/client.js';
import { enqueueParseAndEmbed } from './code.js';
import { deleteByFilePath } from '../qdrant/index.js';
import { COLLECTIONS } from '../types/index.js';
import { checkErrorPatterns, type ErrorPatternWarning } from './error-patterns.js';
import { verfolgeFehlermusterPruefung, vormerkenBefunde, ueberholeSyntaxBefunde } from './fehlermuster-auslieferung.js';
import { meldeFehlerfall } from './erklaerungen.js';
import {
  hatSyntaxPruefer,
  pruefeSignaturen,
  pruefeSyntaxEinzelweg,
  quittierVermerk,
  SyntaxfehlerAbgelehnt,
  type FehlerBefund,
} from './fehlermuster-pruefung.js';

/**
 * IDEA-3a: Resolve agent_id mit Default-Fallback.
 * Reihenfolge: explizit uebergeben -> SYNAPSE_DEFAULT_AGENT_ID env -> null.
 * KEIN harter 'koordinator'-Default — bleibt null wenn nichts gesetzt ist.
 */
// resolveAgentId: zentral in agent-id-resolver.ts (DRY mit file-batch.ts)
import { resolveAgentId } from './agent-id-resolver.js';
import { resolveProjectTaskId } from './task-id-resolver.js';
import { merkeFileTaskVersion } from './file-task-zuordnung.js';

/**
 * SYNC-1: agent_id fuer Aenderungen, die direkt auf dem Dateisystem passiert sind
 * (Editor, git checkout, Skript) und vom FileWatcher aufgesammelt wurden — im
 * Gegensatz zu Aenderungen ueber das files-Tool, die einen echten Agenten haben.
 * Als Konstante, damit Schreiber und Leser (Tray-Events, history-Filter) denselben
 * Wert benutzen.
 */
export const FS_AGENT_ID = 'filesystem';

/**
 * IDEA-3a: Optionale Enrichment-Felder fuer file_versions.
 * Alle Felder additive/nullable — bestehende Aufrufer ohne diese Felder laufen unveraendert weiter.
 */
export interface VersionEnrichment {
  feature_tag?: string | null;
  parent_version_id?: string | number | null;
  git_commit_sha?: string | null;
  /** KI-eigene Beobachtungen pro Edit. Bei Multi-File-Batches via plan/commit
   *  wird zusaetzlich ein UPDATE in file-batch.ts auf alle Rows der Batch
   *  ausgefuehrt; bei single-file writes wird agent_note direkt mit-eingetragen. */
  agent_note?: string | null;
  /** P6-T24: Task-UUID oder Kurz-ID, wird projektweit validiert. */
  task_id?: string | null;
}

// ─── String-Operationen (pure) ────────────────────────────────────────────────

/**
 * Normalisiert Whitespace: trim + collapse multiple spaces
 */
function normalizeWhitespace(str: string): string {
  return str
    .trim()
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .join('\n');
}

/**
 * Longest Common Subsequence Länge (auf Array-Ebene, z.B. Zeilen)
 * DP-basiert: O(m × n) wobei m, n = Zeilenanzahl (nicht Zeichenanzahl)
 */
function lcsLength(arr1: string[], arr2: string[]): number {
  const m = arr1.length;
  const n = arr2.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (arr1[i - 1] === arr2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Levenshtein Similarity Score (0-1)
 */
function calculateLevenshteinSimilarity(s1: string, s2: string): number {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;

  const dp: number[][] = Array(s1.length + 1)
    .fill(null)
    .map(() => Array(s2.length + 1).fill(0));

  for (let i = 0; i <= s1.length; i++) dp[i][0] = i;
  for (let j = 0; j <= s2.length; j++) dp[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const distance = dp[s1.length][s2.length];
  return 1 - distance / maxLen;
}

/**
 * Findet ähnliche Zeilen-Fenster für einen Search-String.
 * Einzeilig: Levenshtein. Mehrzeilig: Sliding Window + LCS auf Zeilen-Ebene.
 * @returns [{ lineStart, preview, similarity }] — Top 3, similarity > 0.5
 */
export interface FuzzyMatch {
  lineStart: number;
  preview: string;
  similarity: number;
}

function findSimilarLines(
  content: string,
  searchStr: string,
  limit: number = 3,
  minSimilarity: number = 0.5
): FuzzyMatch[] {
  const contentLines = content.split('\n');
  const searchLines = searchStr.split('\n');
  const searchLen = searchLines.length;

  // Einzeilig: Levenshtein auf normalisiertem Text
  if (searchLen === 1) {
    const normalized = normalizeWhitespace(searchStr);
    const matches: Array<{ lineStart: number; score: number }> = [];

    contentLines.forEach((line, idx) => {
      const normalizedLine = normalizeWhitespace(line); // einmal cachen
      if (normalizedLine === normalized) return; // Exakt match schon gefunden
      const score = calculateLevenshteinSimilarity(normalized, normalizedLine);
      if (score > minSimilarity) {
        matches.push({ lineStart: idx + 1, score });
      }
    });

    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(m => ({
        lineStart: m.lineStart,
        preview: contentLines[m.lineStart - 1].substring(0, 50),
        similarity: Math.round(m.score * 100),
      }));
  }

  // Mehrzeilig: Sliding Window mit LCS auf normalisierten Zeilen
  const normalizedSearchLines = searchLines.map(normalizeWhitespace);
  const matches: Array<{ lineStart: number; score: number }> = [];

  for (let i = 0; i <= contentLines.length - searchLen; i++) {
    const window = contentLines.slice(i, i + searchLen).map(normalizeWhitespace);
    const lcs = lcsLength(window, normalizedSearchLines);
    const score = lcs / searchLen; // window.length === searchLen immer

    if (score > minSimilarity) {
      matches.push({ lineStart: i + 1, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(m => ({
      lineStart: m.lineStart,
      preview: contentLines[m.lineStart - 1].substring(0, 50),
      similarity: Math.round(m.score * 100),
    }));
}

/**
 * Ersetzt Zeilen in einem String (1-basiert, inklusiv).
 * @param content   - Dateiinhalt als String
 * @param lineStart - Erste zu ersetzende Zeile (1-basiert)
 * @param lineEnd   - Letzte zu ersetzende Zeile (1-basiert, inklusiv)
 * @param newContent - Neuer Inhalt fuer den ersetzen Bereich
 */
export function replaceLines(
  content: string,
  lineStart: number,
  lineEnd: number,
  newContent: string
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (lineStart < 1 || lineStart > totalLines) {
    throw new Error(`lineStart ${lineStart} ausserhalb des gueltigen Bereichs (1-${totalLines})`);
  }
  if (lineEnd < lineStart || lineEnd > totalLines) {
    throw new Error(`lineEnd ${lineEnd} ausserhalb des gueltigen Bereichs (${lineStart}-${totalLines})`);
  }

  const before = lines.slice(0, lineStart - 1);
  const after = lines.slice(lineEnd);

  // Single-Line-Replace: trailing \n strippen (sonst extra leere Zeile)
  let safeNewContent = newContent;
  if (lineStart === lineEnd && safeNewContent.endsWith('\n')) {
    safeNewContent = safeNewContent.slice(0, -1);
  }
  const newLines = safeNewContent.split('\n');

  return [...before, ...newLines, ...after].join('\n');
}

/**
 * Fuegt Inhalt nach einer Zeile ein (0 = am Anfang einfuegen).
 * @param content   - Dateiinhalt als String
 * @param afterLine - Zeile nach der eingefuegt wird (0 = vor der ersten Zeile)
 * @param newContent - Einzufuegender Inhalt
 */
export function insertAfterLine(
  content: string,
  afterLine: number,
  newContent: string
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (afterLine < 0 || afterLine > totalLines) {
    throw new Error(`afterLine ${afterLine} ausserhalb des gueltigen Bereichs (0-${totalLines})`);
  }

  const before = lines.slice(0, afterLine);
  const after = lines.slice(afterLine);
  const newLines = newContent.split('\n');

  return [...before, ...newLines, ...after].join('\n');
}

/**
 * Loescht Zeilen aus einem String (1-basiert, inklusiv).
 * @param content   - Dateiinhalt als String
 * @param lineStart - Erste zu loeschende Zeile (1-basiert)
 * @param lineEnd   - Letzte zu loeschende Zeile (1-basiert, inklusiv)
 */
export function deleteLines(
  content: string,
  lineStart: number,
  lineEnd: number
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (lineStart < 1 || lineStart > totalLines) {
    throw new Error(`lineStart ${lineStart} ausserhalb des gueltigen Bereichs (1-${totalLines})`);
  }
  if (lineEnd < lineStart || lineEnd > totalLines) {
    throw new Error(`lineEnd ${lineEnd} ausserhalb des gueltigen Bereichs (${lineStart}-${totalLines})`);
  }

  const before = lines.slice(0, lineStart - 1);
  const after = lines.slice(lineEnd);

  return [...before, ...after].join('\n');
}

/**
 * Sucht und ersetzt einen String (alle Vorkommen).
 * Strategie (P15-T34: exakt VOR tolerant):
 *   1. Exaktes Match — gibt es exakte Treffer, zaehlen NUR diese
 *   2. Sonst Whitespace-tolerantes Regex-Matching ([ \t]+ statt festes Whitespace, z. B. Tab vs Spaces)
 *   3. Keine Matches: Fuzzy-Finder mit ähnlichen Zeilen
 * @param content - Dateiinhalt als String
 * @param search  - Suchstring
 * @param replace - Ersetzungsstring
 * @returns { content: string, count: number, fuzzyMatches?: FuzzyMatch[] }
 */
export function searchReplace(
  content: string,
  search: string,
  replace: string
): { content: string; count: number; fuzzyMatches?: FuzzyMatch[] } {
  const erst = searchReplaceRoh(content, search, replace);
  if (erst.count > 0) return erst;
  // CRLF-Datei, Suchtext mit blossem \n (Befund 29.09.2026): dieselbe Zeichenfolge mit \r\n
  // versuchen; der Ersatz uebernimmt dann die Zeilenenden der Datei (kein LF/CRLF-Gemisch).
  const crlfSuche = crlfVariante(content, search);
  if (!crlfSuche) return erst;
  const zweit = searchReplaceRoh(content, crlfSuche, alsCrlf(replace));
  return zweit.count > 0 ? zweit : erst;
}

/** Zeilenumbrueche eines Textes als \r\n (bestehende \r\n bleiben). */
function alsCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** CRLF-Variante eines Suchtexts — nur wenn die Datei \r\n nutzt und der Text blosse \n enthaelt. */
function crlfVariante(content: string, text: string): string | null {
  if (!text.includes('\n') || !content.includes('\r\n')) return null;
  const umgewandelt = alsCrlf(text);
  return umgewandelt === text ? null : umgewandelt;
}

function searchReplaceRoh(
  content: string,
  search: string,
  replace: string
): { content: string; count: number; fuzzyMatches?: FuzzyMatch[] } {
  if (!search) return { content, count: 0 };

  // Strategie 1 (P15-T34): exaktes Match zuerst. Vorher lief die tolerante Regex zuerst und machte
  // auch aus der FUEHRENDEN Einrueckung "beliebig viel": ein replace_all auf einen 10-eingerueckten
  // Block ersetzte die 8- und 6-eingerueckten Zwillinge mit (falsche Einrueckung), Folge-Edits fanden
  // dann "0-mal"; ein exakt einmal vorkommender Block galt als mehrdeutig (Plan 24845).
  const exakt = content.split(search);
  if (exakt.length > 1) {
    return { content: exakt.join(replace), count: exakt.length - 1 };
  }

  // Strategie 2: Whitespace-tolerantes Regex (Spaces/Tabs flexibel, Substring-basiert) — nur wenn es
  // keinen exakten Treffer gibt (Indentation-Unterschiede, Tab vs Spaces)
  const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexibleSearch = escapedSearch.replace(/[ \t]+/g, '[ \\t]+');

  try {
    const regex = new RegExp(flexibleSearch, 'g');
    const matchArr = content.match(regex);
    if (matchArr && matchArr.length > 0) {
      // Callback-Form (FILES-1): der Rueckgabewert einer Funktion wird NICHT als
      // Ersatzmuster interpretiert. Mit einem String-Ersatz wuerden die
      // Dollar-Sonderfolgen (Dollar vor Und-Zeichen, Backtick, Apostroph oder Ziffer)
      // expandiert und koennten die Datei still zerstoeren.
      return { content: content.replace(regex, () => replace), count: matchArr.length };
    }
  } catch {
    // Ungültiger Regex (edge case) — fall through zum Fuzzy-Finder
  }

  // Strategie 3: Fuzzy-Finder
  const fuzzyMatches = findSimilarLines(content, search);
  return { content, count: 0, fuzzyMatches };
}

/**
 * Startpositionen aller Vorkommen eines Suchstrings (gleiche Logik wie searchReplace: exakt zuerst,
 * Whitespace-tolerant nur ohne exakten Treffer — P15-T34).
 */
function trefferPositionen(content: string, search: string): number[] {
  if (!search) return [];
  const exakt: number[] = [];
  for (let i = content.indexOf(search); i !== -1; i = content.indexOf(search, i + search.length)) exakt.push(i);
  if (exakt.length > 0) return exakt;
  const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexibleSearch = escapedSearch.replace(/[ \t]+/g, '[ \\t]+');
  try {
    const positionen = Array.from(content.matchAll(new RegExp(flexibleSearch, 'g')), (m) => m.index ?? 0);
    if (positionen.length > 0) return positionen;
  } catch {
    // Ungültiger Regex — kein toleranter Treffer
  }
  return [];
}

/** 1-basierte Zeilennummern zu aufsteigenden Zeichenpositionen. */
function zeilenZuPositionen(content: string, positionen: number[]): number[] {
  const zeilen: number[] = [];
  let zeile = 1;
  let ab = 0;
  for (const pos of positionen) {
    for (let i = content.indexOf('\n', ab); i !== -1 && i < pos; i = content.indexOf('\n', i + 1)) zeile++;
    ab = pos;
    // ab muss hinter dem zuletzt gezaehlten \n liegen: der Scan oben beginnt bei ab neu
    zeilen.push(zeile);
  }
  return zeilen;
}

/**
 * Treffer eines Suchtexts mit Zeilennummern — dieselbe Logik wie searchReplace
 * (Whitespace-tolerant, bei 0 Treffern die CRLF-Variante). suche/ersatz sind die tatsaechlich
 * anzuwendenden Texte (bei CRLF-Treffer in CRLF-Form).
 */
export function findeTreffer(
  content: string,
  search: string,
  replace = ''
): { count: number; lines: number[]; suche: string; ersatz: string } {
  let suche = search;
  let ersatz = replace;
  let positionen = trefferPositionen(content, suche);
  if (positionen.length === 0) {
    const crlfSuche = crlfVariante(content, suche);
    const crlfPositionen = crlfSuche ? trefferPositionen(content, crlfSuche) : [];
    if (crlfSuche && crlfPositionen.length > 0) {
      suche = crlfSuche;
      ersatz = alsCrlf(ersatz);
      positionen = crlfPositionen;
    }
  }
  return { count: positionen.length, lines: zeilenZuPositionen(content, positionen), suche, ersatz };
}

/**
 * Handlungsleitende Fehlermeldung fuer einen search_replace-Suchtext, der nicht genau einmal
 * vorkommt (P15-T10). Nennt Trefferzahl und Zeilen und was der Agent tun soll.
 */
export function trefferFehlerMeldung(count: number, lines: number[], search: string): string {
  const vorschau = JSON.stringify(search.length > 80 ? `${search.slice(0, 80)}…` : search);
  if (count === 0) {
    return `Suchtext ${vorschau} kommt 0-mal vor — nichts geschrieben. Suchtext exakt aus dem aktuellen Dateiinhalt kopieren (code_intel file / files read).`;
  }
  const zeilen = lines.length > 30 ? `${lines.slice(0, 30).join(', ')}, … (${lines.length - 30} weitere)` : lines.join(', ');
  return `Suchtext ${vorschau} ist mehrdeutig: ${count} Treffer in Zeilen ${zeilen} — nichts geschrieben. `
    + `Suchtext um umgebende Zeilen erweitern, bis er genau einmal vorkommt, oder replace_all:true setzen, wenn wirklich alle ${count} Stellen ersetzt werden sollen.`;
}

/**
 * search_replace mit Eindeutigkeitspruefung (P15-T10): ohne replace_all muss der Suchtext genau
 * einmal vorkommen, mit replace_all mindestens einmal. Sonst ok:false, content unveraendert,
 * error mit Trefferzahl und Zeilen.
 */
export function searchReplaceEindeutig(
  content: string,
  search: string,
  replace: string,
  replaceAll = false
): { ok: boolean; content: string; count: number; lines: number[]; error?: string; fuzzyMatches?: FuzzyMatch[] } {
  const treffer = findeTreffer(content, search, replace);
  if (treffer.count === 0) {
    return { ok: false, content, count: 0, lines: [], error: trefferFehlerMeldung(0, [], search), fuzzyMatches: findSimilarLines(content, search) };
  }
  if (treffer.count > 1 && !replaceAll) {
    return { ok: false, content, count: treffer.count, lines: treffer.lines, error: trefferFehlerMeldung(treffer.count, treffer.lines, search) };
  }
  const ergebnis = searchReplace(content, search, replace);
  return { ok: true, content: ergebnis.content, count: ergebnis.count, lines: treffer.lines };
}

/**
 * P15-T34: Zusatz zur "0-mal"-Meldung, wenn der Suchtext im AUSGANGSSTAND vorkam und ein frueheres
 * Edit desselben Batches ihn schon ersetzt hat (Edits laufen nacheinander auf dem Zwischenstand).
 * Rechnet nur im Fehlerfall nach: die frueheren Edits erneut, bis der Text verschwindet.
 */
function verbrauchtVon(original: string, edits: BatchEdit[], index: number): string {
  const suche = edits[index].search;
  if (findeTreffer(original, suche).count === 0) return '';
  let stand = original;
  for (let k = 0; k < index; k++) {
    const t = findeTreffer(stand, edits[k].search, edits[k].replace);
    if (t.count === 0 || (t.count > 1 && !edits[k].replace_all)) continue;
    stand = searchReplaceRoh(stand, t.suche, t.ersatz).content;
    if (findeTreffer(stand, suche).count === 0) {
      return ` Hinweis: der Suchtext stand im Ausgangsstand, Edit ${k}${edits[k].replace_all ? ' (replace_all)' : ''} `
        + `hat ihn bereits ersetzt (Edits laufen nacheinander auf dem Zwischenstand) — Edits zusammenfassen oder Reihenfolge/Suchtexte anpassen.`;
    }
  }
  return '';
}

/**
 * Ein einzelnes Edit fuer searchReplaceBatch.
 */
export interface BatchEdit {
  search: string;
  replace: string;
  replace_all?: boolean;
}

/**
 * Ergebnis eines searchReplaceBatch-Aufrufs.
 */
export interface BatchResult {
  applied: number;
  skipped: number;
  total: number;
  /** Kompatibilitaet: je fehlgeschlagenem Edit ein Eintrag (reason "no_match" bzw. "multiple_matches (N occurrences)"). */
  warnings: Array<{ index: number; search_preview: string; reason: string }>;
  /** P15-T10: fehlgeschlagene Edits. Nicht leer = NICHTS angewendet, content ist der Original-Inhalt. */
  failed: BatchFehlschlag[];
}

/** Ein Edit aus searchReplaceBatch, dessen Suchtext nicht passt (P15-T10). */
export interface BatchFehlschlag {
  index: number;
  search_preview: string;
  reason: 'no_match' | 'multiple_matches';
  count: number;
  /** 1-basierte Zeilen der Treffer (leer bei no_match). */
  lines: number[];
  /** Handlungsleitende Meldung: was der Agent tun soll. */
  message: string;
}

/**
 * Fuehrt mehrere Search-Replace-Edits sequenziell auf einem Content durch.
 * Liest das File 1× im Speicher, schreibt am Ende 1×.
 *
 * Verhalten (atomar, P15-T10 — vorher continue-with-warnings: mehrdeutige oder fehlende Suchtexte
 * wurden still uebersprungen und die Aufrufer schrieben den Rest trotzdem):
 *   - 1 Treffer (oder replace_all + mindestens 1 Treffer) → angewendet
 *   - 0 Treffer                → failed, reason "no_match"
 *   - N>1 ohne replace_all     → failed, reason "multiple_matches" mit Zeilen
 *   - Ist irgendein Edit fehlgeschlagen, kommt der ORIGINAL-Inhalt zurueck (applied 0,
 *     skipped = total). Alle Edits werden trotzdem geprueft, damit jeder Fehler auf einmal
 *     gemeldet wird. Aufrufer schreiben bei failed.length > 0 nichts.
 *
 * @param content - Dateiinhalt als String
 * @param edits   - Array von BatchEdit
 * @returns { content: string; result: BatchResult }
 */
export function searchReplaceBatch(
  content: string,
  edits: BatchEdit[]
): { content: string; result: BatchResult } {
  let current = content;
  let applied = 0;
  const warnings: BatchResult['warnings'] = [];
  const failed: BatchFehlschlag[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const search_preview = edit.search.slice(0, 80);
    // Dieselbe Trefferlogik wie searchReplace (Whitespace-tolerant, CRLF-Variante).
    const treffer = findeTreffer(current, edit.search, edit.replace);
    if (treffer.count === 0 || (treffer.count > 1 && !edit.replace_all)) {
      const reason = treffer.count === 0 ? 'no_match' : 'multiple_matches';
      failed.push({
        index: i,
        search_preview,
        reason,
        count: treffer.count,
        lines: treffer.lines,
        message: `Edit ${i}: ${trefferFehlerMeldung(treffer.count, treffer.lines, edit.search)}`
          + (treffer.count === 0 ? verbrauchtVon(content, edits, i) : ''),
      });
      warnings.push({
        index: i,
        search_preview,
        reason: reason === 'no_match' ? 'no_match' : `multiple_matches (${treffer.count} occurrences)`,
      });
      continue;
    }
    current = searchReplaceRoh(current, treffer.suche, treffer.ersatz).content;
    applied++;
  }

  if (failed.length > 0) {
    return { content, result: { applied: 0, skipped: edits.length, total: edits.length, warnings, failed } };
  }
  return { content: current, result: { applied, skipped: 0, total: edits.length, warnings, failed } };
}

/**
 * Berechnet den SHA-256 Hash eines Strings.
 */
/** sha256 des leeren Strings — Marker fuer "Datei existierte vorher nicht". */
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ─── PG-Operationen ───────────────────────────────────────────────────────────

/**
 * Erstellt eine neue Datei in code_files (INSERT) und startet parseAndEmbed fire-and-forget.
 */
/**
 * Obergrenze fuer den Text, der an die Fehlermuster-Pruefung geht.
 *
 * Eine ganze Quelldatei zu embedden kostet Rechenzeit auf dem Ollama-Server und
 * bringt nichts: ein einzelner Vektor ueber 91 KB verwischt jedes konkrete
 * Muster. Gemessen am 2026-07-26 rund 0,24 ms pro Zeichen — bei 233 KB also ueber
 * 50 Sekunden fuer eine Auskunft, die niemand gelesen hat.
 */
const PRUEFTEXT_MAX_ZEICHEN = 4000;

/** Kontext links und rechts der Aenderung, damit ein Muster erkennbar bleibt. */
const PRUEFTEXT_KONTEXT = 200;

/**
 * Liefert den tatsaechlich geaenderten Abschnitt zwischen zwei Staenden.
 *
 * Gemeinsamer Anfang und gemeinsames Ende werden abgeschnitten, uebrig bleibt
 * genau die Aenderung — plus etwas Kontext, weil ein Fehlermuster sonst nicht
 * wiederzuerkennen ist. Das ist O(n) mit winzigem Faktor und braucht keinen
 * Diff-Algorithmus.
 *
 * Das Ergebnis ist nicht nur kuerzer, sondern TRENNSCHAERFER als der alte
 * Gesamtinhalt: ein Vektor ueber zehn geaenderte Zeilen trifft ein Muster,
 * einer ueber die ganze Datei mittelt es weg.
 *
 * Leeres Ergebnis heisst: nichts geaendert, also nichts zu pruefen.
 */
function geaenderterAbschnitt(alt: string, neu: string): string {
  if (!alt) return neu.slice(0, PRUEFTEXT_MAX_ZEICHEN);

  const kuerzere = Math.min(alt.length, neu.length);
  let start = 0;
  while (start < kuerzere && alt[start] === neu[start]) start++;

  let endeAlt = alt.length;
  let endeNeu = neu.length;
  while (endeAlt > start && endeNeu > start && alt[endeAlt - 1] === neu[endeNeu - 1]) {
    endeAlt--;
    endeNeu--;
  }

  if (endeNeu <= start && endeAlt <= start) return ''; // identisch

  const von = Math.max(0, start - PRUEFTEXT_KONTEXT);
  const bis = Math.min(neu.length, endeNeu + PRUEFTEXT_KONTEXT);
  return neu.slice(von, bis).slice(0, PRUEFTEXT_MAX_ZEICHEN);
}

/**
 * Startet die Fehlermuster-Pruefung, ohne auf sie zu warten.
 *
 * Nebenlaeufig, weil ein Embedding im synchronen Schreibpfad nichts zu suchen hat:
 * es lag dort VOR der ersten PG-Verbindung und hat nicht die Datenbank aufgehalten,
 * sondern die Antwort des Tools. Treffer landen im Log, nicht im Rueckgabewert —
 * der Schreibvorgang ist vorbei, bevor das Ergebnis eintrifft.
 */
function pruefeFehlermusterNebenlaeufig(pruefText: string, agentId: string, filePath: string): void {
  if (!pruefText.trim()) return;
  const pruefung = checkErrorPatterns(pruefText, agentId);
  // P15-T17 E0: Treffer fuer die Auslieferung an den Agenten vormerken (naechste Tool-Antwort).
  verfolgeFehlermusterPruefung(agentId, filePath, pruefung);
  void pruefung
    .then((treffer) => {
      for (const w of treffer) {
        console.error('[code-write] Fehlermuster (' + w.severity + ') bei ' + filePath + ': ' + w.description);
      }
    })
    .catch(() => { /* nebenlaeufig — ein Fehler hier darf den Schreibvorgang nicht beruehren */ });
}

/**
 * P15-T17 (User-Regel E-a): Optionen des Einzelschreibwegs (files create/update/search_replace/
 * replace_lines/insert_after/delete_lines). einzelweg:true schaltet die Syntaxpruefung VOR dem Schreiben
 * ein: ein Befund eines sperrfaehigen Pruefers in geaenderten Zeilen lehnt ab (SyntaxfehlerAbgelehnt,
 * nichts geschrieben). Pruefer docken mit P16-T4 an (registriereSyntaxPruefer); bis dahin ist nur die
 * Musterpruefung aktiv. Plan-Commits, Restore und FS-Sync setzen einzelweg NICHT.
 * quittieren: Absichtsgrund fuer absichtlich fehlerhaften Inhalt (E-b), landet in file_versions.reason.
 */
export interface EinzelSchreibOptionen {
  einzelweg?: boolean;
  quittieren?: string;
}

/** Ergebnis von createFileInPg/updateFileInPg. befunde = Signatur-Treffer und Syntax-Hinweise (auch ausgeliefert). */
export interface SchreibErgebnis {
  warnings?: ErrorPatternWarning[];
  befunde?: FehlerBefund[];
  released_reservations?: Array<{ agent_id: string; file_path: string; reason: string }>;
}

/** Syntaxpruefung vor dem Schreiben (nur Einzelweg). Wirft SyntaxfehlerAbgelehnt bei sperrendem Befund. */
async function syntaxVorDemSchreiben(
  filePath: string,
  alt: string,
  neu: string,
  agentId: string | null,
  einzel: EinzelSchreibOptionen | undefined,
  project?: string,
): Promise<{ hinweise: FehlerBefund[]; quittiert?: string }> {
  if (!einzel?.einzelweg) return { hinweise: [] };
  // P16-T5 E3a: stand = dieser Schreibvorgang. Nachlieferungen tragen ihn; ein spaeterer durchgelaufener
  // Schreibvorgang derselben Datei ueberholt sie (sie haengen dann nicht an fremden, gueltigen Antworten).
  const stand = Date.now();
  const erg = await pruefeSyntaxEinzelweg({
    filePath, alt, neu, quittieren: einzel.quittieren,
    onNachgereicht: (befunde) => vormerkenBefunde(agentId, filePath, befunde, { stand }),
  });
  if (erg.blockierend.length > 0) {
    // P15-T33 E1: Fehlerpfad -> Erklaerungs-Topf. Nur einreihen (kein await, kein PG, kein Jev) - kein Zuschlag.
    if (project) meldeFehlerfall({ project, agent_id: agentId, befund: erg.blockierend[0], basis: alt, ergebnis: neu, weg: 'einzelweg' });
    throw new SyntaxfehlerAbgelehnt(filePath, erg.blockierend);
  }
  if (erg.status !== 'keine_pruefer') ueberholeSyntaxBefunde(agentId, filePath, stand);
  return { hinweise: erg.hinweise, quittiert: erg.quittiert };
}

/** Signatur-Muster nach dem Schreiben: Befunde zurueckgeben und fuer die Tool-Antwort vormerken. Wirft nie. */
async function befundeNachDemSchreiben(
  project: string,
  filePath: string,
  alt: string,
  neu: string,
  agentId: string,
  restoreVersionId: string | null,
  zusatz: FehlerBefund[],
): Promise<FehlerBefund[]> {
  const befunde = [...zusatz, ...(await pruefeSignaturen({ project, filePath, alt, neu, restoreVersionId }))];
  vormerkenBefunde(agentId, filePath, befunde);
  return befunde;
}

export async function createFileInPg(
  project: string,
  filePath: string,
  content: string,
  agentId?: string,
  reason?: string,
  batchId?: number,
  editAction?: string,
  enrichment?: VersionEnrichment,
  einzel?: EinzelSchreibOptionen
): Promise<SchreibErgebnis> {
  const resolvedAgentId = resolveAgentId(agentId);
  const taskId = enrichment?.task_id != null ? await resolveProjectTaskId(project, enrichment.task_id) : null;
  let warnings: ErrorPatternWarning[] | undefined;
  // P15-T17 E-a: Syntaxfehler lehnen den Einzelschreibvorgang ab, bevor etwas geschrieben wird.
  const syntax = await syntaxVorDemSchreiben(filePath, '', content, resolvedAgentId, einzel, project);
  reason = quittierVermerk(reason, syntax.quittiert);
  // Neue Datei: alles daran ist neu, der Anfang steht also fuer die Aenderung.
  // Trotzdem gedeckelt — auch eine frisch angelegte Datei kann gross sein.
  if (resolvedAgentId) {
    pruefeFehlermusterNebenlaeufig(content.slice(0, PRUEFTEXT_MAX_ZEICHEN), resolvedAgentId, filePath);
  }

  const { v4: uuidv4 } = await import('uuid');
  const pool = getPool();

  const fileName = filePath.split('/').pop() ?? filePath;
  const fileType = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
  const hash = contentHash(content);
  const fileSize = Buffer.byteLength(content, 'utf8');

  await pool.query(
    `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, chunk_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NOW())
     ON CONFLICT (project, file_path) DO UPDATE
       SET content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           file_size = EXCLUDED.file_size,
           deleted_at = NULL,
           updated_at = NOW()`,
    [uuidv4(), project, filePath, fileName, fileType, content, hash, fileSize]
  );

  // Marker-Snapshot in file_versions damit "history" die Erstellung sieht.
  // content='' weil "vorher gab es nichts". reason ist optional, edit_action="create".
  // Bei UPSERT auf eine schon existierende Datei waere das missweisend — daher nur
  // schreiben wenn KEIN Konflikt war (content_hash hat sich geaendert).
  // Wir koennten das genauer pruefen, aber pragmatisch: immer einen Marker schreiben.
  // Der spaetere "echte" Snapshot via updateFileInPg fuegt sich nahtlos an.
  try {
    const marker = await pool.query<{ id: string }>(
      `INSERT INTO file_versions (project, file_path, content, content_hash, edit_action, agent_id, batch_id, size_bytes, reason, feature_tag, parent_version_id, git_commit_sha, agent_note, task_id)
       VALUES ($1, $2, '', $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12) RETURNING id::text AS id`,
      [
        project,
        filePath,
        EMPTY_HASH,
        editAction ?? 'create',
        resolvedAgentId,
        batchId ?? null,
        reason ?? null,
        enrichment?.feature_tag ?? null,
        enrichment?.parent_version_id ?? null,
        enrichment?.git_commit_sha ?? null,
        enrichment?.agent_note ?? null,
        taskId,
      ]
    );
    if (marker.rows[0]) merkeFileTaskVersion({ id: marker.rows[0].id, file_path: filePath, task_id: taskId, edit_action: editAction ?? 'create' });
  } catch { /* Tabelle existiert in alten Schemata vlt nicht — best-effort */ }

  enqueueParseAndEmbed(project, filePath);

  const released_reservations = batchId === undefined && resolvedAgentId
    ? await releasePlanlessReservationsAfterSingleWrite(project, resolvedAgentId)
    : [];

  // P15-T17: Signatur-Muster (geschrieben wird trotzdem, error wird deutlich gemeldet).
  let befunde: FehlerBefund[] = [];
  if (resolvedAgentId && resolvedAgentId !== FS_AGENT_ID) {
    befunde = await befundeNachDemSchreiben(project, filePath, '', content, resolvedAgentId, null, syntax.hinweise);
  }

  return {
    ...(warnings?.length ? { warnings } : {}),
    ...(befunde.length ? { befunde } : {}),
    ...(released_reservations.length ? { released_reservations } : {}),
  };
}

/**
 * Aktualisiert den Inhalt einer Datei in code_files (UPDATE) und startet parseAndEmbed fire-and-forget.
 *
 * Versionierungs-Hook: Vor dem Schreiben wird der bisherige Inhalt — sofern vorhanden und vom
 * neuen Inhalt verschieden — in `file_versions` gesichert. Snapshot + Update laufen in einer
 * Transaktion, damit es bei parallelen Writes keine Race-Condition gibt.
 *
 * @param editAction optional, beschreibt die Aenderungsart (z.B. "update", "search_replace",
 *                   "replace_lines"). Hilft beim Lesen der Versionshistorie.
 * @param batchId    optional, gruppiert mehrere Versionseintraege zu einem Multi-File-Edit
 *                   (relevant ab Schritt 2 — Multi-File-Plan/Commit).
 */
export async function updateFileInPg(
  project: string,
  filePath: string,
  newContent: string,
  agentId?: string,
  editAction?: string,
  batchId?: number,
  reason?: string,
  enrichment?: VersionEnrichment,
  einzel?: EinzelSchreibOptionen
): Promise<SchreibErgebnis> {
  const resolvedAgentId = resolveAgentId(agentId);
  const taskId = enrichment?.task_id != null ? await resolveProjectTaskId(project, enrichment.task_id) : null;
  let warnings: ErrorPatternWarning[] | undefined;
  // P15-T17 E-a: Syntaxpruefung vor dem Schreiben (nur Einzelweg und nur, wenn fuer die Endung ein
  // Pruefer registriert ist - sonst wird der alte Inhalt gar nicht erst gelesen).
  let syntax: { hinweise: FehlerBefund[]; quittiert?: string } = { hinweise: [] };
  if (einzel?.einzelweg && hatSyntaxPruefer(filePath)) {
    const vorher = (await getFileContentFromPg(project, filePath)) ?? '';
    syntax = await syntaxVorDemSchreiben(filePath, vorher, newContent, resolvedAgentId, einzel, project);
    reason = quittierVermerk(reason, syntax.quittiert);
  }
  // Die Fehlermuster-Pruefung laeuft NEBENLAEUFIG — ein Embedding hat im
  // synchronen Schreibpfad nichts zu suchen.
  //
  // checkErrorPatterns embeddet den uebergebenen Inhalt ungekuerzt. Gemessen am
  // 2026-07-25: 22 KB brauchten 5,0 s, 91 KB brauchten 21,7 s, ein
  // search_replace auf derselben Datei 41,8 s — Groessenfaktor 4,1 bei
  // Zeitfaktor 4,3, also etwa 0,24 ms pro Zeichen. Der Aufruf lag VOR der ersten
  // PG-Verbindung: die Datenbank war nie blockiert, nur die Antwort des Tools.
  // Da ein Multi-File-Plan mit auto_commit jede Datei einzeln committet, summierte
  // sich das ungebremst — 60 Parser-Dateien dauerten rund 33 Minuten statt Sekunden.
  //
  // FS-Aenderungen bleiben ausgenommen: die Pruefung zielt auf agentengeschriebenen
  // Inhalt, nicht auf Editor-Speicherungen. Treffer landen jetzt im Log, nicht mehr
  // im Rueckgabewert — der Schreibvorgang ist vorbei, bevor das Ergebnis da ist.
  // Die Pruefung steht weiter unten, nach dem Commit: erst dort liegt der alte
  // Inhalt aus dem Versions-Snapshot vor, und nur damit laesst sich der geaenderte
  // Abschnitt bestimmen.

  const pool = getPool();

  const hash = contentHash(newContent);
  const fileSize = Buffer.byteLength(newContent, 'utf8');

  const client = await pool.connect();
  let rowCount = 0;
  let alterInhalt: string | undefined;
  let versionIdVorher: string | undefined;
  try {
    await client.query('BEGIN');

    // Snapshot: alten Inhalt sichern — nur wenn vorhanden UND vom neuen verschieden.
    // Verhindert Versions-Spam durch idempotente Writes (gleicher Inhalt 2x geschrieben).
    //
    // RETURNING liefert den alten Stand gleich mit: damit kennt die Fehlermuster-
    // Pruefung weiter unten den geaenderten Abschnitt, ohne eine zweite Abfrage.
    // Bleibt die Zeile aus, war der Inhalt unveraendert — dann gibt es nichts zu pruefen.
    const schnappschuss = await client.query<{ id: string; content: string }>(
      `INSERT INTO file_versions (project, file_path, content, content_hash, edit_action, agent_id, batch_id, size_bytes, reason, feature_tag, parent_version_id, git_commit_sha, agent_note, task_id)
       SELECT cf.project, cf.file_path, cf.content, cf.content_hash, $3, $4, $5,
              COALESCE(cf.file_size, OCTET_LENGTH(cf.content)), $7, $8, $9, $10, $11, $12
       FROM code_files cf
       WHERE cf.project = $1
         AND cf.file_path = $2
         AND cf.content IS NOT NULL
         AND cf.content_hash IS DISTINCT FROM $6
       RETURNING id::text AS id, content`,
      [
        project,
        filePath,
        editAction ?? 'update',
        resolvedAgentId,
        batchId ?? null,
        hash,
        reason ?? null,
        enrichment?.feature_tag ?? null,
        enrichment?.parent_version_id ?? null,
        enrichment?.git_commit_sha ?? null,
        enrichment?.agent_note ?? null,
        taskId,
      ]
    );

    const result = await client.query(
      `UPDATE code_files
       SET content = $3, content_hash = $4, file_size = $5, updated_at = NOW()
       WHERE project = $1 AND file_path = $2`,
      [project, filePath, newContent, hash, fileSize]
    );
    rowCount = result.rowCount ?? 0;
    alterInhalt = schnappschuss.rows[0]?.content;
    versionIdVorher = schnappschuss.rows[0]?.id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* ignore rollback failure */ });
    throw err;
  } finally {
    client.release();
  }

  if (versionIdVorher) merkeFileTaskVersion({ id: versionIdVorher, file_path: filePath, task_id: taskId, edit_action: editAction ?? 'update' });
  if (rowCount === 0) {
    console.error(`[code-write] updateFileInPg: Keine Datei gefunden fuer ${project}/${filePath}`);
  }

  // Geprueft wird nur der geaenderte Abschnitt, nicht die ganze Datei. Fehlt die
  // Snapshot-Zeile, war der Inhalt identisch — dann gibt es nichts zu pruefen.
  let befunde: FehlerBefund[] = [];
  if (resolvedAgentId && resolvedAgentId !== FS_AGENT_ID && alterInhalt !== undefined) {
    pruefeFehlermusterNebenlaeufig(geaenderterAbschnitt(alterInhalt, newContent), resolvedAgentId, filePath);
    // P15-T17: Signatur-Muster synchron auf den geaenderten Zeilen (geschrieben wird trotzdem).
    befunde = await befundeNachDemSchreiben(project, filePath, alterInhalt, newContent, resolvedAgentId,
      versionIdVorher ?? null, syntax.hinweise);
  }

  enqueueParseAndEmbed(project, filePath);

  const released_reservations = batchId === undefined && resolvedAgentId
    ? await releasePlanlessReservationsAfterSingleWrite(project, resolvedAgentId)
    : [];
  return {
    ...(warnings?.length ? { warnings } : {}),
    ...(befunde.length ? { befunde } : {}),
    ...(released_reservations.length ? { released_reservations } : {}),
  };
}

async function releasePlanlessReservationsAfterSingleWrite(project: string, agentId: string) {
  const pool = getPool();
  const { rows } = await pool.query<{ agent_id: string; file_path: string }>(
    `UPDATE file_reservations SET released_at = NOW()
      WHERE project = $1 AND agent_id = $2 AND plan_id IS NULL AND released_at IS NULL
      RETURNING agent_id, file_path`,
    [project, agentId],
  );
  if (rows.length > 0) {
    const batch = await import('./file-batch.js');
    batch.notifyReservationWaiters();
    await batch.replanUnblockedReservationWaits(project, rows.map((r) => r.file_path));
  }
  return rows.map((row) => ({ ...row, reason: 'freigegeben nach eigenem Commit' }));
}

/**
 * SYNC-1b: Sichert den AKTUELLEN Stand einer Datei als file_versions-Eintrag,
 * ohne sie zu veraendern.
 *
 * Gedacht fuer Vorgaenge, die den Inhalt nicht ersetzen, sondern ihn oder seinen
 * Ort verschwinden lassen — Loeschen und Verschieben auf dem Dateisystem. Ohne
 * diesen Schnappschuss waeren beide im Tray unsichtbar und nicht rueckholbar.
 *
 * MUSS VOR der eigentlichen Mutation aufgerufen werden: danach ist der Inhalt
 * (beim Loeschen) bzw. der alte Pfad (beim Verschieben) nicht mehr greifbar.
 *
 * Liefert true, wenn ein Eintrag entstanden ist (Datei war bekannt und hatte Inhalt).
 */
export async function snapshotFileVersion(
  project: string,
  filePath: string,
  editAction: string,
  reason: string,
  agentId: string = FS_AGENT_ID,
  taskRef?: string,
): Promise<boolean> {
  const taskId = taskRef !== undefined ? await resolveProjectTaskId(project, taskRef) : null;
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO file_versions
       (project, file_path, content, content_hash, edit_action, agent_id, size_bytes, reason, task_id)
     SELECT cf.project, cf.file_path, cf.content, cf.content_hash, $3, $4,
            COALESCE(cf.file_size, OCTET_LENGTH(cf.content)), $5, $6
       FROM code_files cf
      WHERE cf.project = $1 AND cf.file_path = $2 AND cf.content IS NOT NULL
      RETURNING id::text AS id`,
    [project, filePath, editAction, agentId, reason, taskId]
  );
  for (const row of res.rows) merkeFileTaskVersion({ id: row.id, file_path: filePath, task_id: taskId, edit_action: editAction });
  return (res.rowCount ?? 0) > 0;
}

/**
 * Setzt deleted_at = NOW() fuer eine Datei (Soft-Delete, kein echtes Loeschen).
 */
export async function softDeleteFile(
  project: string,
  filePath: string
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE code_files
     SET deleted_at = NOW()
     WHERE project = $1 AND file_path = $2`,
    [project, filePath]
  );
}

/**
 * Verschiebt eine Datei: aktualisiert file_path in allen Tabellen (Transaktion).
 * Reihenfolge: code_symbols, code_references, code_chunks → code_files (FK-Ordnung).
 * Danach: alte Qdrant-Vektoren loeschen + parseAndEmbed fuer neuen Pfad.
 */
export async function moveFileInPg(
  project: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // FK-Checks erst beim COMMIT pruefen — erlaubt Updates in beliebiger Reihenfolge
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    // code_files ZUERST (Ziel-Pfad muss existieren fuer FKs)
    await client.query(
      `UPDATE code_files
       SET file_path = $3, updated_at = NOW(), parsed_at = NULL
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    await client.query(
      `UPDATE code_symbols
       SET file_path = $3
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    await client.query(
      `UPDATE code_references
       SET file_path = $3
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    await client.query(
      `UPDATE code_chunks
       SET file_path = $3
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    // Tombstone fuer alten Pfad — der PG-Watcher unlinkt die Datei von Disk
    // und loescht den Tombstone-Row danach selbst. Ohne diesen Schritt bleibt
    // die alte Datei nach einem Move auf Disk liegen.
    const tombstoneId = crypto.randomUUID();
    const fileName = oldPath.split('/').pop() || oldPath;
    const fileType = (fileName.includes('.') ? fileName.split('.').pop() : 'txt') || 'txt';
    await client.query(
      `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, deleted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, NOW(), NOW())
       ON CONFLICT (project, file_path) DO UPDATE
         SET deleted_at = NOW(), updated_at = NOW()`,
      [tombstoneId, project, oldPath, fileName, fileType]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Alte Qdrant-Vektoren loeschen
  const collection = COLLECTIONS.projectCode(project);
  deleteByFilePath(collection, oldPath, project).catch((err: unknown) =>
    console.error(`[code-write] Qdrant deleteByFilePath Fehler fuer ${oldPath}:`, err)
  );

  // parseAndEmbed fuer neuen Pfad
  enqueueParseAndEmbed(project, newPath);
}

/**
 * Kopiert eine Datei: liest den Inhalt der Quelldatei und erstellt eine neue Datei via createFileInPg.
 */
export async function copyFileInPg(
  project: string,
  sourcePath: string,
  targetPath: string,
  agentId?: string,
  taskRef?: string,
): Promise<{ warnings?: ErrorPatternWarning[] }> {
  const sourceContent = await getFileContentFromPg(project, sourcePath);
  if (sourceContent === null) {
    throw new Error(`Quelldatei nicht gefunden: ${sourcePath}`);
  }
  return createFileInPg(project, targetPath, sourceContent, agentId, undefined, undefined, undefined, taskRef !== undefined ? { task_id: taskRef } : undefined);
}

/**
 * Liest den Inhalt einer Datei aus code_files.
 * @returns content als string oder null wenn nicht gefunden
 */
export async function getFileContentFromPg(
  project: string,
  filePath: string
): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query<{ content: string }>(
    `SELECT content FROM code_files
     WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [project, filePath]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0].content;
}
