-- P18-T26/RV16: Retentionhalter für Reverse-Quellrevisionen (eintrag_id + sha256; revision = sha256).
-- Nur Metadaten, nie Bytes: Originale bleiben unter SYNAPSE_REVERSE_ROOT, nichts wird ins Projekt kopiert.
-- Gleiche Rolle wie asset_retention_referenzen für Projekt-Assets (A14-Lease a14-*, A15-Link a15-*).
CREATE TABLE IF NOT EXISTS reverse_ansicht_retention (
  ref_key TEXT PRIMARY KEY CHECK (length(ref_key) BETWEEN 1 AND 200),
  eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_reverse_ansicht_retention_quelle ON reverse_ansicht_retention(eintrag_id,sha256) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ansicht_tokens_reverse_bindung ON ansicht_tokens(ziel_ref,erstellt_von_projekt) WHERE bereich='reverse' AND revoked_at IS NULL;
CREATE OR REPLACE FUNCTION reverse_ansicht_retention_freigegeben_bereinigen() RETURNS trigger
LANGUAGE plpgsql AS $reverse_ansicht_retention_bereinigen$
BEGIN
  DELETE FROM reverse_ansicht_retention WHERE eintrag_id=OLD.id AND (released_at IS NOT NULL OR expires_at<=clock_timestamp());
  RETURN OLD;
END
$reverse_ansicht_retention_bereinigen$;
CREATE OR REPLACE TRIGGER trg_reverse_ansicht_retention_bereinigen
BEFORE DELETE ON reverse_eintraege FOR EACH ROW EXECUTE FUNCTION reverse_ansicht_retention_freigegeben_bereinigen();
-- A15 (User F5: nur gebundene Einträge): Lösen/Entfernen einer Bindung widerruft die Reverse-Links,
-- die aus diesem Projekt erzeugt wurden, und gibt deren Retention frei.
CREATE OR REPLACE FUNCTION ansicht_tokens_reverse_bindung_widerruf() RETURNS trigger
LANGUAGE plpgsql AS $reverse_ansicht_widerruf$
BEGIN
  IF TG_OP='DELETE' OR (NEW.geloest_at IS NOT NULL AND OLD.geloest_at IS NULL)
     OR NEW.project IS DISTINCT FROM OLD.project OR NEW.eintrag_id IS DISTINCT FROM OLD.eintrag_id THEN
    IF NOT EXISTS(SELECT 1 FROM reverse_bindungen b WHERE b.project=OLD.project AND b.eintrag_id=OLD.eintrag_id
                  AND b.geloest_at IS NULL AND b.id<>OLD.id) THEN
      WITH w AS (
        UPDATE ansicht_tokens SET revoked_at=clock_timestamp(),widerruf_grund='bindung_geloest'
         WHERE bereich='reverse' AND ziel_ref=OLD.eintrag_id AND erstellt_von_projekt=OLD.project AND revoked_at IS NULL
        RETURNING retention_ref)
      UPDATE reverse_ansicht_retention SET released_at=clock_timestamp()
       WHERE ref_key IN (SELECT retention_ref FROM w) AND released_at IS NULL;
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END
$reverse_ansicht_widerruf$;
CREATE OR REPLACE TRIGGER trg_ansicht_tokens_reverse_bindung_widerruf
AFTER UPDATE OF geloest_at,project,eintrag_id OR DELETE ON reverse_bindungen
FOR EACH ROW EXECUTE FUNCTION ansicht_tokens_reverse_bindung_widerruf();
