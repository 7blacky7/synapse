/** P22-T44: Spiegel 118_agent_ausweis_projekte.sql. Additiv/idempotent; nach 111 (agent_identitaeten, agent_identitaet_laeufe) ausfuehren. */
export const AGENT_AUSWEIS_PROJEKTE_SCHEMA_SQL = `
-- P22-T44 / 118. Additiv und idempotent: nur CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, nichts wird gedroppt.
-- Agenten-Ausweis fuer mehrere Projekte (Konzept thought cde685a9 Fassung 7, User-Entscheidungen c4ba1673 Punkt 9, 8076a319).
-- Eine Zeile je Identitaet + Projekt (nicht im Profil-JSON). Heimat = agent_identitaeten.project, steht hier NICHT.
--   visum_*            automatisches Visum (nur lesen + Channels), Frist visum_minuten des Projekts (Standard 30)
--   arbeitsfreigabe_*  befristete Freigabe durch den Koordinator DIESES Projekts oder den User (arbeitsfreigabe_stunden, Standard 24)
--   regeln_lauf_id     Lauf, in dem die Pflichtregeln dieses Projekts zuletzt zugestellt wurden (einmal je Lauf)
-- agent_identitaet_laeufe.zugestellt_projekte_stand: zuletzt angezeigter Visum-/Einwanderungsstand im Lauf (Anzeige je Lauf + bei Aenderung).
CREATE TABLE IF NOT EXISTS agent_ausweis_projekte (
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  project TEXT NOT NULL,
  erster_aufruf TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  zuletzt_aufruf TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  zugang_zuletzt TEXT CHECK (zugang_zuletzt IN ('frei','visum','arbeitsfreigabe')),
  visum_ausgestellt_am TIMESTAMPTZ,
  visum_bis TIMESTAMPTZ,
  visa_anzahl INTEGER NOT NULL DEFAULT 0,
  arbeitsfreigabe_am TIMESTAMPTZ,
  arbeitsfreigabe_bis TIMESTAMPTZ,
  arbeitsfreigabe_von TEXT,
  arbeitsfreigabe_von_identity_id TEXT REFERENCES agent_identitaeten(id),
  arbeitsfreigabe_grund TEXT,
  regeln_lauf_id TEXT,
  PRIMARY KEY (identity_id, project)
);
CREATE INDEX IF NOT EXISTS idx_agent_ausweis_projekte_project ON agent_ausweis_projekte(project);
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS zugestellt_projekte_stand TEXT;
-- P22-T52: '*' (jev abwesend: alle Projekte) ist nie ein Projekt. Vor dem P22-T50-Fix eingetragene Zeilen entfernen (idempotent, nur '*').
DELETE FROM agent_ausweis_projekte WHERE project = '*';
`;
