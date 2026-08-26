/**
 * PRUEFT getReferences UND planeUmbenennung GEGEN GEMESSENE SOLLWERTE.
 *
 * WOZU: Am 24.-26.08.2026 sind in genau diesen beiden Funktionen drei Fehler
 * aufgetreten, die im Code plausibel aussahen — Namensgleichheit als
 * Aufloesung, LIMIT 1 unter fuenf Definitionen, und die hier festgehaltene
 * Blindstelle (J). Ohne festgeschriebene Sollwerte faellt ein Rueckfall erst
 * auf, wenn jemand zufaellig hinsieht.
 *
 * AUFRUF (braucht die Zugangsdaten der Datenbank in der Umgebung):
 *   set -a; . ./.env; set +a; node packages/core/tests/code-intel-referenzen.test.mjs
 * Exit 0 = keine unerwartete Abweichung, Exit 1 = eine Zusage mit status=soll
 * ist verletzt oder der Selbsttest bricht.
 * Braucht ein gebautes packages/core/dist. Er baut NICHT selbst.
 * Er liest ausschliesslich — kein INSERT, kein UPDATE.
 *
 * ⚠️ DIESE ZUSAGEN HAENGEN AM INDEXSTAND DES PROJEKTS, und das ist der
 * wichtigste Satz in dieser Datei. Die Zahlen unten sind ECHTE Messwerte vom
 * 26.08.2026 gegen das indexierte Projekt "synapse" — keine Schaetzungen. Aber
 * sie beschreiben Code, den jemand aendern darf. Wird eine der genannten
 * Stellen umgebaut, meldet dieser Test rot, OHNE dass an code_intel etwas
 * kaputt ist. Wer hier ein Rot sieht, prueft deshalb ZUERST, ob sich der
 * gemessene Code geaendert hat, und zieht dann die Zahl nach. Ein Rot heisst
 * hier "nachsehen", nicht automatisch "Regression".
 * Die rein parser-seitigen Zusagen ohne diese Abhaengigkeit stehen getrennt in
 * tests/parser-aufrufkanten.test.mjs.
 *
 * ⚠️ ERWARTET-ROT: die (J)-Zusagen beschreiben den Sollzustand. Sie werden
 * gezaehlt und benannt, brechen den Lauf aber nicht. Schlagen sie um, meldet
 * der Runner UMGESCHLAGEN — dann ist (J) behoben und die Kennzeichnung gehoert
 * entfernt.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const distIndex = join(hier, '..', 'dist', 'index.js');
const PROJEKT = 'synapse';

/**
 * Selbsttest der Pruef-Logik. Laeuft bei JEDEM Aufruf: ein Test, der nie rot
 * werden kann, ist keiner.
 */
function selbsttest() {
  if (vergleiche(3, 3) !== true) return 'Selbsttest: gleicher Wert gilt nicht als erfuellt';
  if (vergleiche(3, 4) !== false) return 'Selbsttest: abweichender Wert gilt faelschlich als erfuellt';
  if (vergleiche(undefined, 0) !== false) return 'Selbsttest: undefined gilt faelschlich als 0';
  if (vergleiche('a', 'a') !== true) return 'Selbsttest: Zeichenketten werden nicht verglichen';
  return null;
}

function vergleiche(ist, soll) {
  return ist === soll;
}

const selbsttestFehler = selbsttest();
if (selbsttestFehler) {
  console.error(`FEHLER  ${selbsttestFehler}`);
  process.exit(1);
}

let getReferences;
let planeUmbenennung;
try {
  ({ getReferences, planeUmbenennung } = await import(pathToFileURL(distIndex).href));
} catch (e) {
  console.error(`FEHLER  packages/core/dist fehlt oder ist unvollstaendig (${e.message}).`);
  console.error('        Erst bauen, dann diesen Test laufen lassen — er baut absichtlich nicht selbst.');
  process.exit(1);
}

let gruen = 0;
let rot = 0;
let erwartetRot = 0;
let umgeschlagen = 0;

