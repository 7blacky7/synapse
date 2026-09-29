#!/usr/bin/env node
// modelle-2026-09-aktualisieren.mjs — bringt model_registry (Claude-Eintraege) und
// model_cutoffs auf den Stand vom 29.09.2026 (Recherche: Thought 50c14dfe).
//
// Warum ein Skript: der Seed in schema.ts laeuft mit ON CONFLICT DO NOTHING und
// korrigiert bestehende Zeilen deshalb nie (opus zeigte weiter auf claude-opus-4-7,
// cutoff_date stand ueberall auf dem Platzhalter 2025-01-01). Hier: UPSERT.
//
// Idempotent. Gemini-/Antigravity-Eintraege werden NICHT angefasst.
// Die Claude-Zeilen kommen aus STATIC_FALLBACK (packages/agents/dist/models.js) —
// EINE Quelle fuer Code, Seed-Vergleichstest und dieses Skript. Bestehende Zeilen:
// full_id, context_window, Korridore (200k = 73/88, 1M = 80/97, Begruendung in
// packages/core/src/services/kontext-korridor.ts), output_limit, pricing_* (je
// Version, models.dev), cutoff_date sowie effort_stufen/default_effort (Stufen fuer
// claude --effort je Version, haiku 4.5 keine) werden aktualisiert. Neue Aliase werden
// komplett angelegt. Fehlen die effort-Spalten noch (SCHEMA_SQL vor dem Deploy),
// legt --apply sie an.
//
// Nutzung:
//   node scripts/modelle-2026-09-aktualisieren.mjs           # Trockenlauf (Default): alt -> neu
//   node scripts/modelle-2026-09-aktualisieren.mjs --apply   # schreibt
// DATABASE_URL aus der Umgebung. Voraussetzung: gebaute packages/core und
// packages/agents (MODEL_CUTOFF_SEED, STATIC_FALLBACK).
// Danach: laufende Prozesse (REST-API, MCP-Server, Daemon) halten die Registry
// im Cache — Neustart, damit die neuen Werte gelten.

import { createRequire } from 'node:module';

const APPLY = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL fehlt.');
  process.exit(1);
}

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { Client } = requireFromCore('pg');
const { MODEL_CUTOFF_SEED } = await import('../packages/core/dist/services/model-cutoffs.js');
const { STATIC_FALLBACK } = await import('../packages/agents/dist/models.js');

// [alias, full_id, context_window, corridor_min, corridor_max, preis_in, preis_out, preis_cache, cutoff_date, output_limit,
//  effort_stufen, default_effort]
// Nur Claude (Gemini/Antigravity bleiben unangetastet). sonnet-4.6[1m] fehlt dort bewusst.
const REGISTRY = Object.values(STATIC_FALLBACK)
  .filter((e) => e.provider === 'anthropic')
  .map((e) => [
    e.alias, e.fullId, e.contextWindow, e.corridorMin, e.corridorMax,
    e.pricingInputUsdPerMtok, e.pricingOutputUsdPerMtok, e.pricingCacheUsdPerMtok,
    e.cutoffDate ?? null, e.outputLimit ?? null,
    e.effortStufen ?? [], e.defaultEffort ?? null,
  ]);

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
// Kurze Grenzen: jede Anweisung ist ein eigener Autocommit, nichts wartet mit Sperren.
await client.query("SET lock_timeout = '5s'");
await client.query("SET statement_timeout = '30s'");
await client.query("SET idle_in_transaction_session_timeout = '30s'");

