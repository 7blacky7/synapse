# Synapse REST API
# ============================================================================
# PLAN-004 / DIND-1: Multi-Stage Build.
#
#   Stage "builder"  : baut die App exakt wie bisher (node:22-alpine).
#   Finale Stage     : FROM docker:28-dind (Docker-in-Docker-Basis).
#                      Node-Runtime + gebaute App werden reinkopiert.
#                      Der Entrypoint startet ein inneres dockerd NUR wenn
#                      SYNAPSE_DIND_ENABLED=1 (feature-gated, graceful).
#
# WICHTIG: OHNE SYNAPSE_DIND_ENABLED laeuft dieses Image 100% wie zuvor —
#          nur die Node-App, kein dockerd. docker:dind bringt kein Node mit,
#          deshalb wird die Node-Runtime aus dem builder reinkopiert.
# ============================================================================

# ----------------------------------------------------------------------------
# STAGE 1: BUILDER (Node 22-LTS) — UNVERAENDERTE Build-Logik
# ----------------------------------------------------------------------------
# Node 22-LTS — pnpm@latest verwendet intern node:sqlite, was Node 22+ erfordert.
FROM node:22-alpine AS builder

# pnpm installieren — pin auf 10.33 (matched lokale Version, pnpm@latest 11+ ist
# bei Ignored-Build-Scripts (ssh2, cpu-features) strikt und bricht den Install ab)
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Dependencies kopieren
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/rest-api/package.json ./packages/rest-api/
COPY packages/web-ui/package.json ./packages/web-ui/

# Install
RUN pnpm install --frozen-lockfile

# Source kopieren
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/rest-api ./packages/rest-api
COPY packages/web-ui ./packages/web-ui

# Build
RUN pnpm -r --filter @synapse/core --filter @synapse/rest-api --filter @synapse/web-ui run build

# ----------------------------------------------------------------------------
# STAGE 2: FINALE DinD-IMAGE (docker:28-dind)
# ----------------------------------------------------------------------------
# docker:dind bringt dockerd + docker-CLI mit, aber KEIN Node.js.
# Daher kopieren wir die Node-Runtime + die gebaute App aus dem builder.
FROM docker:28-dind

# --- Node.js 22 Runtime aus dem builder reinkopieren ---
# (Muster aus webserver-oauth/docker/agentenstube-dind.dockerfile)
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules

# npm/npx Symlinks erstellen
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Node-Laufzeitabhaengigkeiten auf Alpine (docker:dind ist alpine-basiert)
# + Claude-Code-Voraussetzungen (PLAN-004 / DIND-2, PREP-ONLY, nichts verdrahtet):
#   Das native Bun-Binary von Claude Code braucht auf musl/Alpine ZWINGEND
#   libgcc, libstdc++ UND ripgrep, plus ENV USE_BUILTIN_RIPGREP=0
#   (offizielle Doku: code.claude.com/docs/en/setup). curl/bash fuer den
#   Laufzeit-Installer im Entrypoint.
#   Claude SELBST wird hier NICHT installiert -> der Build bleibt von claude.ai
#   entkoppelt (Build kann nie daran scheitern). Der Entrypoint provisioniert
#   und aktualisiert Claude zur Laufzeit auf den persistenten Share (nur im
#   DinD-Pfad). Default-Verhalten unveraendert.
RUN apk add --no-cache libstdc++ libgcc ripgrep curl bash
ENV USE_BUILTIN_RIPGREP=0
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# --- Gebaute App + installierte Workspace-node_modules reinkopieren ---
# pnpm legt die node_modules (inkl. .pnpm-Store + Workspace-Symlinks) unter
# /app/node_modules und /app/packages/*/node_modules ab. Wir kopieren das
# komplette /app aus dem builder -> dist + node_modules + package.json bleiben
# konsistent zueinander.
COPY --from=builder /app /app

# --- Feature-gated Entrypoint ---
COPY docker/synapse-api-entrypoint.sh /usr/local/bin/synapse-api-entrypoint.sh
RUN chmod +x /usr/local/bin/synapse-api-entrypoint.sh

# Port
EXPOSE 3456

# Default: DinD AUS -> Entrypoint startet direkt die Node-App (Verhalten wie zuvor).
# Auf "1" setzen (z.B. via docker run -e / Unraid) um das innere dockerd zu aktivieren.
ENV SYNAPSE_DIND_ENABLED=0

# Start (kein direktes CMD-node mehr — der Entrypoint uebernimmt und exec't node).
ENTRYPOINT ["/usr/local/bin/synapse-api-entrypoint.sh"]
