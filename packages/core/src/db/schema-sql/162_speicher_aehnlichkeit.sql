-- P10-T88 / 162. Aehnlichkeitspruefung beim Speichern: Einstellwerte (Regel 7; Code-Standard SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN
-- in speicher-aehnlichkeit.ts, keine Zeile = Standard). Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/speicher-aehnlichkeit-schema.ts (SPEICHER_AEHNLICHKEIT_SCHEMA_SQL).
CREATE TABLE IF NOT EXISTS speicher_aehnlichkeit_einstellungen (
 name TEXT PRIMARY KEY, wert JSONB NOT NULL, grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL, gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
