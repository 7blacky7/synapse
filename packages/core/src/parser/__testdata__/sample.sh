#!/bin/bash
# Synapse deployment script

source ./config.sh
. ./utils.sh

export SYNAPSE_VERSION="1.0.0"
export SYNAPSE_ENV="${SYNAPSE_ENV:-production}"

MAX_RETRIES=3
DEFAULT_PORT=3000
readonly CONFIG_DIR="/etc/synapse"

deploy() {
    local name="$1"
    local version="${2:-latest}"

    echo "Deploying ${name}:${version}..."
    docker pull "synapse/${name}:${version}"
    docker run -d --name "${name}" "synapse/${name}:${version}"
}

check_health() {
    local url="$1"
    local retries=0

    while [[ $retries -lt $MAX_RETRIES ]]; do
        if curl -sf "${url}/health" > /dev/null; then
            return 0
        fi
        retries=$((retries + 1))
        sleep 2
    done
    return 1
}

cleanup_old() {
    docker ps -a --filter "status=exited" -q | xargs -r docker rm
}

start_agent() {
    local agent_name="$1"
    local model="${2:-claude-opus-4-6}"

    if [[ -z "$agent_name" ]]; then
        echo "Error: agent name required" >&2
        return 1
    fi

    deploy "$agent_name" && check_health "http://localhost:${DEFAULT_PORT}"
}

# TODO: add rollback functionality
# FIXME: cleanup_old is too aggressive

main() {
    start_agent "$@"
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && main "$@"
