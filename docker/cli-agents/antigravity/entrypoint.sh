#!/usr/bin/env bash
# ============================================================================
# SYNAPSE CLI-AGENT — Antigravity CLI ('agy') Entrypoint (Host-Docker)
# ============================================================================
# PLAN-004 / DIND-2.
#   1. agy bereitstellen / self-updaten (nativer Installer, graceful — Fehler
#      brechen den Container NICHT ab).
#   2. Danach IDLE: der Container bleibt offen; die Wrapper-Logik in der
#      synapse-api treibt agy via
#      'docker exec -i ... agy -p ... --dangerously-skip-permissions' (DIND-5).
#
# WICHTIG: 'agy' == Google Antigravity CLI (NICHT Gemini CLI). Siehe Dockerfile.
# Persistent by design: KEIN idle-stop. Stoppen = explizit (docker stop).
# ============================================================================

set -e

log() { printf '[cli-agent:antigravity] %s\n' "$1"; }

export PATH="/root/.local/bin:${PATH}"

# --- agy bereitstellen / aktualisieren (graceful) ---
if command -v agy >/dev/null 2>&1; then
    log "agy vorhanden -> Installer-Self-Update (graceful) ..."
    if curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 \
            https://antigravity.google/cli/install.sh -o /tmp/install-agy.sh; then
        bash /tmp/install-agy.sh --skip-path >/tmp/agy-update.log 2>&1 \
            || log "WARN: agy-Update fehlgeschlagen -> behalte vorhandene Version."
        rm -f /tmp/install-agy.sh
    else
        log "WARN: Download des agy-Installers fehlgeschlagen -> behalte vorhandene Version."
    fi
else
    log "agy fehlt -> nativer Installer auf das Volume ..."
    if curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 \
            https://antigravity.google/cli/install.sh -o /tmp/install-agy.sh; then
        bash /tmp/install-agy.sh --skip-path >/tmp/agy-install.log 2>&1 \
            || log "WARN: agy-Installer fehlgeschlagen (Log: /tmp/agy-install.log)."
        rm -f /tmp/install-agy.sh
    else
        log "WARN: Download des agy-Installers fehlgeschlagen -> fahre fort (graceful)."
    fi
fi

log "Aktive agy-Version: $(agy --version 2>/dev/null || echo 'unbekannt')"

# --- Auth-Hinweis (DIND-3, hier NICHT automatisiert) ---
# agy laeuft auf der Pro-/Ultra-Quota (KEIN API-Key; der Wrapper ENTFERNT
# GEMINI_API_KEY aus dem agy-env). Auth-Persistenz ueber OS-Keyring:
#   - Local silent keyring: agy nutzt Linux Secret Service (dbus). Store unter
#     /root/.local/share/keyrings (vom /root/.local-Volume gedeckt).
#   - Headless/Remote-Erstlogin (Web-Terminal, DIND-4): 'agy' starten -> CLI
#     erkennt Remote -> druckt Auth-URL -> im lokalen Browser einloggen ->
#     alphanumerischen Code zurueck ins Terminal paste. '/logout' purged Keyring.
# TODO(DIND-3): Im Headless-Container ist Secret Service nicht garantiert
# verfuegbar -> dbus + gnome-keyring bootstrappen/entsperren ODER File-Fallback
# klaeren. Empirisch verifizieren.

# --- Persistent idlen (auf Signale reagieren, kein 'sleep infinity') ---
log "IDLE — bereit fuer 'docker exec' vom Wrapper in der synapse-api."
while true; do
    sleep 3600 &
    wait $!
done
