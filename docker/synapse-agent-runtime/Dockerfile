# syntax=docker/dockerfile:1
# synapse-agent-runtime — Agenten-Runtime-Image (P22-T4, W2a; W0c-Bericht 502500cd Abschn. 4, User e039ae52).
#
# Inhalt:
#   /opt/synapse/<revision>/   Daemon (packages/file-watcher-daemon-ts, Startprofil runtime) samt @synapse/agents
#                              (Wrapper) und @synapse/core, per pnpm deploy eigenstaendig; /opt/synapse/current zeigt darauf.
#   /opt/synapse/cli-bundle/   Claude Code (nativ) und Codex in EXAKTEN Versionen (Build-Argumente, "latest" wird beim
#                              Build aufgeloest und festgehalten). Der Daemon kopiert sie beim ersten Start in den
#                              beschreibbaren home-Mount (~/.local/share/synapse-cli), falls dort noch nichts liegt.
#   synapse-runtime            Bedienung: status, cli list|install|use|update|rollback|verlauf.
#
# Laufzeitvertrag (unveraendert zu den bestehenden Runtime-Containern, codex-driver.ts persistentRuntimeBinds):
#   Mounts <root>/home:/root, <root>/projects:/projects, <root>/state:/state, <root>/attachments:/attachments;
#   Rootfs read-only, /tmp als exec-tmpfs, Init (tini) durch Docker, CapDrop ALL, no-new-privileges.
#   Alles Beschreibbare (CLI-Versionen, Auth, pnpm-Store, Status) liegt auf diesen Mounts, nie unter /usr oder /opt.
#   Keine Projekt-/PC-Nebendienste, kein Docker-Socket, keine Datenbank.
#
# Updates im Betrieb: neue Version daneben installieren, Launcher atomar umschalten, alte Versionen bleiben
# (Rollback). DISABLE_AUTOUPDATER=1 verhindert eigenmaechtige Hintergrund-Updates von Claude Code.
#
# Bauen (aus dem Repo-Root; Dockerfile.dockerignore haelt node_modules/dist des Arbeitsbaums heraus):
#   docker build -f docker/synapse-agent-runtime/Dockerfile \
#     --build-arg SYNAPSE_REVISION=$(git rev-parse --short HEAD) \
#     --build-arg CLAUDE_VERSION=latest --build-arg CODEX_VERSION=latest \
#     -t synapse-agent-runtime:$(git rev-parse --short HEAD) .
#
# Die bestehenden Runtime-Container (synapse-runtime-claude/-codex) werden durch dieses Image NICHT veraendert;
# die Umstellung ist ein eigener, freigegebener Betriebsschritt (README.md).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=10.33.0

# ---------------------------------------------------------------------------
# 1) Daemon/Wrapper bauen und eigenstaendig ablegen
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG SYNAPSE_REVISION=dev
ARG PNPM_VERSION
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/agents/package.json packages/agents/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/file-watcher-daemon-ts/package.json packages/file-watcher-daemon-ts/
RUN pnpm install --frozen-lockfile --filter @synapse/file-watcher-daemon-ts...
COPY packages/core packages/core
COPY packages/agents packages/agents
COPY packages/mcp-server packages/mcp-server
COPY packages/file-watcher-daemon-ts packages/file-watcher-daemon-ts
RUN pnpm --filter @synapse/file-watcher-daemon-ts... run build
RUN pnpm --filter @synapse/file-watcher-daemon-ts deploy --legacy --prod /out/app \
 && chmod 0755 /out/app/dist/runtime-main.js /out/app/dist/runtime-cli.js /out/app/node_modules/@synapse/agents/dist/runtime-mod-policy-helper.js
