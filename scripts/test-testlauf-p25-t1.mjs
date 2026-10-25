// test-testlauf-p25-t1.mjs — Selbsttest des Gesamt-Testlaeufers (P25-T1), ohne DB, ohne Browser, ohne Prozesse
// (Block J schreibt nur in einen eigenen Temp-Ordner, nie ins Repo).
// Sichert ab: scripts/lib/testlauf/finden.mjs (leseMarker, taskAusName, referenziertePakete, passtNur, wendeEinstellungAn),
// bewerten.mjs (werteAusgabeAus, bewerte, passtZeile, testfehlerZeilen, vorschlagEintrag, zeileFuerLog),
// betroffene.mjs (abnehmerHuelle, waehleBetroffene). Grundlage: Entwurf thought 49df5e9e, User-Go b3a3a812,
// Herkunft-Regel 86b6877b. Aufruf: node scripts/test-testlauf-p25-t1.mjs (Exit 1 bei Fehler).
import { leseMarker, taskAusName, referenziertePakete, passtNur, wendeEinstellungAn } from './lib/testlauf/finden.mjs';
import { werteAusgabeAus, bewerte, passtZeile, testfehlerZeilen, vorschlagEintrag, zeileFuerLog, waehleNachlauf, bewerteNachlauf, summiere, istRot } from './lib/testlauf/bewerten.mjs';
import { abnehmerHuelle, waehleBetroffene } from './lib/testlauf/betroffene.mjs';
import { erkenneSchemaFehler, objektName, sucheSchemaObjekt } from './lib/testlauf/schema.mjs';
// P25-T7: scripts/lib/ui-screenshots.mjs (laufIdFuerScreenshots, screenshotOrdner, screenshotAblage, raeumeScreenshotLaeufeAuf)
import { laufIdFuerScreenshots, screenshotOrdner, screenshotAblage, raeumeScreenshotLaeufeAuf } from './lib/ui-screenshots.mjs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fehler = 0;
let pruefungen = 0;
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Jede Pruefung traegt ihre Herkunft (Task + Einheit + Quelldatei) im Label; bei Fehlschlag Debugzeile mit erwartet/tatsaechlich.
function pruefe(label, ist, soll) {
  pruefungen++;
  if (gleich(ist, soll)) { console.log(`OK ${label}`); return; }
  fehler++;
  console.log(`FAIL ${label}`);
  console.log(`DEBUG P25-T1 ${label}: erwartet ${JSON.stringify(soll).slice(0, 300)} | tatsaechlich ${JSON.stringify(ist).slice(0, 300)}`);
}

// A Kopf-Marker (User-Go Punkt 6: // @testlauf ... in Testdateien erlaubt)
{
  const m = leseMarker('// Kopf\n// @testlauf browser zeitlimit=600 braucht=docker env=X_Y=1\n/* @testlauf golden args=--foo bar */\n// @testlauf aus=wartet auf P22-T99\nconst x = 1;');
  pruefe('P25-T1 finden.mjs leseMarker: art browser', m.art, 'browser');
  pruefe('P25-T1 finden.mjs leseMarker: zeitlimit 600', m.zeitlimit, 600);
  pruefe('P25-T1 finden.mjs leseMarker: braucht docker', m.braucht, ['docker']);
  pruefe('P25-T1 finden.mjs leseMarker: env', m.env, { X_Y: '1' });
  pruefe('P25-T1 finden.mjs leseMarker: golden + args Rest der Zeile', [m.golden, m.args], [true, ['--foo', 'bar']]);
  pruefe('P25-T1 finden.mjs leseMarker: aus mit Leerzeichen', m.aus, 'wartet auf P22-T99');
  const spaet = leseMarker(Array.from({ length: 40 }, (_, i) => (i === 35 ? '// @testlauf seriell' : '//')).join('\n'));
  pruefe('P25-T1 finden.mjs leseMarker: Marker nach Zeile 30 zaehlt nicht', spaet.art, null);
  pruefe('P25-T1 finden.mjs leseMarker: unbekanntes Token gemeldet', leseMarker('// @testlauf brwoser').unbekannt, ['brwoser']);
}

