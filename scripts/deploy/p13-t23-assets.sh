#!/usr/bin/env bash
set -euo pipefail

pflicht() {
  local name="$1"
  if ! declare -p "$name" >/dev/null 2>&1 || [[ -z "${!name}" ]]; then
    printf 'FEHLER: Deploy-Variable %s fehlt\n' "$name" >&2
    exit 2
  fi
}

for name in \
  SYNAPSE_PROJEKTE_DATASET SYNAPSE_REVERSE_DATASET \
  SYNAPSE_PROJEKTE_HOST_PATH SYNAPSE_REVERSE_HOST_PATH \
  SYNAPSE_PROJEKTE_ROOT SYNAPSE_REVERSE_ROOT \
  SYNAPSE_REVERSE_USERQUOTA; do
  pflicht "$name"
done

for name in SYNAPSE_PROJEKTE_HOST_PATH SYNAPSE_REVERSE_HOST_PATH SYNAPSE_PROJEKTE_ROOT SYNAPSE_REVERSE_ROOT; do
  value="${!name}"
  if [[ "$value" != /* || "$value" == *:* || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf 'FEHLER: %s muss ein absoluter, Docker-tauglicher Pfad ohne Doppelpunkt/Zeilenumbruch sein\n' "$name" >&2
    exit 2
  fi
done

dataset_exists() {
  local dataset="$1"
  if [[ "${P13_T23_DRY_RUN:-0}" == 1 && -n "${P13_T23_TEST_EXISTING_DATASETS+x}" ]]; then
    case ",${P13_T23_TEST_EXISTING_DATASETS}," in
      *,"${dataset}",*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  zfs list -H -o name "$dataset" >/dev/null 2>&1
}

ensure_dataset() {
  local dataset="$1"
  if dataset_exists "$dataset"; then
    printf 'Dataset bereits vorhanden: %s\n' "$dataset"
  elif [[ "${P13_T23_DRY_RUN:-0}" == 1 ]]; then
    printf 'DRY-RUN: zfs create -o compression=zstd %s\n' "$dataset"
  else
    zfs create -o compression=zstd "$dataset"
    printf 'Dataset angelegt (compression=zstd): %s\n' "$dataset"
  fi
}

case "${1:-}" in
  prepare)
    dry_run="${2:-}"
    if [[ "$dry_run" == --dry-run ]]; then
      export P13_T23_DRY_RUN=1
    elif [[ -n "$dry_run" ]]; then
      printf 'Aufruf: %s prepare [--dry-run] | verify [--dry-run]\n' "$0" >&2
      exit 2
    fi

    ensure_dataset "$SYNAPSE_PROJEKTE_DATASET"
    ensure_dataset "$SYNAPSE_REVERSE_DATASET"
    if [[ "${P13_T23_DRY_RUN:-0}" == 1 ]]; then
      printf 'DRY-RUN: zfs set userquota@65532=%s %s\n' "$SYNAPSE_REVERSE_USERQUOTA" "$SYNAPSE_REVERSE_DATASET"
    else
      zfs set "userquota@65532=$SYNAPSE_REVERSE_USERQUOTA" "$SYNAPSE_REVERSE_DATASET"
    fi
    printf 'API-Mount: %s:%s\n' "$SYNAPSE_PROJEKTE_HOST_PATH" "$SYNAPSE_PROJEKTE_ROOT"
    printf 'API-Mount: %s:%s\n' "$SYNAPSE_REVERSE_HOST_PATH" "$SYNAPSE_REVERSE_ROOT"
    ;;
  verify)
    dry_run="${2:-}"
    if [[ "$dry_run" == --dry-run || "${P13_T23_DRY_RUN:-0}" == 1 ]]; then
      printf 'DRY-RUN: docker exec synapse-api prüft SYNAPSE_PROJEKTE_ROOT und SYNAPSE_REVERSE_ROOT auf Existenz/Schreibbarkeit\n'
    elif [[ -n "$dry_run" ]]; then
      printf 'Aufruf: %s prepare [--dry-run] | verify [--dry-run]\n' "$0" >&2
      exit 2
    else
      docker exec synapse-api sh -eu -c '
        for root do
          test -d "$root"
          test -w "$root"
          probe="$root/.synapse-deploy-write-probe.$$"
          : > "$probe"
          rm -f "$probe"
        done
      ' sh "$SYNAPSE_PROJEKTE_ROOT" "$SYNAPSE_REVERSE_ROOT"
    fi
    ;;
  *)
    printf 'Aufruf: %s prepare [--dry-run] | verify [--dry-run]\n' "$0" >&2
    exit 2
    ;;
esac
