# synapse-workspace:latest — Sandbox-Container fuer pro-Projekt Shell/Tools.
# Wird vom WorkspaceOrchestrator (synapse-api) lazy-gestartet, mit ReadonlyRootfs,
# Resource-Caps, /workspace als persistentes Volume und /tmp als tmpfs.
#
# Ziel: schlank (~200MB), nicht-root, gaengige Dev-Tools fuer die meisten Projekte.
# Hinzukommen bei Bedarf via Folge-Images (z.B. synapse-workspace-rust, -python-data).

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_VERSION=20

# Basistools + Node.js 20 LTS (NodeSource). build-essential bewusst weggelassen —
# Projekte die compiler brauchen, bekommen ein eigenes Folge-Image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
      less \
      openssh-client \
      python3 \
      python3-pip \
      ripgrep \
      tini \
      tree \
      unzip \
      vim-tiny \
      wget \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pnpm@10 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
 && groupadd -g 1000 synapse \
 && useradd -m -u 1000 -g 1000 -s /bin/bash synapse \
 && mkdir -p /workspace \
 && chown -R synapse:synapse /workspace

WORKDIR /workspace
USER synapse:synapse

# Container-Lifetime steuert der Orchestrator via createContainer.Cmd (sleep-Loop).
# Das CMD hier ist nur Default, falls jemand das Image manuell startet.
# tini sorgt fuer korrektes Signal-Handling (Ctrl-C / docker stop).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "-c", "while true; do sleep 86400; done"]