// B Task-ID und Paketbezuege (Herkunft aus Dateiname, --nur-betroffene)
{
  pruefe('P25-T1 finden.mjs taskAusName: p22-t168', taskAusName('chat-zitate-browser-p22-t168.test.mjs'), 'P22-T168');
  pruefe('P25-T1 finden.mjs taskAusName: p13-a10', taskAusName('project-restore-p13-a10.test.mjs'), 'P13-A10');
  pruefe('P25-T1 finden.mjs taskAusName: ohne ID', taskAusName('intern-schalter.test.mjs'), null);
  const refs = referenziertePakete("join(repo,'packages/web-ui/package.json'); import('../../core/dist/x.js'); join(repo,'packages','mcp-server'); '@synapse/agents'", 'rest-api');
  pruefe('P25-T1 finden.mjs referenziertePakete: Pfad, relativ, Liste, @synapse', refs, ['agents', 'core', 'mcp-server', 'web-ui']);
}

// C --nur und zentrale Einstellungen
{
  const t = { datei: 'packages/core/tests/fall-skills-p23-t5.test.mjs', name: 'core/fall-skills-p23-t5' };
  pruefe('P25-T1 finden.mjs passtNur: Dateiname', passtNur(t, ['fall-skills-p23-t5.test.mjs']), true);
  pruefe('P25-T1 finden.mjs passtNur: Name ohne Endung', passtNur(t, ['fall-skills-p23-t5']), true);
  pruefe('P25-T1 finden.mjs passtNur: Glob', passtNur(t, ['core/fall-*']), true);
  pruefe('P25-T1 finden.mjs passtNur: kein Treffer', passtNur(t, ['rest-api/*']), false);
  const e = wendeEinstellungAn({ art: 'pool', zeitlimit_s: 300, env: {}, braucht_docker: false, golden: false, args: [], aus: null }, { art: 'browser', aus: 'inventur' });
  pruefe('P25-T1 finden.mjs wendeEinstellungAn: art browser -> Zeitlimit 900, aus', [e.art, e.zeitlimit_s, e.aus], ['browser', 900, 'inventur']);
}

// D Ausgabe auswerten (Entwurf Abschnitt 2: node:test-Summe, ^FAIL, 'N Fehler')
{
  const spec = '✖ Kompakte Runtime: Login (27.8ms)\n✖ Produktiver Chat (106.1ms)\nℹ tests 5\nℹ pass 2\nℹ fail 2\n✖ failing tests:\n\n✖ Kompakte Runtime: Login (27.8ms)\n  AssertionError [ERR_ASSERTION]: x';
  const a = werteAusgabeAus(spec);
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: node:test fail 2', a.fail, 2);
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: Spec-Zeilen ohne Dauer, dedupliziert', a.fail_zeilen, ['✖ Kompakte Runtime: Login', '✖ Produktiver Chat']);
  const g = werteAusgabeAus('OK a\nFAIL F Golden x\nFAIL F Golden y   \nFAIL F Golden x\n  F Golden y');
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: Golden ^FAIL eindeutig gezaehlt', [g.fail, g.fail_zeilen], [2, ['FAIL F Golden x', 'FAIL F Golden y']]);
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: "469 Pruefungen, 2 Fehler"', werteAusgabeAus('P23-T5: 469 Pruefungen, 2 Fehler').fail, 2);
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: Absturz ohne Zahl', werteAusgabeAus("ReferenceError: Cannot access 'X' before initialization").fail, null);
  const h = werteAusgabeAus('OK P22-T170 lesefenster.ts: erwartet 2\nFAIL P22-T170 zitat.ts waehleEmpfaenger: erwartet 2, tatsaechlich 1');
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: Herkunftszeile nur aus roter Zeile', [h.herkunft_id, h.herkunft_zeile], ['P22-T170', 'FAIL P22-T170 zitat.ts waehleEmpfaenger: erwartet 2, tatsaechlich 1']);
  pruefe('P25-T1 bewerten.mjs werteAusgabeAus: Selbst-Skip test-db-schutz', werteAusgabeAus('x: uebersprungen — TEST_DATABASE_URL nicht gesetzt. Braucht eine Wegwerf-DB (siehe TEST_DATABASE_URL).').selbst_uebersprungen, true);
}

