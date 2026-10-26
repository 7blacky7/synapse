#!/usr/bin/env node
// test-alle.mjs — P25-T1 Gesamt-Testlaeufer: alle Tests mit EINEM Aufruf (Plan P25 "Gesamt-Testlauf").
// Entwurf thought 49df5e9e, User-Go b3a3a812, nicht warten / alles ins Log bf3f4579,
// Herkunft regel-tests-mit-herkunft-kommentieren (86b6877b), Vertrag T6 988979bc.
//
// Aufruf als EIN Synapse-shell(exec)-Job, cwd = Repo bzw. D2-Worktree:
//   mise run test-alle [-- Optionen]   (Node 25 ueber mise)   bzw.   node scripts/test-alle.mjs [Optionen]
// Optionen:
//   --nur <muster,...>          nur diese Tests: Pfad, Dateiname, Name ohne Endung oder Glob mit *
//   --nur-betroffene[=<basis>]  nur Tests geaenderter Pakete und ihrer Abnehmer (Standard-Basis origin/main)
//   --parallel <n>              Pool fuer normale Tests (Standard 8); KI-Browser-Tests laufen daneben seriell
//   --ohne-browser              KI-Browser-Tests auslassen (UEBERSPRUNGEN grund=ohne_browser)
//   --mit-docker                Tests mit braucht=docker mitnehmen (sonst UEBERSPRUNGEN grund=docker); D2: immer
//   --golden-basis <pfad>       rote Golden-Tests gegen die Basis vergleichen statt gegen feste fail_zeilen:
//                               Ordner = Basis-Worktree (Test dort ausfuehren), *.json = ergebnis.json des Basislaufs
//   --max-minuten <n>           danach starten keine neuen Tests mehr (Rest NICHT_GESTARTET), Standard 120
//   --log-dir <pfad>            Ablage dieses Laufs (Standard ~/.synapse/testlaeufe/<id>, die letzten 20 bleiben)
//   --bekannt-rot <pfad>        andere Bekannt-rot-Datei (Standard tests/bekannt-rot.json)
//   --vorschlag                 Inventur: Rot als Vorschlag in ergebnis.json + bekannt-rot.vorschlag.json (nie ins Repo)
//   --liste                     nur finden und einordnen, nichts ausfuehren (Zeilen TESTPLAN)
//   --ohne-schema-nachzug       synapse_test nach dem Lauf NICHT auf den Schemastand des Codes nachziehen
//   --screenshots-behalten <n>  je Anlass nur die letzten n Screenshot-Laeufe ui-screenshots/<anlass>/<lauf-id>/ behalten (Standard 3, P25-T7)
// Schema (User-Entscheidung 3f202323): vor dem Lauf SCHEMA_STAND (nur lesen); getestet wird gegen den Stand, den synapse_test
// hat (nach einem Deploy = Live-Stand). Rot nur wegen Tabelle/Spalte, die der aktuelle Code anlegt -> SCHEMA_FEHLT_LIVE (nicht ROT,
// mit Fundstelle/Task). DANACH Nachzug wie P17-T6 (ensureSchema, nur synapse_test): Zeilen SCHEMA_NEU / SCHEMA_OBJEKT / SCHEMA_NACHZUG.
// Nachlauf: Nach erfolgreichem Nachzug laufen genau die SCHEMA_FEHLT_LIVE-Tests noch EINMAL (sie konnten vorher nicht laufen);
// ihr Ergebnis zaehlt normal (GRUEN/BEKANNT_ROT/NEU_ROT), Zeile mit nachlauf=1, Abschluss schema_fehlt_live=<n> nachlauf_gruen=<n>.
// P25-T8 (Inventur 2f2f6776, Analyse 32c4a579):
//   (a) SCHEMA_FEHLT_LIVE nur, wenn das Objekt in public von synapse_test wirklich fehlt (Bestand aus 'pruefen', schema-bestand.json);
//       hat public es, baut der Test ein veraltetes privates Schema -> NEU_ROT grund=privates_schema_veraltet (HINWEIS PRIVATES_SCHEMA_VERALTET).
//   (b) Kinder bekommen die Test-DB wie im Synapse-shell-Job nur als DATABASE_URL; SYNAPSE_DATABASE_URL wird nicht gesetzt (sonst
//       test_db_ist_produktion), eine geerbte wird entfernt. Tests, die NUR SYNAPSE_DATABASE_URL lesen, bekommen sie gezielt ueber
//       einstellungen[].env {"SYNAPSE_DATABASE_URL": "${DATABASE_URL}"} (setzeEnvEin, kein Zugang in der Datei).
//   (c) Laufschutz: Stand (Commit + Dateien packages/*/{src,dist,tests}, scripts + SCHEMA_STAND von synapse_test) am Anfang und Ende.
//       Abweichung -> STAND_GEAENDERT-Zeilen, HINWEIS LAUF_UNSAUBER, ergebnis=ROT stand=unsauber, KEIN Schema-Nachzug/Nachlauf.
//   (d) seriell: Marker '// @testlauf seriell' bzw. einstellungen[].art='seriell' in tests/bekannt-rot.json (laufen nach dem Pool allein);
//       HINWEIS SERIELL_VERDACHT bei EADDRINUSE oder Zeitlimit im parallelen Pool.
//   (e) --vorschlag: keine leeren/Allerwelts-Erwartungen, nichts fuer Zeitlimit, Importfehler, Laeufer-Umgebung, Privatschema
//       (Zeilen VORSCHLAG_ABGELEHNT <name> grund=..., ergebnis.json vorschlag_abgelehnt).
// Ausgabe (feste Tokens, je Test genau eine Zeile, erst wenn der Test fertig ist):
//   TESTLAUF START id=... modus=... tests=... | TEST <paket>/<name> <STATUS> <ms>ms exit= fail= art= neu= geaendert= grund= herkunft= log=
//   TESTFEHLER <paket>/<name> <text> (bis zu 3, nur bei NEU_ROT, zuerst 'HERKUNFT <debugzeile>') | HINWEIS <CODE> <name> <text>
//   TESTLAUF ENDE id=... ergebnis=GRUEN|ROT ... stand=sauber|unsauber json=<pfad>
// Auswertung ohne Warten: shell(log, id, query:'NEU_ROT|FEHLT|NICHT_GESTARTET|TESTFEHLER|TESTLAUF ENDE', regex:true).
// Exit 0 = GRUEN, 1 = ROT (neu_rot+fehlt+nicht_gestartet > 0, Schema-Nachzug gescheitert oder LAUF_UNSAUBER), 2 = Abbruch (Zeile TESTLAUF ABBRUCH <grund>).
// Screenshots (P25-T7, User-Go 25.10.2026): Browser-Tests legen ueber scripts/lib/ui-screenshots.mjs unter ui-screenshots/<anlass>/<TESTLAUF_ID>/
// ab (Nachlauf: TESTLAUF_NACHLAUF=1 -> .../nachlauf/), nie ueberschreibend. Am Ende loescht der Laeufer je Anlass aeltere Lauf-Ordner:
//   SCREENSHOTS_GELOESCHT <pfad> dateien=<n> | SCREENSHOTS_AUFRAEUMEN behalten=<n> anlaesse=<n> laeufe_geloescht=<n> dateien=<n> fehler=<n>
// Der Laeufer schreibt nie ins Repo (einzige Ausnahme: dieses Loeschen alter Lauf-Ordner unter ui-screenshots/, regel-screenshots-in-ui-screenshots-ablegen;
// der Daemon gleicht ab, geloeschte Assets bleiben ueber asset_intel geloescht/wiederherstellen zurueckholbar) und ruft keine Synapse-API;
// git nur lesend (Commit, --nur-betroffene).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { bewerteTestDbUrl, kindEnv } from './lib/test-db-schutz.mjs';
import { findeTests, passtNur, setzeEnvEin, wendeEinstellungAn } from './lib/testlauf/finden.mjs';
import { beendeAlle, fuehreTestAus } from './lib/testlauf/ausfuehren.mjs';
import { bewerte, bewerteNachlauf, istRot, summiere, testfehlerZeilen, vorschlagAblehnung, vorschlagEintrag, waehleNachlauf, werteAusgabeAus, zeileFuerLog } from './lib/testlauf/bewerten.mjs';
import { geaenderteDateien, paketAbhaengigkeiten, waehleBetroffene, abnehmerHuelle } from './lib/testlauf/betroffene.mjs';
import { erkenneSchemaFehler, ladeSchemaQuellen, leseBestand, objektImBestand, objektName, sucheSchemaObjekt } from './lib/testlauf/schema.mjs';
import { erfasseStand, leseSchemaStand, mtimeIso, standKennung, vergleicheStand } from './lib/testlauf/stand.mjs';
import { raeumeScreenshotLaeufeAuf, STANDARD_BEHALTEN as SCREENSHOTS_BEHALTEN } from './lib/ui-screenshots.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ABLAGE = join(homedir(), '.synapse', 'testlaeufe');
const ZEIGER_VOLLER_LAUF = join(ABLAGE, 'letzter-voller-lauf.txt');
const AUFBEWAHREN = 20;
const LAUF_ORDNER = /^tl-\d{8}-\d{6}-[0-9a-f]{4}$/;

