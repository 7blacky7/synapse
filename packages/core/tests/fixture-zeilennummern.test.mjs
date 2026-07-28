/**
 * PRUEFT DIE ZEILENNUMMERN DER PARSER GEGEN DIE SOLLWERTE IN DEN FIXTURES.
 *
 * WOZU: In packages/core/src/parser/__testdata__ liegen Fixtures, die im
 * Kopfkommentar festhalten, welche Zeile ein Symbol tragen MUSS. Ohne diesen
 * Runner sind diese Zusagen nur nachpruefbar — jemand muss hinsehen. Mit ihm
 * faellt eine Regression auf, ohne dass jemand hinsieht. Das ist der ganze
 * Unterschied, und er war der Grund fuer diese Datei.
 *
 * AUFRUF:
 *   node packages/core/tests/fixture-zeilennummern.test.mjs
 *   node packages/core/tests/fixture-zeilennummern.test.mjs --gegenprobe
 * Exit 0 = alle Sollwerte erfuellt, Exit 1 = mindestens einer verletzt.
 * Braucht ein gebautes packages/core/dist. Er baut NICHT selbst.
 *
 * FORMAT IN DER FIXTURE — eine Zeile im Kopfkommentar je Zusage:
 *   [<symbolname>] -> Zeile <n>
 * Eine Fixture ohne solche Zeilen wird uebersprungen, nicht als Fehler
 * gewertet. Damit waechst dieser Test von selbst mit, sobald jemand in einer
 * beliebigen Fixture Sollwerte ergaenzt — es ist keine Aenderung hier noetig.
 *
 * ⚠️ WARUM ECKIGE KLAMMERN UND KEINE ANFUEHRUNGSZEICHEN:
 * Der Kommentar wird VOM PARSER MITGELESEN. Steht der Symbolname in
 * Anfuehrungszeichen, macht extractStringLiterals daraus ein String-Symbol MIT
 * DEMSELBEN NAMEN — aus einem Symbol "model" wurden so drei, und eine Pruefung
 * auf Eindeutigkeit waere daran gescheitert. Wer eine Fixture um Sollwerte
 * ergaenzt, muss das wissen: eckige Klammern, keine Quotes.
 *
 * ⚠️ ZEILENNUMMERN SIND ABSOLUT. Wer eine Fixture bearbeitet, verschiebt sie —
 * dann meldet dieser Test genau das, und die Nummern im Kopf sind nachzuziehen.
 * Das ist Absicht: lieber ein lauter Test als ein stiller Sollwert, der nicht
 * mehr stimmt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const fixtureVerzeichnis = join(hier, '..', 'src', 'parser', '__testdata__');
const distIndex = join(hier, '..', 'dist', 'parser', 'index.js');

const gegenprobe = process.argv.includes('--gegenprobe');
const ausfuehrlich = process.argv.includes('--verbose');

/** Sollwerte aus dem Kopfkommentar. Leer = Fixture traegt keine Zusagen. */
function lesSollwerte(text) {
  const treffer = [];
  for (const zeile of text.split('\n')) {
    const m = /\[([^\]\n]+)\]\s*->\s*Zeile\s+(\d+)/.exec(zeile);
    if (m) treffer.push({ name: m[1], zeile: Number(m[2]) });
  }
  return treffer;
}

/**
 * Selbsttest der Pruef-Logik. Laeuft bei JEDEM Aufruf, nicht nur auf Wunsch:
 * ein Test, der nie rot werden kann, ist keiner. Hier wird an einem
 * synthetischen Fall geprueft, dass eine verschobene Zeile auch wirklich
 * auffaellt — wenn diese Zusicherung bricht, ist der ganze Lauf wertlos.
 */
function selbsttest() {
  const symbole = [{ name: 'x', line_start: 5 }];
  const trifft = (soll) => symbole.some((s) => s.name === 'x' && s.line_start === soll);
  if (!trifft(5)) return 'Selbsttest: richtiger Sollwert wurde NICHT als erfuellt erkannt';
  if (trifft(6)) return 'Selbsttest: verschobener Sollwert wurde faelschlich als erfuellt erkannt';
  const roh = '#   [feld] -> Zeile 42\n# ohne Zusage\n';
  const gelesen = lesSollwerte(roh);
  if (gelesen.length !== 1 || gelesen[0].name !== 'feld' || gelesen[0].zeile !== 42) {
    return 'Selbsttest: das Sollwert-Format wird nicht korrekt gelesen';
  }
  if (lesSollwerte('# nur Text, keine Zusage\n').length !== 0) {
    return 'Selbsttest: eine Datei ohne Zusagen liefert faelschlich Sollwerte';
  }
  return null;
}

