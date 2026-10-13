-- P20-T9: ein Opt-out je logischem Projekt, unabhängig von dessen Hostzeilen.
CREATE TABLE IF NOT EXISTS compute_project_policy (
  project TEXT PRIMARY KEY,
  pc_gpu_ausgeschlossen BOOLEAN NOT NULL DEFAULT FALSE,
  policy_revision BIGINT NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
