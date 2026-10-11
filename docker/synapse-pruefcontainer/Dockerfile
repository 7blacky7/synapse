# synapse-pruefcontainer (P16-T5, Stufe S3): Syntaxpruefung fuer Sprachen ausserhalb des Node-Prozesses.
#
# Bauen (aus dem Repo-Wurzelverzeichnis):
#   docker build -t synapse-pruefcontainer:latest docker/synapse-pruefcontainer
# Die API startet den Container selbst (packages/rest-api/src/services/pruef-container.ts): bei Bedarf,
# Idle-Stop, Neustart nach Absturz. Laufzeit-Haertung setzt die API beim Anlegen: NetworkMode none,
# read-only rootfs, tmpfs /tmp (noexec), User 65532, cap_drop ALL, no-new-privileges, Speicher-/CPU-/PID-Limit.
#
# Etappe E1: Rust (rustfmt als reiner Parser). Weitere Sprachen folgen als eigene Stufen in diesem Dockerfile.

ARG DEBIAN_TAG=bookworm-slim
ARG RUST_VERSION=1.96.1

# ─── Stufe rust: Toolchain nur zum Herauskopieren von rustfmt + Laufzeit-Bibliotheken ───
FROM debian:${DEBIAN_TAG} AS rust
ARG RUST_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain ${RUST_VERSION} --component rustfmt \
 && SYSROOT=$(/opt/cargo/bin/rustc --print sysroot) \
 && mkdir -p /out/bin /out/lib \
 && cp "$SYSROOT/bin/rustfmt" /out/bin/ \
 && for so in $(ldd "$SYSROOT/bin/rustfmt" | awk '/=> \// {print $3}' | grep "$SYSROOT"); do cp "$so" /out/lib/; done \
 && ls -la /out/bin /out/lib

# ─── Endstufe ───
FROM debian:${DEBIAN_TAG}
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale
COPY --from=rust --chmod=0555 /out/bin/ /opt/pruef/bin/
COPY --from=rust --chmod=0555 /out/lib/ /opt/pruef/lib/
COPY --chmod=0444 pruefserver.py /opt/pruef/pruefserver.py
RUN mkdir -p /opt/pruef/leer && touch /opt/pruef/rustfmt.toml && chmod 0444 /opt/pruef/rustfmt.toml \
 && /opt/pruef/bin/rustfmt --version
ENV PATH=/opt/pruef/bin:/usr/local/bin:/usr/bin:/bin \
    LD_LIBRARY_PATH=/opt/pruef/lib \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
LABEL synapse.pruefcontainer="1" org.opencontainers.image.title="synapse-pruefcontainer"
USER 65532:65532
WORKDIR /opt/pruef/leer
ENTRYPOINT ["python3", "-u", "/opt/pruef/pruefserver.py"]
