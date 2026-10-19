-- P22-T36 / 116 (W2-P1). Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Generische Runtime-Auftraege JE IDENTITAET (Form nach RuntimeCommandDraft, core/types/runtime-vertrag-entwurf.ts):
-- Neustart, Update, Modell- und Runtime-Wechsel, Stop. Die W2-Runtime nutzt spaeter dieselbe Tabelle fuer alle Agenten.
-- Gewuenscht (gewuenscht) und tatsaechlich (tatsaechlich, erst per ACK nach erfolgreichem Neustart) bleiben strikt getrennt.
-- P1 legt nur an, liest und bricht ab; Ausfuehrung (claim/ack) kommt mit dem Runtime-Daemon.
CREATE TABLE IF NOT EXISTS agent_runtime_auftraege (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  art TEXT NOT NULL CHECK (art IN ('neustart','update','modellwechsel','runtime_wechsel','stop')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','accepted','completed','rejected','cancelled')),
  gewuenscht JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(gewuenscht) = 'object'),
  tatsaechlich JSONB CHECK (tatsaechlich IS NULL OR jsonb_typeof(tatsaechlich) = 'object'),
  hands_off JSONB CHECK (hands_off IS NULL OR jsonb_typeof(hands_off) = 'object'),
  grund TEXT NOT NULL,
  erstellt_von TEXT NOT NULL,
  actor_identity_id TEXT REFERENCES agent_identitaeten(id),
  idempotenz_schluessel TEXT,
  claim_revision INTEGER NOT NULL DEFAULT 0 CHECK (claim_revision >= 0),
  lease_bis TIMESTAMPTZ,
  letzter_fehler TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  abgeschlossen_am TIMESTAMPTZ,
  abgeschlossen_von TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runtime_auftraege_idem
  ON agent_runtime_auftraege(identity_id, idempotenz_schluessel) WHERE idempotenz_schluessel IS NOT NULL;
-- Hoechstens ein offener Auftrag je Identitaet und Art.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runtime_auftraege_offen
  ON agent_runtime_auftraege(identity_id, art) WHERE status IN ('pending','claimed','accepted');
CREATE INDEX IF NOT EXISTS idx_agent_runtime_auftraege_identity
  ON agent_runtime_auftraege(identity_id, erstellt_am DESC);
