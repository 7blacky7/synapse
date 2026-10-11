/**
 * MODUL: Skills nach PostgreSQL (P12-T13)
 * ZWECK: Ueberfuehrt alle Skill-Sections aus der Qdrant-Collection 'skills' in die Tabelle
 *        skill_sections. Bis dahin waren die Inhalte NUR als Qdrant-Payload vorhanden; ein
 *        Reset der Collection (Modellwechsel) haette sie vernichtet.
 *
 * SICHERHEIT:
 *   - Qdrant wird NUR gelesen (scroll ohne Vektoren).
 *   - Ohne --ausfuehren ist es ein Trockenlauf: zaehlt, prueft, schreibt nichts.
 *   - Schreibt per UPSERT auf punkt_id: wiederholbar, ueberschreibt nur mit dem Qdrant-Stand.
 *   - embedded_at bleibt NULL: welches Modell den vorhandenen Vektor erzeugt hat, ist
 *     unbekannt (gemischte Vektorraeume, siehe P5-T9). Erst das Re-Embedding (P12-T12) setzt es.
 *   - Legt die Tabelle mit derselben DDL wie db/schema.ts an, falls sie fehlt - so braucht der
 *     Import keinen API-Neustart. Bei Aenderungen an der Tabelle BEIDE Stellen pflegen.
 *
 * AUFRUF (DATABASE_URL = Synapse-DB):
 *   node packages/core/scripts/skills-nach-pg.mjs                (Trockenlauf)
 *   node packages/core/scripts/skills-nach-pg.mjs --ausfuehren   (schreibt)
 *   Optional: SKILL_QDRANT_URL (Default http://192.168.50.65:6333), SKILL_COLLECTION (Default skills)
 *
 * BESTAND MARKIEREN (P12-T13 Teil 2, VOR dem Deploy des Backlogs mit skill_sections ausfuehren):
 *   node packages/core/scripts/skills-nach-pg.mjs --bestand-markieren               (Trockenlauf)
 *   node packages/core/scripts/skills-nach-pg.mjs --bestand-markieren --ausfuehren  (schreibt)
 *   Setzt fuer importierte Zeilen, deren Punkt in Qdrant EXISTIERT und die noch embedded_at NULL
 *   haben: embedded_at = jetzt, embedding_modell = SKILL_BESTAND_KENNUNG (Default die
 *   Produktions-Kennung wie in embedding_collections/payload.embedding_modell, Stand 11.10.2026).
 *   Grund: qwen hat keinen Dokument-Praefix, die vorhandenen Vektoren passen zur Query-Seite;
 *   neu eingebettet wird erst mit P12-T12. Idempotent.
 */
import pg from 'pg';

const QDRANT = (process.env.SKILL_QDRANT_URL || process.env.QDRANT_URL || 'http://192.168.50.65:6333').replace(/\/$/, '');
const COLLECTION = process.env.SKILL_COLLECTION || 'skills';
const AUSFUEHREN = process.argv.includes('--ausfuehren');
const MARKIEREN = process.argv.includes('--bestand-markieren');
const KENNUNG = process.env.SKILL_BESTAND_KENNUNG || 'ollama:qwen3-embedding:8b|digest:64b933495768|dim:3072|ohne-dokpraefix';

const DDL = `
CREATE TABLE IF NOT EXISTS skill_sections (
  punkt_id BIGINT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  section TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  scope TEXT,
  project TEXT,
  agent TEXT,
  content_hash TEXT,
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedded_at TIMESTAMPTZ,
  embedding_modell TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_sections_eindeutig
  ON skill_sections (skill_name, section, COALESCE(scope, 'global'), COALESCE(project, ''), COALESCE(agent, ''));
CREATE INDEX IF NOT EXISTS idx_skill_sections_skill ON skill_sections (skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_sections_offen ON skill_sections (punkt_id) WHERE embedded_at IS NULL;
`;