// E Bekannt-rot-Bewertung (Entwurf Abschnitt 5)
{
  const eintrag = { erwartet: { fail: 2, fail_zeilen: ['FAIL rest: alle Parameter*', 'FAIL stdio: x'] } };
  const lauf = (fail, zeilen, extra = {}) => ({ exit: 1, zeitlimit: false, ausgabe: '', fail, fail_zeilen: zeilen, ...extra });
  pruefe('P25-T1 bewerten.mjs passtZeile: Praefix mit *', passtZeile('FAIL rest: alle Parameter [..lang..]', 'FAIL rest: alle Parameter*'), true);
  pruefe('P25-T1 bewerten.mjs bewerte: gleiche Fehler -> BEKANNT_ROT', bewerte(lauf(2, ['FAIL rest: alle Parameter [a]', 'FAIL stdio: x']), eintrag).status, 'BEKANNT_ROT');
  pruefe('P25-T1 bewerten.mjs bewerte: weniger Fehler -> BEKANNT_ROT + Hinweis', (({ status, hinweise }) => [status, hinweise.map((x) => x.code)])(bewerte(lauf(1, ['FAIL stdio: x']), eintrag)), ['BEKANNT_ROT', ['BEKANNT_ROT_BESSER']]);
  pruefe('P25-T1 bewerten.mjs bewerte: mehr Fehler -> NEU_ROT mehr_fehler', bewerte(lauf(3, []), eintrag).grund, 'mehr_fehler');
  const neu = bewerte(lauf(2, ['FAIL stdio: x', 'FAIL neu']), eintrag);
  pruefe('P25-T1 bewerten.mjs bewerte: neue FAIL-Zeile -> NEU_ROT', [neu.status, neu.grund, neu.neue_zeilen], ['NEU_ROT', 'neue_fail_zeile', ['FAIL neu']]);
  pruefe('P25-T1 bewerten.mjs bewerte: ohne Eintrag -> NEU_ROT unbekannt', bewerte(lauf(1, []), null).grund, 'unbekannt');
  pruefe('P25-T1 bewerten.mjs bewerte: Zeitlimit -> NEU_ROT zeitlimit', bewerte(lauf(null, [], { zeitlimit: true }), eintrag).grund, 'zeitlimit');
  const muster = { erwartet: { fail: null, muster: 'INTERN_SCHALTER.*before initialization' } };
  pruefe('P25-T1 bewerten.mjs bewerte: muster trifft -> BEKANNT_ROT', bewerte(lauf(null, [], { ausgabe: "ReferenceError: Cannot access 'INTERN_SCHALTER' before initialization" }), muster).status, 'BEKANNT_ROT');
  pruefe('P25-T1 bewerten.mjs bewerte: muster fehlt -> NEU_ROT', bewerte(lauf(null, [], { ausgabe: 'TypeError: anders' }), muster).grund, 'muster_fehlt');
  const gruen = bewerte({ exit: 0, zeitlimit: false, ausgabe: '' }, eintrag);
  pruefe('P25-T1 bewerten.mjs bewerte: gruen trotz Eintrag -> Hinweis VERALTET', [gruen.status, gruen.hinweise[0]?.code], ['GRUEN', 'BEKANNT_ROT_VERALTET']);
}

