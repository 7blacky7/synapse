/**
 * P22-T263 Leinwand (Nacharbeit, User-Vorgabe thought ad8d1f41 vom 01.11.2026; Koordinator-Entscheidung 8d464d44 H1) - ohne DB, Netz, Browser.
 *   node --experimental-strip-types packages/web-ui/tests/plan-leinwand-p22-t263.test.mjs   (nach Core-Build: nutzt core dist file-diff.js)
 * Sichert ab:
 *   A components/editor/plan-strom-logik.ts: hunkZeilen/diffStuecke decken die Datei lueckenlos ab (mit den ECHTEN Server-Hunks aus
 *     core file-diff.ts dateiDiff, auch CRLF), Luecken aufklappbar, Signatur/Abruf-Takt der Leinwand, Mitlaufen am unteren Rand.
 *   B editor-plan-leinwand-p22-t263.css: nur Theme-Variablen (hell und dunkel), Ecken 0-3px, Mono-Labels, Keyframes des Plan-Stroms mit
 *     denselben Dauern (nichts abgeschnitten), eingeklappter Explorer, reduzierte Bewegung, schmale Breiten.
 *   C PlanLeinwand.tsx / PlanStrom.tsx / ProjektEditor.tsx: Route plan-aenderungen, alle Ops ohne Kappung, Explorer einklappbar NUR mit
 *     Schalter editor_plan_leinwand, eingeklappt Leinwand statt Code, H1 Schatten nachladbar, nicht_anwendbar im Drei-Wege-Vergleich.
 *   D core/REST: Schalter editor_plan_leinwand Standard AUS + nur ausdruecklich, Route prueft leinwand, keine neue Tabelle.
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
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// ---------------------------------------------------------------- A Logik
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/editor/plan-strom-logik.ts')).href);
const D = await import(pathToFileURL(join(repo, 'packages/core/dist/services/file-diff.js')).href);
// Server-Hunks -> Leinwand: mit allen Luecken offen ergeben die Zeilen exakt vorher und nachher (keine Zeile faellt weg, keine doppelt).
const rekonstruiere = (alt, neu) => {
  const d = D.dateiDiff(alt, neu), hunks = d.hunks.map((h) => ({ a0: h.a0, a1: h.a1, b0: h.b0, b1: h.b1, bereiche: h.bereiche, ops: [0] }));
  const A = L.anzeigeZeilen(alt), B = L.anzeigeZeilen(neu);
  const st = L.diffStuecke(hunks, A.length, () => true), zeilen = st.flatMap((s) => (s.art === 'luecke' ? [] : s.zeilen));
  return { d, st, hunks, vorher: zeilen.filter((z) => z.art !== 'neu').map((z) => A[z.a]).join('\n'), nachher: zeilen.filter((z) => z.art !== 'weg').map((z) => B[z.b]).join('\n'), A, B };
};
const alt = Array.from({ length: 40 }, (_, i) => 'zeile ' + (i + 1)).join('\n');
const neu = alt.replace('zeile 3\n', 'zeile 3 neu\n').replace('zeile 30\n', '').replace('zeile 40', 'zeile 40\nzeile 41');
const r = rekonstruiere(alt, neu);
ok(r.vorher === alt && r.nachher === neu, 'P22-T263 Leinwand plan-strom-logik.ts diffStuecke+hunkZeilen: alle Luecken offen = vorher und nachher exakt (Server-Hunks aus file-diff.ts)', { vorher: r.vorher.slice(0, 80), nachher: r.nachher.slice(0, 80) });
const zu = L.diffStuecke(r.hunks, r.A.length, () => false);
const gedeckt = zu.reduce((s, x) => s + (x.art === 'luecke' ? x.anzahl : x.zeilen.filter((z) => z.art !== 'neu').length), 0);
ok(gedeckt === r.A.length && zu.some((x) => x.art === 'luecke') && zu.filter((x) => x.art === 'hunk').length === r.d.hunks.length,
  'P22-T263 Leinwand diffStuecke: Hunks vollstaendig + Luecken decken die alte Datei lueckenlos ab (nichts gekappt)', { gedeckt, laenge: r.A.length, arten: zu.map((x) => x.art) });
const luecke = zu.find((x) => x.art === 'luecke');
const auf = L.diffStuecke(r.hunks, r.A.length, (s) => s === luecke.schluessel);
ok(auf.some((x) => x.art === 'umfeld' && x.schluessel === luecke.schluessel && x.zeilen.length === luecke.anzahl), 'P22-T263 Leinwand diffStuecke: eine Luecke aufgeklappt = genau ihre Zeilen', auf.map((x) => x.art));
ok(r.st.filter((x) => x.art === 'hunk').every((x) => /^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(x.kopf)), 'P22-T263 Leinwand hunkKopf: Unified-Diff-Kopf', r.st.map((x) => x.kopf));
const crlf = rekonstruiere('a\r\nb\r\nc', 'a\r\nB\r\nc');
ok(crlf.vorher === 'a\nb\nc' && crlf.nachher === 'a\nB\nc' && crlf.d.crlf, 'P22-T263 Leinwand anzeigeZeilen: CRLF wie der Server nur fuer die Anzeige normalisiert (Indizes passen)', crlf);
const neuDatei = rekonstruiere('', 'x\ny');
ok(neuDatei.st.length === 1 && neuDatei.st[0].art === 'hunk' && neuDatei.st[0].zeilen.filter((z) => z.art === 'neu').length === 2, 'P22-T263 Leinwand: neue Datei = ein Hunk mit allen Zeilen', neuDatei.st);
ok(L.hunkZeilen({ a0: 0, a1: 3, b0: 0, b1: 3, bereiche: [{ a0: 1, a1: 2, b0: 1, b1: 2 }], ops: [] }).map((z) => z.art).join() === 'gleich,weg,neu,gleich', 'P22-T263 Leinwand hunkZeilen: Umfeld, erst entfernt, dann neu');
// Abruf-Takt (Last wie H2, Pool-Befund 3c89b7a2).
{
  const plan = (id, zustand, ops = 1) => ({ id: String(id), zustand, ops: Array.from({ length: ops }, (_, i) => ({ i, action: 'search_replace', zustand: null })) });
  const t0 = 500000, a = plan(1, 'entsteht'), b = plan(2, 'committet');
  const erst = L.leinwandFaellig([a, b], new Map(), t0);
  ok(erst.jetzt.join() === '1,2', 'P22-T263 Leinwand leinwandFaellig: beim ersten Sehen jeder Plan einmal', erst);
  const stand = new Map([[a.id, { sig: L.leinwandSignatur(a), zeit: t0 }], [b.id, { sig: L.leinwandSignatur(b), zeit: t0 }]]);
  const ruhig = L.leinwandFaellig([a, b], stand, t0 + 500);
  ok(ruhig.jetzt.length === 0 && ruhig.naechste === t0 + L.SCHATTEN_AUFFRISCHEN_MS, 'P22-T263 Leinwand leinwandFaellig: ohne Aenderung kein Abruf, entstehender Plan frischt nach SCHATTEN_AUFFRISCHEN_MS auf', ruhig);
  const spaet = L.leinwandFaellig([b], stand, t0 + 10 * L.SCHATTEN_AUFFRISCHEN_MS);
  ok(spaet.jetzt.length === 0 && spaet.naechste === null, 'P22-T263 Leinwand leinwandFaellig: beendeter Plan mit gleicher Signatur nie wieder', spaet);
  const a2 = plan(1, 'entsteht', 2);
  const frueh = L.leinwandFaellig([a2], stand, t0 + 300), takt = L.leinwandFaellig([a2], stand, t0 + L.SCHATTEN_TAKT_MS);
  ok(frueh.jetzt.length === 0 && frueh.naechste === t0 + L.SCHATTEN_TAKT_MS && takt.jetzt.join() === '1', 'P22-T263 Leinwand leinwandFaellig: neue Op -> hoechstens 1 Abruf je Plan und Sekunde', { frueh, takt });
  const fertig = plan(1, 'committet', 2);
  ok(L.leinwandFaellig([fertig], stand, t0 + L.SCHATTEN_TAKT_MS).jetzt.join() === '1', 'P22-T263 Leinwand leinwandFaellig: Abschluss (neue Signatur) laedt die Commit-Inhalte');
  ok(L.LEINWAND_PARALLEL >= 1 && L.LEINWAND_PARALLEL <= 4, 'P22-T263 Leinwand: begrenzte Parallelitaet', L.LEINWAND_PARALLEL);
}
ok(L.amEnde(1000, 952, 0) && !L.amEnde(1000, 900, 0) && L.amEnde(1000, 500, 500), 'P22-T263 Leinwand amEnde: unten (48 px Toleranz) = mitlaufen, sonst bleibt die Leseposition');
// User-Entscheidung cc9c22eb: fertige Plaene verlassen die Live-Leinwand, der Verlauf bleibt (aufgeklappte Verlaufsplaene sind feste Eintraege).
{
  const vp = (id, zustand) => ({ id: String(id), owner_agent_id: 'a', status: zustand === 'verworfen' ? 'cancelled' : 'committed', zustand, auto_commit: false, open_for_coedit: true, reason: null, erstellt_am: new Date(0).toISOString(), ende_am: new Date(0).toISOString(), ops: [], dateien: [] });
  const ve = L.verlaufAlsEintraege([vp(9, 'committet'), vp(8, 'verworfen'), vp(7, 'committet')], new Set(['8', '7']));
  ok(ve.map((e) => e.plan.id).join() === '8,7' && ve.every((e) => e.phase === 'abgeschlossen'), 'P22-T263 Verlauf plan-strom-logik.ts verlaufAlsEintraege: nur aufgeklappte Plaene, Reihenfolge des Verlaufs, Phase immer abgeschlossen', ve.map((e) => [e.plan.id, e.phase]));
  ok(L.leinwandFaellig(ve.map((e) => e.plan), new Map(), 1000).jetzt.join() === '8,7', 'P22-T263 Verlauf leinwandFaellig: aufgeklappter Verlaufsplan wird einmal geladen');
}

// ---------------------------------------------------------------- B CSS
const cssPfad = 'packages/web-ui/src/editor-plan-leinwand-p22-t263.css';
const c = lies(cssPfad).replace(/\/\*[\s\S]*?\*\//g, '');
const festeFarben = c.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
ok(festeFarben.length === 0, 'P22-T263 Leinwand ' + cssPfad + ': keine festen Farbwerte, nur Theme-Variablen (hell und dunkel)', festeFarben);
const vars = new Set([...c.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
const fremd = [...vars].filter((v) => !['accent', 'accent-soft', 'accent-contrast', 'panel', 'strong', 'soft', 'bg', 'text', 'muted', 'faint', 'border', 'border2', 'danger', 'success'].includes(v));
ok(fremd.length === 0, 'P22-T263 Leinwand ' + cssPfad + ': nur bekannte Theme-Variablen', fremd);
const radien = [...c.matchAll(/border-radius:([^;}]+)/g)].map((m) => m[1].trim());
ok(radien.every((x) => x === '0' || x === '50%' || /^[0-3]px$/.test(x)), 'P22-T263 Leinwand ' + cssPfad + ': Ecken 0-3px', radien);
ok(!/\b(Inter|Roboto|Arial|Outfit|system-ui)\b/.test(c) && /"IBM Plex Mono"/.test(c) && /"Syne"/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': Mono-Labels, Syne nur im Leerzustand, keine generischen Fonts');
const L263 = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/editor/plan-strom-logik.ts')).href);
const dauer = (name) => { const m = c.match(new RegExp('animation:' + name + ' ([0-9.]+)s')); return m ? Math.round(Number(m[1]) * 1000) : null; };
ok(dauer('ed-strom-abschluss') === L263.ABSCHLUSS_ANIMATION_MS && dauer('ed-strom-verworfen') === L263.ABSCHLUSS_ANIMATION_MS && dauer('ed-strom-raus') === L263.AUSBLENDEN_MS,
  'P22-T263 Leinwand ' + cssPfad + ': Abschluss und Ausblenden mit den Dauern der Logik (Plan-Strom-Keyframes, nichts abgeschnitten)', [dauer('ed-strom-abschluss'), dauer('ed-strom-verworfen'), dauer('ed-strom-raus')]);
ok(/\.ed-lw-plan:is\([^)]*committet[^)]*\)::after\{animation:ed-strom-abschluss/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': Abschluss auf eigener Ebene ::after');
ok(/\.ed-werkbank\[data-explorer="zu"\]\{grid-template-columns:34px/.test(c) && /\.ed-schiene-text\{writing-mode:vertical-rl/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': eingeklappter Explorer als schmale Schiene');
ok(/\.ed-lw-z\[data-art="neu"\]/.test(c) && /\.ed-lw-z\[data-art="weg"\]/.test(c) && /\.ed-lw-luecke\{/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': Diff-Zeilen neu/weg und aufklappbare Luecken gestaltet');
ok(/\.ed-lw-plan-kopf\{position:sticky/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': Plan-Kopf bleibt beim Lesen oben');
ok(/prefers-reduced-motion:reduce/.test(c) && /@media \(max-width:760px\)/.test(c) && /@media \(max-width:1180px\)/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': reduzierte Bewegung und schmale Breiten');
ok(/\.ed-vergleich-na\{/.test(c) && /\.ed-strom-mehr\{/.test(c), 'P22-T263 Leinwand ' + cssPfad + ': nicht_anwendbar im Vergleich und H1-Nachladen gestaltet');

// ---------------------------------------------------------------- C Ansichten und Einbindung
const lw = lies('packages/web-ui/src/components/editor/PlanLeinwand.tsx');
ok(lw.includes("'/api/main-agent/editor/plan-aenderungen?project='") && lw.includes("'&datei=' + q(pfad)"), 'P22-T263 Leinwand PlanLeinwand.tsx: Route plan-aenderungen, Einzel-Nachladen zurueckgestellter Dateien');
ok(lw.includes('{p.ops.map(o => {') && !/ops\.slice\(/.test(lw), 'P22-T263 Leinwand PlanLeinwand.tsx: ALLE Ops, keine Kappung (User: nicht abgehackt)');
ok(lw.includes('[...strom.eintraege].reverse()') && lw.includes('if (el && folgtRef.current && !verlauf) el.scrollTop = el.scrollHeight'), 'P22-T263 Leinwand PlanLeinwand.tsx: durchgehender Strom (aelteste oben), laeuft unten mit');
ok(lw.includes('strom.umschalten(p.id)') && lw.includes("'Festhalten'") && lw.includes('strom.animationFertig(p.id)'), 'P22-T263 Leinwand PlanLeinwand.tsx: Festhalten = Plan oeffnen, Abschlussanimation meldet ihr Ende');
ok(lw.includes('leinwandFaellig(') && lw.includes('LEINWAND_PARALLEL - laufend.current.size'), 'P22-T263 Leinwand PlanLeinwand.tsx: gedrosselter Abruf je Plan, begrenzt parallel');
ok(lw.includes('useZeilenTokens(f.file_path, f.vorher)') && lw.includes('useZeilenTokens(f.file_path, f.nachher)'), 'P22-T263 Leinwand PlanLeinwand.tsx: Syntax-Hervorhebung vorher und nachher (editor_syntax)');
ok(lw.includes("'nicht_anwendbar'") && lw.includes('nicht anwendbar · {n.fehler}'), 'P22-T263 Leinwand PlanLeinwand.tsx: nicht anwendbare Ops mit Grund an der Op');
ok(lw.includes('data-leinwand="an"') && lw.includes('data-plaene={reihe.length}') && lw.includes('data-quelle={d?.quelle || undefined}'), 'P22-T263 Leinwand PlanLeinwand.tsx: Debug-Attribute');
ok(!/style=\{\{/.test(lw) && !/:\s*any\b/.test(lw), 'P22-T263 Leinwand PlanLeinwand.tsx: keine Inline-Gestaltung, kein any');
// cc9c22eb: Verlauf auf der Leinwand (hinter editor_plan_leinwand, die Leinwand gibt es nur mit dem Schalter).
ok(lw.includes('onClick={() => strom.setVerlaufAn(!verlauf)}') && lw.includes('verlaufAlsEintraege(strom.verlauf.plaene, aufgeklappt)') && lw.includes('useLeinwandDaten(project, verlauf ? verlaufEintraege : [])'),
  'P22-T263 Verlauf PlanLeinwand.tsx: Verlauf-Knopf im Kopf, aufgeklappte Plaene laden ihre Aenderungen');
ok(lw.includes('verlaufZu={() => zu(p.id)}') && lw.includes('>Zuklappen</button>') && lw.includes('onClick={strom.verlaufMehr}') && lw.includes("data-verlauf={verlauf ? 'an' : 'aus'}"),
  'P22-T263 Verlauf PlanLeinwand.tsx: Zuklappen, aeltere Plaene nachladen, Debug-Attribut');
ok(lw.includes('useLeinwandDaten(project, strom.live && !verlauf ? strom.eintraege : [])'), 'P22-T263 Verlauf PlanLeinwand.tsx: im Verlauf keine Live-Abrufe (Last)');
ok(/\.ed-lw-verlauf-zeile\{/.test(c) && /\.ed-lw-plan\[data-verlauf\]::after\{animation:none\}/.test(c), 'P22-T263 Verlauf ' + cssPfad + ': Verlaufszeilen gestaltet, keine erneute Abschlussanimation');
const ps = lies('packages/web-ui/src/components/editor/PlanStrom.tsx');
ok(ps.includes('setLeinwand(d.aktiv === true && d.leinwand === true)'), 'P22-T263 Leinwand PlanStrom.tsx: Leinwand nur bei aktivem Strom und Schalter (aus plan-strom)');
ok(ps.includes('schattenFaellig(p.dateien.slice(0, schattenMax)') && ps.includes('onClick={strom.mehrSchatten}') && !ps.includes('(mehr als {SCHATTEN_MAX_DATEIEN})'), 'P22-T263 H1 PlanStrom.tsx: weitere Schatten nachladbar statt nur Namen (Entscheidung 8d464d44)');
const t = lies('packages/web-ui/src/components/ProjektEditor.tsx');
ok(t.includes('const leinwandAn=strom.aktiv&&strom.leinwand;') && t.includes('const zu=leinwandAn&&explorerZu;'), 'P22-T263 Leinwand ProjektEditor.tsx: Einklappen nur mit Schalter (AUS = Editor wie bisher)');
ok(t.includes('{leinwandAn&&<button type="button" className="ed-einklappen"') && t.includes('className="ed-explorer-schiene"'), 'P22-T263 Leinwand ProjektEditor.tsx: Explorer einklappen und wieder einblenden');
ok(t.includes('{zu?<PlanLeinwand strom={strom} project={project}/>:<>') && t.includes('{strom.aktiv&&!zu&&<PlanStromDetail strom={strom}/>}'), 'P22-T263 Leinwand ProjektEditor.tsx: eingeklappt Leinwand statt Reiter/Code, ohne unteres Detail');
ok(t.includes('localStorage.getItem(EXPLORER_ZU)') && /try\{return localStorage/.test(t), 'P22-T263 Leinwand ProjektEditor.tsx: eingeklappt nur als Komfort gemerkt, Speicherfehler = offen');
ok(t.includes('vergleich.nicht_anwendbar.map(n=>') && t.includes('nicht_anwendbar?:Array<{op_index:number;file_path:string;fehler:string}>'), 'P22-T263/T264 ProjektEditor.tsx: nicht_anwendbar aus /editor/user-plan/datei wird angezeigt');
ok(t.includes("data-leinwand={leinwandAn?'an':'aus'}") && t.includes("data-explorer={zu?'zu':'offen'}"), 'P22-T263 Leinwand ProjektEditor.tsx: Debug-Attribute');

// ---------------------------------------------------------------- D core, REST
const kat = lies('packages/core/src/services/agent-profil-schalter.ts');
const nur = kat.slice(kat.indexOf('export const NUR_AUSDRUECKLICH')).split('\n')[0];
const ein = kat.slice(kat.indexOf('export const STANDARD_EIN')).split('\n')[0];
ok(kat.includes("  'editor_plan_leinwand',") && nur.includes("'editor_plan_leinwand'") && !ein.includes('editor_plan_leinwand'), 'P22-T263 Leinwand agent-profil-schalter.ts: Schalter im Katalog, Standard AUS, nur ausdruecklich');
const rt = lies('packages/rest-api/src/routes/agent-runtimes.ts');
ok(rt.includes("'/api/main-agent/editor/plan-aenderungen'") && rt.includes('if(!s.leinwand)return reply.code(403)') && rt.includes("leseUiProduktSchalter('editor_plan_leinwand', project)"), 'P22-T263 Leinwand agent-runtimes.ts: Route nur mit editor_modul + editor_plan_strom + editor_plan_leinwand');
ok(rt.includes('leinwand:aktiv && flaeche.aktiv && !flaeche.letzter_fehler') && rt.includes('aktiv:true,leinwand:s.leinwand'), 'P22-T263 Leinwand agent-runtimes.ts: plan-strom meldet den Leinwand-Schalter');
const dienst = lies('packages/core/src/services/editor-plan-strom.ts');
ok(!/CREATE TABLE/i.test(dienst) && dienst.includes('export async function leseEditorPlanAenderungen') && dienst.includes('zurueckgestellt: true'), 'P22-T263 Leinwand editor-plan-strom.ts: keine Tabelle, Summen-Grenze stellt zurueck statt zu kappen');
ok(dienst.includes('maskiereDatei(a.file_path, a.vorher)') && dienst.includes('istMaskierteDatei(n.file_path) ?'), 'P22-T263 Leinwand editor-plan-strom.ts: sensible Dateien maskiert, auch im Grund nicht anwendbarer Ops');
const fb = lies('packages/core/src/services/file-batch.ts');
ok(fb.includes('export async function planSchattenVollstaendig') && fb.includes('schattenDateien(stand, ops).map((s) =>'), 'P22-T263 Leinwand file-batch.ts: dieselbe Schatten-Anwendung wie plan_status (keine zweite Edit-Engine)');

console.log('OK P22-T263 Editor-Leinwand: ' + n + ' Pruefungen');