async function alleSkillPunkte() {
  const punkte = [];
  let offset = null;
  for (;;) {
    const body = { limit: 256, with_payload: true, with_vector: false };
    if (offset !== null) body.offset = offset;
    const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant scroll ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { result } = await res.json();
    punkte.push(...result.points);
    offset = result.next_page_offset ?? null;
    if (offset === null) return punkte;
  }
}

function alsZeile(p) {
  const pl = p.payload ?? {};
  if (typeof p.id !== 'number') throw new Error(`Punkt ${p.id}: ID ist keine Zahl - Tabelle erwartet BIGINT`);
  if (!pl.skill_name || !pl.section || !(pl.content ?? '').trim()) {
    throw new Error(`Punkt ${p.id}: skill_name/section/content fehlt`);
  }
  const tags = Array.isArray(pl.tags) ? pl.tags.map(String) : [];
  const zeit = pl.updated_at && !Number.isNaN(Date.parse(pl.updated_at)) ? pl.updated_at : null;
  return [p.id, pl.skill_name, pl.section, pl.content, tags, pl.scope ?? null, pl.project ?? null,
    pl.agent ?? null, pl.content_hash ?? null, zeit];
}

const punkte = await alleSkillPunkte();

if (MARKIEREN) {
  const ids = punkte.map((p) => p.id).filter((id) => typeof id === 'number');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const offen = (await client.query(
      'SELECT count(*)::int AS n FROM skill_sections WHERE embedded_at IS NULL AND punkt_id = ANY($1::bigint[])', [ids],
    )).rows[0].n;
    console.log(`Qdrant: ${ids.length} Punkte; davon in skill_sections noch ohne embedded_at: ${offen} (Kennung: ${KENNUNG})`);
    if (!AUSFUEHREN) {
      console.log('TROCKENLAUF - nichts geschrieben. Mit --ausfuehren markieren.');
    } else {
      const r = await client.query(
        `UPDATE skill_sections SET embedded_at = NOW(), embedding_modell = $2
          WHERE embedded_at IS NULL AND punkt_id = ANY($1::bigint[])`,
        [ids, KENNUNG],
      );
      console.log(`MARKIERT: ${r.rowCount} Zeilen als eingebettet (${KENNUNG}).`);
    }
  } finally {
    await client.end();
  }
  process.exit(0);
}
const zeilen = punkte.map(alsZeile);
const skills = new Set(zeilen.map(z => z[1]));
console.log(`Qdrant '${COLLECTION}': ${punkte.length} Sections, ${skills.size} Skills`);

if (!AUSFUEHREN) {
  console.log('TROCKENLAUF - nichts geschrieben. Mit --ausfuehren schreiben.');
  process.exit(0);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(DDL);
  for (const z of zeilen) {
    await client.query(
      `INSERT INTO skill_sections
         (punkt_id, skill_name, section, content, tags, scope, project, agent, content_hash, aktualisiert_am)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, NOW()))
       ON CONFLICT (punkt_id) DO UPDATE SET
         skill_name = EXCLUDED.skill_name, section = EXCLUDED.section, content = EXCLUDED.content,
         tags = EXCLUDED.tags, scope = EXCLUDED.scope, project = EXCLUDED.project, agent = EXCLUDED.agent,
         content_hash = EXCLUDED.content_hash, aktualisiert_am = EXCLUDED.aktualisiert_am`,
      z,
    );
  }
  const { rows } = await client.query('SELECT count(*)::int AS n, count(DISTINCT skill_name)::int AS s FROM skill_sections');
  if (rows[0].n < punkte.length) throw new Error(`Nach dem Import nur ${rows[0].n} Zeilen statt ${punkte.length}`);
  await client.query('COMMIT');
  console.log(`GESCHRIEBEN: skill_sections enthaelt ${rows[0].n} Sections / ${rows[0].s} Skills.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('ABGEBROCHEN, nichts geschrieben:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
