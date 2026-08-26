/**
 * FIXTURE FUER ZWEI BLINDSTELLEN DES TYPESCRIPT-PARSERS.
 *
 * (D) EINE PFEILFUNKTION, DIE ALS ARGUMENT EINES AUFRUFS UEBERGEBEN WIRD,
 * bekommt keinen eigenen Scope. Ihr Rumpf wird Text im umgebenden Statement,
 * und die Aufrufe darin entstehen NIE als Aufrufkante. Gemessen 26.08.2026.
 * Fundstelle: typescript.ts:889-899 — walk() bricht bei ArrowFunction ab, mit
 * dem Kommentar "deren Calls gehoeren zu deren eigenem Scope (separat
 * behandelt)". Separat behandelt werden aber nur Initialisierer und
 * Objekt-Properties (descendIntoFunctionInitializer, :993-1024). ARGUMENTE
 * nicht. Der Kommentar behauptet eine Vollstaendigkeit, die es nicht gibt.
 * Folge im Bestand: routes/projects.ts ruft neun Funktionen aus @synapse/core
 * auf, KEINE davon erscheint als Aufrufkante.
 *
 * (O) DERSELBE ORT, UMGEKEHRTER FEHLER. Bei einer Pfeilfunktion als
 * INITIALISIERER entsteht die Kante ZWEIMAL: einmal richtig mit dem
 * Funktionsnamen als Scope, einmal zusaetzlich mit leerem Scope. Grund:
 * collectCallsInExpression ruft ts.forEachChild(expr, walk) und laesst den
 * Wurzelknoten damit aus. Ist die Wurzel selbst die Pfeilfunktion, greift der
 * Abbruch aus :889-899 genau dort nicht, wo er greifen muesste — ihr Rumpf
 * wird zusaetzlich im aeusseren Scope gezaehlt.
 *
 * ⚠️ MEHRERE ZUSAGEN HIER SIND HEUTE ABSICHTLICH ROT (status=erwartet-rot).
 * Sie beschreiben den Sollzustand nach Schritt 7 (D1), nicht den heutigen.
 * Schlagen sie um, ist D1 wirksam — der Runner meldet das laut, und die
 * Kennzeichnung gehoert dann entfernt. Ein Test, der eine bekannte Luecke
 * gruen meldet, ist wertlos.
 *
 * FORMAT, gelesen von tests/parser-aufrufkanten.test.mjs:
 *   AUFRUFKANTE: callee=NAME scope=NAME zeile=Z anzahl=N status=S
 *   SYMBOL-VERBOTEN: typ=T name_enthaelt=X zeile=Z status=S
 * status ist "soll" oder "erwartet-rot"; anzahl=0 heisst "darf es NICHT geben".
 * Bei scope steht ein Strich fuer den leeren Scope und ein Stern fuer
 * "gleichgueltig". Der Stern ist bei den erwartet-roten Zusagen Absicht: der
 * kuenftige Scope-Name aus D1 steht noch nicht fest, zugesagt ist DASS die
 * Kante entsteht, nicht wie ihr Scope heisst.
 * Absichtlich NICHT das Format aus fixture-zeilennummern.test.mjs — das
 * beschreibt Symbol-Zeilen, hier geht es um Aufrufkanten.
 *
 * AUFRUFKANTE: callee=get scope=registriereRouten zeile=61 anzahl=1 status=soll
 * AUFRUFKANTE: callee=ladeProjekte scope=* zeile=62 anzahl=1 status=erwartet-rot
 * AUFRUFKANTE: callee=zaehleTreffer scope=* zeile=69 anzahl=1 status=erwartet-rot
 * AUFRUFKANTE: callee=meldeFehler scope=beiFehler zeile=81 anzahl=1 status=soll
 * AUFRUFKANTE: callee=meldeFehler scope=- zeile=81 anzahl=0 status=erwartet-rot
 * AUFRUFKANTE: callee=holeDaten scope=nutzeDynamisch zeile=95 anzahl=1 status=soll
 * SYMBOL-VERBOTEN: typ=variable name_enthaelt={ zeile=94 status=erwartet-rot
 */

import { ladeProjekte, zaehleTreffer, meldeFehler } from './hilfen.js';

/** Nur damit die Fixture fuer sich genommen uebersetzbar bleibt. */
interface HttpServer {
  get(pfad: string, handler: () => Promise<unknown>): void;
}

/**
 * FALL 1 (D) — der Aufruf steht im Rumpf einer Pfeilfunktion, die als zweites
 * ARGUMENT uebergeben wird.
 */
export function registriereRouten(server: HttpServer): void {
  server.get('/projekte', async () => {
    const eintraege = await ladeProjekte();
    return eintraege;
  });
}

/** FALL 2 (D) — derselbe Mechanismus bei einem Rueckruf an .map. */
export function summiere(werte: number[]): number {
  return werte.map((wert) => zaehleTreffer(wert)).length;
}

/**
 * KONTROLLFALL — Pfeilfunktion als INITIALISIERER. Diesen Weg deckt
 * descendIntoFunctionInitializer ab; hier MUSS heute schon eine Kante mit
 * scope=beiFehler entstehen. Ohne diesen Fall koennte der Runner niemals gruen
 * werden und waere kein Test, sondern eine Behauptung.
 * Zugleich der Nachweis fuer (O): dieselbe Zeile erzeugt heute eine ZWEITE
 * Kante mit leerem Scope.
 */
export const beiFehler = (): void => {
  meldeFehler('kontrollfall');
};

/**
 * FALL 3 — dynamischer Import. Vorbedingung fuer Blindstelle (J), die selbst
 * NICHT hier sitzt: der Aufruf bekommt korrekt eine Kante. Kaputt ist erst die
 * Aufloesung in getReferences, die das an der Verwendungsstelle entstehende
 * import-Symbol fuer die Definition haelt. Nachgewiesen wird das in
 * tests/code-intel-referenzen.test.mjs.
 * Hier bleibt nur die Zusage, dass die Zerlegung KEIN variable-Symbol mit
 * geschweifter Klammer im Namen erzeugen darf — heute tut sie genau das.
 */
export async function nutzeDynamisch(): Promise<string> {
  const { holeDaten } = await import('./hilfen.js');
  return holeDaten();
}
