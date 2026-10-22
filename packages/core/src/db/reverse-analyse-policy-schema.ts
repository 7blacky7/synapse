/** P18-T104; mirror 144_reverse_analyse_policy.sql. */
export const REVERSE_ANALYSE_POLICY_SCHEMA_SQL = "-- P18-T104: immutable application-level depth pin. No backfill, index or validation on existing data.\nALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS policy_pin JSONB;\n";
