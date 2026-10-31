/** P22-T45: Spiegel 117_agent_ausweis_fristen.sql. Additiv/idempotent; nach 111 (agent_identitaeten) ausfuehren. */
export const AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL = `
-- P22-T45 / 117. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben (Ausnahme P22-T50/P6-T49: Namens-CHECK um Werte erweitert).
-- Fristen des Agenten-Ausweises als EINSTELLUNG (User 19.10.2026 'alles einstellbar, nie Hardcode', memory
-- regel-neue-funktionen-mit-schalter-und-debug Punkt 7). Eine Zeile je Ebene/Projekt/Wert; fehlt sie, gilt die naechste
-- Ebene (projekt > global > Code-Standard). Lesestelle: services/agent-ausweis-fristen.ts. Keine Env.
--   schatten_stunden     Schattenprofil Weg A (Standard 24)
--   erstnutzung_minuten  vorbereiteter Ausweis Weg B / Daemon-Start (Standard 10)
--   visum_minuten        Visum P22-T44 (Standard 30, vorgesehen, noch ohne Wirkung)
--   arbeitsfreigabe_stunden  Arbeitsfreigabe P22-T44 (Standard 24, vorgesehen, noch ohne Wirkung)
--   anmeldung_plaene_minuten  P22-T50: Fenster eigener offener files-Plaene in chat(anmelden) (Standard 30)
--   files_plan_stunden   P6-T49: offene files-Plaene ohne Aktivitaet laufen danach ab (Standard 48)
--   shell_hinweis_minuten  P23-T3: Fertig-Hinweise shell_activity fuer beendete Jobs juenger als dieses Fenster (Standard 60)
--   coedit_aktiv_sekunden  P22-T199: Aktivitaetsfenster des Co-Edit Ready-Gates, nur Schalter coedit_ohne_gate AUS (ohne Wert Env SYNAPSE_COEDIT_AKTIV_MIN bzw. 300)
CREATE TABLE IF NOT EXISTS agent_ausweis_fristen (
  ebene TEXT NOT NULL CHECK (ebene IN ('global','projekt')),
  project TEXT,
  name TEXT NOT NULL CHECK (name IN ('schatten_stunden','erstnutzung_minuten','visum_minuten','arbeitsfreigabe_stunden','anmeldung_plaene_minuten','files_plan_stunden','shell_hinweis_minuten','coedit_aktiv_sekunden')),
  wert INTEGER NOT NULL CHECK (wert > 0),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((ebene = 'global' AND project IS NULL) OR (ebene = 'projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_ausweis_fristen
  ON agent_ausweis_fristen(ebene, (COALESCE(project, '')), name);
-- P22-T50/P6-T49/P23-T3/P22-T199: weitere Werte anmeldung_plaene_minuten, files_plan_stunden, shell_hinweis_minuten, coedit_aktiv_sekunden. Bestehende Tabellen: Namens-CHECK nur erweitern, wenn er den neuesten Wert noch
-- nicht kennt (idempotent; keine Daten werden geaendert, alle bisherigen Namen bleiben gueltig).
DO $fristen_name$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'agent_ausweis_fristen'::regclass
                   AND conname = 'agent_ausweis_fristen_name_check'
                   AND pg_get_constraintdef(oid) LIKE '%coedit_aktiv_sekunden%') THEN
    ALTER TABLE agent_ausweis_fristen DROP CONSTRAINT IF EXISTS agent_ausweis_fristen_name_check;
    ALTER TABLE agent_ausweis_fristen ADD CONSTRAINT agent_ausweis_fristen_name_check
      CHECK (name IN ('schatten_stunden','erstnutzung_minuten','visum_minuten','arbeitsfreigabe_stunden','anmeldung_plaene_minuten','files_plan_stunden','shell_hinweis_minuten','coedit_aktiv_sekunden'));
  END IF;
END
$fristen_name$;
`;
