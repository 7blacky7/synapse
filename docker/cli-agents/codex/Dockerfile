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
# Codex wird ueber den NATIVEN Installer installiert (standalone Binary nach
# ~/.local/bin). Native Binary => glibc-Base (debian), NICHT alpine/musl.
# (Alternativ npm '@openai/codex' — hier bewusst der native Installer, wie claude.)
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

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal-Abhaengigkeiten: Installer (curl/bash), TLS (ca-certificates),
# git (einige CLI-Workflows nutzen es).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/*

# Nativer Codex-Installer (kein npm, kein Node). Baked-in beim Build; der
# Entrypoint holt beim Start das jeweils neueste Update.
# TODO(DIND-2-verify): Build empirisch testen (curl chatgpt.com/codex/install.sh
# muss in der Build-Umgebung erreichbar sein). Fallback dokumentiert: npm i -g @openai/codex.
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh

# Der native Installer legt das Binary nach ~/.local/bin.
ENV PATH="/root/.local/bin:${PATH}"
# Credentials-Verzeichnis explizit fixieren (default ~/.codex) -> persistentes Volume.
ENV CODEX_HOME="/root/.codex"

WORKDIR /agent

COPY entrypoint.sh /usr/local/bin/cli-agent-entrypoint.sh
RUN chmod +x /usr/local/bin/cli-agent-entrypoint.sh

# Credentials/Update-Stand persistent ueber Volume einhaengen.
VOLUME ["/root/.codex"]

# Kein EXPOSE/HEALTHCHECK: kein Server. Wird vom externen Wrapper getrieben.
ENTRYPOINT ["/usr/local/bin/cli-agent-entrypoint.sh"]
