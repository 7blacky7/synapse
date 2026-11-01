/**
 * P22-T266 (User 01.11.2026: „syntax highlights … für jede syntax“): CodeMirror-6-Kern des Editors. Dieses Modul wird NUR per
 * dynamischem import() geladen (CodeFeld.tsx, hervorhebung.tsx), damit CodeMirror nicht im Haupt-Chunk landet; Sprachen laden
 * @codemirror/language-data einzeln nach (eigene Chunks).
 * - sprachBeschreibung/ladeSprache: Sprache aus Dateiname/Endung (LanguageDescription.matchFilename, auch Dockerfile/Makefile);
 *   unbekannt -> null = Klartext, kein Fehler. Je Sprache genau ein Ladevorgang (Cache), Ladefehler -> null.
 * - zeilenTokens: Nur-Lese-Ansichten (Schatten, Committet, Drei-Wege, Verlauf) - Token je Zeile ueber highlightCode mit
 *   classHighlighter (Klassen tok-*), damit Zeilennummern und Markierungen der Ansichten unveraendert bleiben.
 * - erzeugeEditor: minimal zusammengesetzter Editor (kein basicSetup): Zeilennummern, aktive Zeile, Undo/Redo, Klammerpaare,
 *   Einruecken, Schreibschutz umschaltbar; Farben ueber dieselben tok-*-Klassen (editor-syntax-p22-t266.css, nur Theme-Tokens).
 */
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { LanguageDescription, syntaxHighlighting, indentOnInput, bracketMatching, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightCode, classHighlighter } from '@lezer/highlight';

export type Token = { text: string; cls: string };
/** Ueber dieser Laenge bleibt eine Nur-Lese-Ansicht Klartext (Parsen grosser Dateien bei jedem Live-Abgleich waere zu teuer). */
export const HERVORHEBUNG_MAX_ZEICHEN = 400_000;

const dateiname = (pfad: string) => pfad.slice(pfad.lastIndexOf('/') + 1);
export function sprachBeschreibung(pfad: string): LanguageDescription | null {
  if (!pfad) return null;
  return LanguageDescription.matchFilename(languages, dateiname(pfad));
}
const cache = new Map<string, Promise<LanguageSupport | null>>();
export function ladeSprache(pfad: string): Promise<LanguageSupport | null> {
  const d = sprachBeschreibung(pfad);
  if (!d) return Promise.resolve(null);
  let p = cache.get(d.name);
  if (!p) { p = d.load().catch(() => null); cache.set(d.name, p); }
  return p;
}
export function sprachName(pfad: string): string | null { return sprachBeschreibung(pfad)?.name ?? null; }

/** Token je Zeile (Zeilen wie text.split('\n')); Klasse '' = ungefaerbter Text. */
export function zeilenTokens(text: string, sprache: LanguageSupport): Token[][] | null {
  if (text.length > HERVORHEBUNG_MAX_ZEICHEN) return null;
  const zeilen: Token[][] = [[]];
  const baum = sprache.language.parser.parse(text);
  highlightCode(text, baum, classHighlighter, (t, cls) => { zeilen[zeilen.length - 1].push({ text: t, cls }); }, () => { zeilen.push([]); });
  return zeilen;
}

export interface EditorGriff {
  setzeWert(wert: string): void;
  setzeLesend(lesend: boolean): void;
  setzeSprache(sprache: LanguageSupport | null): void;
  zerstoeren(): void;
}
export function erzeugeEditor(ort: HTMLElement, o: { wert: string; lesend: boolean; label: string; onChange: (wert: string) => void }): EditorGriff {
  const sprache = new Compartment(), schutz = new Compartment();
  let extern = false;
  const schreibschutz = (lesend: boolean) => [EditorState.readOnly.of(lesend), EditorView.editable.of(!lesend)];
  const view = new EditorView({
    parent: ort,
    state: EditorState.create({
      doc: o.wert,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), indentOnInput(), bracketMatching(),
        syntaxHighlighting(classHighlighter),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': o.label, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        sprache.of([]), schutz.of(schreibschutz(o.lesend)),
        EditorView.updateListener.of((u) => { if (u.docChanged && !extern) o.onChange(u.state.doc.toString()); }),
      ],
    }),
  });
  return {
    setzeWert(wert) {
      const alt = view.state.doc.toString();
      if (alt === wert) return;
      extern = true;
      // H4 (Abnahme 6d46d12a): externer Wertwechsel (z. B. Freeze loesen/fortsetzen) gehoert nicht in die Undo-Historie.
      try { view.dispatch({ changes: { from: 0, to: alt.length, insert: wert }, annotations: Transaction.addToHistory.of(false) }); } finally { extern = false; }
    },
    setzeLesend(lesend) { view.dispatch({ effects: schutz.reconfigure(schreibschutz(lesend)) }); },
    setzeSprache(s) { view.dispatch({ effects: sprache.reconfigure(s ?? []) }); },
    zerstoeren() { view.destroy(); },
  };
}
