# synapse-workspace:latest — Sandbox-Container fuer pro-Projekt Shell/Tools.
# Wird vom WorkspaceOrchestrator (synapse-api) lazy-gestartet, mit ReadonlyRootfs,
# Resource-Caps, /workspace als persistentes Volume, /home/synapse als
# persistentes HOME-Volume (WS2-A1) und /tmp als tmpfs mit exec
# (Groesse pro Projekt via project_workspaces.tmpfs_mb, Default 256 MB).
#
# Ziel seit 2026-06-12 (User-Entscheid, Plan WS2): VOLLE SELBSTBEDIENUNG —
# die KI soll im Workspace alles bauen, linken, debuggen, testen und
# ausfuehren koennen (C/C++/Python/JS/Rust/Go/Java, Windows via MinGW+Wine,
# ARM/RISC-V via Cross-GCC+qemu-user, GL/Vulkan headless via Mesa+Xvfb).
# Tier-1-Paketliste: Memory workspace-test-tools-roadmap (Perplexity-validiert).
# Erwartete Groesse ~6-7 GB — bewusst akzeptiert; wer es schlank braucht,
# setzt per workspace(configure, image: ...) ein eigenes Image pro Projekt.
# Was NICHT im Image ist (bewusst): .NET/emscripten/Playwright-Browser —
# holt sich die KI selbst ins persistente HOME (Netz + schreibbares $HOME
# vorhanden); Android/KVM = eigenes Tier-2-Image (siehe README.md).

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_VERSION=20

# ---------------------------------------------------------------------------
# Layer 1 — Basistools + Build-Toolchain + Node.js 20 LTS (NodeSource).
# build-essential: gcc/g++/make/ar. xz/zstd/file: Archiv-/Format-Handling.
# gcc-mingw-w64-x86-64: Windows-Cross (gcc + g++ fuer C++-Ports).
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      file \
      gcc-mingw-w64-x86-64 \
      g++-mingw-w64-x86-64 \
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
      python3-venv \
      python3-dev \
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
 && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ---------------------------------------------------------------------------
# Layer 2 — Tier 1a: Dev-LIBRARIES (compile-faehig != link-faehig — DIE Luecke).
# Alles, wogegen reale C/C++-Programme linken: sqlite3, SDL2-Familie, curl,
# OpenSSL, zlib, png/jpeg/freetype, ncurses, readline, pcre2, libpq (Postgres),
# xml2, yaml, boost.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libsqlite3-dev sqlite3 \
      libsdl2-dev libsdl2-image-dev libsdl2-ttf-dev libsdl2-mixer-dev \
      libcurl4-openssl-dev libssl-dev zlib1g-dev \
      libpng-dev libjpeg-dev libfreetype-dev \
      libncurses-dev libreadline-dev \
      libpcre2-dev libpq-dev \
      libxml2-dev libyaml-dev \
      libboost-all-dev \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 3 — Tier 1b Debug/Analyse + Tier 1c Test-Frameworks.
# Sanitizer (ASan/UBSan/LSan/TSan) kommen mit gcc/clang (-fsanitize=...).
# gtest: Debian liefert Quellen — einmal bauen + installieren, damit
# -lgtest direkt linkt. catch2 v3: Header+Lib. pytest fuer Python.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gdb lldb valgrind strace ltrace \
      cppcheck clang clang-tidy lld shellcheck patchelf \
      libgtest-dev catch2 python3-pytest \
 && cmake -S /usr/src/googletest -B /tmp/gtest-build \
 && cmake --build /tmp/gtest-build --target install -j"$(nproc)" \
 && rm -rf /tmp/gtest-build \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 4 — Tier 1d: Multimedia/GL/Audio + headless GUI.
# Mesa llvmpipe = Software-Rendering fuer OpenGL UND Vulkan ohne GPU;
# Xvfb fuer SDL/GUI-Tests. ffmpeg als CLI + dev-Libs. OpenAL/ALSA/Pulse-Audio.
# Zusaetzlich Browser-Runtime-Libs (libnss3 & Co), damit die KI sich
# Playwright-Browser ins HOME installieren kann (npx playwright install).
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1-mesa-dev libglu1-mesa-dev libegl-dev libgles-dev \
      mesa-vulkan-drivers libvulkan-dev vulkan-tools mesa-utils \
      libopenal-dev libasound2-dev libpulse-dev \
      ffmpeg libavcodec-dev libavformat-dev libswscale-dev \
      xvfb x11-utils libx11-dev libxext-dev libwayland-dev \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libatspi2.0-0 libx11-xcb1 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 5 — Tier 1e: Cross-Compile + QEMU-user.
