/**
 * MODUL: Tech-Docs nach PostgreSQL (P12-T16, Punkt 4: Migration des Bestands)
 * ZWECK: Bringt den Tech-Docs-Bestand auf den PG-first-Stand. Bis P12-T16 stand die
 *        Projektzuordnung NUR in Qdrant (welche Collection den Punkt haelt), und der alte
 *        docs-indexer/cacheDoc schrieb Context7-Chunks NUR nach Qdrant. Vor dem Re-Embedding
 *        (P12-T12, Quelle = PG) muss beides in tech_docs stehen, sonst geht es verloren.
 *
 * ⚠️ WANN: DIREKT NACH DEM DEPLOY von P12-T16 ausfuehren. Bis dahin haben ALLE Bestandszeilen
 *    project NULL und gelten als global. Der Code ist darauf vorbereitet (Airbag liest
 *    project NULL mit, Suche bleibt auf den Collections), aber der Zustand soll kurz bleiben.
 *
 * WAS ES TUT (Quelle der Zuordnung = Qdrant, project_<p>_docs und tech_docs_cache):
 *   A) research/manual-Zeilen mit project NULL, deren Punkt in project_<p>_docs liegt
 *      -> tech_docs.project = <p>. Liegt der Punkt in mehreren Projekten: nur gemeldet.
 *   B) research/manual-Zeilen ohne Projekt-Collection -> NUR AUFGELISTET (User entscheidet).
 *   C) Context7-Zeilen, deren Punkt in einer project_<p>_docs liegt -> bleiben global
 *      (project NULL), embedded_at = NULL (Backlog bettet nach tech_docs_cache ein), der
 *      verirrte Punkt in project_<p>_docs wird geloescht (erst NACH dem PG-Commit).
 *   D) Context7-Zeilen ganz ohne Punkt -> embedded_at = NULL (Backlog holt den Vektor nach).
 *   E) Qdrant-Punkte OHNE PG-Zeile (alter Qdrant-only-Weg) -> als Zeile importiert:
 *      aus project_<p>_docs mit project <p> (Context7-Punkte dort: global + wie C),
 *      aus tech_docs_cache global. Dedupe je (project, content_hash) — Duplikate nur gemeldet.
 *
 * SICHERHEIT:
 *   - Ohne --ausfuehren ist es ein TROCKENLAUF: liest PG und Qdrant, berichtet, schreibt nichts.
 *   - Idempotent: ein zweiter Lauf findet nichts mehr zu tun (alles zugeordnet/importiert).
 *   - Qdrant wird nur gelesen (scroll ohne Vektoren); einzige Qdrant-Schreibaktion sind die
 *     Loeschungen aus C/E, und zwar erst nach erfolgreichem PG-Commit.
 *   - DDL (Spalten project/embedded_at, Unique-Index) wie in db/schema.ts — falls das Skript
 *     vor dem ersten Start der neuen API laeuft. Jede DDL-Anweisung einzeln mit lock_timeout;
 *     die Datentransaktion setzt idle_in_transaction_session_timeout (Regel
 *     regel-schema-60s-und-keine-sperre-mit-client-warten). Bei Aenderungen BEIDE Stellen pflegen.
 *
 * AUFRUF (DATABASE_URL = Synapse-DB):
 *   node packages/core/scripts/tech-docs-nach-pg.mjs                (Trockenlauf)
 *   node packages/core/scripts/tech-docs-nach-pg.mjs --ausfuehren   (schreibt)
 *   Optional: --liste (alle Eintraege der Listen statt der ersten 50),
 *             QDRANT_URL (Default http://192.168.50.65:6333)
 */
import pg from 'pg';
import { createHash } from 'crypto';

const QDRANT = (process.env.QDRANT_URL || 'http://192.168.50.65:6333').replace(/\/$/, '');
const GLOBAL = 'tech_docs_cache';
const AUSFUEHREN = process.argv.includes('--ausfuehren');
const VOLLE_LISTE = process.argv.includes('--liste');

