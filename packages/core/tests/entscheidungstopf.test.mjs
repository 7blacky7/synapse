/**
 * P15 E1 (11.10.2026): ENTSCHEIDUNGS-TOPF fuer Jev (Konzept thought 6591b268, User-Entscheidung e7b013c2,
 * E0-Messung bfbf7968, Vorbild Erklaerungstopf 58d13b5e).
 *
 * ZUSAGEN:
 *   S  DDL jev_entscheidungstopf (Status roh|aktiv|ersetzt|stillgelegt) + neue Spalten in jev_entscheidungen im
 *      gebauten SCHEMA_SQL; Funktion 'entscheidungstopf' im Schalter; verbotene Kategorien + live_db, schema.
 *   D  Seed: idempotent (zweiter Lauf 0 neu), alle Eintraege aktiv, kandidat=false bleibt gespeichert.
 *   A  entscheidung_ablegen/aufbereiten: nur Koordinator/User; gepflegte Sprachen Pflicht fuer aktiv, sonst roh.
 *   T  thought mit Tags entscheidung+user -> roh-Eintrag (herkunft thought, idempotent); ohne Tags nichts (ANKER).
 *   K  Kandidaten per Embedding (Mock), Top 6, eigener Eintrag zuerst, Embedding in PG gespeichert.
 *   P  Praezedenz-Schritt: beide Tore (0,8 Praezedenz, 0,7 Option) -> entschieden mit praezedenz_id;
 *      Praezedenz unter Tor/'keine' -> Entscheidung OHNE Praezedenz (markiert); Option unter Tor -> unsicher;
 *      Option entscheidung_ohne_praezedenz aus -> offene Frage, kein zweiter Aufruf.
 *   X  Sicherheit: S1 live_db verboten; S2 Text-Scan (kein fetch, ANKER harmlos mit fetch); S2b irreversibel -> nie
 *      autonom; S3 autonome Entscheidungen erzeugen keinen Topf-Eintrag (ANKER: Topf nicht leer).
 *   W  Schalter entscheidungstopf aus -> alter Weg (ein Aufruf ohne irreversibel; ANKER an: mit).
 *   R  Durchsicht: Liste ohne_praezedenz zuerst; ok -> bestaetigt_n; korrigieren -> neuer Eintrag herkunft korrektur,
 *      korrigiert_n; Nicht-Koordinator abgelehnt. abwesend aus liefert durchsicht_offen.
 *   G  abwesend project '*' wirkt fuer alle Projekte; aus schaltet ab.
 *   O  Jev-Option entscheidung_ohne_praezedenz (Standard an), admin jev_entscheidungstopf status, Dispatcher topf.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama 127.0.0.1:9. Jeder Jev-Aufruf ist ein
 * Fake-fetch, jedes Embedding ein Mock (deps.embed). Tabellen mit der DDL aus dem gebauten SCHEMA_SQL.
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/entscheidungstopf.test.mjs   (core vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
  JEV_SCHALTER_CACHE_MS: '0', JEV_MODUS_CACHE_S: '0', JEV_OPENROUTER_API_KEY: 'sk-or-test-GEHEIM-topf-0123',
});
for (const n of ['JEV_API_URL', 'JEV_PREIS_JE_MIO_EINGABE', 'JEV_BUDGET_RESERVE_USD', 'JEV_ENTSCHEIDUNG_TOR', 'JEV_ENTSCHEIDUNGSTOPF_TOR',
  'JEV_IRREVERSIBEL_SCHWELLE', 'JEV_ENTSCHEIDUNG_RATE', 'SYNAPSE_AGENT_NAME', 'SYNAPSE_DEFAULT_AGENT_ID']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
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

// --- S: DDL + Modul ------------------------------------------------------------------------------
const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const TABELLEN = ['jev_entscheidet', 'jev_entscheidungen', 'jev_schalter', 'jev_aufrufe', 'jev_budget_stand', 'jev_optionen', 'jev_entscheidungstopf'];
const ddl = TABELLEN.map((t) => schemaJs.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`))?.[0]);
const fehlend = TABELLEN.filter((_, i) => !ddl[i]);
pruefe(fehlend.length === 0, 'S DDL jev_* + jev_entscheidungstopf im gebauten SCHEMA_SQL', fehlend);
const modulDa = existsSync(join(dist, 'services', 'entscheidungstopf.js'));
pruefe(modulDa, 'S Modul dist/services/entscheidungstopf.js vorhanden');
const alters = [...schemaJs.matchAll(/ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS (\w+)[^;]*;/g)];
const neueSpalten = ['praezedenz_id', 'praezedenz_confidence', 'ohne_praezedenz', 'irreversibel_p', 'durchsicht', 'durchsicht_am', 'durchsicht_von'];
pruefe(neueSpalten.every((s) => alters.some((m) => m[1] === s)), 'S jev_entscheidungen: nur neue Spalten (ADD COLUMN IF NOT EXISTS) fuer Praezedenz und Durchsicht', alters.map((m) => m[1]));
if (fehlend.length > 0 || !modulDa) {
  console.error(`${fehler} FEHLER (Abbruch: ohne Tabelle/Modul keine weiteren Zusagen pruefbar)`);
  process.exit(1);
}
const topfDdl = ddl[6];
pruefe(/'roh', 'aktiv', 'ersetzt', 'stillgelegt'/.test(topfDdl) && /antwort_wortlaut TEXT NOT NULL/.test(topfDdl) && /aufbereitet_de JSONB/.test(topfDdl) && /aufbereitet_en JSONB/.test(topfDdl),
  'S jev_entscheidungstopf: Status roh|aktiv|ersetzt|stillgelegt, Wortlaut Pflicht, Aufbereitung je Sprache', topfDdl);
pruefe(!/\bproject TEXT NOT NULL/.test(topfDdl), 'S Topf ist global (kein Pflicht-Projekt, nur herkunft_projekt)');

const privateSchema = 'topf_regression_' + process.pid + '_' + Date.now();
const privateUrl = new URL(DB_URL); privateUrl.searchParams.set('options', '-c search_path=' + privateSchema + ',public');
process.env.DATABASE_URL = privateUrl.toString(); process.env.SYNAPSE_DATABASE_URL = privateUrl.toString();
const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
await pool.query('CREATE SCHEMA "' + privateSchema + '"');
for (const { tablename } of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) {
  const q = '"' + tablename.replaceAll('"', '""') + '"';
  await pool.query('CREATE TABLE "' + privateSchema + '".' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
}
await pool.query("SET lock_timeout = '5s'");
for (const d of ddl) await pool.query(d);
for (const m of alters) await pool.query(m[0]);
for (const m of schemaJs.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_jev_entscheidungstopf[^;]*;/g)) await pool.query(m[0]);

const S = await lade(dist, 'services', 'jev-schalter.js');
const O = await lade(dist, 'services', 'jev-optionen.js');
const A = await lade(dist, 'services', 'jev-admin.js');
const E = await lade(dist, 'services', 'jev-entscheidung.js');
const T = await lade(dist, 'services', 'entscheidungstopf.js');

pruefe(S.JEV_FUNKTIONEN.includes('entscheidungstopf'), 'S Funktion entscheidungstopf in JEV_FUNKTIONEN', S.JEV_FUNKTIONEN);
pruefe(E.VERBOTENE_KATEGORIEN.includes('live_db') && E.VERBOTENE_KATEGORIEN.includes('schema') && E.VERBOTENE_KATEGORIEN.includes('deploy'),
  'S verbotene Kategorien um live_db und schema ergaenzt', E.VERBOTENE_KATEGORIEN);

const PRJ = 'zz-entscheidungstopf';
const PRJ2 = 'zz-entscheidungstopf-2';
const KOORD = 'koordinator';
const AG = 'topf-agent';
const aufraeumen = async () => {
  await pool.query('DELETE FROM jev_entscheidungstopf');
  await pool.query('DELETE FROM jev_entscheidungen WHERE project = ANY($1)', [[PRJ, PRJ2]]);
  await pool.query(`DELETE FROM jev_entscheidet WHERE project = ANY($1)`, [[PRJ, PRJ2, '*']]);
  await pool.query(`DELETE FROM jev_schalter WHERE project = ANY($1) OR (project = '*' AND funktion = 'entscheidungstopf')`, [[PRJ, PRJ2]]);
  await pool.query(`DELETE FROM jev_optionen WHERE name = 'entscheidung_ohne_praezedenz'`);
  await pool.query('DELETE FROM jev_aufrufe WHERE project = ANY($1)', [[PRJ, PRJ2]]);
};
await aufraeumen();
S.leereJevSchalterCache?.();

// --- Mock-Embedding: Wort-Hashing (64 Dim.), gleiche Woerter -> aehnlich -----------------------
const DIM = 64;
const embedAufrufe = [];
function mockEmbed(text, art) {
  embedAufrufe.push(art);
  const v = new Array(DIM).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-zäöüß0-9]{3,}/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  return Promise.resolve(v);
}

/** Fake-Jev: antworten je Frage-Schluessel; merkt sich alle Bodies */
function fakeJev(antwort) {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    f.aufrufe.push(body);
    const answers = {};
    for (const [k, q] of Object.entries(body.questions ?? {})) answers[k] = antwort(k, q, body, f.aufrufe.length);
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 900, output_tokens: 20, cost: 0.00004 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.aufrufe = [];
  return f;
}
/** Schluessel der Praezedenz-Kriterien, deren Text das Merkmal enthaelt */
const keyMit = (q, merkmal) => Object.entries(q.criteria ?? {}).find(([, t]) => String(t).includes(merkmal))?.[0];

