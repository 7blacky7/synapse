#!/usr/bin/env bash
# context-counter.sh — PostToolUse Hook: Warnt basierend auf echtem Context-Window-Verbrauch
#
# Liest context_window.used_percentage aus /tmp/.claude-context-pct-<key>
# (geschrieben von statusline-command.sh bei jedem Render).
#
# WICHTIG: PostToolUse Hooks bekommen KEINE context_window Daten im stdin-JSON!
# Deshalb nutzen wir die StatusLine als Bruecke.
#
# Schwellenwerte:
#   90% — HANDOFF-EVENT: In SQLite DB tracken (session-spezifisch, nur 1x), starke Warnung
#   95% — Kritische Warnung
#   98% — SOFORTIGER HANDOFF

set +e  # Hooks muessen fehlertolerant sein

# stdin lesen (Pflicht fuer Hooks)
STDIN=$(cat)
SESSION_ID=$(echo "$STDIN" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# Context-Prozentsatz aus session-spezifischer StatusLine-Datei lesen
PCT_KEY="${SESSION_ID:-${CLAUDE_WRAPPER_PID:-default}}"
PCT_FILE="/tmp/.claude-context-pct-${PCT_KEY}"
if [ ! -f "$PCT_FILE" ]; then exit 0; fi

USED_PCT=$(cat "$PCT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$USED_PCT" ] || [ "$USED_PCT" = "0" ]; then exit 0; fi

HANDOFF_PCT=90
WARN_PCT="${CONTEXT_WARN_PERCENT:-95}"
CRIT_PCT="${CONTEXT_CRIT_PERCENT:-98}"

# SQLite DB fuer session-spezifisches Event-Tracking
DB_PATH="${HOME}/.claude/context-events.db"
SESSION_PID="${CLAUDE_WRAPPER_PID:-}"

# DB initialisieren (idempotent)
sqlite3 "$DB_PATH" "
  CREATE TABLE IF NOT EXISTS context_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    wrapper_pid TEXT,
    event_type TEXT NOT NULL,
    pct INTEGER NOT NULL,
    triggered_at DATETIME DEFAULT (datetime('now')),
    handoff_started INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_session_event ON context_events(session_id, event_type);
" 2>/dev/null

# Hilfsfunktion: Hat diese Session bereits ein Event dieses Typs?
event_already_fired() {
  local event_type="$1"
  local count
  count=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM context_events WHERE session_id='${SESSION_ID}' AND event_type='${event_type}';" \
    2>/dev/null || echo "0")
  [ "${count:-0}" -gt 0 ]
}

# Hilfsfunktion: Event in DB schreiben
record_event() {
  local event_type="$1"
  sqlite3 "$DB_PATH" \
    "INSERT INTO context_events(session_id, wrapper_pid, event_type, pct)
     VALUES('${SESSION_ID}', '${SESSION_PID}', '${event_type}', ${USED_PCT});" \
    2>/dev/null
}

# Agenten-Check fuer Warnungen
AGENT_INFO=""
if [ -n "$SESSION_PID" ]; then
  REGISTRY_DIR="/tmp/.claude-agents-${SESSION_PID}"
  if [ -d "$REGISTRY_DIR" ] && [ -n "$(ls "$REGISTRY_DIR/" 2>/dev/null)" ]; then
    AGENT_COUNT=$(ls "$REGISTRY_DIR/" | wc -l)
    AGENT_INFO=" | ACHTUNG: ${AGENT_COUNT} Agenten noch aktiv — erst warten, DANN Handoff!"
  fi
fi

# ── 98%+ KRITISCH ─────────────────────────────────────────────────────────────
if [ "$USED_PCT" -ge "$CRIT_PCT" ] 2>/dev/null; then
  if ! event_already_fired "crit_98"; then
    record_event "crit_98"
  fi
  jq -n \
    --arg ctx "CONTEXT-LIMIT KRITISCH (${USED_PCT}%) — SOFORTIGER HANDOFF! 1) Schritt abschliessen+commit 2) Agenten abwarten 3) add_thought+write_memory 4) context-handoff.sh aufrufen${AGENT_INFO}" \
    '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'

# ── 95%+ WARNUNG ──────────────────────────────────────────────────────────────
elif [ "$USED_PCT" -ge "$WARN_PCT" ] 2>/dev/null; then
  if ! event_already_fired "warn_95"; then
    record_event "warn_95"
  fi
  jq -n \
    --arg ctx "CONTEXT-WARNUNG (${USED_PCT}%): Plane den Session-Handoff. Keine neuen grossen Tasks.${AGENT_INFO}" \
    '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'

# ── 90% HANDOFF-EVENT (nur 1x pro Session) ───────────────────────────────────
elif [ "$USED_PCT" -ge "$HANDOFF_PCT" ] 2>/dev/null; then
  if ! event_already_fired "handoff_90"; then
    record_event "handoff_90"
    # Handoff-Event feuern: starke einmalige Warnung
    SOCKET_PATH="/tmp/cc-inject-${SESSION_PID}.sock"
    jq -n \
      --arg ctx "🔶 CONTEXT 90% ERREICHT (Session: ${SESSION_ID}) — Handoff vorbereiten! Jetzt: 1) Laufende Arbeit committen 2) Synapse: add_thought mit aktuellem Stand 3) Warte auf Agenten (${AGENT_INFO:-keine aktiv}) 4) context-handoff.sh aufrufen. Socket fuer cc-send: ${SOCKET_PATH}" \
      '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
  fi
  # Nach dem ersten Event: stille Wiederholungen unterdrücken (kein Output)
fi

exit 0
