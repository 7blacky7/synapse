/**
 * PRUEFT DIE AUFRUFKANTEN DES TYPESCRIPT-PARSERS GEGEN DIE ZUSAGEN IN DER FIXTURE.
 *
 * WOZU: Am 26.08.2026 wurden zwei Blindstellen gemessen, die im Code plausibel
 * aussehen und deshalb monatelang niemandem aufgefallen sind — (D) eine
 * Pfeilfunktion als Call-Argument bekommt keinen Scope, ihre Aufrufe entstehen
 * nie; (O) dieselbe Stelle zaehlt einen Initialisierer-Aufruf doppelt. Dieser
 * Runner haelt beide als ZUSAGE fest, damit Schritt 7 (D1) eine Messlatte hat
 * und nicht auf Zuruf fuer erledigt erklaert wird.
 *
 * AUFRUF:
 *   node packages/core/tests/parser-aufrufkanten.test.mjs
 * Exit 0 = keine unerwartete Abweichung. Exit 1 = eine Zusage mit status=soll
 * ist verletzt, oder der Selbsttest der Pruef-Logik bricht.
 * Braucht ein gebautes packages/core/dist. Er baut NICHT selbst.
 *
 * ⚠️ ERWARTET-ROT IST KEIN FEHLER, SONDERN EINE VERABREDUNG. Zusagen mit
 * status=erwartet-rot beschreiben den Sollzustand NACH D1. Sie werden gezaehlt
 * und einzeln benannt, brechen den Lauf aber nicht. Schlaegt eine davon um,
 * meldet der Runner UMGESCHLAGEN — das ist die Abnahme fuer D1, und die
 * Kennzeichnung in der Fixture gehoert dann entfernt. Auskommentiert wird
 * nichts: eine stumme Zusage ist keine.
 *
 * ⚠️ ZEILENNUMMERN SIND ABSOLUT. Wer die Fixture bearbeitet, verschiebt sie —
 * dann meldet dieser Test genau das, und die Nummern im Kopf sind nachzuziehen.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const fixturPfad = join(hier, '..', 'src', 'parser', '__testdata__', 'sample-pfeilfunktion-argument.ts');
const distIndex = join(hier, '..', 'dist', 'parser', 'index.js');

/** Liest die Zusagen aus dem Kopfkommentar der Fixture. */
function lesZusagen(roh) {
  const zusagen = [];
  const kante = /AUFRUFKANTE:\s*callee=(\S+)\s+scope=(\S+)\s+zeile=(\d+)\s+anzahl=(\d+)\s+status=(soll|erwartet-rot)/g;
  let m;
  while ((m = kante.exec(roh)) !== null) {
    zusagen.push({
      art: 'aufrufkante',
      callee: m[1],
      scope: m[2],
      zeile: Number(m[3]),
      anzahl: Number(m[4]),
      status: m[5],
    });
  }
  const symbol = /SYMBOL-VERBOTEN:\s*typ=(\S+)\s+name_enthaelt=(\S+)\s+zeile=(\d+)\s+status=(soll|erwartet-rot)/g;
  while ((m = symbol.exec(roh)) !== null) {
    zusagen.push({
      art: 'symbol-verboten',
      typ: m[1],
      enthaelt: m[2],
      zeile: Number(m[3]),
      status: m[4],
    });
  }
  return zusagen;
}

/** Zaehlt die Kanten, auf die eine Zusage passt. scope: '*' = beliebig, '-' = leer. */
function zaehleKanten(kanten, z) {
  return kanten.filter((e) => {
    if (e.callee_name !== z.callee) return false;
    if (e.line_number !== z.zeile) return false;
    if (z.scope === '*') return true;
    if (z.scope === '-') return e.caller_scope === null || e.caller_scope === undefined;
    return e.caller_scope === z.scope;
  }).length;
}

/** Zaehlt Symbole, die eine Verbots-Zusage verletzen wuerden. */
function zaehleSymbole(symbole, z) {
  return symbole.filter(
    (s) => s.symbol_type === z.typ && s.line_start === z.zeile && typeof s.name === 'string' && s.name.includes(z.enthaelt),
  ).length;
}

