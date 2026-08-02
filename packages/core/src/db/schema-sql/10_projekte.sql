-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Projekte, Workspaces, Ignore-Regeln
-- ============================================================

--
-- Name: project_ignore_rules; Type: TABLE; Schema: public
--

CREATE TABLE public.project_ignore_rules (
    id bigint NOT NULL,
    project text NOT NULL,
    pattern text NOT NULL,
    scope text,
    enabled boolean DEFAULT true NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    kommentar text,
    sort_order integer DEFAULT 100 NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    modus text DEFAULT 'ausgeblendet'::text NOT NULL,
    eingeblendet_bis timestamp with time zone,
    CONSTRAINT project_ignore_rules_modus_check CHECK ((modus = ANY (ARRAY['gesperrt'::text, 'ausgeblendet'::text])))
);

--
-- Name: project_ignore_rules_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.project_ignore_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: project_ignore_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.project_ignore_rules_id_seq OWNED BY public.project_ignore_rules.id;

--
-- Name: project_init_jobs; Type: TABLE; Schema: public
--

CREATE TABLE public.project_init_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    hostname text,
    template text,
    requested_by text,
    status public.project_init_status DEFAULT 'pending'::public.project_init_status NOT NULL,
    resolved_path text,
    error text,
    message text,
    claimed_by text,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: project_setup_status; Type: TABLE; Schema: public
--

CREATE TABLE public.project_setup_status (
    project text NOT NULL,
    setup_phase text DEFAULT 'none'::text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: project_workspaces; Type: TABLE; Schema: public
--

CREATE TABLE public.project_workspaces (
    project text NOT NULL,
    container_id text,
    status text DEFAULT 'cold'::text NOT NULL,
    image text DEFAULT 'synapse-workspace:latest'::text NOT NULL,
    volume_name text,
    cpu_limit real DEFAULT 1.0 NOT NULL,
    mem_limit_mb integer DEFAULT 512 NOT NULL,
    pids_limit integer DEFAULT 200 NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    last_started_at timestamp with time zone,
    last_stopped_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tmpfs_mb integer DEFAULT 256 NOT NULL,
    name text DEFAULT 'main'::text NOT NULL,
    role text
);

--
-- Name: projects; Type: TABLE; Schema: public
--

CREATE TABLE public.projects (
    name text NOT NULL,
    hostname text NOT NULL,
    path text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    last_access timestamp with time zone DEFAULT now(),
    enabled boolean DEFAULT true NOT NULL
);

--
-- Name: workspace_roles; Type: TABLE; Schema: public
--

CREATE TABLE public.workspace_roles (
    id bigint NOT NULL,
    project text,
    role text NOT NULL,
    image text DEFAULT 'synapse-workspace:latest'::text NOT NULL,
    cpu_limit real DEFAULT 1.0 NOT NULL,
    mem_limit_mb integer DEFAULT 512 NOT NULL,
    pids_limit integer DEFAULT 200 NOT NULL,
    tmpfs_mb integer DEFAULT 256 NOT NULL,
    init_command text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    devices text[] DEFAULT '{}'::text[] NOT NULL,
    security_opts text[] DEFAULT '{}'::text[] NOT NULL,
    cap_add text[] DEFAULT '{}'::text[] NOT NULL,
    init_timeout_ms integer DEFAULT 120000 NOT NULL
);

--
-- Name: workspace_roles_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.workspace_roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: workspace_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.workspace_roles_id_seq OWNED BY public.workspace_roles.id;

--
-- Name: project_ignore_rules id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.project_ignore_rules ALTER COLUMN id SET DEFAULT nextval('public.project_ignore_rules_id_seq'::regclass);

--
-- Name: workspace_roles id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.workspace_roles ALTER COLUMN id SET DEFAULT nextval('public.workspace_roles_id_seq'::regclass);

--
-- Name: project_ignore_rules project_ignore_rules_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.project_ignore_rules
    ADD CONSTRAINT project_ignore_rules_pkey PRIMARY KEY (id);

--
-- Name: project_init_jobs project_init_jobs_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.project_init_jobs
    ADD CONSTRAINT project_init_jobs_pkey PRIMARY KEY (id);

--
-- Name: project_setup_status project_setup_status_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.project_setup_status
    ADD CONSTRAINT project_setup_status_pkey PRIMARY KEY (project);

--
-- Name: project_workspaces project_workspaces_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.project_workspaces
    ADD CONSTRAINT project_workspaces_pkey PRIMARY KEY (project, name);

--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (name, hostname);

--
-- Name: workspace_roles workspace_roles_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.workspace_roles
    ADD CONSTRAINT workspace_roles_pkey PRIMARY KEY (id);

--
-- Name: idx_project_ignore_rules_aktiv; Type: INDEX; Schema: public
--

CREATE INDEX idx_project_ignore_rules_aktiv ON public.project_ignore_rules USING btree (project, sort_order) WHERE enabled;

--
-- Name: idx_project_ignore_rules_eindeutig; Type: INDEX; Schema: public
--

CREATE UNIQUE INDEX idx_project_ignore_rules_eindeutig ON public.project_ignore_rules USING btree (project, pattern, COALESCE(scope, ''::text));

--
-- Name: idx_project_ignore_rules_modus; Type: INDEX; Schema: public
--

CREATE INDEX idx_project_ignore_rules_modus ON public.project_ignore_rules USING btree (project, modus) WHERE enabled;

--
-- Name: idx_project_init_jobs_pending; Type: INDEX; Schema: public
--

CREATE INDEX idx_project_init_jobs_pending ON public.project_init_jobs USING btree (created_at) WHERE (status = 'pending'::public.project_init_status);

--
-- Name: idx_project_init_jobs_status; Type: INDEX; Schema: public
--

CREATE INDEX idx_project_init_jobs_status ON public.project_init_jobs USING btree (status, created_at);

--
-- Name: idx_project_workspaces_active_activity; Type: INDEX; Schema: public
--

CREATE INDEX idx_project_workspaces_active_activity ON public.project_workspaces USING btree (last_activity_at) WHERE (status = 'active'::text);

--
-- Name: idx_project_workspaces_status; Type: INDEX; Schema: public
--

CREATE INDEX idx_project_workspaces_status ON public.project_workspaces USING btree (status);

--
-- Name: uq_workspace_roles_scope_role; Type: INDEX; Schema: public
--

CREATE UNIQUE INDEX uq_workspace_roles_scope_role ON public.workspace_roles USING btree (COALESCE(project, ''::text), role);