# P22-T194: nur die freigegebene gemeinsame Mod, keine Probe-Plugins/Arbeitskopie.
COPY mods/synapse-inbox mods/synapse-inbox
COPY mods/.claude-plugin/marketplace.json mods/.claude-plugin/marketplace.json
COPY docker/synapse-agent-runtime/paketiere-mods.mjs docker/synapse-agent-runtime/paketiere-mods.mjs
RUN node docker/synapse-agent-runtime/paketiere-mods.mjs /src/mods /out/app/mods "${SYNAPSE_REVISION}"

# ---------------------------------------------------------------------------
# 2) CLI-Bundle: exakte Versionen ueber denselben Installweg wie im Betrieb (cli-versionen.ts)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS cli-bundle
ARG PNPM_VERSION
ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bash procps \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DISABLE_AUTOUPDATER=1 \
    SYNAPSE_CLI_PNPM_STORE=/tmp/pnpm-store
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=build /out/app /opt/synapse/app
RUN node /opt/synapse/app/dist/runtime-cli.js cli install claude "${CLAUDE_VERSION}" \
      --basis /opt/synapse/cli-bundle --launcher-dir /tmp/kein-launcher --akteur image-build \
 && node /opt/synapse/app/dist/runtime-cli.js cli install codex "${CODEX_VERSION}" \
      --basis /opt/synapse/cli-bundle --launcher-dir /tmp/kein-launcher --akteur image-build \
 && node /opt/synapse/app/dist/runtime-cli.js cli list --basis /opt/synapse/cli-bundle --launcher-dir /tmp/kein-launcher \
      > /opt/synapse/cli-bundle/inhalt.json

# ---------------------------------------------------------------------------
# 3) Laufzeit-Image
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG PNPM_VERSION
ARG SYNAPSE_REVISION=dev
# procps (ps) fuer Codex' pid-verwalteten app-server (bdeed061); git/curl/bash fuer CLIs und Installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bash git procps \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=build /out/app /opt/synapse/${SYNAPSE_REVISION}
COPY --from=cli-bundle /opt/synapse/cli-bundle /opt/synapse/cli-bundle
# P22-T194 (t223-Nachbesserung): managed-settings.json ruft nur den policyHelper auf. Ohne verwalteten Start
# (runtime_synapse_mods AUS, Standard) gibt er eine leere managed Policy aus und die CLI startet wie bisher.
# SYNAPSE_RUNTIME_MOD_POLICY=1 unten ist nur die Faehigkeit dieses Images, kein Schalter.
COPY docker/synapse-agent-runtime/managed-settings.json /etc/claude-code/managed-settings.json
RUN ln -s /opt/synapse/${SYNAPSE_REVISION} /opt/synapse/current \
 && printf '%s\n' "${SYNAPSE_REVISION}" > /opt/synapse/REVISION \
 && ln -s /opt/synapse/current/dist/runtime-cli.js /usr/local/bin/synapse-runtime \
 && ln -s /opt/synapse/current/dist/runtime-main.js /usr/local/bin/synapse-runtime-daemon \
 && ln -s /opt/synapse/current/node_modules/@synapse/agents/dist/runtime-mod-policy-helper.js /usr/local/bin/synapse-runtime-mod-policy
ENV HOME=/root \
    PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISABLE_AUTOUPDATER=1 \
    SYNAPSE_DAEMON_PROFIL=runtime \
    SYNAPSE_RUNTIME_MOD_POLICY=1 \
    SYNAPSE_RUNTIME_MOD_MARKETPLACE=/opt/synapse/current/mods \
    SYNAPSE_IMAGE_REVISION=${SYNAPSE_REVISION} \
    PNPM_HOME=/root/.local/share/pnpm \
    XDG_CACHE_HOME=/root/.cache \
    NODE_ENV=production
LABEL org.opencontainers.image.title="synapse-agent-runtime" \
      org.opencontainers.image.revision="${SYNAPSE_REVISION}" \
      org.opencontainers.image.description="Synapse Agenten-Runtime: Daemon (Startprofil runtime) + versionierte Claude-/Codex-CLI"
WORKDIR /projects
CMD ["node", "/opt/synapse/current/dist/runtime-main.js"]
