-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Datei-Versionierung, Batch-Plaene, Watcher
-- ============================================================

--
-- Name: daemon_heartbeats; Type: TABLE; Schema: public
--

CREATE TABLE public.daemon_heartbeats (
    project text NOT NULL,
    hostname text NOT NULL,
    daemon_pid integer,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: file_batch_plans; Type: TABLE; Schema: public
--

CREATE TABLE public.file_batch_plans (
    id bigint NOT NULL,
    project text NOT NULL,
    owner_agent_id text,
    ops jsonb NOT NULL,
    expected_hashes jsonb NOT NULL,
    previews jsonb NOT NULL,
    status public.file_batch_status DEFAULT 'open'::public.file_batch_status NOT NULL,
    open_for_coedit boolean DEFAULT true NOT NULL,
    notify_channel text,
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    reason text
);

--
-- Name: file_batch_plans_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.file_batch_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: file_batch_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.file_batch_plans_id_seq OWNED BY public.file_batch_plans.id;

--
-- Name: file_versions; Type: TABLE; Schema: public
--

CREATE TABLE public.file_versions (
    id bigint NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    edit_action text,
    agent_id text,
    batch_id bigint,
    size_bytes integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    reason text,
    feature_tag text,
    parent_version_id bigint,
    git_commit_sha text,
    agent_note text
);

--
-- Name: file_versions_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.file_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: file_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.file_versions_id_seq OWNED BY public.file_versions.id;

--
-- Name: watcher_events; Type: TABLE; Schema: public
--

CREATE TABLE public.watcher_events (
    id bigint NOT NULL,
    project text NOT NULL,
    event_type text NOT NULL,
    file_path text NOT NULL,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: watcher_events_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.watcher_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: watcher_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.watcher_events_id_seq OWNED BY public.watcher_events.id;

--
-- Name: file_batch_plans id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.file_batch_plans ALTER COLUMN id SET DEFAULT nextval('public.file_batch_plans_id_seq'::regclass);

--
-- Name: file_versions id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.file_versions ALTER COLUMN id SET DEFAULT nextval('public.file_versions_id_seq'::regclass);

--
-- Name: watcher_events id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.watcher_events ALTER COLUMN id SET DEFAULT nextval('public.watcher_events_id_seq'::regclass);

--
-- Name: daemon_heartbeats daemon_heartbeats_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.daemon_heartbeats
    ADD CONSTRAINT daemon_heartbeats_pkey PRIMARY KEY (project);

--
-- Name: file_batch_plans file_batch_plans_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.file_batch_plans
    ADD CONSTRAINT file_batch_plans_pkey PRIMARY KEY (id);

--
-- Name: file_versions file_versions_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_pkey PRIMARY KEY (id);

--
-- Name: watcher_events watcher_events_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.watcher_events
    ADD CONSTRAINT watcher_events_pkey PRIMARY KEY (id);

--
-- Name: idx_daemon_heartbeats_last_seen; Type: INDEX; Schema: public
--

CREATE INDEX idx_daemon_heartbeats_last_seen ON public.daemon_heartbeats USING btree (last_seen DESC);

--
-- Name: idx_file_batch_plans_open; Type: INDEX; Schema: public
--

CREATE INDEX idx_file_batch_plans_open ON public.file_batch_plans USING btree (project, expires_at) WHERE (status = 'open'::public.file_batch_status);

--
-- Name: idx_file_batch_plans_status; Type: INDEX; Schema: public
--

CREATE INDEX idx_file_batch_plans_status ON public.file_batch_plans USING btree (project, status, created_at DESC);

--
-- Name: idx_file_versions_batch; Type: INDEX; Schema: public
--

CREATE INDEX idx_file_versions_batch ON public.file_versions USING btree (batch_id) WHERE (batch_id IS NOT NULL);

--
-- Name: idx_file_versions_lookup; Type: INDEX; Schema: public
--

CREATE INDEX idx_file_versions_lookup ON public.file_versions USING btree (project, file_path, created_at DESC);

--
-- Name: idx_fv_feature_tag; Type: INDEX; Schema: public
--

CREATE INDEX idx_fv_feature_tag ON public.file_versions USING btree (project, feature_tag) WHERE (feature_tag IS NOT NULL);

--
-- Name: idx_fv_git_sha; Type: INDEX; Schema: public
--

CREATE INDEX idx_fv_git_sha ON public.file_versions USING btree (git_commit_sha) WHERE (git_commit_sha IS NOT NULL);

--
-- Name: idx_fv_parent; Type: INDEX; Schema: public
--

CREATE INDEX idx_fv_parent ON public.file_versions USING btree (parent_version_id) WHERE (parent_version_id IS NOT NULL);

--
-- Name: idx_watcher_events_path; Type: INDEX; Schema: public
--

CREATE INDEX idx_watcher_events_path ON public.watcher_events USING btree (project, file_path);

--
-- Name: idx_watcher_events_project_time; Type: INDEX; Schema: public
--

CREATE INDEX idx_watcher_events_project_time ON public.watcher_events USING btree (project, created_at DESC);
