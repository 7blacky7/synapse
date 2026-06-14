#!/usr/bin/env bash
# ============================================================================
# SYNAPSE CLI-AGENT (inneres Image) — Claude Code Entrypoint
# ============================================================================
# PLAN-004 / DIND-2 (PREP-ONLY).
#
# Aufgabe (bewusst minimal):
#   1. Self-Update von Claude bei jedem (Neu-)Start (graceful).
#   2. Mit Argumenten -> exec "$@" (spaeter vom externen Wrapper getrieben).
#      Ohne Argumente -> idle (Container bleibt offen fuer exec/Steuerung).
#
# NICHT verdrahtet: keine MCP-Config, keine Auth-Logik, keine Wrapper-Bindung.
# Das kommt in DIND-3 (Auth/claude.ai-Connector) bzw. DIND-5 (Spawn/Steuerung).
# ============================================================================

set -e

log() { printf '[cli-agent:claude] %s\n' "$1"; }

export PATH="/root/.local/bin:${PATH}"

# --- Self-Update (graceful: Fehler brechen den Start NICHT ab) ---
if command -v claude >/dev/null 2>&1; then
    log "Self-Update: 'claude update' ..."
    claude update 2>&1 || log "WARN: 'claude update' fehlgeschlagen -> fahre mit vorhandener Version fort."
else
    log "WARN: 'claude' nicht auf PATH -> nativer Installer erneut ..."
    curl -fsSL https://claude.ai/install.sh | bash || log "WARN: Installer fehlgeschlagen."
fi

log "Aktive Claude-Version: $(claude --version 2>/dev/null || echo 'unbekannt')"

# --- Treiben oder idlen ---
if [ "$#" -gt 0 ]; then
    log "Starte Kommando: $*"
    cd /agent
    exec "$@"
fi

log "Keine Argumente -> idle (prep-only, nicht verdrahtet). Offen fuer exec/Steuerung."
# busybox-/bash-portabel auf Signale reagieren (kein 'sleep infinity').
while true; do
    sleep 3600 &
    wait $!
done
