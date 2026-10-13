-- P20-T12: menschliche Policy unabhängig vom gesunden Registry-Eintrag.
CREATE TABLE IF NOT EXISTS compute_node_policy (
  node_id TEXT PRIMARY KEY,
  ausfuehrungsfreigabe BOOLEAN NOT NULL DEFAULT FALSE,
  modus TEXT NOT NULL DEFAULT 'automatik' CHECK (modus IN ('automatik','manuell')),
  faehigkeit_schalter JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(faehigkeit_schalter)='object'),
  usersperre JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(usersperre)='object'),
  policy_revision BIGINT NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
