/** A10: no code/asset bytes in transport tables. */
export const PROJECT_RESTORE_SCHEMA_SQL = `
-- P13-T28/A10: existing init queue, explicit per-host consent, metadata-only snapshots.
ALTER TABLE project_init_jobs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'create';
ALTER TABLE project_init_jobs ADD COLUMN IF NOT EXISTS restore_lease UUID;
ALTER TABLE project_init_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS project_host_bindings (
 project TEXT NOT NULL, hostname TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(project,hostname)
);
CREATE INDEX IF NOT EXISTS idx_project_restore_pending ON project_init_jobs(hostname,status) WHERE mode='restore_existing';
CREATE TABLE IF NOT EXISTS project_code_manifests (
 id UUID PRIMARY KEY, project TEXT NOT NULL, hostname TEXT NOT NULL, lease_until TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS project_code_manifest_entries (
 manifest_id UUID NOT NULL REFERENCES project_code_manifests(id) ON DELETE CASCADE,
 file_path TEXT NOT NULL, sha256 TEXT NOT NULL, groesse BIGINT NOT NULL,
 PRIMARY KEY(manifest_id,file_path)
);
`;
