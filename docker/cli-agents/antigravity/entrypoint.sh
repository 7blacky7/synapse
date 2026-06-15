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
        # Der Shell-Installer kennt nur -d/--dir (kein --skip-path -> Usage+Exit1).
        bash /tmp/install-agy.sh >/tmp/agy-update.log 2>&1 \
            || log "WARN: agy-Update fehlgeschlagen -> behalte vorhandene Version."
        rm -f /tmp/install-agy.sh
    else
        log "WARN: Download des agy-Installers fehlgeschlagen -> behalte vorhandene Version."
    fi
else
    log "agy fehlt -> nativer Installer auf das Volume ..."
    if curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 \
            https://antigravity.google/cli/install.sh -o /tmp/install-agy.sh; then
        # Der Shell-Installer kennt nur -d/--dir (kein --skip-path -> Usage+Exit1).
        bash /tmp/install-agy.sh >/tmp/agy-install.log 2>&1 \
            || log "WARN: agy-Installer fehlgeschlagen (Log: /tmp/agy-install.log)."
        rm -f /tmp/install-agy.sh
    else
        log "WARN: Download des agy-Installers fehlgeschlagen -> fahre fort (graceful)."
    fi
fi

log "Aktive agy-Version: $(agy --version 2>/dev/null || echo 'unbekannt')"

# --- Auth-Hinweis (DIND-3, hier NICHT automatisiert) ---
# agy laeuft auf der Pro-/Ultra-Quota (KEIN API-Key; der Wrapper ENTFERNT
# GEMINI_API_KEY aus dem agy-env).
#
# AUTH-PER-LINK (empirisch verifiziert dind-verifier 2026-06-15, headless
# Container ohne TTY/Browser): agy hat KEIN 'login'/'auth'-Subcommand. Beim
# ersten beliebigen Aufruf (z.B. 'agy --print ...') erkennt es fehlende Auth und
# druckt:
#     Authentication required. Please visit the URL to log in:
#       https://accounts.google.com/o/oauth2/auth?...redirect_uri=
#         https%3A%2F%2Fantigravity.google%2Foauth-callback...
#     Waiting for authentication (timeout 30s)...
#     Or, paste the authorization code here and press Enter:
# => Genau der gewuenschte Link-/Device-Flow: URL im lokalen Browser oeffnen,
#    Google-Login, den Auth-Code zurueck ins Container-stdin pasten (Web-Terminal
#    DIND-4). Das Timeout (30s) ggf. mit laengerem print-timeout abfedern.
#
# PERSISTENZ (empirisch): agy speichert KEINEN OS-Keyring. Sein gesamter State
# inkl. der OAuth-Credentials liegt FILE-BASIERT unter /root/.gemini
# (Unterordner antigravity-cli/ + config/). /root/.antigravity bleibt leer.
# Daher MUSS /root/.gemini als Volume persistiert werden (siehe Dockerfile),
# damit die Auth Neustarts/Updates ueberlebt. '/logout' in der CLI purged sie.

# --- Persistent idlen (auf Signale reagieren, kein 'sleep infinity') ---
log "IDLE — bereit fuer 'docker exec' vom Wrapper in der synapse-api."
while true; do
    sleep 3600 &
    wait $!
done