# qemu-user-static: ARM/AArch64/RISC-V-Binaries DIREKT ausfuehren
# (qemu-aarch64-static ./bin — binfmt ist Host-Sache, im Container unnoetig).
# Embedded: arm-none-eabi (+newlib) und AVR.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      qemu-user-static \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
      gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
      gcc-riscv64-linux-gnu g++-riscv64-linux-gnu \
      gcc-arm-none-eabi libnewlib-arm-none-eabi \
      gcc-avr avr-libc \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 5b — System-Emulation + Boot-Tooling (moo-Gates, OS-Dev, WS4).
# qemu-system: GANZE Maschinen booten (x86_64 + ARM64) — reine TCG-Software-
# Emulation, kein KVM noetig (langsamer als nativ, aber sandbox-tauglich).
# OVMF/AAVMF: UEFI-Firmware fuer uefi-/arm64-Smokes. grub-mkrescue kommt aus
# grub-common; grub-pc-bin (BIOS) + grub-efi-amd64-bin (UEFI) liefern die
# Module; xorriso + mtools bauen die bootfaehigen ISOs.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      qemu-system-x86 qemu-system-arm qemu-utils \
      ovmf qemu-efi-aarch64 \
      grub-common grub-pc-bin grub-efi-amd64-bin \
      xorriso mtools \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 6 — Wine (x64): Windows-.exe AUSFUEHREN (MinGW-Builds testen).
# Nur wine64 — bookworm-multiarch/wine32 bewusst weggelassen (x64 reicht
# fuer eigene MinGW-x86_64-Builds). WINEPREFIX entsteht beim ersten Lauf
# in $HOME/.wine (persistentes HOME-Volume). Headless: xvfb-run wine app.exe
# bzw. WINEDLLOVERRIDES="mscoree,mshtml=" gegen Gecko/Mono-Dialoge.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends wine wine64 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 7 — MinGW-Extras (/opt/mingw-extras): Fremdlibs fuer Windows-Cross,
# die Debian NICHT als mingw-Pakete liefert.
# - sqlite3: Amalgamation (Public Domain), MinGW-kompiliert -> libsqlite3.a
# - SDL2 + SDL2_image: offizielle -devel-mingw-Releases (zlib-Lizenz)
# Nutzung: x86_64-w64-mingw32-gcc app.c -I/opt/mingw-extras/include \
#   -L/opt/mingw-extras/lib -lsqlite3 -lSDL2 [...] (Details: README.md).
# Versions-Pins bewusst — Update-Anleitung im README.
# ---------------------------------------------------------------------------
ENV MINGW_EXTRAS=/opt/mingw-extras \
    SQLITE_AMALGAMATION=sqlite-amalgamation-3450300 \
    SDL2_MINGW_VERSION=2.30.5 \
    SDL2_IMAGE_MINGW_VERSION=2.8.2
