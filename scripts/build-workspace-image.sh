#!/bin/bash
# build-workspace-image.sh — baut synapse-workspace:latest lokal,
# optional Push zu Unraid via docker save | ssh docker load (ohne Registry).
#
# Nutzung:
#   ./scripts/build-workspace-image.sh                  # nur lokal bauen
#   ./scripts/build-workspace-image.sh --push-unraid    # bauen + auf Unraid laden
#
# Voraussetzung fuer --push-unraid: SSHPASS in env oder SSH-Key fuer root@192.168.50.65.

set -euo pipefail

IMAGE="${WORKSPACE_IMAGE:-synapse-workspace:latest}"
UNRAID_HOST="${UNRAID_HOST:-192.168.50.65}"
UNRAID_USER="${UNRAID_USER:-root}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTEXT="$REPO_ROOT/docker/synapse-workspace"

echo "==> Build $IMAGE aus $CONTEXT"
docker build -t "$IMAGE" "$CONTEXT"

SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)
echo "==> Fertig. Image-Groesse: $((SIZE / 1024 / 1024)) MB"

if [[ "${1:-}" == "--push-unraid" ]]; then
  echo "==> Stream zu $UNRAID_USER@$UNRAID_HOST (docker save | ssh docker load)…"
  if command -v sshpass >/dev/null && [[ -n "${SSHPASS:-}" ]]; then
    docker save "$IMAGE" | sshpass -e ssh -o StrictHostKeyChecking=no "$UNRAID_USER@$UNRAID_HOST" docker load
  else
    docker save "$IMAGE" | ssh "$UNRAID_USER@$UNRAID_HOST" docker load
  fi
  echo "==> Auf Unraid verfuegbar:"
  if command -v sshpass >/dev/null && [[ -n "${SSHPASS:-}" ]]; then
    sshpass -e ssh -o StrictHostKeyChecking=no "$UNRAID_USER@$UNRAID_HOST" "docker images $IMAGE"
  else
    ssh "$UNRAID_USER@$UNRAID_HOST" "docker images $IMAGE"
  fi
fi
