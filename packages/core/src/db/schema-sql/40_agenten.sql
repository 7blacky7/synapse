-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Agenten, Sessions, Events, Spezialisten-Channels
-- ============================================================

--
-- Name: agent_event_acks; Type: TABLE; Schema: public
--

CREATE TABLE public.agent_event_acks (
    event_id integer NOT NULL,
    agent_id text NOT NULL,
    acked_at timestamp with time zone DEFAULT now(),
    reaction text
);

--
-- Name: agent_events; Type: TABLE; Schema: public
--

CREATE TABLE public.agent_events (
    id integer NOT NULL,
    project text NOT NULL,
    event_type text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    scope text DEFAULT 'all'::text NOT NULL,
    source_id text NOT NULL,
    payload text,
    requires_ack boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: agent_events_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.agent_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: agent_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.agent_events_id_seq OWNED BY public.agent_events.id;

--
-- Name: agent_onboardings; Type: TABLE; Schema: public
--

CREATE TABLE public.agent_onboardings (
    agent_id text NOT NULL,
    project text NOT NULL,
    server_instance_id text NOT NULL,
    onboarded_at timestamp with time zone DEFAULT now(),
    rolle text,
    rolle_quelle text
);

--
-- Name: agent_sessions; Type: TABLE; Schema: public
--

CREATE TABLE public.agent_sessions (
    id text NOT NULL,
    project text NOT NULL,
    model text,
    cutoff_date date,
    status text DEFAULT 'active'::text,
    registered_at timestamp with time zone DEFAULT now(),
    server_instance_id text,
    provider text,
    model_full_id text
);

--
-- Name: chat_messages; Type: TABLE; Schema: public
--

CREATE TABLE public.chat_messages (
    id integer NOT NULL,
    project text NOT NULL,
    sender_id text NOT NULL,
    recipient_id text,
    content text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now()
);

--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.chat_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;

--
-- Name: specialist_channel_members; Type: TABLE; Schema: public
--

CREATE TABLE public.specialist_channel_members (
    channel_id integer NOT NULL,
    agent_name text NOT NULL,
    joined_at timestamp with time zone DEFAULT now(),
    last_read_message_id bigint DEFAULT 0 NOT NULL,
    last_notified_message_id bigint,
    read_initialized_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: specialist_channel_messages; Type: TABLE; Schema: public
--

CREATE TABLE public.specialist_channel_messages (
    id integer NOT NULL,
    channel_id integer,
    sender text NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: specialist_channel_messages_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.specialist_channel_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: specialist_channel_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.specialist_channel_messages_id_seq OWNED BY public.specialist_channel_messages.id;

--
-- Name: specialist_channels; Type: TABLE; Schema: public
--

CREATE TABLE public.specialist_channels (
    id integer NOT NULL,
    name text NOT NULL,
    project text NOT NULL,
    description text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: specialist_channels_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.specialist_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: specialist_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.specialist_channels_id_seq OWNED BY public.specialist_channels.id;

--
-- Name: specialist_inbox; Type: TABLE; Schema: public
--

CREATE TABLE public.specialist_inbox (
    id integer NOT NULL,
    from_agent text NOT NULL,
    to_agent text NOT NULL,
    content text NOT NULL,
    processed boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: specialist_inbox_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.specialist_inbox_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: specialist_inbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.specialist_inbox_id_seq OWNED BY public.specialist_inbox.id;

--
-- Name: specialist_jobs; Type: TABLE; Schema: public
--

CREATE TABLE public.specialist_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project text NOT NULL,
    action text NOT NULL,
    args jsonb NOT NULL,
    status public.specialist_job_status DEFAULT 'pending'::public.specialist_job_status NOT NULL,
    result jsonb,
    error text,
    message text,
    claimed_by text,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: wrapper_status; Type: TABLE; Schema: public
--

CREATE TABLE public.wrapper_status (
    agent_name text NOT NULL,
    project text NOT NULL,
    wrapper_pid integer,
    inner_pid integer,
    socket_path text,
    model text,
    model_full_id text,
    provider text,
    status text DEFAULT 'idle'::text NOT NULL,
    busy boolean DEFAULT false NOT NULL,
    current_task text,
    context_ceiling integer,
    tokens_input integer,
    tokens_output integer,
    tokens_percent numeric(5,2),
    channels text[] DEFAULT '{}'::text[] NOT NULL,
    connected_mcp boolean DEFAULT false NOT NULL,
    last_activity timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: agent_events id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.agent_events ALTER COLUMN id SET DEFAULT nextval('public.agent_events_id_seq'::regclass);

--
-- Name: chat_messages id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);

--
-- Name: specialist_channel_messages id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.specialist_channel_messages ALTER COLUMN id SET DEFAULT nextval('public.specialist_channel_messages_id_seq'::regclass);

--
-- Name: specialist_channels id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.specialist_channels ALTER COLUMN id SET DEFAULT nextval('public.specialist_channels_id_seq'::regclass);

--
-- Name: specialist_inbox id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.specialist_inbox ALTER COLUMN id SET DEFAULT nextval('public.specialist_inbox_id_seq'::regclass);

--
-- Name: agent_event_acks agent_event_acks_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.agent_event_acks
    ADD CONSTRAINT agent_event_acks_pkey PRIMARY KEY (event_id, agent_id);

--
-- Name: agent_events agent_events_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_pkey PRIMARY KEY (id);

--
-- Name: agent_onboardings agent_onboardings_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.agent_onboardings
    ADD CONSTRAINT agent_onboardings_pkey PRIMARY KEY (agent_id, project, server_instance_id);

--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);

--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

--
-- Name: specialist_channel_members specialist_channel_members_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_channel_members
    ADD CONSTRAINT specialist_channel_members_pkey PRIMARY KEY (channel_id, agent_name);

--
-- Name: specialist_channel_messages specialist_channel_messages_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_channel_messages
    ADD CONSTRAINT specialist_channel_messages_pkey PRIMARY KEY (id);

--
-- Name: specialist_channels specialist_channels_name_project_key; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_channels
    ADD CONSTRAINT specialist_channels_name_project_key UNIQUE (name, project);

--
-- Name: specialist_channels specialist_channels_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_channels
    ADD CONSTRAINT specialist_channels_pkey PRIMARY KEY (id);

--
-- Name: specialist_inbox specialist_inbox_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_inbox
    ADD CONSTRAINT specialist_inbox_pkey PRIMARY KEY (id);

--
-- Name: specialist_jobs specialist_jobs_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_jobs
    ADD CONSTRAINT specialist_jobs_pkey PRIMARY KEY (id);

--
-- Name: wrapper_status wrapper_status_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.wrapper_status
    ADD CONSTRAINT wrapper_status_pkey PRIMARY KEY (agent_name, project);

--
-- Name: idx_agent_event_acks_agent; Type: INDEX; Schema: public
--

CREATE INDEX idx_agent_event_acks_agent ON public.agent_event_acks USING btree (agent_id);

--
-- Name: idx_agent_events_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_agent_events_project ON public.agent_events USING btree (project, created_at);

--
-- Name: idx_agent_events_type; Type: INDEX; Schema: public
--

CREATE INDEX idx_agent_events_type ON public.agent_events USING btree (event_type);

--
-- Name: idx_agent_sessions_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_agent_sessions_project ON public.agent_sessions USING btree (project);

--
-- Name: idx_chat_messages_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_chat_messages_project ON public.chat_messages USING btree (project, "timestamp");

--
-- Name: idx_chat_messages_recipient; Type: INDEX; Schema: public
--

CREATE INDEX idx_chat_messages_recipient ON public.chat_messages USING btree (recipient_id);

--
-- Name: idx_specialist_channel_members_agent; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_channel_members_agent ON public.specialist_channel_members USING btree (agent_name, channel_id);

--
-- Name: idx_specialist_channel_messages_channel; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_channel_messages_channel ON public.specialist_channel_messages USING btree (channel_id, id DESC);

--
-- Name: idx_specialist_channel_messages_created; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_channel_messages_created ON public.specialist_channel_messages USING btree (channel_id, created_at DESC);

--
-- Name: idx_specialist_channels_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_channels_project ON public.specialist_channels USING btree (project);

--
-- Name: idx_specialist_inbox_unprocessed; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_inbox_unprocessed ON public.specialist_inbox USING btree (to_agent, processed) WHERE (processed = false);

--
-- Name: idx_specialist_jobs_created; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_jobs_created ON public.specialist_jobs USING btree (created_at) WHERE (status = 'pending'::public.specialist_job_status);

--
-- Name: idx_specialist_jobs_history; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_jobs_history ON public.specialist_jobs USING btree (project, created_at DESC);

--
-- Name: idx_specialist_jobs_project_status; Type: INDEX; Schema: public
--

CREATE INDEX idx_specialist_jobs_project_status ON public.specialist_jobs USING btree (project, status);

--
-- Name: idx_wrapper_status_last_activity; Type: INDEX; Schema: public
--

CREATE INDEX idx_wrapper_status_last_activity ON public.wrapper_status USING btree (last_activity);

--
-- Name: idx_wrapper_status_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_wrapper_status_project ON public.wrapper_status USING btree (project);

--
-- Name: idx_wrapper_status_status; Type: INDEX; Schema: public
--

CREATE INDEX idx_wrapper_status_status ON public.wrapper_status USING btree (status, last_activity);
