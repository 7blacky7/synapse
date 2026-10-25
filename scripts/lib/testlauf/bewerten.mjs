// bewerten.mjs — P25-T1 Gesamt-Testlaeufer: Testausgabe auswerten und gegen tests/bekannt-rot.json bewerten.
// Entwurf thought 49df5e9e Abschnitte 2 (Fehlzahl), 5 (Bekannt-rot), 6 (Zeilenform).
// Herkunft nach regel-tests-mit-herkunft-kommentieren (thought 86b6877b): die erste rote Debugzeile mit
// Task-ID (z. B. 'FAIL P22-T170 lesefenster.ts ...: erwartet 2, tatsaechlich 1') wird bei NEU_ROT uebernommen.
// Reine Funktionen, keine Datei- oder Prozesszugriffe.

export const STATUS = ['GRUEN', 'BEKANNT_ROT', 'SCHEMA_FEHLT_LIVE', 'NEU_ROT', 'FEHLT', 'UEBERSPRUNGEN', 'NICHT_GESTARTET'];

const SPEC_DAUER = /\s*\(\d+(?:\.\d+)?m?s\)\s*$/;
const HERKUNFT_ID = /\bP\d+-[A-Z]{1,2}\d+\b/;
const HERKUNFT_SIGNAL = /(?:\b(?:DEBUG|HERKUNFT|FAIL|FEHLER|Error|erwartet|tatsaechlich|tatsächlich|expected|actual)\b|✖|\bnot ok\b)/i;
const GRUENE_ZEILE = /^(?:OK|ok|PASS|✔)\b/;
const FEHLER_ZEILE = /^(?:FAIL\b|✖ (?!failing tests)|not ok\b|ABBRUCH\b|FEHLER\b|DEBUG\b|HERKUNFT\b|TESTLAUF-STARTFEHLER\b|(?:Uncaught )?[A-Z][A-Za-z]*Error\b|Error\b)/;
const SELBST_UEBERSPRUNGEN = /: uebersprungen — .*Braucht eine Wegwerf-DB/; // Format aus scripts/lib/test-db-schutz.mjs testDbOderSkip

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
 * fail: node:test-Summe ('ℹ fail N' / '# fail N'), sonst Anzahl verschiedener ^FAIL-Zeilen (Golden), sonst
 * 'N Fehler' / 'N FAIL' / 'fail=N', sonst null.
 * fail_zeilen: sortierte Menge der ^FAIL-Zeilen und der node:test-Fehlschlaege ('✖ <name>' ohne Dauer).
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
    if (/^FAIL\b/.test(z)) { failPraefix.add(z); failZeilen.add(z); }
    else if (t.startsWith('✖ ') && !/^✖ failing tests:?$/.test(t)) failZeilen.add(t.replace(SPEC_DAUER, ''));
    else if ((m = /^not ok \d+ - (.*)$/.exec(t))) failZeilen.add('✖ ' + m[1].replace(/\s+#.*$/, ''));
    if ((m = /\b(\d+)\s+(?:FAIL|Fehler|failed|fehlgeschlagen)\b/.exec(z))) zahlText = Number(m[1]);
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

/** ergebnis=ROT genau dann, wenn neu_rot + fehlt + nicht_gestartet > 0 oder der Schema-Nachzug gescheitert ist. */
export function istRot(summe, nachzug) {
  return summe.neu_rot + summe.fehlt + summe.nicht_gestartet > 0 || nachzug === 'fehler';
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

/** Vorschlag fuer einen bekannt_rot-Eintrag (Inventur, --vorschlag). Lange Zeilen werden zu Praefix-Mustern. */
export function vorschlagEintrag({ test, lauf, aus, laufId, datum }) {
  const failZeilen = (aus.fail_zeilen ?? []).map((z) => (z.length > 160 ? z.slice(0, 160) + '*' : z));
  let muster = null;
  if (aus.fail == null && failZeilen.length === 0) {
    const erste = (aus.fehler_zeilen ?? [])[0];
    if (erste) muster = escapeRegex(erste.split(/\s+at\s+|file:\/\//)[0].trim().slice(0, 120));
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
