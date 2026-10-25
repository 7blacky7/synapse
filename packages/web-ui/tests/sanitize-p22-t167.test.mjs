/**
 * P22-T167: reine Logik der Bereinigung (Erlaubnisliste nach Normalisierung, SVG-Animationen auf URL-Attribute).
 * Bewusst nur harmlose Marker (x-test:, ftp:, ma&#9;ilto) – sie belegen die Logik, nicht einen Angriff.
 * Aufruf: node --experimental-strip-types packages/web-ui/tests/sanitize-p22-t167.test.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const S = await import(pathToFileURL(join(hier, '..', 'src', 'kios', 'sanitize.ts')).href);
let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info) : '')); } };

// Erlaubnisliste
check(['https://a.b/c', 'http://x', 'mailto:a@b.c', 'tel:+49', '/pfad', 'rel/datei.html', '#anker', '?q=1', ''].every((u) => S.urlErlaubt(u)), 'erlaubt: http/https/mailto/tel, relativ, #, ?, leer');
check(['x-test:abc', 'unbekannt:1', 'ftp://host/datei', 'data:text/plain,hallo'].every((u) => !S.urlErlaubt(u)), 'entfernt: unbekannte Schemata und data: ausser Bild');
check(S.urlErlaubt('data:image/png;base64,AAAA', true) && !S.urlErlaubt('data:image/png;base64,AAAA', false) && !S.urlErlaubt('data:image/svg+xml,<svg/>', true), 'data:image nur fuer Bildquellen, kein svg');
check(S.urlErlaubt('rel/pfad:mit-doppelpunkt'), 'Doppelpunkt nach Schraegstrich ist relativ');

// Normalisierung VOR der Pruefung (Steuerzeichen/Whitespace wie der URL-Parser, Grossschreibung)
check(S.normalisiereUrl(' MA\tI\nLTO:a') === 'mailto:a', 'normalisiereUrl entfernt Steuerzeichen und schreibt klein');
check(S.urlErlaubt('ma\tilto:a@b.c') && S.urlErlaubt('HTTPS://A.B'), 'erlaubtes Schema mit Steuerzeichen/Grossschreibung bleibt erlaubt');
check(!S.urlErlaubt('x-\ttest:abc') && !S.urlErlaubt('x\u0000-test:abc') && !S.urlErlaubt('\u0001x-test:abc') && !S.urlErlaubt('X-TEST:abc'), 'unbekanntes Schema mit eingestreuten Steuerzeichen bzw. Grossschreibung wird erkannt und entfernt');
// Beleg 'vorher': die alte Pruefung (startsWith eines festen Worts nach trim) haette ein Schema mit eingestreutem Tab nicht erkannt.
const alt = (wert, wort) => wert.trim().toLowerCase().startsWith(wort);
check(!alt('x-\ttest:abc', 'x-test:') && !S.urlErlaubt('x-\ttest:abc'), 'vorher/nachher: alte Wortpruefung verfehlt eingestreuten Tab, neue Pruefung greift');

// srcset je Eintrag
check(S.srcsetErlaubt('a.png 1x, https://b/c.png 2x') && !S.srcsetErlaubt('a.png 1x, x-test:b 2x'), 'srcset: jeder Eintrag geprueft');

// SVG-Animationen
check(S.istUrlAnimation('animate', 'href') && S.istUrlAnimation('set', 'xlink:href') && S.istUrlAnimation('SET', 'HR\tEF') && S.istUrlAnimation('animate', 'onbegin'), 'Animationen auf href/xlink:href/on* erkannt (auch mit Steuerzeichen/Grossschreibung)');
check(!S.istUrlAnimation('animate', 'opacity') && !S.istUrlAnimation('rect', 'href') && !S.istUrlAnimation('animate', null), 'Animation auf opacity bzw. normale Elemente bleiben');

console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
