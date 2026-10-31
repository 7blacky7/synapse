-- P22-T199 / 168. Co-Edit ohne Ready-Gate (Produkt-Schalter coedit_ohne_gate, Standard AUS; Entwurf 7efece9b, Freigabe bf31526a).
-- op_zustaende: Zustand je Op eines offenen gemeinsamen Plans (gueltig|fehlerhaft|konflikt|drift|wartet_gruppe), Index = op_index.
-- aus_plan_id: ein Teilcommit wird als eigene committete Zeile abgespalten; ihre id ist die batch_id, aus_plan_id der offen
-- bleibende Plan. Bei Schalter AUS bleiben beide Spalten NULL. Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/coedit-ohne-gate-schema.ts (COEDIT_OHNE_GATE_SCHEMA_SQL).
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS op_zustaende JSONB;
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS aus_plan_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_file_batch_plans_aus_plan_id
  ON file_batch_plans (aus_plan_id, committed_at) WHERE aus_plan_id IS NOT NULL;
