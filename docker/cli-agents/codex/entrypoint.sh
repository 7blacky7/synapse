#!/usr/bin/env bash
# ============================================================================
# SYNAPSE CLI-AGENT — OpenAI Codex CLI Entrypoint (Host-Docker)
# ============================================================================
# PLAN-004 / DIND-2.
#   1. Codex auf die persistenten Volumes installieren bzw. self-updaten
#      (graceful — Fehler brechen den Container NICHT ab).
#   2. Danach IDLE: der Container bleibt offen; die Wrapper-Logik in der
#      synapse-api treibt Codex via 'docker exec -i ... codex ...' (DIND-5).
#
# Persistent by design: KEIN idle-stop. Stoppen = explizit ueber den
# Orchestrator/WebUI (docker stop).
# ============================================================================

set -e

log() { printf '[cli-agent:codex] %s\n' "$1"; }

export PATH="/root/.local/bin:${PATH}"
export CODEX_HOME="${CODEX_HOME:-/root/.codex}"

# --- Codex bereitstellen / aktualisieren (graceful) ---
if command -v codex >/dev/null 2>&1; then
    log "Codex vorhanden -> Self-Update (graceful) ..."
    # Codex bringt (je nach Version) ein eigenes Update-Kommando mit; faellt das
    # weg, wird der native Installer erneut ausgefuehrt (idempotent).
    if codex --help 2>/dev/null | grep -qiw 'update'; then
        codex update >/tmp/codex-update.log 2>&1 \
            || log "WARN: 'codex update' fehlgeschlagen -> behalte vorhandene Version."
    else
        log "Kein 'codex update' -> nativer Installer (graceful) ..."
        curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 \
            https://chatgpt.com/codex/install.sh | sh >/tmp/codex-install.log 2>&1 \
            || log "WARN: Codex-Self-Reinstall fehlgeschlagen -> behalte vorhandene Version."
    fi
else
    log "Codex fehlt -> nativer Installer auf das Volume ..."
    if curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 \
            https://chatgpt.com/codex/install.sh -o /tmp/install-codex.sh; then
        sh /tmp/install-codex.sh >/tmp/codex-install.log 2>&1 \
            || log "WARN: Codex-Installer fehlgeschlagen (Log: /tmp/codex-install.log)."
        rm -f /tmp/install-codex.sh
    else
        log "WARN: Download des Codex-Installers fehlgeschlagen -> fahre fort (graceful)."
    fi
fi

log "Aktive Codex-Version: $(codex --version 2>/dev/null || echo 'unbekannt')"

# --- Auth-Hinweis (DIND-3, hier nicht automatisiert) ---
# Interaktiv einmalig (Web-Terminal, DIND-4): 'codex login --device-auth'.
# Persistiert in ${CODEX_HOME}/auth.json (Volume) und ueberlebt Neustarts.
# Alternativ ENV OPENAI_API_KEY oder vorbefuellte auth.json auf dem Volume.

# --- Persistent idlen (auf Signale reagieren, kein 'sleep infinity') ---
log "IDLE — bereit fuer 'docker exec' vom Wrapper in der synapse-api."
while true; do
    sleep 3600 &
    wait $!
done