const AUFB = (merkmal) => ({
  de: { entscheidung: `Ausgabeformat bleibt JSON ${merkmal}.`, begruendung: 'Maschinenlesbar.', gilt_wenn: `Richtig, wenn ueber das Ausgabeformat einer Tool-Antwort entschieden wird ${merkmal}.` },
  en: { decision: `Output format stays JSON ${merkmal}.`, reason: 'Machine readable.', applies_when: `Correct when deciding the output format of a tool response ${merkmal}.` },
});

// --- O: Jev-Option entscheidung_ohne_praezedenz ------------------------------------------------
await versuche('O Option entscheidung_ohne_praezedenz', async () => {
  const o = await O.leseJevOptionen();
  pruefe(o.entscheidung_ohne_praezedenz === true, 'O entscheidung_ohne_praezedenz Standard an (User e7b013c2)', o);
  const o2 = await O.setzeJevOptionen({ entscheidung_ohne_praezedenz: false, agent: KOORD });
  pruefe(o2.entscheidung_ohne_praezedenz === false && o2.jev_sprache === o.jev_sprache, 'O setzen aus, uebrige Optionen bleiben', o2);
  await O.setzeJevOptionen({ entscheidung_ohne_praezedenz: true, agent: KOORD });
  const r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', entscheidung_ohne_praezedenz: false }, AG);
  pruefe(r.success === false && r.error === 'nur_koordinator', 'O admin jev_optionen setzen nur Koordinator/User', r);
});

