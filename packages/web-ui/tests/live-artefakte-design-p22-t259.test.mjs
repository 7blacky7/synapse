/**
 * P22-T259: Live-Artefakte nach den Projekt-Designvorgaben - ohne DB, Netz und Browser.
 *   node --experimental-strip-types packages/web-ui/tests/live-artefakte-design-p22-t259.test.mjs
 * Anlass (User 01.11.2026 ~01:15, memory regel-web-ui-gestaltung-nur-claude-agenten): Funktion ja, Optik "total haesslich",
 * Designvorgaben nicht eingehalten. Vorgaben: webui-design-standard, user-design-praeferenzen (Orange, hell+dunkel),
 * design-decision-tactical-hud-dashboard (Hairlines, 0-3px Ecken, Mono-Labels), Stil der Nachbaransichten (Top-Artefakte).
 * Sichert ab:
 *   A live-artefakte.css: Farben nur aus Theme-Variablen (keine festen Farbwerte -> hell/dunkel), Ecken <= 3px (ausser Statuspunkt),
 *     keine verbotenen Fonts, IBM Plex Mono/Syne wie die Nachbarn, Akzent --accent, Fokusrahmen, reduced-motion.
 *   B LiveArtefakte.tsx: Funktion/Datenvertraege unveraendert (Katalog-Route mit Keyset, Layout-PUT, verschiebe/skaliere,
 *     sechs Tastenknoepfe mit aria-label, Oeffnen ueber Lesefenster, Skript-Rahmen), neue Struktur (Kopf, Status, Zaehler, Griff).
 *   C live-artefakte-layout.ts: anzeigeTitel (Entitaeten nur fuer die Anzeige), kurzeId.
 *   D OverviewView.tsx: Umschalter gestaltet (Klasse live-umschalter, aria-pressed bleibt).
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/live-artefakte-layout.ts')).href);
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// ---------------------------------------------------------------- A CSS
const css = lies('packages/web-ui/src/live-artefakte.css');
const ohneKommentar = css.replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = ohneKommentar.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
ok(festeFarben.length === 0, 'P22-T259 live-artefakte.css: keine festen Farbwerte, nur Theme-Variablen (hell und dunkel)', festeFarben);
const radien = [...ohneKommentar.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
ok(radien.every((r) => r === '0' || r === '50%' || /^[0-3]px$/.test(r)), 'P22-T259 live-artefakte.css: Ecken 0-3px (Statuspunkt rund)', radien);
ok(!/\b(Inter|Roboto|Arial|Outfit|system-ui)\b/.test(ohneKommentar), 'P22-T259 live-artefakte.css: keine generischen Fonts (Inter/Roboto/Arial/Outfit/system-ui)');
ok(/"IBM Plex Mono"/.test(ohneKommentar) && /"Syne"/.test(ohneKommentar), 'P22-T259 live-artefakte.css: Mono-Labels und Syne-Titel wie die Nachbaransichten (Top-Artefakte)');
const vars = new Set([...ohneKommentar.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
ok(['accent', 'panel', 'text', 'muted', 'border', 'danger', 'success', 'accent-contrast'].every((v) => vars.has(v)), 'P22-T259 live-artefakte.css: Theme-Tokens inkl. Orange-Akzent', [...vars]);
ok(/:focus-visible\{outline:2px solid var\(--accent\)/.test(ohneKommentar), 'P22-T259 live-artefakte.css: sichtbarer Fokusrahmen im Akzent');
ok(/prefers-reduced-motion:reduce/.test(ohneKommentar) && /@media \(hover:none\)/.test(ohneKommentar), 'P22-T259 live-artefakte.css: reduzierte Bewegung und Touch beruecksichtigt');
ok(/\.live-kachel\[data-zieht\]/.test(ohneKommentar) && /cursor:grab/.test(ohneKommentar) && /cursor:nwse-resize/.test(ohneKommentar), 'P22-T259 live-artefakte.css: Zieh-/Groessenzustand sichtbar');
// Fassung 3 (User-Abnahme 01.11. ~12:00 abgelehnt, Befund e25440e9): Frames wie in Figma - Beschriftung ueber der Flaeche (im Fluss, keine
// schwebende Leiste), Flaeche mit Hairline, Auswahl mit vier Eckgriffen, Metazeile des Artefakt-Blocks in der Beschriftung, duenne Scrollbalken.
const kachelRegel = (ohneKommentar.match(/\.live-kachel\{[^}]*\}/) ?? [''])[0];
const flaecheRegel = (ohneKommentar.match(/\.live-kachel-inhalt\{[^}]*\}/) ?? [''])[0];
ok(!/border:1px/.test(kachelRegel) && !/background:/.test(kachelRegel) && /border:1px solid var\(--border\)/.test(flaecheRegel) && /border-radius:3px/.test(flaecheRegel) && /scrollbar-color:/.test(flaecheRegel),
  'P22-T259 Frames live-artefakte.css: Kachel selbst ohne Rahmen/Flaeche, die Flaeche traegt Hairline, 3px-Ecken und duenne Scrollbalken', { kachelRegel, flaecheRegel });
const ecken = (ohneKommentar.match(/\.live-kachel::after\{[^}]*\}/) ?? [''])[0];
ok((ecken.match(/linear-gradient\(var\(--accent\),var\(--accent\)\)/g) ?? []).length === 4 && /pointer-events:none/.test(ecken) && /opacity:0/.test(ecken) && /\.live-kachel:hover::after/.test(ohneKommentar) && /\.live-kachel\[data-zieht\]::after/.test(ohneKommentar),
  'P22-T259 Frames live-artefakte.css: Auswahl mit vier Eckgriffen im Akzent (Hover, Fokus, Ziehen), faengt keine Klicks ab', ecken);
ok(/\.live-kachel-kopf\{flex:none;/.test(ohneKommentar) && !/\.live-kachel-kopf\{position:absolute/.test(ohneKommentar) && /\.live-kachel \.artefakt-live-kopf\{position:absolute;top:0;/.test(ohneKommentar) && /\.live-kachel-groesse\{position:absolute;[^}]*cursor:nwse-resize/.test(ohneKommentar),
  'P22-T259 Frames live-artefakte.css: Beschriftung im Fluss ueber der Flaeche, Metazeile des Artefakt-Blocks rechts darin, Groessengriff an der Ecke');
ok(/radial-gradient\(circle,color-mix\(in srgb,var\(--muted\)/.test(ohneKommentar) && /\.live-board-flaeche\{/.test(ohneKommentar), 'P22-T259 Canvas live-artefakte.css: Punkt-Leinwand wie Figma/Miro');
ok(/\.live-kachel-steuerung\{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset\(50%\)/.test(ohneKommentar) && /\.live-kachel-steuerung:focus-within\{position:static/.test(ohneKommentar),
  'P22-T259 Canvas live-artefakte.css: Pfeilknoepfe nur fuer Tastatur/Barrierefreiheit (verborgen, beim Fokus sichtbar)');

// Nachbesserung Befund d153b15b (team-lead 01.11.): Touch-Leiste ueber statt auf dem Inhalt; lesbare Flaeche fuer Artefakte ohne Hintergrund.
const touch = (ohneKommentar.match(/@media \(hover:none\)\{([\s\S]*?)\n\}/) ?? ['', ''])[1];
ok(/\.live-kachel-oeffnen,\.live-kachel-entfernen,\.live-kachel \.artefakt-live-neu,\.live-kachel-id\{opacity:1\}/.test(touch) && /\.live-kachel-groesse::before\{/.test(touch), 'P22-T259 Frames live-artefakte.css: bei hover:none (Touch) Werkzeuge, ID und Eckgriff dauerhaft sichtbar', touch);
ok(/\.live-kachel-inhalt \.agent-rendering-shadow\{color-scheme:light;background:Canvas;color:CanvasText/.test(ohneKommentar), 'P22-T259 d153b15b live-artefakte.css: Artefakt-Flaeche mit Browser-Standardgrund (lesbar im dunklen Theme)');

// team-lead 01.11.: Knopf „Neu zeichnen“ (ArtefaktLiveBlock.tsx) in der Tokensprache statt Browser-Standard; Funktion unveraendert.
const neuCss = lies('packages/web-ui/src/artefakt-live-block.css').replace(/\/\*[\s\S]*?\*\//g, '');
const blockTsx = lies('packages/web-ui/src/components/ArtefaktLiveBlock.tsx');
ok((neuCss.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? []).length === 0 && /\.artefakt-live-neu\{[^}]*border:1px solid var\(--border\)[^}]*border-radius:0[^}]*"IBM Plex Mono"[^}]*text-transform:uppercase/.test(neuCss)
  && /\.artefakt-live-neu:focus-visible\{outline:2px solid var\(--accent\)/.test(neuCss) && /prefers-reduced-motion:reduce/.test(neuCss), 'P22-T259 artefakt-live-block.css: Neu-zeichnen als Hairline-Knopf mit Mono-Label, nur Tokens, Fokus, reduced-motion', neuCss);
ok(/import '\.\.\/artefakt-live-block\.css'/.test(blockTsx) && /<button type="button" className="artefakt-live-neu" onClick=\{\(\) => void neuZeichnen\(\)\} disabled=\{busy\}>\{busy \? 'zeichnet …' : 'Neu zeichnen'\}<\/button>/.test(blockTsx),
  'P22-T259 ArtefaktLiveBlock.tsx: Knopf mit Klasse statt Inline-Stil, Funktion (neuZeichnen, disabled, Beschriftung) unveraendert');

// ---------------------------------------------------------------- B TSX (Funktion unveraendert, neue Struktur)
const tsx = lies('packages/web-ui/src/components/LiveArtefakte.tsx');
ok(/'\/api\/main-agent\/live-artefakte'\+q/.test(tsx) && /nach_id=/.test(tsx) && /nach_projekt=/.test(tsx) && /while\(cursor && lebt\)/.test(tsx), 'P22-T164/T259 LiveArtefakte.tsx: paginierter Katalog (Keyset) unveraendert');
ok(/\/layout',\{method:'PUT'/.test(tsx) && /revision:Number\(r\.revision\)/.test(tsx), 'P22-T164/T259 LiveArtefakte.tsx: Layout je User per PUT mit Revision unveraendert');
ok(/verschiebe\(v,dx,dy\)/.test(tsx) && /skaliere\(v,dx,dy\)/.test(tsx) && /setPointerCapture/.test(tsx), 'P22-T164/T259 LiveArtefakte.tsx: Ziehen und Skalieren unveraendert');
const labels = ['Nach links', 'Nach rechts', 'Nach oben', 'Nach unten', 'Kleiner', 'Größer'];
ok(labels.every((l) => tsx.includes('aria-label="' + l + '"')) && (tsx.match(/<button type="button"/g) ?? []).length >= 8, 'P22-T259 LiveArtefakte.tsx: sechs Tastenknoepfe mit aria-label, alle type=button');
ok(/fenster\?\.oeffne\(\{project:e\.project,art:'artefakt',id:e\.id,ohneHerkunft:true\}\)/.test(tsx) && /skriptErlaubt\(/.test(tsx) && /<VerweisFensterProvider><Board\/><\/VerweisFensterProvider>/.test(tsx), 'P22-T164/T259 LiveArtefakte.tsx: Oeffnen ueber Lesefenster, Skript-Rahmen, Provider unveraendert');
ok(/className="live-board-kopf"/.test(tsx) && /live-board-status/.test(tsx) && /live-board-zahl/.test(tsx) && /className="live-kachel-griff"/.test(tsx) && /data-zieht=\{zieht\|\|undefined\}/.test(tsx),
  'P22-T259 LiveArtefakte.tsx: Kopf mit Status/Zaehlern, Kachel mit Griff und Ziehzustand');
ok(/title=\{e\.id\}>\{kurzeId\(e\.id\)\}/.test(tsx) && /anzeigeTitel\(e\.title\)/.test(tsx) && !/\{e\.project\} · \{e\.id\}/.test(tsx), 'P22-T259 LiveArtefakte.tsx: kurze ID (volle im Tooltip), lesbarer Titel statt roher UUID-Zeile');
ok(!/style=\{\{[^}]*(color|background|border)/.test(tsx), 'P22-T259 LiveArtefakte.tsx: keine Inline-Farben (Gestaltung nur ueber CSS-Tokens)');

// ---------------------------------------------------------------- C Logik
ok(L.anzeigeTitel('P6 Leitstand – Trainingsdaten &amp; Loss') === 'P6 Leitstand – Trainingsdaten & Loss' && L.anzeigeTitel('a &lt;b&gt; &quot;c&quot; &#39;d&#39;') === 'a <b> "c" \'d\'',
  'P22-T259 live-artefakte-layout.ts anzeigeTitel: Entitaeten werden Zeichen (nur Anzeige)');
ok(L.anzeigeTitel(null) === 'Artefakt' && L.anzeigeTitel('  ') === 'Artefakt', 'P22-T259 live-artefakte-layout.ts anzeigeTitel: leer = Artefakt');
ok(L.kurzeId('05949658-0605-404c-b51f-a0061a59f1da') === '05949658' && L.kurzeId('abc') === 'abc', 'P22-T259 live-artefakte-layout.ts kurzeId: 8 Zeichen');
ok(JSON.stringify(L.verschiebe({ x: 20, y: 30, breite: 40, hoehe: 200, revision: 7 }, 100, -100)) === JSON.stringify({ x: 60, y: 0, breite: 40, hoehe: 200, revision: 7 }), 'P22-T164 live-artefakte-layout.ts verschiebe unveraendert');

// ---------------------------------------------------------------- D OverviewView
const ov = lies('packages/web-ui/src/views/uebersicht/OverviewView.tsx');
ok(/aria-pressed=\{liveOffen\} className="live-umschalter"/.test(ov) && /web_ui_live_artefakte/.test(ov), 'P22-T259 OverviewView.tsx: Umschalter gestaltet, Schalter web_ui_live_artefakte unveraendert');
// ---------------------------------------------------------------- E L2-L4 (User 01.11.2026 ~12:05, thought c737a806)
ok(!/<h2>/.test(tsx) && !/live-board-titel/.test(tsx) && !/\.live-board-titel/.test(ohneKommentar), 'P22-T259 L2 LiveArtefakte.tsx/css: keine Ueberschrift mehr, nur die Werkzeugzeile');
ok(/className="live-hinzu" aria-haspopup="dialog" aria-expanded=\{auswahl\}/.test(tsx) && /role="dialog" aria-label="Live-Artefakt hinzuf/.test(tsx) && /ev\.key==='Escape'/.test(tsx),
  'P22-T259 L3 LiveArtefakte.tsx: + oeffnet die Auswahl aus dem Katalog (Dialog, Escape schliesst)');
ok(/sichtbar=liste\.filter\(aufLeinwand\)/.test(tsx) && /frei=liste\.filter\(e=>!aufLeinwand\(e\)\)/.test(tsx) && /<Auswahl eintraege=\{frei\}/.test(tsx),
  'P22-T259 L3 LiveArtefakte.tsx: Leinwand zeigt nur Hinzugefuegtes, die Auswahl nur den Rest des Katalogs');
ok(/auf_leinwand:leinwand/.test(tsx) && /speichereLage\(e,v,true\)/.test(tsx) && /speichereLage\(e,v,false\)/.test(tsx) && /auf_leinwand:true\}\)\}\);set\(/.test(tsx) && /aria-label="Von der Leinwand nehmen"/.test(tsx),
  'P22-T259 L3/L4 LiveArtefakte.tsx: Hinzufuegen/Entfernen ueber den bestehenden Layout-PUT (auf_leinwand), Entfernen je Kachel');
ok(/\.live-hinzu\{[^}]*background:var\(--accent\)/.test(ohneKommentar) && /\.live-auswahl\{[^}]*border-top:2px solid var\(--accent\)/.test(ohneKommentar) && /\.live-auswahl-liste button:focus-visible\{outline:2px solid var\(--accent\)/.test(ohneKommentar),
  'P22-T259 L3 live-artefakte.css: Hinzufuegen als Akzentknopf, Auswahl-Panel mit Akzentkante und Fokusrahmen');
ok(/\.live-kachel\{container-type:inline-size\}/.test(ohneKommentar) && /@container \(max-width:460px\)/.test(ohneKommentar) && /@container \(max-width:300px\)/.test(ohneKommentar),
  'P22-T259 live-artefakte.css: schmale Frames verdichten die Beschriftung (Container-Abfrage), nichts ragt in Nachbar-Frames');
const api = lies('packages/rest-api/src/routes/agent-runtimes.ts');
ok(/l\.revision AS layout_revision,l\.auf_leinwand/.test(api) && /typeof b\.auf_leinwand!=='boolean'/.test(api) && /\$8::boolean/.test(api) && /auf_leinwand=EXCLUDED\.auf_leinwand/.test(api) && /b\.auf_leinwand!==false\]/.test(api),
  'P22-T259 L4 agent-runtimes.ts: Katalog liefert auf_leinwand, Layout-PUT nimmt es optional (fehlt = true)');
const routen = api.match(/'\/api\/main-agent\/live-artefakte[^']*'/g) ?? [];
ok(routen.length === 2, 'P22-T259 L4 agent-runtimes.ts: keine neue Route, weiter nur GET Katalog und PUT Layout', routen);
const schema = lies('packages/core/src/db/schema.ts');
ok(/column_name='auf_leinwand'\) THEN\s+ALTER TABLE user_live_artefakt_layout ADD COLUMN auf_leinwand BOOLEAN NOT NULL DEFAULT TRUE;/.test(schema) && /ON CONFLICT \(user_key,artefakt_id,project\) DO NOTHING;/.test(schema) && (schema.match(/CREATE TABLE IF NOT EXISTS user_live_artefakt/g) ?? []).length === 1,
  'P22-T259 L4 schema.ts: Feld im bestehenden Layout-Speicher, Einmal-Umstieg nur beim Anlegen der Spalte, keine neue Tabelle');
ok(L.aufLeinwand({ auf_leinwand: true }) && !L.aufLeinwand({ auf_leinwand: false }) && !L.aufLeinwand({ auf_leinwand: null }) && !L.aufLeinwand({}), 'P22-T259 L3 live-artefakte-layout.ts aufLeinwand: nur ausdruecklich hinzugefuegte Kacheln');
ok(JSON.stringify(L.freieLage([360, 700, 340])) === JSON.stringify({ x: 0, y: 700, breite: 48, hoehe: 320 }) && JSON.stringify(L.freieLage([], { breite: 30, hoehe: 500 })) === JSON.stringify({ x: 0, y: 0, breite: 30, hoehe: 500 })
  && L.freieLage([], { breite: 500, hoehe: 10 }).breite === 100 && L.freieLage([], { breite: 500, hoehe: 10 }).hoehe === 100, 'P22-T259 L3 live-artefakte-layout.ts freieLage: unter der untersten Kachel, Groesse bleibt bzw. wird begrenzt');
console.log('P22-T259 Web-UI: ' + n + ' Pruefungen bestanden');
