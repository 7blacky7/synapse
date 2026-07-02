# ============================================================================
# SYNAPSE CLI-AGENT (inneres Image) — Claude Code
# ============================================================================
# PLAN-004 / DIND-2 (PREP-ONLY, nichts verdrahtet).
#
# Dieses Image wird im INNEREN dockerd (DinD, siehe DIND-1) der synapse-api
# gestartet. Es enthaelt AUSSCHLIESSLICH die Claude-Code-CLI — KEIN Wrapper,
# KEIN synapse-node-Runtime, KEIN sqlite. Der Synapse-Wrapper (packages/agents)
# laeuft bewusst AUSSERHALB im synapse-api-Aussencontainer und treibt/steuert
# dieses (und weitere) innere Container; er gehoert daher NICHT ins Image.
#
# Claude wird ueber den NATIVEN Installer installiert (standalone Binary, kein
# Node-Wrapper; npm @anthropic-ai/claude-code ist deprecated). Native Binary =>
# glibc-Base (debian), NICHT alpine/musl.
#
# Self-Update: der Entrypoint aktualisiert Claude bei jedem (Neu-)Start.
# Persistenz: /root/.claude (Credentials) ueber einen Share/Volume einhaengen,
# damit Auth + Update-Stand Neustarts ueberleben.
#
# Auth (claude.ai-Connector der synapse-api) und MCP-Verdrahtung kommen in
# DIND-3/DIND-5 — hier bewusst NICHT verdrahtet.
# ============================================================================

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal-Abhaengigkeiten: Installer (curl/bash), TLS (ca-certificates),
# git (einige CLI-Workflows nutzen es).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/*

# Nativer Claude-Code-Installer (kein npm, kein Node).
# Baked-in beim Build; der Entrypoint holt beim Start das jeweils neueste Update.
RUN curl -fsSL https://claude.ai/install.sh | bash

# Der native Installer legt das Binary nach ~/.local/bin.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /agent

COPY entrypoint.sh /usr/local/bin/cli-agent-entrypoint.sh
RUN chmod +x /usr/local/bin/cli-agent-entrypoint.sh

# Credentials/Update-Stand persistent ueber Share einhaengen.
VOLUME ["/root/.claude"]

# Kein EXPOSE/HEALTHCHECK: kein Server. Wird vom externen Wrapper getrieben.
ENTRYPOINT ["/usr/local/bin/cli-agent-entrypoint.sh"]