RUN mkdir -p ${MINGW_EXTRAS}/include ${MINGW_EXTRAS}/lib /tmp/mx && cd /tmp/mx \
 && wget -q https://sqlite.org/2024/${SQLITE_AMALGAMATION}.zip \
 && unzip -q ${SQLITE_AMALGAMATION}.zip \
 && x86_64-w64-mingw32-gcc -O2 -DSQLITE_THREADSAFE=1 -c ${SQLITE_AMALGAMATION}/sqlite3.c -o sqlite3.o \
 && x86_64-w64-mingw32-ar rcs ${MINGW_EXTRAS}/lib/libsqlite3.a sqlite3.o \
 && cp ${SQLITE_AMALGAMATION}/sqlite3.h ${SQLITE_AMALGAMATION}/sqlite3ext.h ${MINGW_EXTRAS}/include/ \
 && wget -q https://github.com/libsdl-org/SDL/releases/download/release-${SDL2_MINGW_VERSION}/SDL2-devel-${SDL2_MINGW_VERSION}-mingw.tar.gz \
 && tar xzf SDL2-devel-${SDL2_MINGW_VERSION}-mingw.tar.gz \
 && cp -r SDL2-${SDL2_MINGW_VERSION}/x86_64-w64-mingw32/include/* ${MINGW_EXTRAS}/include/ \
 && cp -r SDL2-${SDL2_MINGW_VERSION}/x86_64-w64-mingw32/lib/* ${MINGW_EXTRAS}/lib/ \
 && cp SDL2-${SDL2_MINGW_VERSION}/x86_64-w64-mingw32/bin/SDL2.dll ${MINGW_EXTRAS}/lib/ \
 && wget -q https://github.com/libsdl-org/SDL_image/releases/download/release-${SDL2_IMAGE_MINGW_VERSION}/SDL2_image-devel-${SDL2_IMAGE_MINGW_VERSION}-mingw.tar.gz \
 && tar xzf SDL2_image-devel-${SDL2_IMAGE_MINGW_VERSION}-mingw.tar.gz \
 && cp -r SDL2_image-${SDL2_IMAGE_MINGW_VERSION}/x86_64-w64-mingw32/include/* ${MINGW_EXTRAS}/include/ \
 && cp -r SDL2_image-${SDL2_IMAGE_MINGW_VERSION}/x86_64-w64-mingw32/lib/* ${MINGW_EXTRAS}/lib/ \
 && cp SDL2_image-${SDL2_IMAGE_MINGW_VERSION}/x86_64-w64-mingw32/bin/*.dll ${MINGW_EXTRAS}/lib/ \
 && cd / && rm -rf /tmp/mx

# ---------------------------------------------------------------------------
# Layer 8 — Tier 1f: Runtimes + Build-Beschleuniger.
# Rust: Toolchain RO unter /opt/rust inkl. der wichtigsten Cross-Targets
#   (windows-gnu fuer MinGW-Link, aarch64, wasm32). cargo install schreibt
#   via CARGO_HOME ins persistente HOME. Exotische Toolchains kann die KI
#   mit RUSTUP_HOME=$HOME/.rustup selbst nachziehen.
# Go: offizielles Tarball nach /usr/local/go (Cross via GOOS/GOARCH gratis).
# JDK headless (OpenJDK 17), Ruby, PHP-CLI. ninja/meson/ccache.
# ---------------------------------------------------------------------------
ENV RUSTUP_HOME=/opt/rust \
    GO_VERSION=1.23.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      default-jdk-headless ruby-full php-cli \
      ninja-build meson ccache \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
 && CARGO_HOME=/opt/rust RUSTUP_HOME=/opt/rust sh /tmp/rustup-init.sh -y \
      --no-modify-path --profile minimal --default-toolchain stable \
      --component clippy --component rustfmt \
 && CARGO_HOME=/opt/rust RUSTUP_HOME=/opt/rust /opt/rust/bin/rustup target add \
      x86_64-pc-windows-gnu aarch64-unknown-linux-gnu wasm32-unknown-unknown \
 && rm /tmp/rustup-init.sh \
 && curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz

# ---------------------------------------------------------------------------
# Layer 8b — Service-Rollen-Grundausstattung (WS4 Workspace-Rollen).
# DB-Server als normale Binaries — laufen als User synapse mit Daten im
# persistenten HOME-Volume (initdb $HOME/pgdata, redis --dir $HOME).
# Kein systemd, kein root: der Rollen-init_command startet die Dienste
# (z.B. pg_ctl start). reset_home = DB-Reset. uv: schneller Python-
# Paketmanager als Standalone-Binary nach /usr/local/bin.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql postgresql-client redis-server \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
 && uv --version

# ---------------------------------------------------------------------------
# Layer 8c — Nachzuegler (bewusst am Ende statt in Layer 4: so bleibt der
# Docker-Cache der dicken Layer beim Rebuild erhalten). xauth wird von
# xvfb-run zwingend gebraucht (WS4-5-Befund: "xauth command not found").
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends xauth \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 9 — User, ENV-Ergonomie, Selbstbedienungs-Defaults.
# PIP_BREAK_SYSTEM_PACKAGES: PEP-668-Override — im Wegwerf-Sandbox-Container
#   legitim (pip install --user landet im persistenten HOME-Volume).
# CARGO_HOME/GOPATH/ccache: alles Schreibende zeigt ins HOME-Volume.
# PATH: ccache-Wrapper zuerst (transparente Build-Caches), dann Rust/Go,
#   dann die User-Bin-Verzeichnisse (~/.cargo/bin, ~/.local/bin, ~/go/bin).
# git safe.directory '*': /workspace-Quellen gehoeren root (materialize 0444)
#   — ohne das meckert git "dubious ownership".
# ---------------------------------------------------------------------------
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    CARGO_HOME=/home/synapse/.cargo \
    GOPATH=/home/synapse/go \
    CCACHE_DIR=/home/synapse/.cache/ccache \
    PATH=/usr/lib/ccache:/opt/rust/bin:/usr/local/go/bin:/home/synapse/.cargo/bin:/home/synapse/.local/bin:/home/synapse/go/bin:/usr/lib/postgresql/15/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN git config --system safe.directory '*' \
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
