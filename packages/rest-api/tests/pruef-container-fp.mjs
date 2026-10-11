// P16-T5 (11.10.2026): Falsch-Positiv-Messung der Container-Pruefer (Stufe S3) gegen echte Index-Dateien.
// Liest code_files NUR LESEND (default_transaction_read_only) aus DATABASE_URL und schickt jede Datei durch den
// Pruef-Container (lokal gebautes Image). Jede Meldung ist ein Kandidat fuer einen Fehlalarm und wird mit Projekt,
// Pfad, Zeile und Meldung ausgegeben. Gleichzeitig Positivkontrolle (Anker, damit "0 Meldungen" etwas bedeutet):
// die kleinste Datei mit angehaengter Zeile ")}] ((( {{{ [[[" MUSS gemeldet werden, sonst Exit 2.
//
// Aufruf:  node packages/rest-api/tests/pruef-container-fp.mjs [sprache=rust|python|shell|go|php|ruby|lua] [max=2000]
// Weiche Meldungen (weich:true, sperren nie) werden getrennt gezaehlt und gelistet; nur harte zaehlen als Fehlalarm.
// Env:     DATABASE_URL (Pflicht), PRUEFCONTAINER_TEST_IMAGE (Standard synapse-pruefcontainer:latest)
// Ausgabe: Zusammenfassung + je Meldung eine Zeile; Exit 0 = keine Meldung, 1 = Meldungen, 2 = Kontrolle versagt.
import { createRequire } from 'node:module';
import Docker from 'dockerode';
import { PruefContainer, pruefContainerConfigAusEnv, CONTAINER_SPRACHEN } from '../dist/services/pruef-container.js';

// pg ist eine Abhaengigkeit von core, nicht von rest-api.
const pg = createRequire(new URL('../../core/package.json', import.meta.url))('pg');

const [sprache = 'rust', maxRoh = '2000'] = process.argv.slice(2);
const def = CONTAINER_SPRACHEN.find((s) => s.sprache === sprache);
if (!def) { console.error(`unbekannte Sprache ${sprache}; bekannt: ${CONTAINER_SPRACHEN.map((s) => s.sprache).join(', ')}`); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL fehlt'); process.exit(2); }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query('SET default_transaction_read_only = on');
const muster = def.endungen.map((e) => `%.${e}`);
const r = await c.query(
  `SELECT project, file_path, content FROM code_files
    WHERE deleted_at IS NULL AND content IS NOT NULL AND file_path LIKE ANY($1)
      AND length(content) BETWEEN 50 AND 200000
    ORDER BY md5(project || file_path) LIMIT $2`, [muster, Number(maxRoh)]);
await c.end();

const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });
const pc = new PruefContainer(docker, {
  ...pruefContainerConfigAusEnv(),
  image: process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest',
  name: 'synapse-pruefcontainer-fp',
  cacheEintraege: 0,
  timeoutMs: 20_000,
});

const projekte = new Map();
const treffer = [];
const weich = [];
const zeiten = [];
let fehler = 0;
try {
  for (const z of r.rows) {
    projekte.set(z.project, (projekte.get(z.project) ?? 0) + 1);
    const t = performance.now();
    try {
      const m = await pc.pruefe(sprache, z.content, z.file_path);
      const hart = m.filter((x) => !x.weich);
      if (hart.length > 0) treffer.push({ projekt: z.project, pfad: z.file_path, ...hart[0] });
      else if (m.length > 0) weich.push({ projekt: z.project, pfad: z.file_path, ...m[0] });
    } catch (e) {
      fehler++;
      console.error(`FEHLER ${z.project}:${z.file_path}: ${e.message}`);
    }
    zeiten.push(performance.now() - t);
  }
  // Positivkontrolle
  const kleinste = r.rows.reduce((a, b) => (a && a.content.length <= b.content.length ? a : b), null);
  // PHP: nach einem schliessenden ?> waere die Zeile HTML-Text - deshalb dort mit eigenem <?php-Block.
  const anhang = sprache === 'php' ? '\n<?php )}] ((( {{{ [[[\n' : '\n)}] ((( {{{ [[[\n';
  const kontrolle = kleinste ? (await pc.pruefe(sprache, kleinste.content + anhang, 'kontrolle')).filter((x) => !x.weich) : [];
  zeiten.sort((a, b) => a - b);
  const p = (q) => (zeiten.length ? zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * q))].toFixed(1) : '-');
  console.log(`sprache ${sprache}: ${r.rows.length} Dateien, Meldungen ${treffer.length}, weich ${weich.length}, Fehler ${fehler}, Kontrolle ${kontrolle.length > 0 ? 'erkannt' : 'NICHT erkannt'}`);
  console.log(`zeit je Datei (warm, inkl. attach) p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms`);
  console.log(`projekte: ${[...projekte].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const t of treffer) console.log(`MELDUNG ${t.projekt}:${t.pfad} Z.${t.zeile}:${t.spalte ?? '?'} ${t.meldung}`);
  for (const t of weich) console.log(`WEICH ${t.projekt}:${t.pfad} Z.${t.zeile}:${t.spalte ?? '?'} ${t.meldung}`);
  process.exitCode = kontrolle.length === 0 ? 2 : treffer.length > 0 ? 1 : 0;
} finally {
  await pc.beenden();
}