try {
  // effort-Spalten gibt es erst mit dem SCHEMA_SQL vom 29.09.2026.
  const effortSpalten = (await client.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'model_registry'
        AND column_name IN ('default_effort', 'effort_stufen')`,
  )).rows[0].n === 2;

  // --- model_registry ---
  const alt = await client.query(
    `SELECT alias, full_id, context_window, corridor_min, corridor_max, output_limit,
            pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok,
            cutoff_date::text AS cutoff_date${effortSpalten ? ', default_effort, effort_stufen' : ''}
       FROM model_registry WHERE alias = ANY($1)`,
    [REGISTRY.map((r) => r[0])],
  );
  const altMap = new Map(alt.rows.map((r) => [r.alias, r]));
  console.log(`model_registry (alias: alt -> neu)${effortSpalten ? '' : ' — effort-Spalten fehlen noch, werden mit --apply angelegt'}`);
  let regAenderungen = 0;
  const zahl = (v) => (v === null || v === undefined ? null : Number(v));
  const effortText = (stufen, standard) => (stufen?.length ? `[${stufen.join(',')}] std=${standard ?? 'NULL'}` : 'keine');
  for (const [alias, fullId, ctx, cmin, cmax, pin, pout, pcache, cutoff, output, effortStufen, effortStd] of REGISTRY) {
    const a = altMap.get(alias);
    const vorher = a
      ? `${a.full_id} ${a.context_window} ${a.corridor_min}/${a.corridor_max} out=${a.output_limit ?? 'NULL'} ` +
        `$${zahl(a.pricing_input_usd_per_mtok)}/${zahl(a.pricing_output_usd_per_mtok)}/${zahl(a.pricing_cache_usd_per_mtok)} ${a.cutoff_date ?? 'NULL'} ` +
        `effort=${effortSpalten ? effortText(a.effort_stufen, a.default_effort) : '(Spalte fehlt)'}`
      : '(neu)';
    const nachher = `${fullId} ${ctx} ${cmin}/${cmax} out=${output ?? 'NULL'} $${pin}/${pout}/${pcache} ${cutoff ?? 'NULL'} ` +
      `effort=${effortText(effortStufen, effortStd)}`;
    const gleich = a && a.full_id === fullId && Number(a.context_window) === ctx &&
      Number(a.corridor_min) === cmin && Number(a.corridor_max) === cmax &&
      zahl(a.output_limit) === output && zahl(a.pricing_input_usd_per_mtok) === pin &&
      zahl(a.pricing_output_usd_per_mtok) === pout && zahl(a.pricing_cache_usd_per_mtok) === pcache &&
      (a.cutoff_date ?? null) === cutoff &&
      effortSpalten && JSON.stringify(a.effort_stufen ?? null) === JSON.stringify(effortStufen) &&
      (a.default_effort ?? null) === effortStd;
    if (!gleich) regAenderungen++;
    console.log(`  ${gleich ? '=' : '*'} ${alias.padEnd(14)} ${vorher}  ->  ${nachher}`);
  }

  // --- model_cutoffs ---
  const tabelleDa = (await client.query("SELECT to_regclass('public.model_cutoffs') IS NOT NULL AS da")).rows[0].da;
  const cutAlt = tabelleDa
    ? new Map((await client.query('SELECT model_id, cutoff_date::text AS cutoff_date FROM model_cutoffs')).rows
      .map((r) => [r.model_id, r.cutoff_date]))
    : new Map();
  console.log(`\nmodel_cutoffs${tabelleDa ? '' : ' (Tabelle fehlt noch, wird mit --apply angelegt)'} (model_id: alt -> neu)`);
  let cutAenderungen = 0;
  for (const [id, datum] of MODEL_CUTOFF_SEED) {
    const vorher = cutAlt.get(id) ?? '(neu)';
    const gleich = vorher === datum;
    if (!gleich) cutAenderungen++;
    console.log(`  ${gleich ? '=' : '*'} ${id.padEnd(24)} ${vorher}  ->  ${datum}`);
  }

  console.log(`\n${regAenderungen} Registry-Zeile(n) und ${cutAenderungen} Cutoff-Zeile(n) weichen ab.`);
  if (!APPLY) {
    console.log('Trockenlauf — nichts geschrieben. Mit --apply schreiben.');
  } else {
    // Gleiche Anweisungen wie im SCHEMA_SQL (core db/schema.ts), idempotent.
    await client.query('ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS default_effort TEXT');
    await client.query('ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS effort_stufen TEXT[]');
    for (const [alias, fullId, ctx, cmin, cmax, pin, pout, pcache, cutoff, output, effortStufen, effortStd] of REGISTRY) {
      await client.query(
        `INSERT INTO model_registry
           (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path,
            corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok,
            pricing_cache_usd_per_mtok, cutoff_date, output_limit, effort_stufen, default_effort)
         VALUES ($1, $2, 'anthropic', $3, ARRAY[]::TEXT[], 'claude', NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (alias) DO UPDATE SET
           full_id = EXCLUDED.full_id,
           context_window = EXCLUDED.context_window,
           corridor_min = EXCLUDED.corridor_min,
           corridor_max = EXCLUDED.corridor_max,
           output_limit = EXCLUDED.output_limit,
           pricing_input_usd_per_mtok = EXCLUDED.pricing_input_usd_per_mtok,
           pricing_output_usd_per_mtok = EXCLUDED.pricing_output_usd_per_mtok,
           pricing_cache_usd_per_mtok = EXCLUDED.pricing_cache_usd_per_mtok,
           cutoff_date = EXCLUDED.cutoff_date,
           effort_stufen = EXCLUDED.effort_stufen,
           default_effort = EXCLUDED.default_effort,
           updated_at = NOW()`,
        [alias, fullId, ctx, cmin, cmax, pin, pout, pcache, cutoff, output, effortStufen, effortStd],
      );
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS model_cutoffs (
         model_id TEXT PRIMARY KEY,
         cutoff_date DATE NOT NULL,
         quelle TEXT,
         aktualisiert_am TIMESTAMPTZ DEFAULT NOW()
       )`,
    );
    for (const [id, datum, quelle] of MODEL_CUTOFF_SEED) {
      await client.query(
        `INSERT INTO model_cutoffs (model_id, cutoff_date, quelle) VALUES ($1, $2, $3)
         ON CONFLICT (model_id) DO UPDATE SET
           cutoff_date = EXCLUDED.cutoff_date,
           quelle = EXCLUDED.quelle,
           aktualisiert_am = NOW()`,
        [id, datum, quelle],
      );
    }
    console.log(`Geschrieben: ${REGISTRY.length} Registry-, ${MODEL_CUTOFF_SEED.length} Cutoff-Zeilen (UPSERT).`);
    console.log('Hinweis: REST-API/MCP-Server/Daemon neu starten, damit die Caches die neuen Werte laden.');
  }
} finally {
  await client.end();
}
