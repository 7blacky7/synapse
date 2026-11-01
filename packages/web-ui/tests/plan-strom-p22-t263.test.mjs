/**
 * P22-T263: Editor-Live-Plan als durchgehender Strom aus PG - Logik, Gestaltung und Einbindung, ohne DB, Netz und Browser.
 *   node --experimental-strip-types packages/web-ui/tests/plan-strom-p22-t263.test.mjs
 * Herkunft: User-Vorgabe thought 9a3005ff (01.11.2026), Task P22-T263, Bestand c31f5886, Befund 3ff89583 (Animation 9 s nach 3 s
 * abgeschnitten), Koordinator 34555 (Einstellung im bestehenden Einstellweg, keine neue Tabelle).
 * Sichert ab:
 *   A components/editor/plan-strom-logik.ts: Strom haelt Plaene selbst fest, Abschluss nie abgeschnitten (Offen-Fenster UND
 *     Abschlussanimation, dann Ausblenden), geoeffneter Plan bleibt, Wegklicken startet das Fenster neu, geloeschter offener Plan
 *     = verworfen, spaetes 'open' nach Abschluss ignoriert, Notbremse (unvollstaendige Liste) verwirft nichts, ein Timer je Aenderung.
 *   B editor-plan-strom-p22-t263.css: nur Theme-Variablen, Ecken 0-3px, Mono/keine generischen Fonts, Abschluss auf ::after mit
 *     derselben Dauer wie ABSCHLUSS_ANIMATION_MS, Ausblenden = AUSBLENDEN_MS, reduzierte Bewegung, schmale Breiten.
 *   C PlanStrom.tsx/ProjektEditor.tsx: Routen plan-strom/plan-verlauf/plan-ergebnis/schatten, Verlauf-Knopf, Detail mit Schatten und
 *     committeten Inhalten, Einbindung nur bei strom.aktiv (AUS = Ansicht P22-T262), SSE-Zaehler, keine Inline-Gestaltung ausser Fristvariablen.
 *   D core: Schalter editor_plan_strom Standard AUS + nur ausdruecklich; editor_plan_offen_sekunden=20 neben plan_nachleuchten_sekunden=3
 *     (unveraendert); keine neue Tabelle; Ops-Projektion ohne Inhalte; Routen pruefen beide Schalter.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// ---------------------------------------------------------------- A Logik
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/editor/plan-strom-logik.ts')).href);
const plan = (id, zustand, ops = 1) => ({ id: String(id), owner_agent_id: 'agent-' + id, status: zustand === 'entsteht' ? 'open' : zustand === 'verworfen' ? 'cancelled' : 'committed',
  zustand, auto_commit: zustand === 'auto-committet', open_for_coedit: true, reason: null, erstellt_am: new Date(0).toISOString(), ende_am: null,
  ops: Array.from({ length: ops }, (_, i) => ({ i, action: 'search_replace', file_path: 'src/a' + i + '.ts', new_path: null, reason: null, task_id: null, agent_id: null, zustand: null })),
  dateien: Array.from({ length: ops }, (_, i) => 'src/a' + i + '.ts') });
const OFFEN = 20000, { ABSCHLUSS_ANIMATION_MS: ANIM, ANIMATION_RESERVE_MS: RES, AUSBLENDEN_MS: AUS } = L;
const g = new L.PlanStromGedaechtnis();
g.aktualisiere([plan(10, 'entsteht', 1)], 1000);
let s = g.sichtbar(1000, OFFEN, null);
ok(s.length === 1 && s[0].phase === 'entsteht', 'P22-T263 plan-strom-logik.ts: offener Plan erscheint im Strom (entsteht)', s);
g.aktualisiere([plan(10, 'entsteht', 3)], 1500);
ok(g.hole('10').plan.ops.length === 3, 'P22-T263 plan-strom-logik.ts: entstehender Plan waechst live (Ops kommen dazu)', g.hole('10').plan.ops.length);
g.aktualisiere([plan(10, 'committet', 3)], 2000);
ok(g.hole('10').ende === 2000, 'P22-T263 plan-strom-logik.ts: Abschluss lokal festgehalten', g.hole('10'));
g.aktualisiere([], 2500);
ok(g.sichtbar(2500, OFFEN, null).length === 1, 'P22-T263 plan-strom-logik.ts: Server liefert den Plan nicht mehr -> bleibt trotzdem sichtbar (kein Abschneiden)');
ok(L.phase(g.hole('10'), 2000 + OFFEN - 1, OFFEN, null) === 'abgeschlossen', 'P22-T263 plan-strom-logik.ts: vor Ablauf des Offen-Fensters (20 s) sichtbar');
ok(L.phase(g.hole('10'), 2000 + OFFEN, OFFEN, null) === 'geht', 'P22-T263 plan-strom-logik.ts: nach dem Offen-Fenster erst Ausblenden (geht), nicht sofort weg');
ok(L.phase(g.hole('10'), 2000 + OFFEN + AUS, OFFEN, null) === 'weg', 'P22-T263 plan-strom-logik.ts: nach dem Ausblenden weg');
// Kurzes Fenster: Animation laeuft trotzdem zu Ende.
const kurzMs = 1000;
ok(L.phase(g.hole('10'), 2000 + kurzMs + 10, kurzMs, null) === 'abgeschlossen', 'P22-T263 plan-strom-logik.ts: kurzes Fenster schneidet die Abschlussanimation nicht ab');
ok(L.gehtAb(g.hole('10'), kurzMs) === 2000 + ANIM + RES, 'P22-T263 plan-strom-logik.ts: ohne animationend gilt die Reserve', L.gehtAb(g.hole('10'), kurzMs));
g.animationFertig('10', 2000 + ANIM);
ok(L.gehtAb(g.hole('10'), kurzMs) === 2000 + ANIM, 'P22-T263 plan-strom-logik.ts: animationend beendet die Wartezeit genau am Animationsende', L.gehtAb(g.hole('10'), kurzMs));
// Geoeffnet bleibt, Wegklicken startet das Fenster neu.
ok(L.phase(g.hole('10'), 2000 + OFFEN * 5, OFFEN, '10') === 'abgeschlossen', 'P22-T263 plan-strom-logik.ts: geoeffneter fertiger Plan bleibt offen');
g.geschlossen('10', 2000 + OFFEN * 5);
ok(L.phase(g.hole('10'), 2000 + OFFEN * 5 + OFFEN - 1, OFFEN, null) === 'abgeschlossen' && L.phase(g.hole('10'), 2000 + OFFEN * 6, OFFEN, null) === 'geht', 'P22-T263 plan-strom-logik.ts: Wegklicken -> nur der Plan, noch einmal das Offen-Fenster lang');
// Spaetes open nach Abschluss ignoriert.
g.aktualisiere([plan(10, 'entsteht', 3)], 2000 + OFFEN * 5 + 5);
ok(g.hole('10').plan.zustand === 'committet', 'P22-T263 plan-strom-logik.ts: spaetes open nach Abschluss (Rennen) ignoriert', g.hole('10').plan.zustand);
// Geloeschter offener Plan -> verworfen; Notbremse wertet nicht.
const g2 = new L.PlanStromGedaechtnis();
g2.aktualisiere([plan(20, 'entsteht'), plan(21, 'entsteht')], 0);
g2.aktualisiere([plan(21, 'entsteht')], 100, { vollstaendig: false });
ok(g2.hole('20').ende === null, 'P22-T263 plan-strom-logik.ts: unvollstaendige Liste (Notbremse) verwirft nichts');
g2.aktualisiere([plan(21, 'entsteht')], 200);
ok(g2.hole('20').plan.zustand === 'verworfen' && g2.hole('20').ende === 200, 'P22-T263 plan-strom-logik.ts: offener Plan, den PG nicht mehr liefert, gilt als verworfen', g2.hole('20'));
ok(g2.anzahlEntstehend() === 1, 'P22-T263 plan-strom-logik.ts: Zaehler entstehender Plaene', g2.anzahlEntstehend());
ok(g2.sichtbar(300, OFFEN, null).map((e) => e.plan.id).join() === '21,20', 'P22-T263 plan-strom-logik.ts: neueste zuerst');
ok(g2.naechsteAenderung(300, OFFEN, null) === 200 + OFFEN, 'P22-T263 plan-strom-logik.ts: genau ein Timer bis zur naechsten Phasenaenderung', g2.naechsteAenderung(300, OFFEN, null));
ok(g2.aufraeumen(200 + OFFEN + AUS, OFFEN, null).join() === '20' && !g2.hole('20'), 'P22-T263 plan-strom-logik.ts: aufraeumen entfernt nur ausgeblendete Plaene');
// Schnell auto-committeter Plan, nie offen gesehen: erscheint trotzdem mit Abschluss.
const g3 = new L.PlanStromGedaechtnis();
g3.aktualisiere([plan(30, 'auto-committet')], 50);
ok(g3.sichtbar(60, OFFEN, null)[0]?.phase === 'abgeschlossen' && g3.hole('30').ende === 50, 'P22-T263 plan-strom-logik.ts: nie offen gesehener Plan zeigt seinen Abschluss trotzdem');
ok(L.geaenderteZeilen('a\nb', 'a\nc\nb').join() === 'false,true,false', 'P22-T263 plan-strom-logik.ts: geaenderte Zeilen im Commit-Ergebnis markiert');

// ---------------------------------------------------------------- B CSS
const cssPfad = 'packages/web-ui/src/editor-plan-strom-p22-t263.css';
const c = lies(cssPfad).replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = c.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
ok(festeFarben.length === 0, 'P22-T263 ' + cssPfad + ': keine festen Farbwerte, nur Theme-Variablen (hell und dunkel)', festeFarben);
const radien = [...c.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
ok(radien.every((r) => r === '0' || r === '50%' || /^[0-3]px$/.test(r)), 'P22-T263 ' + cssPfad + ': Ecken 0-3px (Punkte rund)', radien);
ok(!/\b(Inter|Roboto|Arial|Outfit|system-ui)\b/.test(c) && /"IBM Plex Mono"/.test(c), 'P22-T263 ' + cssPfad + ': Mono-Labels, keine generischen Fonts');
const vars = new Set([...c.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
const fremd = [...vars].filter((v) => !['accent', 'accent-soft', 'accent-contrast', 'panel', 'strong', 'soft', 'bg', 'text', 'muted', 'faint', 'border', 'border2', 'danger', 'success', 'offen-ms', 'offen-seit'].includes(v));
ok(fremd.length === 0, 'P22-T263 ' + cssPfad + ': nur bekannte Theme-Variablen (plus --offen-ms/--offen-seit der Fristleiste)', fremd);
const dauer = (name) => { const m = c.match(new RegExp('animation:' + name + ' ([0-9.]+)s')); return m ? Math.round(Number(m[1]) * 1000) : null; };
ok(dauer('ed-strom-abschluss') === ANIM && dauer('ed-strom-verworfen') === ANIM, 'P22-T263 ' + cssPfad + ': Abschlussanimation dauert ABSCHLUSS_ANIMATION_MS (Logik und CSS gleich)', [dauer('ed-strom-abschluss'), dauer('ed-strom-verworfen'), ANIM]);
ok(dauer('ed-strom-raus') === AUS, 'P22-T263 ' + cssPfad + ': Ausblenden dauert AUSBLENDEN_MS', [dauer('ed-strom-raus'), AUS]);
ok(/\.ed-strom-plan:is\([^)]*committet[^)]*\)::after\{animation:ed-strom-abschluss/.test(c), 'P22-T263 ' + cssPfad + ': Abschluss auf eigener Ebene ::after (Einlauf der Karte wird nicht ersetzt)');
ok(/\.ed-strom-ops>li\{[^}]*animation:ed-strom-op-rein/.test(c), 'P22-T263 ' + cssPfad + ': jede neue Op laeuft einzeln ein');
ok(/\.ed-strom-frist\{[^}]*animation:ed-strom-frist var\(--offen-ms[^)]*\) linear var\(--offen-seit/.test(c), 'P22-T263 ' + cssPfad + ': Fristleiste zeigt das Offen-Fenster');
ok(/prefers-reduced-motion:reduce/.test(c) && /@media \(max-width:760px\)/.test(c), 'P22-T263 ' + cssPfad + ': reduzierte Bewegung und schmale Breiten');
ok(/@keyframes ed-strom-abschluss/.test(c) && /@keyframes ed-strom-verworfen/.test(c) && /@keyframes ed-strom-raus/.test(c) && /@keyframes ed-strom-frist/.test(c), 'P22-T263 ' + cssPfad + ': alle Keyframes vorhanden');

// ---------------------------------------------------------------- C Ansichten und Einbindung
const ps = lies('packages/web-ui/src/components/editor/PlanStrom.tsx');
for (const r of ["'/api/main-agent/editor/plan-strom?project='", "'/api/main-agent/editor/plan-verlauf?project='", "'/api/main-agent/editor/plan-ergebnis?project='", "'/api/main-agent/editor/schatten?project='"])
  ok(ps.includes(r), 'P22-T263 PlanStrom.tsx: Route ' + r);
ok(ps.includes('Verlauf') && ps.includes('aria-pressed={strom.verlaufAn}') && ps.includes('Ältere Pläne laden'), 'P22-T263 PlanStrom.tsx: Verlauf-Knopf mit Nachladen');
ok(ps.includes("'Schatten · live'") && ps.includes('Committet · aus PG') && ps.includes('Letzter Schatten'), 'P22-T263 PlanStrom.tsx: Detail zeigt Schatten und nach Commit die Inhalte aus PG');
ok(ps.includes("ev.animationName === 'ed-strom-abschluss'") && ps.includes('strom.animationFertig(p.id)'), 'P22-T263 PlanStrom.tsx: animationend meldet das Ende der Abschlussanimation');
ok(ps.includes('vollstaendig: d.voll !== true'), 'P22-T263 PlanStrom.tsx: Notbremse des Servers wird an die Logik weitergegeben');
ok(!/style=\{\{(?! '--offen-ms')/.test(ps), 'P22-T263 PlanStrom.tsx: keine Inline-Gestaltung ausser den Fristvariablen');
// H2 (Abnahme 6d46d12a, Koordinator vor Deploy t232): Schatten nur fuer geaenderte Dateien, je Datei hoechstens 1 Abruf pro Sekunde.
{
  const p = plan(30, 'entsteht', 2), sig = (f) => L.dateiSignatur(p, f), t0 = 100000;
  ok(L.dateiSignatur(p, 'src/a0.ts') === '0:search_replace:' && L.dateiSignatur(p, 'src/x.ts') === '', 'P22-T263 H2 plan-strom-logik.ts dateiSignatur: Ops je Datei (Index, Art, Zustand)', L.dateiSignatur(p, 'src/a0.ts'));
  const erst = L.schattenFaellig(p.dateien, sig, new Map(), t0);
  ok(erst.jetzt.length === 2 && erst.naechste === null, 'P22-T263 H2 schattenFaellig: beim Oeffnen jede Datei einmal', erst);
  const stand = new Map(p.dateien.map((f) => [f, { sig: sig(f), zeit: t0 }]));
  const ruhig = L.schattenFaellig(p.dateien, sig, stand, t0 + 500);
  ok(ruhig.jetzt.length === 0 && ruhig.naechste === t0 + L.SCHATTEN_AUFFRISCHEN_MS, 'P22-T263 H2 schattenFaellig: ohne Aenderung kein Abruf, nur Auffrischen nach SCHATTEN_AUFFRISCHEN_MS', ruhig);
  const p2 = { ...p, ops: [...p.ops, { ...p.ops[0], i: 2 }] }, sig2 = (f) => L.dateiSignatur(p2, f);
  const zuFrueh = L.schattenFaellig(p2.dateien, sig2, stand, t0 + 300);
  ok(zuFrueh.jetzt.length === 0 && zuFrueh.naechste === t0 + L.SCHATTEN_TAKT_MS, 'P22-T263 H2 schattenFaellig: geaenderte Datei innerhalb 1 s -> gedrosselt, Wecker zum Taktende', zuFrueh);
  const spaeter = L.schattenFaellig(p2.dateien, sig2, stand, t0 + L.SCHATTEN_TAKT_MS);
  ok(spaeter.jetzt.length === 1 && spaeter.jetzt[0] === 'src/a0.ts', 'P22-T263 H2 schattenFaellig: nach dem Takt NUR die geaenderte Datei', spaeter);
  ok(L.SCHATTEN_TAKT_MS >= 1000, 'P22-T263 H2: hoechstens 1 Abruf je Datei und Sekunde', L.SCHATTEN_TAKT_MS);
  ok(ps.includes('schattenFaellig(p.dateien.slice(0, schattenMax), sigVon, schattenStand.current, t)') && ps.includes('faellig.map(async (f)') && !ps.includes('p.dateien.slice(0, SCHATTEN_MAX_DATEIEN).map(async'),
    'P22-T263 H2 PlanStrom.tsx: Detail laedt nur faellige Schatten (nicht mehr alle je Abgleich)');
  ok(ps.includes('setSchattenWecker(n => n + 1)') && ps.includes('if (wecker !== null) window.clearTimeout(wecker)'), 'P22-T263 H2 PlanStrom.tsx: gedrosselte Abrufe holt ein Wecker nach, Aufraeumen beim Wechsel');
}
const t = lies('packages/web-ui/src/components/ProjektEditor.tsx');
ok(t.includes("import { usePlanStrom, PlanStromListe, PlanStromDetail } from './editor/PlanStrom';") && t.includes('const strom=usePlanStrom({project,live,ereignisNr,onFehler:setFehler});'), 'P22-T263 ProjektEditor.tsx: Hook eingebunden');
ok(t.includes('source.onmessage=()=>{setEreignisNr(n=>n+1);'), 'P22-T263 ProjektEditor.tsx: bestehender SSE-Strom stoesst den Plan-Strom an (keine zweite Verbindung)');
ok(t.includes("{seite==='live'&&strom.aktiv\n     ? <PlanStromListe strom={strom} pfad={pfad}/>") && t.includes('{strom.aktiv&&!zu&&<PlanStromDetail strom={strom}/>}'), 'P22-T263 ProjektEditor.tsx: Strom nur bei strom.aktiv, sonst Ansicht P22-T262 (Detail nicht auf der Leinwand)');
ok(t.includes('ed-plan nachklang') && t.includes('Number(d.nachleuchten_sekunden)*1000'), 'P22-T263 ProjektEditor.tsx: Schalter AUS = bisheriges Nachleuchten unveraendert');
ok(t.includes('Mein Plan') && t.includes("json('/api/main-agent/editor/user-plan',{method:'POST'"), 'P22-T263/T264 ProjektEditor.tsx: Speichern-Teil liegt bei P22-T264 (User-Plan), Strom unabhaengig davon');

// ---------------------------------------------------------------- D core, REST, Einstellweg
const kat = lies('packages/core/src/services/agent-profil-schalter.ts');
const nur = kat.slice(kat.indexOf('export const NUR_AUSDRUECKLICH')).split('\n')[0];
const ein = kat.slice(kat.indexOf('export const STANDARD_EIN')).split('\n')[0];
ok(kat.includes("  'editor_plan_strom',") && nur.includes("'editor_plan_strom'") && !ein.includes('editor_plan_strom'), 'P22-T263 agent-profil-schalter.ts: Schalter editor_plan_strom im Katalog, Standard AUS, nur ausdruecklich');
const netz = lies('packages/core/src/services/agentennetzwerk.ts');
ok(/editor_plan_offen_sekunden: \{ standard: 20, min: 1, max: 3600 \}/.test(netz), 'P22-T263 agentennetzwerk.ts: editor_plan_offen_sekunden=20 im bestehenden Einstellweg');
ok(/plan_nachleuchten_sekunden: \{ standard: 3, min: 1, max: 300 \}/.test(netz), 'P22-T263 agentennetzwerk.ts: plan_nachleuchten_sekunden (Netzwerk, 3 s) unveraendert');
const form = lies('packages/web-ui/src/components/netzwerk/einstellungen-form.ts');
ok(form.includes("editor_plan_offen_sekunden: 'Editor: fertiger Plan bleibt offen (Sekunden)'") && form.includes("'plan_trabanten_max', 'editor_plan_offen_sekunden']"), 'P22-T263 einstellungen-form.ts: Beschriftung und Gruppe Pläne');
const dienst = lies('packages/core/src/services/editor-plan-strom.ts');
ok(!/CREATE TABLE/i.test(dienst) && !existsSync(join(repo, 'packages/core/src/db/schema-sql/177_editor_einstellungen.sql')), 'P22-T263 editor-plan-strom.ts: keine neue Tabelle (Koordinator 34555)');
const projektion = dienst.slice(dienst.indexOf('const PLAN_SPALTEN'), dienst.indexOf('p.op_zustaende`'));
ok(!/'content'|'search'|'replace'|'edits'/.test(projektion), 'P22-T263 editor-plan-strom.ts: Ops-Projektion ohne Dateiinhalte', projektion);
ok(dienst.includes('maskiereDatei(z.file_path, z.vorher)') && dienst.includes('maskiereDatei(z.file_path, nachherRoh)'), 'P22-T263 editor-plan-strom.ts: Commit-Ergebnis maskiert sensible Dateien');
const rt = lies('packages/rest-api/src/routes/agent-runtimes.ts');
for (const r of ['/api/main-agent/editor/plan-strom', '/api/main-agent/editor/plan-verlauf', '/api/main-agent/editor/plan-ergebnis'])
  ok(rt.includes("'" + r + "'"), 'P22-T263 agent-runtimes.ts: Route ' + r);
ok(rt.includes("leseUiProduktSchalter('editor_plan_strom', project)") && rt.includes('const aktiv=editor.aktiv && !editor.letzter_fehler && strom.aktiv && !strom.letzter_fehler'), 'P22-T263 agent-runtimes.ts: Routen pruefen editor_modul UND editor_plan_strom');
ok(!/fastify\.put[^\n]*editor\/einstellungen/.test(rt), 'P22-T263 agent-runtimes.ts: kein eigener Einstellweg (Setzen ueber admin agentennetzwerk einstellen)');

console.log('OK P22-T263 Editor-Plan-Strom: ' + n + ' Pruefungen');
