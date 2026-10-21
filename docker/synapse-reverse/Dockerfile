# RV11: static reverse tools. P20 must enforce network=none, read-only rootfs,
# cap_drop=ALL, no-new-privileges, quotas and mount policy at runtime.
ARG DEBIAN_BASE=debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
FROM ${DEBIAN_BASE}
ARG DEBIAN_SNAPSHOT=20261001T000000Z
ARG SEVENZIP_VERSION=25.01+dfsg-1~deb13u2
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
ARG RIZIN_VERSION=0.9.1
ARG RIZIN_SHA256=9102249a9f0b6319c5334a2e5cf8d9cc3f2035e1d3def027c41f6a90f647e8cf
ARG GHIDRA_VERSION=11.4.3
ARG GHIDRA_TAG=Ghidra_11.4.3_build
ARG GHIDRA_DATE=20251203
ARG GHIDRA_SHA256=b22a8baebb14339f19903c54363ba7e01781930cc43ab430539aabce0d58547a
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/${GHIDRA_TAG}/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TMPDIR=/tmp PATH=/opt/reverse/bin:/usr/local/bin:/usr/bin:/bin GHIDRA_HOME=/opt/ghidra
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\n' "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends \
      "7zip=${SEVENZIP_VERSION}" "ffmpeg=${FFMPEG_VERSION}" \
      ca-certificates curl file libarchive-tools libmirage11 gir1.2-mirage-3.2 \
      bchunk unshield innoextract msitools cabextract unar lhasa arj mtools \
      llvm wabt libopenmpt0 mscompress python3 python3-gi unzip xz-utils openjdk-21-jdk-headless passwd \
 && ln -sf /usr/bin/7z /usr/local/bin/7zz \
 && rm -rf /var/cache/apt/archives/*
RUN curl --fail --location --retry 3 --output /tmp/rizin.tar.xz "https://github.com/rizinorg/rizin/releases/download/v${RIZIN_VERSION}/rizin-v${RIZIN_VERSION}-static-x86_64.tar.xz" \
 && echo "${RIZIN_SHA256}  /tmp/rizin.tar.xz" | sha256sum --check - \
 && mkdir -p /opt/rizin /opt/reverse/bin /opt/reverse/licenses /opt/reverse/ghidra_scripts \
 && tar -xJf /tmp/rizin.tar.xz -C /opt/rizin \
 && ln -sf /opt/rizin/bin/rizin /opt/reverse/bin/rizin \
 && ln -sf /opt/rizin/bin/rz-bin /opt/reverse/bin/rz-bin \
 && rm /tmp/rizin.tar.xz \
 && curl --fail --location --retry 3 --output /opt/ghidra.zip "${GHIDRA_URL}" \
 && echo "${GHIDRA_SHA256}  /opt/ghidra.zip" | sha256sum --check - \
 && unzip -q /opt/ghidra.zip -d /opt \
 && mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" "${GHIDRA_HOME}" \
 && rm /opt/ghidra.zip \
 && apt-get purge -y curl unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && chmod -R a+rX "${GHIDRA_HOME}" \
 && ln -sf "${GHIDRA_HOME}/support/analyzeHeadless" /opt/reverse/bin/analyzeHeadless \
 && printf '%s %s\n' "${GHIDRA_VERSION}" "${GHIDRA_SHA256}" > /opt/reverse/version-ghidra \
 && chmod 0444 /opt/reverse/version-ghidra \
 && /usr/sbin/useradd --uid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin reverse
COPY --chmod=0444 runner.py /opt/reverse/runner.py
# P18-T49/RV34: Spurtabelle, Parser-Registry (libmirage via GObject-Introspection) und gemeinsamer Extraktor.
COPY --chmod=0444 disc.py /opt/reverse/disc.py
COPY --chmod=0444 pe_ressourcen.py /opt/reverse/pe_ressourcen.py
COPY --chmod=0444 LIZENZEN.md /opt/reverse/licenses/README.md
COPY --chmod=0444 ghidra/ExportFunctions.java /opt/reverse/ghidra_scripts/ExportFunctions.java
RUN set -eu; { printf 'debian_snapshot=%s\n' "${DEBIAN_SNAPSHOT}"; printf '7zip=%s\n' "$(7zz i 2>&1 | grep -m1 '^7-Zip')"; printf 'ffmpeg=%s\n' "$(ffmpeg -version | head -1)"; printf 'rizin=%s\n' "$(rizin -v | head -1)"; printf 'python=%s\n' "$(python3 --version)"; printf 'java=%s\n' "$(java -version 2>&1 | head -1)"; printf 'ghidra=%s sha256=%s\n' "${GHIDRA_VERSION}" "${GHIDRA_SHA256}"; } > /opt/reverse/versionen.txt \
 && chmod 0444 /opt/reverse/versionen.txt
RUN dpkg-query -W -f='${Package}=${Version}\n' 7zip ffmpeg file libarchive-tools libmirage11 gir1.2-mirage-3.2 bchunk unshield innoextract msitools cabextract unar lhasa arj mtools llvm wabt libopenmpt0 mscompress python3 python3-gi openjdk-21-jdk-headless > /opt/reverse/versionen-pakete.txt && chmod 0444 /opt/reverse/versionen-pakete.txt
USER 65532:65532
WORKDIR /arbeit
ENTRYPOINT ["python3", "-u", "/opt/reverse/runner.py"]
