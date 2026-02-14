#!/usr/bin/env bash
# Synapse Agent Onboarding Hook (Linux)
# Handles: PreToolUse:Read (Hauptagent) + SubagentStart (Subagenten)
# PreToolUse → additionalContext (einmal pro Session)
# SubagentStart → updatedPrompt (jeder Subagent)

set -euo pipefail

# stdin lesen
INPUT=$(cat)
if [ -z "$INPUT" ]; then exit 0; fi

# JSON parsen (jq erforderlich)
if ! command -v jq &>/dev/null; then exit 0; fi

HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
if [ -z "$HOOK_EVENT" ]; then exit 0; fi

# ============================================
# Dateipfad / Projektverzeichnis ermitteln
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
# Projekt-Root mit .synapse/status.json finden
# ============================================
find_synapse_project() {
    local dir="$1"
    # Falls Datei, nimm das Verzeichnis
    if [ -f "$dir" ]; then
        dir=$(dirname "$dir")
    fi
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
# Session-Tracking (NUR fuer PreToolUse, NICHT fuer Subagenten)
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
# Bekannte Agenten
# ============================================
KNOWN_AGENTS=$(jq -r '(.knownAgents // []) | join(", ")' "$STATUS_FILE")

# ============================================
# Letzte Thoughts aus Qdrant
# ============================================
get_recent_thoughts() {
    local body='{"limit":5,"filter":{"must":[{"key":"project","match":{"value":"'"$PROJECT_NAME"'"}}]},"with_payload":true}'
    curl -s --max-time 3 \
        -X POST "http://192.168.50.65:6334/collections/project_thoughts/points/scroll" \
        -H "Content-Type: application/json" \
        -d "$body" 2>/dev/null || echo '{}'
}

THOUGHTS_JSON=$(get_recent_thoughts)
THOUGHTS_COUNT=$(echo "$THOUGHTS_JSON" | jq '.result.points | length // 0' 2>/dev/null || echo 0)

# ============================================
# Onboarding-Message generieren
# ============================================
MSG="Dieses Projekt nutzt Synapse MCP fuer Agent-Koordination.\n"
MSG+="Projekt: ${PROJECT_NAME} | Status: ${PROJECT_STATUS}\n"

if [ -n "$KNOWN_AGENTS" ]; then
    MSG+="Aktive Agenten: ${KNOWN_AGENTS}\n"
fi

if [ "$THOUGHTS_COUNT" -gt 0 ]; then
    MSG+="Letzte Erkenntnisse im Projekt:\n"
    for i in $(seq 0 $((THOUGHTS_COUNT - 1))); do
        SRC=$(echo "$THOUGHTS_JSON" | jq -r ".result.points[$i].payload.source // \"?\"")
        CNT=$(echo "$THOUGHTS_JSON" | jq -r ".result.points[$i].payload.content // \"\"" | head -c 80)
        TAGS=$(echo "$THOUGHTS_JSON" | jq -r "(.result.points[$i].payload.tags // []) | join(\",\")")
        MSG+="  ${SRC} - ${CNT} (${TAGS})\n"
    done
fi

MSG+="Synapse-Tools: mcp__synapse__read_memory (project:\"${PROJECT_NAME}\" name:\"projekt-regeln\" agent_id:\"dein-name\"), mcp__synapse__search_thoughts, mcp__synapse__add_thought"

# ============================================
# Output je nach Event-Typ
# ============================================
if [ "$HOOK_EVENT" = "SubagentStart" ]; then
    ORIGINAL_PROMPT=$(echo "$INPUT" | jq -r '.subagent_prompt // ""')
    UPDATED_PROMPT=$(printf '%b\n\n--- ORIGINAL TASK ---\n\n%s' "$MSG" "$ORIGINAL_PROMPT")
    jq -nc --arg p "$UPDATED_PROMPT" '{"updatedPrompt": $p}'
else
    CONTEXT=$(printf '%b' "$MSG")
    jq -nc --arg c "$CONTEXT" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": $c}}'
fi

exit 0
