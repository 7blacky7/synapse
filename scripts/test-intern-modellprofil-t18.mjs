/**
 * P15-T18 (11.10.2026): modellprofil-Werkzeuge.
 *
 * ZUSAGEN (je mit Positivkontrolle, d. h. der Aufbau loest den alten Fehler wirklich aus):
 *   M1 messwerte werden TIEF gemischt: {hook:{b:{d:4}}} auf {hook:{a:1,b:{c:2,d:3}}} -> a und c bleiben
 *      (vorher ersetzte das Teil-Objekt den ganzen Zweck - so passiert in P15-T13).
 *   M2 null entfernt genau einen Schluessel. M3 messwerte_modus 'oben' = altes Verhalten (Zweck ersetzt,
 *      andere Zwecke bleiben). M4 'ersetzen' = gesamtes Objekt neu.
 *   K1 modellprofil_kalibrieren zweck tech_docs_gut: misst ueber searchTechDocs (scope all) OHNE Nachladen,
 *      framework je Anfrage kommt als Qdrant-Filter an; passend 0.8 / Rauschen 0.3 -> Vorschlag 0.55.
 *   K2 schreiben:true setzt die Schwelle und mischt die Messwerte tief (fruehere bleiben).
 *   E1 error_patterns: Treffer tragen die Beschreibung aus PG -> erwartet darf ein Teil der Beschreibung sein
 *      (vorher nur die UUID, P15-T13); die UUID funktioniert weiterhin.
 *   F1 unbekannter messwerte_modus -> parameter_ungueltig.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node scripts/test-intern-modellprofil-t18.mjs
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-intern-modellprofil-t18');

const MODELL = 'fake-t18-embed:latest';
const DIGEST = 'fedcba9876543210'.repeat(4);
const MUSTER_ID = '0d0d0d0d-1818-4f15-8a18-000000000018';

// Fake-Ollama: Texte mit PASSEND -> [1,0,...], sonst [0,1,0,...]
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: MODELL, model: MODELL, digest: DIGEST, size: 1000 }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } }));
    if (req.url === '/api/embed') {
      const a = JSON.parse(body);
      return res.end(JSON.stringify({ embeddings: a.input.map((t) => (/PASSEND/.test(t) ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0])) }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
// Fake-Qdrant: Suche liefert 0.8 fuer PASSEND-Vektoren, 0.3 sonst; Filter werden mitgeschrieben.
const filterLog = [];
let qdrantPfade = [];
let ERRP = '';
const qdrant = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    qdrantPfade.push(req.method + ' ' + u.pathname);
    if (req.method === 'GET' && u.pathname === '/') return res.end(JSON.stringify({ title: 'qdrant', version: '1.13.0' }));
    const m = /^\/collections\/([^/]+)\/points\/search$/.exec(u.pathname);
    if (m) {
      const b = JSON.parse(body || '{}');
      const name = decodeURIComponent(m[1]);
      filterLog.push({ name, filter: b.filter ?? null });
      const score = b.vector?.[0] === 1 ? 0.8 : 0.3;
      if (name === ERRP) return res.end(JSON.stringify({ status: 'ok', time: 0, result: [{ id: MUSTER_ID, version: 0, score: score - 0.1, payload: {} }] }));
      const fw = b.filter?.must?.find((x) => x.key === 'framework')?.match?.value ?? 'allg';
      return res.end(JSON.stringify({ status: 'ok', time: 0, result: [{ id: `doc-${fw}`, version: 0, score, payload: { framework: fw, section: `${fw}-abschnitt`, content: 'x', type: 'code-example', source: 'context7' } }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ status: { error: 'nicht im Fake' } }));
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
process.env.OLLAMA_MODEL = MODELL;
process.env.QDRANT_URL = `http://127.0.0.1:${qdrant.address().port}`;
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SYNAPSE_MODELLPROFIL_TTL_MS = '0';
process.env.SYNAPSE_INTERN_TOOL = '1';
delete process.env.CONTEXT7_API_KEY;
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_NUM_CTX', 'EMBEDDING_NUM_BATCH', 'EMBEDDING_MAX_INPUT_CHARS',
  'EMBEDDING_QUERY_PREFIX', 'EMBEDDING_DOC_PREFIX', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST',
  'SCORE_SCHWELLE_TECH_DOCS_GUT', 'SCORE_SCHWELLE_ERROR_PATTERNS', 'SYNAPSE_COMPUTE_NODE']) delete process.env[name];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) {
  console.error('ABBRUCH: Ollama/Qdrant zeigen auf Produktion.');
  process.exit(2);
}
const pflege = await lade(dist, 'services', 'intern-modellprofil.js');
const T = await lade(dist, 'services', 'intern-tool.js');
const profil = await lade(dist, 'embeddings', 'modell-profil.js');
const db = await lade(dist, 'db', 'client.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');
ERRP = COLLECTIONS.globalErrorPatterns;
const pool = db.getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 2000) : '')); }
}
const aufraeumen = async () => {
  await pool.query('DELETE FROM embedding_modell_profile WHERE modell = $1', [MODELL]);
  await pool.query('DELETE FROM error_patterns WHERE id = $1', [MUSTER_ID]);
};
const messwerte = async () => (await pool.query("SELECT messwerte FROM embedding_modell_profile WHERE modell = $1 AND digest = ''", [MODELL])).rows[0]?.messwerte;

try {
  await aufraeumen();
  profil.vergissModellprofil();
  await pflege.modellprofilSetzen({ modell: MODELL, query_praefix: '', dok_praefix: '', max_stueck_zeichen: 1000, messwerte: { hook: { a: 1, b: { c: 2, d: 3 } }, andere: { q: 1 } } });

  // M1..M4
  await pflege.modellprofilSetzen({ modell: MODELL, messwerte: { hook: { b: { d: 4 } } } });
  let m = await messwerte();
  pruefe(m?.hook?.a === 1 && m?.hook?.b?.c === 2 && m?.hook?.b?.d === 4 && m?.andere?.q === 1, 'M1 tief gemischt: a und b.c bleiben, b.d neu', m);
  await pflege.modellprofilSetzen({ modell: MODELL, messwerte: { hook: { a: null } } });
  m = await messwerte();
  pruefe(m?.hook && !('a' in m.hook) && m.hook.b?.c === 2, 'M2 null entfernt genau einen Schluessel', m);
  await pflege.modellprofilSetzen({ modell: MODELL, messwerte: { hook: { z: 1 } }, messwerte_modus: 'oben' });
  m = await messwerte();
  pruefe(JSON.stringify(m?.hook) === '{"z":1}' && m?.andere?.q === 1, 'M3 modus oben: Zweck ersetzt, andere bleiben', m);
  await pflege.modellprofilSetzen({ modell: MODELL, messwerte: { neu: { x: 1 } }, messwerte_modus: 'ersetzen' });
  m = await messwerte();
  pruefe(JSON.stringify(m) === '{"neu":{"x":1}}', 'M4 modus ersetzen: ganzes Objekt neu', m);

  // K1
  filterLog.length = 0;
  qdrantPfade = [];
  let r = await pflege.modellprofilKalibrieren({
    zweck: 'tech_docs_gut',
    passend: [{ query: 'PASSEND react hooks', framework: 'react', erwartet: 'react' }, { query: 'PASSEND vue slots', framework: 'vue' }],
    rauschen: [{ query: 'fremdes thema', framework: 'react' }, 'auch fremd'],
  });
  const fws = filterLog.map((f) => f.filter?.must?.find((x) => x.key === 'framework')?.match?.value ?? null);
  pruefe(r.trennbar === true && r.vorschlag === 0.55 && r.passend[0].rang === 1, 'K1 tech_docs_gut messbar: 0.8 vs 0.3 -> 0.55', r);
  pruefe(fws.includes('react') && fws.includes('vue') && fws.includes(null) && filterLog.every((f) => f.name === COLLECTIONS.techDocs),
    'K1 framework je Anfrage als Filter, nur tech_docs_cache (kein project)', filterLog);
  pruefe(qdrantPfade.every((p) => /points\/search$|^GET \/$/.test(p)), 'K1 nur Suchen, kein Schreiben/Nachladen', qdrantPfade);

  // K2
  r = await pflege.modellprofilKalibrieren({
    zweck: 'tech_docs_gut',
    passend: [{ query: 'PASSEND react hooks', framework: 'react' }],
    rauschen: [{ query: 'fremd', framework: 'react' }],
    schreiben: true, agent: 'diag-t18',
  });
  m = await messwerte();
  pruefe(r.geschrieben === true && r.profil?.score_schwellen?.tech_docs_gut === 0.55 && m?.neu?.x === 1 && typeof m?.tech_docs_gut?.passend_min === 'number',
    'K2 schreiben: Schwelle gesetzt, fruehere Messwerte bleiben', { r: r.profil, m });

  // E1
  await pool.query(
    `INSERT INTO error_patterns (id, description, fix, model_scope, found_by, found_in_model, embedded_at)
     VALUES ($1, 'Diag-Muster LIKE ohne ESCAPE', 'ESCAPE setzen', 'all', 'diag', 'diag', NOW())`, [MUSTER_ID],
  );
  r = await pflege.modellprofilKalibrieren({
    zweck: 'error_patterns',
    passend: [{ query: 'PASSEND like', erwartet: 'LIKE ohne ESCAPE' }, { query: 'PASSEND like 2', erwartet: MUSTER_ID.slice(0, 8) }],
    rauschen: ['fremd'],
  });
  pruefe(r.passend[0].rang === 1 && r.passend[0].score === 0.7 && r.passend[1].rang === 1 && /LIKE ohne ESCAPE/.test(r.passend[0].bester?.name ?? ''),
    'E1 error_patterns: Treffer mit Beschreibung, erwartet per Beschreibung und per ID', r.passend);

  // F1 + Weg ueber das Tool (Parameter kommen durch)
  let f = null;
  try { await pflege.modellprofilSetzen({ modell: MODELL, messwerte: { x: 1 }, messwerte_modus: 'quatsch' }); } catch (e) { f = e; }
  pruefe(f?.code === 'parameter_ungueltig', 'F1 unbekannter messwerte_modus', f?.message);
  r = await T.fuehreInternAus({
    action: 'modellprofil_kalibrieren', zweck: 'tech_docs_gut',
    passend: [{ query: 'PASSEND react', framework: 'react' }], rauschen: [{ query: 'fremd', framework: 'react' }],
  });
  pruefe(r.success && r.vorschlag === 0.55, 'R1 ueber fuehreInternAus: framework-Objekte kommen durch', r);
  r = await T.fuehreInternAus({ action: 'modellprofil_setzen', modell: MODELL, messwerte: { tief: { a: 1 } }, messwerte_modus: 'oben' });
  pruefe(r.success && r.profil?.messwerte?.tief?.a === 1, 'R2 ueber fuehreInternAus: messwerte_modus kommt durch', r);
} finally {
  await aufraeumen().catch(() => {});
  await db.closePool();
  ollama.close();
  qdrant.close();
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
