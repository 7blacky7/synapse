-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Trigger
-- ============================================================
-- Nach allen Tabellen und nach 05_funktionen.

--
-- Name: code_files trg_code_files_tsv; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_code_files_tsv BEFORE INSERT OR UPDATE OF content ON public.code_files FOR EACH ROW EXECUTE FUNCTION public.code_files_tsv_trigger();

--
-- Name: agent_events trg_notify_agent_event; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_agent_event AFTER INSERT ON public.agent_events FOR EACH ROW EXECUTE FUNCTION public.notify_agent_event();

--
-- Name: specialist_channel_messages trg_notify_channel_message; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_channel_message AFTER INSERT ON public.specialist_channel_messages FOR EACH ROW EXECUTE FUNCTION public.notify_channel_message();

--
-- Name: chat_messages trg_notify_chat_message; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_chat_message AFTER INSERT ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION public.notify_chat_message();

--
-- Name: code_files trg_notify_code_file_change; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_code_file_change AFTER INSERT OR DELETE OR UPDATE ON public.code_files FOR EACH ROW EXECUTE FUNCTION public.notify_code_file_change();

--
-- Name: file_versions trg_notify_file_change; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_file_change AFTER INSERT ON public.file_versions FOR EACH ROW EXECUTE FUNCTION public.notify_file_change();

--
-- Name: project_ignore_rules trg_notify_ignore_rules; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_ignore_rules AFTER INSERT OR DELETE OR UPDATE ON public.project_ignore_rules FOR EACH ROW EXECUTE FUNCTION public.notify_ignore_rules_change();

--
-- Name: wrapper_status trg_notify_wrapper_status_change; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_notify_wrapper_status_change AFTER INSERT OR DELETE OR UPDATE ON public.wrapper_status FOR EACH ROW EXECUTE FUNCTION public.notify_wrapper_status_change();

--
-- Name: project_init_jobs trg_project_init_jobs_notify; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_project_init_jobs_notify AFTER INSERT ON public.project_init_jobs FOR EACH ROW EXECUTE FUNCTION public.notify_project_init_job_created();

--
-- Name: shell_jobs trg_shell_jobs_notify; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_shell_jobs_notify AFTER INSERT ON public.shell_jobs FOR EACH ROW EXECUTE FUNCTION public.notify_shell_job_created();

--
-- Name: specialist_jobs trg_specialist_jobs_notify; Type: TRIGGER; Schema: public
--

CREATE TRIGGER trg_specialist_jobs_notify AFTER INSERT ON public.specialist_jobs FOR EACH ROW EXECUTE FUNCTION public.notify_specialist_job_created();