// F TESTFEHLER-Zeilen, Vorschlag, Maskierung (Herkunft-Regel 86b6877b Punkt 5)
{
  const aus = werteAusgabeAus('FAIL P22-T170 zitat.ts: erwartet 2, tatsaechlich 1\nError: boom\n    at x');
  const z = testfehlerZeilen(aus, { neue_zeilen: ['FAIL P22-T170 zitat.ts: erwartet 2, tatsaechlich 1'] });
  pruefe('P25-T1 bewerten.mjs testfehlerZeilen: HERKUNFT zuerst, ohne Doppel', z, ['HERKUNFT FAIL P22-T170 zitat.ts: erwartet 2, tatsaechlich 1', 'Error: boom']);
  pruefe('P25-T1 bewerten.mjs zeileFuerLog: Zugangsdaten maskiert', zeileFuerLog('postgresql://user:geheim@host:5433/db token=abc'), 'postgresql://***@host:5433/db token=***');
  const v = vorschlagEintrag({ test: { datei: 'packages/core/tests/x.test.mjs', task: null, golden: false }, lauf: { zeitlimit: false },
    aus: werteAusgabeAus("ReferenceError: Cannot access 'X' before initialization\n    at file:///a.mjs:1"), laufId: 'tl-1', datum: '2026-10-25' });
  pruefe('P25-T1 bewerten.mjs vorschlagEintrag: Absturz -> muster statt fail', [v.erwartet.fail, v.erwartet.fail_zeilen, v.erwartet.muster], [null, null, "ReferenceError: Cannot access 'X' before initialization"]);
}

// G --nur-betroffene (Entwurf Abschnitt 7)
{
  const abh = new Map([['core', new Set()], ['rest-api', new Set(['core'])], ['mcp-server', new Set(['core'])], ['web-ui', new Set()], ['file-watcher-daemon-ts', new Set(['mcp-server'])]]);
  pruefe('P25-T1 betroffene.mjs abnehmerHuelle: core -> transitiv', [...abnehmerHuelle(['core'], abh)].sort(), ['core', 'file-watcher-daemon-ts', 'mcp-server', 'rest-api']);
  const tests = [
    { datei: 'packages/core/tests/a.test.mjs', paket: 'core', referenziert: [] },
    { datei: 'packages/rest-api/tests/b-browser.test.mjs', paket: 'rest-api', referenziert: ['web-ui'] },
    { datei: 'packages/web-ui/tests/c.test.mjs', paket: 'web-ui', referenziert: [] },
  ];
  const w = waehleBetroffene(tests, ['packages/web-ui/src/x.tsx', 'docs/a.md', 'packages/core/tests/a.test.mjs'], abh);
  pruefe('P25-T1 betroffene.mjs waehleBetroffene: web-ui + Bezug + geaenderte Testdatei', [...w.ausgewaehlt].sort(), ['packages/core/tests/a.test.mjs', 'packages/rest-api/tests/b-browser.test.mjs', 'packages/web-ui/tests/c.test.mjs']);
  pruefe('P25-T1 betroffene.mjs waehleBetroffene: nur .md -> nichts', waehleBetroffene(tests, ['packages/core/README.md'], abh).ausgewaehlt.size, 0);
  pruefe('P25-T1 betroffene.mjs waehleBetroffene: tests/bekannt-rot.json -> voll', waehleBetroffene(tests, ['tests/bekannt-rot.json'], abh).voll, true);
}

