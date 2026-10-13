-- P20-T16: revisions- und bootgebundener Soll-/Istzustand, keine Ausführungsfreigabe.
CREATE TABLE IF NOT EXISTS compute_node_control (
 node_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL,
 revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 desired JSONB NOT NULL CHECK(jsonb_typeof(desired)='object'),
 observed JSONB, ack_revision BIGINT,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 observed_at TIMESTAMPTZ,
 CHECK(ack_revision IS NULL OR ack_revision=revision)
);
