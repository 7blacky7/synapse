#!/usr/bin/env bash
# chat-notify.sh — PostToolUse Hook: Zeigt ungelesene Chat-Nachrichten
#
# Erkennt automatisch den aktiven Agenten:
# - Primaer: agent_id / session_id aus Claude Code Hook-Input
# - Fallback: agent_id aus Synapse MCP-Tool tool_input
#
# Installation (Claude Code settings.json → hooks.PostToolUse):
#   { "type": "command", "command": "bash ~/dev/synapse/scripts/chat-notify.sh" }

set +e  # Hooks muessen fehlertolerant sein

# stdin ZUERST lesen (Pflicht — Claude Code erwartet dass stdin konsumiert wird)
INPUT=$(cat 2>/dev/null || echo '{}')

PROJECT="${SYNAPSE_PROJECT:-synapse}"
CHECK_INTERVAL="${SYNAPSE_CHAT_INTERVAL:-15}"
DB_URL="${SYNAPSE_DB_URL:-}"
if [[ -z "$DB_URL" ]]; then exit 0; fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Tool-Name extrahieren
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

# Agent-ID bestimmen: direkt aus Hook-Input (Claude Code liefert agent_id/session_id)
HOOK_AGENT=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || echo "")
HOOK_SESSION=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")
# Fallback: agent_id aus tool_input (Synapse MCP-Tool)
TOOL_AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent_id // .tool_input.sender_id // .tool_input.id // empty' 2>/dev/null || echo "")

if [[ -n "$TOOL_AGENT" ]]; then
  AGENT_ID="$TOOL_AGENT"
elif [[ -n "$HOOK_AGENT" ]]; then
  AGENT_ID="$HOOK_AGENT"
else
  # Default: koordinator (session_id ist eine UUID, nicht als Agent-ID brauchbar)
  AGENT_ID="${SYNAPSE_AGENT_ID:-koordinator}"
fi

LASTSEEN_FILE="/tmp/synapse-chat-lastseen-${AGENT_ID}"
LASTCHECK_FILE="/tmp/synapse-chat-lastcheck-${AGENT_ID}"

# chat(action: "get") → gelesen markieren
# Konsolidierte Tools: mcp__synapse__chat mit action "get"
TOOL_ACTION=$(echo "$INPUT" | jq -r '.tool_input.action // empty' 2>/dev/null || echo "")
if [[ "$TOOL_NAME" == *"chat"* && "$TOOL_ACTION" == "get" ]] || [[ "$TOOL_NAME" == *"get_chat_messages"* ]]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LASTSEEN_FILE"
  exit 0
fi

# Throttling (pro Agent separat)
if [[ -f "$LASTCHECK_FILE" ]]; then
  last_check=$(cat "$LASTCHECK_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  if (( now - last_check < CHECK_INTERVAL )); then
    exit 0
  fi
fi
date +%s > "$LASTCHECK_FILE"

# Last-Seen
if [[ ! -f "$LASTSEEN_FILE" ]]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LASTSEEN_FILE"
  exit 0
fi
SINCE=$(cat "$LASTSEEN_FILE")

# === EVENT-CHECK (VOR Chat) ===
EVENT_RESULT=$(node "$SCRIPT_DIR/event-check.mjs" "$AGENT_ID" "$PROJECT" "$DB_URL" 2>/dev/null) || EVENT_RESULT="[]"

# Events parsen und ausgeben
EVENT_COUNT=$(echo "$EVENT_RESULT" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).length" 2>/dev/null || echo "0")

EVENT_MSG=""
if [[ "$EVENT_COUNT" -gt 0 ]]; then
  # Event-Details formatieren
  EVENT_MSG=$(echo "$EVENT_RESULT" | node -p "
    const events = JSON.parse(require('fs').readFileSync(0,'utf8'));
    events.map(e => {
      const prefix = e.priority === 'critical' ? '⛔ PFLICHT' : '⚠️';
      return prefix + ' EVENT ' + e.event_type + ' (' + e.priority + ') von ' + e.source_id + ': ' + (e.payload || 'Keine Details') + '. Reagiere mit: event(action: \"ack\", event_id: ' + e.id + ')';
    }).join('\\n');
  " 2>/dev/null || echo "")
fi

# DB-Query (Chat)
RESULT=$(node "$SCRIPT_DIR/chat-check.mjs" "$AGENT_ID" "$PROJECT" "$SINCE" "$DB_URL" 2>/dev/null) || RESULT="0|0|"

IFS='|' read -r BROADCASTS DMS DM_SENDERS <<< "$RESULT"
BROADCASTS=${BROADCASTS:-0}
DMS=${DMS:-0}

CHAT_MSG=""
if [[ "$BROADCASTS" -gt 0 || "$DMS" -gt 0 ]]; then
  PARTS=()
  [[ "$BROADCASTS" -gt 0 ]] && PARTS+=("${BROADCASTS} Broadcasts")
  [[ "$DMS" -gt 0 ]] && PARTS+=("${DMS} DMs${DM_SENDERS:+ von ${DM_SENDERS}}")
  CHAT_MSG="📨 Chat (${AGENT_ID}): $(IFS=', '; echo "${PARTS[*]}") ungelesen"
fi

# Ausgabe: Events VOR Chat, nur wenn mindestens eine Meldung vorhanden
[[ -z "$EVENT_MSG" && -z "$CHAT_MSG" ]] && exit 0

FULL_MSG=""
if [[ -n "$EVENT_MSG" && -n "$CHAT_MSG" ]]; then
  FULL_MSG="${EVENT_MSG}
${CHAT_MSG}"
elif [[ -n "$EVENT_MSG" ]]; then
  FULL_MSG="$EVENT_MSG"
else
  FULL_MSG="$CHAT_MSG"
fi

jq -n --arg ctx "$FULL_MSG" '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
