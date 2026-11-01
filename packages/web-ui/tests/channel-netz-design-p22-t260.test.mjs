/**
 * P22-T260: Channel-Fenster/-Suche (P22-T254) und Ergebnis-Detailfenster (P22-T255) nach den Projekt-Designvorgaben -
 * ohne DB, Netz und Browser.
 *   node packages/web-ui/tests/channel-netz-design-p22-t260.test.mjs
 * Anlass: Befund claude-birke thought 1918655e (Design-Pruefung T254/T255), memory regel-web-ui-gestaltung-nur-claude-agenten.
 * Vorgaben: webui-design-standard, user-design-praeferenzen (Orange, hell+dunkel), design-decision-tactical-hud-dashboard
 * (Hairlines, 0-3px Ecken, Mono-Labels), Tokensprache der Live-Artefakte (P22-T259, live-artefakte.css).
 * Sichert ab:
 *   A channel-fenster-p22-t254.css: keine festen Farben/Fallbacks, Ecken <= 3px, Hairline statt Orange-Vollrahmen,
 *     Suchfeld nur bei :focus-visible orange, Fokusrahmen, Mono-Labels, reduced-motion.
 *   B agentennetzwerk.css, NUR die .nw-detail-Regeln (P22-T255-Zeile): dieselben Pruefungen, hell/dunkel ueber Tokens.
 *   C ChannelFenster.tsx / NetzErgebnisFenster.tsx / ChannelSuche.tsx: Funktion unveraendert (Ziehen per Pointer-Capture,
 *     Minimieren/Schliessen, aria-Labels, Portal in .synapse-control, Lesestand-Route, Suche).
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
const ohneKommentar = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = (css) => css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
const radien = (css) => [...css.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
const radienOk = (r) => r.every((x) => x === '0' || /^[0-3]px$/.test(x));
/** Alle Regeln (Selektor + Block) eines Selektor-Praefixes, auch innerhalb von @media. */
const regeln = (css, praefix) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(praefix)).map((m) => ({ sel: m[1].trim(), body: m[2] }));
const block = (liste, sel) => liste.find((r) => r.sel.split(',').map((s) => s.trim()).includes(sel))?.body ?? '';

