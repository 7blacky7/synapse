#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/p13-t23-assets.sh"
export SYNAPSE_PROJEKTE_DATASET="z/synapse-projekte"
export SYNAPSE_REVERSE_DATASET="z/synapse-reverse"
export SYNAPSE_PROJEKTE_HOST_PATH="/mnt/z/synapse-projekte"
export SYNAPSE_REVERSE_HOST_PATH="/mnt/z/synapse-reverse"
export SYNAPSE_PROJEKTE_ROOT="/srv/synapse/projekte"
export SYNAPSE_REVERSE_ROOT="/srv/synapse/reverse"
export SYNAPSE_REVERSE_USERQUOTA="8G"

erstlauf="$(P13_T23_TEST_EXISTING_DATASETS="" bash "$script" prepare --dry-run)"
grep -Fq "DRY-RUN: zfs create -o compression=zstd z/synapse-projekte" <<<"$erstlauf"
grep -Fq "DRY-RUN: zfs create -o compression=zstd z/synapse-reverse" <<<"$erstlauf"
grep -Fq "userquota@65532=8G" <<<"$erstlauf"
grep -Fq "/mnt/z/synapse-projekte:/srv/synapse/projekte" <<<"$erstlauf"
grep -Fq "/mnt/z/synapse-reverse:/srv/synapse/reverse" <<<"$erstlauf"
! grep -Fq "/mnt/user" <<<"$erstlauf"

zweitlauf="$(P13_T23_TEST_EXISTING_DATASETS="z/synapse-projekte,z/synapse-reverse" bash "$script" prepare --dry-run)"
grep -Fq "Dataset bereits vorhanden: z/synapse-projekte" <<<"$zweitlauf"
grep -Fq "Dataset bereits vorhanden: z/synapse-reverse" <<<"$zweitlauf"
! grep -Fq "zfs create" <<<"$zweitlauf"

verify="$(bash "$script" verify --dry-run)"
grep -Fq 'docker exec synapse-api' <<<"$verify"
grep -Fq 'SYNAPSE_PROJEKTE_ROOT' <<<"$verify"
grep -Fq 'SYNAPSE_REVERSE_ROOT' <<<"$verify"

printf 'P13-T23 dry-run: zweimal idempotent, Quota, direkte Mounts und Container-Verify OK\n'
