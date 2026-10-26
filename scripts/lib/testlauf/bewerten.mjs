// bewerten.mjs — P25-T1 Gesamt-Testlaeufer: Testausgabe auswerten und gegen tests/bekannt-rot.json bewerten.
// Entwurf thought 49df5e9e Abschnitte 2 (Fehlzahl), 5 (Bekannt-rot), 6 (Zeilenform).
// Herkunft nach regel-tests-mit-herkunft-kommentieren (thought 86b6877b): die erste rote Debugzeile mit
// Task-ID (z. B. 'FAIL P22-T170 lesefenster.ts ...: erwartet 2, tatsaechlich 1') wird bei NEU_ROT uebernommen.
// Reine Funktionen, keine Datei- oder Prozesszugriffe.
// P25-T8 (Inventur 2f2f6776 Punkte 2e/3): 'FEHLER  <Pruefung>'-Zeilen (OK/FEHLER-Spalten) zaehlen wie '^FAIL'; ein bekannt_rot-Eintrag
// ohne fail/fail_zeilen/muster ist kein Freibrief (NEU_ROT eintrag_ohne_erwartung); der Vorschlag-Generator schlaegt keine leeren
// oder Allerwelts-Muster vor und keine Eintraege fuer Zeitlimit, Import-/Ladefehler, Laeufer-Umgebung oder veraltete Privatschemata.

export const STATUS = ['GRUEN', 'BEKANNT_ROT', 'SCHEMA_FEHLT_LIVE', 'NEU_ROT', 'FEHLT', 'UEBERSPRUNGEN', 'NICHT_GESTARTET'];

const SPEC_DAUER = /\s*\(\d+(?:\.\d+)?m?s\)\s*$/;
const HERKUNFT_ID = /\bP\d+-[A-Z]{1,2}\d+\b/;
const HERKUNFT_SIGNAL = /(?:\b(?:DEBUG|HERKUNFT|FAIL|FEHLER|Error|erwartet|tatsaechlich|tatsächlich|expected|actual)\b|✖|\bnot ok\b)/i;
const GRUENE_ZEILE = /^(?:OK|ok|PASS|✔)\b/;
const FEHLER_ZEILE = /^(?:FAIL\b|✖ (?!failing tests)|not ok\b|ABBRUCH\b|FEHLER\b|DEBUG\b|HERKUNFT\b|TESTLAUF-STARTFEHLER\b|(?:Uncaught )?[A-Z][A-Za-z]*Error\b|Error\b)/;
const SELBST_UEBERSPRUNGEN = /: uebersprungen — .*Braucht eine Wegwerf-DB/; // Format aus scripts/lib/test-db-schutz.mjs testDbOderSkip
// P25-T8: 'FEHLER  M JEV_FUNKTIONEN = 6 ...' (Spaltenformat 'OK      x' / 'FEHLER  x', z. B. jev-schalter, erklaerungen-topf) = Fehlschlag
const FEHLER_LABEL = /^FEHLER {2,}\S/;