// ---------------------------------------------------------------- A Channel-Fenster und -Suche
const T254 = 'packages/web-ui/src/channel-fenster-p22-t254.css';
const c = ohneKommentar(lies(T254));
ok(festeFarben(c).length === 0, 'P22-T260 ' + T254 + ': keine festen Farbwerte (auch keine var()-Fallbacks), nur Theme-Variablen', festeFarben(c));
ok(!/var\(--[a-z0-9-]+,/.test(c), 'P22-T260 ' + T254 + ': keine var(--x, Fallback)', c.match(/var\(--[a-z0-9-]+,[^)]*\)/g));
ok(radienOk(radien(c)), 'P22-T260 ' + T254 + ': Ecken 0-3px', radien(c));
const cr = regeln(c, '');
const fenster = block(cr, '.channel-eigenfenster');
ok(/border:1px solid var\(--border\)/.test(fenster) && !/border:[^;]*var\(--accent\)/.test(fenster), 'P22-T260 ' + T254 + ' .channel-eigenfenster: Hairline in --border statt Orange-Vollrahmen', fenster);
ok(/box-shadow:[^;]*color-mix\(in srgb,var\(--text\)/.test(fenster), 'P22-T260 ' + T254 + ' .channel-eigenfenster: Schatten ueber color-mix (hell weich)', fenster);
const kopf = block(cr, '.channel-eigenfenster-kopf');
ok(/background:var\(--strong\)/.test(kopf) && /border-bottom:1px solid var\(--border\)/.test(kopf) && /cursor:grab/.test(kopf), 'P22-T260 ' + T254 + ' Kopf: --strong, Hairline unten, cursor grab', kopf);
const knopf = block(cr, '.channel-eigenfenster-knopf');
ok(/"IBM Plex Mono"/.test(knopf) && /text-transform:uppercase/.test(knopf) && /border:1px solid var\(--border\)/.test(knopf), 'P22-T260 ' + T254 + ' Kopfknoepfe: Mono-Label, Hairline (kein Browser-Standard)', knopf);
const feld = block(cr, '.channel-suche input');
ok(feld && !/var\(--accent\)/.test(feld), 'P22-T260 ' + T254 + ' Suchfeld: ohne Dauer-Orange', feld);
ok(/var\(--accent\)/.test(block(cr, '.channel-suche input:focus-visible')), 'P22-T260 ' + T254 + ' Suchfeld: Orange nur bei :focus-visible');
const suche = block(cr, '.seitenleiste-projektsuche.channel-suche');
ok(/border:1px solid var\(--border\)/.test(suche), 'P22-T260 ' + T254 + ' .seitenleiste-projektsuche.channel-suche: Orange-Rahmen der Projektsuche durch Hairline ersetzt', suche);
ok(/outline:2px solid var\(--accent\)/.test(block(cr, '.seitenleiste-projektsuche.channel-suche .channel-suche-liste button:focus-visible')), 'P22-T260 ' + T254 + ' Trefferliste: Fokusrahmen');
ok(/"IBM Plex Mono"/.test(block(cr, '.seitenleiste-projektsuche.channel-suche .channel-suche-liste small')) && /var\(--faint\)/.test(block(cr, '.seitenleiste-projektsuche.channel-suche .channel-suche-liste small')), 'P22-T260 ' + T254 + ' Treffer-Meta: Mono in --faint');
ok(!/\d(\.\d+)?rem\b/.test(c), 'P22-T260 ' + T254 + ': px-Raster wie die Nachbarn (kein rem)', c.match(/[\d.]+rem/g));
ok(/@media \(prefers-reduced-motion:reduce\)/.test(c) && /@media \(hover:none\)/.test(c), 'P22-T260 ' + T254 + ': reduced-motion und Touch beruecksichtigt');
ok(!/\b(Inter|Roboto|Arial|Outfit)\b/.test(c) && /"Syne"/.test(c), 'P22-T260 ' + T254 + ': Syne-Titel, keine generischen Fonts');

// ---------------------------------------------------------------- B Ergebnis-Detailfenster (nur .nw-detail-Regeln)
const NW = 'packages/web-ui/src/agentennetzwerk.css';
const nwZeilen = lies(NW).split('\n');
const nwIdx = nwZeilen.findIndex((z) => z.startsWith('.nw-detail-fenster{'));
ok(nwIdx >= 0 && /P22-T255/.test(nwZeilen[nwIdx - 1] ?? ''), 'P22-T260 ' + NW + ': .nw-detail-Zeile direkt unter dem P22-T255-Kommentar', nwIdx);
const nw = nwZeilen[nwIdx] ?? '';
ok(festeFarben(nw).length === 0, 'P22-T260 ' + NW + ' .nw-detail: keine festen Farben (Fenster wird im hellen Theme hell)', festeFarben(nw));
ok(radienOk(radien(nw)), 'P22-T260 ' + NW + ' .nw-detail: Ecken 0-3px', radien(nw));
const nr = regeln(nw, '.nw-detail');
const nf = block(nr, '.nw-detail-fenster');
ok(/background:var\(--panel\)/.test(nf) && /color:var\(--text\)/.test(nf) && /border:1px solid var\(--border\)/.test(nf), 'P22-T260 ' + NW + ' .nw-detail-fenster: Panel/Text/Hairline aus Tokens', nf);
ok(/background:var\(--strong\)/.test(block(nr, '.nw-detail-fenster header')), 'P22-T260 ' + NW + ' Kopf: --strong');
const dt = block(nr, '.nw-detail-inhalt dt');
ok(/"IBM Plex Mono"/.test(dt) && /text-transform:uppercase/.test(dt) && /var\(--muted\)/.test(dt), 'P22-T260 ' + NW + ' dt: Mono-Label in --muted', dt);
ok(/outline:2px solid var\(--accent\)/.test(block(nr, '.nw-detail-fenster header button:focus-visible')), 'P22-T260 ' + NW + ' Kopfknopf: Fokusrahmen');
ok(/prefers-reduced-motion:reduce/.test(nw), 'P22-T260 ' + NW + ' .nw-detail: reduced-motion');

// ---------------------------------------------------------------- C Funktion unveraendert
const CF = 'packages/web-ui/src/components/ChannelFenster.tsx';
const cf = lies(CF);
ok(/setPointerCapture\(e\.pointerId\)/.test(cf) && /onPointerDown=\{down\}/.test(cf) && /closest\('button'\)/.test(cf), 'P22-T260 ' + CF + ': Ziehen per Pointer-Capture, Knoepfe ausgenommen');
ok(/setMinimiert\(v=>!v\)/.test(cf) && /\{minimiert\?'Öffnen':'Minimieren'\}/.test(cf) && /aria-label="Channel schließen"/.test(cf), 'P22-T260 ' + CF + ': Minimieren/Oeffnen und Schliessen mit aria-label');
ok(/role="dialog"/.test(cf) && /aria-label=\{'Channel '\+channel\}/.test(cf) && /\/user-gelesen'/.test(cf), 'P22-T260 ' + CF + ': Dialog-Rolle und Lesestand-Route unveraendert');
ok(/document\.querySelector\('\.synapse-control'\) \?\? document\.body/.test(cf), 'P22-T260 ' + CF + ': Portal in .synapse-control (Theme-Tokens gelten im Fenster)');
const NE = 'packages/web-ui/src/components/netzwerk/NetzErgebnisFenster.tsx';
const ne = lies(NE);
ok(/aria-label="Ergebnis schließen"/.test(ne) && /onClick=\{onClose\}/.test(ne) && /setPointerCapture\(e\.pointerId\)/.test(ne), 'P22-T260 ' + NE + ': Schliessen und Ziehen unveraendert');
ok(/ladeNetzErgebnis\(project,id\)/.test(ne) && /document\.querySelector\('\.synapse-control'\) \?\? document\.body/.test(ne), 'P22-T260 ' + NE + ': Datenquelle und Portal unveraendert');
const CS = 'packages/web-ui/src/components/ChannelSuche.tsx';
const cs = lies(CS);
ok(/className="seitenleiste-projektsuche channel-suche"/.test(cs) && /sortiereChannelSuche\(channels,ungelesen,such\)/.test(cs) && /channels-user-ungelesen/.test(cs), 'P22-T260 ' + CS + ': Klassen, Sortierung und Lesestand-Route unveraendert');

console.log('P22-T260 Design Channel-Fenster/-Suche und Ergebnis-Detailfenster: ' + n + ' Pruefungen OK');