// H SCHEMA_FEHLT_LIVE (User-Entscheidung 3f202323): fehlendes Live-Schema erkennen und Fundstelle im Code nennen
{
  const gefunden = erkenneSchemaFehler([
    'error: relation "p22_t168_1_ab.chat_zitate_einstellungen" does not exist',
    'error: column "quittung_seit" of relation "agent_zustellungen" does not exist',
    'Fehler: Spalte »git_branch« existiert nicht',
    'error: column "quittung_seit" does not exist',
  ].join('\n'));
  pruefe('P25-T1 schema.mjs erkenneSchemaFehler: englisch/deutsch, Schema-Praefix weg, ohne Doppel', gefunden.map((o) => `${o.art}:${objektName(o)}`),
    ['spalte:agent_zustellungen.quittung_seit', 'tabelle:chat_zitate_einstellungen', 'spalte:git_branch']);
  pruefe('P25-T1 schema.mjs erkenneSchemaFehler: andere Fehler -> nichts', erkenneSchemaFehler('TypeError: x is not a function'), []);
  const quellen = [{ datei: 'packages/core/src/db/schema.ts', zeilen: [
    '// P22-T168 Schema 157: Zitat-Einstellungen',
    'CREATE TABLE IF NOT EXISTS chat_zitate_einstellungen (',
    '  id TEXT PRIMARY KEY,',
    '  aktiv BOOLEAN NOT NULL',
    ');',
    '-- P22-T144 Quittung',
    'ALTER TABLE agent_zustellungen',
    '  ADD COLUMN IF NOT EXISTS quittung_seit TIMESTAMPTZ;',
  ] }];
  pruefe('P25-T1 schema.mjs sucheSchemaObjekt: Tabelle mit Task', sucheSchemaObjekt(quellen, { art: 'tabelle', name: 'chat_zitate_einstellungen' }),
    { datei: 'packages/core/src/db/schema.ts', zeile: 2, task: 'P22-T168' });
  pruefe('P25-T1 schema.mjs sucheSchemaObjekt: ADD COLUMN mit Tabelle', sucheSchemaObjekt(quellen, { art: 'spalte', name: 'quittung_seit', tabelle: 'agent_zustellungen' }),
    { datei: 'packages/core/src/db/schema.ts', zeile: 8, task: 'P22-T144' });
  pruefe('P25-T1 schema.mjs sucheSchemaObjekt: Spalte im CREATE-Block', sucheSchemaObjekt(quellen, { art: 'spalte', name: 'aktiv', tabelle: 'chat_zitate_einstellungen' })?.zeile, 4);
  pruefe('P25-T1 schema.mjs sucheSchemaObjekt: unbekannt -> null', sucheSchemaObjekt(quellen, { art: 'tabelle', name: 'gibt_es_nicht' }), null);
}

// I Nachlauf (Koordinator 25.10.2026 zu 3f202323): SCHEMA_FEHLT_LIVE-Tests nach dem Nachzug genau EINMAL, Ergebnis zaehlt normal
{
  const eintraege = [['a.test.mjs', { status: 'SCHEMA_FEHLT_LIVE' }], ['b.test.mjs', { status: 'GRUEN' }], ['c.test.mjs', { status: 'SCHEMA_FEHLT_LIVE' }]];
  pruefe('P25-T1 bewerten.mjs waehleNachlauf: nur SCHEMA_FEHLT_LIVE nach Nachzug ok', waehleNachlauf(eintraege, 'ok'), ['a.test.mjs', 'c.test.mjs']);
  pruefe('P25-T1 bewerten.mjs waehleNachlauf: Nachzug fehler/aus -> kein Nachlauf', [waehleNachlauf(eintraege, 'fehler'), waehleNachlauf(eintraege, 'aus')], [[], []]);
  const rot = { exit: 1, zeitlimit: false, ausgabe: '', fail: 1, fail_zeilen: [] };
  pruefe('P25-T1 bewerten.mjs bewerteNachlauf: wieder Schemafehler -> NEU_ROT schema_nach_nachzug_fehlt', (({ status, grund }) => [status, grund])(bewerteNachlauf(rot, null, 1)), ['NEU_ROT', 'schema_nach_nachzug_fehlt']);
  pruefe('P25-T1 bewerten.mjs bewerteNachlauf: anderer Fehler -> NEU_ROT unbekannt', bewerteNachlauf(rot, null, 0).grund, 'unbekannt');
  pruefe('P25-T1 bewerten.mjs bewerteNachlauf: gruen -> GRUEN', bewerteNachlauf({ exit: 0, zeitlimit: false, ausgabe: '' }, null, 0).status, 'GRUEN');
  const s = summiere([{ status: 'GRUEN', nachlauf: 1 }, { status: 'NEU_ROT', nachlauf: 1 }, { status: 'GRUEN' }, { status: 'BEKANNT_ROT' }]);
  pruefe('P25-T1 bewerten.mjs summiere: schema_fehlt_live zaehlt Nachlauf-Tests, nachlauf_gruen, normal gezaehlt',
    [s.schema_fehlt_live, s.nachlauf_gruen, s.gruen, s.neu_rot, s.bekannt_rot, s.schema_ungeprueft], [2, 1, 2, 1, 1, 0]);
  pruefe('P25-T1 bewerten.mjs istRot: Nachlauf NEU_ROT -> ROT', istRot(s, 'ok'), true);
  const ohne = summiere([{ status: 'SCHEMA_FEHLT_LIVE' }, { status: 'GRUEN' }]);
  pruefe('P25-T1 bewerten.mjs summiere/istRot: SCHEMA_FEHLT_LIVE ohne Nachlauf -> ungeprueft, nicht ROT', [ohne.schema_fehlt_live, ohne.schema_ungeprueft, istRot(ohne, 'aus')], [1, 1, false]);
  pruefe('P25-T1 bewerten.mjs istRot: Nachzug fehler -> ROT', istRot(ohne, 'fehler'), true);
}

