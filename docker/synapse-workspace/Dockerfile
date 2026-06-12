# synapse-workspace:latest — Sandbox-Container fuer pro-Projekt Shell/Tools.
# Wird vom WorkspaceOrchestrator (synapse-api) lazy-gestartet, mit ReadonlyRootfs,
# Resource-Caps, /workspace als persistentes Volume und /tmp als tmpfs
# (Groesse pro Projekt via project_workspaces.tmpfs_mb, Default 256 MB).
#
# Ziel seit 2026-06-12 (User-Entscheid): TEST-FAEHIG fuer alle gaengigen Szenarien
# (C/C++-Builds, Archiv-Formate, Windows-Cross-Compile via MinGW, Netz-Probes)
# statt minimal. Groesse ~1 GB ist akzeptiert; wer es schlank braucht, setzt per
# workspace(configure, image: ...) ein eigenes Image pro Projekt.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_VERSION=20

# Basistools + Build-Toolchain + Node.js 20 LTS (NodeSource).
# build-essential: gcc/g++/make/ar fuer native Builds + dpkg -x Workflows.
# xz-utils/zstd/file: Archiv- und Format-Handling (tar.xz, .deb, Binaer-Inspektion).
# gcc-mingw-w64-x86-64: Windows-Cross-Compile-Probe (POSIX-only-Code erkennen).
# cmake/pkg-config: gaengige Build-Systeme. procps/netcat: ps + Port-/Netz-Tests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      file \
      gcc-mingw-w64-x86-64 \
      git \
      gnupg \
      jq \
      less \
      netcat-openbsd \
      openssh-client \
      pkg-config \
      procps \
      python3 \
      python3-pip \
      ripgrep \
      tini \
      tree \
      unzip \
      vim-tiny \
      wget \
      xz-utils \
      zstd \
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
