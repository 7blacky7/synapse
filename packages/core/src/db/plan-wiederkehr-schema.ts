/** P3-T16: Spiegel 163_plan_wiederkehr.sql. Additiv/idempotent. */
export const PLAN_WIEDERKEHR_SCHEMA_SQL = `
-- P3-T16 / 163. Wiederkehrende Plaene (Skill taktik-wiederkehr-plaene, Schalter wiederkehr_plaene).
-- wiederkehrend: Plan ist ein wiederholbarer Ablauf (NULL/false = normaler Plan, Altverhalten).
-- durchlauf: Zahl abgeschlossener Durchlaeufe; letzter_durchlauf_am: Zeitpunkt der letzten Rueckstellung.
-- Task-Markierungen einmalig/abschluss liegen im JSON plans.tasks (kein Schema noetig).
-- Kleine Tabelle, nur ADD COLUMN ohne Default, keine Sperre ueber Daten.
-- Laufzeit-Spiegel: packages/core/src/db/plan-wiederkehr-schema.ts (PLAN_WIEDERKEHR_SCHEMA_SQL).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS wiederkehrend BOOLEAN;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS durchlauf INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS letzter_durchlauf_am TIMESTAMPTZ;
`;