function abbruch(grund) {
  console.log(`TESTLAUF ABBRUCH ${zeileFuerLog(grund, 300)}`);
  process.exit(2);
}

function leseOptionen(argv) {
  const o = { nur: [], betroffene: null, parallel: 8, ohneBrowser: false, mitDocker: false, goldenBasis: null,
    maxMinuten: 120, logDir: null, bekanntRot: null, vorschlag: false, liste: false, ohneSchemaNachzug: false,
    screenshotsBehalten: SCREENSHOTS_BEHALTEN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const gleich = a.indexOf('=');
    const k = gleich > 0 ? a.slice(0, gleich) : a;
    const v = gleich > 0 ? a.slice(gleich + 1) : undefined;
    const wert = () => { const x = v ?? argv[++i]; if (x === undefined || x === '') abbruch(`Option ${k} braucht einen Wert`); return x; };
    const zahl = () => { const n = Number(wert()); if (!Number.isFinite(n) || n <= 0) abbruch(`Option ${k} braucht eine Zahl > 0`); return n; };
    switch (k) {
      case '--nur': o.nur.push(...wert().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--nur-betroffene': o.betroffene = v || 'origin/main'; break;
      case '--parallel': o.parallel = Math.floor(zahl()); break;
      case '--ohne-browser': o.ohneBrowser = true; break;
      case '--mit-docker': o.mitDocker = true; break;
      case '--golden-basis': o.goldenBasis = resolve(wert()); break;
      case '--max-minuten': o.maxMinuten = zahl(); break;
      case '--log-dir': o.logDir = resolve(wert()); break;
      case '--bekannt-rot': o.bekanntRot = resolve(wert()); break;
      case '--vorschlag': o.vorschlag = true; break;
      case '--liste': o.liste = true; break;
      case '--ohne-schema-nachzug': o.ohneSchemaNachzug = true; break;
      case '--screenshots-behalten': o.screenshotsBehalten = Math.max(1, Math.floor(zahl())); break;
      default: abbruch(`unbekannte Option ${a}`);
    }
  }
  if (o.nur.length && o.betroffene) abbruch('--nur und --nur-betroffene nicht zusammen');
  return o;
}

function laufId(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `tl-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
}

function datumHeute(d) { return d.toISOString().slice(0, 10); }

function ladeBekanntRot(pfad, istStandard) {
  if (!existsSync(pfad)) {
    if (!istStandard) abbruch(`Bekannt-rot-Datei fehlt: ${pfad}`);
    return { daten: { bekannt_rot: [], einstellungen: [] }, fehlt: true };
  }
  let daten;
  try { daten = JSON.parse(readFileSync(pfad, 'utf8')); } catch (e) { abbruch(`Bekannt-rot-Datei kein gueltiges JSON (${pfad}): ${e.message}`); }
  if (!Array.isArray(daten.bekannt_rot)) daten.bekannt_rot = [];
  if (!Array.isArray(daten.einstellungen)) daten.einstellungen = [];
  return { daten, fehlt: false };
}

function git(...args) {
  try { return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return '-'; }
}

/** Letzter voller Lauf (Zeiger-Datei) fuer neu/geaendert und die Reihenfolge lange-zuerst. */
function ladeVorlauf() {
  try {
    const pfad = readFileSync(ZEIGER_VOLLER_LAUF, 'utf8').trim();
    const json = JSON.parse(readFileSync(pfad, 'utf8'));
    return { pfad, id: json.id, tests: new Map((json.tests ?? []).map((t) => [t.datei, t])) };
  } catch { return null; }
}

function neuesteMtime(dir, tiefe = 0) {
  let max = 0;
  let eintraege;
  try { eintraege = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of eintraege) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (tiefe < 12) max = Math.max(max, neuesteMtime(p, tiefe + 1)); }
    else { try { max = Math.max(max, statSync(p).mtimeMs); } catch { /* weg */ } }
  }
  return max;
}

/** dist-Pruefung: core/dist fehlt -> Abbruch; sonst Hinweise DIST_FEHLT / DIST_ALT je Paket. */
function pruefeDist(pakete, hinweis) {
  if (!existsSync(join(REPO, 'packages', 'core', 'dist'))) abbruch('packages/core/dist fehlt (der Laeufer baut nicht: vorher mise run build bzw. code_check build_pruefen)');
  for (const p of pakete) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(REPO, 'packages', p, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg.scripts?.build) continue;
    const dist = join(REPO, 'packages', p, 'dist');
    if (!existsSync(dist)) { hinweis('DIST_FEHLT', p, 'kein dist/, Tests dieses Pakets koennen rot werden'); continue; }
    const src = neuesteMtime(join(REPO, 'packages', p, 'src'));
    if (src && src > neuesteMtime(dist)) hinweis('DIST_ALT', p, 'src neuer als dist, vorher bauen');
  }
}

function raeumeAlteLaeufeAuf() {
  let namen;
  try { namen = readdirSync(ABLAGE).filter((n) => LAUF_ORDNER.test(n)).sort(); } catch { return; }
  // P25-T8: der letzte volle Lauf (Zeiger, Basis fuer neu/geaendert und Inventur) bleibt, auch nach mehr als 20 --nur-Laeufen
  // (so ging am 26.10. die Inventur-Ablage tl-20261025-232030-a99b verloren).
  let geschuetzt = null;
  try { geschuetzt = basename(dirname(readFileSync(ZEIGER_VOLLER_LAUF, 'utf8').trim())); } catch { /* kein Zeiger */ }
  for (const n of namen.slice(0, Math.max(0, namen.length - AUFBEWAHREN))) {
    if (n === geschuetzt) continue;
    try { rmSync(join(ABLAGE, n), { recursive: true, force: true }); } catch { /* naechstes Mal */ }
  }
}

async function main() {
  const opt = leseOptionen(process.argv.slice(2));
  const start = new Date();
  const id = laufId(start);
  const hinweise = [];
  const hinweis = (code, name, text) => hinweise.push({ code, name: name ?? '-', text: zeileFuerLog(text ?? '', 200) });

  const bekanntPfad = opt.bekanntRot ?? join(REPO, 'tests', 'bekannt-rot.json');
  const { daten: liste, fehlt: listeFehlt } = ladeBekanntRot(bekanntPfad, !opt.bekanntRot);
  if (listeFehlt) hinweis('BEKANNT_ROT_DATEI_FEHLT', '-', `${bekanntPfad} fehlt, alles Rot zaehlt als NEU_ROT`);
  const eintragFuer = new Map(liste.bekannt_rot.map((e) => [e.datei, e]));
  const einstellungFuer = new Map(liste.einstellungen.map((e) => [e.datei, e]));

  const alleTests = findeTests(REPO).map((t) => wendeEinstellungAn(t, einstellungFuer.get(t.datei)));
  for (const t of alleTests) {
    if (eintragFuer.get(t.datei)?.golden === true) t.golden = true;
    if (t.unbekannte_marker.length) hinweis('MARKER_UNBEKANNT', t.name, t.unbekannte_marker.join(' '));
  }

  // Auswahl: alle | nur | betroffene
  let modus = 'alle';
  let basis = '-';
  let tests = alleTests;
  let eintragRelevant = () => true;
  if (opt.nur.length) {
    modus = 'nur';
    tests = alleTests.filter((t) => passtNur(t, opt.nur));
    if (!tests.length) abbruch(`--nur ${opt.nur.join(',')} trifft keinen Test`);
    eintragRelevant = (e) => passtNur({ datei: e.datei, name: e.datei }, opt.nur);
  } else if (opt.betroffene) {
    modus = 'betroffene';
    let g;
    try { g = geaenderteDateien(REPO, opt.betroffene); } catch (e) { abbruch(`--nur-betroffene: Basis ${opt.betroffene} nicht lesbar (${e.message.split('\n')[0]})`); }
    basis = g.basis_sha.slice(0, 12);
    const abh = paketAbhaengigkeiten(REPO);
    const w = waehleBetroffene(alleTests, g.dateien, abh);
    tests = alleTests.filter((t) => w.ausgewaehlt.has(t.datei));
    hinweis('BETROFFENE', '-', w.voll ? `voller Lauf (${w.grund}), ${g.dateien.length} geaenderte Dateien`
      : `${g.dateien.length} geaenderte Dateien, Pakete ${w.geaenderte_pakete.join(',') || '-'} -> ${w.betroffene_pakete.join(',') || '-'}`);
    const betroffen = new Set(w.voll ? alleTests.map((t) => t.paket) : abnehmerHuelle(w.geaenderte_pakete, abh));
    eintragRelevant = (e) => w.voll || betroffen.has(String(e.datei).split('/')[1]);
  }

  const vorlauf = ladeVorlauf();
  if (!vorlauf) hinweis('KEIN_VORLAUF', '-', 'kein voller Vorlauf gefunden, neu/geaendert bleiben 0');
  const kenn = (t) => {
    const alt = vorlauf?.tests.get(t.datei);
    return { neu: vorlauf && !alt ? 1 : 0, geaendert: alt && alt.sha256 && alt.sha256 !== t.sha256 ? 1 : 0, ms_alt: alt?.ms ?? null };
  };
  for (const t of tests) Object.assign(t, kenn(t));
  for (const t of tests) if (t.neu) hinweis('NEUE_TESTDATEI', t.name, `seit Vorlauf ${vorlauf.id}`);

  // Ausgelassen (nicht gestartet, aber gezaehlt)
  const uebersprungenGrund = (t) => (t.aus ? 'aus' : (t.braucht_docker && !opt.mitDocker ? 'docker' : (t.art === 'browser' && opt.ohneBrowser ? 'ohne_browser' : null)));

  if (opt.liste) {
    const z = { pool: 0, browser: 0, seriell: 0, docker: 0, aus: 0, bekannt_rot: 0 };
    console.log(`TESTLAUF LISTE modus=${modus} basis=${basis} tests=${tests.length} node=${process.version}`);
    for (const t of tests) {
      z[t.art]++; if (t.braucht_docker) z.docker++; if (t.aus) z.aus++; if (eintragFuer.has(t.datei)) z.bekannt_rot++;
      console.log(`TESTPLAN ${t.name} art=${t.art} quelle=${t.art_quelle} docker=${t.braucht_docker ? 1 : 0} zeitlimit=${t.zeitlimit_s}s golden=${t.golden ? 1 : 0} bekannt_rot=${eintragFuer.has(t.datei) ? 1 : 0} neu=${t.neu} geaendert=${t.geaendert} start=${uebersprungenGrund(t) ?? 'ja'}${t.aus ? ' aus=' + zeileFuerLog(t.aus, 80) : ''}`);
    }
    for (const h of hinweise) console.log(`HINWEIS ${h.code} ${h.name} ${h.text}`);
    console.log(`TESTLAUF LISTE ENDE gesamt=${tests.length} pool=${z.pool} browser=${z.browser} seriell=${z.seriell} docker=${z.docker} aus=${z.aus} bekannt_rot=${z.bekannt_rot}`);
    return 0;
  }

  // Vorbedingungen
  const db = bewerteTestDbUrl(process.env.DATABASE_URL);
  if (!db.ok) abbruch(`${db.grund} (nur synapse_test:5433 erlaubt; im Synapse-shell-Job kommt DATABASE_URL automatisch)`);
  pruefeDist([...new Set(tests.map((t) => t.paket))], hinweis);

  const logDir = opt.logDir ?? join(ABLAGE, id);
  mkdirSync(logDir, { recursive: true });
  // P25-T8 (b, Inventur Gruppe D): SYNAPSE_DATABASE_URL NICHT auf die Test-DB setzen. istSynapseProdDb (core test-db-laufzeit-schutz.ts)
  // haelt dasselbe Port+DB-Ziel wie SYNAPSE_DATABASE_URL fuer Prod -> test_db_ist_produktion (9 Tests). Wie im Synapse-shell-Job
  // (dort ist SYNAPSE_DATABASE_URL nicht gesetzt) kommt die Test-DB nur ueber DATABASE_URL; eine geerbte wird entfernt.
  const kindBasis = { ...kindEnv(process.env), SYNAPSE_SKIP_EMBEDDINGS: '1', QDRANT_URL: 'http://127.0.0.1:1', PARSER_LOOP_DISABLED: '1',
    TESTLAUF_ID: id, NO_COLOR: '1' };
  delete kindBasis.FORCE_COLOR;
  if (kindBasis.SYNAPSE_DATABASE_URL !== undefined) {
    delete kindBasis.SYNAPSE_DATABASE_URL;
    hinweis('SYNAPSE_DATABASE_URL_ENTFERNT', '-', 'geerbte SYNAPSE_DATABASE_URL nicht an die Tests weitergegeben, sie nehmen DATABASE_URL');
  }

  const commit = git('rev-parse', '--short=12', 'HEAD');
  // Laufschutz (P25-T8 c): Stand am Anfang festhalten, am Ende vergleichen
  const standStart = erfasseStand(REPO, { commit });
  console.log(`TESTLAUF START id=${id} modus=${modus} basis=${basis} commit=${commit} stand=${standKennung(standStart)} tests=${tests.length} neu=${tests.filter((t) => t.neu).length} geaendert=${tests.filter((t) => t.geaendert).length} parallel=${opt.parallel} db=${db.ziel.split('@').pop()} node=${process.version} docker=${opt.mitDocker ? 1 : 0} browser=${opt.ohneBrowser ? 0 : 1} screenshots_behalten=${opt.screenshotsBehalten} log=${logDir}`);

  // Schemastand vor dem Lauf (nur lesen, 3f202323): getestet wird gegen den Stand, den synapse_test gerade hat
  const SCHEMA_SKRIPT = 'scripts/lib/testlauf/schema-nachzug.mjs';
  const schemaSchritt = async (schritt, extra = [], logName = schritt) => {
    const logPfad = join(logDir, `schema-${logName}.log`);
    const r = await fuehreTestAus({ cwd: REPO, datei: SCHEMA_SKRIPT, skriptArgs: [schritt, ...extra], env: kindBasis, logPfad, zeitlimitS: 300 });
    return { exit: r.exit, zeilen: r.ausgabe.split('\n').filter((z) => /^SCHEMA_[A-Z]+ /.test(z)), log: logPfad };
  };
  const bestandDatei = join(logDir, 'schema-bestand.json');
  const schemaVorher = await schemaSchritt('pruefen', [bestandDatei]);
  for (const z of schemaVorher.zeilen) console.log(z);
  const standVorher = /stand=(\w+)/.exec(schemaVorher.zeilen.find((z) => z.startsWith('SCHEMA_STAND')) ?? '')?.[1] ?? 'unbekannt';
  if (schemaVorher.exit !== 0) hinweis('SCHEMA_STAND_UNBEKANNT', '-', `Schemastand nicht lesbar, siehe ${schemaVorher.log}`);
  else if (standVorher === 'aktuell') hinweis('SCHEMA_SCHON_AKTUELL', '-', 'synapse_test entspricht schon dem Schema dieses Codes; lag seit dem Deploy ein Nachzug dazwischen, ist fehlendes Live-Schema hier nicht erkennbar');
  // P25-T8 (a): Bestand von public in synapse_test; ohne ihn gibt es kein SCHEMA_FEHLT_LIVE (fail-closed: NEU_ROT)
  let schemaBestand = null;
  try { schemaBestand = leseBestand(JSON.parse(readFileSync(bestandDatei, 'utf8'))); }
  catch { hinweis('SCHEMA_BESTAND_UNBEKANNT', '-', `Bestand von public nicht lesbar (${bestandDatei}), Schemafehler zaehlen als NEU_ROT`); }
  let schemaQuellen = null;

  const ergebnisse = new Map();
  const zeile = (t, r) => `TEST ${t.name} ${r.status} ${r.ms}ms exit=${r.exit ?? '-'} fail=${r.fail ?? '-'} art=${t.art} neu=${t.neu} geaendert=${t.geaendert} grund=${r.grund ?? '-'} herkunft=${r.herkunft ?? t.task ?? '-'} log=${r.log ?? '-'}${r.nachlauf ? ' nachlauf=1' : ''}`;
  const melde = (t, r, fehlerTexte = []) => {
    ergebnisse.set(t.datei, r);
    console.log(zeile(t, r));
    for (const f of fehlerTexte) console.log(`TESTFEHLER ${t.name} ${f}`);
  };

  const ausfuehrbar = [];
  for (const t of tests) {
    const g = uebersprungenGrund(t);
    if (g) melde(t, { status: 'UEBERSPRUNGEN', ms: 0, exit: null, fail: null, grund: g, herkunft: null, log: null });
    else ausfuehrbar.push(t);
  }

  // Golden gegen Basis (User-Go Punkt 4: in D2 echter Vergleich gegen den Basis-Worktree)
  let basisErgebnis = null;
  if (opt.goldenBasis && opt.goldenBasis.endsWith('.json')) {
    try { basisErgebnis = new Map((JSON.parse(readFileSync(opt.goldenBasis, 'utf8')).tests ?? []).map((x) => [x.datei, x])); }
    catch (e) { abbruch(`--golden-basis ${opt.goldenBasis} nicht lesbar: ${e.message}`); }
  } else if (opt.goldenBasis && !existsSync(join(opt.goldenBasis, 'packages'))) abbruch(`--golden-basis ${opt.goldenBasis} ist weder ergebnis.json noch Worktree`);
  const goldenEintrag = async (t, logPfad) => {
    if (basisErgebnis) {
      const b = basisErgebnis.get(t.datei);
      if (!b) { hinweis('GOLDEN_BASIS_OHNE_TEST', t.name, 'Basislauf kennt den Test nicht, es gilt bekannt-rot.json'); return eintragFuer.get(t.datei) ?? null; }
      if (b.exit === 0) { hinweis('GOLDEN_BASIS_GRUEN', t.name, 'in der Basis gruen'); return null; }
      return { datei: t.datei, golden: true, erwartet: { fail: b.fail ?? null, fail_zeilen: b.fail_zeilen ?? [] }, quelle: `golden-basis ${opt.goldenBasis}` };
    }
    if (!existsSync(join(opt.goldenBasis, t.datei))) { hinweis('GOLDEN_BASIS_OHNE_TEST', t.name, 'Datei fehlt im Basis-Worktree, es gilt bekannt-rot.json'); return eintragFuer.get(t.datei) ?? null; }
    const basisLog = logPfad.replace(/\.log$/, '.basis.log');
    const b = await fuehreTestAus({ cwd: opt.goldenBasis, datei: t.datei, args: t.args, env: { ...kindBasis, ...setzeEnvEin(t.env, process.env) }, logPfad: basisLog, zeitlimitS: t.zeitlimit_s });
    if (b.exit === 0) { hinweis('GOLDEN_BASIS_GRUEN', t.name, 'in der Basis gruen'); return null; }
    const ba = werteAusgabeAus(b.ausgabe);
    return { datei: t.datei, golden: true, erwartet: { fail: ba.fail, fail_zeilen: ba.fail_zeilen }, quelle: `golden-basis ${basisLog}` };
  };

  const laufe = async (t, nachlauf = false) => {
    const vorher = nachlauf ? ergebnisse.get(t.datei) : null;
    // P25-T7: im Nachlauf TESTLAUF_NACHLAUF=1 -> Screenshots in ui-screenshots/<anlass>/<lauf-id>/nachlauf/ (erster Lauf bleibt unveraendert)
    const logPfad = join(logDir, `${t.paket}__${basename(t.datei).replace(/\.test\.(?:mjs|ts)$/, '')}${nachlauf ? '.nachlauf' : ''}.log`);
    const lauf = await fuehreTestAus({ cwd: REPO, datei: t.datei, args: t.args, env: { ...kindBasis, ...setzeEnvEin(t.env, process.env), ...(nachlauf ? { TESTLAUF_NACHLAUF: '1' } : {}) }, logPfad, zeitlimitS: t.zeitlimit_s });
    const aus = werteAusgabeAus(lauf.ausgabe);
    let eintrag = eintragFuer.get(t.datei) ?? null;
    if (opt.goldenBasis && t.golden && lauf.exit !== 0) eintrag = await goldenEintrag(t, logPfad);
    const b = nachlauf ? bewerteNachlauf({ ...lauf, ...aus }, eintrag, erkenneSchemaFehler(lauf.ausgabe).length) : bewerte({ ...lauf, ...aus }, eintrag);
    for (const h of b.hinweise) hinweis(h.code, t.name, h.text);
    // SCHEMA_FEHLT_LIVE (3f202323): Rot nur wegen Tabelle/Spalte, die der aktuelle Code anlegt, synapse_test aber noch nicht hat
    let schemaObjekte = [];
    if (!nachlauf && b.status === 'NEU_ROT' && !lauf.zeitlimit) {
      const fehlend = erkenneSchemaFehler(lauf.ausgabe);
      if (fehlend.length) {
        schemaQuellen ??= ladeSchemaQuellen(REPO);
        const mitFund = fehlend.map((o) => ({ ...o, objekt: objektName(o), fund: sucheSchemaObjekt(schemaQuellen, o) }));
        if (!mitFund.every((o) => o.fund)) hinweis('SCHEMA_OBJEKT_UNBEKANNT', t.name, `${mitFund.filter((o) => !o.fund).map((o) => `${o.art}:${o.objekt}`).join(' ')} fehlt, der Code legt es nicht an`);
        else if (!schemaBestand) b.grund = 'schema_bestand_unbekannt';
        else {
          // P25-T8 (a, Inventur Punkt 1): fehlt nur, wenn public es nicht hat; sonst ist das private Testschema veraltet (Nachzug hilft nicht)
          const imPublic = mitFund.filter((o) => objektImBestand(schemaBestand, o));
          if (!imPublic.length) { b.status = 'SCHEMA_FEHLT_LIVE'; b.grund = 'schema_fehlt'; schemaObjekte = mitFund; }
          else {
            b.grund = 'privates_schema_veraltet';
            hinweis('PRIVATES_SCHEMA_VERALTET', t.name, `${imPublic.map((o) => `${o.art}:${o.objekt}`).join(' ')} ist in public von synapse_test vorhanden, das private Testschema des Tests fehlt es`);
          }
        }
      }
    }
    const schemaZeilen = schemaObjekte.map((o) => `SCHEMA ${o.art} ${o.objekt} fehlt live, angelegt in ${o.fund.datei}:${o.fund.zeile}${o.fund.task ? ` (${o.fund.task})` : ''}`);
    if (b.status === 'NEU_ROT' && aus.eaddrinuse) hinweis('SERIELL_VERDACHT', t.name, 'EADDRINUSE in der Ausgabe, evtl. Marker seriell setzen');
    // P25-T8 (d): Zeitlimit im parallelen Pool (Inventur: 5 file-batch-Tests, ausweis-zaehler 260 s) -> seriell nachpruefen
    if (b.status === 'NEU_ROT' && lauf.zeitlimit && t.art === 'pool' && opt.parallel > 1) hinweis('SERIELL_VERDACHT', t.name, `Zeitlimit ${t.zeitlimit_s}s im parallelen Pool, seriell nachpruefen (einstellungen art seriell)`);
    const r = { status: b.status, ms: lauf.ms, exit: lauf.exit, fail: aus.fail, fail_zeilen: aus.fail_zeilen, neue_zeilen: b.neue_zeilen,
      grund: b.grund, herkunft: schemaObjekte[0]?.fund.task ?? aus.herkunft_id ?? vorher?.herkunft ?? null,
      schema_objekte: nachlauf ? (vorher?.schema_objekte ?? []) : schemaObjekte.map((o) => ({ art: o.art, name: o.objekt, datei: o.fund.datei, zeile: o.fund.zeile, task: o.fund.task })),
      nachlauf: nachlauf ? 1 : 0, vorlauf_status: vorher?.status ?? null, vorlauf_log: vorher?.log ?? null,
      herkunft_zeile: aus.herkunft_zeile ? zeileFuerLog(aus.herkunft_zeile) : null,
      zeitlimit_abgelaufen: lauf.zeitlimit, log: logPfad, _aus: aus, _lauf: lauf };
    melde(t, r, b.status === 'NEU_ROT' ? testfehlerZeilen(aus, b) : schemaZeilen);
  };

  // Planung: Pool (parallel, lange zuerst) + KI-Browser-Spur (seriell, daneben), danach seriell-exklusiv
  const ende = Date.now() + opt.maxMinuten * 60_000;
  const langeZuerst = (a, b) => (b.ms_alt ?? Infinity) - (a.ms_alt ?? Infinity);
  const pool = ausfuehrbar.filter((t) => t.art === 'pool').sort(langeZuerst);
  const browser = ausfuehrbar.filter((t) => t.art === 'browser').sort(langeZuerst);
  const seriell = ausfuehrbar.filter((t) => t.art === 'seriell').sort(langeZuerst);
  const arbeite = async (schlange, fn = laufe, frist = ende) => { while (schlange.length && Date.now() < frist && !abgebrochen) await fn(schlange.shift()); };

  let abgebrochen = null;
  const stopp = (signal) => { abgebrochen = signal; beendeAlle('SIGTERM'); setTimeout(() => beendeAlle('SIGKILL'), 5000).unref(); };
  process.on('SIGTERM', () => stopp('SIGTERM'));
  process.on('SIGINT', () => stopp('SIGINT'));

  await Promise.all([...Array.from({ length: Math.max(1, opt.parallel) }, () => arbeite(pool)), arbeite(browser)]);
  if (!abgebrochen) await arbeite(seriell);

  for (const t of ausfuehrbar) {
    if (!ergebnisse.has(t.datei)) melde(t, { status: 'NICHT_GESTARTET', ms: 0, exit: null, fail: null, grund: abgebrochen ? 'abgebrochen' : 'max_minuten', herkunft: null, log: null });
  }

  // Laufschutz (P25-T8 c, Inventur 2f2f6776): Code/dist/Tests oder Schema von synapse_test waehrend des Laufs geaendert -> Mischstand.
  // Dann LAUF_UNSAUBER, ergebnis=ROT und KEIN Nachzug/Nachlauf (sonst landet der Stand eines laufenden Umbaus in synapse_test).
  let stand = { sauber: true, start: standKennung(standStart), ende: null };
  if (!abgebrochen) {
    const standEnde = erfasseStand(REPO, { commit: git('rev-parse', '--short=12', 'HEAD') });
    const d = vergleicheStand(standStart, standEnde);
    const schemaEnde = await schemaSchritt('pruefen', [], 'pruefen-ende');
    const sv = leseSchemaStand(schemaVorher.zeilen);
    const se = leseSchemaStand(schemaEnde.zeilen);
    const schemaGleich = sv.vorhanden === se.vorhanden && sv.erwartet === se.erwartet;
    const dateiAenderungen = [...d.geaendert, ...d.neu, ...d.weg];
    stand = { sauber: d.gleich && schemaGleich, start: stand.start, ende: standKennung(standEnde), commit_start: commit, commit_ende: standEnde.commit,
      dateien: standEnde.dateien.size, geaendert: d.geaendert.slice(0, 50), neu: d.neu.slice(0, 50), weg: d.weg.slice(0, 50), schema_start: sv, schema_ende: se };
    for (const rel of dateiAenderungen.slice(0, 20)) console.log(`STAND_GEAENDERT ${rel} mtime=${mtimeIso(standEnde.dateien.get(rel))}${d.weg.includes(rel) ? ' weg=1' : ''}`);
    console.log(`STAND sauber=${stand.sauber ? 1 : 0} start=${stand.start} ende=${stand.ende} commit=${commit}->${standEnde.commit} dateien=${standEnde.dateien.size} geaendert=${d.geaendert.length} neu=${d.neu.length} weg=${d.weg.length} schema_vorhanden=${sv.vorhanden}->${se.vorhanden} schema_erwartet=${sv.erwartet}->${se.erwartet}`);
    if (!stand.sauber) {
      const teile = [];
      if (d.commit_geaendert) teile.push(`commit ${commit}->${standEnde.commit}`);
      if (dateiAenderungen.length) teile.push(`${dateiAenderungen.length} Dateien geaendert (STAND_GEAENDERT)`);
      if (!schemaGleich) teile.push(`Schema ${sv.vorhanden}/${sv.erwartet} -> ${se.vorhanden}/${se.erwartet}`);
      hinweis('LAUF_UNSAUBER', '-', `${teile.join(', ')}: Mischstand, kein Schema-Nachzug, auf festem Stand wiederholen`);
    }
  }

  // Nachzug (3f202323): erst NACH den Tests synapse_test auf den Schemastand des Codes ziehen, Neues ins Log
  let schemaNachzug = 'aus';
  const schemaNachzugZeilen = [];
  if (!opt.ohneSchemaNachzug && !abgebrochen && !stand.sauber) {
    schemaNachzug = 'uebersprungen';
    console.log('SCHEMA_NACHZUG uebersprungen grund=lauf_unsauber (kein Zwischenstand nach synapse_test)');
  } else if (!opt.ohneSchemaNachzug && !abgebrochen) {
    const objekte = [];
    for (const r of ergebnisse.values()) for (const o of r.schema_objekte ?? []) if (!objekte.some((x) => x.art === o.art && x.name === o.name)) objekte.push({ art: o.art, name: o.name });
    const objektDatei = join(logDir, 'schema-objekte.json');
    writeFileSync(objektDatei, JSON.stringify(objekte) + '\n');
    const n = await schemaSchritt('nachziehen', [objektDatei]);
    for (const z of n.zeilen) { console.log(z); schemaNachzugZeilen.push(z); }
    schemaNachzug = n.exit === 0 && n.zeilen.some((z) => z.startsWith('SCHEMA_NACHZUG ok=1')) ? 'ok' : 'fehler';
    if (schemaNachzug === 'fehler') hinweis('SCHEMA_NACHZUG_FEHLER', '-', `Nachzug gescheitert, siehe ${n.log}`);
    // Nachlauf (Koordinator 25.10.): SCHEMA_FEHLT_LIVE-Tests konnten vorher nicht laufen -> nach dem Nachzug genau EINMAL,
    // Ergebnis zaehlt normal. Ohne Frist, die Auswahl ist klein; der KI-Browser bleibt seriell.
    const nachlaufDateien = new Set(waehleNachlauf([...ergebnisse.entries()], schemaNachzug));
    if (nachlaufDateien.size && !abgebrochen) {
      console.log(`TESTLAUF NACHLAUF tests=${nachlaufDateien.size} grund=schema_nachgezogen`);
      const nl = tests.filter((t) => nachlaufDateien.has(t.datei));
      const nachlaufTest = (t) => laufe(t, true);
      const nPool = nl.filter((t) => t.art === 'pool');
      await Promise.all([...Array.from({ length: Math.max(1, Math.min(opt.parallel, nPool.length)) }, () => arbeite(nPool, nachlaufTest, Infinity)),
        arbeite(nl.filter((t) => t.art === 'browser'), nachlaufTest, Infinity)]);
      if (!abgebrochen) await arbeite(nl.filter((t) => t.art === 'seriell'), nachlaufTest, Infinity);
    }
  }
  const ungeprueft = [...ergebnisse.values()].filter((r) => r.status === 'SCHEMA_FEHLT_LIVE').length;
  if (ungeprueft) hinweis('SCHEMA_FEHLT_LIVE_UNGEPRUEFT', '-', `${ungeprueft} Tests ohne Nachlauf (Nachzug ${schemaNachzug}), ihre Pruefungen liefen nicht`);

  // Screenshots (P25-T7): je Anlass nur die letzten n Lauf-Ordner ui-screenshots/<anlass>/<lauf-id>/ behalten, der laufende Lauf ist geschuetzt.
  // Altbestand ohne Lauf-ID-Namen (z. B. Fixtures ui-screenshots/p22-t149/*.png) bleibt unberuehrt. Bei Abbruch wird nichts geloescht.
  let screenshots = { behalten: opt.screenshotsBehalten, anlaesse: 0, geloescht: [], fehler: [], aufgeraeumt: false };
  if (!abgebrochen) {
    try { screenshots = { ...raeumeScreenshotLaeufeAuf(REPO, { behalten: opt.screenshotsBehalten, schuetzen: [id] }), aufgeraeumt: true }; }
    catch (e) { screenshots.fehler.push({ rel: '-', text: e.message }); }
    for (const g of screenshots.geloescht) console.log(`SCREENSHOTS_GELOESCHT ${g.rel} dateien=${g.dateien}`);
    for (const f of screenshots.fehler) hinweis('SCREENSHOTS_AUFRAEUMEN_FEHLER', f.rel, f.text);
    console.log(`SCREENSHOTS_AUFRAEUMEN behalten=${screenshots.behalten} anlaesse=${screenshots.anlaesse} laeufe_geloescht=${screenshots.geloescht.length} dateien=${screenshots.geloescht.reduce((s, g) => s + g.dateien, 0)} fehler=${screenshots.fehler.length}`);
  }

  // FEHLT: Eintrag ohne Datei
  const vorhanden = new Set(alleTests.map((t) => t.datei));
  const fehlt = [];
  for (const e of liste.bekannt_rot) {
    if (vorhanden.has(e.datei) || !eintragRelevant(e)) continue;
    const name = String(e.datei).replace(/^packages\//, '').replace('/tests/', '/').replace(/\.test\.(?:mjs|ts)$/, '');
    fehlt.push({ datei: e.datei, name });
    console.log(`TEST ${name} FEHLT 0ms exit=- fail=- art=- neu=0 geaendert=0 grund=datei_fehlt herkunft=${e.task ?? '-'} log=-`);
  }

  for (const h of hinweise) console.log(`HINWEIS ${h.code} ${h.name} ${h.text}`);

  // Zusammenfassung + ergebnis.json
  const summe = summiere([...ergebnisse.values()], fehlt.length);
  const rot = istRot(summe, schemaNachzug, stand.sauber);
  const datum = datumHeute(start);
  const vorschlaege = [];
  const vorschlaegeAbgelehnt = [];
  if (opt.vorschlag) {
    for (const t of tests) {
      const r = ergebnisse.get(t.datei);
      if (r?.status !== 'NEU_ROT') continue;
      const v = vorschlagEintrag({ test: t, lauf: r._lauf, aus: r._aus, laufId: id, datum });
      // P25-T8 (e): keine leeren/Allerwelts-Erwartungen, nichts fuer Zeitlimit, Importfehler, Laeufer-Umgebung, Privatschema
      const ablehnung = vorschlagAblehnung({ eintrag: v, lauf: r._lauf, grund: r.grund });
      if (ablehnung) vorschlaegeAbgelehnt.push({ datei: t.datei, name: t.name, grund: ablehnung });
      else vorschlaege.push({ ...v, ...(eintragFuer.has(t.datei) ? { ersetzt: true } : {}) });
    }
  }
  const json = {
    id, start: start.toISOString(), ende: new Date().toISOString(), commit, basis, modus, node: process.version, parallel: opt.parallel,
    repo: REPO, bekannt_rot_datei: bekanntPfad, vorlauf: vorlauf?.pfad ?? null, optionen: { ...opt }, summe,
    schema: { stand_vorher: standVorher, vorher: schemaVorher.zeilen, nachzug: schemaNachzug, zeilen: schemaNachzugZeilen },
    stand,
    tests: tests.map((t) => {
      const r = ergebnisse.get(t.datei) ?? {};
      return { datei: t.datei, paket: t.paket, name: t.name, art: t.art, status: r.status, exit: r.exit ?? null, fail: r.fail ?? null,
        fail_zeilen: r.fail_zeilen ?? [], neue_zeilen: r.neue_zeilen ?? [], ms: r.ms ?? 0, zeitlimit: t.zeitlimit_s,
        zeitlimit_abgelaufen: !!r.zeitlimit_abgelaufen, sha256: t.sha256, neu: t.neu, geaendert: t.geaendert, grund: r.grund ?? null,
        herkunft: r.herkunft ?? t.task ?? null, herkunft_zeile: r.herkunft_zeile ?? null, schema_objekte: r.schema_objekte ?? [], nachlauf: r.nachlauf ?? 0,
        vorlauf_status: r.vorlauf_status ?? null, vorlauf_log: r.vorlauf_log ?? null, log: r.log ?? null };
    }).concat(fehlt.map((f) => ({ datei: f.datei, name: f.name, status: 'FEHLT', grund: 'datei_fehlt' }))),
    screenshots: { lauf_id: id, ...screenshots },
    hinweise,
    ...(opt.vorschlag ? { vorschlag_bekannt_rot: vorschlaege, vorschlag_abgelehnt: vorschlaegeAbgelehnt } : {}),
  };
  const jsonPfad = join(logDir, 'ergebnis.json');
  writeFileSync(jsonPfad, JSON.stringify(json, null, 2) + '\n');
  if (opt.vorschlag) {
    const ersetzt = new Set(vorschlaege.map((v) => v.datei));
    const neueListe = { ...liste, bekannt_rot: [...liste.bekannt_rot.filter((e) => !ersetzt.has(e.datei)), ...vorschlaege.map(({ ersetzt: _x, ...v }) => v)]
      .sort((a, b) => String(a.datei).localeCompare(String(b.datei))) };
    writeFileSync(join(logDir, 'bekannt-rot.vorschlag.json'), JSON.stringify(neueListe, null, 2) + '\n');
    for (const a of vorschlaegeAbgelehnt) console.log(`VORSCHLAG_ABGELEHNT ${a.name} grund=${a.grund}`);
    const jeGrund = Object.entries(vorschlaegeAbgelehnt.reduce((s, a) => ({ ...s, [a.grund]: (s[a.grund] ?? 0) + 1 }), {})).map(([g, n]) => `${g}=${n}`).join(' ');
    console.log(`HINWEIS VORSCHLAG - ${vorschlaege.length} Eintraege in ${join(logDir, 'bekannt-rot.vorschlag.json')} (sichten, dann per files nach tests/bekannt-rot.json), ${vorschlaegeAbgelehnt.length} nicht vorgeschlagen${jeGrund ? ` (${jeGrund})` : ''}`);
  }
  if (modus === 'alle' && !abgebrochen) {
    try { mkdirSync(ABLAGE, { recursive: true }); writeFileSync(ZEIGER_VOLLER_LAUF, jsonPfad + '\n'); } catch { /* Zeiger optional */ }
  }
  if ((logDir + sep).startsWith(ABLAGE + sep)) raeumeAlteLaeufeAuf();

  const dauer = Math.round((Date.now() - start.getTime()) / 1000);
  console.log(`TESTLAUF ENDE id=${id} ergebnis=${rot ? 'ROT' : 'GRUEN'} gesamt=${summe.gesamt} gruen=${summe.gruen} bekannt_rot=${summe.bekannt_rot} schema_fehlt_live=${summe.schema_fehlt_live} nachlauf_gruen=${summe.nachlauf_gruen} neu_rot=${summe.neu_rot} fehlt=${summe.fehlt} uebersprungen=${summe.uebersprungen} nicht_gestartet=${summe.nicht_gestartet} schema_nachzug=${schemaNachzug} stand=${stand.sauber ? 'sauber' : 'unsauber'} dauer=${dauer}s json=${jsonPfad}`);
  if (abgebrochen) { console.log(`TESTLAUF ABBRUCH signal=${abgebrochen}`); return 2; }
  return rot ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  console.log(`TESTLAUF ABBRUCH interner Fehler: ${zeileFuerLog(e?.stack ?? String(e), 300)}`);
  beendeAlle('SIGTERM');
  process.exitCode = 2;
});