// --- D: Seed -------------------------------------------------------------------------------------
await versuche('D Seed', async () => {
  const r1 = await T.ladeEntscheidungstopfSeed({ agent: 'topf-test' });
  const seed = JSON.parse(readFileSync(join(hier, '..', 'data', 'entscheidungstopf-seed.json'), 'utf8'));
  pruefe(r1.success === true && r1.neu === seed.eintraege.length && r1.neu >= 50, 'D Seed laedt alle Eintraege', r1);
  const r2 = await T.ladeEntscheidungstopfSeed({ agent: 'topf-test' });
  pruefe(r2.success === true && r2.neu === 0 && r2.vorhanden === seed.eintraege.length, 'D Seed idempotent (zweiter Lauf 0 neu)', r2);
  const { rows } = await pool.query(`SELECT status, kandidat, herkunft, count(*)::int AS n FROM jev_entscheidungstopf GROUP BY 1, 2, 3`);
  const nicht = seed.eintraege.filter((e) => !e.kandidat).length;
  pruefe(rows.every((z) => z.status === 'aktiv' && z.herkunft === 'seed') && rows.find((z) => z.kandidat === false)?.n === nicht,
    'D Seed: alle aktiv, herkunft seed, Nicht-Kandidaten gespeichert', rows);
  const st = await A.fuehreJevAdminAus('jev_entscheidungstopf', { modus: 'status' }, AG);
  pruefe(st.success === true && st.topf?.aktiv === seed.eintraege.length, 'O admin jev_entscheidungstopf status zaehlt', st);
  const sl = await A.fuehreJevAdminAus('jev_entscheidungstopf', { modus: 'seed_laden' }, AG);
  pruefe(sl.success === false && sl.error === 'nur_koordinator', 'O admin seed_laden nur Koordinator/User', sl);
  await pool.query(`DELETE FROM jev_entscheidungstopf WHERE herkunft = 'seed'`);
});

