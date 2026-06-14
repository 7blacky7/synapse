#!/bin/sh
# ============================================================================
# SYNAPSE API - Entrypoint (Docker-in-Docker, feature-gated)
# ============================================================================
# PLAN-004 / DIND-1.
#
# Leitprinzip: ADDITIV + FEATURE-GATED + GRACEFUL.
#
#   SYNAPSE_DIND_ENABLED != "1" (Default):
#       -> KEIN inneres dockerd. Direkt 'exec node ...'.
#       -> Verhalten 100% identisch zum frueheren CMD ["node", ...].
#
#   SYNAPSE_DIND_ENABLED == "1":
#       -> Schreibt /etc/docker/daemon.json (storage-driver=zfs) falls noch
#          nicht vorhanden, startet das offizielle docker:dind
#          'dockerd-entrypoint.sh' im Hintergrund und wartet (busy-wait) bis
#          'docker info' antwortet (max ~30 Versuche).
#       -> Schlaegt der Start fehl: nur WARNEN, NICHT haengen bleiben.
#          Die Node-App startet trotzdem (graceful degradation).
#
# Danach IMMER: exec node packages/rest-api/dist/index.js
# ============================================================================

set -e

APP_CMD_BIN="node"
APP_CMD_ARG="packages/rest-api/dist/index.js"

log() {
    # POSIX-sicheres Logging (kein echo -e, das in /bin/sh nicht portabel ist)
    printf '[synapse-entrypoint] %s\n' "$1"
}

# ----------------------------------------------------------------------------
# Default-Pfad: KEIN DinD -> bestehendes Verhalten unveraendert.
# ----------------------------------------------------------------------------
if [ "${SYNAPSE_DIND_ENABLED}" != "1" ]; then
    log "SYNAPSE_DIND_ENABLED!=1 -> DinD deaktiviert. Starte direkt die Node-App."
    cd /app
    exec "${APP_CMD_BIN}" "${APP_CMD_ARG}"
fi

# ----------------------------------------------------------------------------
# DinD aktiviert: inneres dockerd vorbereiten + starten.
# ----------------------------------------------------------------------------
log "SYNAPSE_DIND_ENABLED=1 -> bereite inneres dockerd vor (storage-driver=zfs)."

# Storage-Driver via daemon.json setzen (nur wenn noch keine vorhanden ist,
# damit ein per Volume eingehaengtes daemon.json Vorrang behaelt).
DOCKER_DATA_ROOT="${SYNAPSE_DIND_DATA_ROOT:-/var/lib/docker}"
if [ ! -f /etc/docker/daemon.json ]; then
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<EOF
{
  "storage-driver": "${SYNAPSE_DIND_STORAGE_DRIVER:-zfs}",
  "data-root": "${DOCKER_DATA_ROOT}"
}
EOF
    log "daemon.json geschrieben (storage-driver=${SYNAPSE_DIND_STORAGE_DRIVER:-zfs}, data-root=${DOCKER_DATA_ROOT})."
else
    log "Bestehende /etc/docker/daemon.json gefunden -> wird respektiert."
fi

# Offizielles docker:dind-Entrypoint im Hintergrund starten.
# dockerd-entrypoint.sh liest /etc/docker/daemon.json und reicht zusaetzlich
# $DOCKERD_ARGS an dockerd weiter.
log "Starte dockerd-entrypoint.sh im Hintergrund ..."
dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

# Busy-wait bis 'docker info' erfolgreich ist (max ~30s).
RETRIES=0
MAX_RETRIES=30
DIND_READY=0
while [ "${RETRIES}" -lt "${MAX_RETRIES}" ]; do
    if docker info >/dev/null 2>&1; then
        DIND_READY=1
        break
    fi
    # Falls dockerd inzwischen gestorben ist -> nicht weiter pollen.
    if ! kill -0 "${DOCKERD_PID}" 2>/dev/null; then
        log "WARN: dockerd-Prozess (PID ${DOCKERD_PID}) ist nicht mehr aktiv."
        break
    fi
    RETRIES=$((RETRIES + 1))
    sleep 1
done

if [ "${DIND_READY}" = "1" ]; then
    log "OK: inneres dockerd ist bereit (nach ${RETRIES}s)."
else
    # GRACEFUL: nicht abbrechen. Die Node-App startet trotzdem.
    log "WARN: inneres dockerd wurde nach ${MAX_RETRIES}s nicht bereit."
    log "WARN: fahre OHNE DinD fort (graceful). Letzte dockerd-Logs:"
    tail -n 20 /var/log/dockerd.log 2>/dev/null || true
fi

# ----------------------------------------------------------------------------
# IMMER: Node-App starten (exec ersetzt die Shell -> PID 1 Signale gehen an node).
# ----------------------------------------------------------------------------
log "Starte Node-App: ${APP_CMD_BIN} ${APP_CMD_ARG}"
cd /app
exec "${APP_CMD_BIN}" "${APP_CMD_ARG}"
