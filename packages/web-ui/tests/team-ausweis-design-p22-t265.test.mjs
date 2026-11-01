/**
 * P22-T265: Gestaltung der Ausweis-Anzeige im Agententeam (Funktion P22-T257) - ohne DB, Netz und Browser.
 *   node --experimental-strip-types packages/web-ui/tests/team-ausweis-design-p22-t265.test.mjs
 * Herkunft: User-Abnahme thought 897873c7 („Schulhofkind, aber die Funktion ist da“), Bestand 5918a00d.
 * Sichert ab:
 *   A team-ausweis-p22-t265.css: nur Theme-Variablen (hell und dunkel), Ecken 0-3px, Mono-Labels ohne generische Fonts, Fokusrahmen im
 *     Akzent, reduzierte Bewegung, schmale Breiten, Zustandsfarben an der Kante.
 *   B TeamAusweisKarte.tsx: Datenvertrag unveraendert (Kennung aus ladeTeamAusweis lesbar und kopierbar), alle Zustaende sichtbar
 *     (laedt, aus, fehlt, fehler), Kopier-Rueckmeldung mit aria-live und Markier-Rueckfall, Verwalten-Knopf, Debug-Attribute.
 *   C ProjectAgentTeamView.tsx: Karte statt nackter Browser-Knoepfe; Ladeweg P22-T257 unveraendert; keine Inline-Gestaltung.
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

// ---------------------------------------------------------------- A CSS
const cssPfad = 'packages/web-ui/src/team-ausweis-p22-t265.css';
const c = lies(cssPfad).replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = c.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
ok(festeFarben.length === 0, 'P22-T265 ' + cssPfad + ': keine festen Farbwerte, nur Theme-Variablen (hell und dunkel)', festeFarben);
const radien = [...c.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
ok(radien.length > 0 && radien.every((r) => r === '0' || r === '50%' || /^[0-3]px$/.test(r)), 'P22-T265 ' + cssPfad + ': Ecken 0-3px (Punkte rund)', radien);
ok(!/\b(Inter|Roboto|Arial|Outfit|system-ui)\b/.test(c) && /"IBM Plex Mono"/.test(c), 'P22-T265 ' + cssPfad + ': Mono-Labels, keine generischen Fonts');
const vars = new Set([...c.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
const bekannt = ['accent', 'accent-soft', 'accent-contrast', 'panel', 'strong', 'soft', 'bg', 'text', 'muted', 'faint', 'border', 'border2', 'danger', 'success'];
ok([...vars].every((v) => bekannt.includes(v)) && ['accent', 'success', 'danger', 'panel', 'soft', 'border'].every((v) => vars.has(v)), 'P22-T265 ' + cssPfad + ': nur bekannte Theme-Tokens, Orange-Akzent und Zustandsfarben', [...vars]);
ok(/\.team-ausweis :is\(button,code\):focus-visible\{outline:2px solid var\(--accent\)/.test(c), 'P22-T265 ' + cssPfad + ': sichtbarer Fokusrahmen im Akzent');
ok(/prefers-reduced-motion:reduce/.test(c) && /@media \(max-width:760px\)/.test(c), 'P22-T265 ' + cssPfad + ': reduzierte Bewegung und schmale Breiten');
ok(/\.team-ausweis\[data-zustand="gueltig"\]\{border-left-color:var\(--success\)\}/.test(c) && /\.team-ausweis\[data-zustand="keiner"\]\{border-left-color:var\(--danger\)\}/.test(c), 'P22-T265 ' + cssPfad + ': Zustand an der Kante (gueltig gruen, kein Ausweis rot)');
ok(/\.team-ausweis-kopieren\{[^}]*background:transparent/.test(c) && /\.team-ausweis-verwalten\{[^}]*background:transparent/.test(c), 'P22-T265 ' + cssPfad + ': Knoepfe als Hairline-Knoepfe statt grauer Browser-Standardknoepfe');
ok(/\.team-ausweis-kennung\{[^}]*"IBM Plex Mono"[^}]*user-select:all/.test(c), 'P22-T265 ' + cssPfad + ': Kennung als Mono-Feld, mit einem Klick markierbar');

// ---------------------------------------------------------------- B Komponente
const kartePfad = 'packages/web-ui/src/views/projekt/TeamAusweisKarte.tsx';
const k = lies(kartePfad);
ok(k.includes("import '../../team-ausweis-p22-t265.css';"), 'P22-T265 ' + kartePfad + ': eigenes Stylesheet');
ok(k.includes('navigator.clipboard.writeText(stand.ausweis)') && k.includes('{stand!.ausweis}'), 'P22-T265 ' + kartePfad + ': Kennung lesbar und kopierbar (Funktion P22-T257)');
ok(k.includes('aria-live="polite"') && k.includes("'Kopiert'") && k.includes('markieren()'), 'P22-T265 ' + kartePfad + ': Kopier-Rueckmeldung und Markier-Rueckfall');
ok(['Kennung lädt', 'Anzeige der Kennung ist ausgeschaltet', 'Keine lesbare Kennung', 'Anzeige nicht verfügbar ('].every((s) => k.includes(s)), 'P22-T265 ' + kartePfad + ': Lade-, Schalter-AUS-, Leer- und Fehlerzustand sichtbar');
ok(k.includes('Ausweis und Profil verwalten') && k.includes('onClick={onVerwalten}'), 'P22-T265 ' + kartePfad + ': Verwalten-Knopf erhalten');
ok(k.includes('data-zustand={art}') && k.includes('data-kennung={kennung}'), 'P22-T265 ' + kartePfad + ': Debug-Attribute');
ok(!/style=\{\{/.test(k), 'P22-T265 ' + kartePfad + ': keine Inline-Gestaltung');
ok(k.includes('className="team-ausweis-symbol"') && !k.includes('⧉') && /\.team-ausweis-symbol\[data-art="kopie"\]::before/.test(c), 'P22-T265 ' + kartePfad + ': Kopier-Symbol aus Hairlines, keine Glyphe (Vorschau t231: U+29C9 als Kaestchen)');
// Reine Zustandsfunktion (Typen werden beim Laden entfernt).
const src = k.slice(k.indexOf('export function teamAusweisKennung'), k.indexOf('export function TeamAusweisKarte'))
  .replace(/: TeamAusweisStand\): [^{]+\{/, ') {');
const teamAusweisKennung = new Function(src.replace('export function teamAusweisKennung', 'return function teamAusweisKennung'))();
ok(teamAusweisKennung(null) === 'laedt' && teamAusweisKennung({ aktiv: false, ausweis: '', quelle: 'standard', fehler: '' }) === 'aus'
  && teamAusweisKennung({ aktiv: true, ausweis: '', quelle: 'p', fehler: '' }) === 'fehlt' && teamAusweisKennung({ aktiv: true, ausweis: 'sai_8', quelle: 'p', fehler: '' }) === 'sichtbar'
  && teamAusweisKennung({ aktiv: true, ausweis: 'sai_8', quelle: 'p', fehler: 'x' }) === 'fehler', 'P22-T265 ' + kartePfad + ': teamAusweisKennung ordnet alle Zustaende zu');

// ---------------------------------------------------------------- C Einbindung
const viewPfad = 'packages/web-ui/src/views/projekt/ProjectAgentTeamView.tsx';
const v = lies(viewPfad);
ok(v.includes("import { TeamAusweisKarte } from './TeamAusweisKarte';") && v.includes('<TeamAusweisKarte key={current.identityId || current.name} zustand={current.ausweis}'), 'P22-T265 ' + viewPfad + ': Karte unter dem Agentennamen');
ok(v.includes('void ladeTeamAusweis(project, identityId)') && v.includes('stand={teamAusweis?.identityId === current.identityId ? teamAusweis : null}'), 'P22-T265 ' + viewPfad + ': Ladeweg P22-T257 unveraendert, Antwort dem gewaehlten Agenten zugeordnet');
ok(!v.includes('<p><button type="button" onClick={() => oeffneAusweisVerwaltung') && !v.includes('<button type="button" onClick={() => void navigator.clipboard.writeText'), 'P22-T265 ' + viewPfad + ': keine nackten Browser-Knoepfe mehr');
ok(v.includes("{current.art === 'wrapper' && <div><dt>Ausweis</dt><dd>–</dd></div>}"), 'P22-T265 ' + viewPfad + ': Raster-Zeile Ausweis nur noch fuer Wrapper');

console.log('OK P22-T265 Ausweis-Anzeige: ' + n + ' Pruefungen');
