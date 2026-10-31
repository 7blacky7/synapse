/** P22-T227: dauerhafte benannte, projektgebundene Shell-Ausgabe. */
export const SHELL_LOG_STROM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shell_log_stroeme (
  project TEXT NOT NULL, name TEXT NOT NULL, erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(project, name)
);
CREATE TABLE IF NOT EXISTS shell_log_strom_teile (
  id BIGSERIAL PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
  job_id UUID NOT NULL, folge INTEGER NOT NULL, inhalt TEXT NOT NULL,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(project, name) REFERENCES shell_log_stroeme(project, name) ON DELETE CASCADE,
  UNIQUE(job_id, folge)
);
CREATE INDEX IF NOT EXISTS idx_shell_log_strom_teile_lesen ON shell_log_strom_teile(project, name, id DESC);
`;
