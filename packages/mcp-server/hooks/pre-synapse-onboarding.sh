#!/usr/bin/env bash
# Synapse Onboarding Hook
# PreToolUse:Read → Koordinator-Regeln
# SubagentStart → Agent-Regeln mit automatischer ID

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

QDRANT_URL="${QDRANT_URL:-http://192.168.50.65:6333}"

# ============================================
# KOORDINATOR (PreToolUse:Read)
# ============================================
if [ "$HOOK_EVENT" != "SubagentStart" ]; then
    # Session-Tracking (einmal pro 30 Min)
    MARKER="/tmp/synapse-onboarding-${PROJECT_NAME}.marker"
    if [ -f "$MARKER" ]; then
        MARKER_AGE=$(( $(date +%s) - $(stat -c %Y "$MARKER" 2>/dev/null || echo 0) ))
        if [ "$MARKER_AGE" -lt 1800 ]; then
            exit 0
        fi
    fi
    touch "$MARKER"

    MSG="Synapse MCP aktiv | Projekt: ${PROJECT_NAME} | Status: ${PROJECT_STATUS}\n"
    MSG+="Du bist der KOORDINATOR. Lade: synapse-nutzung Skill\n"
    MSG+="Session-Start: chat(action: \"register\", id: \"koordinator\", project: \"${PROJECT_NAME}\", model: \"claude-opus-4-6\")\n"
    MSG+="Dann: chat(action: \"get\", project: \"${PROJECT_NAME}\", agent_id: \"koordinator\", limit: 10)\n"
    MSG+="Agenten spawnen: Prompt-Baustein aus synapse-nutzung Skill einbetten\n"
    MSG+="Tools: chat, search, memory, thought, docs, event, project (13 konsolidierte Tools mit action-Parameter)"

    CONTEXT=$(printf '%b' "$MSG")
    jq -nc --arg c "$CONTEXT" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": $c}}'

# ============================================
# AGENT (SubagentStart)
# ============================================
else
    # Agent-ID: Claude Code liefert agent_id im Hook-Input, Fallback auf Timestamp-ID
    CLAUDE_AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
    AGENT_ID="${CLAUDE_AGENT_ID:-agent-$(date +%s | tail -c 6)}"

    MSG="=== SYNAPSE AGENT-ONBOARDING ===\n"
    MSG+="Projekt: ${PROJECT_NAME} | Deine ID: ${AGENT_ID}\n\n"
    MSG+="PFLICHT-SCHRITTE (ALLERERSTE Aktionen):\n"
    MSG+="1. chat(action: \"register\", id: \"${AGENT_ID}\", project: \"${PROJECT_NAME}\")\n"
    MSG+="2. admin(action: \"index_stats\", project: \"${PROJECT_NAME}\", agent_id: \"${AGENT_ID}\")\n"
    MSG+="3. chat(action: \"get\", project: \"${PROJECT_NAME}\", agent_id: \"${AGENT_ID}\", limit: 10)\n\n"
    MSG+="SUCHE: IMMER zuerst search(action: \"code\") / search(action: \"memory\"). Glob/Grep nur Fallback.\n"
    MSG+="CHAT: chat(action: \"send\") fuer Status. DM: recipient_id: \"koordinator\" bei Problemen.\n"
    MSG+="ENDE: chat(action: \"unregister\", id: \"${AGENT_ID}\")\n"
    MSG+="agent_id \"${AGENT_ID}\" an JEDEN Synapse-Aufruf. source \"${AGENT_ID}\" bei thought(action: \"add\").\n"
    MSG+="=== ENDE AGENT-ONBOARDING ===\n"

    ORIGINAL_PROMPT=$(echo "$INPUT" | jq -r '.subagent_prompt // ""')
    UPDATED_PROMPT=$(printf '%b\n\n--- ORIGINAL TASK ---\n\n%s' "$MSG" "$ORIGINAL_PROMPT")
    jq -nc --arg p "$UPDATED_PROMPT" '{"updatedPrompt": $p}'
fi

exit 0
