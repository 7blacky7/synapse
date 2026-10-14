-- P9-T31 (14.10.2026): Spiegel von packages/core/src/db/loesch-token-schema.ts (LOESCH_TOKEN_SCHEMA_SQL).
-- Sicheres Loeschen eines Projekts nur mit rechnergebundenem Loesch-Code.
-- loesch_geheimnisse: EIN TOTP-Geheimnis je Rechner (hostname), eingerichtet nur im Tray des Rechners
-- (Daemon-Zugang dieses Rechners + Login-TOTP des Users). Eigenes Geheimnis, nie der Login-TOTP.
-- geheimnis = bestaetigtes, wirksames Geheimnis; neues_geheimnis = Einrichtung, die noch auf den ersten
-- Code wartet (das alte bleibt bis dahin gueltig). letzter_zeitschritt = Replay-Schutz (jeder Code einmal).
CREATE TABLE IF NOT EXISTS loesch_geheimnisse (
  hostname TEXT PRIMARY KEY,
  geheimnis TEXT,
  neues_geheimnis TEXT,
  bestaetigt_at TIMESTAMPTZ,
  letzter_zeitschritt BIGINT NOT NULL DEFAULT 0,
  eingerichtet_von TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- loesch_auftraege: Vorschau + Bindung an Projekt, Rechner, Umfang (vorschau_hash). Einmalig, laeuft ab,
-- wenige Fehlversuche. Bleibt nach der Loeschung als Protokoll (wird von der Projekt-Loeschung NIE erfasst).
CREATE TABLE IF NOT EXISTS loesch_auftraege (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  hostname TEXT NOT NULL,
  umfang TEXT NOT NULL CHECK (umfang IN ('rechner','zentral','komplett')),
  vorschau JSONB NOT NULL,
  vorschau_hash TEXT NOT NULL,
  erstellt_von TEXT,
  status TEXT NOT NULL DEFAULT 'offen'
    CHECK (status IN ('offen','laeuft','ausgefuehrt','teilweise','verfallen','fehlgeschlagen')),
  fehlversuche INTEGER NOT NULL DEFAULT 0,
  gueltig_bis TIMESTAMPTZ NOT NULL,
  ordner_status TEXT CHECK (ordner_status IS NULL OR ordner_status IN ('wartet','laeuft','done','failed')),
  ordner_pfad TEXT,
  ordner_claimed_at TIMESTAMPTZ,
  ordner_meldung TEXT,
  ergebnis JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loesch_auftraege_host_status ON loesch_auftraege (hostname, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_loesch_auftraege_ordner ON loesch_auftraege (hostname, ordner_status) WHERE ordner_status IS NOT NULL;

-- loesch_login_fehlversuche: falsche Login-Codes bei der Einrichtung des Loesch-Codes je Rechner (Sperre nach
-- 5 Fehlversuchen in 15 Minuten, laeuft mit dem Fenster ab). Keine Codes, nur Rechner + Zeitpunkt.
CREATE TABLE IF NOT EXISTS loesch_login_fehlversuche (
  id BIGSERIAL PRIMARY KEY,
  hostname TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loesch_login_fehlversuche_host ON loesch_login_fehlversuche (hostname, created_at);
