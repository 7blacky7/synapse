/**
 * MODUL: PostgreSQL Schema
 * ZWECK: DDL-Migration fuer alle Synapse-Tabellen — einmalig ausfuehren beim Start.
 *
 * INPUT:
 *   - Kein direkter Input; nutzt intern getPool() aus client.ts
 *
 * OUTPUT:
 *   - void: Schema ist nach ensureSchema() garantiert vorhanden
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Erstellt Tabellen memories, thoughts, plans, proposals,
 *     agent_sessions, chat_messages, tech_docs, code_files, agent_events, agent_event_acks,
 *     code_symbols, code_references, code_chunks
 *   - Erweitert code_files um: content, content_hash, parsed_at, tsv (mit GIN-Index + Trigger)
 *   - Legt Indizes fuer alle Projekt- und Zeitstempel-Felder an
 *   - Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 */

/**
 * ⚠️ ZWEITER ORT FUER DASSELBE SCHEMA: packages/core/src/db/schema-sql/
 *
 * Dort liegt das vollstaendige Schema als .sql-Dateien (nur Struktur, keine Daten),
 * damit die Datenbank aus dem geklonten Repo von null aufgebaut werden kann.
 * Erzeugt per pg_dump aus der laufenden Datenbank, aufgeteilt nach Sachgebiet.
 *
 * DIESE Datei ist der ausgefuehrte Weg — der Ordner ist nur ihre Spiegelung und
 * wird NICHT automatisch mitgezogen. Wer hier eine Tabelle oder Spalte aendert,
 * macht den Export veraltet, ohne dass irgendetwas fehlschlaegt. Danach also neu
 * exportieren; das Kommando steht in schema-sql/README.md.
 */


import { getPool } from './client.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'note',
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: task_id fuer Verknuepfung Thought↔Plan-Task (Idea 1, 2026-05-02)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_thoughts_project_task_id ON thoughts(project, task_id) WHERE task_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  goals TEXT[] DEFAULT '{}',
  architecture TEXT,
  tasks JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  suggested_content TEXT NOT NULL,
  description TEXT,
  author TEXT,
  status TEXT DEFAULT 'pending',
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Nachzug fuer nebenlaeufiges Embedding (EMBED-1, 2026-07-28).
-- Der Schreibvorgang kehrt zurueck, sobald die Zeile in PostgreSQL steht; der Vektor wird
-- nachgereicht. embedded_at IS NULL ist die Backlog-Bedingung — ohne diese Spalte waere ein
-- fehlgeschlagenes Embedding STILL VERLOREN: der Eintrag ist ueber PG abrufbar, hat aber nie
-- einen Vektor, und niemand merkt es.
--
-- WARUM DEFAULT NOW() UND DIREKT DANACH DROP DEFAULT, in genau dieser Reihenfolge:
-- ADD COLUMN mit DEFAULT fuellt die BESTEHENDEN Zeilen mit diesem Wert. Der Altbestand gilt
-- damit als erledigt — er hat seine Vektoren ja bereits. Ohne das waere jede vorhandene Memory
-- und jeder Gedanke ab sofort faellig, und die Einfuehrung dieser Spalte wuerde genau die
-- Massen-Embedding-Welle ausloesen, gegen die sie gebaut ist.
-- Das anschliessende DROP DEFAULT sorgt dafuer, dass NEUE Zeilen NULL bekommen und damit vom
-- Backlog gesehen werden. Beides zusammen ist idempotent: beim zweiten Lauf greift
-- IF NOT EXISTS, das DROP DEFAULT ist dann ein No-op.
ALTER TABLE memories  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE memories  ALTER COLUMN embedded_at DROP DEFAULT;
ALTER TABLE thoughts  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE thoughts  ALTER COLUMN embedded_at DROP DEFAULT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE proposals ALTER COLUMN embedded_at DROP DEFAULT;

-- Teil-Indizes: der Backlog fragt ausschliesslich nach den offenen Zeilen, und das sind im
-- Normalbetrieb sehr wenige. Ein Teil-Index bleibt dadurch winzig, auch wenn die Tabellen wachsen.
CREATE INDEX IF NOT EXISTS idx_memories_embed_backlog  ON memories(project)  WHERE embedded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_embed_backlog  ON thoughts(project)  WHERE embedded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_embed_backlog ON proposals(project) WHERE embedded_at IS NULL;


CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  model TEXT,
  cutoff_date DATE,
  status TEXT DEFAULT 'active',
  server_instance_id TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: server_instance_id nachtraeglich hinzufuegen
-- HINWEIS: agent_sessions.server_instance_id ist seit agent_onboardings obsolet
-- (wird nicht mehr geschrieben) — Spalte bleibt fuer Bestandsdaten erhalten.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS server_instance_id TEXT;

-- Onboarding-Gedaechtnis: einmal pro (Agent, Projekt, Server-Prozess).
-- Ersetzt den server_instance_id-Vergleich auf agent_sessions, der zwei Defekte hatte:
-- (1) Ping-Pong: mehrere Prozesse ueberschreiben sich gegenseitig die eine Zeile (UNIQUE(id)),
-- (2) Project-Mismatch: SELECT prueft id+project, INSERT aktualisiert project nie →
--     Agent in zweitem Projekt wurde bei JEDEM Tool-Call neu ongeboardet.
CREATE TABLE IF NOT EXISTS agent_onboardings (
  agent_id TEXT NOT NULL,
  project TEXT NOT NULL,
  server_instance_id TEXT NOT NULL,
  onboarded_at TIMESTAMPTZ DEFAULT NOW(),
  rolle TEXT,
  rolle_quelle TEXT,
  PRIMARY KEY (agent_id, project, server_instance_id)
);

-- ROLLEN-PROTOKOLL (2026-08-02): haelt fest, WELCHE Rolle beim Onboarding verwendet
-- wurde und WOHER sie kam.
-- Es ist ein PROTOKOLL, keine Wahrheit: es sagt, was das System entschieden hat —
-- nicht, ob die Entscheidung richtig war. Einen richtigen Default kann man von einem
-- falschen nicht unterscheiden, beide sehen identisch aus.
-- WAS ES TROTZDEM BEWEISBAR MACHT: hat derselbe Agent in kurzer Zeit ZWEI verschiedene
-- Rollen bekommen? Das ist ein Widerspruch, den man ohne Aussenwissen zeigen kann —
-- ein GROUP BY (agent_id, project) statt eines Zufallsfundes. Genau dieser Fall ist am
-- 02.08.2026 drei Agenten gleichzeitig passiert und fiel nur auf, weil sie zufaellig
-- die gelieferten Regelnamen ausgezaehlt haben.
-- Bewusst NULLABLE und ohne Backfill: die Tabelle hat 7-Tage-Retention
-- (project-status.ts), der Altbestand laeuft von selbst aus. Kein Umstellungstag,
-- kein Zustand, in dem eine Regel niemanden erreicht.
ALTER TABLE agent_onboardings ADD COLUMN IF NOT EXISTS rolle TEXT;
ALTER TABLE agent_onboardings ADD COLUMN IF NOT EXISTS rolle_quelle TEXT;

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT,
  content TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tech_docs (
  id TEXT PRIMARY KEY,
  framework TEXT NOT NULL,
  version TEXT NOT NULL,
  section TEXT,
  content TEXT NOT NULL,
  type TEXT,
  category TEXT DEFAULT 'framework',
  content_hash TEXT UNIQUE,
  source TEXT DEFAULT 'context7',
  indexed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS code_files (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0,
  file_size INTEGER DEFAULT 0,
  indexed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project, file_path)
);

