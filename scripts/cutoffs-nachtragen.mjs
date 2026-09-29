#!/usr/bin/env node
// cutoffs-nachtragen.mjs — setzt agent_sessions.cutoff_date fuer alle Sessions mit
// model nach DERSELBEN Logik wie registerAgent (resolveCutoff in
// packages/core/src/services/model-cutoffs.ts: model_cutoffs -> model_registry ->
// Praefix an '-'-Grenze). Politik wie dort: ist das Modell bekannt, gilt der
// bekannte Cutoff; Sessions mit unbekanntem Modell bleiben unveraendert.
//
// REIHENFOLGE: erst scripts/modelle-2026-09-aktualisieren.mjs --apply. Sonst
// kennt die Registry die neuen full_ids nicht (opus -> claude-opus-4-7) und die
// Aliase bekommen den Cutoff der alten Version.
//
// Nutzung:
//   node scripts/cutoffs-nachtragen.mjs           # Trockenlauf (Default): Tabelle alt -> neu
//   node scripts/cutoffs-nachtragen.mjs --apply   # schreibt
// DATABASE_URL aus der Umgebung. Voraussetzung: gebautes packages/core.
// --apply schreibt in Batches zu 50; jede Zeile ist ein eigenes UPDATE im
// Autocommit — keine lange Transaktion, keine gehaltenen Sperren.

const APPLY = process.argv.includes('--apply');
const BATCH = 50;
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL fehlt.');
  process.exit(1);
}

const { getPool, closePool } = await import('../packages/core/dist/db/client.js');
const { resolveCutoff } = await import('../packages/core/dist/services/model-cutoffs.js');

const pool = getPool();
try {
  const { rows } = await pool.query(
    `SELECT id, model, cutoff_date::text AS cutoff_date
       FROM agent_sessions
      WHERE model IS NOT NULL AND model <> ''
      ORDER BY id`,
  );

  // Je Modell nur einmal aufloesen
  const jeModell = new Map();
  for (const r of rows) {
    if (!jeModell.has(r.model)) jeModell.set(r.model, await resolveCutoff(r.model));
  }

  const aenderungen = [];
  let unbekannt = 0;
  let gleich = 0;
  for (const r of rows) {
    const neu = jeModell.get(r.model);
    if (!neu) { unbekannt++; continue; }
    if (r.cutoff_date === neu) { gleich++; continue; }
    aenderungen.push({ id: r.id, model: r.model, alt: r.cutoff_date, neu });
  }

  console.log('id | model | alt -> neu');
  for (const a of aenderungen) console.log(`${a.id} | ${a.model} | ${a.alt ?? 'NULL'} -> ${a.neu}`);
  console.log(`\n${rows.length} Sessions mit model: ${aenderungen.length} zu aendern, ${gleich} schon richtig, ${unbekannt} mit unbekanntem Modell (bleiben).`);
  console.log('Unbekannte Modelle:', [...jeModell].filter(([, c]) => !c).map(([m]) => m).join(', ') || '-');

  if (!APPLY) {
    console.log('Trockenlauf — nichts geschrieben. Mit --apply schreiben.');
  } else {
    let geschrieben = 0;
    for (let i = 0; i < aenderungen.length; i += BATCH) {
      for (const a of aenderungen.slice(i, i + BATCH)) {
        const res = await pool.query(
          `UPDATE agent_sessions SET cutoff_date = $2::date
            WHERE id = $1 AND cutoff_date IS DISTINCT FROM $2::date`,
          [a.id, a.neu],
        );
        geschrieben += res.rowCount ?? 0;
      }
      console.log(`  Batch ${Math.floor(i / BATCH) + 1}: bis ${Math.min(i + BATCH, aenderungen.length)}/${aenderungen.length}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`Geschrieben: ${geschrieben} Session(s).`);
  }
} finally {
  await closePool();
}