/** Kuerzt eine Zeile fuers Log: eine Zeile, Steuerzeichen raus, Zugangsdaten maskiert. */
export function zeileFuerLog(text, max = 200) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(\/\/)[^/\s:@]+:[^@\s]+@/g, '$1***@')
    .replace(/\b(token|passwor[dt]|secret|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Wertet die Ausgabe eines Tests aus.
 * fail: node:test-Summe ('ℹ fail N' / '# fail N'), sonst Anzahl verschiedener ^FAIL- bzw. 'FEHLER  '-Zeilen (Golden), sonst
 * 'N Fehler' / 'N FEHLER' / 'N FAIL' / 'fail=N', sonst null.
 * fail_zeilen: sortierte Menge der ^FAIL-/'FEHLER  '-Zeilen und der node:test-Fehlschlaege ('✖ <name>' ohne Dauer).
 */
export function werteAusgabeAus(text) {
  let nodeTestFail = null;
  let zahlText = null;
  const failPraefix = new Set();
  const failZeilen = new Set();
  const fehlerZeilen = [];
  let herkunftZeile = null;
  for (const roh of String(text ?? '').split(/\r?\n/)) {
    const z = roh.replace(/\s+$/, '');
    const t = z.trimStart();
    if (!t) continue;
    let m;
    if ((m = /^(?:ℹ|#) fail (\d+)$/.exec(t))) nodeTestFail = Number(m[1]);
    if (/^FAIL\b/.test(z) || FEHLER_LABEL.test(z)) { failPraefix.add(z); failZeilen.add(z); }
    else if (t.startsWith('✖ ') && !/^✖ failing tests:?$/.test(t)) failZeilen.add(t.replace(SPEC_DAUER, ''));
    else if ((m = /^not ok \d+ - (.*)$/.exec(t))) failZeilen.add('✖ ' + m[1].replace(/\s+#.*$/, ''));
    if ((m = /\b(\d+)\s+(?:FAIL|FEHLER|Fehler|failed|fehlgeschlagen)\b/.exec(z))) zahlText = Number(m[1]);
    else if ((m = /\bfail(?:ed|s)?\s*[=:]\s*(\d+)\b/i.exec(z))) zahlText = Number(m[1]);
    if (GRUENE_ZEILE.test(t)) continue;
    if (FEHLER_ZEILE.test(t) && !/^✖ failing tests/.test(t) && fehlerZeilen.length < 20) fehlerZeilen.push(t.startsWith('✖ ') ? t.replace(SPEC_DAUER, '') : t);
    if (!herkunftZeile && HERKUNFT_ID.test(t) && HERKUNFT_SIGNAL.test(t)) herkunftZeile = t;
  }
  const fail = nodeTestFail ?? (failPraefix.size > 0 ? failPraefix.size : zahlText);
  const ausgabe = String(text ?? '');
  return {
    fail,
    fail_zeilen: [...failZeilen].sort(),
    fehler_zeilen: fehlerZeilen,
    herkunft_zeile: herkunftZeile,
    herkunft_id: herkunftZeile ? HERKUNFT_ID.exec(herkunftZeile)[0] : null,
    selbst_uebersprungen: SELBST_UEBERSPRUNGEN.test(ausgabe),
    eaddrinuse: /\bEADDRINUSE\b/.test(ausgabe),
  };
}

/** Eintrag in fail_zeilen: exakt, oder mit '*' am Ende als Praefix (fuer lange Zeilen mit Detail-Listen). */
export function passtZeile(ist, muster) {
  return muster.endsWith('*') ? ist.startsWith(muster.slice(0, -1)) : ist === muster;
}

/**
 * Bewertet einen Lauf. lauf: { exit, zeitlimit, ausgabe, fail, fail_zeilen, selbst_uebersprungen }.
 * eintrag: Eintrag aus bekannt_rot[] oder null. Ergebnis: { status, grund, neue_zeilen, hinweise[] }.
 * Regeln (Entwurf Abschnitt 5): gleiche oder kleinere Fehlzahl UND keine neue FAIL-Zeile UND (falls muster)
 * muster trifft -> BEKANNT_ROT; sonst NEU_ROT. Gruen trotz Eintrag -> HINWEIS BEKANNT_ROT_VERALTET.
 */
export function bewerte(lauf, eintrag) {
  const hinweise = [];
  if (lauf.exit === 0 && !lauf.zeitlimit) {
    if (eintrag) hinweise.push({ code: 'BEKANNT_ROT_VERALTET', text: 'Test gruen, Eintrag in tests/bekannt-rot.json per files entfernen' });
    if (lauf.selbst_uebersprungen) return { status: 'UEBERSPRUNGEN', grund: 'selbst', neue_zeilen: [], hinweise };
    return { status: 'GRUEN', grund: null, neue_zeilen: [], hinweise };
  }
  if (!eintrag) return { status: 'NEU_ROT', grund: lauf.zeitlimit ? 'zeitlimit' : 'unbekannt', neue_zeilen: lauf.fail_zeilen ?? [], hinweise };
  const e = eintrag.erwartet ?? {};
  if (lauf.zeitlimit && !e.zeitlimit) return { status: 'NEU_ROT', grund: 'zeitlimit', neue_zeilen: [], hinweise };
  // P25-T8: ohne fail, fail_zeilen und muster wuerde der Eintrag JEDEN Fehler erlauben (Inventur: 11 solche Vorschlaege);
  // nur 'zeitlimit: true' allein deckt genau ein Zeitlimit.
  if (ohneErwartung(e) && !(e.zeitlimit && lauf.zeitlimit)) {
    hinweise.push({ code: 'BEKANNT_ROT_OHNE_ERWARTUNG', text: 'Eintrag ohne fail/fail_zeilen/muster erlaubt jeden Fehler, per files nachziehen' });
    return { status: 'NEU_ROT', grund: 'eintrag_ohne_erwartung', neue_zeilen: lauf.fail_zeilen ?? [], hinweise };
  }
  if (e.muster) {
    let trifft = false;
    try { trifft = new RegExp(e.muster).test(lauf.ausgabe ?? ''); } catch { hinweise.push({ code: 'MUSTER_UNGUELTIG', text: zeileFuerLog(e.muster, 80) }); }
    if (!trifft) return { status: 'NEU_ROT', grund: 'muster_fehlt', neue_zeilen: [], hinweise };
  }
  if (e.fail != null && (lauf.fail == null || lauf.fail > e.fail)) {
    return { status: 'NEU_ROT', grund: 'mehr_fehler', neue_zeilen: neueZeilen(lauf.fail_zeilen, e.fail_zeilen), hinweise };
  }
  if (Array.isArray(e.fail_zeilen)) {
    const neu = neueZeilen(lauf.fail_zeilen, e.fail_zeilen);
    if (neu.length) return { status: 'NEU_ROT', grund: 'neue_fail_zeile', neue_zeilen: neu, hinweise };
  }
  if (e.fail != null && lauf.fail != null && lauf.fail < e.fail) {
    hinweise.push({ code: 'BEKANNT_ROT_BESSER', text: `fail=${lauf.fail} statt ${e.fail}, Eintrag per files nachziehen` });
  }
  return { status: 'BEKANNT_ROT', grund: null, neue_zeilen: [], hinweise };
}

/**
 * Nachlauf (Koordinator 25.10.2026 zu 3f202323): SCHEMA_FEHLT_LIVE-Tests liefen vor dem Nachzug nie wirklich. Nach einem
 * erfolgreichen Schema-Nachzug laufen genau sie noch EINMAL (kein Doppellauf). eintraege: [[datei, ergebnis], ...].
 */
export function waehleNachlauf(eintraege, nachzug) {
  if (nachzug !== 'ok') return [];
  return eintraege.filter(([, r]) => r?.status === 'SCHEMA_FEHLT_LIVE').map(([datei]) => datei);
}

/** Bewertung im Nachlauf: wie bewerte; scheitert der Test wieder an fehlendem Schema, ist das NEU_ROT (nie erneut SCHEMA_FEHLT_LIVE). */
export function bewerteNachlauf(lauf, eintrag, schemaFehlerAnzahl) {
  const b = bewerte(lauf, eintrag);
  if (b.status === 'NEU_ROT' && schemaFehlerAnzahl > 0 && !lauf.zeitlimit) return { ...b, grund: 'schema_nach_nachzug_fehlt' };
  return b;
}

/**
 * Zaehler fuer TESTLAUF ENDE. schema_fehlt_live = Tests, die im ersten Lauf SCHEMA_FEHLT_LIVE waren (auch wenn der Nachlauf sie
 * neu bewertet hat); nachlauf_gruen = davon im Nachlauf GRUEN; schema_ungeprueft = SCHEMA_FEHLT_LIVE ohne Nachlauf.
 * Der Nachlauf zaehlt normal in gruen/bekannt_rot/neu_rot.
 */
export function summiere(ergebnisListe, fehltAnzahl = 0) {
  const s = { gesamt: ergebnisListe.length + fehltAnzahl, gruen: 0, bekannt_rot: 0, schema_fehlt_live: 0, nachlauf_gruen: 0, schema_ungeprueft: 0,
    neu_rot: 0, fehlt: fehltAnzahl, uebersprungen: 0, nicht_gestartet: 0 };
  for (const r of ergebnisListe) {
    if (r.status === 'SCHEMA_FEHLT_LIVE' || r.nachlauf) s.schema_fehlt_live++;
    if (r.nachlauf && r.status === 'GRUEN') s.nachlauf_gruen++;
    if (r.status === 'GRUEN') s.gruen++;
    else if (r.status === 'BEKANNT_ROT') s.bekannt_rot++;
    else if (r.status === 'NEU_ROT') s.neu_rot++;
    else if (r.status === 'SCHEMA_FEHLT_LIVE') s.schema_ungeprueft++;
    else if (r.status === 'UEBERSPRUNGEN') s.uebersprungen++;
    else if (r.status === 'NICHT_GESTARTET') s.nicht_gestartet++;
  }
  return s;
}

/**
 * ergebnis=ROT genau dann, wenn neu_rot + fehlt + nicht_gestartet > 0, der Schema-Nachzug gescheitert ist oder (P25-T8) sich
 * Code/dist/Tests bzw. das Schema von synapse_test waehrend des Laufs geaendert haben (sauber === false, Mischstand).
 */
export function istRot(summe, nachzug, sauber = true) {
  return summe.neu_rot + summe.fehlt + summe.nicht_gestartet > 0 || nachzug === 'fehler' || sauber === false;
}

/** P25-T8: Erwartung ohne fail, ohne nicht-leere fail_zeilen und ohne muster. */
function ohneErwartung(e) {
  return e?.fail == null && !(Array.isArray(e?.fail_zeilen) && e.fail_zeilen.length) && !e?.muster;
}

function neueZeilen(ist, erwartet) {
  if (!Array.isArray(erwartet)) return [];
  return (ist ?? []).filter((z) => !erwartet.some((m) => passtZeile(z, m)));
}

/** Bis zu max TESTFEHLER-Texte: zuerst die Herkunftszeile, dann neue FAIL-Zeilen, dann die ersten Fehlerzeilen. */
export function testfehlerZeilen(aus, bewertung, max = 3) {
  const zeilen = [];
  const dazu = (z, praefix = '') => {
    const text = zeileFuerLog(praefix + z);
    if (text && !zeilen.some((x) => x === text || x === 'HERKUNFT ' + text) && zeilen.length < max) zeilen.push(text);
  };
  if (aus.herkunft_zeile) dazu(aus.herkunft_zeile, 'HERKUNFT ');
  for (const z of bewertung.neue_zeilen ?? []) dazu(z);
  for (const z of aus.fehler_zeilen ?? []) dazu(z);
  return zeilen;
}

function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// P25-T8 (Inventur 2f2f6776 Punkt 3): Zeilen, die auf praktisch jeden Fehler passen, taugen nicht als muster
// (z. B. 'Error\.captureStackTrace\(err\)' aus jedem pg-Stack, der nackte Assert-Kopf ohne eigenen Text).
const ALLERWELTS = [
  /^Error\.captureStackTrace\b/,
  /^(?:Uncaught )?[A-Za-z]*Error(?: \[[A-Z_]+\])?:?$/,
  /^AssertionError \[ERR_ASSERTION\]: (?:Expected values to be (?:strictly |loosely )?(?:deep-)?equal|The expression evaluated to a falsy value)/,
];

/** Muster-Kandidat aus einer Fehlerzeile (Stack-/URL-Rest abgeschnitten) oder null, wenn die Zeile zu allgemein ist. */
export function musterKandidat(zeile) {
  const text = String(zeile ?? '').split(/\s+at\s+|file:\/\//)[0].trim().slice(0, 120);
  if (text.replace(/[^A-Za-z0-9]/g, '').length < 12) return null;
  return ALLERWELTS.some((r) => r.test(text)) ? null : text;
}

const IMPORT_FEHLER = /does not provide an export named|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)\b|Cannot access '[^']+' before initialization/;
const NICHT_VORSCHLAGEN = new Set(['zeitlimit', 'privates_schema_veraltet', 'schema_bestand_unbekannt', 'schema_nach_nachzug_fehlt', 'eintrag_ohne_erwartung']);

/**
 * P25-T8: Grund, warum fuer einen NEU_ROT-Test KEIN bekannt_rot-Vorschlag entsteht, sonst null. Ausgeschlossen: Zeitlimit,
 * Import-/Ladefehler (Build- oder Zyklusproblem, gehoert in einen Fix-Task), Laeufer-Umgebung (test_db_ist_produktion),
 * veraltete Privatschemata/Schemafehler und Eintraege ohne verwertbare Erwartung (wuerden jeden Fehler erlauben).
 * eintrag = Ergebnis von vorschlagEintrag, lauf = { zeitlimit, ausgabe }, grund = Bewertungsgrund des Laeufers.
 */
export function vorschlagAblehnung({ eintrag, lauf, grund }) {
  if (lauf?.zeitlimit || grund === 'zeitlimit') return 'zeitlimit';
  if (NICHT_VORSCHLAGEN.has(grund)) return grund;
  const ausgabe = String(lauf?.ausgabe ?? '');
  if (IMPORT_FEHLER.test(ausgabe)) return 'importfehler';
  if (/\btest_db_ist_produktion\b/.test(ausgabe)) return 'laeufer_umgebung';
  if (ohneErwartung(eintrag?.erwartet)) return 'ohne_erwartung';
  return null;
}

/** Vorschlag fuer einen bekannt_rot-Eintrag (Inventur, --vorschlag). Lange Zeilen werden zu Praefix-Mustern. */
export function vorschlagEintrag({ test, lauf, aus, laufId, datum }) {
  const failZeilen = (aus.fail_zeilen ?? []).map((z) => (z.length > 160 ? z.slice(0, 160) + '*' : z));
  let muster = null;
  if (aus.fail == null && failZeilen.length === 0) {
    const erste = (aus.fehler_zeilen ?? []).map(musterKandidat).find(Boolean);
    if (erste) muster = escapeRegex(erste);
  }
  const erwartet = { fail: aus.fail ?? null, fail_zeilen: failZeilen.length ? failZeilen : null, muster };
  if (lauf.zeitlimit) erwartet.zeitlimit = true;
  return {
    datei: test.datei,
    ...(test.golden ? { golden: true } : {}),
    erwartet,
    grund: `inventur-${datum}: noch sichten (Altlast oder Fix-Task)`,
    seit: datum,
    task: aus.herkunft_id ?? test.task ?? null,
    quelle: `testlauf ${laufId}`,
  };
}