function pruefe(bezeichnung, ist, soll, status) {
  const erfuellt = vergleiche(ist, soll);
  const wie = `${bezeichnung}: soll ${JSON.stringify(soll)}, ist ${JSON.stringify(ist)}`;
  if (status === 'soll') {
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
    console.log('              Diese bekannte Luecke ist geschlossen. Kennzeichnung erwartet-rot hier entfernen.');
  } else {
    erwartetRot++;
    console.log(`ERWARTET-ROT  ${wie}  (bekannte Luecke (J), dynamische Importe werden nicht aufgeloest)`);
  }
}

try {
  // ---- getReferences: Namensgleichheit wird aussortiert und MITGEZAEHLT ----
  // Gemessen 26.08.2026. "update" ist der Fall aus muster-stille-teilantwort:
  // 14 Treffer, davon 13 crypto.createHash(...).update(). Der Filter darf sie
  // nicht als Referenzen ausgeben, muss sie aber sichtbar zaehlen.
  const refUpdate = await getReferences(PROJEKT, 'update');
  pruefe('references(update).references', refUpdate.references.length, 1, 'soll');
  pruefe('references(update).total_name_matches', refUpdate.total_name_matches, 13, 'soll');

  // ---- planeUmbenennung ----
  // watcherRequest: eindeutiger Name, 5 Stellen. Gemessen 26.08.2026.
  const umbWatcher = await planeUmbenennung(PROJEKT, 'watcherRequest', 'watcherRequestNeu');
  pruefe('rename(watcherRequest).stellen', umbWatcher.stellen.length, 5, 'soll');
  pruefe('rename(watcherRequest).mehrdeutig', umbWatcher.mehrdeutig, false, 'soll');

  // update: 2 Stellen, 13 Namensgleiche bleiben bewusst draussen und werden
  // gezaehlt. Genau diese Zahl war der Beleg dafuer, dass der Filter wirkt.
  const umbUpdate = await planeUmbenennung(PROJEKT, 'update', 'updateNeu');
  pruefe('rename(update).stellen', umbUpdate.stellen.length, 2, 'soll');
  pruefe('rename(update).namensgleiche_ignoriert', umbUpdate.namensgleiche_ignoriert, 13, 'soll');

  // ---- Blindstelle (J): dynamische Importe werden nicht aufgeloest ----
  // GEMESSEN 26.08.2026: getReferences liefert als "definition" das
  // import-Symbol an der VERWENDUNGSSTELLE (tray.ts:197, typ=import) statt der
  // echten Definition in project-status.ts:247. Die Datei mit der echten
  // Definition taucht in den Referenzen ueberhaupt nicht auf.
  // Warum das mehr ist als ein Schoenheitsfehler: planeUmbenennung baut auf
  // getReferences auf. Eine Umbenennung wuerde die Import-Zeile aendern und die
  // echte Definition stehen lassen.
  const refDyn = await getReferences(PROJEKT, 'holeChannelTeilnehmer');
  pruefe(
    '(J) references(holeChannelTeilnehmer).definition.file_path',
    refDyn.definition ? refDyn.definition.file_path : null,
    'packages/core/src/services/project-status.ts',
    'erwartet-rot',
  );
  pruefe(
    '(J) references(holeChannelTeilnehmer).definition.symbol_type',
    refDyn.definition ? refDyn.definition.symbol_type : null,
    'function',
    'erwartet-rot',
  );
  pruefe(
    '(J) references(holeChannelTeilnehmer) kennt die Datei der echten Definition',
    refDyn.references.some((r) => r.file_path === 'packages/core/src/services/project-status.ts'),
    true,
    'erwartet-rot',
  );
} catch (e) {
  console.error(`FEHLER  Lauf abgebrochen: ${e.message}`);
  console.error('        Stehen die Zugangsdaten der Datenbank in der Umgebung? set -a; . ./.env; set +a');
  process.exit(1);
}

const gesamt = gruen + rot + erwartetRot + umgeschlagen;
console.log('');
console.log(`${gesamt} Zusagen: ${gruen} gruen, ${rot} unerwartet rot, ${erwartetRot} erwartet-rot, ${umgeschlagen} umgeschlagen.`);
if (umgeschlagen > 0) {
  console.log('⚠️  Mindestens eine bekannte Luecke ist zu. Kennzeichnung nachziehen, sonst verliert der Test seine Aussage.');
}
process.exit(rot > 0 ? 1 : 0);
