/**
 * P15 Nachtrunde A (11.10.2026, Befund cdff55ea Punkt 6): Der Sammelhinweis der Fehlermuster-Auslieferung sagte bei
 * jeder von Jev gewaehlten Erklaerung pauschal "status vorgeschlagen = noch nicht verifiziert" - auch bei
 * verifizierten Treffern.
 *
 * ZUSAGEN:
 *   V  nur verifizierte Erklaerung: Hinweis nennt "verifiziert", NICHT "noch nicht verifiziert".
 *   O  nur vorgeschlagene Erklaerung: Hinweis nennt "vorgeschlagen = noch nicht verifiziert".
 *   M  gemischt (1 verifiziert + 1 vorgeschlagen): beide Teile mit Anzahl.
 *   F  offener Fall (ohne erklaerung) aendert den Status-Teil nicht (Fall-Text bleibt).
 *   ANKER: in jedem Fall kommt der Erklaerungs-Teil ueberhaupt (sonst waere "nicht enthalten" automatisch erfuellt).
 *
 * Kein PG-Zugriff (Auslieferung ist im Speicher). DB-Sperre wie bei allen Erklaerungs-Tests: nur synapse_test.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/erklaerung-hinweis-status.test.mjs   (core vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('erklaerung-hinweis-status.test');
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', PARSER_LOOP_DISABLED: '1', FEHLERMUSTER_WARTE_MS: '0' });

const hier = dirname(fileURLToPath(import.meta.url));
const A = await import(pathToFileURL(join(hier, '..', 'dist', 'services', 'fehlermuster-auslieferung.js')).href);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 800) : '')); }
}

let n = 0;
function erklaerung(agent, status) {
  n++;
  A.vormerkenErklaerung(agent, `probe/datei-${n}.ts`, {
    pattern_id: `erklaerung:${n}`, severity: 'warning', datei: `probe/datei-${n}.ts`,
    was: 'Lage', wie: 'Abhilfe', quelle: 'erklaerung',
    erklaerung: { id: String(n), status, confidence: 0.9, sprachen: { de: {}, en: {} } },
  });
}
function fall(agent) {
  n++;
  A.vormerkenErklaerung(agent, `probe/fall-${n}.ts`, {
    pattern_id: `erklaerung-fall:${n}`, severity: 'warning', datei: `probe/fall-${n}.ts`,
    was: 'Fall', wie: 'code_check(erklaerung_ablegen)', quelle: 'erklaerung',
  });
}
const NICHT_VERIF = 'noch nicht verifiziert';

// V nur verifiziert
erklaerung('t-v', 'verifiziert');
let h = await A.holeFehlermusterHinweise('t-v');
pruefe(/Erklaerung\(en\) aus dem Erklaerungs-Topf/.test(h?.hinweis ?? ''), 'V ANKER Erklaerungs-Teil vorhanden', h?.hinweis);
pruefe(/verifiziert/.test(h?.hinweis ?? '') && !(h?.hinweis ?? '').includes(NICHT_VERIF), 'V verifiziert ohne "noch nicht verifiziert"', h?.hinweis);

// O nur vorgeschlagen
erklaerung('t-o', 'vorgeschlagen');
h = await A.holeFehlermusterHinweise('t-o');
pruefe(/Erklaerung\(en\) aus dem Erklaerungs-Topf/.test(h?.hinweis ?? ''), 'O ANKER Erklaerungs-Teil vorhanden', h?.hinweis);
pruefe((h?.hinweis ?? '').includes('vorgeschlagen') && (h?.hinweis ?? '').includes(NICHT_VERIF), 'O vorgeschlagen = noch nicht verifiziert', h?.hinweis);

// M gemischt
erklaerung('t-m', 'verifiziert');
erklaerung('t-m', 'vorgeschlagen');
h = await A.holeFehlermusterHinweise('t-m');
pruefe(/^2 Erklaerung\(en\)/.test(h?.hinweis ?? ''), 'M ANKER 2 Erklaerungen gezaehlt', h?.hinweis);
pruefe(/1 verifiziert/.test(h?.hinweis ?? '') && /1 vorgeschlagen/.test(h?.hinweis ?? ''), 'M gemischt: 1 verifiziert + 1 vorgeschlagen', h?.hinweis);

// F Fall neben verifizierter Erklaerung
erklaerung('t-f', 'verifiziert');
fall('t-f');
h = await A.holeFehlermusterHinweise('t-f');
pruefe(/1 offene\(r\) Erklaerungsfall/.test(h?.hinweis ?? ''), 'F ANKER Fall-Text vorhanden', h?.hinweis);
pruefe(!(h?.hinweis ?? '').includes(NICHT_VERIF) && /^1 Erklaerung\(en\)/.test(h?.hinweis ?? ''), 'F Fall aendert den Status-Teil nicht', h?.hinweis);

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
