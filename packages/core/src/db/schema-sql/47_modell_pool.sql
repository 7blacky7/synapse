-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Modell-Pool (kostenlose und kostenpflichtige Fremdanbieter)
--
-- Vier Tabellen ohne Fremdschluessel und ohne Trigger: der Anbieter-Zustand,
-- die Zugaenge (mehrere je Anbieter moeglich), der Modell-Spiegel samt unserer
-- eigenen Entscheidungen und das Aenderungsprotokoll.
-- Quelle: schema.ts, Abschnitt free_pool_*.
-- ============================================================

--
-- Name: free_pool_providers; Type: TABLE; Schema: public
--

CREATE TABLE public.free_pool_providers (
    id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    reachability text DEFAULT 'unverified'::text NOT NULL,
    reachability_note text,
    probed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT free_pool_providers_reachability_check CHECK ((reachability = ANY (ARRAY['ready'::text, 'unverified'::text, 'blocked'::text, 'no_credential'::text])))
);

--
-- Name: free_pool_credentials; Type: TABLE; Schema: public
--

CREATE TABLE public.free_pool_credentials (
    id uuid NOT NULL,
    provider text NOT NULL,
    label text NOT NULL,
    source text DEFAULT 'env'::text NOT NULL,
    secret_ref text,
    api_key text,
    has_payment_method boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    request_count bigint DEFAULT 0 NOT NULL,
    monthly_budget_usd numeric(10,2),
    spent_usd numeric(12,6) DEFAULT 0 NOT NULL,
    last_status text,
    last_error_code integer,
    last_error_reason text,
    last_error_message text,
    last_error_reset_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT free_pool_credentials_source_check CHECK ((source = ANY (ARRAY['env'::text, 'database'::text, 'manual'::text])))
);

--
-- Name: free_pool_models; Type: TABLE; Schema: public
--

CREATE TABLE public.free_pool_models (
    ref text NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    display_name text,
    family text,
    cost_class text DEFAULT 'unknown'::text NOT NULL,
    price_in_per_mtok numeric(16,6),
    price_out_per_mtok numeric(16,6),
    context_length integer,
    max_output_tokens integer,
    capabilities text[] DEFAULT ARRAY[]::text[] NOT NULL,
    data_use text DEFAULT 'unknown'::text NOT NULL,
    allowed boolean,
    deprecated boolean DEFAULT false NOT NULL,
    metadata_source text,
    stale boolean DEFAULT false NOT NULL,
    cooldown_until timestamp with time zone,
    cooldown_reason text,
    failure_count integer DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_ok_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT free_pool_models_cost_class_check CHECK ((cost_class = ANY (ARRAY['free'::text, 'paid'::text, 'unknown'::text]))),
    CONSTRAINT free_pool_models_data_use_check CHECK ((data_use = ANY (ARRAY['private'::text, 'retained'::text, 'training'::text, 'unknown'::text])))
);

--
-- Name: free_pool_events; Type: TABLE; Schema: public
--

CREATE TABLE public.free_pool_events (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    provider text,
    ref text,
    detail jsonb,
    CONSTRAINT free_pool_events_kind_check CHECK ((kind = ANY (ARRAY['model_added'::text, 'model_gone'::text, 'model_back'::text, 'price_changed'::text, 'cost_class_changed'::text, 'allowed_changed'::text, 'cooldown'::text, 'probe'::text, 'credential_changed'::text])))
);

--
-- Name: free_pool_events_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.free_pool_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: free_pool_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public
--

ALTER SEQUENCE public.free_pool_events_id_seq OWNED BY public.free_pool_events.id;

--
-- Name: free_pool_events id; Type: DEFAULT; Schema: public
--

ALTER TABLE ONLY public.free_pool_events ALTER COLUMN id SET DEFAULT nextval('public.free_pool_events_id_seq'::regclass);

--
-- Name: free_pool_providers free_pool_providers_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.free_pool_providers
    ADD CONSTRAINT free_pool_providers_pkey PRIMARY KEY (id);

--
-- Name: free_pool_credentials free_pool_credentials_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.free_pool_credentials
    ADD CONSTRAINT free_pool_credentials_pkey PRIMARY KEY (id);

--
-- Name: free_pool_credentials uq_free_pool_credentials_label; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.free_pool_credentials
    ADD CONSTRAINT uq_free_pool_credentials_label UNIQUE (provider, label);

--
-- Name: free_pool_models free_pool_models_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.free_pool_models
    ADD CONSTRAINT free_pool_models_pkey PRIMARY KEY (ref);

--
-- Name: free_pool_events free_pool_events_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.free_pool_events
    ADD CONSTRAINT free_pool_events_pkey PRIMARY KEY (id);

--
-- Name: idx_free_pool_credentials_provider; Type: INDEX; Schema: public
--

CREATE INDEX idx_free_pool_credentials_provider ON public.free_pool_credentials USING btree (provider, priority, id);

--
-- Name: idx_free_pool_models_auswahl; Type: INDEX; Schema: public
--

CREATE INDEX idx_free_pool_models_auswahl ON public.free_pool_models USING btree (cost_class, provider, stale, deprecated);

--
-- Name: idx_free_pool_models_freigabe; Type: INDEX; Schema: public
--

CREATE INDEX idx_free_pool_models_freigabe ON public.free_pool_models USING btree (allowed) WHERE (allowed IS NOT NULL);

--
-- Name: idx_free_pool_models_sperre; Type: INDEX; Schema: public
--

CREATE INDEX idx_free_pool_models_sperre ON public.free_pool_models USING btree (cooldown_until) WHERE (cooldown_until IS NOT NULL);

--
-- Name: idx_free_pool_events_zeit; Type: INDEX; Schema: public
--

CREATE INDEX idx_free_pool_events_zeit ON public.free_pool_events USING btree (at DESC, id DESC);

--
-- Name: idx_free_pool_events_ref; Type: INDEX; Schema: public
--

CREATE INDEX idx_free_pool_events_ref ON public.free_pool_events USING btree (ref, at DESC) WHERE (ref IS NOT NULL);
