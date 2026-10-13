/** P20-T18: additiver Abschnitt im AUTH_SCHEMA_SQL nach der Knotenregistry. */
export const SERVER_EXECUTOR_SCHEMA_SQL = `
-- P20-T18/R4.3: Executor-Owner ergänzt dieselbe R1.1-Knotenregistry.
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS executor_owner TEXT;
`;
