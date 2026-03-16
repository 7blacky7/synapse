#!/usr/bin/env bash
# coordinator-watch.sh — Polling-Daemon der den Koordinator weckt
# Laeuft im Hintergrund, checkt alle 10s auf neue DMs/Events
# Gibt Output und beendet sich wenn was da ist → task-notification weckt Koordinator
#
# PID-Management: Ein Watcher pro Projekt, PID in /tmp/synapse-watch-{projekt}.pid
# Multi-Projekt: Jedes Projekt hat seinen eigenen Watcher

set -euo pipefail

PROJECT="${1:-synapse}"
AGENT_ID="${2:-koordinator}"
INTERVAL="${3:-10}"
DB_URL="${SYNAPSE_DB_URL:-postgresql://synapse:***@192.168.50.65:5432/synapse}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LASTSEEN_FILE="/tmp/synapse-chat-lastseen-${AGENT_ID}"
PID_FILE="/tmp/synapse-watch-${PROJECT}.pid"

# Pruefen ob bereits ein Watcher fuer dieses Projekt laeuft
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[coordinator-watch] Watcher fuer ${PROJECT} laeuft bereits (PID: ${OLD_PID})" >&2
    exit 0
  fi
  # PID-File existiert aber Prozess ist tot → aufraeumen
  rm -f "$PID_FILE"
fi

# PID schreiben + Cleanup bei Exit
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

# Initiales Lastseen setzen falls nicht vorhanden
if [[ ! -f "$LASTSEEN_FILE" ]]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LASTSEEN_FILE"
fi

echo "[coordinator-watch] Starte Polling (alle ${INTERVAL}s) fuer ${AGENT_ID}@${PROJECT} (PID: $$)" >&2

while true; do
  sleep "$INTERVAL"

  # Events checken
  EVENTS=$(node "$SCRIPT_DIR/event-check.mjs" "$AGENT_ID" "$PROJECT" "$DB_URL" 2>/dev/null) || EVENTS="[]"
  EVENT_COUNT=$(echo "$EVENTS" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).length" 2>/dev/null || echo "0")

  # Chat checken
  SINCE=$(cat "$LASTSEEN_FILE" 2>/dev/null || echo "2000-01-01T00:00:00Z")
  CHAT=$(node "$SCRIPT_DIR/chat-check.mjs" "$AGENT_ID" "$PROJECT" "$SINCE" "$DB_URL" 2>/dev/null) || CHAT="0|0|"
  IFS='|' read -r BROADCASTS DMS DM_SENDERS <<< "$CHAT"
  BROADCASTS=${BROADCASTS:-0}
  DMS=${DMS:-0}

  # Wenn was da ist → Output und Exit (weckt Koordinator via task-notification)
  if [[ "$EVENT_COUNT" -gt 0 ]] || [[ "$BROADCASTS" -gt 0 ]] || [[ "$DMS" -gt 0 ]]; then
    PARTS=()
    if [[ "$EVENT_COUNT" -gt 0 ]]; then
      EVENT_DETAILS=$(echo "$EVENTS" | node -p "
        JSON.parse(require('fs').readFileSync(0,'utf8'))
          .map(e => e.event_type + '(' + e.priority + ') von ' + e.source_id + ': ' + (e.payload || '-'))
          .join(', ')
      " 2>/dev/null || echo "Events vorhanden")
      PARTS+=("⛔ ${EVENT_COUNT} Event(s): ${EVENT_DETAILS}")
    fi
    if [[ "$BROADCASTS" -gt 0 ]]; then
      PARTS+=("📢 ${BROADCASTS} Broadcasts")
    fi
    if [[ "$DMS" -gt 0 ]]; then
      PARTS+=("💬 ${DMS} DMs${DM_SENDERS:+ von ${DM_SENDERS}}")
    fi

    echo "🔔 KOORDINATOR AUFWACHEN! [${PROJECT}]"
    printf '%s\n' "${PARTS[@]}"
    echo ""
    echo "→ get_chat_messages + get_pending_events aufrufen!"
    echo "→ Danach Watcher neu starten: bash ~/dev/synapse/scripts/coordinator-watch.sh ${PROJECT} ${AGENT_ID} ${INTERVAL}"
    exit 0
  fi
done
