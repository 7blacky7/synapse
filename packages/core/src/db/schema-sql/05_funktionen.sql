-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- PL/pgSQL- und SQL-Funktionen
-- ============================================================
-- Vor den Tabellen, weil Trigger und ggf. Index-Ausdruecke sie brauchen.
-- Funktionsruempfe werden nicht gegen Tabellen geprueft, die Reihenfolge ist also unkritisch.

--
-- Name: code_files_tsv_trigger(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.code_files_tsv_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END
$$;

--
-- Name: notify_agent_event(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_agent_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('synapse_event', json_build_object(
    'project', NEW.project,
    'event_type', NEW.event_type,
    'priority', NEW.priority,
    'source_id', NEW.source_id,
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$;

--
-- Name: notify_channel_message(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_channel_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ch_name TEXT;
  ch_project TEXT;
BEGIN
  SELECT name, project INTO ch_name, ch_project
    FROM specialist_channels WHERE id = NEW.channel_id;
  PERFORM pg_notify('synapse_channel', json_build_object(
    'project', COALESCE(ch_project, ''),
    'channel', COALESCE(ch_name, ''),
    'sender', NEW.sender,
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$;

--
-- Name: notify_chat_message(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_chat_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('synapse_chat', json_build_object(
    'project', NEW.project,
    'sender_id', NEW.sender_id,
    'recipient_id', COALESCE(NEW.recipient_id, ''),
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$;

--
-- Name: notify_code_file_change(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_code_file_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- DELETE: row weg
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('synapse_code_file_change', json_build_object(
      'project', OLD.project, 'file_path', OLD.file_path, 'action', 'DELETE'
    )::text);
    RETURN OLD;
  END IF;
  -- UPDATE soft-delete (content wird NULL)
  IF TG_OP = 'UPDATE' AND OLD.content IS NOT NULL AND NEW.content IS NULL THEN
    PERFORM pg_notify('synapse_code_file_change', json_build_object(
      'project', NEW.project, 'file_path', NEW.file_path, 'action', 'DELETE'
    )::text);
    RETURN NEW;
  END IF;
  -- INSERT/UPDATE mit content → materialize
  IF NEW.content IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.content IS NOT NULL AND OLD.content_hash = NEW.content_hash THEN
      RETURN NEW;   -- Hash unveraendert → kein Sync noetig.
    END IF;
    PERFORM pg_notify('synapse_code_file_change', json_build_object(
      'project', NEW.project, 'file_path', NEW.file_path, 'action', TG_OP
    )::text);
  END IF;
  RETURN NEW;
END
$$;

--
-- Name: notify_file_change(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_file_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('synapse_file', json_build_object(
    'project', NEW.project,
    'file_path', NEW.file_path,
    'edit_action', NEW.edit_action,
    'agent_id', COALESCE(NEW.agent_id, ''),
    'id', NEW.id::text
  )::text);
  RETURN NEW;
END
$$;

--
-- Name: notify_ignore_rules_change(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_ignore_rules_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('synapse_ignore_rules', COALESCE(NEW.project, OLD.project));
  RETURN NULL;
END
$$;

--
-- Name: notify_project_init_job_created(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_project_init_job_created() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('project_init_job_created', NEW.id::text);
  RETURN NEW;
END;
$$;

--
-- Name: notify_shell_job_created(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_shell_job_created() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('shell_job_created', NEW.project || ':' || NEW.id::text);
  RETURN NEW;
END;
$$;

--
-- Name: notify_specialist_job_created(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_specialist_job_created() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('specialist_job_created', NEW.project || ':' || NEW.id::text);
  RETURN NEW;
END;
$$;

--
-- Name: notify_wrapper_status_change(); Type: FUNCTION; Schema: public
--

CREATE FUNCTION public.notify_wrapper_status_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  proj TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    proj := OLD.project;
  ELSE
    proj := NEW.project;
  END IF;
  PERFORM pg_notify('synapse_specialist_status_change', json_build_object(
    'project', proj,
    'agent_name', CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_name ELSE NEW.agent_name END,
    'status', CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE NEW.status END
  )::text);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;
