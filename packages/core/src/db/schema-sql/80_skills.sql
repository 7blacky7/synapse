-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Skills und Skill-Hook-Telemetrie
-- ============================================================

--
-- Name: skill_hook_deliveries; Type: TABLE; Schema: public
--

CREATE TABLE public.skill_hook_deliveries (
    agent_id text NOT NULL,
    skill_name text NOT NULL,
    hook_name text NOT NULL,
    suggested_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: skill_hook_metrics; Type: TABLE; Schema: public
--

CREATE TABLE public.skill_hook_metrics (
    hook_name text NOT NULL,
    suggested_count bigint DEFAULT 0 NOT NULL,
    dedup_suppressed_count bigint DEFAULT 0 NOT NULL,
    load_skipped_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: skill_hook_preparations; Type: TABLE; Schema: public
--

CREATE TABLE public.skill_hook_preparations (
    source_type text DEFAULT 'channel'::text NOT NULL,
    source_id text NOT NULL,
    agent_id text NOT NULL,
    skill_name text NOT NULL,
    score double precision NOT NULL,
    reason text NOT NULL,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: skill_names; Type: TABLE; Schema: public
--

CREATE TABLE public.skill_names (
    skill_name text NOT NULL,
    section_count integer DEFAULT 0 NOT NULL,
    aktualisiert_am timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: skill_sections; Type: TABLE; Schema: public
-- Skill-Inhalte als Quelle der Wahrheit (P12-T13); Qdrant 'skills' haelt nur den Vektor.
--

CREATE TABLE public.skill_sections (
    punkt_id bigint NOT NULL,
    skill_name text NOT NULL,
    section text NOT NULL,
    content text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    scope text,
    project text,
    agent text,
    content_hash text,
    aktualisiert_am timestamp with time zone DEFAULT now() NOT NULL,
    embedded_at timestamp with time zone,
    embedding_modell text
);

ALTER TABLE ONLY public.skill_sections
    ADD CONSTRAINT skill_sections_pkey PRIMARY KEY (punkt_id);

CREATE UNIQUE INDEX idx_skill_sections_eindeutig ON public.skill_sections USING btree (skill_name, section, COALESCE(scope, 'global'::text), COALESCE(project, ''::text), COALESCE(agent, ''::text));

CREATE INDEX idx_skill_sections_skill ON public.skill_sections USING btree (skill_name);

CREATE INDEX idx_skill_sections_offen ON public.skill_sections USING btree (punkt_id) WHERE (embedded_at IS NULL);

--
-- Name: skill_hook_deliveries skill_hook_deliveries_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.skill_hook_deliveries
    ADD CONSTRAINT skill_hook_deliveries_pkey PRIMARY KEY (agent_id, skill_name);

--
-- Name: skill_hook_metrics skill_hook_metrics_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.skill_hook_metrics
    ADD CONSTRAINT skill_hook_metrics_pkey PRIMARY KEY (hook_name);

--
-- Name: skill_hook_preparations skill_hook_preparations_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.skill_hook_preparations
    ADD CONSTRAINT skill_hook_preparations_pkey PRIMARY KEY (source_type, source_id, agent_id, skill_name);

--
-- Name: skill_names skill_names_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.skill_names
    ADD CONSTRAINT skill_names_pkey PRIMARY KEY (skill_name);

--
-- Name: idx_skill_hook_preparations_agent; Type: INDEX; Schema: public
--

CREATE INDEX idx_skill_hook_preparations_agent ON public.skill_hook_preparations USING btree (agent_id, prepared_at DESC);

--
-- Name: idx_skill_hook_preparations_quelle; Type: INDEX; Schema: public
--

CREATE INDEX idx_skill_hook_preparations_quelle ON public.skill_hook_preparations USING btree (source_type, source_id);

--
-- Name: idx_skill_names_trgm; Type: INDEX; Schema: public
--

CREATE INDEX idx_skill_names_trgm ON public.skill_names USING gin (skill_name public.gin_trgm_ops);
