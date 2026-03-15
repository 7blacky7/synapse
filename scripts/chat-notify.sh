#!/usr/bin/env bash
# chat-notify.sh — PostToolUse Hook: Zeigt ungelesene Chat-Nachrichten
#
# Erkennt automatisch den aktiven Agenten:
# - Bei Synapse-Tool-Calls: agent_id aus tool_input extrahieren
# - Sonst: letzte bekannte agent_id aus /tmp/synapse-current-agent
#
# Installation (Claude Code settings.json → hooks.PostToolUse):
#   { "type": "command", "command": "bash ~/dev/synapse/scripts/chat-notify.sh" }

set -euo pipefail

PROJECT="${SYNAPSE_PROJECT:-synapse}"
CHECK_INTERVAL="${SYNAPSE_CHAT_INTERVAL:-15}"
DB_URL="${SYNAPSE_DB_URL:-postgresql://synapse:synapse2026@192.168.50.65:5432/synapse}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CURRENT_AGENT_FILE="/tmp/synapse-current-agent"

# stdin → Tool-Name + agent_id extrahieren
INPUT=$(cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | node -p "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.tool_name||'');process.exit()}catch{}" 2>/dev/null || echo "")

# agent_id aus tool_input extrahieren (wenn Synapse MCP-Tool)
TOOL_AGENT=$(echo "$INPUT" | node -p "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const i=d.tool_input||{};console.log(i.agent_id||i.sender_id||i.id||'');process.exit()}catch{}" 2>/dev/null || echo "")

# Agent-ID bestimmen: aus Tool-Input, oder letzte bekannte, oder Default
if [[ -n "$TOOL_AGENT" ]]; then
  AGENT_ID="$TOOL_AGENT"
  echo "$AGENT_ID" > "$CURRENT_AGENT_FILE"
elif [[ -f "$CURRENT_AGENT_FILE" ]]; then
  AGENT_ID=$(cat "$CURRENT_AGENT_FILE")
else
  AGENT_ID="${SYNAPSE_AGENT_ID:-koordinator}"
fi

LASTSEEN_FILE="/tmp/synapse-chat-lastseen-${AGENT_ID}"
LASTCHECK_FILE="/tmp/synapse-chat-lastcheck-${AGENT_ID}"

# get_chat_messages → gelesen markieren
if [[ "$TOOL_NAME" == *"get_chat_messages"* ]]; then
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

# DB-Query
RESULT=$(node "$SCRIPT_DIR/chat-check.mjs" "$AGENT_ID" "$PROJECT" "$SINCE" "$DB_URL" 2>/dev/null) || exit 0

IFS='|' read -r BROADCASTS DMS DM_SENDERS <<< "$RESULT"
BROADCASTS=${BROADCASTS:-0}
DMS=${DMS:-0}

[[ "$BROADCASTS" -eq 0 && "$DMS" -eq 0 ]] && exit 0

PARTS=()
[[ "$BROADCASTS" -gt 0 ]] && PARTS+=("${BROADCASTS} Broadcasts")
[[ "$DMS" -gt 0 ]] && PARTS+=("${DMS} DMs${DM_SENDERS:+ von ${DM_SENDERS}}")

MSG="📨 Chat (${AGENT_ID}): $(IFS=', '; echo "${PARTS[*]}") ungelesen"

jq -n --arg ctx "$MSG" '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
