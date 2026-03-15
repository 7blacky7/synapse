#!/usr/bin/env bash
# Synapse Agent Onboarding Hook (Linux)
# Handles: PreToolUse:Read (Koordinator) + SubagentStart (Subagenten)
# PreToolUse → additionalContext (Koordinator-Regeln)
# SubagentStart → updatedPrompt (Agent-Regeln)

set -euo pipefail

INPUT=$(cat)
if [ -z "$INPUT" ]; then exit 0; fi
if ! command -v jq &>/dev/null; then exit 0; fi

HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
if [ -z "$HOOK_EVENT" ]; then exit 0; fi

# ============================================
# Projektverzeichnis ermitteln
# ============================================
START_PATH=""
if [ "$HOOK_EVENT" = "SubagentStart" ]; then
    START_PATH=$(echo "$INPUT" | jq -r '.cwd // empty')
    if [ -z "$START_PATH" ]; then
        START_PATH="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    fi
else
    START_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
fi
if [ -z "$START_PATH" ]; then exit 0; fi

# ============================================
# Projekt-Root finden
# ============================================
find_synapse_project() {
    local dir="$1"
    if [ -f "$dir" ]; then dir=$(dirname "$dir"); fi
    while [ "$dir" != "/" ] && [ -n "$dir" ]; do
        if [ -f "$dir/.synapse/status.json" ]; then
            echo "$dir"
            return 0
        fi
        dir=$(dirname "$dir")
    done
    return 1
}

PROJECT_ROOT=$(find_synapse_project "$START_PATH") || exit 0
STATUS_FILE="$PROJECT_ROOT/.synapse/status.json"
if [ ! -f "$STATUS_FILE" ]; then exit 0; fi

PROJECT_NAME=$(jq -r '.project // empty' "$STATUS_FILE")
PROJECT_STATUS=$(jq -r '.status // "unknown"' "$STATUS_FILE")
if [ -z "$PROJECT_NAME" ]; then exit 0; fi

# ============================================
# Session-Tracking (NUR fuer Koordinator, nicht Subagenten)
# ============================================
if [ "$HOOK_EVENT" != "SubagentStart" ]; then
    MARKER="/tmp/synapse-onboarding-${PROJECT_NAME}.marker"
    if [ -f "$MARKER" ]; then
        MARKER_AGE=$(( $(date +%s) - $(stat -c %Y "$MARKER" 2>/dev/null || echo 0) ))
        if [ "$MARKER_AGE" -lt 1800 ]; then
            exit 0
        fi
    fi
    touch "$MARKER"
fi

# ============================================
# Qdrant URL (aus Env oder Default)
# ============================================
QDRANT_URL="${QDRANT_URL:-http://192.168.50.65:6333}"

# ============================================
# Letzte Thoughts aus Per-Projekt Collection
# ============================================
get_recent_thoughts() {
    local collection="project_${PROJECT_NAME}_thoughts"
    local body='{"limit":5,"filter":{"must":[{"key":"project","match":{"value":"'"$PROJECT_NAME"'"}}]},"with_payload":true}'
    curl -s --max-time 3 \
        -X POST "${QDRANT_URL}/collections/${collection}/points/scroll" \
        -H "Content-Type: application/json" \
        -d "$body" 2>/dev/null || echo '{}'
}

THOUGHTS_JSON=$(get_recent_thoughts)
THOUGHTS_COUNT=$(echo "$THOUGHTS_JSON" | jq '.result.points | length // 0' 2>/dev/null || echo 0)

# ============================================
# Output: KOORDINATOR (PreToolUse)
# ============================================
if [ "$HOOK_EVENT" != "SubagentStart" ]; then
    MSG="Synapse MCP aktiv | Projekt: ${PROJECT_NAME} | Status: ${PROJECT_STATUS}\n"
    MSG+="Lade: synapse-nutzung Skill (Koordinator-Regeln)\n"
    MSG+="Session-Start: register_chat_agent(id:\"koordinator\" project:\"${PROJECT_NAME}\")\n"

    if [ "$THOUGHTS_COUNT" -gt 0 ]; then
        MSG+="Letzte Erkenntnisse:\n"
        for i in $(seq 0 $((THOUGHTS_COUNT - 1))); do
            SRC=$(echo "$THOUGHTS_JSON" | jq -r ".result.points[$i].payload.source // \"?\"")
            CNT=$(echo "$THOUGHTS_JSON" | jq -r ".result.points[$i].payload.content // \"\"" | head -c 80)
            MSG+="  ${SRC}: ${CNT}...\n"
        done
    fi

    MSG+="Tools: register_chat_agent, send_chat_message, get_chat_messages, search_tech_docs, get_docs_for_file"

    CONTEXT=$(printf '%b' "$MSG")
    jq -nc --arg c "$CONTEXT" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": $c}}'

# ============================================
# Output: AGENT (SubagentStart)
# ============================================
else
    MSG="=== SYNAPSE AGENT-REGELN ===\n"
    MSG+="Projekt: ${PROJECT_NAME}\n"
    MSG+="SCHRITT 1: register_chat_agent(id:\"<deine-id>\" project:\"${PROJECT_NAME}\")\n"
    MSG+="SCHRITT 2: get_index_stats(project:\"${PROJECT_NAME}\" agent_id:\"<deine-id>\")\n"
    MSG+="SCHRITT 3: get_chat_messages(project:\"${PROJECT_NAME}\" agent_id:\"<deine-id>\" limit:10)\n"
    MSG+="SUCHE: IMMER zuerst semantic_code_search / search_memory, Glob/Grep nur als Fallback\n"
    MSG+="CHAT: send_chat_message fuer Status, DM an \"koordinator\" bei Problemen\n"
    MSG+="ENDE: unregister_chat_agent(id:\"<deine-id>\")\n"
    MSG+="=== ENDE AGENT-REGELN ===\n"

    ORIGINAL_PROMPT=$(echo "$INPUT" | jq -r '.subagent_prompt // ""')
    UPDATED_PROMPT=$(printf '%b\n\n--- ORIGINAL TASK ---\n\n%s' "$MSG" "$ORIGINAL_PROMPT")
    jq -nc --arg p "$UPDATED_PROMPT" '{"updatedPrompt": $p}'
fi

exit 0
