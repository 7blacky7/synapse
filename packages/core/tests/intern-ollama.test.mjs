/**
 * P14-T3 (11.10.2026): intern-Tool ollama_status / ollama_entladen / ollama_laden gegen ein Fake-Ollama.
 *
 * ZUSAGEN:
 *   O1 status: Version, geladene Modelle mit GPU-/CPU-Anteil aus size_vram/size, belegter VRAM, Embedding-Modelle
 *      ueber capabilities UND (wenn /api/show nichts liefert) ueber den Namen; LLM nicht in der Embedding-Liste.
 *   O2 entladen eines NICHT geladenen Modells: war_geladen:false und KEIN Lade-/Entladeaufruf an Ollama.
 *      ANKER: O3/O4 zeigen, dass dieselbe Zaehlung Aufrufe sieht, wenn welche stattfinden.
 *   O3 entladen eines geladenen Embedding-Modells: /api/embed mit keep_alive 0 und leerer Eingabe, entladen:true,
 *      vram_frei_mb; beim konfigurierten Modell und Schalter aus: hinweis_schalter.
 *   O4 entladen eines geladenen Sprachmodells: /api/generate mit keep_alive 0.
 *   O5 laden: nicht installiert -> modell_nicht_installiert ohne Ladeaufruf; installiert -> /api/embed mit keep_alive,
 *      geladen:true, ladezeit_ms; Name ohne Tag trifft :latest.
 *   O6 Dispatcher: fehlendes modell -> parameter_fehlt, keep_alive "bald" -> keep_alive_ungueltig, Ollama weg ->
 *      ollama_nicht_erreichbar (kein Wurf).
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2; gebraucht nur fuer den Schalter-Hinweis).
 * Ollama = lokale Attrappe, Qdrant 127.0.0.1:9, fetch fuer alles ausser 127.0.0.1 gesperrt.
 *
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/intern-ollama.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB/Dienste.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}

const echtesFetch = globalThis.fetch;
const gesperrt = [];
globalThis.fetch = (url, opts) => {
  const ziel = String(url instanceof Request ? url.url : url);
  if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(ziel)) {
    gesperrt.push(ziel);
    return Promise.reject(new Error('Netz im Test gesperrt: ' + ziel));
  }
  return echtesFetch(url, opts);
};

// ── Fake-Ollama mit Zustand ──
const GB = 1024 ** 3;
const installiert = [
  { name: 'qwen3-embedding:8b', size: 5 * GB, details: { family: 'qwen3', parameter_size: '7.6B', quantization_level: 'Q4_K_M' }, cap: ['embedding'] },
  { name: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest', size: GB, details: { family: 'llama' }, cap: null },
  { name: 'llama3.2:latest', size: 2 * GB, details: { family: 'llama', parameter_size: '3.2B' }, cap: ['completion'] },
];
const geladen = new Map([
  ['qwen3-embedding:8b', { size: 6 * GB, size_vram: 4.5 * GB, context_length: 8192 }],
  ['llama3.2:latest', { size: 3 * GB, size_vram: 3 * GB, context_length: 4096 }],
]);
const aufrufe = [];
let entladeAbbruch = false; // P15-T5: Entlade-Aufruf bricht ab, Ollama entlaedt trotzdem
const server = http.createServer((req, res) => {
  let roh = '';
  req.on('data', (c) => { roh += c; });
  req.on('end', () => {
    const body = roh ? JSON.parse(roh) : null;
    const json = (status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/version') return json(200, { version: '0.12.3' });
    if (req.url === '/api/tags') return json(200, { models: installiert.map(({ cap, ...m }) => m) });
    if (req.url === '/api/ps') {
      return json(200, { models: [...geladen].map(([name, g]) => ({ name, model: name, ...g, expires_at: '2026-10-11T12:00:00Z', details: installiert.find((m) => m.name === name)?.details })) });
    }
    if (req.url === '/api/show') {
      const m = installiert.find((x) => x.name === body.model);
      if (!m) return json(404, { error: 'model not found' });
      if (!m.cap) return json(500, { error: 'show kaputt' }); // erzwingt den Namens-Ersatz
      return json(200, { capabilities: m.cap });
    }
    if (req.url === '/api/embed' || req.url === '/api/generate') {
      aufrufe.push({ pfad: req.url, ...body });
      if (body.keep_alive === 0 && entladeAbbruch) { geladen.delete(body.model); return req.socket.destroy(); }
      if (body.keep_alive === 0) geladen.delete(body.model);
      else geladen.set(body.model, { size: GB, size_vram: GB, context_length: 2048 });
      return json(200, req.url === '/api/embed' ? { model: body.model, embeddings: [] } : { model: body.model, response: '', done: true });
    }
    json(404, { error: 'unbekannt' });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
process.env.OLLAMA_MODEL = 'qwen3-embedding:8b';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_INTERN_TOOL = '1';
process.env.SYNAPSE_INTERN_CACHE_MS = '0';
// P15-T5: ohne Env darf embedding_messen KEINE num_ctx/num_batch schicken (kein Code-Default)
delete process.env.EMBEDDING_NUM_CTX;
delete process.env.EMBEDDING_NUM_BATCH;

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (wirksam.embeddings.ollama.url !== process.env.OLLAMA_URL || /192\.168\.50\.65/.test(wirksam.qdrant.url + wirksam.embeddings.ollama.url)) {
  console.error(`ABBRUCH: Ollama/Qdrant zeigen nicht auf die Test-Attrappen (ollama=${wirksam.embeddings.ollama.url}).`);
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail) : '')); }
}

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const ddl = readFileSync(join(dist, 'db', 'schema.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS intern_schalter \([\s\S]*?\n\);/)?.[0];
await pool.query("SET lock_timeout = '5s'");
await pool.query(ddl);
await pool.query('DELETE FROM intern_schalter');
const T = await lade(dist, 'services', 'intern-tool.js');

try {
  // O1
  let r = await T.fuehreInternAus({ action: 'ollama_status' });
  const qwen = r.geladen?.find((m) => m.name === 'qwen3-embedding:8b');
  const embNamen = (r.embedding_modelle ?? []).map((m) => m.name).sort();
  pruefe(r.success && r.version === '0.12.3' && qwen?.gpu_prozent === 75 && qwen?.cpu_prozent === 25 && qwen?.kontext === 8192
    && r.vram_belegt_mb === Math.round(4.5 * 1024) + 3 * 1024, 'O1 status: Version, GPU 75 % / CPU 25 %, Kontext, belegter VRAM', r);
  pruefe(JSON.stringify(embNamen) === JSON.stringify(['hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest', 'qwen3-embedding:8b'])
    && r.embedding_modelle.find((m) => m.name.startsWith('hf.co'))?.erkannt_ueber === 'name'
    && r.embedding_modelle.find((m) => m.name.startsWith('qwen'))?.erkannt_ueber === 'capabilities',
    'O1 Embedding-Modelle: qwen ueber capabilities, Nemotron ueber Namen, llama nicht', r.embedding_modelle);

  // O2
  r = await T.fuehreInternAus({ action: 'ollama_entladen', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF' });
  pruefe(r.success && r.war_geladen === false && r.entladen === false && aufrufe.length === 0, 'O2 nicht geladen: nichts angefasst, kein Aufruf', { r, aufrufe });

  // O3
  r = await T.fuehreInternAus({ action: 'ollama_entladen', modell: 'qwen3-embedding:8b' });
  const a3 = aufrufe.at(-1);
  pruefe(r.success && r.entladen === true && r.vram_frei_mb === Math.round(4.5 * 1024) && a3?.pfad === '/api/embed' && a3.keep_alive === 0
    && Array.isArray(a3.input) && a3.input.length === 0 && !r.geladen.includes('qwen3-embedding:8b'),
    'O3 Embedding-Modell entladen: /api/embed keep_alive 0, leere Eingabe, vram_frei_mb', { r, a3 });
  pruefe(typeof r.hinweis_schalter === 'string', 'O3 konfiguriertes Modell + Schalter aus: hinweis_schalter', r);

  // O4
  r = await T.fuehreInternAus({ action: 'ollama_entladen', modell: 'llama3.2' });
  const a4 = aufrufe.at(-1);
  pruefe(r.success && r.entladen === true && a4?.pfad === '/api/generate' && a4.keep_alive === 0 && aufrufe.length === 2,
    'O4 Sprachmodell (Name ohne Tag) entladen: /api/generate keep_alive 0', { r, a4 });

  // O5
  r = await T.fuehreInternAus({ action: 'ollama_laden', modell: 'gibts-nicht:1b' });
  pruefe(!r.success && r.error === 'modell_nicht_installiert' && aufrufe.length === 2, 'O5 nicht installiert: modell_nicht_installiert, kein Ladeaufruf', r);
  r = await T.fuehreInternAus({ action: 'ollama_laden', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF', keep_alive: '45m' });
  const a5 = aufrufe.at(-1);
  pruefe(r.success && r.geladen === true && r.war_schon_geladen === false && r.art === 'embedding' && typeof r.ladezeit_ms === 'number'
    && a5?.pfad === '/api/embed' && a5.keep_alive === '45m' && a5.model === 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest',
    'O5 laden: Nemotron (ohne Tag) per /api/embed keep_alive 45m, geladen, Ladezeit', { r, a5 });

  // O7 (P15-T5): Entlade-Aufruf bricht ab, Modell ist laut /api/ps trotzdem weg -> Erfolg + hinweis_aufruf
  entladeAbbruch = true;
  r = await T.fuehreInternAus({ action: 'ollama_entladen', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF' });
  entladeAbbruch = false;
  pruefe(r.success && r.entladen === true && typeof r.hinweis_aufruf === 'string' && !r.geladen.some((n) => n.startsWith('hf.co')),
    'O7 Entlade-Aufruf abgebrochen, Modell aber entladen -> kein ollama_nicht_erreichbar, hinweis_aufruf', r);

  // O8 (P15-T5): embedding_messen mit num_ctx/num_batch -> in jedem /api/embed; ohne Angabe und ohne Env -> keine options
  const vorO8 = aufrufe.length;
  r = await T.fuehreInternAus({ action: 'embedding_messen', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF', anzahl: 2, num_ctx: 4096, num_batch: 1024 });
  const mitOpt = aufrufe.slice(vorO8);
  pruefe(r.success && mitOpt.length === 4 && mitOpt.every((a) => a.options?.num_ctx === 4096 && a.options?.num_batch === 1024)
    && r.optionen?.num_ctx === 4096 && r.optionen?.quelle?.num_batch === 'aufruf',
    'O8 embedding_messen: num_ctx/num_batch in Lade-, Einzel- und Batch-Aufruf, Antwort nennt Quelle', { r, mitOpt });
  const vorO8b = aufrufe.length;
  r = await T.fuehreInternAus({ action: 'embedding_messen', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF', anzahl: 2 });
  const ohneOpt = aufrufe.slice(vorO8b);
  pruefe(r.success && ohneOpt.length >= 3 && ohneOpt.every((a) => a.options === undefined) && r.optionen?.num_ctx === null,
    'O8 ohne Angabe und ohne Env: keine options (kein Code-Default)', { r, ohneOpt });
  r = await T.fuehreInternAus({ action: 'embedding_messen', modell: 'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF', num_ctx: -5 });
  pruefe(!r.success && r.error === 'parameter_ungueltig', 'O8 num_ctx -5 -> parameter_ungueltig', r);

  // O6
  r = await T.fuehreInternAus({ action: 'ollama_entladen' });
  pruefe(!r.success && r.error === 'parameter_fehlt', 'O6 entladen ohne modell -> parameter_fehlt', r);
  r = await T.fuehreInternAus({ action: 'ollama_laden', modell: 'llama3.2', keep_alive: 'bald' });
  pruefe(!r.success && r.error === 'keep_alive_ungueltig', 'O6 keep_alive "bald" -> keep_alive_ungueltig', r);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  r = await T.fuehreInternAus({ action: 'ollama_status' });
  pruefe(!r.success && r.error === 'ollama_nicht_erreichbar', 'O6 Ollama weg -> ollama_nicht_erreichbar (kein Wurf)', r);

  pruefe(gesperrt.length === 0, 'Netzsperre: kein Aufruf ausserhalb 127.0.0.1', gesperrt);
} finally {
  await pool.query('DELETE FROM intern_schalter').catch(() => {});
  await db.closePool();
  if (server.listening) { server.closeAllConnections(); server.close(); }
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
