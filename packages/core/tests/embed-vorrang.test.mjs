/**
 * P5-T15 (11.10.2026): KI-ANFRAGEN HABEN IMMER VORRANG VOR HINTERGRUND-EMBEDDINGS — Lasttest.
 *
 * BEFUND (t37): memory read 51 s, memory update 113 s, waehrend ~1700 Context7-Chunks je einen
 * nebenlaeufigen Embedding-Nachtrag anstiessen. Jeder holte zuerst eine Verbindung aus dem einen
 * pg-Pool (max 20, FIFO); die Tool-Anfragen standen dahinter.
 *
 * AUFBAU:
 *   - Fake-Ollama (node http, FAKE_EMBED_MS je Embed, merkt abgebrochene Anfragen) — kein GPU-Server.
 *   - 500 Hintergrundauftraege in imHintergrund: je eine Verbindung (pg_sleep) + ein Embedding
 *     mit priority 'background'.
 *   - 5 parallele parseAndEmbed-artige Ablaeufe im Hintergrund (Client halten, BEGIN,
 *     pg_advisory_xact_lock, Arbeit, COMMIT) — wie parseUnparsedFiles mit 5 Workern; eine
 *     Verklemmung im kleinen Hintergrund-Pool fiele hier als Timeout auf.
 *   - Waehrenddessen interaktiv: Lesen (Haupt-Pool), Schreiben (derselbe PG-Schreibschritt wie
 *     writeMemory — writeMemory selbst braucht Qdrant, das es im Test nicht gibt), embed() — je < 2 s.
 *   - ABSICHERUNG: Qdrant zeigt hart auf eine unerreichbare lokale Adresse, Ollama auf den Fake;
 *     zeigt die wirksame Konfiguration auf etwas anderes (z. B. 192.168.50.65), bricht der Test ab.
 *   - KONTROLLE: der Hintergrund-Pool war wirklich gesaettigt (waitingCount > 0) und es wurde
 *     wirklich verdraengt (Abbrueche > 0) — sonst waere gruen nur ein Zeichen fehlender Last.
 *
 * AUFRUF (NUR gegen die Test-DB, nie Produktion):
 *   set -a; . <test-db.env>; set +a; node packages/core/tests/embed-vorrang.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB (Abbruch vor allem).
 * Braucht ein gebautes packages/core/dist. Schreibt nur Memories im Projekt PROJECT und raeumt sie ab.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}

const PROJECT = 'embed-vorrang-test';
const EMBED_MS = Number(process.env.FAKE_EMBED_MS ?? 100);
const GRENZE_MS = 2000;

// ── Fake-Ollama ──
let fakeAnfragen = 0;
let fakeAbbrueche = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'fake-embed' }] }));
    return;
  }
  // P15-T7: der Provider spricht seit bcee710 /api/embed (Liste input -> Liste embeddings); der Fake
  // bediente nur /api/embeddings, damit war der Test rot, ohne dass es am Vorrang lag.
  if (req.url === '/api/embed') {
    fakeAnfragen++;
    let body = '';
    let fertig = false;
    let t = null;
    req.on('data', (stueck) => { body += stueck; });
    req.on('end', () => {
      let n = 1;
      try { const input = JSON.parse(body).input; n = Array.isArray(input) ? input.length : 1; } catch { /* ein Text */ }
      t = setTimeout(() => {
        fertig = true;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: Array.from({ length: n }, () => Array.from({ length: 8 }, (_, i) => (i + 1) / 8)) }));
      }, EMBED_MS);
    });
    res.on('close', () => { if (!fertig) { if (t) clearTimeout(t); fakeAbbrueche++; } });
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.QDRANT_URL = 'http://127.0.0.1:9'; // Qdrant bewusst unerreichbar: Nachtraege scheitern im Hintergrund
process.env.EMBED_MAX_CONCURRENT = '2';
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SYNAPSE_DB_HINTERGRUND_MAX = process.env.SYNAPSE_DB_HINTERGRUND_MAX || '8';
delete process.env.EMBEDDING_TARGET_DIM;
// P15-T8: Praefixe kommen sonst aus dem Modellprofil (PG) - hier geht es nur um den Vorrang.
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const emb = await import(join(dist, 'embeddings', 'index.js'));
const db = await import(join(dist, 'db', 'client.js'));
const { getConfig } = await import(join(dist, 'config.js'));
// Der Test darf Produktionsdienste NIE erreichen — auch nicht ueber einen spaeter hinzugefuegten Aufruf.
const wirksam = getConfig();
if (wirksam.qdrant.url !== 'http://127.0.0.1:9' || /192\.168\.50\.65/.test(wirksam.qdrant.url)
  || wirksam.embeddings.ollama.url !== process.env.OLLAMA_URL || /192\.168\.50\.65/.test(wirksam.embeddings.ollama.url)) {
  console.error(`ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappen (qdrant=${wirksam.qdrant.url}, ollama=${wirksam.embeddings.ollama.url}).`);
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
const dauer = async (fn) => { const t = Date.now(); await fn(); return Date.now() - t; };

try {
  await db.getPool().query('DELETE FROM memories WHERE project = $1', [PROJECT]);

  // ── Kontext-Weiche ──
  const innen = await db.imHintergrund(async () => db.getPool() === db.getHintergrundPool() && db.istImHintergrund());
  pruefe(innen && db.getPool() !== db.getHintergrundPool() && !db.istImHintergrund(),
    'imHintergrund: getPool() liefert darin den Hintergrund-Pool, draussen den Haupt-Pool');

  // ── Last starten ──
  const hp = db.getHintergrundPool();
  let maxWartend = 0;
  let maxBelegtHintergrund = 0;
  const beobachter = setInterval(() => {
    maxWartend = Math.max(maxWartend, hp.waitingCount);
    maxBelegtHintergrund = Math.max(maxBelegtHintergrund, hp.totalCount);
  }, 20);

  const hintergrund = Array.from({ length: 500 }, (_, i) => db.imHintergrund(async () => {
    const c = await db.getPool().connect();
    try { await c.query('SELECT pg_sleep(0.02)'); } finally { c.release(); }
    return emb.embed(`hintergrund ${i}`, { priority: 'background' });
  }));
  const parseArtig = Array.from({ length: 5 }, (_, w) => db.imHintergrund(async () => {
    for (let r = 0; r < 10; r++) {
      const c = await db.getPool().connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`embed-vorrang-test:${w % 2}`]);
        await c.query('SELECT pg_sleep(0.05)');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    }
    return w;
  }));

  await new Promise((r) => setTimeout(r, 300));

  // ── Interaktiv messen ──
  const zeiten = { lesen: [], schreiben: [], embed: [] };
  let hauptWartendMax = 0;
  for (let n = 0; n < 10; n++) {
    zeiten.lesen.push(await dauer(() => db.getPool().query('SELECT count(*) FROM memories WHERE project = $1', [PROJECT])));
    // Derselbe PG-Schreibschritt wie writeMemory (memory.ts), ueber den Haupt-Pool
    zeiten.schreiben.push(await dauer(() => db.getPool().query(
      `INSERT INTO memories (id, project, name, category, content, tags, created_at, updated_at)
       VALUES ($1, $2, $3, 'note', $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW(), embedded_at = NULL`,
      [`${PROJECT}-${n}`, PROJECT, `vorrang-${n}`, `Inhalt ${n}`, ['test']],
    )));
    zeiten.embed.push(await dauer(() => emb.embed(`frage ${n}`, { art: 'query' })));
    hauptWartendMax = Math.max(hauptWartendMax, db.getPool().waitingCount);
    await new Promise((r) => setTimeout(r, 150));
  }
  const max = (a) => Math.max(...a);
  console.log(`INFO    interaktiv max ms: lesen ${max(zeiten.lesen)}, schreiben ${max(zeiten.schreiben)}, embed ${max(zeiten.embed)}`);
  pruefe(max(zeiten.lesen) < GRENZE_MS, `interaktives Lesen unter Last < ${GRENZE_MS} ms`, zeiten.lesen);
  pruefe(max(zeiten.schreiben) < GRENZE_MS, `interaktives Schreiben (Memory-Schreibschritt) unter Last < ${GRENZE_MS} ms`, zeiten.schreiben);
  pruefe(max(zeiten.embed) < GRENZE_MS, `interaktives embed() unter Last < ${GRENZE_MS} ms`, zeiten.embed);
  pruefe(hauptWartendMax === 0, 'Haupt-Pool: keine wartende Anfrage waehrend der Last', hauptWartendMax);

  // ── Kontrollen: die Last war echt ──
  const statsMitte = emb.getEmbeddingQueueStats();
  pruefe(maxWartend > 0, 'KONTROLLE: Hintergrund-Pool war gesaettigt (waitingCount > 0)', { maxWartend });
  pruefe(maxBelegtHintergrund <= Number(process.env.SYNAPSE_DB_HINTERGRUND_MAX), 'Hintergrund-Pool bleibt in seiner Grenze', { maxBelegtHintergrund });
  pruefe(statsMitte.preemptedBackground > 0 && fakeAbbrueche > 0, 'KONTROLLE: laufende Hintergrund-Aufrufe wurden fuer interaktive verdraengt (Abbruch)',
    { preempted: statsMitte.preemptedBackground, fakeAbbrueche });

  // ── Danach laeuft der Rest automatisch weiter ──
  const ergebnisse = await Promise.allSettled(hintergrund);
  const ok = ergebnisse.filter((e) => e.status === 'fulfilled' && Array.isArray(e.value) && e.value.length === 8).length;
  pruefe(ok === 500, 'alle 500 Hintergrundauftraege am Ende fertig (verdraengte neu eingereiht)', { ok, fehler: ergebnisse.find((e) => e.status === 'rejected')?.reason?.message });
  const parse = await Promise.allSettled(parseArtig);
  pruefe(parse.every((p) => p.status === 'fulfilled'), 'parseAndEmbed-artige Ablaeufe ohne Verklemmung/Timeout fertig', parse.filter((p) => p.status === 'rejected').map((p) => p.reason?.message));
  clearInterval(beobachter);
  const stats = emb.getEmbeddingQueueStats();
  console.log(`INFO    Fake-Ollama: ${fakeAnfragen} Anfragen, ${fakeAbbrueche} abgebrochen; Queue: ${JSON.stringify({ completed: stats.completed, preempted: stats.preemptedBackground, longestWaitMs: stats.longestWaitMs })}`);
  pruefe(stats.active.interactive === 0 && stats.active.background === 0 && stats.queued.background === 0, 'Queue am Ende leer', stats);
} catch (error) {
  fehler++;
  console.error('ABBRUCH ' + (error?.stack ?? error));
} finally {
  // Hintergrund-Nachtraege der Memories scheitern an Qdrant (gewollt) — kurz ausklingen lassen.
  await new Promise((r) => setTimeout(r, 500));
  await db.getPool().query('DELETE FROM memories WHERE project = $1', [PROJECT]).catch((e) => { fehler++; console.error('Aufraeumen: ' + e.message); });
  const rest = (await db.getPool().query('SELECT count(*)::int AS n FROM memories WHERE project = $1', [PROJECT])).rows[0].n;
  console.log(`AUFGERAEUMT (Rest ${rest})`);
  await db.closePool();
  server.close();
}
console.log(fehler === 0 ? 'ALLE PRUEFUNGEN GRUEN' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
