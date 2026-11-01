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
// Nachtrag User (Canvas): rahmenlose Artefakte auf einer Punkt-Leinwand, Bedienelemente erst beim Zeigen.
const kachelRegel = (ohneKommentar.match(/\.live-kachel\{[^}]*\}/) ?? [''])[0];
ok(!/border:1px/.test(kachelRegel) && !/background:var\(--panel\)/.test(kachelRegel) && /outline:1px solid transparent/.test(kachelRegel), 'P22-T259 Canvas live-artefakte.css: Artefakt ohne Rahmen/Fensterflaeche, nur Auswahlkante beim Zeigen', kachelRegel);
ok(/\.live-kachel-kopf\{position:absolute;[^}]*opacity:0/.test(ohneKommentar) && /\.live-kachel:hover \.live-kachel-kopf/.test(ohneKommentar) && /\.live-kachel-groesse\{[^}]*opacity:0/.test(ohneKommentar), 'P22-T259 Canvas live-artefakte.css: Leiste und Groessengriff schweben, erst beim Zeigen sichtbar');
ok(/radial-gradient\(circle,color-mix\(in srgb,var\(--muted\)/.test(ohneKommentar) && /\.live-board-flaeche\{/.test(ohneKommentar), 'P22-T259 Canvas live-artefakte.css: Punkt-Leinwand wie Figma/Miro');
ok(/\.live-kachel-steuerung\{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset\(50%\)/.test(ohneKommentar) && /\.live-kachel-steuerung:focus-within\{position:static/.test(ohneKommentar),
  'P22-T259 Canvas live-artefakte.css: Pfeilknoepfe nur fuer Tastatur/Barrierefreiheit (verborgen, beim Fokus sichtbar)');

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
console.log('P22-T259 Web-UI: ' + n + ' Pruefungen bestanden');
