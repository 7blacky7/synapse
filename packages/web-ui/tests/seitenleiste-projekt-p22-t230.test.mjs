/**
 * P22-T230 (Testphase P22-T233): Seitenleiste 'Aktives Projekt' - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/seitenleiste-projekt-p22-t230.test.mjs
 * Herkunft: Task P22-T230 (User 31.10.2026 ~14:55, Screenshot 14-32-27), Bestand thought 1c426ba8, Ergebnis bcc63a32,
 *   Datenvertrag P22-T232 (codex-rea4, Channel t128-team 31472/31473/31484).
 * Sichert ab:
 *   A components/workspace/seitenleiste-projekt-logik.ts letzteTasks: je Task-ID juengster Eintrag, juengste zuerst, hoechstens 3,
 *     ohne Zeit hinten, Titel bleibt erhalten.
 *   B liesVertragAntwort (Vertrag T232 ?nur=aktuelle_tasks): Felder task_id/titel/zuletzt/quelle, daten_schalter AUS -> null
 *     (= Uebergangsquelle), fehlendes Feld/Fehler -> null, leeres Array mit daten_schalter EIN = gueltig leer.
 *   C ausAktuellenTasks (Uebergangsquelle P22-T172): Schalter AUS -> leer mit Hinweis, done zaehlt nicht, zuletzt vor seit.
 *   D liesSchalterAntwort (GET /agent-profile/schalter): seitenleiste_projekt_tasks EIN/AUS, fehlender Eintrag/Fehler/letzter_fehler = AUS.
 *   E Anzeige: unterzeile (Kurz-IDs mit ' · ', Leertext), taskTitel, kartenTitel (Quelle = Debug), gleicheTasks.
 *   F Einbau (Quelltext): Karte in SynapseWorkspace, Abruf ?nur=aktuelle_tasks + Rueckfall, ProjectSelector wiederverwendet (keine
 *     zweite Suchlogik), Schalter im Core-Katalog nur ausdruecklich, AUS-Zweig mit Alttext und Klick auf die Uebersicht.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/workspace/seitenleiste-projekt-logik.ts')).href);
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const ids = (t) => t.map((x) => x.task_id);
const H = 'P22-T230 seitenleiste-projekt-logik.ts';

// ---------------------------------------------------------------- A letzteTasks
{
  const e = (task_id, zuletzt, titel = null) => ({ task_id, titel, zuletzt, quelle: 'test' });
  const r = L.letzteTasks([
    e('P1-T1', '2026-10-31T10:00:00Z', 'Eins'),
    e('P1-T2', '2026-10-31T12:00:00Z'),
    e('P1-T3', '2026-10-31T11:00:00Z'),
    e('P1-T4', '2026-10-31T09:00:00Z'),
    e('P1-T1', '2026-10-31T13:00:00Z'),
    e('P1-T5', null),
  ]);
  ok(r.length === 3, H + ' letzteTasks: hoechstens 3 (SEITENLEISTE_ANZAHL)', r);
  ok(L.SEITENLEISTE_ANZAHL === 3, H + ' SEITENLEISTE_ANZAHL = 3', L.SEITENLEISTE_ANZAHL);
  ok(kurz(ids(r)) === kurz(['P1-T1', 'P1-T2', 'P1-T3']), H + ' letzteTasks: juengste zuerst, je Task-ID nur der juengste Eintrag', ids(r));
  ok(r[0].titel === 'Eins' && r[0].zuletzt === '2026-10-31T13:00:00Z', H + ' letzteTasks: Titel des aelteren Eintrags bleibt am juengeren erhalten', r[0]);
  const ohneZeit = L.letzteTasks([e('P2-T9', null), e('P2-T1', '2026-10-31T08:00:00Z'), e('P2-T2', null)], 5);
  ok(kurz(ids(ohneZeit)) === kurz(['P2-T1', 'P2-T2', 'P2-T9']), H + ' letzteTasks: Eintraege ohne Zeit hinten, dort stabil nach ID', ids(ohneZeit));
  ok(L.letzteTasks([], 3).length === 0 && L.letzteTasks([e('P1-T1', null)], 0).length === 0, H + ' letzteTasks: leer bzw. n=0 -> leer');
}

// ---------------------------------------------------------------- B liesVertragAntwort (Vertrag P22-T232)
{
  const roh = {
    success: true, project: 'synapse', stand: '2026-10-31T14:00:00Z', daten_schalter: { aktiv: true, quelle: 'produkt-schalter' },
    aktuelle_tasks: [
      { task_id: 'P22-T226', titel: 'Alt', zuletzt: '2026-10-31T13:00:00Z', quelle: 'aktivitaet:tool_calls' },
      { task_id: 'P22-T228', titel: 'Neu', zuletzt: '2026-10-31T13:30:00Z', quelle: 'aktivitaet:file_versions' },
      { task_id: 'P22-T227', titel: null, zuletzt: '2026-10-31T13:10:00Z' },
      { task_id: 'P22-T225', titel: 'Am aeltesten', zuletzt: '2026-10-31T12:00:00Z', quelle: 'bindung' },
      { titel: 'ohne ID' },
    ],
  };
  const v = L.liesVertragAntwort(true, roh);
  ok(v && v.quelle === 'aktuelle_tasks', H + ' liesVertragAntwort: Vertrag geliefert -> quelle aktuelle_tasks', v);
  ok(kurz(ids(v.tasks)) === kurz(['P22-T228', 'P22-T227', 'P22-T226']), H + ' liesVertragAntwort: juengste zuerst, max 3, Zeile ohne task_id verworfen', ids(v.tasks));
  ok(v.tasks[1].quelle === 'aktuelle_tasks' && v.tasks[0].quelle === 'aktivitaet:file_versions', H + ' liesVertragAntwort: quelle je Zeile (Rueckfall aktuelle_tasks)', v.tasks);
  ok(v.stand === '2026-10-31T14:00:00Z' && v.hinweis === null, H + ' liesVertragAntwort: stand uebernommen, kein Hinweis', v);
  ok(L.liesVertragAntwort(true, { ...roh, daten_schalter: { aktiv: false, quelle: 'standard' }, aktuelle_tasks: [] }) === null,
    H + ' liesVertragAntwort: daten_schalter AUS (netzwerk_datengrundlage) -> null = Uebergangsquelle');
  ok(L.liesVertragAntwort(true, { success: true, project: 'synapse', agenten: [] }) === null, H + ' liesVertragAntwort: Feld aktuelle_tasks fehlt (aelterer Server) -> null');
  ok(L.liesVertragAntwort(false, roh) === null && L.liesVertragAntwort(true, { ...roh, success: false }) === null && L.liesVertragAntwort(true, null) === null,
    H + ' liesVertragAntwort: HTTP-/API-Fehler bzw. kein Objekt -> null');
  const leer = L.liesVertragAntwort(true, { ...roh, aktuelle_tasks: [] });
  ok(leer && leer.quelle === 'aktuelle_tasks' && leer.tasks.length === 0, H + ' liesVertragAntwort: leeres Array bei daten_schalter EIN = gueltig leer (kein Rueckfall)', leer);
}

// ---------------------------------------------------------------- C ausAktuellenTasks (Uebergangsquelle P22-T172)
{
  const a = (task_id, status, seit, zuletzt) => ({ task_id, titel: 'T ' + task_id, status, seit, zuletzt, quelle: 'aktivitaet:tool_calls' });
  const aus = L.ausAktuellenTasks({ aktiv: false, agenten: [], letzter_fehler: null, stand: null });
  ok(aus.quelle === 'agent_aktuelle_task' && aus.tasks.length === 0 && /agent_aktuelle_task AUS/.test(aus.hinweis ?? ''),
    H + ' ausAktuellenTasks: Schalter agent_aktuelle_task AUS -> leer mit Hinweis (Debug)', aus);
  ok(L.ausAktuellenTasks(null).quelle === 'keine' && L.ausAktuellenTasks(null).hinweis === 'nicht_lesbar', H + ' ausAktuellenTasks: null -> keine, nicht_lesbar');
  const ein = L.ausAktuellenTasks({ aktiv: true, letzter_fehler: null, stand: 's', agenten: [
    a('P3-T1', 'in_progress', '2026-10-31T09:00:00Z', '2026-10-31T12:00:00Z'),
    a('P3-T2', 'done', '2026-10-31T09:00:00Z', '2026-10-31T13:00:00Z'),
    a('P3-T3', 'in_progress', '2026-10-31T11:00:00Z', null),
    a('P3-T1', 'in_progress', '2026-10-31T09:00:00Z', '2026-10-31T10:00:00Z'),
  ] });
  ok(kurz(ids(ein.tasks)) === kurz(['P3-T1', 'P3-T3']), H + ' ausAktuellenTasks: done zaehlt nicht, doppelte Task einmal, zuletzt vor seit', ids(ein.tasks));
  ok(ein.tasks[1].zuletzt === '2026-10-31T11:00:00Z', H + ' ausAktuellenTasks: ohne zuletzt gilt seit', ein.tasks[1]);
}

// ---------------------------------------------------------------- D liesSchalterAntwort
{
  const z = (aktiv, extra = {}) => ({ success: true, project: 'synapse', schalter: [{ funktion: 'agentennetzwerk', aktiv: true, quelle: 'produkt-schalter' },
    { funktion: 'seitenleiste_projekt_tasks', aktiv, quelle: aktiv ? 'produkt-schalter' : 'standard', ebene: aktiv ? 'projekt' : null, letzter_fehler: null, ...extra }] });
  ok(L.SEITENLEISTE_FUNKTION === 'seitenleiste_projekt_tasks', H + ' SEITENLEISTE_FUNKTION = Katalogname', L.SEITENLEISTE_FUNKTION);
  const ein = L.liesSchalterAntwort(true, z(true));
  ok(ein.aktiv && ein.quelle === 'produkt-schalter' && ein.ebene === 'projekt', H + ' liesSchalterAntwort: EIN (Projekt)', ein);
  ok(!L.liesSchalterAntwort(true, z(false)).aktiv, H + ' liesSchalterAntwort: Standard AUS');
  const fehler = L.liesSchalterAntwort(true, z(true, { letzter_fehler: 'produkt_schalter_nicht_lesbar' }));
  ok(!fehler.aktiv && fehler.letzter_fehler === 'produkt_schalter_nicht_lesbar', H + ' liesSchalterAntwort: letzter_fehler -> AUS', fehler);
  const fehlt = L.liesSchalterAntwort(true, { success: true, schalter: [{ funktion: 'agentennetzwerk', aktiv: true }] });
  ok(!fehlt.aktiv && fehlt.letzter_fehler === 'funktion_unbekannt', H + ' liesSchalterAntwort: Eintrag fehlt (alter Server) -> AUS', fehlt);
  const http = L.liesSchalterAntwort(false, { success: false, error: { code: 'unauthorized' } });
  ok(!http.aktiv && http.quelle === 'fehler' && http.letzter_fehler === 'unauthorized', H + ' liesSchalterAntwort: HTTP-Fehler -> AUS mit Code', http);
}

// ---------------------------------------------------------------- E Anzeige
{
  const t = { quelle: 'aktuelle_tasks', hinweis: null, stand: null, tasks: [
    { task_id: 'P22-T228', titel: 'Neu', zuletzt: null, quelle: 'x' }, { task_id: 'P22-T227', titel: null, zuletzt: null, quelle: 'x' }] };
  ok(L.unterzeile(t) === 'P22-T228 · P22-T227', H + ' unterzeile: Kurz-IDs mit Trenner', L.unterzeile(t));
  ok(L.unterzeile(L.TASKS_LEER) === L.SEITENLEISTE_LEERTEXT && L.SEITENLEISTE_LEERTEXT === 'keine aktive Task', H + ' unterzeile: Leertext ohne Tasks', L.unterzeile(L.TASKS_LEER));
  ok(L.taskTitel(t.tasks[0]) === 'P22-T228: Neu' && L.taskTitel(t.tasks[1]) === 'P22-T227', H + ' taskTitel: ID mit Titel als Tooltip');
  const k = L.kartenTitel('synapse', t);
  ok(/^synapse\nP22-T228: Neu\nP22-T227\nQuelle: aktuelle_tasks \(P22-T232\)\nKlick: Projekt suchen$/.test(k), H + ' kartenTitel: Projekt, Tasks, Quelle (Debug), Klickhinweis', k);
  ok(/Quelle: agenten-aktuelle-task \(Übergang\) · Schalter agent_aktuelle_task AUS/.test(L.kartenTitel('', { ...L.TASKS_LEER, quelle: 'agent_aktuelle_task', hinweis: 'Schalter agent_aktuelle_task AUS' })),
    H + ' kartenTitel: Uebergangsquelle mit Hinweis');
  ok(L.gleicheTasks(t, { ...t, tasks: t.tasks.map((x) => ({ ...x })) }) && !L.gleicheTasks(t, { ...t, tasks: t.tasks.slice(1) }) && !L.gleicheTasks(t, { ...t, quelle: 'agent_aktuelle_task' }),
    H + ' gleicheTasks: Inhalt statt Referenz, Quelle zaehlt');
  ok(L.SEITENLEISTE_ALTTEXT === 'ein Projekt · ein UI-Objekt', H + ' SEITENLEISTE_ALTTEXT = bisherige Unterzeile (Schalter AUS)');
}

// ---------------------------------------------------------------- F Einbau (Quelltext)
{
  const ws = lies('packages/web-ui/src/components/workspace/SynapseWorkspace.tsx');
  ok(/import \{ SeitenleisteProjekt \} from '\.\/SeitenleisteProjekt';/.test(ws) && /<SeitenleisteProjekt[\s\S]*?onOpenOverview=\{\(\) => setArea\('overview'\)\}/.test(ws),
    'P22-T230 SynapseWorkspace.tsx: Karte ueber SeitenleisteProjekt, AUS-Klick weiter auf die Uebersicht');
  ok(!/ein Projekt · ein UI-Objekt/.test(ws), 'P22-T230 SynapseWorkspace.tsx: Alttext nur noch an einer Stelle (Logik-Konstante)');
  const sp = lies('packages/web-ui/src/components/workspace/SeitenleisteProjekt.tsx');
  ok(/import \{ ProjectSelector \} from '\.\.\/\.\.\/views\/uebersicht\/ProjectSelector';/.test(sp) && /<ProjectSelector [^>]*autoFocus/.test(sp),
    'P22-T230 SeitenleisteProjekt.tsx: bestehende Projektsuche wiederverwendet (keine zweite Suchlogik), Feld fokussiert');
  ok(/if \(!aktiv\) \{[\s\S]*?onClick=\{onOpenOverview\}[\s\S]*?SEITENLEISTE_ALTTEXT/.test(sp), 'P22-T230 SeitenleisteProjekt.tsx: Schalter AUS = bisherige Karte');
  ok(/event\.key !== 'Escape'/.test(sp) && /addEventListener\('pointerdown'/.test(sp), 'P22-T230 SeitenleisteProjekt.tsx: Escape und Klick ausserhalb schliessen');
  ok(/console\.debug\('\[seitenleiste-projekt\]'/.test(sp) && /data-seitenleiste-schalter/.test(sp) && /data-seitenleiste-quelle/.test(sp), 'P22-T230 SeitenleisteProjekt.tsx: Debug (console.debug, data-Attribute)');
  const api = lies('packages/web-ui/src/api/seitenleiste-projekt.ts');
  ok(/'\/agentennetzwerk\?nur=aktuelle_tasks'/.test(api) && /leseAktuelleTasks\(project\)/.test(api) && /'\/agent-profile\/schalter'/.test(api),
    'P22-T230 api/seitenleiste-projekt.ts: leichter Vertragsabruf, Uebergangsquelle, Schalterabruf (eine Stelle)');
  const sel = lies('packages/web-ui/src/views/uebersicht/ProjectSelector.tsx');
  ok(/autoFocus = false,/.test(sel) && /autoFocus=\{autoFocus\}/.test(sel), 'P22-T230 ProjectSelector.tsx: nur optionale Prop autoFocus (Standard false = Uebersicht unveraendert)');
  const core = lies('packages/core/src/services/agent-profil-schalter.ts');
  const katalog = core.slice(core.indexOf('export const PROFIL_PRODUKT_FUNKTIONEN'), core.indexOf('] as const;', core.indexOf('export const PROFIL_PRODUKT_FUNKTIONEN')));
  ok(/'seitenleiste_projekt_tasks'/.test(katalog), 'P22-T230 agent-profil-schalter.ts: seitenleiste_projekt_tasks in PROFIL_PRODUKT_FUNKTIONEN');
  const nurZeile = core.split('\n').find((z) => z.startsWith('export const NUR_AUSDRUECKLICH')) ?? '';
  const standardEin = core.split('\n').find((z) => z.startsWith('export const STANDARD_EIN')) ?? '';
  ok(nurZeile.includes("'seitenleiste_projekt_tasks'") && !standardEin.includes('seitenleiste_projekt_tasks'),
    'P22-T230 agent-profil-schalter.ts: nur ausdruecklich (alle schaltet nicht mit), Standard AUS');
}

console.log('PASS P22-T230 Seitenleiste Aktives Projekt ' + n + ' Pruefungen');
