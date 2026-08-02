-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Extensions und ENUM-Typen
-- ============================================================
-- Muss ZUERST laufen. Die ENUM-Typen werden von Spalten in spaeteren Dateien benutzt,
-- pgcrypto liefert gen_random_uuid() fuer die DEFAULTs vieler Primaerschluessel.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';

--
-- Name: file_batch_status; Type: TYPE; Schema: public
--

CREATE TYPE public.file_batch_status AS ENUM (
    'open',
    'committed',
    'cancelled',
    'expired',
    'stale'
);

--
-- Name: project_init_status; Type: TYPE; Schema: public
--

CREATE TYPE public.project_init_status AS ENUM (
    'pending',
    'running',
    'done',
    'failed',
    'rejected',
    'timeout'
);

--
-- Name: shell_job_status; Type: TYPE; Schema: public
--

CREATE TYPE public.shell_job_status AS ENUM (
    'pending',
    'running',
    'done',
    'failed',
    'rejected',
    'timeout'
);

--
-- Name: specialist_job_status; Type: TYPE; Schema: public
--

CREATE TYPE public.specialist_job_status AS ENUM (
    'pending',
    'running',
    'done',
    'failed',
    'rejected',
    'timeout'
);