// --- A: ablegen / aufbereiten ----------------------------------------------------------------
let eintragId = null;
await versuche('A ablegen/aufbereiten', async () => {
  const basis = { name: 'test-ausgabeformat', frage_de: 'Welches Ausgabeformat soll die Tool-Antwort haben?', kategorie: 'variante', antwort_wortlaut: 'JSON, immer.', gewaehlte_option: 'a', themen: ['format'] };
  let r = await E.fuehreJevTopfActionAus(PRJ, 'entscheidung_ablegen', { ...basis, agent_id: AG, aufbereitet: AUFB('ZZT-MARKER') });
  pruefe(r.success === false && /Koordinator/.test(r.message ?? ''), 'A ablegen nur Koordinator/User', r);
  r = await E.fuehreJevTopfActionAus(PRJ, 'entscheidung_ablegen', { ...basis, agent_id: KOORD, aufbereitet: { de: AUFB('x').de } });
  pruefe(r.success === true && r.status === 'roh' && /en/.test(JSON.stringify(r.fehlende_sprachen ?? r.hinweis ?? '')), 'A gepflegte Sprache fehlt -> roh mit Hinweis', r);
  const rohId = r.id;
  r = await E.fuehreJevTopfActionAus(PRJ, 'entscheidung_aufbereiten', { agent_id: KOORD, eintrag_id: rohId, aufbereitet: AUFB('ZZT-MARKER') });
  pruefe(r.success === true && r.status === 'aktiv', 'A aufbereiten macht roh -> aktiv', r);
  eintragId = rohId;
  const { rows } = await pool.query('SELECT herkunft_projekt, herkunft, aufbereitet_von FROM jev_entscheidungstopf WHERE id = $1', [rohId]);
  pruefe(rows[0]?.herkunft === 'tool' && rows[0]?.herkunft_projekt === PRJ && rows[0]?.aufbereitet_von === KOORD, 'A Herkunft tool, herkunft_projekt, aufbereitet_von', rows);
  const l = await E.fuehreJevTopfActionAus(PRJ, 'topf', { status: 'aktiv' });
  pruefe(l.success === true && l.namen?.includes('test-ausgabeformat'), 'O Dispatcher topf listet', l);
});

