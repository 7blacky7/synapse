/**
 * P22-T266: Syntax-Hervorhebung im Editor - ohne DB, Netz und Browser.
 *   node --experimental-strip-types packages/web-ui/tests/editor-syntax-p22-t266.test.mjs
 * Herkunft: User 01.11.2026 „syntax highlights … für jede syntax“, Task P22-T266, Bestand/Bibliothekswahl 2be3ef10 (CodeMirror 6).
 * Sichert ab:
 *   A components/editor/syntax.ts (echtes CodeMirror/Lezer aus node_modules): Sprache aus Endung UND Dateiname, unbekannt = null,
 *     Lezer-Sprachen und Legacy-Modi liefern Token je Zeile (Zeilen wie split('\n'), Text vollstaendig), Grenze fuer grosse Texte.
 *   B editor-syntax-p22-t266.css: nur Theme-Variablen (hell/dunkel), tok-*-Klassen fuer die wichtigsten Arten, CodeMirror-Rahmen.
 *   C Einbindung: CodeMirror NUR in syntax.ts (sonst nur import type bzw. dynamisches import()), Schalter editor_syntax liest
 *     ProjektEditor, AUS = Textfeld aus P22-T262, Rueckfall bei Ladefehler; alle Code-Ansichten (Bearbeiten, Schatten, Pins,
 *     Committet, Drei-Wege) hervorgehoben.
 *   D core: Produkt-Schalter editor_syntax im Katalog, Standard AUS, nur ausdruecklich.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// ---------------------------------------------------------------- A syntax.ts
const S = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/editor/syntax.ts')).href);
const Q = 'P22-T266 syntax.ts';
ok(S.sprachName('packages/web-ui/src/a.ts') === 'TypeScript' && S.sprachName('x/Komponente.tsx') === 'TSX', Q + ': TypeScript/TSX aus der Endung', [S.sprachName('a.ts'), S.sprachName('a.tsx')]);
ok(S.sprachName('tools/Dockerfile') === 'Dockerfile', Q + ': Sprache aus dem Dateinamen ohne Endung (Dockerfile)', S.sprachName('Dockerfile'));
ok(['a.py', 'a.rs', 'a.go', 'a.sql', 'a.css', 'a.json', 'a.md', 'a.sh', 'a.yaml', 'a.java', 'a.cpp', 'a.lua'].every((p) => S.sprachName(p)), Q + ': viele Sprachen erkannt', ['a.py', 'a.rs', 'a.go', 'a.sql', 'a.css', 'a.json', 'a.md', 'a.sh', 'a.yaml', 'a.java', 'a.cpp', 'a.lua'].map((p) => [p, S.sprachName(p)]));
ok(S.sprachBeschreibung('daten.xyzunbekannt') === null && S.sprachBeschreibung('') === null, Q + ': unbekannte Sprache = null (Klartext, kein Fehler)');
const code = 'def f(x):\n    # Kommentar\n    return "a" + 1\n';
const py = await S.ladeSprache('a.py');
ok(py && (await S.ladeSprache('b.py')) === py, Q + ': Sprache wird einmal geladen und gecacht');
const zeilen = S.zeilenTokens(code, py);
ok(zeilen.length === code.split('\n').length, Q + ': Zeilenzahl wie split(\\n)', [zeilen.length, code.split('\n').length]);
ok(zeilen.every((z, i) => z.map((t) => t.text).join('') === code.split('\n')[i]), Q + ': Token ergeben den Zeilentext vollstaendig', zeilen);
const klassen = zeilen.flat().map((t) => t.cls).join(' ');
ok(/tok-keyword/.test(klassen) && /tok-comment/.test(klassen) && /tok-string/.test(klassen) && /tok-number/.test(klassen), Q + ': Python-Token mit Klassen keyword/comment/string/number', klassen);
const lua = await S.ladeSprache('skript.lua');
const luaZ = S.zeilenTokens('local x = 1 -- k', lua);
ok(lua && /tok-keyword/.test(luaZ.flat().map((t) => t.cls).join(' ')), Q + ': Legacy-Modus (Lua) liefert ebenfalls Token', luaZ);
ok(S.zeilenTokens('x'.repeat(S.HERVORHEBUNG_MAX_ZEICHEN + 1), py) === null, Q + ': sehr grosse Texte bleiben Klartext');

// H4 (Abnahme 6d46d12a): externer Wertwechsel landet nicht in der Undo-Historie.
const sx = lies('packages/web-ui/src/components/editor/syntax.ts');
ok(/setzeWert\(wert\) \{[\s\S]*?annotations: Transaction\.addToHistory\.of\(false\)/.test(sx) && /import \{ EditorState, Compartment, Transaction \} from '@codemirror\/state'/.test(sx), Q + ': setzeWert ohne Undo-Historie (H4)');

// ---------------------------------------------------------------- B CSS
const cssPfad = 'packages/web-ui/src/editor-syntax-p22-t266.css';
const c = lies(cssPfad).replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = c.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
ok(festeFarben.length === 0, 'P22-T266 ' + cssPfad + ': keine festen Farbwerte, nur Theme-Variablen (hell und dunkel)', festeFarben);
const vars = new Set([...c.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
ok([...vars].every((v) => ['accent', 'accent-soft', 'accent-contrast', 'panel', 'strong', 'soft', 'bg', 'text', 'muted', 'faint', 'border', 'border2', 'danger', 'success'].includes(v)), 'P22-T266 ' + cssPfad + ': nur bekannte Theme-Tokens', [...vars]);
ok(['tok-keyword', 'tok-string', 'tok-comment', 'tok-number', 'tok-typeName', 'tok-propertyName', 'tok-punctuation', 'tok-invalid'].every((k) => c.includes('.' + k)), 'P22-T266 ' + cssPfad + ': Farben fuer die wichtigsten Token-Arten');
ok(/\.projekt-editor \.ed-codefeld \.cm-gutters\{/.test(c) && /\.projekt-editor \.ed-codefeld \.cm-editor\{[^}]*font:400 12px\/1\.65/.test(c), 'P22-T266 ' + cssPfad + ': CodeMirror-Rahmen mit Schrift/Zeilenhoehe wie das Textfeld aus P22-T262');
ok(/\.ed-code\[data-bearbeitbar\] \.ed-codefeld \.cm-gutters\{box-shadow:inset -2px 0 var\(--accent\)\}/.test(c), 'P22-T266 ' + cssPfad + ': bearbeitbar = orange Kante wie bisher');
ok(/prefers-reduced-motion:reduce/.test(c), 'P22-T266 ' + cssPfad + ': reduzierte Bewegung');

// ---------------------------------------------------------------- C Einbindung
const t = lies('packages/web-ui/src/components/ProjektEditor.tsx');
const ps = lies('packages/web-ui/src/components/editor/PlanStrom.tsx');
const cf = lies('packages/web-ui/src/components/editor/CodeFeld.tsx');
const hv = lies('packages/web-ui/src/components/editor/hervorhebung.tsx');
for (const [name, quelle] of [['ProjektEditor.tsx', t], ['PlanStrom.tsx', ps], ['CodeFeld.tsx', cf], ['hervorhebung.tsx', hv]])
  ok(!/from '@codemirror\//.test(quelle) && !/from '@lezer\//.test(quelle) && !/import \{[^}]*\} from '\.\/syntax'/.test(quelle), 'P22-T266 ' + name + ': kein statischer CodeMirror-Import (bleibt aus dem Haupt-Chunk)');
ok(cf.includes("import('./syntax')") && hv.includes("import('./syntax')"), 'P22-T266 CodeFeld/hervorhebung: CodeMirror per dynamischem import()');
ok(t.includes("leseArbeitsbereichSchalter(project,'editor_syntax')") && t.includes('<SyntaxAn.Provider value={syntaxAn}>') && t.includes("data-syntax={syntaxAn?'an':'aus'}"), 'P22-T266 ProjektEditor.tsx: Schalter editor_syntax, Kontext und Debug-Attribut');
ok(t.includes('? <CodeFeld pfad={pfad} wert={wert} lesend={lesend}') && t.includes('rueckfall={textfeld}') && t.includes(': textfeld}'), 'P22-T266 ProjektEditor.tsx: CodeMirror bei EIN, Textfeld bei AUS und als Rueckfall');
ok(cf.includes("if (stand === 'fehler') return <>{rueckfall}</>;") && cf.includes('data-syntax={stand}'), 'P22-T266 CodeFeld.tsx: Rueckfall bei Ladefehler, Debug data-syntax');
ok((t.match(/pfad=\{vergleich\.file_path\|\|pfad\}/g) ?? []).length === 3 && t.includes('<ZeilenInhalt tokens={tokens?.[i]} roh={z}/>'), 'P22-T266 ProjektEditor.tsx: Drei-Wege-Spalten hervorgehoben');
ok(t.includes('<HervorgehobenerText pfad={pfad} text={schatten}/>') && t.includes('<HervorgehobenerText pfad={pin.pfad} text={pin.text}/>'), 'P22-T266 ProjektEditor.tsx: Live-Schatten und Pins hervorgehoben');
ok(ps.includes('<HervorgehobenerText pfad={f} text={s.text} />') && ps.includes('const tokens = useZeilenTokens(d.file_path, neu);'), 'P22-T266 PlanStrom.tsx: Schatten und Committet-Ansicht hervorgehoben');
ok(hv.includes('const an = useContext(SyntaxAn);') && hv.includes('if (!an || text === null || !pfad) { setTokens(null); return; }'), 'P22-T266 hervorhebung.tsx: Schalter AUS = Klartext');

// ---------------------------------------------------------------- D Schalter
const kat = lies('packages/core/src/services/agent-profil-schalter.ts');
const nur = kat.slice(kat.indexOf('export const NUR_AUSDRUECKLICH')).split('\n')[0];
const ein = kat.slice(kat.indexOf('export const STANDARD_EIN')).split('\n')[0];
ok(kat.includes("  'editor_syntax',") && nur.includes("'editor_syntax'") && !ein.includes('editor_syntax'), 'P22-T266 agent-profil-schalter.ts: editor_syntax im Katalog, Standard AUS, nur ausdruecklich');
const pkg = JSON.parse(lies('packages/web-ui/package.json'));
ok(['@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/language-data', '@codemirror/commands', '@lezer/highlight'].every((p) => pkg.dependencies[p]) && !pkg.dependencies.codemirror && !pkg.dependencies['monaco-editor'], 'P22-T266 package.json: CodeMirror 6 minimal (kein basicSetup-Paket, kein Monaco)', pkg.dependencies);

console.log('OK P22-T266 Syntax-Hervorhebung: ' + n + ' Pruefungen');
