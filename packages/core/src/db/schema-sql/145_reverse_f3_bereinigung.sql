-- P18-T97/F3: immutable, entry-scoped commit evidence. No startup validation of old tables.
CREATE TABLE IF NOT EXISTS reverse_f3_bereinigungs_batches (
 eintrag_id text NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
 batch_nr bigint NOT NULL CHECK (batch_nr >= 0),
 batch_sha256 text NOT NULL CHECK (batch_sha256 ~ '^[a-f0-9]{64}$'),
 ops jsonb NOT NULL CHECK (jsonb_typeof(ops)='array'),
 delta jsonb NOT NULL CHECK (jsonb_typeof(delta)='object'),
 backup_beleg text NOT NULL CHECK (length(backup_beleg)>=8),
 projekt_sentinel_sha256 text NOT NULL CHECK (projekt_sentinel_sha256 ~ '^[a-f0-9]{64}$'),
 einstellungen_revision text NOT NULL,
 abgeschlossen_am timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (eintrag_id,manifest_sha256,batch_nr)
);