// J Screenshots je Lauf (P25-T7, User-Go 25.10.2026): ui-screenshots/<anlass>/<lauf-id>/, nie ueberschreiben (Sync-Konflikte),
// je Anlass nur die letzten N Laeufe behalten; Altbestand ohne Lauf-ID-Namen bleibt. Alles in einem Temp-Ordner als Projektwurzel.
{
  const tmp = mkdtempSync(join(tmpdir(), 'p25-t7-screenshots-'));
  try {
    const jetzt = new Date(2026, 9, 25, 23, 40, 5);
    pruefe('P25-T7 ui-screenshots.mjs laufIdFuerScreenshots: TESTLAUF_ID vom Laeufer uebernommen',
      laufIdFuerScreenshots({ TESTLAUF_ID: 'tl-20261025-234005-ab12' }, jetzt, 'ffff'), { lauf: 'tl-20261025-234005-ab12', quelle: 'testlauf' });
    pruefe('P25-T7 ui-screenshots.mjs laufIdFuerScreenshots: Einzelaufruf -> Zeitstempel ez-',
      laufIdFuerScreenshots({}, jetzt, '0a1b'), { lauf: 'ez-20261025-234005-0a1b', quelle: 'einzel' });
    pruefe('P25-T7 ui-screenshots.mjs laufIdFuerScreenshots: TESTLAUF_ID mit Pfadteilen verworfen',
      laufIdFuerScreenshots({ TESTLAUF_ID: '../../etc' }, jetzt, '0a1b'), { lauf: 'ez-20261025-234005-0a1b', quelle: 'einzel', verworfen: '../../etc' });
    const o = screenshotOrdner(tmp, 'p22-t171', { env: { TESTLAUF_ID: 'tl-20261025-234005-ab12', TESTLAUF_NACHLAUF: '1' } });
    pruefe('P25-T7 ui-screenshots.mjs screenshotOrdner: Nachlauf -> Unterordner nachlauf/',
      [o.rel, o.ordner === join(tmp, 'ui-screenshots', 'p22-t171', 'tl-20261025-234005-ab12', 'nachlauf'), existsSync(o.ordner)],
      ['ui-screenshots/p22-t171/tl-20261025-234005-ab12/nachlauf', true, false]);
    let wurf = null;
    try { screenshotOrdner(tmp, '../x'); } catch (e) { wurf = e.message; }
    pruefe('P25-T7 ui-screenshots.mjs screenshotOrdner: Anlass mit Pfadteilen -> Fehler', /ungueltiger Anlass/.test(wurf ?? ''), true);

    const zeilen = [];
    const a = await screenshotAblage(tmp, 'p22-t999', { env: { TESTLAUF_ID: 'tl-20261025-234005-ab12' }, log: (z) => zeilen.push(z) });
    const p1 = await a.speichere('01-dunkel.png', Buffer.from('eins'));
    const p2 = await a.speichere('01-dunkel.png', Buffer.from('zwei'));
    pruefe('P25-T7 ui-screenshots.mjs speichere: gleicher Name -> Suffix -2, Pfade Projekt-relativ', [p1, p2],
      ['ui-screenshots/p22-t999/tl-20261025-234005-ab12/01-dunkel.png', 'ui-screenshots/p22-t999/tl-20261025-234005-ab12/01-dunkel-2.png']);
    pruefe('P25-T7 ui-screenshots.mjs speichere: erste Datei NICHT ueberschrieben', [readFileSync(join(tmp, p1), 'utf8'), readFileSync(join(tmp, p2), 'utf8')], ['eins', 'zwei']);
    pruefe('P25-T7 ui-screenshots.mjs screenshotAblage: Debugzeile SCREENSHOTS', zeilen,
      ['SCREENSHOTS ordner=ui-screenshots/p22-t999/tl-20261025-234005-ab12 lauf=tl-20261025-234005-ab12 quelle=testlauf']);

    // Aufraeumen: 6 Laeufe (tl/ez gemischt, je mit nachlauf/), dazu Altbestand; behalten 3, ein alter geschuetzter Lauf bleibt
    const anlass = join(tmp, 'ui-screenshots', 'p22-t168');
    for (const l of ['tl-20261020-100000-aaaa', 'ez-20261021-100000-bbbb', 'tl-20261022-100000-cccc', 'ez-20261023-100000-dddd', 'tl-20261024-100000-eeee', 'tl-20261019-100000-ffff']) {
      mkdirSync(join(anlass, l, 'nachlauf'), { recursive: true });
      writeFileSync(join(anlass, l, '01.png'), 'x');
      writeFileSync(join(anlass, l, 'nachlauf', '01.png'), 'x');
    }
    writeFileSync(join(anlass, '01-alt.png'), 'alt');
    mkdirSync(join(anlass, 'ki-browser-2026-10-01'));
    const opt = { behalten: 3, schuetzen: ['tl-20261019-100000-ffff'] };
    const soll = [{ rel: 'ui-screenshots/p22-t168/ez-20261021-100000-bbbb', dateien: 2 }, { rel: 'ui-screenshots/p22-t168/tl-20261020-100000-aaaa', dateien: 2 }];
    const vorschau = raeumeScreenshotLaeufeAuf(tmp, { ...opt, trocken: true });
    pruefe('P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf trocken: meldet, loescht nichts', [vorschau.geloescht, readdirSync(anlass).length], [soll, 8]);
    const r = raeumeScreenshotLaeufeAuf(tmp, opt);
    pruefe('P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf: aeltere Laeufe nach Zeitstempel (nicht Praefix) geloescht, Dateien gezaehlt',
      [r.geloescht, r.anlaesse, r.fehler], [soll, 2, []]);
    pruefe('P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf: neueste 3 + geschuetzter Lauf + Altbestand bleiben', readdirSync(anlass).sort(),
      ['01-alt.png', 'ez-20261023-100000-dddd', 'ki-browser-2026-10-01', 'tl-20261019-100000-ffff', 'tl-20261022-100000-cccc', 'tl-20261024-100000-eeee']);
    pruefe('P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf: Anlass mit 1 Lauf unberuehrt', [existsSync(join(tmp, p1)), existsSync(join(tmp, p2))], [true, true]);
    let wurf0 = null;
    try { raeumeScreenshotLaeufeAuf(tmp, { behalten: 0 }); } catch (e) { wurf0 = e.message; }
    pruefe('P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf: behalten 0 -> Fehler statt alles loeschen', /behalten muss/.test(wurf0 ?? ''), true);
    pruefe('P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf: ohne ui-screenshots -> nichts', raeumeScreenshotLaeufeAuf(join(tmp, 'gibt-es-nicht')).geloescht, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`P25-T1 testlauf-Selbsttest: ${pruefungen} Pruefungen, ${fehler} Fehler`);
process.exitCode = fehler ? 1 : 0;
