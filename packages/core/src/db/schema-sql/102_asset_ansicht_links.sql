-- P13-T33/A15: Capability-Links mit Timer. In PG liegt NUR der sha256-Digest des Tokens, nie Token oder URL.
-- Spiegel von ASSET_ANSICHT_LINK_SCHEMA_SQL (packages/core/src/db/asset-ansicht-link-schema.ts).
-- id/revision/sha256 binden den Link an genau eine unveränderliche Quellrevision (A14-Referenz).
CREATE TABLE IF NOT EXISTS ansicht_tokens (
  token_id UUID PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  bereich TEXT NOT NULL CHECK (bereich IN ('projekt','reverse')),
  ziel_ref TEXT NOT NULL,
  id TEXT NOT NULL,
  revision TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  art TEXT NOT NULL DEFAULT 'ansicht' CHECK (art IN ('ansicht','original')),
  einmalig BOOLEAN NOT NULL DEFAULT false,
  offen_sekunden INTEGER NOT NULL CHECK (offen_sekunden > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  widerruf_grund TEXT,
  consumed_at TIMESTAMPTZ,
  abrufe INTEGER NOT NULL DEFAULT 0,
  letzter_abruf_at TIMESTAMPTZ,
  retention_ref TEXT NOT NULL,
  erstellt_von_agent TEXT,
  erstellt_von_projekt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ansicht_tokens_ziel ON ansicht_tokens(bereich,ziel_ref,id);
CREATE INDEX IF NOT EXISTS idx_ansicht_tokens_ablauf ON ansicht_tokens(expires_at);
-- Audit: Zeit, Ereignis, Status, gekürzter User-Agent, Client-IP. Kein Token, keine URL.
CREATE TABLE IF NOT EXISTS ansicht_token_audit (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID REFERENCES ansicht_tokens(token_id) ON DELETE SET NULL,
  zeit TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ereignis TEXT NOT NULL,
  http_status INTEGER,
  ergebnis TEXT NOT NULL,
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 200),
  client_ip TEXT CHECK (client_ip IS NULL OR length(client_ip) <= 64),
  akteur TEXT
);
CREATE INDEX IF NOT EXISTS idx_ansicht_token_audit_token ON ansicht_token_audit(token_id,zeit);
-- Löschung, Purge oder Projektwechsel eines Projekt-Assets widerruft alle zugehörigen Links.
CREATE OR REPLACE FUNCTION ansicht_tokens_asset_widerruf() RETURNS trigger
LANGUAGE plpgsql AS $ansicht_widerruf$
BEGIN
  IF (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
     OR (NEW.storage_status IN ('purging','purged') AND NEW.storage_status IS DISTINCT FROM OLD.storage_status)
     OR NEW.project IS DISTINCT FROM OLD.project THEN
    UPDATE ansicht_tokens SET revoked_at=clock_timestamp(),
      widerruf_grund=CASE WHEN NEW.project IS DISTINCT FROM OLD.project THEN 'projekt_geaendert' ELSE 'asset_geloescht' END
     WHERE bereich='projekt' AND ziel_ref=OLD.project AND id=OLD.id::text AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END
$ansicht_widerruf$;
CREATE OR REPLACE TRIGGER trg_ansicht_tokens_asset_widerruf
AFTER UPDATE OF deleted_at,storage_status,project ON asset_files
FOR EACH ROW EXECUTE FUNCTION ansicht_tokens_asset_widerruf();
