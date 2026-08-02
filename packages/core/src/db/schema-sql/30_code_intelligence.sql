-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Code-Index: Dateien, Symbole, Referenzen, Chunks, Statements, Call-Kanten, Parser-Status
-- ============================================================

--
-- Name: code_call_edges; Type: TABLE; Schema: public
--

CREATE TABLE public.code_call_edges (
    id bigint NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    caller_scope text,
    statement_id bigint,
    callee_name text NOT NULL,
    callee_receiver text,
    target_symbol_id text,
    line_number integer NOT NULL,
    call_kind text,
    confidence real DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: code_call_edges_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.code_call_edges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: code_call_edges_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.code_call_edges_id_seq OWNED BY public.code_call_edges.id;

--
-- Name: code_chunks; Type: TABLE; Schema: public
--

CREATE TABLE public.code_chunks (
    id text NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    chunk_index integer NOT NULL,
    content text NOT NULL,
    line_start integer NOT NULL,
    line_end integer NOT NULL,
    embedded_at timestamp with time zone,
    content_hash text,
    claim_token text,
    claimed_by text,
    lease_until timestamp with time zone,
    claim_attempt integer DEFAULT 0 NOT NULL
);

--
-- Name: code_files; Type: TABLE; Schema: public
--

CREATE TABLE public.code_files (
    id text NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    file_name text NOT NULL,
    file_type text NOT NULL,
    chunk_count integer DEFAULT 0,
    file_size integer DEFAULT 0,
    indexed_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    content text,
    content_hash text,
    parsed_at timestamp with time zone,
    tsv tsvector,
    deleted_at timestamp with time zone,
    parser_version integer,
    ignored boolean DEFAULT false NOT NULL
);

--
-- Name: code_references; Type: TABLE; Schema: public
--

CREATE TABLE public.code_references (
    id text NOT NULL,
    project text NOT NULL,
    symbol_id text NOT NULL,
    file_path text NOT NULL,
    line_number integer NOT NULL,
    context text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: code_statements; Type: TABLE; Schema: public
--

CREATE TABLE public.code_statements (
    id bigint NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    scope_type text,
    scope_name text,
    statement_type text NOT NULL,
    node_kind text,
    line_start integer NOT NULL,
    line_end integer,
    order_index integer NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    parent_statement_id bigint,
    text text,
    callee text,
    receiver text,
    assigned_to text,
    condition_text text,
    is_top_level boolean DEFAULT false NOT NULL,
    is_awaited boolean DEFAULT false NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: code_statements_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.code_statements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: code_statements_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.code_statements_id_seq OWNED BY public.code_statements.id;

--
-- Name: code_symbols; Type: TABLE; Schema: public
--

CREATE TABLE public.code_symbols (
    id text NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    symbol_type text NOT NULL,
    name text,
    value text,
    line_start integer NOT NULL,
    line_end integer,
    parent_symbol text,
    params text[],
    return_type text,
    is_exported boolean DEFAULT false,
    usage_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: parse_coverage; Type: TABLE; Schema: public
--

CREATE TABLE public.parse_coverage (
    project text NOT NULL,
    file_path text NOT NULL,
    file_type text,
    parser text,
    parser_version integer,
    datei_bytes integer,
    zeilen_gesamt integer DEFAULT 0 NOT NULL,
    belegte_zeilen integer DEFAULT 0 NOT NULL,
    n_symbole integer DEFAULT 0 NOT NULL,
    n_funktionen integer DEFAULT 0 NOT NULL,
    n_klassen integer DEFAULT 0 NOT NULL,
    n_variablen integer DEFAULT 0 NOT NULL,
    n_imports integer DEFAULT 0 NOT NULL,
    n_text_symbole integer DEFAULT 0 NOT NULL,
    n_statements integer DEFAULT 0 NOT NULL,
    n_call_edges integer DEFAULT 0 NOT NULL,
    dauer_ms integer,
    gemessen_am timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: parse_failures; Type: TABLE; Schema: public
--

CREATE TABLE public.parse_failures (
    id bigint NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    grund text NOT NULL,
    details text,
    parser text,
    dauer_ms integer,
    datei_bytes integer,
    aufgetreten_am timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: parse_failures_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.parse_failures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: parse_failures_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.parse_failures_id_seq OWNED BY public.parse_failures.id;

--
-- Name: code_call_edges id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.code_call_edges ALTER COLUMN id SET DEFAULT nextval('public.code_call_edges_id_seq'::regclass);

--
-- Name: code_statements id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.code_statements ALTER COLUMN id SET DEFAULT nextval('public.code_statements_id_seq'::regclass);

--
-- Name: parse_failures id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.parse_failures ALTER COLUMN id SET DEFAULT nextval('public.parse_failures_id_seq'::regclass);

--
-- Name: code_call_edges code_call_edges_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_call_edges
    ADD CONSTRAINT code_call_edges_pkey PRIMARY KEY (id);

--
-- Name: code_chunks code_chunks_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_chunks
    ADD CONSTRAINT code_chunks_pkey PRIMARY KEY (id);

--
-- Name: code_files code_files_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_files
    ADD CONSTRAINT code_files_pkey PRIMARY KEY (id);

--
-- Name: code_files code_files_project_file_path_key; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_files
    ADD CONSTRAINT code_files_project_file_path_key UNIQUE (project, file_path);

--
-- Name: code_references code_references_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_references
    ADD CONSTRAINT code_references_pkey PRIMARY KEY (id);

--
-- Name: code_statements code_statements_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_statements
    ADD CONSTRAINT code_statements_pkey PRIMARY KEY (id);

--
-- Name: code_symbols code_symbols_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_pkey PRIMARY KEY (id);

--
-- Name: parse_coverage parse_coverage_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.parse_coverage
    ADD CONSTRAINT parse_coverage_pkey PRIMARY KEY (project, file_path);

--
-- Name: parse_failures parse_failures_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.parse_failures
    ADD CONSTRAINT parse_failures_pkey PRIMARY KEY (id);

--
-- Name: parse_failures parse_failures_project_file_path_key; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.parse_failures
    ADD CONSTRAINT parse_failures_project_file_path_key UNIQUE (project, file_path);

--
-- Name: idx_code_call_edges_callee; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_call_edges_callee ON public.code_call_edges USING btree (project, callee_name);

--
-- Name: idx_code_call_edges_file; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_call_edges_file ON public.code_call_edges USING btree (project, file_path);

--
-- Name: idx_code_call_edges_statement; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_call_edges_statement ON public.code_call_edges USING btree (statement_id) WHERE (statement_id IS NOT NULL);

--
-- Name: idx_code_call_edges_target; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_call_edges_target ON public.code_call_edges USING btree (target_symbol_id) WHERE (target_symbol_id IS NOT NULL);

--
-- Name: idx_code_chunks_claim_ordnung; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_chunks_claim_ordnung ON public.code_chunks USING btree (project, file_path, chunk_index) WHERE (embedded_at IS NULL);

--
-- Name: idx_code_chunks_claimable; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_chunks_claimable ON public.code_chunks USING btree (lease_until, project, file_path, chunk_index) WHERE (embedded_at IS NULL);

--
-- Name: idx_code_chunks_file; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_chunks_file ON public.code_chunks USING btree (project, file_path);

--
-- Name: idx_code_chunks_unembedded; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_chunks_unembedded ON public.code_chunks USING btree (project) WHERE (embedded_at IS NULL);

--
-- Name: idx_code_files_hash; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_files_hash ON public.code_files USING btree (project, content_hash);

--
-- Name: idx_code_files_path; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_files_path ON public.code_files USING btree (project, file_path);

--
-- Name: idx_code_files_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_files_project ON public.code_files USING btree (project);

--
-- Name: idx_code_files_sichtbar; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_files_sichtbar ON public.code_files USING btree (project, file_path) WHERE (NOT ignored);

--
-- Name: idx_code_files_tsv; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_files_tsv ON public.code_files USING gin (tsv);

--
-- Name: idx_code_files_type; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_files_type ON public.code_files USING btree (project, file_type);

--
-- Name: idx_code_references_file; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_references_file ON public.code_references USING btree (project, file_path);

--
-- Name: idx_code_references_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_references_project ON public.code_references USING btree (project);

--
-- Name: idx_code_references_symbol; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_references_symbol ON public.code_references USING btree (symbol_id);

--
-- Name: idx_code_statements_file; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_statements_file ON public.code_statements USING btree (project, file_path);

--
-- Name: idx_code_statements_parent; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_statements_parent ON public.code_statements USING btree (parent_statement_id) WHERE (parent_statement_id IS NOT NULL);

--
-- Name: idx_code_statements_scope; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_statements_scope ON public.code_statements USING btree (project, file_path, scope_name);

--
-- Name: idx_code_statements_toplevel; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_statements_toplevel ON public.code_statements USING btree (project, is_top_level) WHERE (is_top_level = true);

--
-- Name: idx_code_symbols_file; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_symbols_file ON public.code_symbols USING btree (project, file_path);

--
-- Name: idx_code_symbols_name; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_symbols_name ON public.code_symbols USING btree (project, name);

--
-- Name: idx_code_symbols_parent_symbol; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_symbols_parent_symbol ON public.code_symbols USING btree (parent_symbol);

--
-- Name: idx_code_symbols_project; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_symbols_project ON public.code_symbols USING btree (project);

--
-- Name: idx_code_symbols_type; Type: INDEX; Schema: public
--

CREATE INDEX idx_code_symbols_type ON public.code_symbols USING btree (project, symbol_type);

--
-- Name: idx_parse_coverage_parser; Type: INDEX; Schema: public
--

CREATE INDEX idx_parse_coverage_parser ON public.parse_coverage USING btree (project, parser);

--
-- Name: idx_parse_failures_projekt; Type: INDEX; Schema: public
--

CREATE INDEX idx_parse_failures_projekt ON public.parse_failures USING btree (project);
