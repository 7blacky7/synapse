/** P18-T77: mirror schema-sql/137_reverse_code_stuecke.sql. */
export const REVERSE_CODE_STUECKE_SCHEMA_SQL = `
-- P18-T77: physical text pieces in the existing Reverse code table, one logical path.
ALTER TABLE reverse_code_dateien ADD COLUMN IF NOT EXISTS logischer_pfad TEXT;
ALTER TABLE reverse_code_dateien ADD COLUMN IF NOT EXISTS teil_nr INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reverse_code_dateien ADD COLUMN IF NOT EXISTS zeilen_offset INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_reverse_code_logisch ON reverse_code_dateien(eintrag_id,logischer_pfad,schicht,fingerabdruck,teil_nr) WHERE logischer_pfad IS NOT NULL;
`;
