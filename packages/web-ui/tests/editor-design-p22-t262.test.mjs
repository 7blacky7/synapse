/**
 * P22-T262: Gestaltung des Editors (P22-T256) nach den Projekt-Designvorgaben - ohne DB, Netz und Browser.
 *   node packages/web-ui/tests/editor-design-p22-t262.test.mjs
 * Anlass: Gestaltungs-Uebergabe codex-rea4 (thought 009ebddf), Regel regel-web-ui-gestaltung-nur-claude-agenten; User-Zielbild
 * thoughts b92a5a84, 829dd47d, 680ffa06 (Bedienung wie VS Code, Live-Plaene mit Nachleuchten und Pins, Freeze, Pruefplan).
 * Vorgaben: webui-design-standard, user-design-praeferenzen (Orange, hell+dunkel), design-decision-tactical-hud-dashboard
 * (Hairlines, 0-3px Ecken, Mono-Labels), Tokensprache wie P22-T259 (live-artefakte.css).
 * Sichert ab:
 *   A editor-p22-t256.css: nur Theme-Variablen (keine festen Farbwerte), Ecken <= 3px (ausser Punkte), Syne/IBM Plex Mono,
 *     keine generischen Fonts, Fokusrahmen im Akzent, reduced-motion, Freeze-Segment orange, schmale Breiten.
 *   B ProjektEditor.tsx: Datenvertraege/Routen von P22-T256 unveraendert (alle Editor-Routen, Bodies, Nachleuchten-Timer,
 *     Live-Ereignisstrom, readOnly-Regel, Entwurfsschluessel), neue VS-Code-Struktur (Explorer mit Baum+Filter, Reiter,
 *     Zeilennummern, Inspektor-Seiten, Drei-Wege-Panel, Statusleiste, Strg+S).
 *   C SynapseWorkspace.tsx: Eintrag 'Editor' nur bei Schalter editor_modul, Bereich 'editor' rendert ProjektEditor.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// ---------------------------------------------------------------- A CSS
const css = lies('packages/web-ui/src/editor-p22-t256.css');
const c = css.replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = c.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
ok(festeFarben.length === 0, 'P22-T262 editor-p22-t256.css: keine festen Farbwerte, nur Theme-Variablen (hell und dunkel)', festeFarben);
const radien = [...c.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
ok(radien.length > 0 && radien.every((r) => r === '0' || r === '50%' || /^[0-3]px$/.test(r)), 'P22-T262 editor-p22-t256.css: Ecken 0-3px (Punkte rund)', radien);
ok(!/\b(Inter|Roboto|Arial|Outfit|system-ui)\b/.test(c) && !/font-family:monospace/.test(c), 'P22-T262 editor-p22-t256.css: keine generischen Fonts');
ok(/"IBM Plex Mono"/.test(c) && /"Syne"/.test(c), 'P22-T262 editor-p22-t256.css: Mono-Labels und Syne-Titel wie Live-Artefakte (P22-T259)');
const vars = new Set([...c.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
ok(['accent', 'accent-soft', 'accent-contrast', 'panel', 'strong', 'soft', 'text', 'muted', 'faint', 'border', 'border2', 'danger', 'success'].every((v) => vars.has(v)), 'P22-T262 editor-p22-t256.css: Theme-Tokens inkl. Orange-Akzent', [...vars]);
const fremd = [...vars].filter((v) => !['accent', 'accent-soft', 'accent-contrast', 'panel', 'strong', 'soft', 'bg', 'text', 'muted', 'faint', 'border', 'border2', 'danger', 'success', 'tiefe'].includes(v));
ok(fremd.length === 0, 'P22-T262 editor-p22-t256.css: nur bekannte Theme-Variablen (plus --tiefe fuer die Baum-Einrueckung)', fremd);
ok(/:focus-visible\{outline:2px solid var\(--accent\)/.test(c), 'P22-T262 editor-p22-t256.css: sichtbarer Fokusrahmen im Akzent');
ok(/prefers-reduced-motion:reduce/.test(c) && /@media \(max-width:760px\)/.test(c) && /@media \(max-width:1180px\)/.test(c), 'P22-T262 editor-p22-t256.css: reduzierte Bewegung und schmale Breiten');
ok(/\.ed-status-modus\.freeze\{background:var\(--accent\);color:var\(--accent-contrast\)\}/.test(c), 'P22-T262 editor-p22-t256.css: Freeze als oranges Statussegment');
ok(/\.ed-reiter-eintrag\.aktiv\{[^}]*box-shadow:inset 0 2px var\(--accent\)/.test(c), 'P22-T262 editor-p22-t256.css: aktiver Reiter mit oranger Oberkante');
ok(/@keyframes ed-nachleuchten/.test(c) && /\.ed-plan\.nachklang\{[^}]*animation:ed-nachleuchten/.test(c), 'P22-T262 editor-p22-t256.css: Nachleuchten abgeschlossener Plaene');
ok(/\.ed-schatten\.schreibt::after\{content:'\\258D'/.test(c), 'P22-T262 editor-p22-t256.css: Schreibcursor im live entstehenden Schatten');
ok(/\.ed-zeilen\{[^}]*font:400 12px\/1\.65/.test(c) && /\.ed-code textarea\{[^}]*font:400 12px\/1\.65/.test(c), 'P22-T262 editor-p22-t256.css: Zeilennummern und Code mit gleicher Schrift/Zeilenhoehe');
ok(/\.projekt-editor \.ed-code textarea\{/.test(c), 'P22-T262 editor-p22-t256.css: Code-Feld schlaegt .synapse-control textarea{line-height:1.4} (Live-Befund t230: 16.8px statt 19.8px)');

// ---------------------------------------------------------------- B ProjektEditor.tsx
const t = lies('packages/web-ui/src/components/ProjektEditor.tsx');
const routen = [
  "'/api/main-agent/editor/dateien?project='",
  // P22-T264 (Vertrag claude-birke 34579): User-Plan statt Pruefplaene.
  "'/api/main-agent/editor/user-plan?project='",
  "'/api/main-agent/editor/user-plan/datei?project='",
  "'/api/main-agent/editor/plaene?project='",
  "'/api/main-agent/editor/abbild/'+q(freeze)+'/datei?project='",
  "'/api/projects/'+q(project)+'/code-intel/file?path='",
  "'/api/main-agent/editor/ereignisse?project='",
  "'/api/main-agent/editor/schatten?project='",
  "json('/api/main-agent/editor/abbild',{method:'POST'",
  "json('/api/main-agent/editor/user-plan',{method:'POST'",
  "json('/api/main-agent/editor/pruefauftrag',{method:'POST'",
];
ok(routen.every((r) => t.includes(r)), 'P22-T262/T264 ProjektEditor.tsx: alle Editor-Routen (P22-T256, Speichern seit P22-T264 als User-Plan)', routen.filter((r) => !t.includes(r)));
ok(!t.includes('/api/main-agent/editor/pruefplaene'), 'P22-T264 ProjektEditor.tsx: keine Pruefplan-Routen mehr');
ok(t.includes("body:JSON.stringify({project,abbild_id:freeze,file_path:pfad,entwurf:entwuerfe[(freeze??'')+'::'+pfad]??datei.inhalt})"), 'P22-T262/T264 ProjektEditor.tsx: Speicher-Body unveraendert (jetzt User-Plan)');
ok(t.includes('Number(d.nachleuchten_sekunden)*1000') && t.includes('new EventSource('), 'P22-T262 ProjektEditor.tsx: Nachleuchten ueber Server-Einstellwert und Live-Ereignisstrom unveraendert');
ok(t.includes('const lesend=!freeze||pauseAbbild||!!aktiv?.maskiert') && t.includes('readOnly={lesend}'), 'P22-T262 ProjektEditor.tsx: Bearbeiten nur im Freeze, nie bei maskierten Dateien');
ok(t.includes("{pauseAbbild?'Abbild fortsetzen':'Freeze lösen'}") && t.includes('Codebild einfrieren') && t.includes('Neues Abbild') && t.includes('Im Plan speichern'), 'P22-T262/T264 ProjektEditor.tsx: Freeze-Bedienung und Speichern vorhanden');
ok(!t.includes('<h2>Editor') && t.includes('<header className="ed-kopf" aria-label="Editor-Werkzeuge">') && t.includes('className="ed-projekt-chip"'), 'P22-T264 ProjektEditor.tsx: keine Ueberschrift mehr (User 34584), Werkzeugzeile mit Projekt-Chip');
ok(t.includes('className="ed-explorer"') && t.includes('className="ed-filter"') && /function baueBaum\(/.test(t) && t.includes('aria-expanded={auf}'), 'P22-T262 ProjektEditor.tsx: Explorer mit Dateibaum und Filter (VS Code)');
ok(t.includes('role="tablist" aria-label="Geöffnete Dateien"') && t.includes('className="ed-reiter-zu"'), 'P22-T262 ProjektEditor.tsx: Reiter mit Schliessen');
ok(t.includes('className="ed-zeilen"') && t.includes('wrap="off"') && t.includes('onScroll='), 'P22-T262 ProjektEditor.tsx: Zeilennummern synchron zum Code');
ok(t.includes('Live-Pläne') && t.includes('Mein Plan') && t.includes('ed-plan nachklang') && t.includes('Schatten anpinnen') && t.includes('Pin lösen'), 'P22-T262/T264 ProjektEditor.tsx: Inspektor mit Live-Plaenen, Nachleuchten, Pins und Mein Plan');
ok(t.includes('Prüfen lassen') && t.includes('text:pruefText.trim()||undefined') && t.includes('className="ed-userplan-ops"') && t.includes("'korrigiert · '+o.agent_id"), 'P22-T264 ProjektEditor.tsx: Mein Plan mit Ops je Datei (User/Agent-Korrektur), ausdruecklicher Pruefauftrag mit optionalem Text');
ok(t.includes('aria-label="Drei-Wege-Vergleich"') && (t.match(/<DreiWegeSpalte /g) ?? []).length === 3, 'P22-T262 ProjektEditor.tsx: Drei-Wege-Vergleich mit drei Spalten');
ok(t.includes('className="ed-status"') && /e\.key\.toLowerCase\(\)==='s'/.test(t) && t.includes('if(speicherbar)void speichern()'), 'P22-T262 ProjektEditor.tsx: Statusleiste und Strg+S nur wenn speicherbar');
ok(t.includes('data-modus={modus}') && t.includes("data-live={live?'an':'aus'}"), 'P22-T262 ProjektEditor.tsx: Debug-Attribute am Wurzelelement');
ok(!/style=\{\{(?!'--tiefe')/.test(t), 'P22-T262 ProjektEditor.tsx: keine Inline-Gestaltung ausser der Baum-Einrueckung');

// ---------------------------------------------------------------- C Eingliederung
const w = lies('packages/web-ui/src/components/workspace/SynapseWorkspace.tsx');
ok(w.includes("leseArbeitsbereichSchalter(selectedProject,'editor_modul')") && w.includes("{area:'editor' as const,label:'Editor'"), 'P22-T262 SynapseWorkspace.tsx: Eintrag Editor nur bei Schalter editor_modul');
ok(w.includes("if (area === 'editor' && editorSchalter?.aktiv) return <ProjektEditor project={selectedProject}/>;"), 'P22-T262 SynapseWorkspace.tsx: Bereich editor rendert ProjektEditor');

console.log('OK P22-T262 Editor-Design: ' + n + ' Pruefungen');
