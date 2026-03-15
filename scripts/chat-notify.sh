#!/usr/bin/env bash
# chat-notify.sh — PostToolUse Hook: Zeigt ungelesene Chat-Nachrichten
#
# Nutzt chat-check.mjs fuer PostgreSQL-Query.
# Throttled auf 30s. Aktualisiert Timestamp bei get_chat_messages.
#
# Installation (Claude Code settings.json → hooks.PostToolUse):
#   { "type": "command", "command": "bash ~/dev/synapse/scripts/chat-notify.sh" }

set -euo pipefail

AGENT_ID="${SYNAPSE_AGENT_ID:-koordinator}"
PROJECT="${SYNAPSE_PROJECT:-synapse}"
CHECK_INTERVAL="${SYNAPSE_CHAT_INTERVAL:-30}"
DB_URL="${SYNAPSE_DB_URL:-postgresql://synapse:***@192.168.50.65:5432/synapse}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

LASTSEEN_FILE="/tmp/synapse-chat-lastseen-${AGENT_ID}"
LASTCHECK_FILE="/tmp/synapse-chat-lastcheck-${AGENT_ID}"

# stdin → Tool-Name
INPUT=$(cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).tool_name||''}catch{''}" 2>/dev/null || echo "")

# get_chat_messages → gelesen markieren
if [[ "$TOOL_NAME" == *"get_chat_messages"* ]]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LASTSEEN_FILE"
  exit 0
fi

# Throttling
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

# DB-Query
RESULT=$(node "$SCRIPT_DIR/chat-check.mjs" "$AGENT_ID" "$PROJECT" "$SINCE" "$DB_URL" 2>/dev/null) || exit 0

IFS='|' read -r BROADCASTS DMS DM_SENDERS <<< "$RESULT"
BROADCASTS=${BROADCASTS:-0}
DMS=${DMS:-0}

[[ "$BROADCASTS" -eq 0 && "$DMS" -eq 0 ]] && exit 0

PARTS=()
[[ "$BROADCASTS" -gt 0 ]] && PARTS+=("${BROADCASTS} Broadcasts")
[[ "$DMS" -gt 0 ]] && PARTS+=("${DMS} DMs${DM_SENDERS:+ von ${DM_SENDERS}}")

echo "📨 Chat: $(IFS=', '; echo "${PARTS[*]}") ungelesen"
