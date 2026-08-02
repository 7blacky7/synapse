-- Synapse: Datenbank-Schema (Struktur, KEINE Daten)
-- Erzeugt aus der laufenden Datenbank mit:
--   pg_dump --schema-only --no-owner --no-privileges
-- Aufbaureihenfolge und Kommandos: siehe README.md in diesem Ordner.
-- Der ausgefuehrte Weg im Betrieb ist packages/core/src/db/schema.ts (ensureSchema());
-- diese Dateien sind dessen SQL-Spiegelung.

-- ============================================================
-- Fremdschluessel
-- ============================================================
-- ZULETZT. Alle 19 FKs stehen bewusst hier und nicht inline in den CREATE TABLEs —
-- dadurch ist die Reihenfolge der Sachgebiets-Dateien untereinander beliebig.

--
-- Name: agent_event_acks agent_event_acks_event_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.agent_event_acks
    ADD CONSTRAINT agent_event_acks_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.agent_events(id) ON DELETE CASCADE;

--
-- Name: auth_tokens auth_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_oauth_clients(client_id) ON DELETE CASCADE;

--
-- Name: code_call_edges code_call_edges_project_file_path_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_call_edges
    ADD CONSTRAINT code_call_edges_project_file_path_fkey FOREIGN KEY (project, file_path) REFERENCES public.code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_call_edges code_call_edges_statement_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_call_edges
    ADD CONSTRAINT code_call_edges_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES public.code_statements(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_call_edges code_call_edges_target_symbol_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_call_edges
    ADD CONSTRAINT code_call_edges_target_symbol_id_fkey FOREIGN KEY (target_symbol_id) REFERENCES public.code_symbols(id) ON DELETE SET NULL;

--
-- Name: code_chunks code_chunks_project_file_path_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_chunks
    ADD CONSTRAINT code_chunks_project_file_path_fkey FOREIGN KEY (project, file_path) REFERENCES public.code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_references code_references_project_file_path_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_references
    ADD CONSTRAINT code_references_project_file_path_fkey FOREIGN KEY (project, file_path) REFERENCES public.code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_references code_references_symbol_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_references
    ADD CONSTRAINT code_references_symbol_id_fkey FOREIGN KEY (symbol_id) REFERENCES public.code_symbols(id) ON DELETE CASCADE;

--
-- Name: code_statements code_statements_parent_statement_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_statements
    ADD CONSTRAINT code_statements_parent_statement_id_fkey FOREIGN KEY (parent_statement_id) REFERENCES public.code_statements(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_statements code_statements_project_file_path_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_statements
    ADD CONSTRAINT code_statements_project_file_path_fkey FOREIGN KEY (project, file_path) REFERENCES public.code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_symbols code_symbols_parent_symbol_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_parent_symbol_fkey FOREIGN KEY (parent_symbol) REFERENCES public.code_symbols(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: code_symbols code_symbols_project_file_path_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_project_file_path_fkey FOREIGN KEY (project, file_path) REFERENCES public.code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: embedding_knoten embedding_knoten_service_token_hash_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.embedding_knoten
    ADD CONSTRAINT embedding_knoten_service_token_hash_fkey FOREIGN KEY (service_token_hash) REFERENCES public.auth_tokens(token_hash) ON DELETE CASCADE;

--
-- Name: error_pattern_seen error_pattern_seen_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.error_pattern_seen
    ADD CONSTRAINT error_pattern_seen_pattern_id_fkey FOREIGN KEY (pattern_id) REFERENCES public.error_patterns(id) ON DELETE CASCADE;

--
-- Name: file_versions file_versions_parent_version_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_parent_version_id_fkey FOREIGN KEY (parent_version_id) REFERENCES public.file_versions(id) ON DELETE SET NULL;

--
-- Name: parse_coverage parse_coverage_project_file_path_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.parse_coverage
    ADD CONSTRAINT parse_coverage_project_file_path_fkey FOREIGN KEY (project, file_path) REFERENCES public.code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

--
-- Name: shell_stream_chunks shell_stream_chunks_job_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.shell_stream_chunks
    ADD CONSTRAINT shell_stream_chunks_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.shell_jobs(id) ON DELETE CASCADE;

--
-- Name: specialist_channel_members specialist_channel_members_channel_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_channel_members
    ADD CONSTRAINT specialist_channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.specialist_channels(id) ON DELETE CASCADE;

--
-- Name: specialist_channel_messages specialist_channel_messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public
--

ALTER TABLE ONLY public.specialist_channel_messages
    ADD CONSTRAINT specialist_channel_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.specialist_channels(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
