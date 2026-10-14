/**
 * P15 Logpflege (11.10.2026): 'PG→FS Skip' je Datei und Grund nur EINMAL (Befund 929b5b10, FIX-1).
 *
 * BEFUND: Der PG->FS-Poller (alle 2 s) meldete fuer jede Zeile mit fremdem Plattenstand in JEDER Runde
 * dieselbe Logzeile und hielt den Checkpoint vor der Zeile zurueck. Fuer Pfade, die der Watcher nie
 * einsammelt (.gitignore/ausgeblendet, Binaer), kam das Einsammeln nie -> 15 Mio Zeilen im daemon.log.
 * User-Entscheidung 11.10.: Watcher NICHT umbauen, solche Pfade werden weiter nicht abgeglichen.
 *
 * ZUSAGEN (echter Watcher + Poller gegen die Test-DB):
 *   K1 gitignorierter Pfad mit fremdem Plattenstand: genau EINE Skip-Zeile ueber mehrere Runden.
 *   K2 einsammelbarer Pfad mit fremdem Plattenstand (Watcher-Callback hier leer): ebenfalls genau EINE Zeile.
 *   K3 Platte unveraendert (kein Ueberschreiben, Schutz SYNC-1 bleibt).
 *   K4 P6-T41: Ueberlappung/Vollabgleich pruefen auch gitignorierte Pfade erneut.
 *      Ein neuer Plattenstand meldet sich je Pfad genau einmal, unveraenderter Stand bleibt still.
 *   K5 Aenderung in PG (neuer Inhalt) -> genau eine neue Zeile fuer den gitignorierten Pfad.
 *   K6 Positivkontrolle Sync: eine neue PG-Zeile ohne Plattendatei wird geschrieben (Poller arbeitet).
 * POSITIVKONTROLLE: am Stand vor dem Fix zaehlt K1/K2 eine Zeile je Runde (> 1) -> FEHL.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama hart auf 127.0.0.1:9.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/pgfs-skip-einmal.test.mjs
 * Braucht gebautes packages/core/dist.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('pgfs-skip-einmal.test');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.DEBOUNCE_MS = '200';

const hier = dirname(fileURLToPath(import.meta.url));
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const core = await lade(hier, '..', 'dist', 'index.js');
const watcherMod = await lade(hier, '..', 'dist', 'watcher', 'index.js');

const PROJECT = 'zz-pgfs-skip-einmal';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = core.getPool();

let fehler = 0;
const pruefe = (bed, text, detail) => {
  if (bed) console.log(`OK   ${text}`);
  else { fehler++; console.log(`FEHL ${text}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
};

// Logzeilen des Pollers mitschneiden (console.error), weiter ausgeben fuer die Fehlersuche.
const zeilen = [];
const original = console.error.bind(console);
console.error = (...args) => { zeilen.push(args.map(String).join(' ')); original(...args); };
const skips = (pfad) => zeilen.filter((z) => z.includes('PG→FS Skip') && z.endsWith(pfad)).length;

const wurzel = fs.mkdtempSync(join(os.tmpdir(), 'pgfs-skip-'));
const IGN = 'cache/x.txt';
const SAMMEL = 'src/y.txt';
const NEU = 'src/neu.txt';

async function pgZeile(pfad, inhalt) {
  await pool.query(
    `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'txt', $4, $5, $6, NOW())`,
    [PROJECT, pfad, pfad.split('/').pop(), inhalt, sha(inhalt), Buffer.byteLength(inhalt)]
  );
}
async function aufraeumen() {
  await pool.query('DELETE FROM code_files WHERE project = $1', [PROJECT]);
  await pool.query('DELETE FROM file_versions WHERE project = $1', [PROJECT]);
}

let watcher = null;
try {
  await aufraeumen();
  fs.writeFileSync(join(wurzel, '.gitignore'), 'cache/\n');
  fs.mkdirSync(join(wurzel, 'cache'), { recursive: true });
  fs.mkdirSync(join(wurzel, 'src'), { recursive: true });
  fs.writeFileSync(join(wurzel, IGN), 'PLATTE-A\n');
  fs.writeFileSync(join(wurzel, SAMMEL), 'PLATTE-B\n');
  await pgZeile(IGN, 'PG-A\n');
  await pgZeile(SAMMEL, 'PG-B\n');

  let bereit;
  const fertig = new Promise((r) => (bereit = r));
  watcher = watcherMod.startFileWatcher({
    projectPath: wurzel,
    projectName: PROJECT,
    onFileChange: async () => { /* bewusst leer: der Watcher sammelt in diesem Test nichts ein */ },
    onError: () => {},
    onReady: () => bereit(),
  });
  await fertig;
  await schlaf(9000); // >= 4 Runden zu 2 s

  pruefe(skips(IGN) === 1, `K1 gitignorierter Pfad: genau 1 Skip-Zeile in ~4 Runden (gezaehlt ${skips(IGN)})`);
  pruefe(skips(SAMMEL) === 1, `K2 einsammelbarer Pfad: genau 1 Skip-Zeile in ~4 Runden (gezaehlt ${skips(SAMMEL)})`);
  pruefe(
    fs.readFileSync(join(wurzel, IGN), 'utf8') === 'PLATTE-A\n' && fs.readFileSync(join(wurzel, SAMMEL), 'utf8') === 'PLATTE-B\n',
    'K3 Plattenstand beider Dateien unveraendert'
  );

  // K4: Platte erneut fremd aendern.
  fs.writeFileSync(join(wurzel, IGN), 'PLATTE-A2\n');
  fs.writeFileSync(join(wurzel, SAMMEL), 'PLATTE-B2\n');
  await schlaf(5000);
  pruefe(skips(IGN) === 2, `K4 Ueberlappung meldet neuen Plattenstand einmal (gezaehlt ${skips(IGN)})`);
  pruefe(skips(SAMMEL) === 2, `K4 einsammelbarer Pfad (zurueckgestellt) meldet den neuen Plattenstand einmal (gezaehlt ${skips(SAMMEL)})`);

  // K5: Aenderung in PG.
  await pool.query(
    `UPDATE code_files SET content = $3, content_hash = $4, updated_at = NOW() WHERE project = $1 AND file_path = $2`,
    [PROJECT, IGN, 'PG-A2\n', sha('PG-A2\n')]
  );
  await schlaf(7000);
  pruefe(skips(IGN) === 3, `K5 nach Aenderung in PG genau 1 neue Zeile (gezaehlt ${skips(IGN)})`);
  pruefe(fs.readFileSync(join(wurzel, IGN), 'utf8') === 'PLATTE-A2\n', 'K5 Platte weiter unveraendert');

  // K6: Positivkontrolle, der Poller schreibt noch.
  await pgZeile(NEU, 'NEU\n');
  const ende = Date.now() + 10000;
  while (Date.now() < ende && !fs.existsSync(join(wurzel, NEU))) await schlaf(200);
  pruefe(fs.existsSync(join(wurzel, NEU)) && fs.readFileSync(join(wurzel, NEU), 'utf8') === 'NEU\n', 'K6 neue PG-Zeile landet auf der Platte');
} finally {
  try { await watcher?.stop(); } catch { /* egal */ }
  try { await aufraeumen(); } catch { /* egal */ }
  fs.rmSync(wurzel, { recursive: true, force: true });
  console.error = original;
  console.log(fehler === 0 ? 'ERGEBNIS: alle Zusagen OK' : `ERGEBNIS: ${fehler} FEHL`);
  try { await pool.end(); } catch { /* egal */ }
  process.exit(fehler === 0 ? 0 : 1);
}