const selbsttestFehler = selbsttest();
if (selbsttestFehler) {
  console.error(`FEHLER  ${selbsttestFehler}`);
  process.exit(1);
}

let getParserForFile;
try {
  ({ getParserForFile } = await import(pathToFileURL(distIndex).href));
} catch (e) {
  console.error(`FEHLER  packages/core/dist fehlt oder ist unvollstaendig (${e.message}).`);
  console.error('        Erst bauen, dann diesen Test laufen lassen — er baut absichtlich nicht selbst.');
  process.exit(1);
}

let dateien = [];
try {
  dateien = readdirSync(fixtureVerzeichnis).sort();
} catch (e) {
  console.error(`FEHLER  Fixture-Verzeichnis nicht lesbar: ${fixtureVerzeichnis} (${e.message})`);
  process.exit(1);
}

let geprueft = 0;
let erfuellt = 0;
const abweichungen = [];
const uebersprungen = [];

for (const datei of dateien) {
  const pfad = join(fixtureVerzeichnis, datei);
  let text;
  try {
    text = readFileSync(pfad, 'utf8');
  } catch {
    continue;
  }
  const sollwerte = lesSollwerte(text);
  if (sollwerte.length === 0) {
    uebersprungen.push(`${datei} (keine Sollwerte im Kopfkommentar)`);
    continue;
  }

  const parser = getParserForFile(pfad);
  if (!parser) {
    // Sollwerte da, aber kein Parser zustaendig: das ist ein echter Mangel und
    // keine Sache zum Ueberspringen — sonst prueft der Test still nichts mehr.
    abweichungen.push(`${datei}: Sollwerte vorhanden, aber kein Parser fuer diese Endung`);
    continue;
  }

  let symbole;
  try {
    symbole = parser.parse(text, pfad).symbols;
  } catch (e) {
    abweichungen.push(`${datei}: parse() ist gescheitert — ${e.message}`);
    continue;
  }

  for (const [i, soll] of sollwerte.entries()) {
    // Gegenprobe: der erste Sollwert der ersten Fixture wird absichtlich um eine
    // Zeile verschoben. Der Lauf MUSS dadurch rot werden.
    const erwartet = gegenprobe && i === 0 ? soll.zeile + 1 : soll.zeile;
    geprueft++;
    const gleichnamige = symbole.filter((s) => s.name === soll.name);
    if (gleichnamige.length === 0) {
      abweichungen.push(`${datei}: [${soll.name}] erwartet Zeile ${erwartet}, aber kein Symbol dieses Namens`);
      continue;
    }
    if (gleichnamige.some((s) => s.line_start === erwartet)) {
      erfuellt++;
      continue;
    }
    const ist = gleichnamige.map((s) => s.line_start).join('/');
    abweichungen.push(`${datei}: [${soll.name}] erwartet Zeile ${erwartet}, tatsaechlich ${ist}`);
  }
}

// Uebersprungene Fixtures nur zaehlen, nicht einzeln auflisten: es sind ueber
// sechzig, und sie wuerden die Abweichungen zuschuetten, auf die es ankommt.
if (uebersprungen.length > 0) {
  console.log(`uebersprungen  ${uebersprungen.length} Fixtures ohne Sollwerte im Kopfkommentar (--verbose zeigt welche)`);
  if (ausfuehrlich) for (const u of uebersprungen) console.log(`               ${u}`);
}
for (const a of abweichungen) console.error(`ABWEICHUNG     ${a}`);

const kopf = gegenprobe ? 'GEGENPROBE (ein Sollwert absichtlich verschoben)' : 'Fixture-Zeilennummern';
console.log(`${kopf}: ${geprueft} Sollwerte geprueft, ${erfuellt} erfuellt, ${abweichungen.length} verletzt`);

if (gegenprobe) {
  if (abweichungen.length === 0) {
    console.error('FEHLER  Die Gegenprobe hat NICHTS gefunden — dieser Test kann nicht rot werden und ist wertlos.');
    process.exit(1);
  }
  console.log('Gegenprobe bestanden: die verschobene Zeile wurde erkannt.');
  process.exit(0);
}

process.exit(abweichungen.length === 0 ? 0 : 1);
