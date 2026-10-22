-- P18-T104: immutable application-level depth pin. No backfill, index or validation on existing data.
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS policy_pin JSONB;
