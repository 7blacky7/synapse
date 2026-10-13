-- P20-T13/R1.3: erst aktualisierte Leser ausrollen; compute_cpu_only default AUS.
ALTER TABLE embedding_knoten ADD COLUMN IF NOT EXISTS node_kind TEXT NOT NULL DEFAULT 'embedding';
ALTER TABLE embedding_knoten ALTER COLUMN ollama_url DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN modell DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN modell_digest DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN native_dimension DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN ziel_dimension DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN num_ctx DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN vram_gesamt_mb DROP NOT NULL;
ALTER TABLE embedding_knoten ALTER COLUMN vram_frei_mb DROP NOT NULL;
DO $cpu_constraint$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='embedding_knoten'::regclass AND conname='embedding_knoten_typed_model') THEN
    ALTER TABLE embedding_knoten ADD CONSTRAINT embedding_knoten_typed_model CHECK(
      (node_kind='embedding' AND ollama_url IS NOT NULL AND modell IS NOT NULL AND modell_digest IS NOT NULL
        AND native_dimension IS NOT NULL AND ziel_dimension IS NOT NULL AND num_ctx IS NOT NULL
        AND vram_gesamt_mb IS NOT NULL AND vram_frei_mb IS NOT NULL)
      OR (node_kind='cpu' AND contract_version IS NOT NULL AND contract_version=1 AND features IS NOT NULL AND features@>ARRAY['compute_cpu_only']::text[]
        AND ollama_url IS NULL AND modell IS NULL AND modell_digest IS NULL AND quantisierung IS NULL
        AND native_dimension IS NULL AND ziel_dimension IS NULL AND num_ctx IS NULL
        AND vram_gesamt_mb IS NULL AND vram_frei_mb IS NULL));
  END IF;
END $cpu_constraint$;
