-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Authentifizierung: Tokens, TOTP, OAuth-Clients
-- ============================================================

--
-- Name: auth_oauth_clients; Type: TABLE; Schema: public
--

CREATE TABLE public.auth_oauth_clients (
    client_id text NOT NULL,
    client_secret text,
    redirect_uris text[] DEFAULT '{}'::text[],
    client_name text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: auth_tokens; Type: TABLE; Schema: public
--

CREATE TABLE public.auth_tokens (
    token_hash text NOT NULL,
    kind text NOT NULL,
    client_id text,
    scope text,
    label text,
    redirect_uri text,
    code_challenge text,
    parent_token text,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone
);

--
-- Name: auth_totp; Type: TABLE; Schema: public
--

CREATE TABLE public.auth_totp (
    id integer DEFAULT 1 NOT NULL,
    secret text NOT NULL,
    confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT auth_totp_singleton CHECK ((id = 1))
);

--
-- Name: provider_credentials; Type: TABLE; Schema: public
--

CREATE TABLE public.provider_credentials (
    provider text NOT NULL,
    api_key text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: auth_oauth_clients auth_oauth_clients_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.auth_oauth_clients
    ADD CONSTRAINT auth_oauth_clients_pkey PRIMARY KEY (client_id);

--
-- Name: auth_tokens auth_tokens_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_pkey PRIMARY KEY (token_hash);

--
-- Name: auth_totp auth_totp_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.auth_totp
    ADD CONSTRAINT auth_totp_pkey PRIMARY KEY (id);

--
-- Name: provider_credentials provider_credentials_pkey; Type: CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.provider_credentials
    ADD CONSTRAINT provider_credentials_pkey PRIMARY KEY (provider);

--
-- Name: idx_auth_tokens_client; Type: INDEX; Schema: public
--

CREATE INDEX idx_auth_tokens_client ON public.auth_tokens USING btree (client_id);

--
-- Name: idx_auth_tokens_kind_expires; Type: INDEX; Schema: public
--

CREATE INDEX idx_auth_tokens_kind_expires ON public.auth_tokens USING btree (kind, expires_at);
