-- P16-T16 E1 (14.10.2026): Einstellungen der projektweiten Build-Pruefung im Pruefcontainer.
-- bereich: 'global' | 'projekt:<name>' (werte.aktiv = Build-Tor) | 'pruefcontainer' (speicher_mb, tmpfs_mb, heap_mb,
-- zeitlimit_s). Gesetzt ueber code_check(build_einstellungen, modus 'setzen'), nur Koordinator/User.
CREATE TABLE IF NOT EXISTS build_pruefung_einstellungen (
  bereich TEXT PRIMARY KEY,
  werte JSONB NOT NULL DEFAULT '{}'::jsonb,
  gesetzt_von TEXT,
  grund TEXT,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
