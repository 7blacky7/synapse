#!/usr/bin/env node
// plaene-kurz-ids.mjs — Kurz-IDs und aktiven Plan im Bestand befuellen (Task 137fabaf).
//
//   node scripts/plaene-kurz-ids.mjs            Trockenlauf (Standard): liest nur, zeigt die Aenderungen
//   node scripts/plaene-kurz-ids.mjs --apply    schreibt
//
// Was passiert (Logik: core services/plan-kurz-ids.ts planeKurzIds, getestet in
// scripts/test-plaene-mehrere.mjs):
//   - je Projekt fehlende Plan-Kurz-IDs P<n> nach created_at (nach der hoechsten vorhandenen weiter)
//   - genau ein aktiver Plan: vorhandene Markierung bleibt, sonst der zuletzt geaenderte
//     (= der Plan, den getPlan bisher aus Qdrant bekam). synapse: Leerplan "synapse" -> P1
//     inaktiv, "PLAN-004" -> P2 aktiv.
//   - fehlende Task-Kurz-IDs P<n>-T<m> nach createdAt, Zaehler plans.naechste_task_nr
//   - vergebene Kurz-IDs werden nie geaendert; ein zweiter Lauf aendert nichts
//
// --apply zusaetzlich:
//   - ADD COLUMN IF NOT EXISTS (falls SCHEMA_SQL noch nicht lief)
//   - je Plan EIN UPDATE mit Bedingung "tasks unveraendert" (sonst uebersprungen + gemeldet,
//     einfach erneut laufen lassen). statement_timeout/lock_timeout gesetzt, keine Transaktion
//     haelt Sperren waehrend eines Client-Wartens (Regel regel-schema-60s-und-keine-sperre-mit-client-warten).
//   - Qdrant-Payload (tasks, kurz_id, aktiv) je Plan nachziehen (QDRANT_URL, optional QDRANT_API_KEY).
//     WICHTIG: sonst schreibt ein noch nicht neu gestarteter ALTER Prozess (liest Plaene aus
//     Qdrant) die Tasks ohne kurz_id zurueck. Reihenfolge: Deploy -> Daemon/MCP neu starten
//     -> dieses Skript.
//   - danach die Unique-Indizes (project, kurz_id) und "hoechstens ein aktiver Plan je Projekt".
//
// Voraussetzung: gebautes core-dist (pnpm build), DATABASE_URL auf die Synapse-DB.

import { createRequire } from 'node:module';

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = requireFromCore('pg');
const { planeKurzIds } = await import('../packages/core/dist/services/plan-kurz-ids.js');

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL fehlt.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET statement_timeout = '15s'");
await client.query("SET lock_timeout = '3s'");
await client.query("SET idle_in_transaction_session_timeout = '15s'");
if (!APPLY) await client.query('SET default_transaction_read_only = on');

