# ============================================================================
# SYNAPSE CLI-AGENT — OpenAI Codex CLI
# ============================================================================
# PLAN-004 / DIND-2 (Image-Geruest, analog docker/cli-agents/claude/).
#
# Dieses Image wird vom CliAgentOrchestrator (packages/rest-api/src/services/
# cli-agent-orchestrator.ts) als persistenter Container auf dem HOST-Docker via
# docker.sock gestartet. Es enthaelt AUSSCHLIESSLICH die Codex-CLI — KEIN
# Wrapper, KEIN synapse-node-Runtime. Der Synapse-Wrapper (packages/agents)
# laeuft AUSSERHALB im synapse-api-Container und treibt diesen Container via
# 'docker exec -i <container> codex ...' (DIND-5).
#
# Codex-Installation: npm '@openai/codex' (node-Base). Der native Installer
# (chatgpt.com/codex/install.sh) ist Stand 2026-06-15 upstream DEFEKT: er
# resolved v0.139.0, bricht aber ab mit 'Could not find SHA-256 digest for
# codex-package-x86_64-unknown-linux-musl.tar.gz in codex-package_SHA256SUMS'
# (Exit 1 -> Build-Abbruch). Daher der vom Header dokumentierte npm-Fallback,
# empirisch verifiziert (dind-verifier 2026-06-15): codex-cli 0.139.0, exit 0,
# Binary /usr/local/bin/codex. node-Base statt debian-slim noetig fuer npm.
#
# Self-Update: der Entrypoint aktualisiert Codex bei jedem (Neu-)Start (graceful).
# Persistenz: ~/.codex (auth.json — ChatGPT-/API-Auth) + ~/.local (Binary +
# Update-Stand) ueber Volumes einhaengen, damit Auth + Update Neustarts
# ueberleben. CODEX_HOME zeigt explizit auf ~/.codex.
#
# Auth-Flow (DIND-3, hier NICHT verdrahtet): 'codex login --device-auth'
# (Device-Code, TTY-frei) ODER vorbefuellte ~/.codex/auth.json auf dem Volume
# ODER ENV OPENAI_API_KEY. Einmaliger interaktiver Schritt via Web-Terminal (DIND-4).
# ============================================================================

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal-Abhaengigkeiten: TLS (ca-certificates), git (CLI-Workflows),
# curl/bash (Diagnose/Self-Update). node+npm bringt das Base-Image mit.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/*

# Codex via npm (globaler Install -> /usr/local/bin/codex). Baked-in beim Build;
# der Entrypoint aktualisiert beim Start (npm i -g @openai/codex@latest, idempotent).
RUN npm install -g @openai/codex

# npm-globals liegen in /usr/local/bin (im PATH); ~/.local/bin zusaetzlich, falls
# spaetere Self-Updates dorthin schreiben.
ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"
# Credentials-Verzeichnis explizit fixieren (default ~/.codex) -> persistentes Volume.
ENV CODEX_HOME="/root/.codex"

WORKDIR /agent

COPY entrypoint.sh /usr/local/bin/cli-agent-entrypoint.sh
RUN chmod +x /usr/local/bin/cli-agent-entrypoint.sh

# Credentials/Update-Stand persistent ueber Volume einhaengen.
VOLUME ["/root/.codex"]

# Kein EXPOSE/HEALTHCHECK: kein Server. Wird vom externen Wrapper getrieben.
ENTRYPOINT ["/usr/local/bin/cli-agent-entrypoint.sh"]
