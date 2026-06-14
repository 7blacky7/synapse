#!/usr/bin/env bash
# ============================================================================
# SYNAPSE CLI-AGENT — Antigravity / Gemini CLI Entrypoint (Host-Docker)
# ============================================================================
# PLAN-004 / DIND-2.
#   1. Gemini-CLI self-updaten (npm i -g @google/gemini-cli@latest, graceful —
#      Fehler brechen den Container NICHT ab).
#   2. Danach IDLE: der Container bleibt offen; die Wrapper-Logik in der
#      synapse-api treibt die CLI via
#      'docker exec -i ... gemini -p ... --output-format stream-json' (DIND-5).
#
# Persistent by design: KEIN idle-stop. Stoppen = explizit ueber den
# Orchestrator/WebUI (docker stop).
# ============================================================================

set -e

log() { printf '[cli-agent:antigravity] %s\n' "$1"; }

export GEMINI_HOME="${GEMINI_HOME:-/root/.gemini}"

# --- Gemini-CLI bereitstellen / aktualisieren (graceful) ---
if command -v gemini >/dev/null 2>&1; then
    log "Gemini-CLI vorhanden -> npm Self-Update (graceful) ..."
    npm install -g @google/gemini-cli@latest >/tmp/gemini-update.log 2>&1 \
        || log "WARN: Gemini-CLI-Update fehlgeschlagen -> behalte vorhandene Version."
else
    log "Gemini-CLI fehlt -> npm-Installation ..."
    npm install -g @google/gemini-cli >/tmp/gemini-install.log 2>&1 \
        || log "WARN: Gemini-CLI-Installation fehlgeschlagen (Log: /tmp/gemini-install.log)."
fi

log "Aktive Gemini-Version: $(gemini --version 2>/dev/null || echo 'unbekannt')"

# --- Auth-Hinweis (DIND-3, hier nicht automatisiert) ---
# Interaktiv einmalig (Web-Terminal, DIND-4): 'gemini' -> 'Login with Google'
# (Browser-OAuth). Persistiert in ${GEMINI_HOME}/oauth_creds.json (Volume,
# auto-refresh) und ueberlebt Neustarts. Headless-Alternative: ENV GEMINI_API_KEY
# oder Vertex (GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT/LOCATION).

# --- Persistent idlen (auf Signale reagieren, kein 'sleep infinity') ---
log "IDLE — bereit fuer 'docker exec' vom Wrapper in der synapse-api."
while true; do
    sleep 3600 &
    wait $!
done
