// P16-T5 E3b (11.10.2026): Positivkontrolle der Container-Pruefer durch MUTATIONEN echter Index-Dateien.
// Liest code_files NUR LESEND (default_transaction_read_only) aus DATABASE_URL, nimmt je Sprache N gueltige Dateien
// (das Original muss ohne harten Befund bleiben = Anker), baut je Datei zwei Fehler ein und zaehlt, wie viele der
// Container meldet - mit der erwarteten Zeile, wo sie feststeht.
//   M1 "klammer-fehlt": die letzte Zeile, die nur aus '}' besteht, wird entfernt (Meldung meist am Dateiende).
//   M2 "ausdruck-fehlt": nach der ersten Zeile, die auf '{' endet, wird eine Zuweisung ohne Wert eingefuegt
//      (Kotlin 'val x = )', Java 'int x = ;'), erwartete Zeile = Einfuegestelle.
// Am alten Image (ohne die Sprache) muss alles 'unerkannt' sein (Antwort 'keine Pruefung fuer Sprache').
//
// Aufruf:  node packages/rest-api/tests/pruef-container-mutation.mjs <kotlin|java> [anzahl=5]
// Env:     DATABASE_URL (Pflicht), PRUEFCONTAINER_TEST_IMAGE (Standard synapse-pruefcontainer:latest),
//          ZUSATZ_DATEI=<pfad> optional: eine weitere (kaputte) Datei, deren erste Meldung ausgegeben wird
//          (z. B. gemma kotlin_3.kt, erwartet 117:39).
// Exit 0 = alle Mutationen erkannt und alle Originale ohne Befund, 1 = sonst.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Docker from 'dockerode';
import { PruefContainer, pruefContainerConfigAusEnv, CONTAINER_SPRACHEN } from '../dist/services/pruef-container.js';

const pg = createRequire(new URL('../../core/package.json', import.meta.url))('pg');
const [sprache = 'kotlin', anzahlRoh = '5'] = process.argv.slice(2);
// P16-T11: nicht angemeldete Container-Sprachen (tree-sitter-Module mit modus 'aus') per ENDUNGEN=c,h messbar.
const def = CONTAINER_SPRACHEN.find((s) => s.sprache === sprache)
  ?? (process.env.ENDUNGEN ? { sprache, endungen: process.env.ENDUNGEN.split(',') } : undefined);
if (!def) { console.error(`unbekannte Sprache ${sprache}`); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL fehlt'); process.exit(2); }
const EINFUEGUNG = {
  kotlin: 'val mutation = )', java: 'int mutation = ;',
  // P16-T11 tree-sitter
  csharp: 'int mutation = ;', dart: 'var mutation = ;', swift: 'let mutation = )',
  c: 'int mutation = ;', cpp: 'int mutation = ;', objc: 'int mutation = ;',
};
if (!EINFUEGUNG[sprache]) { console.error(`keine Mutationen fuer ${sprache}`); process.exit(2); }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query('SET default_transaction_read_only = on');
const r = await c.query(
  `SELECT project, file_path, content FROM code_files
    WHERE deleted_at IS NULL AND content IS NOT NULL AND file_path LIKE ANY($1)
      AND length(content) BETWEEN 500 AND 30000 AND file_path NOT LIKE '%/neg/%'
    ORDER BY md5(project || file_path) LIMIT 200`, [def.endungen.map((e) => `%.${e}`)]);
await c.end();

const pc = new PruefContainer(new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' }), {
  ...pruefContainerConfigAusEnv(),
  image: process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest',
  name: 'synapse-pruefcontainer-mutation',
  cacheEintraege: 0,
  timeoutMs: 20_000,
});

async function pruefe(inhalt, pfad) {
  try {
    return { meldungen: (await pc.pruefe(sprache, inhalt, pfad)).filter((m) => !m.weich) };
  } catch (e) {
    return { fehler: e.message, meldungen: [] };
  }
}

let erkannt = 0, faelle = 0, originaleMitBefund = 0, genommen = 0;
try {
  for (const z of r.rows) {
    if (genommen >= Number(anzahlRoh)) break;
    const L = z.content.replace(/\r\n/g, '\n').split('\n');
    const zu = L.map((x) => x.trim()).lastIndexOf('}');
    const auf = L.findIndex((x, i) => i > 0 && x.trimEnd().endsWith('{'));
    if (zu < 0 || auf < 0) continue;
    const o = await pruefe(z.content, z.file_path);
    if (o.meldungen.length) {
      originaleMitBefund++;
      console.log(`ORIGINAL MIT BEFUND Z.${o.meldungen[0].zeile} ${o.meldungen[0].meldung}\t${z.project}:${z.file_path}`);
      continue;
    }
    // Pruefer nicht verfuegbar (z. B. altes Image ohne die Sprache): Datei trotzdem nehmen, die Mutationen
    // zaehlen dann als unerkannt - genau das ist die rote Kontrolle am alten Stand.
    if (o.fehler) { originaleMitBefund++; console.log(`ORIGINAL FEHLER ${o.fehler}\t${z.project}:${z.file_path}`); }
    genommen++;
    const m1 = [...L]; m1.splice(zu, 1);
    const m2 = [...L]; m2.splice(auf + 1, 0, EINFUEGUNG[sprache]);
    for (const [name, inhalt, zeile] of [['klammer-fehlt', m1.join('\n'), null], ['ausdruck-fehlt', m2.join('\n'), auf + 2]]) {
      faelle++;
      const e = await pruefe(inhalt, z.file_path);
      const b = e.meldungen[0];
      const ok = !!b && (zeile === null || b.zeile === zeile);
      if (ok) erkannt++;
      console.log(`${ok ? 'ERKANNT' : 'unerkannt'}\t${name}\t${z.project}:${z.file_path}\t${b ? `Z.${b.zeile}:${b.spalte ?? '?'}${zeile ? ` (erwartet ${zeile})` : ''} ${b.meldung}` : e.fehler ?? 'kein Befund'}`);
    }
  }
  if (process.env.ZUSATZ_DATEI) {
    const inhalt = readFileSync(process.env.ZUSATZ_DATEI, 'utf8');
    const e = await pruefe(inhalt, process.env.ZUSATZ_DATEI);
    const b = e.meldungen[0];
    console.log(`ZUSATZ ${process.env.ZUSATZ_DATEI}: ${b ? `Z.${b.zeile}:${b.spalte ?? '?'} ${b.meldung} | Zeile: ${inhalt.split('\n')[b.zeile - 1]?.trim()}` : e.fehler ?? 'kein Befund'}`);
  }
  console.log(`SUMME ${sprache}: ${erkannt}/${faelle} erkannt, ${genommen} Dateien, Originale mit Befund/Fehler ${originaleMitBefund}`);
  process.exitCode = erkannt === faelle && faelle > 0 ? 0 : 1;
} finally {
  await pc.beenden();
}