const DDL = [
  'ALTER TABLE tech_docs ADD COLUMN IF NOT EXISTS project TEXT',
  'ALTER TABLE tech_docs ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ DEFAULT NOW()',
  'ALTER TABLE tech_docs ALTER COLUMN embedded_at DROP DEFAULT',
  'ALTER TABLE tech_docs DROP CONSTRAINT IF EXISTS tech_docs_content_hash_key',
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_tech_docs_project_hash ON tech_docs ((COALESCE(project, '')), content_hash)",
  'CREATE INDEX IF NOT EXISTS idx_tech_docs_project ON tech_docs(project)',
  'CREATE INDEX IF NOT EXISTS idx_tech_docs_embed_backlog ON tech_docs(indexed_at) WHERE embedded_at IS NULL',
];

async function qdrant(pfad, body) {
  const res = await fetch(`${QDRANT}${pfad}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Qdrant ${pfad} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).result;
}

async function allePunkte(collection) {
  const punkte = [];
  let offset = null;
  for (;;) {
    const body = { limit: 256, with_payload: true, with_vector: false };
    if (offset !== null) body.offset = offset;
    const result = await qdrant(`/collections/${collection}/points/scroll`, body);
    punkte.push(...result.points);
    offset = result.next_page_offset ?? null;
    if (offset === null) return punkte;
  }
}

function kurz(text, n = 60) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function zeigeListe(titel, eintraege, format) {
  console.log(`\n${titel}: ${eintraege.length}`);
  const zeigen = VOLLE_LISTE ? eintraege : eintraege.slice(0, 50);
  for (const e of zeigen) console.log(`  - ${format(e)}`);
  if (zeigen.length < eintraege.length) console.log(`  ... ${eintraege.length - zeigen.length} weitere (--liste zeigt alle)`);
}

// ---------------------------------------------------------------------------
// 1. Bestand lesen
// ---------------------------------------------------------------------------
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const spalten = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'tech_docs' AND column_name IN ('project', 'embedded_at')`
);
const hatSpalten = spalten.rows.length === 2;
if (!hatSpalten && !AUSFUEHREN) {
  console.log('HINWEIS: Spalten project/embedded_at fehlen noch (API noch nicht neu gestartet) - Trockenlauf rechnet mit project NULL.');
}

const pgZeilen = (await client.query(
  `SELECT id, framework, version, section, source, content_hash, indexed_at,
          ${hatSpalten ? 'project' : 'NULL::text AS project'}
     FROM tech_docs`
)).rows;
const pgNachId = new Map(pgZeilen.map(z => [String(z.id), z]));

const collections = (await qdrant('/collections')).collections.map(c => c.name);
const docsCollections = collections.filter(n => n === GLOBAL || /^project_.+_docs$/.test(n)).sort();
const projektAus = (name) => (name === GLOBAL ? null : name.slice('project_'.length, -'_docs'.length));

/** pointId -> [{ collection, project, payload }] */
const fundorte = new Map();
const punktZahl = {};
for (const coll of docsCollections) {
  const punkte = await allePunkte(coll);
  punktZahl[coll] = punkte.length;
  for (const p of punkte) {
    const id = String(p.id);
    if (!fundorte.has(id)) fundorte.set(id, []);
    fundorte.get(id).push({ collection: coll, project: projektAus(coll), payload: p.payload ?? {} });
  }
}

console.log(`PG tech_docs: ${pgZeilen.length} Zeilen`);
console.log(`Qdrant: ${docsCollections.length} Docs-Collections, ${fundorte.size} verschiedene Punkt-IDs`);
for (const c of docsCollections) console.log(`  ${c}: ${punktZahl[c]}`);

// ---------------------------------------------------------------------------
// 2. Einordnen
// ---------------------------------------------------------------------------
const zuordnen = [];        // A: { zeile, project }
const mehrdeutig = [];      // A: { zeile, projekte }
const ohneZuordnung = [];   // B: zeile
const c7Verirrt = [];       // C: { zeile, collections }
const c7OhneVektor = [];    // D: zeile
const importe = [];         // E: { id, project, source, hash, collection, payload, verirrt, ohneProjekt }

// Belegte Dedupe-Schluessel (project, content_hash) nach dem geplanten Stand.
const belegt = new Set(pgZeilen.map(z => `${z.project ?? ''}\u0000${z.content_hash}`));
const konflikte = [];

for (const z of pgZeilen) {
  const orte = fundorte.get(String(z.id)) ?? [];
  const projektOrte = [...new Set(orte.filter(o => o.project).map(o => o.project))];
  if (z.source === 'context7') {
    if (z.project) continue; // schon richtig (sollte bei context7 nicht vorkommen)
    const verirrt = orte.filter(o => o.project);
    if (verirrt.length > 0) c7Verirrt.push({ zeile: z, collections: verirrt.map(o => o.collection) });
    else if (orte.length === 0) c7OhneVektor.push(z);
    continue;
  }
  if (z.project) continue; // bereits zugeordnet (zweiter Lauf)
  if (projektOrte.length === 1) {
    const neu = `${projektOrte[0]}\u0000${z.content_hash}`;
    if (belegt.has(neu)) {
      konflikte.push({ art: 'zuordnung', id: z.id, project: projektOrte[0], text: `${z.framework} ${kurz(z.section)}` });
      continue;
    }
    belegt.delete(`\u0000${z.content_hash}`);
    belegt.add(neu);
    zuordnen.push({ zeile: z, project: projektOrte[0] });
  } else if (projektOrte.length > 1) {
    mehrdeutig.push({ zeile: z, projekte: projektOrte });
  } else {
    ohneZuordnung.push(z);
  }
}

for (const [id, orte] of fundorte) {
  if (pgNachId.has(id)) continue;
  // Waise: bevorzugt der Fundort in einer Projekt-Collection (dort stand die Zuordnung).
  const ort = orte.find(o => o.project) ?? orte[0];
  const pl = ort.payload;
  const content = typeof pl.content === 'string' ? pl.content : '';
  if (!content.trim() || !pl.framework) {
    konflikte.push({ art: 'unvollstaendig', id, project: ort.project, text: `${ort.collection}: framework/content fehlt` });
    continue;
  }
  const source = typeof pl.source === 'string' ? pl.source : 'context7';
  const project = source === 'context7' ? null : ort.project;
  const hash = createHash('sha256').update(content).digest('hex');
  const schluessel = `${project ?? ''}\u0000${hash}`;
  if (belegt.has(schluessel)) {
    konflikte.push({ art: 'import-duplikat', id, project, text: `${ort.collection}: ${pl.framework} ${kurz(pl.section ?? pl.title)}` });
    continue;
  }
  belegt.add(schluessel);
  importe.push({
    id, project, source, hash, collection: ort.collection, payload: pl,
    // Context7-Punkt in einer Projekt-Collection: global importieren, dort loeschen, neu einbetten.
    verirrt: source === 'context7' ? orte.filter(o => o.project).map(o => o.collection) : [],
    // research-Waise nur in tech_docs_cache: global importiert = ohne Zuordnung (Liste B).
    ohneProjekt: source !== 'context7' && !project,
  });
}

// ---------------------------------------------------------------------------
// 3. Bericht
// ---------------------------------------------------------------------------
const proProjekt = {};
for (const a of zuordnen) proProjekt[a.project] = (proProjekt[a.project] ?? 0) + 1;
console.log('\nA) research/manual -> Projekt aus Qdrant-Zuordnung:', zuordnen.length);
for (const [p, n] of Object.entries(proProjekt).sort()) console.log(`  ${p}: ${n}`);
zeigeListe('A) MEHRDEUTIG (Punkt in mehreren Projekten, NICHT zugeordnet)', mehrdeutig,
  e => `${e.zeile.id} ${e.zeile.framework} ${kurz(e.zeile.section)} -> ${e.projekte.join(', ')}`);
zeigeListe('B) research/manual OHNE Projekt-Zuordnung (User fragen)', ohneZuordnung,
  z => `${z.id} [${z.source}] ${z.framework} ${z.version} | ${kurz(z.section)} | ${new Date(z.indexed_at).toISOString().slice(0, 10)}`);
zeigeListe('C) Context7 in Projekt-Collection -> global, neu einbetten', c7Verirrt,
  e => `${e.zeile.id} ${e.zeile.framework} ${kurz(e.zeile.section)} <- ${e.collections.join(', ')}`);
console.log(`\nD) Context7 ohne Vektor -> embedded_at NULL (Backlog): ${c7OhneVektor.length}`);
const importProColl = {};
for (const i of importe) importProColl[i.collection] = (importProColl[i.collection] ?? 0) + 1;
console.log(`\nE) Qdrant-Punkte ohne PG-Zeile -> Import: ${importe.length}`);
for (const [c, n] of Object.entries(importProColl).sort()) console.log(`  aus ${c}: ${n}`);
zeigeListe('E) davon research ohne Projekt (nur in tech_docs_cache, gehoert zu B)', importe.filter(i => i.ohneProjekt),
  i => `${i.id} ${i.payload.framework} ${kurz(i.payload.section ?? i.payload.title)}`);
zeigeListe('KONFLIKTE / UEBERSPRUNGEN', konflikte, k => `${k.art}: ${k.id} [${k.project ?? 'global'}] ${k.text}`);

if (!AUSFUEHREN) {
  console.log('\nTROCKENLAUF - nichts geschrieben. Mit --ausfuehren schreiben.');
  await client.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Schreiben: DDL einzeln, dann EINE Datentransaktion, danach Qdrant-Loeschungen
// ---------------------------------------------------------------------------
await client.query("SET lock_timeout = '5s'");
await client.query("SET statement_timeout = '60s'");
for (const sql of DDL) await client.query(sql);

const loeschen = []; // { collection, id }
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");

  for (const a of zuordnen) {
    await client.query('UPDATE tech_docs SET project = $2 WHERE id = $1 AND project IS NULL', [a.zeile.id, a.project]);
  }
  for (const e of c7Verirrt) {
    await client.query('UPDATE tech_docs SET embedded_at = NULL WHERE id = $1', [e.zeile.id]);
    for (const c of e.collections) loeschen.push({ collection: c, id: e.zeile.id });
  }
  for (const z of c7OhneVektor) {
    await client.query('UPDATE tech_docs SET embedded_at = NULL WHERE id = $1', [z.id]);
  }
  for (const i of importe) {
    const pl = i.payload;
    const zeit = [pl.indexed_at, pl.indexedAt, pl.cached_at].find(t => t && !Number.isNaN(Date.parse(t))) ?? null;
    const brauchtVektor = i.verirrt.length > 0;
    await client.query(
      `INSERT INTO tech_docs (id, framework, version, section, content, type, category, content_hash, source, indexed_at, project, embedded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()), $11, ${brauchtVektor ? 'NULL' : 'NOW()'})
       ON CONFLICT DO NOTHING`,
      [i.id, String(pl.framework).toLowerCase(), pl.version ? String(pl.version) : 'latest',
        pl.section ?? pl.title ?? null, pl.content, pl.type ?? null, pl.category ?? 'framework',
        i.hash, i.source, zeit, i.project]
    );
    for (const c of i.verirrt) loeschen.push({ collection: c, id: i.id });
  }

  await client.query('COMMIT');
  console.log(`\nGESCHRIEBEN: ${zuordnen.length} zugeordnet, ${c7Verirrt.length + c7OhneVektor.length} Context7 zum Nachembedden markiert, ${importe.length} importiert.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ABGEBROCHEN, nichts geschrieben:', err.message);
  await client.end();
  process.exit(1);
}
await client.end();

// Qdrant erst nach dem PG-Commit: faellt hier etwas aus, ist PG trotzdem vollstaendig; der
// verirrte Punkt bleibt dann nur als Doppel in der Projekt-Collection. Ein zweiter Lauf findet
// ihn erneut (Fall C) und versucht das Loeschen noch einmal.
let geloescht = 0;
for (const l of loeschen) {
  try {
    await qdrant(`/collections/${l.collection}/points/delete?wait=true`, { points: [isNaN(Number(l.id)) ? l.id : Number(l.id)] });
    geloescht++;
  } catch (err) {
    console.error(`Qdrant-Delete fehlgeschlagen (${l.collection}/${l.id}): ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`Qdrant: ${geloescht}/${loeschen.length} verirrte Context7-Punkte aus Projekt-Collections entfernt.`);
console.log('Die als embedded_at NULL markierten Zeilen bettet der Backlog (embeddeOffeneEintraege) nach tech_docs_cache ein.');
