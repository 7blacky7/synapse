-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Audit-Trail und Fehlermuster
-- ============================================================

--
-- Name: error_pattern_seen; Type: TABLE; Schema: public
--

CREATE TABLE public.error_pattern_seen (
    pattern_id uuid NOT NULL,
    session_id text NOT NULL,
    shown_at timestamp with time zone DEFAULT now()
);

--
-- Name: error_patterns; Type: TABLE; Schema: public
--

CREATE TABLE public.error_patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    description text NOT NULL,
    fix text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    model_scope text NOT NULL,
    found_by text NOT NULL,
    found_in_model text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: tool_calls; Type: TABLE; Schema: public
--

CREATE TABLE public.tool_calls (
    id bigint NOT NULL,
    project text,
    tool_name text NOT NULL,
    action text,
    source text,
    args_preview text,
    ok boolean DEFAULT true,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    agent_id text,
    duration_ms integer,
    error text,
    result text,
    result_bytes integer,
    result_truncated boolean DEFAULT false,
    is_mutation boolean DEFAULT false
);

--
-- Name: tool_calls_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.tool_calls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: tool_calls_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.tool_calls_id_seq OWNED BY public.tool_calls.id;

--
-- Name: tool_calls id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.tool_calls ALTER COLUMN id SET DEFAULT nextval('public.tool_calls_id_seq'::regclass);

--
-- Name: error_pattern_seen error_pattern_seen_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.error_pattern_seen
    ADD CONSTRAINT error_pattern_seen_pkey PRIMARY KEY (pattern_id, session_id);

--
-- Name: error_patterns error_patterns_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.error_patterns
    ADD CONSTRAINT error_patterns_pkey PRIMARY KEY (id);

--
-- Name: tool_calls tool_calls_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (id);

--
-- Name: idx_error_pattern_seen_session; Type: INDEX; Schema: public
--

CREATE INDEX idx_error_pattern_seen_session ON public.error_pattern_seen USING btree (session_id);

--
-- Name: idx_tool_calls_agent; Type: INDEX; Schema: public
--

CREATE INDEX idx_tool_calls_agent ON public.tool_calls USING btree (agent_id, ts DESC);

--
-- Name: idx_tool_calls_mut; Type: INDEX; Schema: public
--

CREATE INDEX idx_tool_calls_mut ON public.tool_calls USING btree (ts DESC) WHERE is_mutation;

--
-- Name: idx_tool_calls_project_ts; Type: INDEX; Schema: public
--

CREATE INDEX idx_tool_calls_project_ts ON public.tool_calls USING btree (project, ts DESC);

--
-- Name: idx_tool_calls_tool; Type: INDEX; Schema: public
--

CREATE INDEX idx_tool_calls_tool ON public.tool_calls USING btree (tool_name, ts DESC);
