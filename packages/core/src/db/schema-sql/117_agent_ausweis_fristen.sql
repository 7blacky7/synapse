-- P22-T45 / 117. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Fristen des Agenten-Ausweises als EINSTELLUNG (User 19.10.2026 'alles einstellbar, nie Hardcode', memory
-- regel-neue-funktionen-mit-schalter-und-debug Punkt 7). Eine Zeile je Ebene/Projekt/Wert; fehlt sie, gilt die naechste
-- Ebene (projekt > global > Code-Standard). Lesestelle: services/agent-ausweis-fristen.ts. Keine Env.
--   schatten_stunden     Schattenprofil Weg A (Standard 24)
--   erstnutzung_minuten  vorbereiteter Ausweis Weg B / Daemon-Start (Standard 10)
--   visum_minuten        Visum P22-T44 (Standard 30, vorgesehen, noch ohne Wirkung)
--   arbeitsfreigabe_stunden  Arbeitsfreigabe P22-T44 (Standard 24, vorgesehen, noch ohne Wirkung)
CREATE TABLE IF NOT EXISTS agent_ausweis_fristen (
  ebene TEXT NOT NULL CHECK (ebene IN ('global','projekt')),
  project TEXT,
  name TEXT NOT NULL CHECK (name IN ('schatten_stunden','erstnutzung_minuten','visum_minuten','arbeitsfreigabe_stunden')),
  wert INTEGER NOT NULL CHECK (wert > 0),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((ebene = 'global' AND project IS NULL) OR (ebene = 'projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_ausweis_fristen
  ON agent_ausweis_fristen(ebene, (COALESCE(project, '')), name);