/**
 * ⚠️ ANKER-PRUEFUNG — sie ist wichtiger, als sie aussieht.
 * Jede Zusage nennt eine ABSOLUTE Zeilennummer. Verschiebt jemand die Fixture,
 * zeigt die Nummer ins Leere. Eine Zusage mit anzahl=0 ist dann faelschlich
 * erfuellt und wird als UMGESCHLAGEN gemeldet — also als BEHOBENE Luecke. Genau
 * das ist beim Anlegen dieser Datei passiert: zwei Zusagen meldeten "Luecke
 * geschlossen", waehrend in Wahrheit nur die Zeilennummer falsch war.
 * Deshalb muss die genannte Zeile den genannten Namen auch wirklich enthalten.
 * Der Vergleich geht direkt gegen den Dateitext und ist damit auch dann
 * wirksam, wenn der Parser selbst kaputt ist.
 */
function pruefeAnker(zeilen, zusagen) {
  const fehler = [];
  for (const z of zusagen) {
    const text = zeilen[z.zeile - 1];
    const gesucht = z.art === 'aufrufkante' ? z.callee : z.enthaelt;
    if (text === undefined || !text.includes(gesucht)) {
      fehler.push(
        `Zeile ${z.zeile} enthaelt "${gesucht}" nicht (dort steht: ${text === undefined ? '<Datei zu kurz>' : text.trim()})`,
      );
    }
  }
  return fehler;
}

/**
 * Selbsttest der Pruef-Logik. Laeuft bei JEDEM Aufruf: ein Test, der nie rot
 * werden kann, ist keiner.
 */
