-- P22-T287 / 182. Produkt-Schalter je Agent: Ebenen identitaet (Ausweis, identity_id), agent (alte Methode ohne Ausweis:
-- agent_id oder Namensmuster wie luna-*) und typ (agent_typen.id) ueber projekt/global (agent_profil_schalter bleibt unveraendert).
-- Rang beim Lesen (agent-profil-schalter.ts leseProfilProduktSchalter): identitaet > agent exakt > agent Muster > typ > projekt > global > Standard.
-- Additiv und idempotent. Schalter: Produkt-Schalter schalter_identitaet (Standard AUS; AUS = Zeilen werden ignoriert).
CREATE TABLE IF NOT EXISTS agent_profil_schalter_ziel (
  id BIGSERIAL PRIMARY KEY,
  ebene TEXT NOT NULL CHECK (ebene IN ('identitaet','agent','typ')),
  project TEXT NOT NULL,
  ziel TEXT NOT NULL CHECK (btrim(ziel) <> ''),
  funktion TEXT NOT NULL,
  aktiv BOOLEAN NOT NULL,
  grund TEXT NOT NULL CHECK (btrim(grund) <> ''),
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_profil_schalter_ziel
  ON agent_profil_schalter_ziel(ebene, project, ziel, funktion);
CREATE INDEX IF NOT EXISTS idx_agent_profil_schalter_ziel_lesen
  ON agent_profil_schalter_ziel(funktion, project);
-- Verlauf jeder Aenderung (auch Entfernen = wieder erben); bei ebene identitaet zusaetzlich agent_identitaet_audit.
CREATE TABLE IF NOT EXISTS agent_profil_schalter_ziel_verlauf (
  id BIGSERIAL PRIMARY KEY,
  ebene TEXT NOT NULL,
  project TEXT NOT NULL,
  ziel TEXT NOT NULL,
  funktion TEXT NOT NULL,
  alt BOOLEAN,
  neu BOOLEAN,
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_profil_schalter_ziel_verlauf
  ON agent_profil_schalter_ziel_verlauf(project, ebene, ziel, wann DESC);
-- User-Korrektur 27f9c071: Herkunft des Setzenden (user|ausweis|legacy_koordinator|ohne_ausweis) und dessen agent_id (Audit).
ALTER TABLE agent_profil_schalter_ziel ADD COLUMN IF NOT EXISTS herkunft TEXT;
ALTER TABLE agent_profil_schalter_ziel ADD COLUMN IF NOT EXISTS setter_agent_id TEXT;
ALTER TABLE agent_profil_schalter_ziel_verlauf ADD COLUMN IF NOT EXISTS herkunft TEXT;
ALTER TABLE agent_profil_schalter_ziel_verlauf ADD COLUMN IF NOT EXISTS setter_agent_id TEXT;
-- P22-T287 S4: Einstellwerte je Agent (Ebenen identitaet/agent/typ) fuer die ziel-faehigen Werte der Bereiche shell_ausgabe,
-- runtime_tool_ausgabe und ausweis_fristen (agent-profil-schalter-ziel.ts ZIEL_EINSTELLUNG_BEREICHE). Rang wie die Schalter; darunter
-- die bisherige Aufloesung des Bereichs (projekt > global > Standard). Nur bei schalter_identitaet EIN wirksam.
CREATE TABLE IF NOT EXISTS agent_einstellung_ziel (
  id BIGSERIAL PRIMARY KEY,
  bereich TEXT NOT NULL,
  ebene TEXT NOT NULL CHECK (ebene IN ('identitaet','agent','typ')),
  project TEXT NOT NULL,
  ziel TEXT NOT NULL CHECK (btrim(ziel) <> ''),
  name TEXT NOT NULL,
  wert BIGINT NOT NULL CHECK (wert >= 0),
  grund TEXT NOT NULL CHECK (btrim(grund) <> ''),
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  herkunft TEXT,
  setter_agent_id TEXT,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_einstellung_ziel
  ON agent_einstellung_ziel(bereich, ebene, project, ziel, name);
CREATE INDEX IF NOT EXISTS idx_agent_einstellung_ziel_lesen
  ON agent_einstellung_ziel(bereich, project);
CREATE TABLE IF NOT EXISTS agent_einstellung_ziel_verlauf (
  id BIGSERIAL PRIMARY KEY,
  bereich TEXT NOT NULL,
  ebene TEXT NOT NULL,
  project TEXT NOT NULL,
  ziel TEXT NOT NULL,
  name TEXT NOT NULL,
  alt BIGINT,
  neu BIGINT,
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  herkunft TEXT,
  setter_agent_id TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_einstellung_ziel_verlauf
  ON agent_einstellung_ziel_verlauf(project, ebene, ziel, wann DESC);
