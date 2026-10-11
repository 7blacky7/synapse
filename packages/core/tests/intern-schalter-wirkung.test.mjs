/**
 * P14-T2 (11.10.2026): DIE INTERN-SCHALTER WIRKEN — embedding, parser, context7.
 *
 * ZUSAGEN:
 *   E1 modus hintergrund: embed(background) -> EMBEDDING_ANGEHALTEN, Fake-Ollama bekommt KEINE Anfrage;
 *      Kontrolle: embed(interaktiv) laeuft durch (Fake +1).
 *   E2 modus alle: auch interaktiv -> EMBEDDING_ANGEHALTEN, die Meldung nennt den Volltext-Weg; Fake unveraendert.
 *   E3 Schalter aus: background laeuft wieder (Fake +1).
 *   B1 Backlog angehalten: { angehalten:true, geprueft:0 }. ANKER: mit Schalter aus prueft derselbe Aufruf den
 *      Test-Thought (geprueft >= 1) — die 0 kommt also nicht von einer leeren Tabelle.
 *   N1 nebenlaeufiger Nachtrag (embeddeThoughtNach) angehalten: kehrt ohne Fehler zurueck, kein Ollama-Aufruf,
 *      embedded_at bleibt NULL. Kontrolle aus: derselbe Aufruf laeuft los und scheitert an Qdrant (127.0.0.1:9).
 *   K1 claimEmbeddingChunks angehalten: [] ohne Pool-Zugriff. Kontrolle aus: der (Attrappen-)Pool wird angefragt.
 *   L1 schalterHaeltAn: Beginn und Ende je Ablauf genau einmal im Log; modi-Filter wirkt.
 *   C1 context7AutomatikTick bei Schalter context7: ruht mit Logzeile, kein Netzaufruf, kein Lauf.
 *   V1 Nachtraege laufen als background (P5-T15): a) embeddeThoughtNach ohne Optionen wird vom Schalter
 *      hintergrund erfasst, mit priority interactive nicht (wartende Aufrufer); b) ein background-Auftrag wird
 *      von einem interaktiven embed verdraengt (preemptedBackground steigt, interaktiv ist zuerst fertig).
 *      Der volle Weg Nachtrag->Ollama braucht Qdrant (ensureCollection) und ist hier bewusst in a) und b) geteilt.
 *   P1 Parser-Worker (rest-api dist): die Schalter-Pruefung parser steht VOR projekteMitBacklog, die fuer
 *      embedding in der Claims-Schleife VOR claimEmbeddingChunks.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Ollama = lokale Attrappe, Qdrant
 * 127.0.0.1:9; zeigt die wirksame Konfiguration woanders hin, Abbruch mit Exit 2. fetch ist fuer alles
 * ausser 127.0.0.1 gesperrt (Context7 u. a.) — ein gesperrter Aufruf ist ein Fehler.
 *
 * AUFRUF (NUR gegen die Test-DB):
 *   set -a; . <test-db.env>; set +a; node packages/core/tests/intern-schalter-wirkung.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB/Dienste.
 * Braucht gebautes packages/core/dist und packages/rest-api/dist.
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

// ── Netzsperre: nur 127.0.0.1 ──
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

// ── Log mitschneiden ──
const log = [];
const echtesError = console.error.bind(console);
console.error = (...teile) => { log.push(teile.join(' ')); echtesError(...teile); };

// ── Fake-Ollama ──
let fakeEmbeds = 0;
let fakeMs = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'fake-embed' }] }));
    return;
  }
  // P12-T14: der Provider spricht /api/embed (Liste input -> Liste embeddings); /api/embeddings bleibt fuer Altes.
  if (req.url === '/api/embeddings' || req.url === '/api/embed') {
    fakeEmbeds++;
    let body = '';
    req.on('data', (d) => { body += d; });
    let fertig = false;
    let t;
    req.on('end', () => {
      t = setTimeout(() => {
        fertig = true;
        const vektor = Array.from({ length: 8 }, (_, i) => (i + 1) / 8);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/embeddings') return res.end(JSON.stringify({ embedding: vektor }));
        const eingabe = JSON.parse(body || '{}').input;
        const n = Array.isArray(eingabe) ? eingabe.length : 1;
        res.end(JSON.stringify({ embeddings: Array.from({ length: n }, () => vektor) }));
      }, fakeMs);
    });
    res.on('close', () => { if (!fertig) clearTimeout(t); });
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SYNAPSE_INTERN_CACHE_MS = '0';
delete process.env.SYNAPSE_COMPUTE_NODE;
delete process.env.EMBEDDING_TARGET_DIM;
delete process.env.SYNAPSE_CONTEXT7_AUTO;

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);

const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (wirksam.qdrant.url !== 'http://127.0.0.1:9' || wirksam.embeddings.ollama.url !== process.env.OLLAMA_URL
  || /192\.168\.50\.65/.test(wirksam.qdrant.url + wirksam.embeddings.ollama.url)) {
  console.error(`ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappen (qdrant=${wirksam.qdrant.url}, ollama=${wirksam.embeddings.ollama.url}).`);
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail) : '')); }
}
async function fange(p) {
  try { return { wert: await p }; } catch (err) { return { fehler: err }; }
}

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const ddl = schemaJs.match(/CREATE TABLE IF NOT EXISTS intern_schalter \([\s\S]*?\n\);/)?.[0];
if (!ddl) {
  console.log('FEHLER  DDL intern_schalter nicht im gebauten SCHEMA_SQL gefunden');
  process.exit(1);
}
await pool.query("SET lock_timeout = '5s'");
await pool.query(ddl);
await pool.query('DELETE FROM intern_schalter');

const S = await lade(dist, 'services', 'intern-schalter.js');
const emb = await lade(dist, 'embeddings', 'index.js');
const backlog = await lade(dist, 'services', 'embed-backlog.js');
const thoughts = await lade(dist, 'services', 'thoughts.js');
const claims = await lade(dist, 'services', 'embedding-claims.js');
const c7 = await lade(dist, 'services', 'context7-automatik.js');

const PROJECT = 'intern-wirkung-test';
const THOUGHT = 'intern-wirkung-t1';
const setze = (name, aktiv, modus) => S.setzeSchalter(name, { aktiv, modus, dauer_min: 10, grund: 'test', agent: 'intern-test' });

try {
  // Aufwaermen: Provider einmal anlegen, damit die Zaehlungen unten nur den Auftrag selbst sehen
  await emb.embed('Aufwaermen');

  // E1
  await setze('embedding', true, 'hintergrund');
  let vorher = fakeEmbeds;
  let r = await fange(emb.embed('Hallo Welt', { priority: 'background' }));
  pruefe(r.fehler?.code === 'EMBEDDING_ANGEHALTEN' && fakeEmbeds === vorher, 'E1 hintergrund: embed(background) angehalten, kein Ollama-Aufruf', r.fehler?.message);
  vorher = fakeEmbeds;
  r = await fange(emb.embed('Hallo Welt'));
  pruefe(Array.isArray(r.wert) && fakeEmbeds === vorher + 1, 'E1 Kontrolle: embed(interaktiv) laeuft durch (Fake +1)', r.fehler?.message);

  // E2
  await setze('embedding', true, 'alle');
  vorher = fakeEmbeds;
  r = await fange(emb.embed('Suchanfrage', { art: 'query' }));
  pruefe(r.fehler?.code === 'EMBEDDING_ANGEHALTEN' && /Volltext/.test(r.fehler?.message ?? '') && fakeEmbeds === vorher,
    'E2 alle: embed(interaktiv) angehalten mit Volltext-Hinweis, kein Ollama-Aufruf', r.fehler?.message);

  // E3
  await setze('embedding', false);
  vorher = fakeEmbeds;
  r = await fange(emb.embed('Hallo Welt', { priority: 'background' }));
  pruefe(Array.isArray(r.wert) && fakeEmbeds === vorher + 1, 'E3 aus: embed(background) laeuft wieder (Fake +1)', r.fehler?.message);

  // B1 + N1: ein Thought ohne Vektor
  await pool.query(
    `INSERT INTO thoughts (id, project, source, content, embedded_at) VALUES ($1, $2, 'test', 'Intern-Wirkung', NULL)
     ON CONFLICT (id) DO UPDATE SET embedded_at = NULL`,
    [THOUGHT, PROJECT],
  );
  await setze('embedding', true, 'hintergrund');
  const b1 = await backlog.embeddeOffeneEintraege(5, PROJECT);
  pruefe(b1.angehalten === true && b1.geprueft === 0, 'B1 Backlog angehalten: angehalten:true, geprueft 0', b1);

  vorher = fakeEmbeds;
  r = await fange(thoughts.embeddeThoughtNach(PROJECT, THOUGHT));
  const nachN1 = (await pool.query('SELECT embedded_at FROM thoughts WHERE id = $1', [THOUGHT])).rows[0];
  pruefe(!r.fehler && fakeEmbeds === vorher && nachN1.embedded_at === null,
    'N1 Nachtrag angehalten: ohne Fehler zurueck, kein Ollama-Aufruf, embedded_at NULL', r.fehler?.message);

  let verbunden = 0;
  const attrappe = { connect: async () => { verbunden++; throw new Error('attrappen-pool'); } };
  r = await fange(claims.claimEmbeddingChunks('intern-test', {}, attrappe));
  pruefe(Array.isArray(r.wert) && r.wert.length === 0 && verbunden === 0, 'K1 Claims angehalten: [] ohne Pool-Zugriff', r.fehler?.message);

  await setze('embedding', false);
  const b1k = await backlog.embeddeOffeneEintraege(5, PROJECT);
  pruefe(!b1k.angehalten && b1k.geprueft >= 1, 'B1 ANKER: Schalter aus -> derselbe Aufruf prueft den Test-Thought', b1k);
  r = await fange(thoughts.embeddeThoughtNach(PROJECT, THOUGHT));
  pruefe(r.fehler !== undefined, 'N1 Kontrolle: Schalter aus -> Nachtrag laeuft los (scheitert an Qdrant 127.0.0.1:9)', r.fehler?.message);
  r = await fange(claims.claimEmbeddingChunks('intern-test', {}, attrappe));
  pruefe(r.fehler?.message === 'attrappen-pool' && verbunden === 1, 'K1 Kontrolle: Schalter aus -> Pool wird angefragt', r.fehler?.message);

  // V1a: Nachtrag ohne Optionen = background (vom Schalter hintergrund erfasst), wartender Aufrufer interaktiv
  await setze('embedding', true, 'hintergrund');
  r = await fange(thoughts.embeddeThoughtNach(PROJECT, THOUGHT));
  const rInteraktiv = await fange(thoughts.embeddeThoughtNach(PROJECT, THOUGHT, { priority: 'interactive' }));
  pruefe(!r.fehler && rInteraktiv.fehler !== undefined,
    'V1a Nachtrag ohne Optionen = background (Schalter hintergrund greift); priority interactive laeuft los (Qdrant)', rInteraktiv.fehler?.message);
  await setze('embedding', false);

  // V1b: ein background-Auftrag (so laeuft der Nachtrag) wird von einem interaktiven embed verdraengt
  fakeMs = 300;
  const statsVorher = emb.getEmbeddingQueueStats();
  const reihenfolge = [];
  const hinter = emb.embed('Nachtrag', { priority: 'background' }).then(() => reihenfolge.push('background'));
  await new Promise((res) => setTimeout(res, 50));
  await emb.embed('Suche', { art: 'query' }).then(() => reihenfolge.push('interaktiv'));
  await hinter;
  fakeMs = 0;
  const statsNachher = emb.getEmbeddingQueueStats();
  pruefe(statsNachher.preemptedBackground > statsVorher.preemptedBackground && reihenfolge[0] === 'interaktiv' && reihenfolge.length === 2,
    'V1b background wird vom interaktiven embed verdraengt und laeuft danach zu Ende',
    { reihenfolge, vorher: statsVorher.preemptedBackground, nachher: statsNachher.preemptedBackground });

  // L1
  const zaehle = (muster) => log.filter((z) => z.includes(muster)).length;
  pruefe(await S.schalterHaeltAn('parser', 'test-ablauf') === null && zaehle('test-ablauf') === 0, 'L1 parser aus: null, kein Log');
  await setze('parser', true);
  const st = await S.schalterHaeltAn('parser', 'test-ablauf');
  await S.schalterHaeltAn('parser', 'test-ablauf');
  pruefe(st?.modus === 'pause' && zaehle('[intern] test-ablauf angehalten') === 1, 'L1 parser an: Stand + genau eine Logzeile Beginn', log.filter((z) => z.includes('test-ablauf')));
  await setze('parser', false);
  await S.schalterHaeltAn('parser', 'test-ablauf');
  await S.schalterHaeltAn('parser', 'test-ablauf');
  pruefe(zaehle('[intern] test-ablauf laeuft wieder') === 1, 'L1 parser aus: genau eine Logzeile Ende');
  await setze('embedding', true, 'hintergrund');
  pruefe(await S.schalterHaeltAn('embedding', 'test-modi', ['alle']) === null, 'L1 modi-Filter: hintergrund haelt einen alle-Ablauf nicht an');
  await setze('embedding', false);

  // C1
  await setze('context7', true);
  const c7LogVorher = zaehle('[context7-auto]');
  await c7.context7AutomatikTick();
  pruefe(zaehle('[intern] context7-automatik angehalten') === 1 && zaehle('[context7-auto]') === c7LogVorher && gesperrt.length === 0,
    'C1 context7 an: Automatik ruht mit Logzeile, kein Lauf, kein Netzaufruf', { gesperrt });
  process.env.SYNAPSE_CONTEXT7_AUTO = '0'; // kein weiterer Tick in diesem Prozess

  // P1
  const pw = readFileSync(join(repo, 'packages', 'rest-api', 'dist', 'services', 'parser-worker.js'), 'utf8');
  const iParser = pw.indexOf("schalterHaeltAn('parser', 'parser-worker')");
  const iBacklog = pw.indexOf('projekteMitBacklog(this.cfg.maxPerTick)');
  const iEmb = pw.indexOf("schalterHaeltAn('embedding', 'parser-worker/embedding-claims')");
  const iClaim = pw.indexOf("claimEmbeddingChunks('unraid-local'");
  pruefe(iParser > 0 && iBacklog > iParser && iEmb > 0 && iClaim > iEmb, 'P1 Parser-Worker: Pruefungen vor projekteMitBacklog bzw. claimEmbeddingChunks', { iParser, iBacklog, iEmb, iClaim });

  pruefe(gesperrt.length === 0, 'Netzsperre: kein Aufruf ausserhalb 127.0.0.1', gesperrt);
} finally {
  await pool.query('DELETE FROM thoughts WHERE id = $1', [THOUGHT]).catch(() => {});
  await pool.query('DELETE FROM intern_schalter').catch(() => {});
  await db.closePool();
  server.close();
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
