-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Shell-Job-Queue
-- ============================================================

--
-- Name: shell_jobs; Type: TABLE; Schema: public
--

CREATE TABLE public.shell_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project text NOT NULL,
    command text NOT NULL,
    cwd_relative text,
    timeout_ms integer DEFAULT 30000,
    tail_lines integer DEFAULT 5,
    status public.shell_job_status DEFAULT 'pending'::public.shell_job_status NOT NULL,
    exit_code integer,
    tail jsonb,
    error text,
    stream_id text,
    claimed_by text,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    message text,
    output text,
    output_truncated boolean DEFAULT false,
    output_size integer DEFAULT 0 NOT NULL,
    agent_id text
);

--
-- Name: shell_stream_chunks; Type: TABLE; Schema: public
--

CREATE TABLE public.shell_stream_chunks (
    id bigint NOT NULL,
    job_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    line text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: shell_stream_chunks_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.shell_stream_chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shell_stream_chunks_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.shell_stream_chunks_id_seq OWNED BY public.shell_stream_chunks.id;

--
-- Name: shell_stream_chunks id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.shell_stream_chunks ALTER COLUMN id SET DEFAULT nextval('public.shell_stream_chunks_id_seq'::regclass);

--
-- Name: shell_jobs shell_jobs_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.shell_jobs
    ADD CONSTRAINT shell_jobs_pkey PRIMARY KEY (id);

--
-- Name: shell_stream_chunks shell_stream_chunks_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.shell_stream_chunks
    ADD CONSTRAINT shell_stream_chunks_pkey PRIMARY KEY (id);

--
-- Name: idx_shell_jobs_agent; Type: INDEX; Schema: public
--

CREATE INDEX idx_shell_jobs_agent ON public.shell_jobs USING btree (agent_id) WHERE (agent_id IS NOT NULL);

--
-- Name: idx_shell_jobs_created; Type: INDEX; Schema: public
--

CREATE INDEX idx_shell_jobs_created ON public.shell_jobs USING btree (created_at) WHERE (status = 'pending'::public.shell_job_status);

--
-- Name: idx_shell_jobs_history; Type: INDEX; Schema: public
--

CREATE INDEX idx_shell_jobs_history ON public.shell_jobs USING btree (project, created_at DESC);

--
-- Name: idx_shell_jobs_project_status; Type: INDEX; Schema: public
--

CREATE INDEX idx_shell_jobs_project_status ON public.shell_jobs USING btree (project, status);

--
-- Name: idx_shell_stream_chunks_job; Type: INDEX; Schema: public
--

CREATE INDEX idx_shell_stream_chunks_job ON public.shell_stream_chunks USING btree (job_id, chunk_index);
