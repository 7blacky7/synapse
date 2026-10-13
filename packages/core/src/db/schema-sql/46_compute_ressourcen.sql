-- P20-T11/R1.1: bestehende Registry additiv erweitern; Legacy-Werte bleiben unknown.
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS contract_version INTEGER;
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS features TEXT[];
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS capability_revision BIGINT;
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS policy_revision BIGINT;
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS host_resource_domain TEXT;
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS ressourcen JSONB;
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS capabilities JSONB;
CREATE INDEX IF NOT EXISTS idx_embedding_knoten_resource_domain ON embedding_knoten(host_resource_domain);
