-- P20-T18/R4.3: Executor-Owner ergänzt dieselbe R1.1-Knotenregistry.
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS executor_owner TEXT;
