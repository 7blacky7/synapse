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

# P22-T329: Im Subagent- bzw. Teammate-Kontext traegt der Hook-stdin agent_id (Claude-Code-Doku "Hooks reference", Common input
# fields: agent_id = "Unique identifier for the subagent or in-process teammate the hook fires in"; agent_type allein reicht NICHT,
# er steht auch bei --agent in der Hauptsitzung). Die session_id ist dort DIESELBE wie in der Hauptsitzung, die StatusLine-Datei
# zeigt aber nur den Hauptkontext -> Subagenten lasen bisher den Kontextstand des Koordinators und brachen bei >= 90 % ab.
# Schalter CONTEXT_COUNTER_SUBAGENT (Env): "aus" (Standard) = im Subagent-Kontext sofort ohne Ausgabe und ohne DB-Event beenden
# (den eigenen Kontext eines Subagenten misst die Mod subagent-context-watch); "alt" = bisheriges Verhalten nur zum Debuggen,
# DB-Events dann unter <session_id>:<agent_id>, nie unter der Sitzung des Koordinators.
# Debug: CONTEXT_COUNTER_DEBUG=1 schreibt je Aufruf eine Zeile nach ~/.claude/context-counter-debug.log (nur IDs, keine Inhalte).
AGENT_ID=$(echo "$STDIN" | jq -r '.agent_id // ""' 2>/dev/null | tr -cd 'A-Za-z0-9_.:-')
AGENT_TYPE=$(echo "$STDIN" | jq -r '.agent_type // ""' 2>/dev/null | tr -cd 'A-Za-z0-9_.:-')
SUBAGENT_MODUS="${CONTEXT_COUNTER_SUBAGENT:-aus}"
debug_log() {
  [ "${CONTEXT_COUNTER_DEBUG:-0}" = "1" ] || return 0
  ( printf '%s session=%s agent_id=%s agent_type=%s modus=%s entscheidung=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SESSION_ID:-}" "${AGENT_ID:-}" "${AGENT_TYPE:-}" "$SUBAGENT_MODUS" "$1" \
    >> "${HOME}/.claude/context-counter-debug.log" ) 2>/dev/null
}
if [ -n "$AGENT_ID" ] && [ "$SUBAGENT_MODUS" != "alt" ]; then
  debug_log "subagent_uebersprungen"
  exit 0
fi
# Schluessel der DB-Events: Hauptsitzung = session_id; Subagent (nur Modus alt) = session_id:agent_id.
EVENT_KEY="$SESSION_ID"
if [ -n "$AGENT_ID" ]; then EVENT_KEY="${SESSION_ID}:${AGENT_ID}"; fi

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
    "SELECT COUNT(*) FROM context_events WHERE session_id='${EVENT_KEY}' AND event_type='${event_type}';" \
    2>/dev/null || echo "0")
  [ "${count:-0}" -gt 0 ]
}

# Hilfsfunktion: Event in DB schreiben
record_event() {
  local event_type="$1"
  sqlite3 "$DB_PATH" \
    "INSERT INTO context_events(session_id, wrapper_pid, event_type, pct)
     VALUES('${EVENT_KEY}', '${SESSION_PID}', '${event_type}', ${USED_PCT});" \
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

debug_log "ausgewertet pct=${USED_PCT}"
exit 0
