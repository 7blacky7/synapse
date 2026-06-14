# ============================================================================
# SYNAPSE CLI-AGENT — Antigravity / Google Gemini CLI
# ============================================================================
# PLAN-004 / DIND-2 (Image-Geruest, analog docker/cli-agents/claude/).
#
# Dieses Image wird vom CliAgentOrchestrator (packages/rest-api/src/services/
# cli-agent-orchestrator.ts) als persistenter Container auf dem HOST-Docker via
# docker.sock gestartet. Es enthaelt AUSSCHLIESSLICH die Gemini-CLI — KEIN
# Wrapper, KEIN synapse-node-Runtime. Der Synapse-Wrapper (packages/agents)
# laeuft AUSSERHALB im synapse-api-Container und treibt diesen Container via
# 'docker exec -i <container> gemini -p ... --output-format stream-json' (DIND-5).
#
# Die Gemini-CLI ('antigravity'/Gemini-Familie) wird via npm installiert
# ('@google/gemini-cli', Node 18+/20+). Daher Node-Base statt nativem Installer.
#
# Self-Update: der Entrypoint aktualisiert die CLI bei jedem (Neu-)Start
# (npm i -g @google/gemini-cli@latest, graceful).
# Persistenz: ~/.gemini (oauth_creds.json — Google-OAuth, auto-refresh +
# settings.json) ueber ein Volume einhaengen, damit Auth Neustarts ueberlebt.
#
# Auth-Flow (DIND-3, hier NICHT verdrahtet): interaktiv 'Login with Google'
# (Browser-OAuth, einmalig via Web-Terminal DIND-4) -> ~/.gemini/oauth_creds.json,
# ODER headless via ENV GEMINI_API_KEY, ODER Vertex (GOOGLE_GENAI_USE_VERTEXAI=true
# + GOOGLE_CLOUD_PROJECT/LOCATION) bzw. GOOGLE_APPLICATION_CREDENTIALS.
# HINWEIS: Google stuft OAuth mit Drittsoftware als policy-verletzend ein ->
# fuer automatisierten Betrieb eher GEMINI_API_KEY/Vertex verwenden.
# ============================================================================

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal-Abhaengigkeiten: TLS (ca-certificates), git (CLI-Workflows), curl.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/*

# Gemini-CLI global installieren. Baked-in beim Build; der Entrypoint zieht beim
# Start das jeweils neueste Update.
# TODO(DIND-2-verify): Build empirisch testen (npm-Registry erreichbar; ggf.
# konkrete Major-Version pinnen sobald Antigravity-Branding final ist).
RUN npm install -g @google/gemini-cli \
    && npm cache clean --force

# Gemini-Config/Creds-Verzeichnis (default ~/.gemini) -> persistentes Volume.
ENV GEMINI_HOME="/root/.gemini"

WORKDIR /agent

COPY entrypoint.sh /usr/local/bin/cli-agent-entrypoint.sh
RUN chmod +x /usr/local/bin/cli-agent-entrypoint.sh

# OAuth-Creds + settings persistent ueber Volume einhaengen.
VOLUME ["/root/.gemini"]

# Kein EXPOSE/HEALTHCHECK: kein Server. Wird vom externen Wrapper getrieben.
ENTRYPOINT ["/usr/local/bin/cli-agent-entrypoint.sh"]