// --- T: Thought-Spiegel --------------------------------------------------------------------------
await versuche('T Thought-Spiegel', async () => {
  const id1 = '00000000-0000-4000-8000-00000000e1a1';
  const r = await T.spiegeleThoughtInTopf(PRJ, { id: id1, name: 'test-thought', source: 'koordinator', content: 'USER-ENTSCHEIDUNG: Variante B nehmen.', tags: ['entscheidung', 'user'] });
  const r2 = await T.spiegeleThoughtInTopf(PRJ, { id: id1, name: 'test-thought', source: 'koordinator', content: 'USER-ENTSCHEIDUNG: Variante B nehmen.', tags: ['entscheidung', 'user'] });
  const r3 = await T.spiegeleThoughtInTopf(PRJ, { id: '00000000-0000-4000-8000-00000000e1a2', source: 'x', content: 'nur Notiz', tags: ['notiz'] });
  const { rows } = await pool.query(`SELECT status, herkunft, quelle_ref, kandidat FROM jev_entscheidungstopf WHERE herkunft = 'thought'`);
  pruefe(rows.length === 1 && rows[0].status === 'roh' && rows[0].quelle_ref === id1 && rows[0].kandidat === false && r?.angelegt === true && r2?.angelegt === false,
    'T entscheidung+user -> genau ein roh-Eintrag (idempotent), nie Kandidat', { rows, r, r2 });
  pruefe(r3?.angelegt === false, 'T ohne Tags kein Eintrag (ANKER: mit Tags angelegt)', r3);
  const th = readFileSync(join(dist, 'services', 'thoughts.js'), 'utf8');
  pruefe((th.match(/spiegeleThoughtInTopf\(/g) ?? []).length >= 2, 'T addThought und addThoughtsBatch rufen den Spiegel');
});

// --- K: Kandidaten -----------------------------------------------------------------------------------
await versuche('K Kandidaten', async () => {
  for (let i = 0; i < 7; i++) {
    await T.legeEntscheidungAb({ name: `test-fuellung-${i}`, frage_de: `Fuellfrage ${i} zu Datenbank Index Nummer ${i}`, kategorie: 'umsetzungsweg', antwort_wortlaut: `Wortlaut ${i}`,
      aufbereitet: { de: { entscheidung: `Index ${i}`, begruendung: 'b', gilt_wenn: `Richtig bei Index ${i} Datenbank` }, en: { decision: `Index ${i}`, reason: 'r', applies_when: `Correct for database index ${i}` } } }, KOORD);
  }
  await T.legeEntscheidungAb({ name: 'test-loeschen', frage_de: 'Darf geloescht werden?', kategorie: 'loeschen', antwort_wortlaut: 'Nein', aufbereitet: AUFB('ZZT-VERBOTEN') }, KOORD);
  const k = await T.holeTopfKandidaten('Welches Ausgabeformat soll die Antwort des Tools haben, JSON oder Text?', { erlaubte: [...E.ERLAUBTE_KATEGORIEN] }, { embed: mockEmbed });
  pruefe(k.kandidaten.length === 6 && k.kandidaten[0].eintrag.id === eintragId && k.quelle === 'embedding', 'K Top 6, passender Eintrag zuerst, Quelle embedding', k.kandidaten.map((x) => [x.eintrag.frage_de, x.score]));
  pruefe(!k.kandidaten.some((x) => x.eintrag.kategorie === 'loeschen'), 'K verbotene Kategorie nie Kandidat');
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM jev_entscheidungstopf WHERE status = 'aktiv' AND embedding_en IS NOT NULL`);
  pruefe(rows[0].n >= 8, 'K Embeddings in PG gespeichert (PG ist die Wahrheit)', rows);
  const vorher = embedAufrufe.length;
  await T.holeTopfKandidaten('Ausgabeformat?', { erlaubte: [...E.ERLAUBTE_KATEGORIEN] }, { embed: mockEmbed });
  pruefe(embedAufrufe.length - vorher === 1, 'K zweiter Lauf embeddet nur die Frage (Cache in PG)', embedAufrufe.length - vorher);
});

// --- P: Praezedenz-Schritt ---------------------------------------------------------------------
const FRAGE = {
  agent_id: AG, typ: 'choice', kategorie: 'variante', frage: 'Welches Ausgabeformat soll die Antwort des Tools haben?',
  kontext: 'Task: neue Tool-Antwort fuer die Liste der Plaene.',
  optionen: { a: 'JSON-Objekt: richtig, wenn Maschinen die Antwort lesen', b: 'Fliesstext: richtig, wenn nur Menschen lesen', c: 'Tabelle in Markdown: richtig fuer Uebersichten', d: 'CSV: richtig fuer Tabellenexport', weitere: 'x' },
};
const opt = (extra = {}) => ({ ...FRAGE, ...extra });
const protokollZeile = async (id) => (await pool.query('SELECT * FROM jev_entscheidungen WHERE id = $1', [id])).rows[0];

await versuche('P Praezedenz', async () => {
  await E.setzeAbwesenheit(PRJ, { modus: 'an', agent_id: KOORD });
  // 1) beide Tore halten
  let f = fakeJev((k, q) => k === 'irreversibel' ? { noul: 0.05 } : k === 'praezedenz' ? { choice: keyMit(q, 'ZZT-MARKER'), confidence: 0.9 } : { choice: 'a', confidence: 0.85 });
  let r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === true && r.wahl === 'a' && r.praezedenz?.id === eintragId && f.aufrufe.length === 2, 'P beide Tore -> entschieden mit Praezedenz, zwei Aufrufe', { r, n: f.aufrufe.length });
  pruefe(f.aufrufe[0].questions?.irreversibel?.type === 'noul' && f.aufrufe[0].questions?.praezedenz?.criteria?.keine !== undefined && Object.keys(f.aufrufe[0].questions.praezedenz.criteria).length <= 7,
    'P Aufruf 1: irreversibel (noul) + praezedenz (choice Top 6 + keine)', f.aufrufe[0].questions);
  pruefe(!!f.aufrufe[1].state?.praezedenz && /state\.praezedenz/.test(f.aufrufe[1].questions?.entscheidung?.instructions ?? ''), 'P Aufruf 2 bekommt state.praezedenz', f.aufrufe[1]);
  let z = await protokollZeile(r.protokoll_id);
  pruefe(z?.praezedenz_id === eintragId && Math.abs(z?.praezedenz_confidence - 0.9) < 1e-9 && z?.ohne_praezedenz === false && Math.abs(z?.irreversibel_p - 0.05) < 1e-9,
    'P Protokoll: praezedenz_id, praezedenz_confidence, irreversibel_p', z);
  const { rows: g } = await pool.query('SELECT gewaehlt_n FROM jev_entscheidungstopf WHERE id = $1', [eintragId]);
  pruefe(g[0]?.gewaehlt_n === 1, 'P gewaehlt_n der Praezedenz +1', g);
  pruefe(/wie User-Entscheidung/.test(r.kennzeichnung ?? '') && /nicht vom User/.test(r.kennzeichnung ?? ''), 'P Kennzeichnung nennt Praezedenz und "nicht vom User"', r.kennzeichnung);
  const praezedenzEntscheidungId = r.protokoll_id;

  // 2) Praezedenz unter Tor 0,8 -> ohne Praezedenz entschieden (markiert)
  f = fakeJev((k, q) => k === 'irreversibel' ? { noul: 0.05 } : k === 'praezedenz' ? { choice: keyMit(q, 'ZZT-MARKER'), confidence: 0.75 } : { choice: 'b', confidence: 0.8 });
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  z = await protokollZeile(r.protokoll_id);
  pruefe(r.entschieden === true && r.ohne_praezedenz === true && !r.praezedenz && z?.ohne_praezedenz === true && z?.praezedenz_id === null && !f.aufrufe[1].state?.praezedenz,
    'P Praezedenz 0,75 < 0,8 -> Entscheidung OHNE Praezedenz, markiert', { r, z });
  const ohneId = r.protokoll_id;

  // 3) 'keine' -> ohne Praezedenz
  f = fakeJev((k) => k === 'irreversibel' ? { noul: 0.1 } : k === 'praezedenz' ? { choice: 'keine', confidence: 0.95 } : { choice: 'c', confidence: 0.9 });
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === true && r.ohne_praezedenz === true && f.aufrufe.length === 2, 'P keine -> ohne Praezedenz entschieden', r);

  // 4) Option unter Tor 0,7 trotz Praezedenz -> unsicher
  f = fakeJev((k, q) => k === 'irreversibel' ? { noul: 0.05 } : k === 'praezedenz' ? { choice: keyMit(q, 'ZZT-MARKER'), confidence: 0.95 } : { choice: 'a', confidence: 0.6 });
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === false && r.grund === 'unsicher', 'P Option 0,6 < 0,7 -> keine Entscheidung (beide Tore muessen halten)', r);

  // 5) Option entscheidung_ohne_praezedenz aus -> offene Frage, kein zweiter Aufruf
  await O.setzeJevOptionen({ entscheidung_ohne_praezedenz: false, agent: KOORD });
  f = fakeJev((k) => k === 'irreversibel' ? { noul: 0.05 } : k === 'praezedenz' ? { choice: 'keine', confidence: 0.9 } : { choice: 'a', confidence: 0.9 });
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === false && r.grund === 'keine_praezedenz' && r.offen_fuer_user === true && f.aufrufe.length === 1, 'P Option aus -> offene Frage, ein Aufruf', { r, n: f.aufrufe.length });
  await O.setzeJevOptionen({ entscheidung_ohne_praezedenz: true, agent: KOORD });

  // --- X: Sicherheit -------------------------------------------------------------------------------
  f = fakeJev(() => ({ choice: 'a', confidence: 0.99, noul: 0.01 }));
  r = await E.entscheideRueckfrage(PRJ, opt({ kategorie: 'live_db' }), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === false && r.grund === 'kategorie_verboten' && f.aufrufe.length === 0, 'X S1 live_db verboten, kein Aufruf', r);
  r = await E.entscheideRueckfrage(PRJ, opt({ frage: 'Sollen wir danach per git push nach main uebertragen?' }), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === false && r.grund === 'sicherheit_text' && f.aufrufe.length === 0 && (r.treffer ?? []).length > 0, 'X S2 Text-Scan (git push) -> nie autonom, kein Aufruf', r);
  r = await E.entscheideRueckfrage(PRJ, opt({ kontext: 'Danach DROP TABLE plans auf 192.168.50.65:5432.' }), { fetch: f, embed: mockEmbed });
  pruefe(r.grund === 'sicherheit_text' && f.aufrufe.length === 0, 'X S2 Text-Scan im kontext (DROP TABLE, Live-DB)', r);
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(f.aufrufe.length > 0 && r.grund !== 'sicherheit_text', 'X ANKER: harmlose Frage passiert den Scan (Aufruf erfolgt)', r);
  f = fakeJev((k, q) => k === 'irreversibel' ? { noul: 0.6 } : k === 'praezedenz' ? { choice: keyMit(q, 'ZZT-MARKER'), confidence: 0.95 } : { choice: 'a', confidence: 0.95 });
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === false && r.grund === 'sicherheit_irreversibel' && f.aufrufe.length === 1, 'X S2b Jev haelt die Aktion fuer irreversibel (0,6 >= 0,3) -> nie autonom', { r, n: f.aufrufe.length });
  const { rows: n } = await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE herkunft NOT IN ('tool', 'thought', 'seed', 'korrektur'))::int AS fremd FROM jev_entscheidungstopf`);
  const { rows: e } = await pool.query(`SELECT count(*)::int AS n FROM jev_entscheidungen WHERE project = $1 AND entschieden`, [PRJ]);
  pruefe(n[0].n === 10 && n[0].fremd === 0 && e[0].n >= 3, 'X S3 autonome Entscheidungen erzeugen keinen Topf-Eintrag (ANKER: Topf 10, Entscheidungen >= 3)', { topf: n[0], ent: e[0] });

  // --- W: Schalter entscheidungstopf aus -> alter Weg -----------------------------------------
  await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'entscheidungstopf', aktiv: false, agent: KOORD });
  f = fakeJev(() => ({ choice: 'a', confidence: 0.9 }));
  r = await E.entscheideRueckfrage(PRJ, opt(), { fetch: f, embed: mockEmbed });
  pruefe(r.entschieden === true && f.aufrufe.length === 1 && !f.aufrufe[0].questions.irreversibel && !r.ohne_praezedenz, 'W Schalter aus -> alter Weg (ein Aufruf, ohne Praezedenz-Schritt)', { r, q: f.aufrufe[0]?.questions });
  await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'entscheidungstopf', aktiv: true, agent: KOORD });

  // --- R: Durchsicht -------------------------------------------------------------------------------
  let d = await E.durchsichtEntscheidung(PRJ, { agent_id: AG });
  const liste = d.durchsicht_offen ?? [];
  const erstesMit = liste.findIndex((x) => x.ohne_praezedenz !== true);
  const letztesOhne = liste.map((x) => x.ohne_praezedenz === true).lastIndexOf(true);
  pruefe(d.success === true && liste.length >= 3 && letztesOhne >= 0 && (erstesMit === -1 || letztesOhne < erstesMit), 'R Durchsicht: Entscheidungen ohne Praezedenz zuerst', liste.map((x) => [x.id, x.ohne_praezedenz]));
  d = await E.durchsichtEntscheidung(PRJ, { agent_id: AG, id: praezedenzEntscheidungId, urteil: 'ok' });
  pruefe(d.success === false, 'R Durchsicht setzen nur Koordinator/User', d);
  d = await E.durchsichtEntscheidung(PRJ, { agent_id: KOORD, id: praezedenzEntscheidungId, urteil: 'ok' });
  z = await protokollZeile(praezedenzEntscheidungId);
  const { rows: b } = await pool.query('SELECT bestaetigt_n, korrigiert_n FROM jev_entscheidungstopf WHERE id = $1', [eintragId]);
  pruefe(d.success === true && z.durchsicht === 'bestaetigt' && z.durchsicht_von === KOORD && b[0].bestaetigt_n === 1, 'R ok -> bestaetigt, bestaetigt_n der Praezedenz +1', { d, z, b });
  d = await E.durchsichtEntscheidung(PRJ, { agent_id: KOORD, id: ohneId, name: 'test-korrektur-ohne', urteil: 'korrigieren', wahl: 'a', wortlaut: 'Nein, JSON war richtig.' });
  z = await protokollZeile(ohneId);
  const { rows: k } = await pool.query(`SELECT status, herkunft, quelle_ref, gewaehlte_option, antwort_wortlaut FROM jev_entscheidungstopf WHERE herkunft = 'korrektur'`);
  pruefe(d.success === true && z.durchsicht === 'korrigiert' && JSON.stringify(z.ueberstimmt_wahl) === '"a"' && k.length === 1 && k[0].status === 'roh'
    && k[0].gewaehlte_option === 'a' && k[0].antwort_wortlaut === 'Nein, JSON war richtig.' && k[0].quelle_ref === `jev_entscheidungen:${ohneId}` && !!d.neuer_eintrag,
    'R korrigieren -> ueberstimmt + neuer Topf-Eintrag herkunft korrektur (roh, Wortlaut des Users)', { d, z, k });
  d = await E.durchsichtEntscheidung(PRJ, { agent_id: KOORD, id: praezedenzEntscheidungId, name: 'test-korrektur-mit', urteil: 'korrigieren', wahl: 'b', wortlaut: 'Doch B.' });
  const { rows: b2 } = await pool.query('SELECT korrigiert_n FROM jev_entscheidungstopf WHERE id = $1', [eintragId]);
  pruefe(d.success === true && b2[0].korrigiert_n === 1, 'R korrigieren einer Praezedenz-Entscheidung -> korrigiert_n +1', b2);
  const aus = await E.setzeAbwesenheit(PRJ, { modus: 'aus', agent_id: KOORD });
  pruefe(Array.isArray(aus.durchsicht_offen) && aus.durchsicht_offen.length >= 1 && aus.durchsicht_offen[0].ohne_praezedenz === true, 'R abwesend aus liefert durchsicht_offen (ohne Praezedenz zuerst)', aus.durchsicht_offen);
});

