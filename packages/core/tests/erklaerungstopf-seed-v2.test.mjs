/**
 * P15 Nachtrunde C (11.10.2026): STARTBESTAND v2 des Erklaerungs-Topfs. Fall 16 (python) zeigte, dass der Seed nur
 * typescript/json/libpg-query abdeckte; fuer jede andere Familie ging Jev leer aus (keine_kandidaten).
 *
 * ZUSAGEN:
 *   F  Eintraege mit v2:true fuer python, shell, go, rust, php, ruby, kotlin, java, csharp, yaml, toml, dockerfile,
 *      cmake - je Familie 2 bis 4.
 *   N  Jede v2-Familie ist der Name eines angemeldeten Syntaxpruefers (Container-Sprache der API oder core-Katalog),
 *      sonst bekaeme der Pruefer-Befund (familieVon) die Erklaerungen nie. ANKER: ein falscher Name faellt auf.
 *   G  Jeder Eintrag besteht pruefeSeedEintrag (de+en, Laenge, Generik). ANKER: Pfad + Zeilenangabe werden erkannt.
 *   S  verifiziert nur mit Messbeleg "richtig 3/3" (echter Pruefer + Jev), sonst vorgeschlagen.
 *   L  Laden idempotent: 1. Lauf legt alle v2-Eintraege an (Status laut Seed), 2. Lauf 0 neu.
 *
 * Nur synapse_test (sonst Exit 2). Angelegte Zeilen werden danach geloescht (nur die, die vorher nicht da waren).
 * SEED_DATEI=<pfad> (optional) prueft eine andere Seed-Datei, z. B. den alten Stand fuer die Positivkontrolle.
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/erklaerungstopf-seed-v2.test.mjs   (core + rest-api vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', PARSER_LOOP_DISABLED: '1' });

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...p) => import(pathToFileURL(join(dist, ...p)).href);
const E = await lade('services', 'erklaerungen.js');
const K = await lade('services', 'syntax-pruefer', 'katalog.js');
const { getPool } = await lade('db', 'client.js');
const { CONTAINER_SPRACHEN } = await import(pathToFileURL(join(hier, '..', '..', 'rest-api', 'dist', 'services', 'pruef-container.js')).href);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 800) : '')); }
}

const seedDatei = process.env.SEED_DATEI || E.erklaerungstopfSeedPfad();
const seed = JSON.parse(readFileSync(seedDatei, 'utf8'));
const v2 = seed.eintraege.filter((e) => e.v2 === true);
const FAMILIEN = ['python', 'shell', 'go', 'rust', 'php', 'ruby', 'kotlin', 'java', 'csharp', 'yaml', 'toml', 'dockerfile', 'cmake'];

// ── F Familien ──
const jeFamilie = Object.fromEntries(FAMILIEN.map((f) => [f, v2.filter((e) => e.familie === f).length]));
pruefe(FAMILIEN.every((f) => jeFamilie[f] >= 2 && jeFamilie[f] <= 4), 'F je Familie 2 bis 4 v2-Erklaerungen (13 Familien)', jeFamilie);
pruefe(v2.every((e) => FAMILIEN.includes(e.familie)), 'F keine v2-Erklaerung ausserhalb der 13 Familien', v2.filter((e) => !FAMILIEN.includes(e.familie)).map((e) => e.kennung));

// ── N Familienname = angemeldeter Pruefer ──
const containerNamen = new Set(CONTAINER_SPRACHEN.map((s) => s.sprache));
const angemeldet = (f) => containerNamen.has(f) || !!K.prueferNachName(f);
pruefe(!angemeldet('pyton') && angemeldet('python') && angemeldet('yaml'), 'N ANKER: falscher Familienname faellt auf, echte (Container/core) werden gefunden');
const unbekannt = [...new Set(seed.eintraege.map((e) => e.familie))].filter((f) => !angemeldet(f));
pruefe(unbekannt.length === 0, 'N jede Seed-Familie ist ein angemeldeter Syntaxpruefer', unbekannt);

// ── G Generik + Sprachen ──
const probleme = seed.eintraege.map((e) => [e.kennung, E.pruefeSeedEintrag(e, ['de', 'en'])]).filter(([, p]) => p.length);
pruefe(probleme.length === 0 && v2.length > 0, 'G jeder Eintrag: de+en vollstaendig, Laenge, Generik bestanden', probleme);
const verstoss = { ...v2[0], de: { ...(v2[0]?.de ?? {}), abhilfe: 'In src/teil/modul.py in Zeile 12 die Klammer ergaenzen.' } };
const p = E.pruefeSeedEintrag(verstoss, ['de', 'en']);
pruefe(p.some((x) => x.includes('pfad')) && p.some((x) => x.includes('zeilenangabe')), 'G ANKER: Pfad und Zeilenangabe im Text werden erkannt', p);
pruefe(new Set(seed.eintraege.map((e) => e.kennung)).size === seed.eintraege.length, 'G Kennungen eindeutig');

// ── S Status nur mit Beleg ──
const falsch = v2.filter((e) => (e.status === 'verifiziert') !== /richtig 3\/3/.test(e.beleg ?? '') || !['verifiziert', 'vorgeschlagen'].includes(e.status));
pruefe(falsch.length === 0, 'S verifiziert genau dann, wenn der Messbeleg 3/3 lautet', falsch.map((e) => e.kennung));
pruefe(v2.some((e) => e.status === 'vorgeschlagen') && v2.some((e) => e.status === 'verifiziert'), 'S ANKER: beide Status kommen vor (Pruefung nicht leer erfuellt)');

// ── L Laden idempotent ──
const pool = getPool();
const kennungen = seed.eintraege.map((e) => e.kennung);
const vorher = new Set((await pool.query('SELECT kennung FROM erklaerungen WHERE kennung = ANY($1)', [kennungen])).rows.map((r) => r.kennung));
try {
  await pool.query('DELETE FROM erklaerungen WHERE kennung = ANY($1) AND NOT (kennung = ANY($2))', [v2.map((e) => e.kennung), [...vorher]]);
  const r1 = await E.ladeErklaerungstopfSeed({ datei: seedDatei, agent: 'seed-v2-test' });
  const r2 = await E.ladeErklaerungstopfSeed({ datei: seedDatei, agent: 'seed-v2-test' });
  const { rows } = await pool.query('SELECT kennung, familie, status FROM erklaerungen WHERE kennung = ANY($1)', [v2.map((e) => e.kennung)]);
  const soll = Object.fromEntries(v2.map((e) => [e.kennung, e]));
  pruefe(r1.success === true && r1.abgelehnt === 0 && rows.length === v2.length && rows.length > 0
    && rows.every((r) => r.status === soll[r.kennung].status && r.familie === soll[r.kennung].familie),
  'L 1. Lauf: alle v2-Eintraege in PG, Status und Familie laut Seed', { r1, in_pg: rows.length, v2: v2.length });
  pruefe(r2.success === true && r2.neu === 0 && r2.vorhanden === seed.eintraege.length, 'L 2. Lauf: 0 neu (idempotent)', r2);
} finally {
  await pool.query('DELETE FROM erklaerungen WHERE kennung = ANY($1) AND NOT (kennung = ANY($2))', [kennungen, [...vorher]]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
