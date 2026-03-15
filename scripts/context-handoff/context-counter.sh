#!/usr/bin/env bash
# context-counter.sh — PostToolUse Hook: Warnt basierend auf echtem Context-Window-Verbrauch
#
# PROTOTYP — Experimentelles Feature, API kann sich aendern
#
# Liest context_window.used_percentage aus /tmp/.claude-context-pct
# (geschrieben von der StatusLine bei jedem Render).
#
# WICHTIG: PostToolUse Hooks bekommen KEINE context_window Daten im stdin-JSON!
# Deshalb nutzen wir die StatusLine als Bruecke.
#
# Konfiguration via Umgebungsvariablen (optional):
#   CONTEXT_WARN_PERCENT  — GELB-Warnung ab diesem Prozent (Standard: 60)
#   CONTEXT_CRIT_PERCENT  — ROT-Warnung ab diesem Prozent (Standard: 80)
#
# Installation (Claude Code settings.json):
#   "hooks": {
#     "PostToolUse": [{
#       "hooks": [{
#         "type": "command",
#         "command": "/pfad/zu/synapse/scripts/context-handoff/context-counter.sh"
#       }]
#     }]
#   }

set -euo pipefail

# stdin konsumieren (Pflicht fuer Hooks, auch wenn wir es nicht brauchen)
cat > /dev/null

# Context-Prozentsatz aus StatusLine-Datei lesen
PCT_FILE="/tmp/.claude-context-pct"
if [ ! -f "$PCT_FILE" ]; then exit 0; fi

USED_PCT=$(cat "$PCT_FILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$USED_PCT" ] || [ "$USED_PCT" = "0" ]; then exit 0; fi

WARN_PCT="${CONTEXT_WARN_PERCENT:-95}"
CRIT_PCT="${CONTEXT_CRIT_PERCENT:-98}"

if [ "$USED_PCT" -ge "$CRIT_PCT" ] 2>/dev/null; then
  jq -n \
    --arg ctx "CONTEXT-LIMIT KRITISCH (${USED_PCT}% verbraucht) — SOFORTIGER HANDOFF NOETIG! 1) Aktuellen Schritt sauber abschliessen (commit!) 2) Session-Handoff ausfuehren: add_thought + write_memory 3) KEINE neuen Tasks!" \
    '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'

elif [ "$USED_PCT" -ge "$WARN_PCT" ] 2>/dev/null; then
  jq -n \
    --arg ctx "CONTEXT-WARNUNG (${USED_PCT}% verbraucht): Plane den Session-Handoff nach dem aktuellen Task. Keine neuen grossen Tasks starten." \
    '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
fi

exit 0
