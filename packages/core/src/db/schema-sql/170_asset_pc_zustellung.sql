-- P22-T237 / 170. Asset-Zustellung Share -> Projektordner sichtbar (Produkt-Schalter asset_pc_zustellung, Standard AUS).
-- asset_host_checkpoints (A2, bisher ungenutzt) = bestaetigter Stand je Daemon-Host: stand ist die Commit-Wasserlinie
-- (asset_aenderungsstaende), bis zu der der PC alle Share-Aenderungen installiert hat; offene_downloads/letzter_fehler = Debug,
-- updated_at = Zeit der letzten Meldung. daemon_heartbeats.asset_sync_aktiv = Tray-Schalter Asset-Sync je Projekt laut
-- Heartbeat (NULL = aelterer Daemon ohne Angabe). Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/asset-pc-zustellung-schema.ts (ASSET_PC_ZUSTELLUNG_SCHEMA_SQL).
ALTER TABLE asset_host_checkpoints ADD COLUMN IF NOT EXISTS offene_downloads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_host_checkpoints ADD COLUMN IF NOT EXISTS letzter_fehler TEXT;
ALTER TABLE daemon_heartbeats ADD COLUMN IF NOT EXISTS asset_sync_aktiv BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_asset_aenderungen_asset_stand ON asset_aenderungen (project, asset_id, stand);
