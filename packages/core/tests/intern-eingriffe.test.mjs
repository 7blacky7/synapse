/**
 * P14-T5 (11.10.2026): intern-Tool nachzug_jetzt / embedding_messen.
 *
 * ZUSAGEN:
 *   M1 embedding_messen gegen ein Fake-Ollama: nicht geladenes Modell -> Ladeaufruf (input [], keep_alive) mit
 *      ladezeit_ms; genau anzahl Einzelaufrufe + 1 Batch; jede Eingabe beginnt mit dem Praefix ("passage: ",
 *      Leerzeichen erhalten); Dimension aus der Antwort; Median/Max/Min und Passagen/s; ps-Auszug des Modells.
 *   M2 Warnungen: ein anderes geladenes Modell und Schalter embedding aus werden genannt; mit Schalter an und
 *      ohne fremdes Modell (ANKER: dieselbe Messung) keine solche Warnung.
 *   M3 kein Schreiben: waehrend der Messung gehen Netzaufrufe NUR an das Fake-Ollama (kein Qdrant), und in PG
 *      aendert sich nichts ausser intern_schalter (Zeilenzahl thoughts/memories im Testprojekt unveraendert).
 *   M4 Fehler: nicht installiert -> modell_nicht_installiert, anzahl 0/201 -> parameter_ungueltig, ohne modell ->
 *      parameter_fehlt.
 *   N1 nachzug_jetzt: ein offener Test-Thought wird mit tabelle thoughts geprueft (scheitert an Qdrant 127.0.0.1:9,
 *      bleibt offen); mit tabelle memories wird er NICHT angefasst; Schalter embedding an -> angehalten + hinweis;
 *      ungueltige tabelle -> parameter_ungueltig.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2); Ollama = Attrappe, Qdrant 127.0.0.1:9;
 * fetch fuer alles ausser 127.0.0.1 gesperrt.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/intern-eingriffe.test.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('intern-eingriffe.test');

const echtesFetch = globalThis.fetch;
const netz = [];
const gesperrt = [];
globalThis.fetch = (url, opts) => {
  const ziel = String(url instanceof Request ? url.url : url);
  netz.push(ziel);
  if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(ziel)) {
    gesperrt.push(ziel);
    return Promise.reject(new Error('Netz im Test gesperrt: ' + ziel));
  }
  return echtesFetch(url, opts);
};

// ── Fake-Ollama ──
const GB = 1024 ** 3;
const MESS = 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest';
const installiert = [{ name: MESS, size: GB, details: { family: 'llama' } }, { name: 'qwen3-embedding:8b', size: 5 * GB, details: {} }];
const geladen = new Map([['qwen3-embedding:8b', { size: 6 * GB, size_vram: 6 * GB }]]);
const embedAufrufe = [];
const server = http.createServer((req, res) => {
  let roh = '';
  req.on('data', (c) => { roh += c; });
  req.on('end', () => {
    const body = roh ? JSON.parse(roh) : null;
    const json = (status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/tags') return json(200, { models: installiert });
    if (req.url === '/api/ps') return json(200, { models: [...geladen].map(([name, g]) => ({ name, ...g, context_length: 2048 })) });
    if (req.url === '/api/show') return json(200, { capabilities: ['embedding'] });
    if (req.url === '/api/embed') {
      embedAufrufe.push(body);
      geladen.set(body.model, { size: GB, size_vram: GB });
      const eingaben = Array.isArray(body.input) ? body.input : [body.input];
      return json(200, { model: body.model, embeddings: eingaben.map(() => Array.from({ length: 16 }, (_, i) => i / 16)) });
    }
    json(404, { error: 'unbekannt' });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const FAKE = `http://127.0.0.1:${server.address().port}`;

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = FAKE;
process.env.OLLAMA_MODEL = 'qwen3-embedding:8b';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_INTERN_TOOL = '1';
process.env.SYNAPSE_INTERN_CACHE_MS = '0';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (wirksam.embeddings.ollama.url !== FAKE || wirksam.qdrant.url !== 'http://127.0.0.1:9') {
  console.error('ABBRUCH: Ollama/Qdrant zeigen nicht auf die Test-Attrappen.');
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 2000) : '')); }
}

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const ddl = readFileSync(join(dist, 'db', 'schema.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS intern_schalter \([\s\S]*?\n\);/)?.[0];
await pool.query("SET lock_timeout = '5s'");
await pool.query(ddl);
await pool.query('DELETE FROM intern_schalter');
const S = await lade(dist, 'services', 'intern-schalter.js');
const T = await lade(dist, 'services', 'intern-tool.js');
const PROJECT = 'intern-eingriffe-test';
const THOUGHT = 'intern-eingriffe-t1';
const zeilen = async () => (await pool.query(
  `SELECT (SELECT count(*) FROM thoughts WHERE project = $1)::int + (SELECT count(*) FROM memories WHERE project = $1)::int AS n`, [PROJECT])).rows[0].n;

try {
  // M1 + M2 (Schalter aus, qwen geladen)
  const zeilenVorher = await zeilen();
  const netzVorher = netz.length;
  let r = await T.fuehreInternAus({ action: 'embedding_messen', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF', anzahl: 5, praefix: 'passage: ' });
  const ladeAufruf = embedAufrufe[0];
  const einzel = embedAufrufe.filter((b) => typeof b.input === 'string');
  const batch = embedAufrufe.filter((b) => Array.isArray(b.input) && b.input.length > 0);
  pruefe(r.success && r.war_schon_geladen === false && typeof r.ladezeit_ms === 'number' && Array.isArray(ladeAufruf?.input) && ladeAufruf.input.length === 0 && ladeAufruf.keep_alive === '10m',
    'M1 nicht geladen: Ladeaufruf mit leerer Eingabe, ladezeit_ms', { r, ladeAufruf });
  pruefe(einzel.length === 5 && batch.length === 1 && batch[0].input.length === 5 && [...einzel.map((b) => b.input), ...batch[0].input].every((t) => t.startsWith('passage: ') && !t.startsWith('passage:  ')),
    'M1 genau 5 Einzelaufrufe + 1 Batch, Praefix "passage: " mit genau einem Leerzeichen', { einzel: einzel.map((b) => b.input) });
  pruefe(r.dimension === 16 && typeof r.einzeln?.median_ms === 'number' && r.einzeln.max_ms >= r.einzeln.min_ms && r.einzeln.passagen_pro_s > 0 && r.batch?.passagen_pro_s > 0 && r.ollama_ps?.name === MESS,
    'M1 Dimension 16, Median/Max/Min, Passagen/s, ps-Auszug', r);
  pruefe(r.warnungen.some((w) => /anderes Modell/.test(w) && /qwen3-embedding/.test(w)) && r.warnungen.some((w) => /Schalter embedding ist aus/.test(w)),
    'M2 Warnungen: anderes Modell geladen + Schalter aus', r.warnungen);
  // M3
  const messNetz = netz.slice(netzVorher);
  pruefe(messNetz.length > 0 && messNetz.every((u) => u.startsWith(FAKE)) && (await zeilen()) === zeilenVorher,
    'M3 waehrend der Messung nur Aufrufe an Ollama, keine neuen Zeilen in PG', { fremd: messNetz.filter((u) => !u.startsWith(FAKE)) });

  // M2 ANKER: Schalter an, qwen entladen -> keine der beiden Warnungen
  await S.setzeSchalter('embedding', { aktiv: true, dauer_min: 10, grund: 'test' });
  geladen.delete('qwen3-embedding:8b');
  r = await T.fuehreInternAus({ action: 'embedding_messen', modell: MESS, anzahl: 3 });
  pruefe(r.success && r.war_schon_geladen === true && r.ladezeit_ms === null && !r.warnungen.some((w) => /anderes Modell|Schalter embedding/.test(w)),
    'M2 ANKER: Schalter an, nur Messmodell geladen -> keine dieser Warnungen, keine Ladezeit', r.warnungen);

  // M4
  r = await T.fuehreInternAus({ action: 'embedding_messen', modell: 'gibts-nicht' });
  const r0 = await T.fuehreInternAus({ action: 'embedding_messen', modell: MESS, anzahl: 0 });
  const r201 = await T.fuehreInternAus({ action: 'embedding_messen', modell: MESS, anzahl: 201 });
  const rOhne = await T.fuehreInternAus({ action: 'embedding_messen' });
  pruefe(r.error === 'modell_nicht_installiert' && r0.error === 'parameter_ungueltig' && r201.error === 'parameter_ungueltig' && rOhne.error === 'parameter_fehlt',
    'M4 Fehlercodes', { r, r0, r201, rOhne });

  // N1 (Schalter ist noch an)
  await pool.query(
    `INSERT INTO thoughts (id, project, source, content, embedded_at) VALUES ($1, $2, 'test', 'Nachzug', NULL)
     ON CONFLICT (id) DO UPDATE SET embedded_at = NULL`,
    [THOUGHT, PROJECT],
  );
  r = await T.fuehreInternAus({ action: 'nachzug_jetzt', project: PROJECT, tabelle: 'thoughts' });
  pruefe(r.success && r.angehalten === true && r.geprueft === 0 && /Schalter embedding/.test(r.hinweis ?? ''), 'N1 Schalter an: angehalten + hinweis', r);
  await S.setzeSchalter('embedding', { aktiv: false });
  r = await T.fuehreInternAus({ action: 'nachzug_jetzt', project: PROJECT, tabelle: 'memories', limit: 5 });
  pruefe(r.success && r.geprueft === 0 && r.tabelle === 'memories', 'N1 tabelle memories: der Thought wird nicht angefasst', r);
  r = await T.fuehreInternAus({ action: 'nachzug_jetzt', project: PROJECT, tabelle: 'thoughts', limit: 5 });
  pruefe(r.success && r.geprueft === 1 && r.fehlgeschlagen === 1 && r.offen_danach?.thoughts === 1 && typeof r.dauer_ms === 'number',
    'N1 tabelle thoughts: Test-Thought geprueft, scheitert an Qdrant, bleibt offen', r);
  r = await T.fuehreInternAus({ action: 'nachzug_jetzt', tabelle: 'code_chunks' });
  pruefe(!r.success && r.error === 'parameter_ungueltig', 'N1 ungueltige tabelle -> parameter_ungueltig', r);

  pruefe(gesperrt.length === 0, 'Netzsperre: kein Aufruf ausserhalb 127.0.0.1', gesperrt);
} finally {
  await pool.query('DELETE FROM thoughts WHERE id = $1', [THOUGHT]).catch(() => {});
  await pool.query('DELETE FROM intern_schalter').catch(() => {});
  await db.closePool();
  server.closeAllConnections();
  server.close();
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
