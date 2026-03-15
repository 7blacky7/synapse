#!/usr/bin/env bash
# synapse-chat.sh — Nachricht an den Synapse-Chat senden
#
# Nutzung:
#   synapse-chat "Nachricht an alle"
#   synapse-chat "DM an agent" koordinator
#   synapse-chat "Nachricht" koordinator user
#
# Args:
#   $1 — Nachrichteninhalt
#   $2 — Empfaenger (optional, leer = Broadcast)
#   $3 — Absender (optional, Standard: user)

set -euo pipefail

CONTENT="${1:?Nachricht fehlt. Nutzung: synapse-chat \"Nachricht\" [empfaenger] [absender]}"
RECIPIENT="${2:-}"
SENDER="${3:-user}"
PROJECT="${SYNAPSE_PROJECT:-synapse}"
DB_URL="${SYNAPSE_DB_URL:-postgresql://synapse:***@192.168.50.65:5432/synapse}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Insert via node + pg
node "$SCRIPT_DIR/chat-send.mjs" "$PROJECT" "$SENDER" "$CONTENT" "$RECIPIENT" "$DB_URL"
