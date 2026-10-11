// P15-T33 E0/E1: generische Gold-Erklaerungen (Lage / Wieso / Abhilfe) je Fehlerklasse des E0-Korpus, deutsch und
// englisch - ohne Projekt-, Pfad- oder Bezeichnerbezug. Deutsch = Wortlaut aus E0 (thought 1486172c), Englisch = E1.
// Zurueckgehalten (keine Erklaerung im Topf -> Jev muss 'keine' waehlen): K10, S3, X_escape, X_erfunden.
// Verwendung: scripts/erklaerungen/messung-sprache.mjs; E2 spielt sie als Startbestand 'vorgeschlagen' ein.
export const ERKLAERUNGEN = {
  K1: {
    de: { lage: 'Ein Block wird nicht geschlossen: eine schliessende geschweifte Klammer fehlt.', wieso: 'Eine Aenderung hat eine Zeile mit "}" entfernt oder ersetzt. Der Parser liest den Rest als Inhalt des offenen Blocks und meldet den Fehler oft erst spaeter oder am Dateiende, weit weg von der Ursache.', abhilfe: 'An der geaenderten Stelle die fehlende "}" wieder einfuegen; nicht an der gemeldeten Stelle suchen, sondern dort, wo die Aenderung Klammern entfernt hat.' },
    en: { lage: 'A block is not closed: a closing curly brace is missing.', wieso: 'A change removed or replaced a line containing "}". The parser reads the rest as part of the open block and often reports the error later or at the end of the file, far away from the cause.', abhilfe: 'Re-insert the missing "}" at the changed place; do not search at the reported position but where the change removed braces.' },
  },
  K2: {
    de: { lage: 'Eine schliessende geschweifte Klammer zu viel.', wieso: 'Eine Aenderung hat "}" doppelt geschrieben (z. B. Ersatztext enthaelt das Blockende und das alte Blockende bleibt stehen). Der Block endet zu frueh, der folgende Code steht ausserhalb.', abhilfe: 'Die ueberzaehlige "}" an der Aenderungsstelle entfernen; pruefen, ob der Ersatztext das Blockende schon enthaelt.' },
    en: { lage: 'One closing curly brace too many.', wieso: 'A change wrote "}" twice (e.g. the replacement text contains the block end and the old block end remains). The block ends too early and the following code is outside of it.', abhilfe: 'Remove the surplus "}" at the changed place; check whether the replacement text already contains the block end.' },
  },
  K3: {
    de: { lage: 'In einem Objekt- oder Array-Literal fehlt das Komma zwischen zwei Eintraegen.', wieso: 'Beim Einfuegen oder Umstellen von Eintraegen wurde das trennende Komma am Zeilenende vergessen; vor dem naechsten Eintrag erwartet der Parser ",".', abhilfe: 'Am Ende des Eintrags vor der gemeldeten Zeile ein Komma ergaenzen.' },
    en: { lage: 'A comma between two entries of an object or array literal is missing.', wieso: 'When inserting or rearranging entries, the separating comma at the end of the line was forgotten; before the next entry the parser expects ",".', abhilfe: 'Add a comma at the end of the entry before the reported line.' },
  },
  K4: {
    de: { lage: 'Ein String-Literal wird nicht geschlossen.', wieso: 'Das schliessende Anfuehrungszeichen fehlt; der String laeuft bis zum Zeilenende, danach folgen Folgefehler.', abhilfe: 'Das passende schliessende Anfuehrungszeichen ergaenzen; bei Text mit Anfuehrungszeichen Escape oder Template-String nutzen.' },
    en: { lage: 'A string literal is not closed.', wieso: 'The closing quote is missing; the string runs to the end of the line, followed by consequential errors.', abhilfe: 'Add the matching closing quote; for text that contains quotes use escaping or a template string.' },
  },
  K5: {
    de: { lage: '"await" steht in einer Funktion, die nicht als async markiert ist.', wieso: 'await ist nur in async-Funktionen bzw. auf Modulebene erlaubt; der umgebenden Funktion fehlt das Schluesselwort async.', abhilfe: 'Die umgebende Funktion als async markieren (Aufrufer pruefen) oder das Promise ohne await behandeln.' },
    en: { lage: '"await" is used in a function that is not marked async.', wieso: 'await is only allowed in async functions or at module level; the enclosing function lacks the async keyword.', abhilfe: 'Mark the enclosing function as async (check its callers) or handle the promise without await.' },
  },
  K6: {
    de: { lage: 'ES-Import und CommonJS-require sind in einer Importzeile vermischt.', wieso: '"import { a } = require(...)" ist weder ESM- noch CommonJS-Syntax; nach "import { ... }" erwartet der Parser "from".', abhilfe: 'Entweder import { a } from "modul" oder const { a } = require("modul") verwenden, passend zum Modulsystem der Datei.' },
    en: { lage: 'ES import and CommonJS require are mixed in one import line.', wieso: '"import { a } = require(...)" is neither ESM nor CommonJS syntax; after "import { ... }" the parser expects "from".', abhilfe: 'Use either import { a } from "module" or const { a } = require("module"), matching the module system of the file.' },
  },
  K7: {
    de: { lage: 'Git-Konfliktmarker stehen im Quelltext.', wieso: 'Zeilen wie <<<<<<<, ======= und >>>>>>> stammen aus einem nicht aufgeloesten Merge oder wurden mitkopiert; sie sind kein Code.', abhilfe: 'Den Konflikt aufloesen: die gewuenschte Variante behalten und alle Markerzeilen entfernen.' },
    en: { lage: 'Git conflict markers are in the source code.', wieso: 'Lines like <<<<<<<, ======= and >>>>>>> come from an unresolved merge or were copied along; they are not code.', abhilfe: 'Resolve the conflict: keep the wanted variant and remove all marker lines.' },
  },
  K8: {
    de: { lage: 'Eine Anweisung oder Deklaration wurde mitten in einen Ausdruck eingefuegt (Objekt-Literal, Argumentliste, Array).', wieso: 'Die Einfuegestelle lag innerhalb eines noch offenen Ausdrucks; dort sind nur Eintraege bzw. Argumente erlaubt, keine function- oder const-Anweisungen.', abhilfe: 'Den eingefuegten Code hinter das Ende des umgebenden Ausdrucks bzw. auf Modulebene verschieben; den Anker hinter das schliessende Zeichen legen.' },
    en: { lage: 'A statement or declaration was inserted in the middle of an expression (object literal, argument list, array).', wieso: 'The insertion point was inside a still open expression; only entries or arguments are allowed there, no function or const statements.', abhilfe: 'Move the inserted code behind the end of the enclosing expression or to module level; place the anchor after the closing character.' },
  },
  K9: {
    de: { lage: 'Eine schliessende runde Klammer fehlt (Funktionsaufruf, Bedingung oder Gruppierung).', wieso: 'Bei der Aenderung eines Aufrufs ging ")" verloren; der Parser erwartet ")" dort, wo stattdessen ";" oder ein anderes Zeichen kommt.', abhilfe: 'Die Klammerpaare der geaenderten Zeile zaehlen und die fehlende ")" ergaenzen.' },
    en: { lage: 'A closing parenthesis is missing (function call, condition or grouping).', wieso: 'While changing a call, ")" got lost; the parser expects ")" where ";" or another character comes instead.', abhilfe: 'Count the bracket pairs of the changed line and add the missing ")".' },
  },
  K11: {
    de: { lage: 'Ein Stueck Code steht doppelt am Dateiende.', wieso: 'Eine Ersetzung oder ein Anfuegen hat das Dateiende (schliessende Klammern, Exporte, letzte Anweisungen) ein zweites Mal geschrieben, z. B. weil der Ersatztext den Rest der Datei schon enthielt.', abhilfe: 'Den doppelten Teil am Dateiende entfernen; beim Ersetzen nur den betroffenen Bereich uebergeben.' },
    en: { lage: 'A piece of code appears twice at the end of the file.', wieso: 'A replacement or an append wrote the end of the file (closing braces, exports, last statements) a second time, e.g. because the replacement text already contained the rest of the file.', abhilfe: 'Remove the duplicated part at the end of the file; when replacing, pass only the affected range.' },
  },
  J1: {
    de: { lage: 'Komma nach dem letzten Eintrag eines JSON-Objekts oder -Arrays.', wieso: 'JSON erlaubt anders als JavaScript kein abschliessendes Komma; nach dem Komma erwartet der Parser einen weiteren Eintrag.', abhilfe: 'Das Komma nach dem letzten Eintrag entfernen.' },
    en: { lage: 'Comma after the last entry of a JSON object or array.', wieso: 'Unlike JavaScript, JSON allows no trailing comma; after the comma the parser expects another entry.', abhilfe: 'Remove the comma after the last entry.' },
  },
  J2: {
    de: { lage: 'Zwischen zwei JSON-Eintraegen fehlt das Komma.', wieso: 'Beim Einfuegen einer Eigenschaft wurde das Komma am Ende der vorherigen Zeile nicht ergaenzt.', abhilfe: 'Am Ende der Eigenschaft vor der gemeldeten Stelle ein Komma setzen.' },
    en: { lage: 'A comma between two JSON entries is missing.', wieso: 'When inserting a property, the comma at the end of the previous line was not added.', abhilfe: 'Put a comma at the end of the property before the reported position.' },
  },
  J3: {
    de: { lage: 'Einfache Anfuehrungszeichen in JSON.', wieso: 'JSON verlangt doppelte Anfuehrungszeichen fuer Schluessel und Strings; einfache sind JavaScript-Stil.', abhilfe: 'Einfache durch doppelte Anfuehrungszeichen ersetzen.' },
    en: { lage: 'Single quotes in JSON.', wieso: 'JSON requires double quotes for keys and strings; single quotes are JavaScript style.', abhilfe: 'Replace single quotes with double quotes.' },
  },
  S1: {
    de: { lage: 'Kommentar im JavaScript-Stil ("//") in SQL.', wieso: 'SQL kennt nur "--" und "/* */" als Kommentar; "//" wird als Operator gelesen. Steht das SQL in einem String im Programmcode, faellt es erst beim Ausfuehren auf.', abhilfe: '"//" durch "--" ersetzen.' },
    en: { lage: 'JavaScript-style comment ("//") in SQL.', wieso: 'SQL only knows "--" and "/* */" as comments; "//" is read as an operator. If the SQL is inside a string in program code, this only shows up at execution.', abhilfe: 'Replace "//" with "--".' },
  },
  S2: {
    de: { lage: 'Komma vor der schliessenden Klammer einer SQL-Liste (Spalten-, Werte- oder Argumentliste).', wieso: 'SQL erlaubt kein abschliessendes Komma; nach dem Komma erwartet der Parser eine weitere Spalte bzw. einen Ausdruck.', abhilfe: 'Das letzte Komma vor ")" entfernen.' },
    en: { lage: 'Comma before the closing parenthesis of an SQL list (column, value or argument list).', wieso: 'SQL allows no trailing comma; after the comma the parser expects another column or expression.', abhilfe: 'Remove the last comma before ")".' },
  },
};
export const ZURUECKGEHALTEN = ['K10', 'S3', 'X_escape', 'X_erfunden'];
/** E0-Familienkuerzel -> Pruefer-Familie (Name des Syntaxpruefers im Katalog). */
export const FAMILIE = { ts: 'typescript', json: 'json', sql: 'libpg-query' };
