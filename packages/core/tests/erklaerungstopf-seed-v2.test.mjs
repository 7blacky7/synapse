/**
 * P15 Nachtrunde C (11.10.2026): STARTBESTAND v2 des Erklaerungs-Topfs. Fall 16 (python) zeigte, dass der Seed nur
 * typescript/json/libpg-query abdeckte; fuer jede andere Familie ging Jev leer aus (keine_kandidaten).
 *
 * ZUSAGEN:
 *   F  Eintraege mit v2:true fuer python, shell, go, rust, php, ruby, kotlin, java, csharp, yaml, toml, dockerfile,
 *      cmake - je Familie 2 bis 4.
 *   N  Jede Syntax-Familie des Seeds ist der Name eines angemeldeten Syntaxpruefers (Container-Sprache der API oder core-Katalog),
 *      sonst bekaeme der Pruefer-Befund (familieVon) die Erklaerungen nie. ANKER: ein falscher Name faellt auf.
 *      (angepasst P25-T18) Familien mit Doppelpunkt (shell-ergebnis:*, fileplan:*) sind Werkzeug-/Ergebnis-Faelle, keine Syntaxpruefer.
 *   G  Jeder Eintrag besteht pruefeSeedEintrag (de+en, Laenge, Generik). ANKER: Pfad + Zeilenangabe werden erkannt.
 *   S  verifiziert nur mit Messbeleg "richtig 3/3" (echter Pruefer + Jev), sonst vorgeschlagen.
 *   L  Laden idempotent: 1. Lauf legt im leeren Topf alle Eintraege an (v2 mit Familie und Status laut Seed), 2. Lauf 0 neu.
 *
 * Nur synapse_test (sonst Exit 2). (angepasst P25-T18) L laeuft in einem eigenen privaten Schema mit leerer Kopie von erklaerungen,
 * das am Ende geloescht wird: keine Reste im geteilten synapse_test.public. Vorher blieben Zeilen stehen, weil das Aufraeumen ueber
 * kennung lief, der Loader seit P10-T63 aber eine stabile Inhalts-UUID schreibt (kennung bleibt NULL); die Reste trafen
 * erklaerungen-topf als fremde Kandidaten (P25-T17). Abgleich deshalb ueber Familie + Lage.
 * SEED_DATEI=<pfad> (optional) prueft eine andere Seed-Datei, z. B. den alten Stand fuer die Positivkontrolle.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/erklaerungstopf-seed-v2.test.mjs   (core + rest-api vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('erklaerungstopf-seed-v2.test');
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', PARSER_LOOP_DISABLED: '1' });

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');

// P25-T18: privates Schema vor dem ersten Pool-Zugriff; search_path privat vor public (gelesen wird z. B. jev_optionen aus public).
const { Pool } = createRequire(join(hier, '..', 'package.json'))('pg');
const admin = new Pool({ connectionString: DB_URL });
const schema = 'p25_t18s_' + process.pid + '_' + randomUUID().slice(0, 8);
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await admin.query('CREATE TABLE ' + schema + '.erklaerungen (LIKE public.erklaerungen INCLUDING ALL)');
} catch (err) {
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {});
  await admin.end().catch(() => {});
  console.error('ABBRUCH privates Schema: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
const privat = new URL(DB_URL);
privat.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = privat.href;
delete process.env.SYNAPSE_DATABASE_URL;

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
const seedFamilien = [...new Set(seed.eintraege.map((e) => e.familie))];
// (angepasst P25-T18) Werkzeug-/Ergebnis-Familien (art:code, z. B. shell-ergebnis:test_rot, fileplan:anchor_mismatch) sind keine Syntaxpruefer.
const werkzeug = seedFamilien.filter((f) => f.includes(':'));
const unbekannt = seedFamilien.filter((f) => !f.includes(':') && !angemeldet(f));
pruefe(unbekannt.length === 0, 'N jede Syntax-Familie des Seeds ist ein angemeldeter Syntaxpruefer', unbekannt);
pruefe(werkzeug.every((f) => /^[a-z-]+:[a-z_]+$/.test(f)), 'N Werkzeug-Familien haben die Form art:code (kein Tippfehler-Schlupfloch)', werkzeug);

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

// ── L Laden idempotent (privates Schema, leerer Topf) ──
const pool = getPool();
const lage = (e) => String(e.de?.lage ?? '').trim().toLowerCase();
try {
  const vorher = (await pool.query('SELECT count(*)::int AS n FROM erklaerungen')).rows[0].n;
  pruefe(vorher === 0, 'L ANKER: privater Topf vor dem Laden leer (Schema ' + schema + ')', vorher);
  const r1 = await E.ladeErklaerungstopfSeed({ datei: seedDatei, agent: 'seed-v2-test' });
  const r2 = await E.ladeErklaerungstopfSeed({ datei: seedDatei, agent: 'seed-v2-test' });
  const { rows } = await pool.query('SELECT familie, status, lower(lage_de) AS lage FROM erklaerungen');
  const fehlt = v2.filter((e) => !rows.some((r) => r.familie === e.familie && r.lage === lage(e) && r.status === e.status)).map((e) => e.kennung);
  pruefe(r1.success === true && r1.abgelehnt === 0 && r1.neu === seed.eintraege.length && rows.length === seed.eintraege.length && fehlt.length === 0,
    'L 1. Lauf: alle Eintraege neu im leeren Topf, v2 mit Familie und Status laut Seed', { r1, in_pg: rows.length, fehlt: fehlt.slice(0, 5) });
  pruefe(r2.success === true && r2.neu === 0 && r2.vorhanden === seed.eintraege.length, 'L 2. Lauf: 0 neu (idempotent)', r2);
} finally {
  await pool.end().catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch((err) => console.error('Schema entfernen: ' + err.message));
  await admin.end().catch(() => {});
}

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
