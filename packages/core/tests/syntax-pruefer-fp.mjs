/**
 * P16-T4 FALSCH-POSITIV-TEST der Syntaxpruefer (Stufe 1) an echten, gueltigen Index-Dateien.
 * Liest code_files (NUR SELECT) - Live-DB ist erlaubt, es wird nichts geschrieben.
 * Je Endung bis LIMIT Dateien (Arbeitsprojekte zuerst, parser-testkorpus zuletzt, deterministisch per md5).
 * Jede Meldung ist ein Fehlalarm-Kandidat und wird mit Datei, Zeile, Spalte, Meldung ausgegeben;
 * die Pruefung, ob die Datei wirklich gueltig ist, macht der Mensch/Agent (Ausgabe FP-KANDIDAT).
 * AUFRUF: node packages/core/tests/syntax-pruefer-fp.mjs [pruefer,pruefer] [LIMIT=40]
 * Ausgabe-Ende: ERGEBNIS {pruefer: {dateien, meldungen, p50_ms, p95_ms}}
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const hier = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(hier, '..', 'package.json'));
const pg = require('pg');
const K = await import(pathToFileURL(join(hier, '..', 'dist', 'services', 'syntax-pruefer', 'katalog.js')).href);

const filter = process.argv[2] && process.argv[2] !== 'alle' ? process.argv[2].split(',') : null;
const LIMIT = Number(process.argv[3] ?? 40);
const defs = K.katalog().filter((d) => !d.name.startsWith('zz-') && (!filter || filter.includes(d.name)));
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query('SET default_transaction_read_only = on');
const p = (w, q) => { const s = [...w].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] * 100) / 100 : null; };
const ergebnis = {};
try {
  for (const def of defs) {
    const zeiten = [];
    let dateien = 0;
    let meldungen = 0;
    for (const e of def.endungen) {
      const r = await c.query(
        `SELECT project, file_path, content FROM code_files
          WHERE deleted_at IS NULL AND coalesce(ignored, false) = false AND content IS NOT NULL
            AND file_size BETWEEN 50 AND 200000 AND lower(file_path) LIKE $1
            AND file_path NOT LIKE '%node_modules/%'
          ORDER BY (project = 'parser-testkorpus'), md5(project || file_path) LIMIT $2`, [`%.${e}`, LIMIT]);
      for (const row of r.rows) {
        const t0 = performance.now();
        let m;
        try { m = def.pruefe(row.content, row.file_path); } catch (err) { m = [{ zeile: 0, meldung: 'WIRFT: ' + err.message }]; }
        zeiten.push(performance.now() - t0);
        dateien++;
        if (m.length) {
          meldungen++;
          console.log(`FP-KANDIDAT ${def.name} ${row.project}:${row.file_path}:${m[0].zeile}:${m[0].spalte ?? ''} ${m[0].code ?? ''} ${m[0].meldung}`);
        }
      }
    }
    ergebnis[def.name] = { dateien, meldungen, p50_ms: p(zeiten, 0.5), p95_ms: p(zeiten, 0.95) };
    console.log(def.name, JSON.stringify(ergebnis[def.name]));
  }
  console.log('ERGEBNIS ' + JSON.stringify(ergebnis));
} finally {
  await c.end();
}