CREATE TABLE IF NOT EXISTS projects (
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_access TIMESTAMPTZ DEFAULT NOW(),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (name, hostname)
);
-- Migration: enabled-Flag fuer bestehende Tabellen (deaktivierte Projekte
-- werden vom Parser-Worker uebersprungen — siehe parser-worker.ts).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- SETUP-1: Setup-Phase-Tracking (projektweiter Einrichtungsfortschritt).
-- Eigene Tabelle statt Spalte in projects, weil projects PK (name, hostname)
-- hat — pro Projekt eine Zeile JE HOSTNAME (inkl. virtuellem 'rest-api'-Eintrag,
-- siehe registerVirtualProject). setupPhase ist aber projektweit: ein Setup wird
-- oft lokal begonnen und soll ueber die REST-API (virtueller Host) abgeschlossen
-- werden koennen. Als Spalte in projects gaebe es N Kopien desselben Werts ohne
-- eindeutige Quelle. Ersetzt .synapse/status.json als primaere Datenquelle, analog
-- zu wrapper_status fuer Spezialisten. status.json bleibt optionaler Cache/Fallback.
CREATE TABLE IF NOT EXISTS project_setup_status (
  project TEXT PRIMARY KEY,
  setup_phase TEXT NOT NULL DEFAULT 'none',  -- none|initial-pending|initial-done|post-indexing-pending|complete
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_events (
  id SERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  scope TEXT NOT NULL DEFAULT 'all',
  source_id TEXT NOT NULL,
  payload TEXT,
  requires_ack BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_event_acks (
  event_id INTEGER REFERENCES agent_events(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  acked_at TIMESTAMPTZ DEFAULT NOW(),
  reaction TEXT,
  PRIMARY KEY (event_id, agent_id)
);

CREATE TABLE IF NOT EXISTS file_versions (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  edit_action TEXT,
  agent_id TEXT,
  batch_id BIGINT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS reason TEXT;
-- IDEA-3a: History Enrichment (additive, alle nullable)
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS feature_tag TEXT;
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS parent_version_id BIGINT;
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS git_commit_sha TEXT;
-- IDEA-6: KI-eigene Analyse/Beobachtungen pro Batch, optional
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS agent_note TEXT;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'file_versions_parent_version_id_fkey'
  ) THEN
    ALTER TABLE file_versions ADD CONSTRAINT file_versions_parent_version_id_fkey
      FOREIGN KEY (parent_version_id) REFERENCES file_versions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_fv_feature_tag ON file_versions(project, feature_tag) WHERE feature_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fv_git_sha ON file_versions(git_commit_sha) WHERE git_commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fv_parent ON file_versions(parent_version_id) WHERE parent_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_thoughts_project ON thoughts(project);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project);
CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient ON chat_messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project);
CREATE INDEX IF NOT EXISTS idx_tech_docs_framework ON tech_docs(framework, version);
CREATE INDEX IF NOT EXISTS idx_tech_docs_hash ON tech_docs(content_hash);
CREATE INDEX IF NOT EXISTS idx_code_files_project ON code_files(project);
CREATE INDEX IF NOT EXISTS idx_code_files_path ON code_files(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_files_type ON code_files(project, file_type);

CREATE INDEX IF NOT EXISTS idx_agent_events_project ON agent_events(project, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_event_acks_agent ON agent_event_acks(agent_id);

CREATE INDEX IF NOT EXISTS idx_file_versions_lookup ON file_versions(project, file_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_versions_batch ON file_versions(batch_id) WHERE batch_id IS NOT NULL;

-- Migration: Neue Spalten fuer Code-Intelligence
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS content_hash TEXT;
-- INDEX-3: mit welcher Parser-Version wurde die Datei zuletzt geparst?
-- NULL bedeutet UNBEKANNT und loest bewusst KEINEN Reparse aus — sonst wuerde
-- die Einfuehrung selbst den gesamten Bestand auf einen Schlag neu parsen.
-- Die Spalte fuellt sich beim naechsten regulaeren Parse jeder Datei.
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS parser_version INTEGER;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS parsed_at TIMESTAMPTZ;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS tsv TSVECTOR;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_code_files_tsv ON code_files USING GIN(tsv);
CREATE INDEX IF NOT EXISTS idx_code_files_hash ON code_files(project, content_hash);

CREATE OR REPLACE FUNCTION code_files_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_code_files_tsv ON code_files;
CREATE TRIGGER trg_code_files_tsv
  BEFORE INSERT OR UPDATE OF content ON code_files
  FOR EACH ROW EXECUTE FUNCTION code_files_tsv_trigger();

CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  name TEXT,
  value TEXT,
  line_start INTEGER NOT NULL,
  line_end INTEGER,
  parent_symbol TEXT REFERENCES code_symbols(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  params TEXT[],
  return_type TEXT,
  is_exported BOOLEAN DEFAULT false,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_project ON code_symbols(project);
CREATE INDEX IF NOT EXISTS idx_code_symbols_type ON code_symbols(project, symbol_type);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(project, name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(project, file_path);
-- parent_symbol hat einen self-FK (parent_symbol -> id) ON DELETE CASCADE. Ohne Index
-- muss jeder Symbol-DELETE die Tabelle seq-scannen, um Cascade-Kinder zu finden →
-- per-Datei-DELETE wird bei großen/duplizierten Dateien extrem langsam (Minuten).
CREATE INDEX IF NOT EXISTS idx_code_symbols_parent_symbol ON code_symbols(parent_symbol);

CREATE TABLE IF NOT EXISTS code_references (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  symbol_id TEXT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_references_symbol ON code_references(symbol_id);
CREATE INDEX IF NOT EXISTS idx_code_references_file ON code_references(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_references_project ON code_references(project);

CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  embedded_at TIMESTAMPTZ,
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_unembedded ON code_chunks(project) WHERE embedded_at IS NULL;

-- GPU-2: verteilte Pull-Claims. Altbestand bleibt claimbar; content_hash wird beim
-- ersten Claim serverseitig aus dem aktuellen Inhalt berechnet. Lease/Token sind
-- reine Arbeitszustaende, embedded_at bleibt die fachliche Quelle der Wahrheit.
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS claim_token TEXT;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS claim_attempt INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_code_chunks_claimable
  ON code_chunks(lease_until, project, file_path, chunk_index)
  WHERE embedded_at IS NULL;

-- Ordnung INNERHALB eines Projekts. Der Index oben beginnt mit lease_until und
-- taugt deshalb nicht, wenn die Auswahl zuerst das Projekt festlegt und dann
-- der Reihe nach dessen Chunks nimmt — genau das tut claimEmbeddingChunks seit
-- dem 01.08.2026, weil die einstufige Auswahl 7,9 s je Runde brauchte.
CREATE INDEX IF NOT EXISTS idx_code_chunks_claim_ordnung
  ON code_chunks(project, file_path, chunk_index)
  WHERE embedded_at IS NULL;

-- ============================================================================
-- CodeIntel Ablauf-Ebene (Statement-/Execution-Flow)
-- code_statements: pro Datei geordnete Statements (top-level + innerhalb Scopes)
-- code_call_edges: Aufruf-Kanten (CallExpression/new/method/await) je Statement
-- ============================================================================
CREATE TABLE IF NOT EXISTS code_statements (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  scope_type TEXT,                -- 'module' | 'function' | 'method' | 'class' | ...
  scope_name TEXT,                -- Name des umschliessenden Scopes (z.B. Funktionsname)
  statement_type TEXT NOT NULL,   -- 'if' | 'for' | 'while' | 'call' | 'return' | 'assignment' | ...
  node_kind TEXT,                 -- roher AST-Kind-Name (z.B. 'IfStatement', 'CallExpression')
  line_start INTEGER NOT NULL,
  line_end INTEGER,
  order_index INTEGER NOT NULL,   -- Reihenfolge innerhalb des Scopes (0-basiert)
  depth INTEGER NOT NULL DEFAULT 0, -- Verschachtelungstiefe
  parent_statement_id BIGINT REFERENCES code_statements(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  text TEXT,                      -- gekuerzter Quelltext des Statements
  callee TEXT,                    -- bei calls: aufgerufener Name
  receiver TEXT,                  -- bei method-calls: Receiver-Ausdruck (z.B. 'pool')
  assigned_to TEXT,               -- bei assignments: Ziel-Variable
  condition_text TEXT,            -- bei if/while/for: Bedingungstext
  is_top_level BOOLEAN NOT NULL DEFAULT false,
  is_awaited BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_code_statements_file ON code_statements(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_statements_toplevel ON code_statements(project, is_top_level) WHERE is_top_level = true;
CREATE INDEX IF NOT EXISTS idx_code_statements_scope ON code_statements(project, file_path, scope_name);
CREATE INDEX IF NOT EXISTS idx_code_statements_parent ON code_statements(parent_statement_id) WHERE parent_statement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS code_call_edges (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  caller_scope TEXT,              -- umschliessender Scope-Name des Aufrufs
  statement_id BIGINT REFERENCES code_statements(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  callee_name TEXT NOT NULL,      -- aufgerufener Funktions-/Methodenname
  callee_receiver TEXT,           -- Receiver-Ausdruck bei method-calls
  target_symbol_id TEXT REFERENCES code_symbols(id) ON DELETE SET NULL, -- aufgeloestes Ziel-Symbol (optional)
  line_number INTEGER NOT NULL,
  call_kind TEXT,                 -- 'function' | 'method' | 'new' | 'await'
  confidence REAL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_code_call_edges_file ON code_call_edges(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_call_edges_callee ON code_call_edges(project, callee_name);
CREATE INDEX IF NOT EXISTS idx_code_call_edges_statement ON code_call_edges(statement_id) WHERE statement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_code_call_edges_target ON code_call_edges(target_symbol_id) WHERE target_symbol_id IS NOT NULL;

-- Migration: FKs auf code_files DEFERRABLE machen (fuer move-Operation)
DO $$ BEGIN
  -- code_symbols FK
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'code_symbols_project_file_path_fkey') THEN
    ALTER TABLE code_symbols DROP CONSTRAINT code_symbols_project_file_path_fkey;
    ALTER TABLE code_symbols ADD CONSTRAINT code_symbols_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- code_references FK
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'code_references_project_file_path_fkey') THEN
    ALTER TABLE code_references DROP CONSTRAINT code_references_project_file_path_fkey;
    ALTER TABLE code_references ADD CONSTRAINT code_references_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- code_chunks FK
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'code_chunks_project_file_path_fkey') THEN
    ALTER TABLE code_chunks DROP CONSTRAINT code_chunks_project_file_path_fkey;
    ALTER TABLE code_chunks ADD CONSTRAINT code_chunks_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Watcher Debug-Log (alle rohen chokidar-Events, auch nicht-indexierte)
CREATE TABLE IF NOT EXISTS watcher_events (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_watcher_events_project_time ON watcher_events(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watcher_events_path ON watcher_events(project, file_path);

-- Error Patterns (global, kein Projekt-Filter)
CREATE TABLE IF NOT EXISTS error_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  fix TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  model_scope TEXT NOT NULL,
  found_by TEXT NOT NULL,
  found_in_model TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Error Pattern Seen Tracking
CREATE TABLE IF NOT EXISTS error_pattern_seen (
  pattern_id UUID REFERENCES error_patterns(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  shown_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (pattern_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_error_pattern_seen_session
  ON error_pattern_seen(session_id);

-- Specialist Channels (Gruppenchat) — aus agents/schema.ts nach core verschoben
CREATE TABLE IF NOT EXISTS specialist_channels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  project TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, project)
);

CREATE TABLE IF NOT EXISTS specialist_channel_members (
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_message_id BIGINT,
  last_notified_message_id BIGINT,
  read_initialized_at TIMESTAMPTZ,
  PRIMARY KEY (channel_id, agent_name)
);

CREATE TABLE IF NOT EXISTS specialist_channel_messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE specialist_channel_members ADD COLUMN IF NOT EXISTS last_read_message_id BIGINT;
ALTER TABLE specialist_channel_members ADD COLUMN IF NOT EXISTS last_notified_message_id BIGINT;
ALTER TABLE specialist_channel_members ADD COLUMN IF NOT EXISTS read_initialized_at TIMESTAMPTZ;
UPDATE specialist_channel_members mem
SET last_read_message_id=COALESCE(mem.last_read_message_id,
      (SELECT MAX(msg.id) FROM specialist_channel_messages msg WHERE msg.channel_id=mem.channel_id),0),
    last_notified_message_id=COALESCE(mem.last_notified_message_id,mem.last_read_message_id,
      (SELECT MAX(msg.id) FROM specialist_channel_messages msg WHERE msg.channel_id=mem.channel_id),0),
    read_initialized_at=COALESCE(mem.read_initialized_at,mem.joined_at,NOW())
WHERE mem.last_read_message_id IS NULL OR mem.last_notified_message_id IS NULL
   OR mem.read_initialized_at IS NULL;
ALTER TABLE specialist_channel_members
  ALTER COLUMN last_read_message_id SET DEFAULT 0,
  ALTER COLUMN last_read_message_id SET NOT NULL,
  ALTER COLUMN read_initialized_at SET DEFAULT NOW(),
  ALTER COLUMN read_initialized_at SET NOT NULL;

-- Specialist Inbox (1:1 Messaging)
CREATE TABLE IF NOT EXISTS specialist_inbox (
  id SERIAL PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indices (Channels + Inbox)
CREATE INDEX IF NOT EXISTS idx_specialist_inbox_unprocessed
  ON specialist_inbox(to_agent, processed) WHERE processed = false;
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_channel
  ON specialist_channel_messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_created
  ON specialist_channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channels_project
  ON specialist_channels(project);
CREATE INDEX IF NOT EXISTS idx_specialist_channel_members_agent
  ON specialist_channel_members(agent_name, channel_id);

-- LISTEN/NOTIFY Trigger fuer Event-Driven Watcher

-- Migration: UNIQUE(name) → UNIQUE(name, project) fuer Multi-Projekt-Support
ALTER TABLE specialist_channels DROP CONSTRAINT IF EXISTS specialist_channels_name_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'specialist_channels_name_project_key') THEN
    ALTER TABLE specialist_channels ADD CONSTRAINT specialist_channels_name_project_key UNIQUE(name, project);
  END IF;
END $$;
-- Payload: JSON mit project, sender, type etc. fuer Client-seitiges Filtering

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('synapse_chat', json_build_object(
    'project', NEW.project,
    'sender_id', NEW.sender_id,
    'recipient_id', COALESCE(NEW.recipient_id, ''),
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_chat_message ON chat_messages;
CREATE TRIGGER trg_notify_chat_message
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION notify_chat_message();

CREATE OR REPLACE FUNCTION notify_agent_event() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_agent_event ON agent_events;
CREATE TRIGGER trg_notify_agent_event
  AFTER INSERT ON agent_events
  FOR EACH ROW EXECUTE FUNCTION notify_agent_event();

CREATE OR REPLACE FUNCTION notify_channel_message() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_channel_message ON specialist_channel_messages;
CREATE TRIGGER trg_notify_channel_message
  AFTER INSERT ON specialist_channel_messages
  FOR EACH ROW EXECUTE FUNCTION notify_channel_message();

-- ==========================================================================
-- Shell-Queue (Task 1): shell_jobs + shell_stream_chunks + NOTIFY-Trigger
-- REST-API ↔ FileWatcher-Daemon Shell-Exec via PostgreSQL LISTEN/NOTIFY.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE shell_job_status AS ENUM ('pending', 'running', 'done', 'failed', 'rejected', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS shell_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd_relative TEXT,
  timeout_ms INTEGER DEFAULT 30000,
  tail_lines INTEGER DEFAULT 5,
  status shell_job_status NOT NULL DEFAULT 'pending',
  exit_code INTEGER,
  tail JSONB,
  error TEXT,
  stream_id TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive Migrations: actionable error-message + persistenter Voll-Output.
-- message: getrennt vom error-Code, damit Web-KI-Connectors dem User
--   sagen koennen was zu tun ist ("Projekt im Tray aktivieren").
-- output: Worker schreibt stdout+stderr bei Completion direkt in PG
--   (gecappt 1MB) — REST-API auf Unraid kann ohne Filesystem-Zugriff
--   zur Projekt-Maschine den Log lesen.
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output TEXT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output_truncated BOOLEAN DEFAULT false;
-- agent_id: echte Attribution des dispatchenden Agenten (Multi-Agenten-Aufsicht).
--   Cloud: aus Header abgeleitet (deriveAgentIdFromHeaders); Spezialist: SYNAPSE_AGENT_NAME;
--   sonst explizit. shell(history) + shell(activity) zeigen damit WER den Job absetzte.
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_shell_jobs_project_status ON shell_jobs(project, status);
CREATE INDEX IF NOT EXISTS idx_shell_jobs_created ON shell_jobs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_shell_jobs_history ON shell_jobs(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shell_jobs_agent ON shell_jobs(agent_id) WHERE agent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION notify_shell_job_created() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('shell_job_created', NEW.project || ':' || NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shell_jobs_notify ON shell_jobs;
CREATE TRIGGER trg_shell_jobs_notify
  AFTER INSERT ON shell_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_shell_job_created();

CREATE TABLE IF NOT EXISTS shell_stream_chunks (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES shell_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  line TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shell_stream_chunks_job ON shell_stream_chunks(job_id, chunk_index);

-- ==========================================================================
-- Tool-Call Activity-Store: zentraler Audit-Log ALLER MCP-Tool-Aufrufe.
-- Quelle der Multi-Agenten-Aufsicht via shell(action:"activity"). Shell-Jobs
-- werden als tool='shell'-Metazeile mit-interleaved; ihr voller Output bleibt
-- in shell_jobs. agent_id ist die echte Attribution (source nur Fallback).
-- Basis-Tabelle existiert bereits in produktiver DB (CREATE IF NOT EXISTS = no-op);
-- die ALTER-Spalten sind die additive Activity-Store-Erweiterung.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS tool_calls (
  id BIGSERIAL PRIMARY KEY,
  project TEXT,
  tool_name TEXT NOT NULL,
  action TEXT,
  source TEXT,
  args_preview TEXT,
  ok BOOLEAN DEFAULT true,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS agent_id         TEXT;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS duration_ms      INTEGER;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS error            TEXT;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS result           TEXT;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS result_bytes     INTEGER;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS result_truncated BOOLEAN DEFAULT false;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS is_mutation      BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_tool_calls_project_ts ON tool_calls(project, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool  ON tool_calls(tool_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_mut   ON tool_calls(ts DESC) WHERE is_mutation;

-- ==========================================================================
-- Specialist-Queue: REST-API ↔ FileWatcher-Daemon Specialist-Calls.
-- Alle Specialist-Actions (spawn, stop, purge, wake, etc.) werden via PG
-- Queue an den lokalen Daemon delegiert. Erlaubt Web-KIs (REST) Spezialisten
-- auf dem Host-PC zu spawnen wo Claude-CLI + FS verfuegbar sind.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE specialist_job_status AS ENUM ('pending', 'running', 'done', 'failed', 'rejected', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS specialist_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  action TEXT NOT NULL,
  args JSONB NOT NULL,
  status specialist_job_status NOT NULL DEFAULT 'pending',
  result JSONB,
  error TEXT,
  message TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_specialist_jobs_project_status ON specialist_jobs(project, status);
CREATE INDEX IF NOT EXISTS idx_specialist_jobs_created ON specialist_jobs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_specialist_jobs_history ON specialist_jobs(project, created_at DESC);

CREATE OR REPLACE FUNCTION notify_specialist_job_created() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('specialist_job_created', NEW.project || ':' || NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_specialist_jobs_notify ON specialist_jobs;
CREATE TRIGGER trg_specialist_jobs_notify
  AFTER INSERT ON specialist_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_specialist_job_created();

-- ==========================================================================
-- Project-Init-Queue: REST-API ↔ FileWatcher-Daemon Project-Bootstrap.
-- Web-KIs (REST) koennen neue Projekte anlegen ohne Filesystem-Zugriff —
-- der Daemon auf dem Ziel-PC resolved den Workspace-Root, mkdir, git init,
-- registriert in projects-Tabelle und startet ggf. den FileWatcher.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE project_init_status AS ENUM ('pending', 'running', 'done', 'failed', 'rejected', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS project_init_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  hostname TEXT,
  template TEXT,
  requested_by TEXT,
  status project_init_status NOT NULL DEFAULT 'pending',
  resolved_path TEXT,
  error TEXT,
  message TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_init_jobs_status ON project_init_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_project_init_jobs_pending ON project_init_jobs(created_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION notify_project_init_job_created() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('project_init_job_created', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_init_jobs_notify ON project_init_jobs;
CREATE TRIGGER trg_project_init_jobs_notify
  AFTER INSERT ON project_init_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_project_init_job_created();

-- ==========================================================================
-- Multi-File Edit-Plans: Plan/Commit-Phase fuer atomare Multi-Datei-Aenderungen.
-- Eine KI/Agent ruft files.plan(ops[]) -> erhaelt plan_id + previews.
-- files.commit(plan_id) wendet alle Ops in einer TX an, prueft expected_hashes
-- gegen aktuellen Stand. Bei Mismatch -> stale. Erfolgreicher Commit setzt
-- batch_id in jedem file_versions-Snapshot -> restore_batch funktioniert.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE file_batch_status AS ENUM ('open', 'committed', 'cancelled', 'expired', 'stale', 'conflict');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
ALTER TYPE file_batch_status ADD VALUE IF NOT EXISTS 'conflict';

CREATE TABLE IF NOT EXISTS file_batch_plans (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  owner_agent_id TEXT,
  ops JSONB NOT NULL,
  expected_hashes JSONB NOT NULL,
  previews JSONB NOT NULL,
  status file_batch_status NOT NULL DEFAULT 'open',
  open_for_coedit BOOLEAN NOT NULL DEFAULT TRUE,
  notify_channel TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_file_batch_plans_status ON file_batch_plans(project, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_batch_plans_open ON file_batch_plans(project, expires_at) WHERE status = 'open';
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS reason TEXT;

-- ==========================================================================
-- Kooperative Dateireservierungen (Co-Edit CE-1).
-- Reine Buchfuehrung: diese Tabelle blockiert plan/commit noch nicht.
-- Mehrere Agenten duerfen denselben (project, file_path) reservieren.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS file_reservations (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  released_at TIMESTAMPTZ,
  plan_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_file_reservations_path
  ON file_reservations(project, file_path);
CREATE INDEX IF NOT EXISTS idx_file_reservations_agent
  ON file_reservations(project, agent_id);
-- Absichtlich partiell UND dreispaltig: Retry desselben Agenten ist idempotent,
-- verschiedene Agenten duerfen denselben Pfad gleichzeitig reservieren.
-- NIEMALS zu UNIQUE(project, file_path) "vereinfachen" — das zerstoert Co-Edit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_reservations_active_agent_file
  ON file_reservations(project, agent_id, file_path)
  WHERE released_at IS NULL;


-- ============================================================================
-- CE-2/CE-3: Persistente Waits und Lifecycle fuer gemeinsame Primaerplaene.
-- Kommentare in SCHEMA_SQL sind immer SQL-Kommentare mit --.
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_batch_waits (
  wait_token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_plan_id BIGINT NOT NULL,
  project TEXT NOT NULL,
  waiting_agent TEXT,
  primary_agent TEXT NOT NULL,
  shared_files TEXT[] NOT NULL CHECK (cardinality(shared_files) > 0),
  deferred_ops JSONB NOT NULL CHECK (jsonb_typeof(deferred_ops) = 'array'),
  deferred_op_indexes INTEGER[] NOT NULL,
  primary_plan_id BIGINT,
  status TEXT NOT NULL DEFAULT 'waiting',
  contributed_files TEXT[] NOT NULL DEFAULT '{}',
  no_change_files TEXT[] NOT NULL DEFAULT '{}',
  consumed_deferred_op_indexes INTEGER[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS primary_plan_id BIGINT;
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS contributed_files TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS no_change_files TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS consumed_deferred_op_indexes INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
ALTER TABLE file_batch_waits ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_file_batch_waits_source_plan
  ON file_batch_waits(source_plan_id);
CREATE INDEX IF NOT EXISTS idx_file_batch_waits_active
  ON file_batch_waits(project, expires_at);
CREATE INDEX IF NOT EXISTS idx_file_batch_waits_primary_plan
  ON file_batch_waits(project, primary_plan_id, waiting_agent);

-- Serverseitige Skill-Hooks: Dedup gilt bewusst global je Agent und Skill.
-- Wechselnde Agent-IDs duerfen erneut vorgeschlagen bekommen.
CREATE TABLE IF NOT EXISTS skill_hook_deliveries (
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  hook_name TEXT NOT NULL,
  suggested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_name)
);

-- Vorberechnete HOOK-4-Treffer. Feed liest nur diese Tabelle und startet nie Embeddings.
-- SKILLNAMEN ALS EIGENE TABELLE (Idee des Users, 02.08.2026).
--
-- WARUM NICHT AUS DER VEKTORDATENBANK: ein Name ist reiner Text und braucht kein Embedding.
-- Gemessen am selben Tag: ein Channel-Text, der drei Skills beim Namen nennt, ergab einen
-- Vektor mit Score 0,042 zum besten Treffer — verwaschen, weil er von allem etwas enthaelt.
-- Der ausgeschriebene Name ist das verlaesslichere Signal, und er gehoert dorthin, wo man
-- ihn billig und unscharf durchsuchen kann.
--
-- Die Trigram-Suche faengt, was exaktes Vergleichen nie erwischt: "scarlet" statt
-- "scarlett", "phaser gamedev" mit Leerzeichen, Tippfehler. Sie laeuft VOR dem Embedding;
-- die semantische Suche bleibt daneben bestehen und findet weiterhin Themen, die niemand
-- beim Namen nennt.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS skill_names (
  skill_name TEXT PRIMARY KEY,
  section_count INTEGER NOT NULL DEFAULT 0,
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_skill_names_trgm
  ON skill_names USING gin (skill_name gin_trgm_ops);

-- VORBERECHNETE SKILL-KANDIDATEN, QUELLENNEUTRAL (umgebaut 02.08.2026).
--
-- ⚠️ DER CHANNEL IST NUR EINER VON MEHREREN HINWEISGEBERN (Vorgabe des Users).
-- Ein Skillname steht genauso in einer Memory, einem Gedanken oder einer Task. Solange der
-- Vorrat an specialist_channel_messages haengt, bekommt ein Agent, der nie in einen Channel
-- geht, auch nie einen Vorschlag — obwohl er die ganze Zeit mit Texten arbeitet, die Skills
-- beim Namen nennen. Deshalb steht hier jetzt (source_type, source_id) statt message_id.
--
-- source_type: 'channel' | 'memory' | 'thought' | 'task'
-- source_id:   die ID der Quelle als Text (Channel-Nachricht, Memory-Name, Thought-UUID,
--              Task-ID). Text, weil die Quellen verschiedene Schluesseltypen haben.
--
-- MEHRERE KANDIDATEN JE QUELLE UND AGENT: bis zum 02.08.2026 lag der Schluessel auf
-- (message_id, agent_id) — also genau EIN Vorschlag. Da jeder Skill einem Agenten nur einmal
-- gezeigt wird, war die Quelle danach verbraucht und der zweitbeste Treffer verloren.
--
-- ⚠️ KEIN FREMDSCHLUESSEL MEHR, und das ist Absicht: eine Spalte kann nicht auf vier
-- verschiedene Tabellen zeigen. Der Preis ist, dass Kandidaten einer geloeschten Quelle
-- stehen bleiben. Sie schaden nicht (ausgeliefert wird jeder Skill je Agent ohnehin nur
-- einmal, siehe skill_hook_deliveries) und sind ein paar Zeilen gross.
CREATE TABLE IF NOT EXISTS skill_hook_preparations (
  source_type TEXT NOT NULL DEFAULT 'channel',
  source_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  reason TEXT NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_type, source_id, agent_id, skill_name)
);

-- Migration bestehender Installationen: aus channel_skill_preparations wird die
-- quellenneutrale Tabelle. Der Bestand ist per Definition vom Typ 'channel'.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'channel_skill_preparations')
  THEN
    INSERT INTO skill_hook_preparations
      (source_type, source_id, agent_id, skill_name, score, reason, prepared_at)
    SELECT 'channel', message_id::text, agent_id, skill_name, score, reason, prepared_at
      FROM channel_skill_preparations
    ON CONFLICT DO NOTHING;
    DROP TABLE channel_skill_preparations;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_skill_hook_preparations_agent
  ON skill_hook_preparations(agent_id, prepared_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_hook_preparations_quelle
  ON skill_hook_preparations(source_type, source_id);

CREATE TABLE IF NOT EXISTS skill_hook_metrics (
  hook_name TEXT PRIMARY KEY,
  suggested_count BIGINT NOT NULL DEFAULT 0,
  dedup_suppressed_count BIGINT NOT NULL DEFAULT 0,
  load_skipped_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- File-Change-Notify: jeder INSERT in file_versions feuert pg_notify('synapse_file', ...)
-- damit Wrapper bei File-Aenderungen sofort reagieren koennen (Heartbeat-Reset auf 10s
-- + buffered wake-message mit "welche Datei wurde von wem geaendert").
CREATE OR REPLACE FUNCTION notify_file_change() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_file_change ON file_versions;
CREATE TRIGGER trg_notify_file_change
  AFTER INSERT ON file_versions
  FOR EACH ROW EXECUTE FUNCTION notify_file_change();

-- ==========================================================================
-- model_registry: zentrale Source-of-Truth fuer Spezialisten-Modelle.
-- Web-UI/REST kann neue Modelle anlegen ohne Recompile.
-- Wrapper macht 1x Lookup beim Start, In-Memory-Cache fuer Lebensdauer (DB-1).
-- Multi-Daemon: kein Cache-Drift weil Sessions PK haben + Modell pro Spawn fixiert (DB-2 nicht relevant).
-- ALTER TABLE-Risiko bei vielen agent_sessions Rows (>10k): siehe DB-3 Doku.
-- Unbekannter Alias bei Spawn: clear error mit listAliases-Output (DB-4).
-- ==========================================================================
CREATE TABLE IF NOT EXISTS model_registry (
  alias TEXT PRIMARY KEY,
  full_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  context_window INT NOT NULL,
  output_limit INT,
  env_required TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  runtime_binary TEXT NOT NULL DEFAULT 'claude',  -- 'binary' ist SQL-reserved
  runtime_path TEXT,
  corridor_min INT NOT NULL,
  corridor_max INT NOT NULL,
  pricing_input_usd_per_mtok NUMERIC(10,4),
  pricing_output_usd_per_mtok NUMERIC(10,4),
  pricing_cache_usd_per_mtok NUMERIC(10,4),
  cutoff_date DATE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provider-Credentials (optional — wenn SYNAPSE_GEMINI_USE_EMBEDDING_KEY=false)
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- agent_sessions: Provider + Model-Full-ID nachtraeglich
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS model_full_id TEXT;

-- Initial-Seed (idempotent via ON CONFLICT)
INSERT INTO model_registry
  (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date)
VALUES
  ('opus',              'claude-opus-4-7',                'anthropic',  200000, ARRAY[]::TEXT[],          'claude', NULL,                                90, 99, 15.00, 75.00, 1.50, '2025-01-01'),
  ('sonnet',            'claude-sonnet-4-6',              'anthropic',  200000, ARRAY[]::TEXT[],          'claude', NULL,                                80, 88,  3.00, 15.00, 0.30, '2025-01-01'),
  ('haiku',             'claude-haiku-4-5',               'anthropic',  200000, ARRAY[]::TEXT[],          'claude', NULL,                                80, 88,  1.00,  5.00, 0.10, '2025-01-01'),
  ('opus[1m]',          'claude-opus-4-7',                'anthropic', 1000000, ARRAY[]::TEXT[],          'claude', NULL,                                80, 99, 15.00, 75.00, 1.50, '2025-01-01'),
  ('sonnet[1m]',        'claude-sonnet-4-6',              'anthropic', 1000000, ARRAY[]::TEXT[],          'claude', NULL,                                70, 88,  3.00, 15.00, 0.30, '2025-01-01'),
  ('gemini-flash-lite', 'gemini-3.1-flash-lite-preview',  'google',    1000000, ARRAY['GOOGLE_API_KEY'],  'node',   '@synapse/agents-gemini/runtime',    80, 88,  0.25,  1.50, 0.025, '2025-01-01'),
  ('gemini-flash',      'gemini-3-flash-preview',         'google',    1000000, ARRAY['GOOGLE_API_KEY'],  'node',   '@synapse/agents-gemini/runtime',    80, 88,  0.50,  3.00, 0.05,  '2025-01-01'),
  ('gemini-pro',        'gemini-2.5-pro',                 'google',    1000000, ARRAY['GOOGLE_API_KEY'],  'node',   '@synapse/agents-gemini/runtime',    80, 88,  1.25, 10.00, 0.13,  '2025-01-01'),
  -- agy-CLI: Pro-Abo via Keyring, KEIN API-Key (env_required leer), provider 'antigravity' (getrennt von 'google')
  ('antigravity',       'agy-1.0.2',                      'antigravity', 1000000, ARRAY[]::TEXT[],         'node',   '@synapse/agents-antigravity/runtime', 95, 99, NULL,  NULL,  NULL,  NULL)
ON CONFLICT (alias) DO NOTHING;

-- ==========================================================================
-- wrapper_status: Source-of-Truth fuer laufende Wrapper/Spezialisten.
-- Ersetzt .synapse/agents/status.json als primaere Datenquelle.
-- Beide Eingangs-Pfade (stdio-MCP + REST) lesen/schreiben diese Tabelle.
-- status.json bleibt als optionaler Cache fuer Backward-Compat.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS wrapper_status (
  agent_name TEXT NOT NULL,
  project TEXT NOT NULL,
  wrapper_pid INTEGER,
  inner_pid INTEGER,
  socket_path TEXT,
  model TEXT,
  model_full_id TEXT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'idle',  -- running/idle/crashed/stopped
  busy BOOLEAN NOT NULL DEFAULT false,
  current_task TEXT,
  context_ceiling INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_percent NUMERIC(5,2),
  channels TEXT[] NOT NULL DEFAULT '{}',
  connected_mcp BOOLEAN NOT NULL DEFAULT false,
  last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_name, project)
);

CREATE INDEX IF NOT EXISTS idx_wrapper_status_project ON wrapper_status(project);
CREATE INDEX IF NOT EXISTS idx_wrapper_status_last_activity ON wrapper_status(last_activity);
-- Reaper-Query-Index: WHERE status='running' AND last_activity < NOW() - INTERVAL '3 min'
CREATE INDEX IF NOT EXISTS idx_wrapper_status_status ON wrapper_status(status, last_activity);

-- Heartbeat-Steuerung je Spezialist (02.08.2026).
-- Vorher war der Takt fest in packages/agents/src/heartbeat-state.ts verdrahtet und
-- von aussen nicht zu beeinflussen: ein Spezialist, der nur auf Zuruf arbeiten soll,
-- pollte trotzdem im selben Rhythmus wie einer, der eine Aufgabe abarbeitet.
--   heartbeat_enabled     = false → der Wrapper schlaegt gar nicht mehr von selbst.
--                           Er bleibt erreichbar: wake und LISTEN/NOTIFY wirken weiter.
--   heartbeat_interval_ms = NULL  → adaptive Ladder wie bisher (10s bis 60min).
--                           Zahl → genau dieser Takt, ohne Backoff.
-- Zugestellt wird ohne neuen Weg: trg_notify_wrapper_status_change feuert schon heute
-- bei jedem UPDATE dieser Tabelle.
ALTER TABLE wrapper_status ADD COLUMN IF NOT EXISTS heartbeat_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE wrapper_status ADD COLUMN IF NOT EXISTS heartbeat_interval_ms INTEGER;

-- NOTIFY-Trigger fuer wrapper_status Aenderungen
CREATE OR REPLACE FUNCTION notify_wrapper_status_change() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_wrapper_status_change ON wrapper_status;
CREATE TRIGGER trg_notify_wrapper_status_change
  AFTER INSERT OR UPDATE OR DELETE ON wrapper_status
  FOR EACH ROW EXECUTE FUNCTION notify_wrapper_status_change();

-- ============================================================================
-- project_workspaces — Lifecycle-Tracking pro-Projekt Docker-Container
-- ============================================================================
-- Server-seitige Sandbox-Container fuer Shell-Jobs/File-Sync, lazy-gestartet
-- + idle-gestoppt. PG ist Single-Source-of-Truth fuer den Workspace-Status,
-- damit Orchestrator-Restarts (synapse-api Container) den Stand wiederfinden.
CREATE TABLE IF NOT EXISTS project_workspaces (
  project           TEXT PRIMARY KEY,
  container_id      TEXT,                          -- Docker-Container-ID (NULL wenn cold)
  status            TEXT NOT NULL DEFAULT 'cold',  -- cold | warming | active | stopping | error
  image             TEXT NOT NULL DEFAULT 'synapse-workspace:latest',
  volume_name       TEXT,                          -- z.B. synapse-workspace-<project>
  cpu_limit         REAL NOT NULL DEFAULT 1.0,     -- CPUs
  mem_limit_mb      INT  NOT NULL DEFAULT 512,     -- MB
  pids_limit        INT  NOT NULL DEFAULT 200,
  tmpfs_mb          INT  NOT NULL DEFAULT 256,    -- /tmp tmpfs-Groesse in MB (Container-Start)
  pinned            BOOLEAN NOT NULL DEFAULT FALSE, -- LRU verschont gepinte
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_started_at   TIMESTAMPTZ,
  last_stopped_at   TIMESTAMPTZ,
  last_error        TEXT,                          -- letzter Container-Start/Exec-Fehler
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Migration fuer Bestands-DBs (CREATE TABLE IF NOT EXISTS migriert nicht):
ALTER TABLE project_workspaces ADD COLUMN IF NOT EXISTS tmpfs_mb INT NOT NULL DEFAULT 256;

-- WS3: Multi-Workspace pro Projekt — Identitaet wird (project, name).
-- Bestandszeilen werden automatisch zum Workspace 'main' (DEFAULT), die
-- Container-/Volume-/DNS-Namen von 'main' bleiben unveraendert (Kompat).
ALTER TABLE project_workspaces ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'main';
-- PK-Umbau project -> (project, name), idempotent: greift nur, solange der
-- PK noch 1-spaltig ist. Laeuft im selben pool.query(SCHEMA_SQL)-Aufruf
-- (Simple-Query, kein Statement-Splitting — DO-Block bleibt intakt).
DO $ws3$
BEGIN
  IF (SELECT array_length(conkey, 1) FROM pg_constraint
       WHERE conrelid = 'project_workspaces'::regclass AND contype = 'p') = 1 THEN
    ALTER TABLE project_workspaces DROP CONSTRAINT project_workspaces_pkey;
    ALTER TABLE project_workspaces ADD PRIMARY KEY (project, name);
  END IF;
END
$ws3$;
-- LRU-/Idle-Stopper-Query: WHERE status='active' ORDER BY last_activity_at
CREATE INDEX IF NOT EXISTS idx_project_workspaces_active_activity
  ON project_workspaces(last_activity_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_project_workspaces_status
  ON project_workspaces(status);

-- WS4: Workspace-Rollen — Rolle = Template, Workspace = Instanz.
-- Eine Rolle definiert Defaults (image/caps/init_command); sie ist beliebig
-- oft instanziierbar (db-1, db-2, app, qa ...). project NULL = globale Rolle,
-- projekt-scoped Rollen ueberschreiben globale gleichen Namens. init_command
-- laeuft nach jedem Container-Start als User synapse (Dienste hochfahren,
-- z.B. initdb+pg_ctl) — Fehler landen in project_workspaces.last_error.
CREATE TABLE IF NOT EXISTS workspace_roles (
  id            BIGSERIAL PRIMARY KEY,
  project       TEXT,                                -- NULL = globale Rolle
  role          TEXT NOT NULL,
  image         TEXT NOT NULL DEFAULT 'synapse-workspace:latest',
  cpu_limit     REAL NOT NULL DEFAULT 1.0,
  mem_limit_mb  INT  NOT NULL DEFAULT 512,
  pids_limit    INT  NOT NULL DEFAULT 200,
  tmpfs_mb      INT  NOT NULL DEFAULT 256,
  init_command  TEXT,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Eindeutigkeit auch fuer globale Rollen (project NULL): Expression-Index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_roles_scope_role
  ON workspace_roles ((COALESCE(project, '')), role);
-- Instanz merkt sich ihr Herkunfts-Template (informativ + Template-Lookup
-- fuer init_command bei jedem Start; Template-Edits wirken ab naechstem Start).
ALTER TABLE project_workspaces ADD COLUMN IF NOT EXISTS role TEXT;

-- WS5: Privilegierte Rollen-Optionen fuer Container-Builds (rootless Podman).
-- devices: enge Whitelist (/dev/fuse fuer fuse-overlayfs; /dev/kvm spaeter fuer
-- Android/QEMU-KVM; /dev/net/tun fuer VPN-/Netz-Tests). security_opts: feste
-- Whitelist (seccomp=unconfined, apparmor=unconfined, label=disable).
-- NIEMALS --privileged, NIEMALS docker.sock-Mount. Der Orchestrator wendet die
-- Optionen NUR an, wenn die Rolle in ENV SYNAPSE_WS_PRIVILEGED_ROLES
-- (Komma-Liste) allowlisted ist — sonst wird der Start hart verweigert.
ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS devices       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS security_opts TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS cap_add       TEXT[] NOT NULL DEFAULT '{}';

-- WS4-Seed: globale Start-Rollen — NUR Startpunkt, NICHTS ist fest:
-- role_set ueberschreibt/ergaenzt, role_delete entfernt, jede Rolle ist
-- beliebig oft instanziierbar (db-1, db-2, app, qa, ...).
-- ON CONFLICT DO NOTHING: User-Edits an Seed-Rollen gewinnen bei jedem Boot.
INSERT INTO workspace_roles (project, role, image, cpu_limit, mem_limit_mb, tmpfs_mb, init_command, description)
VALUES
  (NULL, 'dev', 'synapse-workspace:latest', 1.0, 512, 256, NULL,
   'Allzweck-Dev-Sandbox (Standard-Image, kein init).'),
  (NULL, 'server', 'synapse-workspace:latest', 1.0, 1024, 256, NULL,
   'Backend-/Service-Instanz — Dienst via exec starten, Ports via expose_ports, DNS synapse-ws-<projekt>-<name>.'),
  (NULL, 'app', 'synapse-workspace:latest', 1.0, 1024, 256, NULL,
   'Client-/App-Instanz — spricht andere Instanzen ueber proxynet-DNS an, wie ein eigenes Geraet im Netz.'),
  (NULL, 'wine-qa', 'synapse-workspace:latest', 1.0, 1024, 1024, NULL,
   'Windows-QA: MinGW-Builds mit wine app.exe testen (Launcher heisst wine, nicht wine64; GUI/SDL headless via xvfb-run; WINEPREFIX im persistenten HOME).'),
  (NULL, 'db-postgres', 'synapse-workspace:latest', 1.0, 1024, 256,
   $wsr1$export PGDATA="$HOME/pgdata"; if [ ! -s "$PGDATA/PG_VERSION" ]; then initdb -D "$PGDATA" -U synapse --auth=trust >/dev/null; { echo "listen_addresses='*'"; echo "unix_socket_directories='/tmp'"; } >> "$PGDATA/postgresql.conf"; echo "host all all 0.0.0.0/0 trust" >> "$PGDATA/pg_hba.conf"; fi; pg_ctl -D "$PGDATA" status >/dev/null 2>&1 || pg_ctl -D "$PGDATA" -l "$HOME/pg.log" -w start$wsr1$,
   'PostgreSQL-15-Instanz: Daten in $HOME/pgdata (reset_home = DB-Reset), trust-Auth im Sandbox-Netz, erreichbar via synapse-ws-<projekt>-<name>:5432; lokal psql -h /tmp.'),
  (NULL, 'db-redis', 'synapse-workspace:latest', 1.0, 512, 256,
   $wsr2$redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 || redis-server --daemonize yes --dir "$HOME" --bind 0.0.0.0 --protected-mode no$wsr2$,
   'Redis-Instanz: Persistenz in $HOME, erreichbar via synapse-ws-<projekt>-<name>:6379 (Sandbox: protected-mode off).')
ON CONFLICT ((COALESCE(project, '')), role) DO NOTHING;

-- WS5-Seed: container-builder — rootless Podman/Buildah (Tier-2-Image, FROM
-- synapse-workspace:latest). Daemonless: kein init_command noetig; Image-Storage
-- (graphroot) liegt im persistenten HOME (reset_home = Registry-Reset).
-- Start wird vom Orchestrator VERWEIGERT solange die Rolle nicht in
-- SYNAPSE_WS_PRIVILEGED_ROLES steht (bewusstes Opt-in pro Deployment).
INSERT INTO workspace_roles (project, role, image, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, init_command, description, devices, security_opts, cap_add)
VALUES
  (NULL, 'container-builder', 'synapse-workspace-podman:latest', 2.0, 2048, 400, 1024, NULL,
   'Container-Builds: docker/podman build, run und compose der User-Projekte testen (docker = podman-Alias, rootless, fuse-overlayfs). Benoetigt ENV SYNAPSE_WS_PRIVILEGED_ROLES=container-builder + Tier-2-Image.',
   ARRAY['/dev/fuse'], ARRAY['seccomp=unconfined','apparmor=unconfined'], ARRAY['SETUID','SETGID'])
ON CONFLICT ((COALESCE(project, '')), role) DO NOTHING;
-- WS5-4: rootless Podman braucht CAP_SETUID/SETGID (newuidmap/newgidmap -> uid_map).
-- Bestands-DBs nachziehen (Seed oben greift wegen ON CONFLICT DO NOTHING nicht).
UPDATE workspace_roles SET cap_add = ARRAY['SETUID','SETGID']
 WHERE project IS NULL AND role = 'container-builder' AND (cap_add IS NULL OR cap_add = '{}');

-- daemon_heartbeats — pro Projekt: laeuft ein lokaler FileWatcher-Daemon?
-- Der lokale Daemon UPSERTed last_seen=NOW() alle 10s pro aktivem Projekt.
-- shell-Tool nutzt die Tabelle fuer Auto-Routing:
--   last_seen > NOW() - 30s  → exec via shell-queue (lokaler Daemon)
--   sonst                    → exec via Workspace-Container (synapse-api)
CREATE TABLE IF NOT EXISTS daemon_heartbeats (
  project TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  daemon_pid INTEGER,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daemon_heartbeats_last_seen
  ON daemon_heartbeats(last_seen DESC);

-- NOTIFY-Trigger fuer code_files Aenderungen → WorkspaceOrchestrator hoert
-- per LISTEN und materialisiert geaenderte Datei in aktive Container.
-- Pattern: "PG ist Source-of-Truth, Container ist live-Mirror der relevanten Files."
-- Behandelt drei Faelle:
--   INSERT mit content                            → action='INSERT' (materialize)
--   UPDATE content/content_hash veraendert        → action='UPDATE' (materialize)
--   UPDATE content NULL OR DELETE row             → action='DELETE' (im Container loeschen)
CREATE OR REPLACE FUNCTION notify_code_file_change() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_code_file_change ON code_files;
CREATE TRIGGER trg_notify_code_file_change
  AFTER INSERT OR UPDATE OR DELETE ON code_files
  FOR EACH ROW EXECUTE FUNCTION notify_code_file_change();

-- ==========================================================================
-- project_ignore_rules (IGN-1): Ignore-Regeln je Projekt in PG statt in der
-- Datei .synapseignore auf der Platte.
--
-- WARUM: Lokaler Daemon und API lasen die Datei bisher jeder fuer sich vom FS.
-- Damit hatte jeder Prozess seine eigene Wahrheit, und ein Umschalten wirkte
-- je nach Prozess zu unterschiedlichen Zeitpunkten. Die Tabelle ist die
-- gemeinsame Quelle, ueber die beide dieselben Regeln sehen.
--
-- SEMANTIK wie bei gitignore:
--   sort_order  bestimmt die Reihenfolge; die spaetere Regel gewinnt.
--   pattern     beginnt mit ! fuer eine Ausnahme von einer breiteren Regel.
--   scope       begrenzt ein Muster auf einen Teilbaum (NULL = ganzes Projekt).
--   enabled     schaltet eine Regel ab, OHNE sie zu verlieren — der Kernzweck.
--   locked      Regeln, die nicht abgeschaltet werden duerfen (node_modules,
--               .git, dist, .env). Schutz davor, dass ein versehentliches
--               Freigeben heruntergeladene Pakete in den Index zieht.
--
-- .gitignore bleibt zusaetzlich aktiv und wird weiter vom FS gelesen, sonst
-- muesste man node_modules/dist doppelt pflegen.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS project_ignore_rules (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  pattern TEXT NOT NULL,
  scope TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  kommentar TEXT,
  sort_order INT NOT NULL DEFAULT 100,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_ignore_rules_eindeutig
  ON project_ignore_rules(project, pattern, COALESCE(scope, ''));
CREATE INDEX IF NOT EXISTS idx_project_ignore_rules_aktiv
  ON project_ignore_rules(project, sort_order) WHERE enabled;

-- IGN-9 (28.07.2026): modus trennt zwei Dinge, die vorher eines waren.
--
--   'gesperrt'      Der Inhalt darf NIE in die Datenbank. Der lokale Daemon
--                   fragt vor dem Senden und schickt gar nicht erst los.
--                   Gilt in BEIDEN Richtungen, also auch fuer PG->FS.
--                   Dafuer da: Secrets, Paketordner, Build-Ausgaben und alles,
--                   was ein kuenftiges Framework mitbringt und wofuer es noch
--                   keine fest einprogrammierte Regel gibt.
--
--   'ausgeblendet'  Nur die SICHTBARKEIT in code_intel ist betroffen, sowohl
--                   die lexikalische als auch die semantische Suche (Embeddings
--                   und Inhalte ueber PG). Zweck ist es, Rauschen aus dem
--                   KI-Kontext zu halten.
--                   ⚠️ Die Datei laeuft trotzdem voellig normal zwischen
--                   Dateisystem und Datenbank hin und her. Ausblenden heisst
--                   NICHT, dass sie verschwindet.
--
-- WARUM DIE TRENNUNG: bis zum 28.07. galt beides als dasselbe. Eine Datei unter
-- einer Ausblend-Regel wurde in PG angelegt, aber nie auf die Platte
-- geschrieben — der Daemon versuchte es nicht einmal. Wer eine Fixture unter
-- __testdata__/ anlegte, bekam ein erfolgreiches ok:true und eine Datei, die es
-- auf der Platte nie gab. Der Hinweistext sprach von "wird aus Suche/Baum
-- ausgeblendet" und liess damit genau den Teil weg, der wehtut.
--
-- MIGRATION: die bisherigen locked-Regeln (node_modules, .git, dist, .env,
-- .mcp.json) werden 'gesperrt', alle uebrigen 'ausgeblendet'. Damit aendert
-- sich fuer den Schutz nichts, waehrend ausgeblendete Pfade ihren Weg auf die
-- Platte zurueckbekommen.
ALTER TABLE project_ignore_rules
  ADD COLUMN IF NOT EXISTS modus TEXT NOT NULL DEFAULT 'ausgeblendet';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'project_ignore_rules' AND constraint_name = 'project_ignore_rules_modus_check'
  ) THEN
    ALTER TABLE project_ignore_rules
      ADD CONSTRAINT project_ignore_rules_modus_check
      CHECK (modus IN ('gesperrt', 'ausgeblendet'));
  END IF;
END $$;

-- Einmalige Migration des Altbestands: locked war bisher der einzige Hinweis
-- darauf, dass eine Regel schuetzen und nicht nur aufraeumen soll.
UPDATE project_ignore_rules SET modus = 'gesperrt' WHERE locked AND modus = 'ausgeblendet';

CREATE INDEX IF NOT EXISTS idx_project_ignore_rules_modus
  ON project_ignore_rules(project, modus) WHERE enabled;

-- IGN-10 (28.07.2026): befristete Einblendung.
--
-- WOFUER: eine KI braucht gelegentlich genau die Datei, die jemand bewusst
-- ausgeblendet hat — weil sie den Kontext zumuellt, aber eben doch die Antwort
-- enthaelt. Sie soll sie sich holen koennen, OHNE die Regel dauerhaft zu
-- kippen und ohne daran denken zu muessen, sie wieder einzuschalten.
-- eingeblendet_bis hebt die Regel bis zu diesem Zeitpunkt auf; danach greift
-- sie von selbst wieder. Ein vergessenes Zuruecksetzen kann es damit nicht
-- geben.
--
-- NULL = keine Befristung, die Regel wirkt normal.
-- Wirkt NUR fuer modus='ausgeblendet'. Eine Sperre laesst sich nicht auf Zeit
-- aufheben: sie haelt Inhalte aus der Datenbank heraus, und was einmal drin
-- ist, ist drin — eine Frist waere dort eine Zusage, die niemand einhalten kann.
ALTER TABLE project_ignore_rules
  ADD COLUMN IF NOT EXISTS eingeblendet_bis TIMESTAMPTZ;
-- Regel-Aenderung sofort an alle Prozesse melden (Daemon, API, Parser-Worker).
-- Ohne diese Benachrichtigung haelt jeder Prozess seinen alten Stand und die
-- Zusage "innerhalb einer Minute sichtbar bzw. unsichtbar" waere nicht haltbar.
CREATE OR REPLACE FUNCTION notify_ignore_rules_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('synapse_ignore_rules', COALESCE(NEW.project, OLD.project));
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- IGN-4: Markierung der ausgeblendeten Dateien. Materialisiert, damit die
-- Lesepfade mit einem simplen "NOT ignored" filtern koennen, statt bei jeder
-- Abfrage saemtliche Muster gegen jeden Pfad zu pruefen. Wird bei jeder
-- Regel-Aenderung neu berechnet (markiereIgnorierteDateien).
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_code_files_sichtbar ON code_files(project, file_path) WHERE NOT ignored;

DROP TRIGGER IF EXISTS trg_notify_ignore_rules ON project_ignore_rules;
CREATE TRIGGER trg_notify_ignore_rules
  AFTER INSERT OR UPDATE OR DELETE ON project_ignore_rules
  FOR EACH ROW EXECUTE FUNCTION notify_ignore_rules_change();

-- ===========================================================================
-- PARSE-COVERAGE: wieviel hat der Parser in einer Datei tatsaechlich erkannt?
--
-- WARUM: Der Index konnte bisher nicht zwischen "in der Datei ist nichts" und
-- "der Parser hat nichts erkannt" unterscheiden. index.html stand mit 100.001
-- Zeilen und 0 Funktionen im Index, ohne dass irgendetwas darauf hinwies.
-- parse_failures erfasst nur Totalausfaelle (Timeout); diese Tabelle erfasst,
-- was INNERHALB erfolgreich geparster Dateien herauskam.
--
-- EIN DATENSATZ JE DATEI, per Upsert bei jedem Parse. Kein Eintrag pro Zeile --
-- bei einer 100.001-Zeilen-Datei waere das die falsche Groessenordnung.
--
-- BEWUSST OHNE SPALTE "auffaellig": ein gespeicherter Schwellwert veraltet
-- still, und genau diese Sorte Fehler soll die Tabelle aufdecken. Die Bewertung
-- entsteht bei jeder Abfrage neu (siehe services/parser-health.ts).
CREATE TABLE IF NOT EXISTS parse_coverage (
  project         TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  file_type       TEXT,
  parser          TEXT,
  parser_version  INTEGER,
  datei_bytes     INTEGER,
  zeilen_gesamt   INTEGER NOT NULL DEFAULT 0,
  belegte_zeilen  INTEGER NOT NULL DEFAULT 0,
  n_symbole       INTEGER NOT NULL DEFAULT 0,
  n_funktionen    INTEGER NOT NULL DEFAULT 0,
  n_klassen       INTEGER NOT NULL DEFAULT 0,
  n_variablen     INTEGER NOT NULL DEFAULT 0,
  n_imports       INTEGER NOT NULL DEFAULT 0,
  n_text_symbole  INTEGER NOT NULL DEFAULT 0,
  n_statements    INTEGER NOT NULL DEFAULT 0,
  n_call_edges    INTEGER NOT NULL DEFAULT 0,
  dauer_ms        INTEGER,
  gemessen_am     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project, file_path)
);
CREATE INDEX IF NOT EXISTS idx_parse_coverage_parser ON parse_coverage(project, parser);

-- Migration: parse_coverage an code_files binden (ON DELETE CASCADE).
--
-- WARUM: diese Tabelle wurde als einzige datei-abgeleitete Tabelle OHNE FK
-- angelegt. code_symbols, code_chunks, code_references, code_statements und
-- code_call_edges haengen alle per FK an code_files und verschwinden mit ihr --
-- parse_coverage blieb stehen. Es gibt drei Stellen, die code_files hart
-- loeschen (watcher/index.ts, mcp-server/tools/init.ts, migrate-to-relative-paths.ts),
-- und keine davon hat parse_coverage mitgeraeumt. Gemessen waren es 3.944
-- Karteileichen: 5.477 Eintraege gegen 1.533 code_files.
--
-- Der Riegel gehoert deshalb hierher und nicht in die Aufrufer. In
-- tools/init.ts stand die Buchfuehrung darueber, welche Tabellen keinen FK
-- haben, sogar als Kommentar im Code -- und war unvollstaendig. Eine Regel,
-- die an drei Stellen gepflegt wird, laeuft auseinander; eine Constraint gilt
-- auch fuer den vierten Loeschweg, den noch niemand geschrieben hat.
--
-- FOLGE FUER DIE ANZEIGE: Eintraege ohne Datei waren fuer parser-health nicht
-- von echten zu unterscheiden (es fragt parse_coverage ohne Join ab) und haben
-- ueber ermittleMedianDichte -- das projektuebergreifend aggregiert -- den
-- Dichte-Massstab ALLER Projekte verzogen.
--
-- DEFERRABLE INITIALLY DEFERRED wie bei den Geschwistern: renameCodeFile
-- schreibt Pfade innerhalb einer Transaktion um und braucht das.
--
-- Das DELETE davor ist Pflicht, nicht Kosmetik: ADD CONSTRAINT validiert die
-- Tabelle und wirft bei jeder Waise -- ensureSchema laeuft bei JEDEM Start und
-- wuerde daran haengenbleiben. Es trifft ausschliesslich Zeilen, zu denen es
-- kein code_files-Gegenstueck mit gleichem project UND file_path gibt; ein
-- Filter auf Projekt oder Parser allein waere hier zu breit.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'parse_coverage'::regclass AND conname = 'parse_coverage_project_file_path_fkey'
  ) THEN
    DELETE FROM parse_coverage pc
     WHERE NOT EXISTS (
       SELECT 1 FROM code_files cf
        WHERE cf.project = pc.project AND cf.file_path = pc.file_path
     );
    ALTER TABLE parse_coverage ADD CONSTRAINT parse_coverage_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;



`;

const AUTH_SCHEMA_SQL = `
-- ==========================================================================
-- PLAN-002: 2FA / Auth — Synapse-System-Tabellen (KEINE Projekt-Daten!).
-- Ersetzen die In-Memory-Maps aus rest-api/src/routes/oauth.ts (persistent).
-- ==========================================================================

-- TOTP-Secret (Single-Row, id=1). Bootstrap optional aus ENV SYNAPSE_TOTP_SECRET.
CREATE TABLE IF NOT EXISTS auth_totp (
  id INTEGER PRIMARY KEY DEFAULT 1,
  secret TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT auth_totp_singleton CHECK (id = 1)
);

-- Registrierte OAuth-Clients (ersetzt In-Memory registeredClients).
CREATE TABLE IF NOT EXISTS auth_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  redirect_uris TEXT[] DEFAULT '{}',
  client_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tokens: access | refresh | authcode | session | service.
-- token_hash = SHA-256 des Klartext-Tokens (Klartext wird NIE gespeichert).
-- parent_token: Refresh->Access bzw. Rotations-Kette. code_challenge/redirect_uri: PKCE-authcode.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT REFERENCES auth_oauth_clients(client_id) ON DELETE CASCADE,
  scope TEXT,
  label TEXT,
  redirect_uri TEXT,
  code_challenge TEXT,
  parent_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_kind_expires ON auth_tokens(kind, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_client ON auth_tokens(client_id);

-- GPU-1: Registry externer Ollama-Compute-Knoten. ollama_url ist reine
-- Information und wird serverseitig niemals abgerufen.
CREATE TABLE IF NOT EXISTS embedding_knoten (
  node_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  ollama_url TEXT NOT NULL,
  modell TEXT NOT NULL,
  modell_digest TEXT NOT NULL CHECK (modell_digest ~ '^[0-9a-f]{64}$'),
  quantisierung TEXT,
  native_dimension INTEGER NOT NULL CHECK (native_dimension > 0),
  ziel_dimension INTEGER NOT NULL CHECK (ziel_dimension > 0),
  num_ctx INTEGER NOT NULL CHECK (num_ctx > 0),
  vram_gesamt_mb INTEGER NOT NULL CHECK (vram_gesamt_mb >= 0),
  vram_frei_mb INTEGER NOT NULL CHECK (vram_frei_mb >= 0),
  system_memory_mb INTEGER,
  cpu_cores INTEGER,
  gpu_name TEXT,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs >= 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','busy','locked','failed')),
  gesperrt_vom_user BOOLEAN NOT NULL DEFAULT FALSE,
  sperrgrund TEXT,
  service_token_hash TEXT NOT NULL UNIQUE REFERENCES auth_tokens(token_hash) ON DELETE CASCADE,
  agent_version TEXT,
  boot_id TEXT NOT NULL,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  boot_started_at TIMESTAMPTZ NOT NULL,
  registriert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  letzter_kontakt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_embedding_knoten_letzter_kontakt
  ON embedding_knoten(letzter_kontakt);

-- API-Bruecke Schritt 4: das Wissen eines Spezialisten in der Datenbank statt als
-- Datei unter .synapse/agents/<name>/. Bildet packages/agents/src/skills.ts ab:
--   meta.yaml -> art='meta' (Inhalt JSON), rules/errors/patterns/context.md ->
--   art='regeln'/'fehler'/'muster'/'kontext', system-prompt.txt -> art='system_prompt'.
-- ZWEI FORMEN, weil der Dateiweg zwei Zugriffsarten kennt und sonst eine davon
-- gefaelscht werden muesste:
--   form='block'   = Ergebnis von writeSkillFile (ein ganzer Text)
--   form='eintrag' = Ergebnis von appendToSkillFile (ein Bullet mit Datum)
-- Die Spalte tag ersetzt die Datums-Kopfzeile "## JJJJ-MM-TT", die im Dateiweg
-- Fliesstext ist und per includes() gesucht wird; als Spalte kann sie nicht mehr
-- versehentlich im Fliesstext getroffen werden.
-- ⚠️ KEIN FREMDSCHLUESSEL, und das ist Absicht: das Wissen eines Agenten muss auch
-- dann existieren koennen, wenn gerade kein Wrapper laeuft. Ein FK auf
-- wrapper_status wuerde das Wissen an die Laufzeit koppeln. Nicht "vergessen".
CREATE TABLE IF NOT EXISTS agent_wissen (
  id              BIGSERIAL PRIMARY KEY,
  project         TEXT NOT NULL,
  agent_name      TEXT NOT NULL,
  art             TEXT NOT NULL CHECK (art IN ('regeln','fehler','muster','kontext','meta','system_prompt')),
  form            TEXT NOT NULL DEFAULT 'eintrag' CHECK (form IN ('block','eintrag')),
  inhalt          TEXT NOT NULL,
  tag             DATE NOT NULL DEFAULT CURRENT_DATE,
  quelle          TEXT,
  erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_wissen_agent
  ON agent_wissen(project, agent_name, art, tag, id);
-- Einmaligkeit gilt NUR fuer den Block, nicht fuer die Eintraege. Dieser Teilindex
-- ist zugleich die Bedingung, die legeAgentWissenAn race-sicher macht
-- (INSERT ... ON CONFLICT (project, agent_name, art) WHERE form='block' DO NOTHING):
-- zwei gleichzeitige Spawns desselben Namens koennen einander das gelernte Wissen
-- damit nicht mehr wegraeumen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_wissen_block
  ON agent_wissen(project, agent_name, art) WHERE form = 'block';
`;

export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(SCHEMA_SQL);
  await pool.query(AUTH_SCHEMA_SQL);
  console.error('[Synapse] PostgreSQL Schema bereit');
}