// --- G: abwesend '*' ---------------------------------------------------------------------------------
await versuche('G abwesend *', async () => {
  pruefe((await E.leseAbwesenheit(PRJ2)).aktiv === false, 'G ANKER: vorher aus');
  const an = await E.setzeAbwesenheit('*', { modus: 'an', agent_id: KOORD });
  pruefe(an.success === true && (await E.leseAbwesenheit(PRJ2)).aktiv === true && (await E.leseAbwesenheit(PRJ)).aktiv === true, "G project '*' -> abwesend fuer alle Projekte", an);
  const aus = await E.setzeAbwesenheit('*', { modus: 'aus', agent_id: KOORD });
  pruefe(aus.success === true && (await E.leseAbwesenheit(PRJ2)).aktiv === false, "G '*' aus -> wieder da", aus);
});

// --- V: Tool jev auf beiden Strecken (stdio-Handler aus mcp-server, REST-Definition) -----------------
await versuche('V Tool-Strecken', async () => {
  const stdioPfad = join(hier, '..', '..', 'mcp-server', 'dist', 'tools', 'consolidated', 'jev.js');
  const restPfad = join(hier, '..', '..', 'rest-api', 'dist', 'routes', 'mcp.js');
  if (!existsSync(stdioPfad) || !existsSync(restPfad)) { pruefe(false, 'V dists mcp-server/rest-api vorhanden (vorher bauen)'); return; }
  const { jevTool } = await import(pathToFileURL(stdioPfad).href);
  const enumA = jevTool.definition.inputSchema.properties.action.enum;
  pruefe(['entscheidung_ablegen', 'entscheidung_aufbereiten', 'topf', 'durchsicht'].every((a) => enumA.includes(a)) && !!jevTool.definition.inputSchema.properties.aufbereitet,
    'V stdio: Actions + Parameter des Topfs in der Definition', enumA);
  const r = await jevTool.handler({ action: 'topf', project: PRJ, status: 'aktiv' });
  pruefe(r.success === true && Array.isArray(r.namen) && r.namen.length > 0, 'V stdio: jev(topf) ueber den Handler', r.anzahl);
  const rest = readFileSync(restPfad, 'utf8');
  pruefe(/istJevTopfAction\)?\(action\)/.test(rest) && /fuehreJevTopfActionAus\)?\(project, action, args\)/.test(rest) && /\.\.\.JEV_TOPF_PARAMETER/.test(rest) && /\.\.\.JEV_TOPF_ACTIONS/.test(rest),
    'V REST: Definition (Actions, Parameter) und Dispatcher eingebunden');
});

await aufraeumen();
await pool.query('DROP SCHEMA "' + privateSchema + '" CASCADE');
await pool.end().catch(() => undefined);
console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
