/** P22-T15: Spiegel 112_agent_bezug.sql. Keine Bestandsmigration. */
export const AGENT_BEZUG_SCHEMA_SQL = `
-- P22-T15 / 112. Additiv und idempotent; KEIN Identity-Backfill.
-- Reihenfolge: nach dem vollstaendigen Basisschema und 111_agent_identitaet.
-- Legacy-Schluessel/Constraints bleiben unangetastet. LIKE kopiert Spalten,
-- NOT NULL, Defaults und CHECKs, absichtlich KEINE alten Namens-PK/UNIQUE-Indizes.
-- Namensspalten sind in Token-Tabellen ausschliesslich Anzeigen-Snapshots.
CREATE TABLE IF NOT EXISTS agent_identitaet_sitzungen (
 identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id),
 project TEXT NOT NULL, agent_id TEXT NOT NULL,
 model TEXT, cutoff_date DATE, provider TEXT, model_full_id TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 sitzung_seit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 aktiv_seit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 zuletzt_aktiv TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 context_epoch INTEGER NOT NULL DEFAULT 0 CHECK(context_epoch>=0),
 lauf_id TEXT REFERENCES agent_identitaet_laeufe(id)
);
CREATE INDEX IF NOT EXISTS idx_aibs_project ON agent_identitaet_sitzungen(project,status,zuletzt_aktiv);
CREATE TABLE IF NOT EXISTS agent_identitaet_onboardings (
 LIKE agent_onboardings INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(identity_id,project,server_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_aib_onboardings_identity ON agent_identitaet_onboardings(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_chat_lesestand (
 LIKE chat_lesestand INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(project,identity_id)
);
CREATE INDEX IF NOT EXISTS idx_aib_chat_lesestand_identity ON agent_identitaet_chat_lesestand(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_channel_mitglieder (
 LIKE specialist_channel_members INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(channel_id,identity_id),
 FOREIGN KEY(channel_id) REFERENCES specialist_channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aib_channel_mitglieder_identity ON agent_identitaet_channel_mitglieder(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_channel_sichtung (
 LIKE channel_sichtung INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(project,channel,identity_id)
);
CREATE INDEX IF NOT EXISTS idx_aib_channel_sichtung_identity ON agent_identitaet_channel_sichtung(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_event_acks (
 LIKE agent_event_acks INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(event_id,identity_id),
 FOREIGN KEY(event_id) REFERENCES agent_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aib_event_acks_identity ON agent_identitaet_event_acks(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_wrapper_status (
 LIKE wrapper_status INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(identity_id,project)
);
CREATE INDEX IF NOT EXISTS idx_aib_wrapper_status_identity ON agent_identitaet_wrapper_status(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_wissen (
 LIKE agent_wissen INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(id)
);
CREATE INDEX IF NOT EXISTS idx_aib_wissen_identity ON agent_identitaet_wissen(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_file_reservations (
 LIKE file_reservations INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(id)
);
CREATE INDEX IF NOT EXISTS idx_aib_file_reservations_identity ON agent_identitaet_file_reservations(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_shell_job_notices (
 LIKE shell_job_notices INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(job_id,identity_id,kind),
 FOREIGN KEY(job_id) REFERENCES shell_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aib_shell_job_notices_identity ON agent_identitaet_shell_job_notices(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_hinweis_gesehen (
 LIKE hinweis_gesehen INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(project,identity_id,art)
);
CREATE INDEX IF NOT EXISTS idx_aib_hinweis_gesehen_identity ON agent_identitaet_hinweis_gesehen(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_hinweis_aufrufe (
 LIKE ausloeser_hinweis_aufrufe INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(identity_id)
);
CREATE INDEX IF NOT EXISTS idx_aib_hinweis_aufrufe_identity ON agent_identitaet_hinweis_aufrufe(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_hinweis_zustellungen (
 LIKE ausloeser_hinweis_zustellungen INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(project,identity_id,sitzung,quelle_id,hinweis_id)
);
CREATE INDEX IF NOT EXISTS idx_aib_hinweis_zustellungen_identity ON agent_identitaet_hinweis_zustellungen(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_skill_deliveries (
 LIKE skill_hook_deliveries INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(identity_id,skill_name)
);
CREATE INDEX IF NOT EXISTS idx_aib_skill_deliveries_identity ON agent_identitaet_skill_deliveries(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_skill_preparations (
 LIKE skill_hook_preparations INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(source_type,source_id,identity_id,skill_name)
);
CREATE INDEX IF NOT EXISTS idx_aib_skill_preparations_identity ON agent_identitaet_skill_preparations(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_skill_sections (
 LIKE skill_sections INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(punkt_id)
);
CREATE INDEX IF NOT EXISTS idx_aib_skill_sections_identity ON agent_identitaet_skill_sections(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_error_pattern_seen (
 LIKE error_pattern_seen INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
 PRIMARY KEY(pattern_id,identity_id),
 FOREIGN KEY(pattern_id) REFERENCES error_patterns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aib_error_pattern_seen_identity ON agent_identitaet_error_pattern_seen(identity_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aib_wissen_block ON agent_identitaet_wissen(project,identity_id,art) WHERE form='block';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aib_reservation_active ON agent_identitaet_file_reservations(project,identity_id,file_path) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_aib_reservation_path ON agent_identitaet_file_reservations(project,file_path);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aib_skill_section ON agent_identitaet_skill_sections(identity_id,skill_name,section);
CREATE TABLE IF NOT EXISTS shell_job_agent_bezuege (
 id BIGSERIAL PRIMARY KEY,
 job_id UUID NOT NULL REFERENCES shell_jobs(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('owner','attached','hint','hidden')),
 identity_id TEXT REFERENCES agent_identitaeten(id),
 project TEXT NOT NULL, agent_id TEXT NOT NULL,
 CHECK(identity_id IS NOT NULL OR length(agent_id)>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aib_shell_identity ON shell_job_agent_bezuege(job_id,role,identity_id) WHERE identity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_aib_shell_legacy ON shell_job_agent_bezuege(job_id,role,project,agent_id) WHERE identity_id IS NULL;
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS erstellt_von_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_identitaeten_erstellt_von_identity_id ON agent_identitaeten(erstellt_von_identity_id) WHERE erstellt_von_identity_id IS NOT NULL;
ALTER TABLE agent_identitaet_tokens ADD COLUMN IF NOT EXISTS widerrufen_von_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_identitaet_tokens_widerrufen_von_identity_id ON agent_identitaet_tokens(widerrufen_von_identity_id) WHERE widerrufen_von_identity_id IS NOT NULL;
ALTER TABLE agent_identitaet_audit ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_identitaet_audit_actor_identity_id ON agent_identitaet_audit(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_chat_messages_sender_identity_id ON chat_messages(sender_identity_id) WHERE sender_identity_id IS NOT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_chat_messages_recipient_identity_id ON chat_messages(recipient_identity_id) WHERE recipient_identity_id IS NOT NULL;
ALTER TABLE specialist_channels ADD COLUMN IF NOT EXISTS created_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_channels_created_by_identity_id ON specialist_channels(created_by_identity_id) WHERE created_by_identity_id IS NOT NULL;
ALTER TABLE specialist_channel_messages ADD COLUMN IF NOT EXISTS sender_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_channel_messages_sender_identity_id ON specialist_channel_messages(sender_identity_id) WHERE sender_identity_id IS NOT NULL;
ALTER TABLE specialist_inbox ADD COLUMN IF NOT EXISTS from_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_inbox_from_identity_id ON specialist_inbox(from_identity_id) WHERE from_identity_id IS NOT NULL;
ALTER TABLE specialist_inbox ADD COLUMN IF NOT EXISTS to_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_inbox_to_identity_id ON specialist_inbox(to_identity_id) WHERE to_identity_id IS NOT NULL;
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS source_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_events_source_identity_id ON agent_events(source_identity_id) WHERE source_identity_id IS NOT NULL;
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS target_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_events_target_identity_id ON agent_events(target_identity_id) WHERE target_identity_id IS NOT NULL;
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS owner_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_file_batch_plans_owner_identity_id ON file_batch_plans(owner_identity_id) WHERE owner_identity_id IS NOT NULL;
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS waiting_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_file_batch_waits_waiting_identity_id ON file_batch_waits(waiting_identity_id) WHERE waiting_identity_id IS NOT NULL;
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS primary_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_file_batch_waits_primary_identity_id ON file_batch_waits(primary_identity_id) WHERE primary_identity_id IS NOT NULL;
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS author_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_file_versions_author_identity_id ON file_versions(author_identity_id) WHERE author_identity_id IS NOT NULL;
ALTER TABLE file_version_task_zuordnungen ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_file_version_task_zuordnungen_actor_identity_id ON file_version_task_zuordnungen(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_tool_calls_identity_id ON tool_calls(identity_id) WHERE identity_id IS NOT NULL;
ALTER TABLE tool_aktivitaet ADD COLUMN IF NOT EXISTS identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_tool_aktivitaet_identity_id ON tool_aktivitaet(identity_id) WHERE identity_id IS NOT NULL;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS owner_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_shell_jobs_owner_identity_id ON shell_jobs(owner_identity_id) WHERE owner_identity_id IS NOT NULL;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS cancelled_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_shell_jobs_cancelled_by_identity_id ON shell_jobs(cancelled_by_identity_id) WHERE cancelled_by_identity_id IS NOT NULL;
ALTER TABLE shell_demaskierungen ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_shell_demaskierungen_actor_identity_id ON shell_demaskierungen(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE shell_sicherungs_audit ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_shell_sicherungs_audit_actor_identity_id ON shell_sicherungs_audit(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE specialist_jobs ADD COLUMN IF NOT EXISTS requester_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_jobs_requester_identity_id ON specialist_jobs(requester_identity_id) WHERE requester_identity_id IS NOT NULL;
ALTER TABLE specialist_jobs ADD COLUMN IF NOT EXISTS target_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_jobs_target_identity_id ON specialist_jobs(target_identity_id) WHERE target_identity_id IS NOT NULL;
ALTER TABLE project_init_jobs ADD COLUMN IF NOT EXISTS requested_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_project_init_jobs_requested_by_identity_id ON project_init_jobs(requested_by_identity_id) WHERE requested_by_identity_id IS NOT NULL;
ALTER TABLE ausloeser_hinweis_profile ADD COLUMN IF NOT EXISTS exact_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_ausloeser_hinweis_profile_exact_identity_id ON ausloeser_hinweis_profile(exact_identity_id) WHERE exact_identity_id IS NOT NULL;
ALTER TABLE ausloeser_hinweis_profile ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_ausloeser_hinweis_profile_setter_identity_id ON ausloeser_hinweis_profile(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE error_patterns ADD COLUMN IF NOT EXISTS found_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_error_patterns_found_by_identity_id ON error_patterns(found_by_identity_id) WHERE found_by_identity_id IS NOT NULL;
ALTER TABLE erklaerung_faelle ADD COLUMN IF NOT EXISTS owner_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_erklaerung_faelle_owner_identity_id ON erklaerung_faelle(owner_identity_id) WHERE owner_identity_id IS NOT NULL;
ALTER TABLE erklaerung_faelle ADD COLUMN IF NOT EXISTS erklaert_von_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_erklaerung_faelle_erklaert_von_identity_id ON erklaerung_faelle(erklaert_von_identity_id) WHERE erklaert_von_identity_id IS NOT NULL;
ALTER TABLE erklaerung_ereignisse ADD COLUMN IF NOT EXISTS owner_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_erklaerung_ereignisse_owner_identity_id ON erklaerung_ereignisse(owner_identity_id) WHERE owner_identity_id IS NOT NULL;
ALTER TABLE erklaerungen ADD COLUMN IF NOT EXISTS author_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_erklaerungen_author_identity_id ON erklaerungen(author_identity_id) WHERE author_identity_id IS NOT NULL;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS source_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_thoughts_source_identity_id ON thoughts(source_identity_id) WHERE source_identity_id IS NOT NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS author_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_proposals_author_identity_id ON proposals(author_identity_id) WHERE author_identity_id IS NOT NULL;
ALTER TABLE jev_entscheidet ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_entscheidet_setter_identity_id ON jev_entscheidet(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_entscheidungen_actor_identity_id ON jev_entscheidungen(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS overrider_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_entscheidungen_overrider_identity_id ON jev_entscheidungen(overrider_identity_id) WHERE overrider_identity_id IS NOT NULL;
ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS reviewer_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_entscheidungen_reviewer_identity_id ON jev_entscheidungen(reviewer_identity_id) WHERE reviewer_identity_id IS NOT NULL;
ALTER TABLE jev_schalter ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_schalter_setter_identity_id ON jev_schalter(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE jev_aufrufe ADD COLUMN IF NOT EXISTS identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_aufrufe_identity_id ON jev_aufrufe(identity_id) WHERE identity_id IS NOT NULL;
ALTER TABLE jev_budget_stand ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_budget_stand_setter_identity_id ON jev_budget_stand(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE jev_optionen ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_optionen_setter_identity_id ON jev_optionen(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE jev_entscheidungstopf ADD COLUMN IF NOT EXISTS erfasst_von_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_entscheidungstopf_erfasst_von_identity_id ON jev_entscheidungstopf(erfasst_von_identity_id) WHERE erfasst_von_identity_id IS NOT NULL;
ALTER TABLE jev_entscheidungstopf ADD COLUMN IF NOT EXISTS aufbereitet_von_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_jev_entscheidungstopf_aufbereitet_von_identity_id ON jev_entscheidungstopf(aufbereitet_von_identity_id) WHERE aufbereitet_von_identity_id IS NOT NULL;
ALTER TABLE hinweis_optionen ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_hinweis_optionen_setter_identity_id ON hinweis_optionen(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE embed_prioritaet ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_embed_prioritaet_setter_identity_id ON embed_prioritaet(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE project_setup_status ADD COLUMN IF NOT EXISTS updater_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_project_setup_status_updater_identity_id ON project_setup_status(updater_identity_id) WHERE updater_identity_id IS NOT NULL;
ALTER TABLE project_ignore_rules ADD COLUMN IF NOT EXISTS creator_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_project_ignore_rules_creator_identity_id ON project_ignore_rules(creator_identity_id) WHERE creator_identity_id IS NOT NULL;
ALTER TABLE embedding_modell_profile ADD COLUMN IF NOT EXISTS calibrator_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_embedding_modell_profile_calibrator_identity_id ON embedding_modell_profile(calibrator_identity_id) WHERE calibrator_identity_id IS NOT NULL;
ALTER TABLE intern_schalter ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_intern_schalter_setter_identity_id ON intern_schalter(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE build_pruefung_einstellungen ADD COLUMN IF NOT EXISTS setter_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_build_pruefung_einstellungen_setter_identity_id ON build_pruefung_einstellungen(setter_identity_id) WHERE setter_identity_id IS NOT NULL;
ALTER TABLE loesch_auftraege ADD COLUMN IF NOT EXISTS creator_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_loesch_auftraege_creator_identity_id ON loesch_auftraege(creator_identity_id) WHERE creator_identity_id IS NOT NULL;
ALTER TABLE tool_activation ADD COLUMN IF NOT EXISTS updater_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_tool_activation_updater_identity_id ON tool_activation(updater_identity_id) WHERE updater_identity_id IS NOT NULL;
ALTER TABLE asset_konflikte ADD COLUMN IF NOT EXISTS resolver_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_asset_konflikte_resolver_identity_id ON asset_konflikte(resolver_identity_id) WHERE resolver_identity_id IS NOT NULL;
ALTER TABLE asset_konflikt_loesungen ADD COLUMN IF NOT EXISTS owner_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_asset_konflikt_loesungen_owner_identity_id ON asset_konflikt_loesungen(owner_identity_id) WHERE owner_identity_id IS NOT NULL;
ALTER TABLE ansicht_tokens ADD COLUMN IF NOT EXISTS creator_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_ansicht_tokens_creator_identity_id ON ansicht_tokens(creator_identity_id) WHERE creator_identity_id IS NOT NULL;
ALTER TABLE ansicht_token_audit ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_ansicht_token_audit_actor_identity_id ON ansicht_token_audit(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE reverse_eintraege ADD COLUMN IF NOT EXISTS creator_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_reverse_eintraege_creator_identity_id ON reverse_eintraege(creator_identity_id) WHERE creator_identity_id IS NOT NULL;
ALTER TABLE reverse_eintraege ADD COLUMN IF NOT EXISTS confirmer_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_reverse_eintraege_confirmer_identity_id ON reverse_eintraege(confirmer_identity_id) WHERE confirmer_identity_id IS NOT NULL;
ALTER TABLE reverse_bindungen ADD COLUMN IF NOT EXISTS binder_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_reverse_bindungen_binder_identity_id ON reverse_bindungen(binder_identity_id) WHERE binder_identity_id IS NOT NULL;
ALTER TABLE reverse_uebernahmen ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_reverse_uebernahmen_actor_identity_id ON reverse_uebernahmen(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS trigger_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_reverse_auftraege_trigger_identity_id ON reverse_auftraege(trigger_identity_id) WHERE trigger_identity_id IS NOT NULL;
ALTER TABLE agent_runtime_sessions ADD COLUMN IF NOT EXISTS identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_runtime_sessions_identity_id ON agent_runtime_sessions(identity_id) WHERE identity_id IS NOT NULL;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS created_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_agent_artifacts_created_by_identity_id ON agent_artifacts(created_by_identity_id) WHERE created_by_identity_id IS NOT NULL;
ALTER TABLE agent_identitaet_channel_sichtung ADD COLUMN IF NOT EXISTS reviewer_identity_id TEXT REFERENCES agent_identitaeten(id);
ALTER TABLE agent_identitaet_event_acks ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
ALTER TABLE agent_identitaet_file_reservations ADD COLUMN IF NOT EXISTS taken_over_by_identity_id TEXT REFERENCES agent_identitaeten(id);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS lauf_id TEXT REFERENCES agent_identitaet_laeufe(id);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS context_epoch INTEGER;
ALTER TABLE agent_runtime_sessions ADD COLUMN IF NOT EXISTS lauf_id TEXT REFERENCES agent_identitaet_laeufe(id);
-- Snapshot-Ziel fuer identity:<id>-Scopes; keine Autorisierung aus diesem Feld.
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS target_agent_name TEXT;
-- Optionale Namenssnapshots in eigenen ID-Zustandstabellen, niemals als Schluessel.
ALTER TABLE agent_identitaet_onboardings ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_chat_lesestand ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_channel_mitglieder ALTER COLUMN agent_name DROP NOT NULL;
ALTER TABLE agent_identitaet_channel_sichtung ALTER COLUMN agent DROP NOT NULL;
ALTER TABLE agent_identitaet_channel_sichtung ALTER COLUMN gesichtet_von DROP NOT NULL;
ALTER TABLE agent_identitaet_event_acks ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_wrapper_status ALTER COLUMN agent_name DROP NOT NULL;
ALTER TABLE agent_identitaet_wissen ALTER COLUMN agent_name DROP NOT NULL;
ALTER TABLE agent_identitaet_file_reservations ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_shell_job_notices ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_hinweis_gesehen ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_hinweis_aufrufe ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_hinweis_zustellungen ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_skill_deliveries ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_skill_preparations ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_identitaet_error_pattern_seen ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE specialist_jobs ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_specialist_jobs_actor ON specialist_jobs(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE agent_event_acks ADD COLUMN IF NOT EXISTS actor_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_event_acks_actor ON agent_event_acks(actor_identity_id) WHERE actor_identity_id IS NOT NULL;
ALTER TABLE file_reservations ADD COLUMN IF NOT EXISTS taken_over_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_reservations_takeover ON file_reservations(taken_over_by_identity_id) WHERE taken_over_by_identity_id IS NOT NULL;
ALTER TABLE agent_identitaet_skill_deliveries ADD COLUMN IF NOT EXISTS context_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS committed_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_plans_committed_by ON file_batch_plans(committed_by_identity_id) WHERE committed_by_identity_id IS NOT NULL;
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS cancelled_by_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_plans_cancelled_by ON file_batch_plans(cancelled_by_identity_id) WHERE cancelled_by_identity_id IS NOT NULL;
ALTER TABLE channel_sichtung ADD COLUMN IF NOT EXISTS reviewer_identity_id TEXT REFERENCES agent_identitaeten(id);
CREATE INDEX IF NOT EXISTS idx_aib_channel_sichtung_reviewer ON channel_sichtung(reviewer_identity_id) WHERE reviewer_identity_id IS NOT NULL;
-- ID-Attribution auch fuer bereits verbundene LISTEN-Clients; Namen bleiben Snapshots.
CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $$
BEGIN
 PERFORM pg_notify('synapse_chat', (jsonb_build_object(
  'project',NEW.project,'sender_id',NEW.sender_id,'recipient_id',COALESCE(NEW.recipient_id,''),'id',NEW.id)
  || jsonb_strip_nulls(jsonb_build_object('sender_identity_id',NEW.sender_identity_id,'recipient_identity_id',NEW.recipient_identity_id)))::text);
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION notify_agent_event() RETURNS trigger AS $$
BEGIN
 PERFORM pg_notify('synapse_event', (jsonb_build_object(
  'project',NEW.project,'event_type',NEW.event_type,'priority',NEW.priority,'source_id',NEW.source_id,'id',NEW.id)
  || jsonb_strip_nulls(jsonb_build_object('source_identity_id',NEW.source_identity_id,'target_identity_id',NEW.target_identity_id)))::text);
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION notify_channel_message() RETURNS trigger AS $$
DECLARE ch_name TEXT; ch_project TEXT;
BEGIN
 SELECT name,project INTO ch_name,ch_project FROM specialist_channels WHERE id=NEW.channel_id;
 PERFORM pg_notify('synapse_channel', (jsonb_build_object(
  'project',COALESCE(ch_project,''),'channel',COALESCE(ch_name,''),'sender',NEW.sender,'id',NEW.id)
  || jsonb_strip_nulls(jsonb_build_object('sender_identity_id',NEW.sender_identity_id)))::text);
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION notify_file_change() RETURNS trigger AS $$
BEGIN
 PERFORM pg_notify('synapse_file', (jsonb_build_object(
  'project',NEW.project,'file_path',NEW.file_path,'edit_action',NEW.edit_action,'agent_id',COALESCE(NEW.agent_id,''),'id',NEW.id::text)
  || jsonb_strip_nulls(jsonb_build_object('author_identity_id',NEW.author_identity_id,'identity_id',NEW.author_identity_id)))::text);
 RETURN NEW;
END $$ LANGUAGE plpgsql;
-- P22-T55: Ausweis-Daten (agent_id, identity_id, lauf_id) des letzten Schreibers auch fuer Memories und Tech-Docs.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS author_agent_id TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS author_identity_id TEXT REFERENCES agent_identitaeten(id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS author_lauf_id TEXT REFERENCES agent_identitaet_laeufe(id);
CREATE INDEX IF NOT EXISTS idx_aib_memories_author_identity_id ON memories(author_identity_id) WHERE author_identity_id IS NOT NULL;
ALTER TABLE tech_docs ADD COLUMN IF NOT EXISTS author_agent_id TEXT;
ALTER TABLE tech_docs ADD COLUMN IF NOT EXISTS author_identity_id TEXT REFERENCES agent_identitaeten(id);
ALTER TABLE tech_docs ADD COLUMN IF NOT EXISTS author_lauf_id TEXT REFERENCES agent_identitaet_laeufe(id);
CREATE INDEX IF NOT EXISTS idx_aib_tech_docs_author_identity_id ON tech_docs(author_identity_id) WHERE author_identity_id IS NOT NULL;

`;