function selbsttest() {
  const kanten = [
    { callee_name: 'a', line_number: 5, caller_scope: 'f' },
    { callee_name: 'a', line_number: 5, caller_scope: null },
  ];
  if (zaehleKanten(kanten, { callee: 'a', scope: 'f', zeile: 5 }) !== 1) return 'Selbsttest: Scope-Treffer falsch gezaehlt';
  if (zaehleKanten(kanten, { callee: 'a', scope: '-', zeile: 5 }) !== 1) return 'Selbsttest: leerer Scope falsch gezaehlt';
  if (zaehleKanten(kanten, { callee: 'a', scope: '*', zeile: 5 }) !== 2) return 'Selbsttest: Stern-Scope falsch gezaehlt';
  if (zaehleKanten(kanten, { callee: 'a', scope: '*', zeile: 6 }) !== 0) return 'Selbsttest: falsche Zeile wurde als Treffer gewertet';
  if (zaehleKanten(kanten, { callee: 'b', scope: '*', zeile: 5 }) !== 0) return 'Selbsttest: falscher Name wurde als Treffer gewertet';
  const sym = [{ symbol_type: 'variable', line_start: 9, name: '{ x }' }];
  if (zaehleSymbole(sym, { typ: 'variable', enthaelt: '{', zeile: 9 }) !== 1) return 'Selbsttest: Symbol-Verbot greift nicht';
  if (zaehleSymbole(sym, { typ: 'variable', enthaelt: '{', zeile: 8 }) !== 0) return 'Selbsttest: Symbol-Verbot greift auf falscher Zeile';
  const ankerGut = pruefeAnker(['egal', 'ruft foo() auf'], [{ art: 'aufrufkante', callee: 'foo', zeile: 2 }]);
  if (ankerGut.length !== 0) return 'Selbsttest: gueltiger Anker wurde faelschlich beanstandet';
  const ankerSchlecht = pruefeAnker(['egal', 'ruft foo() auf'], [{ art: 'aufrufkante', callee: 'bar', zeile: 2 }]);
  if (ankerSchlecht.length !== 1) return 'Selbsttest: veralteter Anker wurde NICHT erkannt';
  const ankerZuKurz = pruefeAnker(['egal'], [{ art: 'aufrufkante', callee: 'foo', zeile: 9 }]);
  if (ankerZuKurz.length !== 1) return 'Selbsttest: Zeile jenseits des Dateiendes wurde nicht erkannt';
  const gelesen = lesZusagen(' * AUFRUFKANTE: callee=k scope=- zeile=3 anzahl=0 status=erwartet-rot\n');
  if (gelesen.length !== 1 || gelesen[0].callee !== 'k' || gelesen[0].anzahl !== 0 || gelesen[0].status !== 'erwartet-rot') {
    return 'Selbsttest: das Zusagen-Format wird nicht korrekt gelesen';
  }
  if (lesZusagen(' * AUFRUFKANTE: callee=NAME scope=NAME zeile=Z anzahl=N status=S\n').length !== 0) {
    return 'Selbsttest: die Format-Doku im Kopf wurde faelschlich als Zusage gelesen';
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

let inhalt;
try {
  inhalt = readFileSync(fixturPfad, 'utf8');
} catch (e) {
  console.error(`FEHLER  Fixture nicht lesbar: ${fixturPfad} (${e.message})`);
  process.exit(1);
}

const zusagen = lesZusagen(inhalt);
if (zusagen.length === 0) {
  console.error('FEHLER  Die Fixture enthaelt keine einzige Zusage — dann prueft dieser Lauf nichts.');
  process.exit(1);
}

const ankerFehler = pruefeAnker(inhalt.split('\n'), zusagen);
if (ankerFehler.length > 0) {
  console.error('FEHLER  Zusagen zeigen ins Leere — die Zeilennummern in der Fixture sind veraltet:');
  for (const f of ankerFehler) console.error(`        ${f}`);
  console.error('        Erst die Nummern nachziehen. Bis dahin sagt dieser Lauf nichts aus.');
  process.exit(1);
}

const parser = getParserForFile(fixturPfad, inhalt);
if (!parser) {
  console.error(`FEHLER  Kein Parser fuer ${fixturPfad}`);
  process.exit(1);
}
const ergebnis = parser.parse(inhalt, fixturPfad);
const kanten = ergebnis.callEdges || [];
const symbole = ergebnis.symbols || [];

let gruen = 0;
let rot = 0;
let erwartetRot = 0;
let umgeschlagen = 0;

for (const z of zusagen) {
  const ist = z.art === 'aufrufkante' ? zaehleKanten(kanten, z) : zaehleSymbole(symbole, z);
  const soll = z.art === 'aufrufkante' ? z.anzahl : 0;
  const erfuellt = ist === soll;
  const wie =
    z.art === 'aufrufkante'
      ? `Aufrufkante ${z.callee} (scope=${z.scope}) in Zeile ${z.zeile}: soll ${soll}, ist ${ist}`
      : `Symbol-Verbot ${z.typ} mit "${z.enthaelt}" im Namen in Zeile ${z.zeile}: soll 0, ist ${ist}`;

  if (z.status === 'soll') {
    if (erfuellt) {
      gruen++;
      console.log(`GRUEN         ${wie}`);
    } else {
      rot++;
      console.error(`ROT           ${wie}`);
    }
  } else if (erfuellt) {
    umgeschlagen++;
    console.log(`UMGESCHLAGEN  ${wie}`);
    console.log('              Diese bekannte Luecke ist geschlossen. Kennzeichnung erwartet-rot in der Fixture entfernen.');
  } else {
    erwartetRot++;
    console.log(`ERWARTET-ROT  ${wie}  (bekannte Luecke, wird von Schritt 7 / D1 geschlossen)`);
  }
}

console.log('');
console.log(`${zusagen.length} Zusagen: ${gruen} gruen, ${rot} unerwartet rot, ${erwartetRot} erwartet-rot, ${umgeschlagen} umgeschlagen.`);
if (umgeschlagen > 0) {
  console.log('⚠️  Mindestens eine bekannte Luecke ist zu. Fixture nachziehen, sonst verliert der Test seine Aussage.');
}
process.exit(rot > 0 ? 1 : 0);
