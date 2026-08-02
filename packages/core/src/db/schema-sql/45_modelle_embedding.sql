-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Modell-Registry und Embedding-Knoten (Ollama/GPU-Lastverteilung)
-- ============================================================

--
-- Name: embedding_knoten; Type: TABLE; Schema: public
--

CREATE TABLE public.embedding_knoten (
    node_id text NOT NULL,
    host text NOT NULL,
    ollama_url text NOT NULL,
    modell text NOT NULL,
    modell_digest text NOT NULL,
    quantisierung text,
    native_dimension integer NOT NULL,
    ziel_dimension integer NOT NULL,
    num_ctx integer NOT NULL,
    vram_gesamt_mb integer NOT NULL,
    vram_frei_mb integer NOT NULL,
    system_memory_mb integer,
    cpu_cores integer,
    gpu_name text,
    max_concurrency integer NOT NULL,
    active_jobs integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    gesperrt_vom_user boolean DEFAULT false NOT NULL,
    sperrgrund text,
    service_token_hash text NOT NULL,
    agent_version text,
    boot_id text NOT NULL,
    last_sequence bigint DEFAULT 0 NOT NULL,
    boot_started_at timestamp with time zone NOT NULL,
    registriert_am timestamp with time zone DEFAULT now() NOT NULL,
    letzter_kontakt timestamp with time zone DEFAULT now() NOT NULL,
    aktualisiert_am timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embedding_knoten_active_jobs_check CHECK ((active_jobs >= 0)),
    CONSTRAINT embedding_knoten_last_sequence_check CHECK ((last_sequence >= 0)),
    CONSTRAINT embedding_knoten_max_concurrency_check CHECK ((max_concurrency > 0)),
    CONSTRAINT embedding_knoten_modell_digest_check CHECK ((modell_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT embedding_knoten_native_dimension_check CHECK ((native_dimension > 0)),
    CONSTRAINT embedding_knoten_num_ctx_check CHECK ((num_ctx > 0)),
    CONSTRAINT embedding_knoten_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'busy'::text, 'locked'::text, 'failed'::text]))),
    CONSTRAINT embedding_knoten_vram_frei_mb_check CHECK ((vram_frei_mb >= 0)),
    CONSTRAINT embedding_knoten_vram_gesamt_mb_check CHECK ((vram_gesamt_mb >= 0)),
    CONSTRAINT embedding_knoten_ziel_dimension_check CHECK ((ziel_dimension > 0))
);

--
-- Name: model_registry; Type: TABLE; Schema: public
--

CREATE TABLE public.model_registry (
    alias text NOT NULL,
    full_id text NOT NULL,
    provider text NOT NULL,
    context_window integer NOT NULL,
    output_limit integer,
    env_required text[] DEFAULT ARRAY[]::text[] NOT NULL,
    runtime_binary text DEFAULT 'claude'::text NOT NULL,
    runtime_path text,
    corridor_min integer NOT NULL,
    corridor_max integer NOT NULL,
    pricing_input_usd_per_mtok numeric(10,4),
    pricing_output_usd_per_mtok numeric(10,4),
    pricing_cache_usd_per_mtok numeric(10,4),
    cutoff_date date,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agy_model_value text,
    default_disabled_tools text[] DEFAULT ARRAY[]::text[] NOT NULL
);

--
-- Name: embedding_knoten embedding_knoten_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.embedding_knoten
    ADD CONSTRAINT embedding_knoten_pkey PRIMARY KEY (node_id);

--
-- Name: embedding_knoten embedding_knoten_service_token_hash_key; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.embedding_knoten
    ADD CONSTRAINT embedding_knoten_service_token_hash_key UNIQUE (service_token_hash);

--
-- Name: model_registry model_registry_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.model_registry
    ADD CONSTRAINT model_registry_pkey PRIMARY KEY (alias);

--
-- Name: idx_embedding_knoten_letzter_kontakt; Type: INDEX; Schema: public
--

CREATE INDEX idx_embedding_knoten_letzter_kontakt ON public.embedding_knoten USING btree (letzter_kontakt);
