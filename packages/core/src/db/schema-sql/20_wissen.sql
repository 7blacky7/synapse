-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Wissensablage: Memories, Gedanken, Plaene, Vorschlaege, Tech-Docs
-- ============================================================

--
-- Name: memories; Type: TABLE; Schema: public
--

CREATE TABLE public.memories (
    id text NOT NULL,
    project text NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'note'::text,
    content text NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    embedded_at timestamp with time zone
);

--
-- Name: plans; Type: TABLE; Schema: public
--

CREATE TABLE public.plans (
    id text NOT NULL,
    project text NOT NULL,
    name text NOT NULL,
    description text,
    goals text[] DEFAULT '{}'::text[],
    architecture text,
    tasks jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    kurz_id text,
    aktiv boolean,
    naechste_task_nr integer
);

--
-- Name: proposals; Type: TABLE; Schema: public
--

CREATE TABLE public.proposals (
    id text NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    suggested_content text NOT NULL,
    description text,
    author text,
    status text DEFAULT 'pending'::text,
    tags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    embedded_at timestamp with time zone
);

--
-- Name: tech_docs; Type: TABLE; Schema: public
--

CREATE TABLE public.tech_docs (
    id text NOT NULL,
    framework text NOT NULL,
    version text NOT NULL,
    section text,
    content text NOT NULL,
    type text,
    category text DEFAULT 'framework'::text,
    content_hash text,
    source text DEFAULT 'context7'::text,
    indexed_at timestamp with time zone DEFAULT now(),
    project text,
    embedded_at timestamp with time zone
);

--
-- Name: context7_automatik_stand; Type: TABLE; Schema: public
-- (P12-T17, von Hand nachgetragen bis zum naechsten Dump; Quelle: SCHEMA_SQL in schema.ts)
--

CREATE TABLE public.context7_automatik_stand (
    id integer NOT NULL,
    monat date,
    abrufe_monat integer DEFAULT 0 NOT NULL,
    tag date,
    abrufe_heute integer DEFAULT 0 NOT NULL,
    abrufe_gesamt bigint DEFAULT 0 NOT NULL,
    letzter_aufruf timestamp with time zone,
    pause_bis timestamp with time zone,
    pause_grund text,
    tokens_max integer,
    CONSTRAINT context7_automatik_stand_id_check CHECK ((id = 1))
);

--
-- Name: context7_bibliotheken; Type: TABLE; Schema: public
-- (P12-T17, von Hand nachgetragen bis zum naechsten Dump; Quelle: SCHEMA_SQL in schema.ts)
--

CREATE TABLE public.context7_bibliotheken (
    framework text NOT NULL,
    anzeige_name text,
    status text DEFAULT 'abgerufen'::text NOT NULL,
    library_id text,
    titel text,
    quelle_stand timestamp with time zone,
    versions text[] DEFAULT '{}'::text[] NOT NULL,
    trust_score real,
    benchmark_score real,
    total_snippets integer,
    chunks integer DEFAULT 0 NOT NULL,
    abfragen text[] DEFAULT '{}'::text[] NOT NULL,
    gesamt_tokens integer,
    abgerufen_am timestamp with time zone,
    letzter_check timestamp with time zone,
    naechster_check timestamp with time zone,
    letzter_fehler text,
    erstellt_am timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.context7_automatik_stand
    ADD CONSTRAINT context7_automatik_stand_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.context7_bibliotheken
    ADD CONSTRAINT context7_bibliotheken_pkey PRIMARY KEY (framework);

CREATE INDEX idx_context7_bibliotheken_check ON public.context7_bibliotheken USING btree (naechster_check);

--
-- Name: thoughts; Type: TABLE; Schema: public
--

CREATE TABLE public.thoughts (
    id text NOT NULL,
    project text NOT NULL,
    source text NOT NULL,
    content text NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    "timestamp" timestamp with time zone DEFAULT now(),
    task_id text,
    embedded_at timestamp with time zone
);

--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);

--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

--
-- Name: proposals proposals_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_pkey PRIMARY KEY (id);

--
-- Name: tech_docs tech_docs_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.tech_docs
    ADD CONSTRAINT tech_docs_pkey PRIMARY KEY (id);

--
-- Name: thoughts thoughts_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.thoughts
    ADD CONSTRAINT thoughts_pkey PRIMARY KEY (id);

--
-- Name: idx_memories_embed_backlog; Type: INDEX; Schema: public
--

CREATE INDEX idx_memories_embed_backlog ON public.memories USING btree (project) WHERE (embedded_at IS NULL);

--
-- Name: idx_memories_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_memories_project ON public.memories USING btree (project);

--
-- Name: idx_plans_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_plans_project ON public.plans USING btree (project);

--
-- Name: idx_proposals_embed_backlog; Type: INDEX; Schema: public
--

CREATE INDEX idx_proposals_embed_backlog ON public.proposals USING btree (project) WHERE (embedded_at IS NULL);

--
-- Name: idx_proposals_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_proposals_project ON public.proposals USING btree (project);

--
-- Name: idx_tech_docs_embed_backlog; Type: INDEX; Schema: public
--

CREATE INDEX idx_tech_docs_embed_backlog ON public.tech_docs USING btree (indexed_at) WHERE (embedded_at IS NULL);

--
-- Name: idx_tech_docs_framework; Type: INDEX; Schema: public
--

CREATE INDEX idx_tech_docs_framework ON public.tech_docs USING btree (framework, version);

--
-- Name: idx_tech_docs_hash; Type: INDEX; Schema: public
--

CREATE INDEX idx_tech_docs_hash ON public.tech_docs USING btree (content_hash);

--
-- Name: idx_tech_docs_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_tech_docs_project ON public.tech_docs USING btree (project);

--
-- Name: idx_thoughts_embed_backlog; Type: INDEX; Schema: public
--

CREATE INDEX idx_thoughts_embed_backlog ON public.thoughts USING btree (project) WHERE (embedded_at IS NULL);

--
-- Name: idx_thoughts_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_thoughts_project ON public.thoughts USING btree (project);

--
-- Name: idx_thoughts_project_task_id; Type: INDEX; Schema: public
--

CREATE INDEX idx_thoughts_project_task_id ON public.thoughts USING btree (project, task_id) WHERE (task_id IS NOT NULL);

--
-- Name: uq_memories_project_name; Type: INDEX; Schema: public
--

CREATE UNIQUE INDEX uq_memories_project_name ON public.memories USING btree (project, name);

--
-- Name: uq_plans_project_name; Type: INDEX; Schema: public
--

CREATE UNIQUE INDEX uq_plans_project_name ON public.plans USING btree (project, name);

--
-- Name: uq_tech_docs_project_hash; Type: INDEX; Schema: public
--

CREATE UNIQUE INDEX uq_tech_docs_project_hash ON public.tech_docs USING btree (COALESCE(project, ''::text), content_hash);
