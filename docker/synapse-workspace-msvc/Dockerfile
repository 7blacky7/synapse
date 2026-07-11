# synapse-workspace-msvc — Tier-2-Image fuer native Windows-MSVC-Cross-Builds.
#
# Enthaelt nur frei redistribuierbare Werkzeuge. MSVC und Windows SDK werden
# aus Lizenzgruenden NICHT ins Image eingebaut. Der User installiert sie
# einmalig mit msvc-setup --accept-license ins persistente Workspace-HOME.
#
# Bauen (Unraid, nach dem Basis-Image):
#   docker build -t synapse-workspace-msvc:latest docker/synapse-workspace-msvc/

FROM synapse-workspace:latest

USER root

ARG MSVC_WINE_REF=514f8ea34842cd6d831804d0e9658d3a32870ae1

# msvc-wine braucht fuer Download/Entpacken msitools + gcab. Clang/LLD 18
# erzeugen nativ auf Linux PE/COFF fuer das MSVC-ABI; Wine ist nur fuer
# optionale Laufzeit-Smokes da und kommt bereits aus dem Basis-Image.
# Die LLVM-Quelle wird hier nochmals idempotent gesetzt, damit auch ein
# aelteres lokal gecachtes Basis-Image reproduzierbar funktioniert.
RUN mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key -o /etc/apt/keyrings/apt-llvm-org.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/apt-llvm-org.asc] http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-18 main" \
      > /etc/apt/sources.list.d/llvm18.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      clang-18 lld-18 msitools gcab cabextract \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && git clone https://github.com/mstorsjo/msvc-wine.git /opt/msvc-wine \
 && git -C /opt/msvc-wine checkout --detach "${MSVC_WINE_REF}" \
 && rm -rf /opt/msvc-wine/.git \
 && mkdir -p /opt/msvc-tools/bin \
 && ln -s /usr/bin/clang-18 /opt/msvc-tools/bin/clang \
 && ln -s /usr/bin/clang++-18 /opt/msvc-tools/bin/clang++ \
 && ln -s /usr/bin/clang-18 /opt/msvc-tools/bin/clang-cl \
 && ln -s /usr/bin/lld-link-18 /opt/msvc-tools/bin/lld-link

COPY msvc-setup /usr/local/bin/msvc-setup
COPY msvc-run /usr/local/bin/msvc-run
COPY msvc-smoke /usr/local/bin/msvc-smoke
RUN chmod 0755 /usr/local/bin/msvc-setup /usr/local/bin/msvc-run /usr/local/bin/msvc-smoke

ENV MSVC_ROOT=/home/synapse/.msvc \
    MSVC_WINE_TOOLS=/opt/msvc-wine \
    PATH=/opt/msvc-tools/bin:/usr/lib/ccache:/opt/rust/bin:/usr/local/go/bin:/home/synapse/.cargo/bin:/home/synapse/.local/bin:/home/synapse/go/bin:/usr/lib/postgresql/15/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace
USER synapse:synapse