const NEUE_SPALTEN = ['kurz_id', 'aktiv', 'naechste_task_nr'];
const vorhanden = new Set(
  (await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'plans' AND column_name = ANY($1)`,
    [NEUE_SPALTEN],
  )).rows.map((r) => r.column_name),
);
const fehlend = NEUE_SPALTEN.filter((s) => !vorhanden.has(s));
if (fehlend.length > 0) {
  if (APPLY) {
    await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS kurz_id TEXT');
    await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS aktiv BOOLEAN');
    await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS naechste_task_nr INTEGER');
    console.log(`Spalten angelegt: ${fehlend.join(', ')}`);
  } else {
    console.log(`HINWEIS: Spalten fehlen noch (${fehlend.join(', ')}) — Trockenlauf rechnet mit NULL; --apply legt sie an.`);
  }
}
const spalte = (s) => (vorhanden.has(s) ? s : `NULL AS ${s}`);
const { rows } = await client.query(
  `SELECT id, project, name, created_at, updated_at, ${spalte('kurz_id')}, ${spalte('aktiv')},
          ${spalte('naechste_task_nr')}, tasks
   FROM plans ORDER BY project, created_at, id`,
);
const altJeId = new Map(rows.map((r) => [r.id, r]));
const aenderungen = planeKurzIds(rows);

// --- Bericht ---------------------------------------------------------------
const projekte = new Map();
for (const a of aenderungen) {
  const liste = projekte.get(a.project) ?? [];
  liste.push(a);
  projekte.set(a.project, liste);
}
console.log(`${rows.length} Plaene in ${new Set(rows.map((r) => r.project)).size} Projekten; zu aendern: ${aenderungen.length} Plaene in ${projekte.size} Projekten.`);
for (const [projekt, liste] of projekte) {
  const teile = liste.map((a) => {
    const alt = altJeId.get(a.id);
    const neueTasks = a.tasks.filter((t, i) => t.kurz_id !== (alt.tasks ?? [])[i]?.kurz_id).length;
    return `${a.kurz_id} "${alt.name}"${a.aktiv ? ' AKTIV' : ''} (${a.tasks.length} Tasks, ${neueTasks} neue Kurz-IDs, Zaehler ${a.naechste_task_nr})`;
  });
  console.log(`  ${projekt}: ${teile.join(' | ')}`);
}

if (!APPLY) {
  console.log('\nTROCKENLAUF — nichts geschrieben. Schreiben mit --apply.');
  await client.end();
  process.exit(0);
}

// --- Schreiben -------------------------------------------------------------
let geschrieben = 0;
const uebersprungen = [];
for (const a of aenderungen) {
  const alt = altJeId.get(a.id);
  const r = await client.query(
    `UPDATE plans SET kurz_id = $2, aktiv = $3, naechste_task_nr = $4, tasks = $5::jsonb
     WHERE id = $1 AND tasks = $6::jsonb`,
    [a.id, a.kurz_id, a.aktiv, a.naechste_task_nr, JSON.stringify(a.tasks), JSON.stringify(alt.tasks ?? [])],
  );
  if (r.rowCount === 1) geschrieben++;
  else uebersprungen.push(`${a.project}/${a.id}`);
}
console.log(`\nPG: ${geschrieben} Plaene geschrieben, ${uebersprungen.length} uebersprungen (waehrenddessen geaendert — Skript erneut starten): ${uebersprungen.join(', ') || '-'}`);

// --- Qdrant-Payload --------------------------------------------------------
const qdrant = process.env.QDRANT_URL?.replace(/\/+$/, '');
if (!qdrant) {
  console.log('Qdrant: QDRANT_URL fehlt — Payload NICHT nachgezogen. Alte Prozesse vorher neu starten!');
} else {
  let ok = 0;
  const fehler = [];
  for (const a of aenderungen) {
    if (uebersprungen.includes(`${a.project}/${a.id}`)) continue;
    try {
      const res = await fetch(`${qdrant}/collections/project_${a.project}_plans/points/payload?wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}) },
        body: JSON.stringify({ payload: { tasks: a.tasks, kurz_id: a.kurz_id, aktiv: a.aktiv }, points: [a.id] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) ok++;
      else fehler.push(`${a.project}/${a.kurz_id}: HTTP ${res.status}`);
    } catch (err) {
      fehler.push(`${a.project}/${a.kurz_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`Qdrant: ${ok} Payloads nachgezogen, ${fehler.length} Fehler${fehler.length ? ` (Punkt fehlt im Index = unkritisch, PG ist Wahrheit): ${fehler.join('; ')}` : ''}`);
}

// --- Indizes ---------------------------------------------------------------
await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_projekt_kurz_id ON plans (project, kurz_id) WHERE kurz_id IS NOT NULL');
await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_ein_aktiver ON plans (project) WHERE aktiv IS TRUE');
console.log('Indizes: idx_plans_projekt_kurz_id, idx_plans_ein_aktiver vorhanden.');

await client.end();
