/**
 * P15-T33 E2 (11.10.2026): ERKLAERUNGS-TOPF - Startbestand, persistente Warteschlange, Onboarding-Zeile.
 * Bezug: E1-Bericht thought 58d13b5e, Konzept 0a089e5d v3, E0 1486172c, User a189da34/a5fd30ea.
 *
 * ZUSAGEN:
 *   S  DDL erklaerung_ereignisse im gebauten SCHEMA_SQL (nur neue Tabelle, kein ALTER auf Bestand).
 *   D  Seed packages/core/data/erklaerungstopf-seed.json: 15 Eintraege, de+en, Generik-Pruefung besteht (ANKER:
 *      Verstoss wird erkannt), Status 13 verifiziert / 2 vorgeschlagen (K4, K11); Laden idempotent (2. Lauf 0 neu),
 *      gleiche Lage in der Familie gilt als vorhanden; familie/schluessel passen zu den echten Pruefern
 *      (Einzelweg-Ablehnung in .ts/.json/.sql -> Jev bekommt die verifizierten Kandidaten der Familie).
 *   W  Warteschlange: der Worker sichert die Situation in erklaerung_ereignisse, BEVOR Jev antwortet (ANKER: Zeile
 *      waehrend des Jev-Aufrufs sichtbar, ohne Volltext), danach geloescht. Neustart: frische Modul-Instanz holt
 *      verwaiste und nie geclaimte Zeilen nach, laesst frisch geclaimte fremde stehen. Schalter aus -> Zeile weg,
 *      kein Fall. Verarbeitungsfehler -> Claim frei, nach 3 Versuchen verworfen.
 *   O  Onboarding-Zeile: Koordinator "N offene Erklaerungs-Faelle, code_check(offene_faelle)" (Projekt), Agent nur
 *      eigene (nur_eigene:true), ohne Faelle nichts (ANKER: Koordinator hat im selben Stand eine Zeile), Stufe ab
 *      6 Monaten genannt, Schalter aus -> nichts; offene_faelle nur_eigene; REST- und stdio-Onboarding verdrahtet.
 *   A  admin jev_erklaerungstopf: status (jeder), seed_laden/nachholen nur Koordinator/User.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama 127.0.0.1:9. Jeder Jev-Aufruf ist
 * ein Fake-fetch. Tabellen mit der DDL aus dem gebauten SCHEMA_SQL. Seed-Zeilen werden am Ende wieder entfernt
 * (sonst aendern sie die Kandidaten im E1-Test).
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/erklaerungen-e2.test.mjs   (core vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
  JEV_SCHALTER_CACHE_MS: '0', JEV_MODUS_CACHE_S: '0', JEV_OPENROUTER_API_KEY: 'sk-or-test-GEHEIM-erklaerungen-e2-0123',
  SYNTAX_WORKER_THREADS: '0', FEHLERPRUEFUNG_BUDGET_MS: '5000', FEHLERMUSTER_WARTE_MS: '0', PARSER_LOOP_DISABLED: '1',
});
for (const n of ['JEV_API_URL', 'JEV_PREIS_JE_MIO_EINGABE', 'JEV_BUDGET_RESERVE_USD', 'JEV_ERKLAERUNG_TOR', 'SYNAPSE_AGENT_NAME', 'SYNAPSE_DEFAULT_AGENT_ID', 'FEHLERPRUEFUNG_PLAN']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const repo = join(hier, '..', '..', '..');
const lade = (...t) => import(pathToFileURL(join(...t)).href);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
async function versuche(text, fn) {
  try { await fn(); } catch (err) { fehler++; console.error('FEHLER  ' + text + ': ' + (err instanceof Error ? err.stack ?? err.message : String(err))); }
}

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const TABELLEN = ['jev_schalter', 'jev_aufrufe', 'jev_budget_stand', 'jev_optionen', 'erklaerungen', 'erklaerung_faelle', 'erklaerung_ereignisse'];
const ddl = TABELLEN.map((t) => schemaJs.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`))?.[0]);
const fehlend = TABELLEN.filter((_, i) => !ddl[i]);
pruefe(fehlend.length === 0, 'S DDL inkl. erklaerung_ereignisse im gebauten SCHEMA_SQL', fehlend);
if (fehlend.length > 0) {
  console.error(`${fehler} FEHLER (Abbruch: ohne Tabellen keine weiteren Zusagen pruefbar)`);
  process.exit(1);
}
const dE = ddl[6];
pruefe(/geclaimt_am TIMESTAMPTZ/.test(dE) && /versuche INTEGER NOT NULL DEFAULT 0/.test(dE) && /schatten JSONB NOT NULL/.test(dE)
  && !/\b(basis|ergebnis|inhalt|content)\b/.test(dE),
  'S erklaerung_ereignisse: Claim-Spalten, Schatten, KEIN Volltext-Feld', dE);
pruefe(!/ALTER TABLE (IF EXISTS )?erklaer/i.test(schemaJs), 'S kein ALTER auf erklaerungen/erklaerung_faelle');
await pool.query("SET lock_timeout = '5s'");
for (const d of ddl) await pool.query(d);
for (const m of schemaJs.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_erklaer[^;]*;/g)) await pool.query(m[0]);

const SEED_DATEI = join(hier, '..', 'data', 'erklaerungstopf-seed.json');
const seed = JSON.parse(readFileSync(SEED_DATEI, 'utf8'));
const KENNUNGEN = seed.eintraege.map((e) => e.kennung);

const PRJ = 'zz-erklaerungen-e2';
const A = 'e2-a';
const B2 = 'e2-b';
const KOORD = 'koordinator';
const aufraeumen = async () => {
  await pool.query('DELETE FROM erklaerung_ereignisse WHERE project = $1', [PRJ]);
  await pool.query('DELETE FROM erklaerung_faelle WHERE project = $1', [PRJ]);
  await pool.query(`DELETE FROM erklaerungen WHERE kennung = ANY($1) OR erstellt_von = ANY($2)`, [KENNUNGEN, ['seed-test', 'e2-setup', KOORD]]);
  await pool.query('DELETE FROM jev_schalter');
  await pool.query('DELETE FROM jev_budget_stand');
  await pool.query('DELETE FROM jev_optionen');
  await pool.query('DELETE FROM jev_aufrufe WHERE project = $1', [PRJ]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PRJ]).catch(() => {});
  }
};
await aufraeumen();

const SP = await lade(dist, 'services', 'syntax-pruefer', 'index.js');
const FP = await lade(dist, 'services', 'fehlermuster-pruefung.js');
const CW = await lade(dist, 'services', 'code-write.js');
const AU = await lade(dist, 'services', 'fehlermuster-auslieferung.js');
const S = await lade(dist, 'services', 'jev-schalter.js');
const CC = await lade(dist, 'services', 'code-check-tool.js');
const JA = await lade(dist, 'services', 'jev-admin.js');
const E = await lade(dist, 'services', 'erklaerungen.js');

FP._syntaxPrueferLeeren();
SP.registriereStandardSyntaxPruefer({ threads: 0 });

/** Fake-fetch fuer Jev: antwort(n, body) -> {choice, confidence}; verzoegerung in ms. */
function fakeJev(antwort = () => ({ choice: 'a', confidence: 0.95 }), verzoegerung = 0) {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    f.aufrufe.push({ url, body });
    if (verzoegerung) await new Promise((r) => setTimeout(r, verzoegerung));
    const a = antwort(f.aufrufe.length, body);
    return new Response(JSON.stringify({ answers: { erklaerung: a }, usage: { input_tokens: 2600, output_tokens: 70, cost: 0.0001092 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.aufrufe = [];
  return f;
}
const kandidatenZahl = (aufruf) => Object.keys(aufruf?.body?.questions?.erklaerung?.criteria ?? {}).filter((k) => k !== 'keine').length;
const schreibe = (datei, inhalt, agent = A) => CW.updateFileInPg(PRJ, datei, inhalt, agent, 'update', undefined, 'erklaerungen-e2-test', undefined, { einzelweg: true });
async function schreibeKaputt(datei, inhalt, agent = A) {
  try { await schreibe(datei, inhalt, agent); return { abgelehnt: false }; } catch (err) { return { abgelehnt: err?.code === 'syntaxfehler', err }; }
}
const faelle = async () => (await pool.query('SELECT * FROM erklaerung_faelle WHERE project = $1 ORDER BY id', [PRJ])).rows;
const ereignisse = async () => (await pool.query('SELECT * FROM erklaerung_ereignisse WHERE project = $1 ORDER BY id', [PRJ])).rows;

const TS = { datei: 'src/zahl.ts', gut: 'export function summe(a: number, b: number): number {\n  return a + b;\n}\n' };
TS.kaputt = TS.gut.replace('return a + b;', 'return (a + b;');
const JS = { datei: 'cfg/werte.json', gut: '{\n  "a": 1,\n  "b": 2\n}\n', kaputt: '{\n  "a": 1,\n  "b": 2,\n}\n' };
const SQ = { datei: 'db/abfrage.sql', gut: 'SELECT a, b FROM t;\n', kaputt: 'INSERT INTO t (a, b,) VALUES (1, 2);\n' };

try {
  for (const f of [TS, JS, SQ]) await CW.createFileInPg(PRJ, f.datei, f.gut, 'e2-setup');

  // ── D Seed-Datei ──
  await versuche('D Seed-Datei', async () => {
    pruefe(seed.format === 'erklaerungstopf-seed' && seed.eintraege.filter((e) => e.e0_klasse).length === 15, 'D Seed: Format erklaerungstopf-seed, 15 E0-Eintraege (v2 prueft erklaerungstopf-seed-v2.test)', seed.eintraege.length);
    pruefe(E.erklaerungstopfSeedPfad() === join(dist, '..', 'data', 'erklaerungstopf-seed.json'), 'D Seed-Pfad aus dist zeigt auf packages/core/data', E.erklaerungstopfSeedPfad());
    const probleme = seed.eintraege.map((e) => [e.kennung, E.pruefeSeedEintrag(e, ['de', 'en'])]).filter(([, p]) => p.length);
    pruefe(probleme.length === 0, 'D jeder Eintrag: de+en vollstaendig, Laenge, Generik-Pruefung bestanden', probleme);
    const verstoss = { ...seed.eintraege[0], de: { ...seed.eintraege[0].de, abhilfe: 'In src/teil/rechnen.ts in Zeile 12 die Klammer ergaenzen.' } };
    const p = E.pruefeSeedEintrag(verstoss, ['de', 'en']);
    pruefe(p.some((x) => x.includes('pfad')) && p.some((x) => x.includes('zeilenangabe')), 'D ANKER: Pfad und Zeilenangabe im Seed-Text werden erkannt', p);
    const nurEn = { ...seed.eintraege[0], de: undefined };
    pruefe(E.pruefeSeedEintrag(nurEn, ['en']).length === 0 && E.pruefeSeedEintrag(nurEn, ['de', 'en']).some((x) => x.includes('de fehlt')),
      'D gepflegte Sprachen: nur en gepflegt -> ok, de gepflegt -> fehlt', E.pruefeSeedEintrag(nurEn, ['de', 'en']));
    const st = Object.fromEntries(['verifiziert', 'vorgeschlagen'].map((s) => [s, seed.eintraege.filter((e) => e.e0_klasse && e.status === s).map((e) => e.e0_klasse)]));
    pruefe(st.verifiziert.length === 13 && st.vorgeschlagen.join(',') === 'K4,K11', 'D Status: 13 verifiziert, vorgeschlagen nur K4 und K11 (E0-Beleg)', st);
  });

  // ── D Seed laden ──
  await versuche('D Seed laden', async () => {
    const k1 = seed.eintraege.find((e) => e.e0_klasse === 'K1');
    await pool.query(`INSERT INTO erklaerungen (familie, lage_en, wieso_en, abhilfe_en, status, erstellt_von) VALUES ('typescript', $1, $2, $3, 'vorgeschlagen', 'e2-setup')`,
      [k1.en.lage.toUpperCase(), k1.en.wieso, k1.en.abhilfe]);
    const r1 = await E.ladeErklaerungstopfSeed({ agent: 'seed-test' });
    const N = seed.eintraege.length;
    pruefe(r1.success === true && r1.neu === N - 1 && r1.vorhanden === 1 && r1.abgelehnt === 0, `D 1. Lauf: ${N - 1} neu, 1 vorhanden (gleiche Lage in der Familie, Gross/Klein egal)`, r1);
    await pool.query(`DELETE FROM erklaerungen WHERE erstellt_von = 'e2-setup'`);
    const r2 = await E.ladeErklaerungstopfSeed({ agent: 'seed-test' });
    pruefe(r2.success === true && r2.neu === 1 && r2.vorhanden === N - 1, `D 2. Lauf: die fehlende kommt dazu (1 neu, ${N - 1} vorhanden)`, r2);
    const r3 = await E.ladeErklaerungstopfSeed({ agent: 'seed-test' });
    pruefe(r3.success === true && r3.neu === 0 && r3.vorhanden === N, 'D idempotent: 3. Lauf 0 neu', r3);
    const { rows } = await pool.query(`SELECT kennung, familie, status, verifiziert_am IS NOT NULL AS va, lage_de IS NOT NULL AND lage_en IS NOT NULL AS beide, erstellt_von
      FROM erklaerungen WHERE kennung = ANY($1)`, [KENNUNGEN]);
    const erwartet = Object.fromEntries(seed.eintraege.map((e) => [e.kennung, e.status]));
    pruefe(rows.length === N && rows.every((r) => r.status === erwartet[r.kennung] && r.va === (r.status === 'verifiziert') && r.beide && r.erstellt_von === 'seed-test'),
      'D in PG: Status laut Seed, verifiziert_am nur bei verifiziert, de+en, erstellt_von', rows);
    const kaputt = join(mkdtempSync(join(tmpdir(), 'e2-seed-')), 'seed.json');
    writeFileSync(kaputt, JSON.stringify({ format: 'erklaerungstopf-seed', eintraege: [{ ...seed.eintraege[0], kennung: 'zz-e2-pfad', de: { ...seed.eintraege[0].de, lage: 'Im Projekt zz-erklaerungen-e2 fehlt in src/a/b.ts eine Klammer.' } }] }));
    const r4 = await E.ladeErklaerungstopfSeed({ datei: kaputt, agent: 'seed-test' });
    pruefe(r4.success === false && r4.abgelehnt === 1 && r4.neu === 0 && /nicht generisch/.test(JSON.stringify(r4.fehler)), 'D nicht generischer Seed-Eintrag wird abgelehnt, nichts gespeichert', r4);
  });

  // ── D Familie/Schluessel gegen die echten Pruefer ──
  await versuche('D Familien', async () => {
    const verifiziert = (fam) => seed.eintraege.filter((e) => e.familie === fam && e.status === 'verifiziert').length;
    for (const [f, fam] of [[TS, 'typescript'], [JS, 'json'], [SQ, 'libpg-query']]) {
      const jev = fakeJev(() => ({ choice: 'keine', confidence: 0.9 }));
      E._setzeErklaerungDeps({ fetch: jev });
      const r = await schreibeKaputt(f.datei, f.kaputt);
      await E._erklaerungenLeerlauf();
      const fall = (await faelle()).find((x) => x.datei === f.datei);
      const seedSchluessel = seed.eintraege.filter((e) => e.familie === fam).map((e) => e.schluessel);
      pruefe(r.abgelehnt && fall && fall.familie === fam && seedSchluessel.includes(fall.schluessel),
        `D ${fam}: echter Pruefer liefert familie ${fam} und einen Seed-Schluessel`, { abgelehnt: r.abgelehnt, err: r.err?.message, familie: fall?.familie, schluessel: fall?.schluessel });
      const inPg = (await pool.query(`SELECT count(*)::int AS n FROM erklaerungen WHERE familie = $1 AND status = 'verifiziert'`, [fam])).rows[0].n;
      pruefe(jev.aufrufe.length === 1 && inPg >= verifiziert(fam) && kandidatenZahl(jev.aufrufe[0]) === Math.min(12, inPg),
        `D ${fam}: Jev bekommt die verifizierten Kandidaten der Familie (Seed: ${verifiziert(fam)})`, { aufrufe: jev.aufrufe.length, kandidaten: kandidatenZahl(jev.aufrufe[0]), inPg });
    }
    await pool.query('DELETE FROM erklaerung_faelle WHERE project = $1', [PRJ]);
  });

  // ── W1 Sicherung waehrend des Jev-Aufrufs ──
  await versuche('W1 Sicherung', async () => {
    const jev = fakeJev(() => ({ choice: 'a', confidence: 0.95 }), 700);
    E._setzeErklaerungDeps({ fetch: jev });
    await AU.holeFehlermusterHinweise(A);
    const t0 = Date.now();
    const r = await schreibeKaputt(TS.datei, TS.kaputt + '// w1\n');
    const ms = Date.now() - t0;
    let gesehen = [];
    for (let i = 0; i < 40 && gesehen.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 15));
      gesehen = await ereignisse();
    }
    const z = gesehen[0];
    pruefe(r.abgelehnt && ms < 600, 'W1 Schreibweg lehnt ab und wartet nicht auf Jev (< 600 ms)', { ms, abgelehnt: r.abgelehnt });
    pruefe(gesehen.length === 1 && z.familie === 'typescript' && z.versuche === 1 && z.geclaimt_am && /:\d+:/.test(z.geclaimt_von ?? '')
      && typeof z.schatten?.code_nachher === 'string' && z.bezug?.ergebnis_hash && jev.aufrufe.length <= 1,
      'W1 ANKER: waehrend des Jev-Aufrufs ist die Situation in erklaerung_ereignisse gesichert (Claim dieses Prozesses, Schatten, Hashes)', gesehen);
    await E._erklaerungenLeerlauf();
    const h = await AU.holeFehlermusterHinweise(A);
    pruefe((await ereignisse()).length === 0 && jev.aufrufe.length === 1 && (await faelle()).length === 0 && (h?.treffer ?? []).some((x) => x.quelle === 'erklaerung' && x.erklaerung?.status === 'verifiziert'),
      'W1 nach der Verarbeitung: Zeile geloescht, verifizierte Seed-Erklaerung ausgeliefert, kein Fall', { ereignisse: (await ereignisse()).length, aufrufe: jev.aufrufe.length, h });
  });

  // ── W2 Neustart: frische Modul-Instanz holt nach ──
  await versuche('W2 Nachholen', async () => {
    const roh = (datei, agent, claim) => {
      const schatten = E.baueSchatten({ datei, befund: { was: "')' expected.", zeilen: [2, 2] }, basis: TS.gut, ergebnis: TS.kaputt + `// ${datei}\n` });
      return pool.query(`INSERT INTO erklaerung_ereignisse (project, agent_id, datei, familie, schluessel, befund, bezug, schatten, versuche, geclaimt_am, geclaimt_von)
        VALUES ($1, $2, $3, 'typescript', 'syntax|typescript|TS1005', $4::jsonb, $5::jsonb, $6::jsonb, 1, ${claim}, 'anderer-prozess') RETURNING id::text AS id`,
      [PRJ, agent, datei, JSON.stringify({ quelle: 'syntax', pruefer: 'syntax:typescript@5.9', severity: 'error', datei, zeilen: [2, 2], code: 'TS1005', was: "')' expected." }),
        JSON.stringify({ weg: 'einzelweg', op_index: null, file_path: datei, basis_hash: 'b'.repeat(64), ergebnis_hash: 'e'.repeat(64) }), JSON.stringify(schatten)]);
    };
    await roh('src/verwaist.ts', A, "NOW() - INTERVAL '10 minutes'");
    await roh('src/nie-geclaimt.ts', B2, 'NULL');
    await roh('src/laeuft-noch.ts', A, 'NOW()');
    pruefe((await ereignisse()).length === 3, 'W2 ANKER: drei gesicherte Situationen liegen vor dem Neustart');
    const E2 = await import(pathToFileURL(join(dist, 'services', 'erklaerungen.js')).href + '?neustart=' + Date.now());
    const jev = fakeJev(() => ({ choice: 'keine', confidence: 0.9 }));
    const r = await E2.holeErklaerungsEreignisseNach({ fetch: jev });
    const rest = await ereignisse();
    const fs = await faelle();
    pruefe(r.geholt === 2 && r.verarbeitet === 2 && r.fehler === 0 && jev.aufrufe.length === 2,
      'W2 neue Instanz: verwaiste + nie geclaimte nachgeholt (2), je ein Jev-Aufruf', r);
    pruefe(rest.length === 1 && rest[0].datei === 'src/laeuft-noch.ts', 'W2 frisch geclaimte Zeile eines lebenden Prozesses bleibt stehen', rest.map((x) => x.datei));
    pruefe(fs.length === 2 && fs.every((f) => f.jev?.wahl === 'keine' && f.bezug?.ergebnis_hash === 'e'.repeat(64)) && fs.map((f) => f.agent_id).sort().join() === [A, B2].sort().join(),
      'W2 nachgeholte Situationen werden zu Faellen (Jev keine) mit Bezug und Agent aus der Sicherung', fs.map((f) => ({ d: f.datei, a: f.agent_id, jev: f.jev })));
    const r2 = await E2.holeErklaerungsEreignisseNach({ fetch: jev });
    pruefe(r2.geholt === 0 && jev.aufrufe.length === 2, 'W2 zweiter Lauf: nichts doppelt verarbeitet', r2);
    await pool.query('DELETE FROM erklaerung_ereignisse WHERE project = $1', [PRJ]);
  });

  // ── W3 Schalter aus, W4 Fehler ──
  await versuche('W3/W4', async () => {
    const einfuegen = (datei, familie, befund) => pool.query(`INSERT INTO erklaerung_ereignisse (project, agent_id, datei, familie, schluessel, befund, bezug, schatten)
      VALUES ($1, $2, $3, $4, 'syntax|x|y', $5::jsonb, '{}'::jsonb, '{}'::jsonb)`, [PRJ, A, datei, familie, JSON.stringify(befund)]);
    await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'erklaerungstopf', aktiv: false, grund: 'test', agent: KOORD });
    await einfuegen('src/aus.ts', 'typescript', { datei: 'src/aus.ts', zeilen: [1, 1] });
    const jev = fakeJev();
    const vorher = (await faelle()).length;
    const r = await E.holeErklaerungsEreignisseNach({ fetch: jev });
    pruefe(r.geholt === 1 && r.ergebnisse?.aus === 1 && (await ereignisse()).length === 0 && jev.aufrufe.length === 0 && (await faelle()).length === vorher,
      'W3 Schalter erklaerungstopf aus: gesicherte Situation verworfen, kein fetch, kein Fall', r);
    await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'erklaerungstopf', aktiv: true, grund: 'test', agent: KOORD });
    // familie ohne Kandidaten, befund ohne datei -> speichereFall scheitert (datei NOT NULL)
    await einfuegen('src/defekt.ts', 'zz-ohne-kandidaten', { zeilen: [1, 1] });
    const a1 = await E.holeErklaerungsEreignisseNach({ fetch: jev });
    const z1 = (await ereignisse())[0];
    pruefe(a1.fehler === 1 && z1 && z1.geclaimt_am === null && z1.versuche === 1, 'W4 Verarbeitungsfehler: Claim freigegeben, Zeile bleibt fuer den naechsten Lauf', { a1, z1 });
    await E.holeErklaerungsEreignisseNach({ fetch: jev });
    const a3 = await E.holeErklaerungsEreignisseNach({ fetch: jev });
    pruefe(a3.fehler === 1 && (await ereignisse()).length === 0, 'W4 nach 3 Versuchen verworfen', { a3, rest: await ereignisse() });
  });

  // ── O Onboarding-Zeile ──
  await versuche('O Onboarding', async () => {
    const n = (await faelle()).length;
    const nA = (await faelle()).filter((f) => f.agent_id === A).length;
    const koord = await E.erklaerungsFaelleZeile({ project: PRJ, agent_id: KOORD, koordinator: true });
    pruefe(n === 2 && koord === `${n} offene Erklaerungs-Faelle, code_check(offene_faelle)`, 'O Koordinator: "N offene Erklaerungs-Faelle, code_check(offene_faelle)"', { n, koord });
    const ag = await E.erklaerungsFaelleZeile({ project: PRJ, agent_id: A, koordinator: false });
    pruefe(nA === 1 && ag === `${nA} offene Erklaerungs-Faelle, code_check(offene_faelle, nur_eigene:true)`, 'O Agent: nur eigene Faelle', { nA, ag });
    const ohne = await E.erklaerungsFaelleZeile({ project: PRJ, agent_id: 'e2-ohne-faelle', koordinator: false });
    pruefe(ohne === undefined && typeof koord === 'string', 'O Agent ohne Faelle: keine Zeile (ANKER: Koordinator hat im selben Stand eine)', ohne);
    pruefe(await E.erklaerungsFaelleZeile({ project: 'zz-e2-leer', agent_id: KOORD, koordinator: true }) === undefined, 'O Projekt ohne Faelle: keine Zeile');
    await pool.query(`UPDATE erklaerung_faelle SET erstellt_am = NOW() - INTERVAL '7 months' WHERE project = $1 AND agent_id = $2`, [PRJ, B2]);
    const alt = await E.erklaerungsFaelleZeile({ project: PRJ, agent_id: KOORD, koordinator: true });
    pruefe(/^2 offene Erklaerungs-Faelle, code_check\(offene_faelle\) - davon 1 ueber 6 Monate/.test(alt ?? ''), 'O Koordinator: Stufe ab 6 Monaten genannt', alt);
    await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'erklaerungstopf', aktiv: false, grund: 'test', agent: KOORD });
    pruefe(await E.erklaerungsFaelleZeile({ project: PRJ, agent_id: KOORD, koordinator: true }) === undefined, 'O Funktion erklaerungstopf aus: keine Zeile');
    await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'erklaerungstopf', aktiv: true, grund: 'test', agent: KOORD });
    const eigen = await CC.fuehreCodeCheckAus({ action: 'offene_faelle', project: PRJ, nur_eigene: true }, A);
    const alle = await CC.fuehreCodeCheckAus({ action: 'offene_faelle', project: PRJ }, A);
    pruefe(eigen.success && eigen.anzahl === 1 && eigen.faelle.every((f) => f.agent_id === A) && alle.anzahl === 2,
      'O code_check(offene_faelle, nur_eigene:true): nur Faelle des Aufrufers, Zaehlung passend', { eigen: eigen.anzahl, alle: alle.anzahl });
    const rest = readFileSync(join(repo, 'packages', 'rest-api', 'src', 'routes', 'mcp.ts'), 'utf8');
    const stdio = readFileSync(join(repo, 'packages', 'mcp-server', 'src', 'tools', 'onboarding.ts'), 'utf8');
    const server = readFileSync(join(repo, 'packages', 'rest-api', 'src', 'server.ts'), 'utf8');
    pruefe(/erklaerungsFaelleZeile\(/.test(rest) && /\.\.\.erklBlock/.test(rest) && /erklaerungsFaelleZeile\(/.test(stdio) && /erklaerung_faelle: erklZeile/.test(stdio),
      'O Onboarding-Zeile in REST (routes/mcp.ts) und stdio (tools/onboarding.ts) verdrahtet');
    pruefe(/ladeErklaerungstopfSeed\(/.test(server) && /holeErklaerungsEreignisseNach\(/.test(server), 'O API-Start: Seed laden und Nachholen verdrahtet (rest-api server.ts)');
  });

  // ── A admin ──
  await versuche('A admin', async () => {
    pruefe(JA.JEV_ADMIN_ACTIONS.includes('jev_erklaerungstopf'), 'A jev_erklaerungstopf in JEV_ADMIN_ACTIONS');
    const st = await JA.fuehreJevAdminAus('jev_erklaerungstopf', { modus: 'status' }, A);
    pruefe(st.success === true && st.topf?.erklaerungen?.je_familie?.typescript?.verifiziert >= 8 && typeof st.topf?.warteschlange?.gesichert === 'number',
      'A status: je Familie/Status, Warteschlange', st);
    const nein = await JA.fuehreJevAdminAus('jev_erklaerungstopf', { modus: 'seed_laden' }, A);
    pruefe(nein.success === false && nein.error === 'nur_koordinator', 'A seed_laden nur Koordinator/User', nein);
    const ja = await JA.fuehreJevAdminAus('jev_erklaerungstopf', { modus: 'seed_laden' }, KOORD);
    pruefe(ja.success === true && ja.neu === 0 && ja.vorhanden === seed.eintraege.length, 'A seed_laden durch Koordinator: idempotent', ja);
    const nach = await JA.fuehreJevAdminAus('jev_erklaerungstopf', { modus: 'nachholen' }, KOORD);
    pruefe(nach.success === true && nach.geholt === 0, 'A nachholen durch Koordinator', nach);
  });
} finally {
  E._setzeErklaerungDeps(null);
  await aufraeumen();
  const rest = (await pool.query('SELECT count(*)::int AS n FROM erklaerungen WHERE kennung = ANY($1)', [KENNUNGEN])).rows[0].n;
  pruefe(rest === 0, 'Aufraeumen: Seed-Zeilen wieder aus der Test-DB entfernt', rest);
  await pool.end().catch(() => {});
}

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
