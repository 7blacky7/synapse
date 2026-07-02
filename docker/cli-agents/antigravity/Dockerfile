# ============================================================================
# SYNAPSE CLI-AGENT — Antigravity CLI (Google, Binary: agy)
# ============================================================================
# PLAN-004 / DIND-2 (Image-Geruest, analog docker/cli-agents/claude/).
#
# Dieses Image wird vom CliAgentOrchestrator (packages/rest-api/src/services/
# cli-agent-orchestrator.ts) als persistenter Container auf dem HOST-Docker via
# docker.sock gestartet. Es enthaelt AUSSCHLIESSLICH die Antigravity-CLI ('agy')
# — KEIN Wrapper, KEIN synapse-node-Runtime. Der Synapse-Wrapper
# (packages/agents-antigravity) laeuft AUSSERHALB im synapse-api-Container und
# treibt diesen Container via 'docker exec -i <container> agy -p ...' (DIND-5).
#
# WICHTIG: cli_type 'antigravity' == OFFIZIELLER agy-CLI (Google Antigravity),
# NICHT die Gemini-CLI. Belegt durch model_registry (fullId 'agy-1.0.2',
# provider 'antigravity', getrennt von 'google') + packages/agents-antigravity/
# runtime.ts (spawn('agy', ['-p', ...])). Die Gemini-CLI wird zudem am
# 18.06.2026 abgeschaltet und durch die Antigravity-CLI abgeloest.
#
# agy ist ein natives (Go-)Binary -> nativer Installer wie bei claude
# (glibc-Base, debian), KEIN npm/Node.
#
# Self-Update: der Entrypoint ruft den Installer bei jedem (Neu-)Start erneut
# auf (idempotent -> latest). Persistenz (DIND-3, empirisch verifiziert
# dind-verifier 2026-06-15): agy legt seinen GESAMTEN State unter /root/.gemini
# ab (Unterordner antigravity-cli/ + config/) — inkl. der OAuth-Credentials nach
# dem Link-Login. KEIN OS-Keyring/Secret-Service (/root/.local/share/keyrings
# existiert nie). /root/.antigravity bleibt LEER. Daher wird /root/.gemini
# persistiert (Auth ueberlebt Neustart); /root/.local deckt nur das Binary +
# Update-Stand ab.
#
# Auth-Verdrahtung (DIND-3) + echtes Wrapper-Driving (DIND-5): hier NICHT
# verdrahtet.
# ============================================================================

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal-Abhaengigkeiten: Installer (curl/bash), TLS (ca-certificates), git
# (CLI-Workflows). HINWEIS: Fuer den OS-Keyring im Headless-Betrieb sind dbus +
# gnome-keyring noetig. TODO(DIND-3): Keyring-Bootstrap/Unlock im Container
# klaeren (oder File-Fallback), empirisch verifizieren.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/*

# Nativer Antigravity-CLI-Installer (kein npm, kein Node). Installiert nach
# ~/.local/bin/agy (Default TARGET_DIR des Installers; via -d/--dir aenderbar).
# Der Installer kennt NUR -d/--dir + -h/--help — KEIN --skip-path (jeder
# unbekannte Flag triggert die Usage + Exit 1). Daher ohne Flags aufrufen.
# Baked-in beim Build; der Entrypoint holt beim Start Updates.
# DIND-2-verify (2026-06-15, dind-verifier): empirisch verifiziert — Installer
# legt /root/.local/bin/agy ab, 'agy --version' -> 1.0.8, exit 0.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Der native Installer legt das Binary nach ~/.local/bin.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /agent

COPY entrypoint.sh /usr/local/bin/cli-agent-entrypoint.sh
RUN chmod +x /usr/local/bin/cli-agent-entrypoint.sh

# Persistenz: Binary + Update-Stand ueber /root/.local; agy-State + OAuth-Auth
# ueber /root/.gemini (empirisch verifiziert: dort liegt antigravity-cli/ +
# config/, NICHT in /root/.antigravity).
VOLUME ["/root/.local", "/root/.gemini"]

# Kein EXPOSE/HEALTHCHECK: kein Server. Wird vom externen Wrapper getrieben.
ENTRYPOINT ["/usr/local/bin/cli-agent-entrypoint.sh"]
