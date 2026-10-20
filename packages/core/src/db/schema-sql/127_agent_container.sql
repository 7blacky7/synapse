-- P22-T82 / 127. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird geaendert, geloescht oder gedroppt.
-- Spezialisten im Runtime-Container: Kontingent je Projekt (Anzahl gleichzeitig lebender Container-Agenten). Standard 0 = keine Zeile.
-- Setzen nur der User (Koordinator fragt an, Freigabe-Weg Koordinator -> Main -> User). Das API-Budget bleibt in agent_api_budget (120).
CREATE TABLE IF NOT EXISTS projekt_agenten_kontingent (
  project TEXT PRIMARY KEY,
  container_agenten_max INTEGER NOT NULL DEFAULT 0 CHECK (container_agenten_max >= 0 AND container_agenten_max <= 100),
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  grund TEXT NOT NULL
);
