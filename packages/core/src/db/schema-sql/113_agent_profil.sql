-- P22-T13 / 113 (W1b Phase V). Additiv und idempotent: nur CREATE ... IF NOT EXISTS und
-- ADD COLUMN IF NOT EXISTS (nullable bzw. mit Default). KEINE Aenderung bestehender
-- PRIMARY KEY/UNIQUE/NOT NULL, kein Backfill, keine Datenmigration.
-- Reihenfolge: nach 111_agent_identitaet und 112_agent_bezug.
-- Alle Funktionen dahinter sind standardmaessig AUS (agent_profil_schalter ohne Zeile = AUS).

-- (I) Produkt-Schalter fuer Profil-/Typ-/Schattenprofil-/Persona-/Task-Bindungs-/Tokenabrufverwaltung.
CREATE TABLE IF NOT EXISTS agent_profil_schalter (
  id BIGSERIAL PRIMARY KEY,
  ebene TEXT NOT NULL CHECK (ebene IN ('global','projekt')),
  project TEXT,
  funktion TEXT NOT NULL,
  aktiv BOOLEAN NOT NULL,
  grund TEXT,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((ebene = 'global' AND project IS NULL) OR (ebene = 'projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_profil_schalter
  ON agent_profil_schalter(ebene, (COALESCE(project, '')), funktion);

-- Typ-Katalog global/projekt, unveraenderliche Revisionen (Paket A).
CREATE TABLE IF NOT EXISTS agent_typen (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','projekt')),
  project TEXT,
  schluessel TEXT NOT NULL CHECK (schluessel ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  aktuelle_revision INTEGER NOT NULL DEFAULT 0 CHECK (aktuelle_revision >= 0),
  status TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','deaktiviert')),
  erstellt_von TEXT NOT NULL,
  erstellt_von_identity_id TEXT REFERENCES agent_identitaeten(id),
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((scope = 'global' AND project IS NULL) OR (scope = 'projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_typen_schluessel
  ON agent_typen(scope, (COALESCE(project, '')), schluessel);
CREATE TABLE IF NOT EXISTS agent_typ_revisionen (
  typ_id TEXT NOT NULL REFERENCES agent_typen(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  inhalt JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inhalt) = 'object'),
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  grund TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (typ_id, revision)
);

-- Profil-Override: agent_identitaeten.profil bleibt der aktuelle Override; neu nur Revision/Typbezug (CAS).
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS profil_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS typ_id TEXT REFERENCES agent_typen(id);
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS typ_revision INTEGER;
CREATE TABLE IF NOT EXISTS agent_profil_revisionen (
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  typ_id TEXT REFERENCES agent_typen(id),
  typ_revision INTEGER,
  persona_vorlage_id TEXT,
  persona_version INTEGER,
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  user_auftrag TEXT,
  grund TEXT NOT NULL CHECK (btrim(grund) <> ''),
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identity_id, revision)
);

-- Schattenprofile: 24h-Vorgang samt vorgesehenem, bis zur Bestaetigung UNGUELTIGEM Ausweis (Paket A/B).
CREATE TABLE IF NOT EXISTS agent_schattenprofile (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  ursprung_agent_id TEXT NOT NULL,
  ursprung_sitzung TEXT,
  ursprung_art TEXT NOT NULL DEFAULT 'legacy_register'
    CHECK (ursprung_art IN ('legacy_register','koordinator_voranlage','koordinator_start')),
  selbstangaben JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(selbstangaben) = 'object'),
  korrektur JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(korrektur) = 'object'),
  typ_id TEXT REFERENCES agent_typen(id),
  zustand TEXT NOT NULL DEFAULT 'pending' CHECK (zustand IN ('pending','bestaetigt','abgelaufen','abgelehnt')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ablauf_am TIMESTAMPTZ NOT NULL,
  vorgesehener_token_hash TEXT UNIQUE CHECK (vorgesehener_token_hash ~ '^[a-f0-9]{64}$'),
  vorgesehener_token_verschluesselt TEXT,
  vorgesehener_token_schluessel_id TEXT,
  identity_id TEXT REFERENCES agent_identitaeten(id),
  entschieden_von TEXT,
  entschieden_von_identity_id TEXT REFERENCES agent_identitaeten(id),
  entschieden_am TIMESTAMPTZ,
  user_zustimmung TEXT,
  grund TEXT,
  CHECK (ablauf_am > erstellt_am),
  CHECK (zustand <> 'bestaetigt' OR identity_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_schattenprofil_offen
  ON agent_schattenprofile(project, ursprung_agent_id) WHERE zustand = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_schattenprofile_ablauf
  ON agent_schattenprofile(project, ablauf_am) WHERE zustand = 'pending';
CREATE TABLE IF NOT EXISTS agent_schattenprofil_audit (
  id BIGSERIAL PRIMARY KEY,
  schattenprofil_id TEXT NOT NULL REFERENCES agent_schattenprofile(id),
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktion TEXT NOT NULL,
  alt JSONB,
  neu JSONB,
  grund TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_schattenprofil_audit_vorgang
  ON agent_schattenprofil_audit(schattenprofil_id, wann DESC);

-- Paket B: letzter Herkunftsort je logischem Lauf (nur Anzeige in der Koordinatorliste, keine Bindung der Tokengueltigkeit).
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS herkunftsort TEXT;

-- Verschluesselte, berechtigt abrufbare Ausweisablage (02845fc2, Paket D). Kein Klartext in PG.
-- Schluessel nur in der API-Betriebskonfiguration (SYNAPSE_AGENT_TOKEN_SCHLUESSEL), siehe agent-token-tresor.ts.
ALTER TABLE agent_identitaet_tokens ADD COLUMN IF NOT EXISTS token_verschluesselt TEXT;
ALTER TABLE agent_identitaet_tokens ADD COLUMN IF NOT EXISTS token_schluessel_id TEXT;
CREATE TABLE IF NOT EXISTS agent_token_abruf_audit (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  ziel_identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  token_id TEXT,
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  anlass TEXT,
  erfolg BOOLEAN NOT NULL,
  fehler TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_token_abruf_audit_ziel
  ON agent_token_abruf_audit(ziel_identity_id, wann DESC);

-- Persona-Bibliothek (versioniert) und ausdrueckliche Zuweisung; Standard leer = keine Zeile (Paket D).
CREATE TABLE IF NOT EXISTS agent_persona_vorlagen (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','projekt')),
  project TEXT,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  aktuelle_version INTEGER NOT NULL DEFAULT 0 CHECK (aktuelle_version >= 0),
  status TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','archiviert')),
  erstellt_von TEXT NOT NULL,
  erstellt_von_identity_id TEXT REFERENCES agent_identitaeten(id),
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((scope = 'global' AND project IS NULL) OR (scope = 'projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_persona_vorlagen_name
  ON agent_persona_vorlagen(scope, (COALESCE(project, '')), name);
CREATE TABLE IF NOT EXISTS agent_persona_versionen (
  vorlage_id TEXT NOT NULL REFERENCES agent_persona_vorlagen(id),
  version INTEGER NOT NULL CHECK (version > 0),
  inhalt JSONB NOT NULL CHECK (jsonb_typeof(inhalt) = 'object'),
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  user_auftrag TEXT NOT NULL CHECK (btrim(user_auftrag) <> ''),
  grund TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vorlage_id, version)
);
CREATE TABLE IF NOT EXISTS agent_persona_zuweisungen (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id),
  vorlage_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  user_auftrag TEXT NOT NULL CHECK (btrim(user_auftrag) <> ''),
  gesetzt_von TEXT NOT NULL,
  gesetzt_von_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (vorlage_id, version) REFERENCES agent_persona_versionen(vorlage_id, version)
);
CREATE TABLE IF NOT EXISTS agent_persona_audit (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  aktion TEXT NOT NULL CHECK (aktion IN ('zuweisen','aendern','entfernen')),
  alt JSONB,
  neu JSONB,
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  user_auftrag TEXT,
  grund TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optionale Task-Bindung (K14): keine Zeile = OFFEN (P7-T53-Standard). Paket T.
CREATE TABLE IF NOT EXISTS plan_task_bindungen (
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  art TEXT NOT NULL CHECK (art IN ('identitaet','team')),
  identity_ids TEXT[] NOT NULL CHECK (cardinality(identity_ids) > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  gesetzt_von TEXT NOT NULL,
  gesetzt_von_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  grund TEXT,
  CHECK (art <> 'identitaet' OR cardinality(identity_ids) = 1),
  PRIMARY KEY (project, task_id)
);
CREATE TABLE IF NOT EXISTS plan_task_bindung_audit (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  aktion TEXT NOT NULL CHECK (aktion IN ('festlegen','aendern','entblocken')),
  alt JSONB,
  neu JSONB,
  wer TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  grund TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (aktion = 'festlegen' OR btrim(COALESCE(grund, '')) <> '')
);
CREATE INDEX IF NOT EXISTS idx_plan_task_bindung_audit_task
  ON plan_task_bindung_audit(project, task_id, wann DESC);
