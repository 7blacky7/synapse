#!/usr/bin/env node
/**
 * MESSWERKZEUG: Parser gegen echtes Material, vor und nach einer Aenderung.
 *
 * ZWECK: Wer einen Parser aendert, muss VOR dem Deploy beweisen, dass es besser
 * geworden ist — und dass nichts anderes kaputtging. Bisher hat jeder sein eigenes
 * Wegwerfskript gebaut; die Zahlen waren dadurch nicht vergleichbar und der
 * Fundstellen-Abgleich fiel regelmaessig unter den Tisch.
 *
 * ⚠️ DAS SKRIPT IST DAS WERKZEUG, NICHT DER BEWEIS. Es misst gegen das gebaute
 * dist, umgeht also den Index und jede Stale-Falle — aber es prueft NICHT, ob die
 * gefundenen Stellen inhaltlich richtig sind. Dafuer ist --pruefe da, und dafuer
 * muss man am Ende in die Quelldatei sehen. Ein Skript, das sich selbst bestaetigt,
 * hat noch gar nichts gezeigt.
 *
 * AUFRUF:
 *   node scripts/parser-massentest.mjs <parser> <wurzel> <endungen> [--pruefe]
 *   node scripts/parser-massentest.mjs jsonnet /pfad/zum/repo .jsonnet,.libsonnet
 *
 * --pruefe gleicht jede gefundene Stelle gegen ihre Quellzeile ab und meldet,
 * wie viele auf einer Kommentarzeile gelandet sind. Bei jeder Aenderung, die eine
 * Zahl ERHOEHT, ist das Pflicht: eine sinkende Zahl prueft jeder nach, eine
 * steigende niemand.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, extname, basename } from 'path';

const [modul, wurzel, endungCsv, ...rest] = process.argv.slice(2);
if (!modul || !wurzel || !endungCsv) {
  console.error('Aufruf: node scripts/parser-massentest.mjs <parser> <wurzel> <endungen> [--pruefe]');
  process.exit(2);
}
const pruefe = rest.includes('--pruefe');
const endungen = endungCsv.split(',').map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase());

const mod = await import(new URL(`../packages/core/dist/parser/${modul}.js`, import.meta.url).href);
let parser = null;
for (const w of Object.values(mod)) {
  if (w && typeof w === 'object' && typeof w.parse === 'function') { parser = w; break; }
}
if (!parser) {
  console.error(`Kein Parser-Objekt in ${modul}.js. Exporte: ${Object.keys(mod).join(', ')}`);
  process.exit(1);
}

function* dateien(dir) {
  let eintraege;
  try { eintraege = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of eintraege) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') yield* dateien(p); }
    else if (endungen.includes(extname(e.name).toLowerCase())) yield p;
  }
}

let n = 0, zeilen = 0, symbole = 0, funktionen = 0, statements = 0, calls = 0;
let abstuerze = 0, msGesamt = 0;
const proTyp = {}, proStmtTyp = {};
const ohneStatements = [];
// Nur fuer --pruefe:
let geprueft = 0, falscheZeile = 0, inKommentar = 0;
const abweichungen = [];

for (const d of dateien(wurzel)) {
  let inhalt;
  try { inhalt = readFileSync(d, 'utf8'); } catch { continue; }
  const quellzeilen = inhalt.split('\n');
  const t0 = performance.now();
  let r;
  try { r = parser.parse(inhalt, d); }
  catch (e) { abstuerze++; console.error(`ABSTURZ ${d}: ${e.message}`); continue; }
  msGesamt += performance.now() - t0;

  const sym = r?.symbols ?? [];
  const stm = r?.statements ?? [];
  const cal = r?.callEdges ?? r?.calls ?? [];
  n++; zeilen += quellzeilen.length; symbole += sym.length; statements += stm.length; calls += cal.length;
  for (const s of sym) {
    const t = s.symbol_type ?? '?';
    proTyp[t] = (proTyp[t] ?? 0) + 1;
    if (t === 'function') funktionen++;
  }
  for (const s of stm) proStmtTyp[s.statement_type ?? '?'] = (proStmtTyp[s.statement_type ?? '?'] ?? 0) + 1;
  if (stm.length === 0 && quellzeilen.length > 100 && ohneStatements.length < 8) {
    ohneStatements.push(`${d.replace(wurzel, '')} (${quellzeilen.length} Zeilen)`);
  }

  if (pruefe) {
    for (const s of [...sym, ...stm]) {
      const nr = s.line_start;
      if (!nr || nr < 1 || nr > quellzeilen.length) {
        falscheZeile++; geprueft++;
        if (abweichungen.length < 6) abweichungen.push(`${basename(d)} Z${nr}: Zeile existiert nicht`);
        continue;
      }
      geprueft++;
      const q = quellzeilen[nr - 1].trim();
      if (q.startsWith('//') || q.startsWith('*') || q.startsWith('#') || q.startsWith('--')) {
        inKommentar++;
        if (abweichungen.length < 6) abweichungen.push(`${basename(d)} Z${nr} in Kommentarzeile: ${q.slice(0, 60)}`);
      }
    }
  }
}

const je = v => (zeilen ? ((1000 * v) / zeilen).toFixed(1) : '0');
console.log(JSON.stringify({
  parser: modul, version: parser.version ?? 1,
  dateien: n, zeilen, abstuerze,
  symbole, funktionen, statements, calls,
  symbole_je_kZeilen: je(symbole), stmt_je_kZeilen: je(statements), calls_je_kZeilen: je(calls),
  symbole_nach_typ: proTyp,
  statements_nach_typ: proStmtTyp,
  dateien_ueber_100_zeilen_ohne_statements: ohneStatements.length,
  beispiele: ohneStatements,
  ms_gesamt: Math.round(msGesamt),
}, null, 2));

if (pruefe) {
  console.log('\n--- Fundstellen-Abgleich gegen die Quellzeilen ---');
  console.log(`geprueft: ${geprueft}`);
  console.log(`Zeilennummer zeigt ins Leere: ${falscheZeile}`);
  console.log(`auf einer Kommentarzeile:     ${inKommentar}`);
  if (abweichungen.length) console.log(abweichungen.map(a => '  ' + a).join('\n'));
  console.log('\nDAS ERSETZT NICHT DEN BLICK IN DIE DATEI: nimm mindestens eine Quelle, deren');
  console.log('Sollwert du vollstaendig kennst, und vergleiche Feld fuer Feld.');
}
