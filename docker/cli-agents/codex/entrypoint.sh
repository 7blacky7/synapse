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
        log "Kein 'codex update' -> npm-Update (graceful) ..."
        npm install -g @openai/codex@latest >/tmp/codex-install.log 2>&1 \
            || log "WARN: Codex-Self-Update (npm) fehlgeschlagen -> behalte vorhandene Version."
    fi
else
    log "Codex fehlt -> npm-Install (graceful) ..."
    npm install -g @openai/codex@latest >/tmp/codex-install.log 2>&1 \
        || log "WARN: Codex-npm-Install fehlgeschlagen (Log: /tmp/codex-install.log) -> fahre fort (graceful)."
fi

log "Aktive Codex-Version: $(codex --version 2>/dev/null || echo 'unbekannt')"

# --- Credential-Store: im Container explizit file (kein OS-Keyring vorhanden) ---
mkdir -p "${CODEX_HOME}"
if ! grep -q 'cli_auth_credentials_store' "${CODEX_HOME}/config.toml" 2>/dev/null; then
    printf 'cli_auth_credentials_store = "file"\n' >> "${CODEX_HOME}/config.toml"
    log "config.toml: cli_auth_credentials_store=file gesetzt."
fi

# --- Auto-Login mit API-Key (DIND-3): ENV gesetzt + noch keine auth.json ---
# WICHTIG: das alte '--api-key'-Flag wurde entfernt; aktueller Weg ist stdin.
if [ -n "${OPENAI_API_KEY:-}" ] && [ ! -f "${CODEX_HOME}/auth.json" ]; then
    log "OPENAI_API_KEY vorhanden + keine auth.json -> codex login --with-api-key ..."
    printf '%s' "${OPENAI_API_KEY}" | codex login --with-api-key >/tmp/codex-login.log 2>&1 \
        && log "API-Key-Login OK (auth.json auf Volume)." \
        || log "WARN: API-Key-Login fehlgeschlagen (Log: /tmp/codex-login.log)."
fi

# --- Auth-Hinweis (DIND-3, Abo-Weg) ---
# Abo statt API-Key: einmalig 'codex login --device-auth' (URL + Einmal-Code,
# WebUI zeigt beides an; Device-Code-Login muss in den ChatGPT-Security-
# Settings aktiviert sein). Persistiert in ${CODEX_HOME}/auth.json (Volume).
# Fallback: lokal eingeloggte auth.json aufs Volume kopieren (nicht host-gebunden).

# --- Persistent idlen (auf Signale reagieren, kein 'sleep infinity') ---
log "IDLE — bereit fuer 'docker exec' vom Wrapper in der synapse-api."
while true; do
    sleep 3600 &
    wait $!
done
