#!/usr/bin/env bash
# ============================================================================
# SYNAPSE CLI-AGENT — Claude Code Entrypoint (Host-Docker)
# ============================================================================
# PLAN-004 / DIND-2.
#   1. Claude auf die persistenten Volumes installieren bzw. self-updaten
#      (graceful — Fehler brechen den Container NICHT ab).
#   2. Danach IDLE: der Container bleibt offen; die Wrapper-Logik in der
#      synapse-api treibt Claude via 'docker exec -i ... claude --print
#      --output-format stream-json ...' (DIND-5b, Option b).
#
# Persistent by design: KEIN idle-stop. Stoppen = explizit ueber den
# Orchestrator/WebUI (docker stop).
# ============================================================================

set -e

log() { printf '[cli-agent:claude] %s\n' "$1"; }

export PATH="/root/.local/bin:${PATH}"
export USE_BUILTIN_RIPGREP=0

# --- Claude bereitstellen / aktualisieren (graceful) ---
if command -v claude >/dev/null 2>&1; then
    log "Claude vorhanden -> 'claude update' (graceful) ..."
    claude update >/tmp/claude-update.log 2>&1 \
        || log "WARN: 'claude update' fehlgeschlagen -> behalte vorhandene Version."
else
    log "Claude fehlt -> nativer Installer auf das Volume ..."
    if curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 \
            https://claude.ai/install.sh -o /tmp/install-claude.sh; then
        bash /tmp/install-claude.sh >/tmp/claude-install.log 2>&1 \
            || log "WARN: Claude-Installer fehlgeschlagen (Log: /tmp/claude-install.log)."
        rm -f /tmp/install-claude.sh
    else
        log "WARN: Download des Claude-Installers fehlgeschlagen -> fahre fort (graceful)."
    fi
fi

log "Aktive Claude-Version: $(claude --version 2>/dev/null || echo 'unbekannt')"

# --- Persistent idlen (auf Signale reagieren, kein 'sleep infinity') ---
log "IDLE — bereit fuer 'docker exec' vom Wrapper in der synapse-api."
while true; do
    sleep 3600 &
    wait $!
done
