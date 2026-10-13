# RV11: static reverse tools. P20 must enforce network=none, read-only rootfs,
# cap_drop=ALL, no-new-privileges, quotas and mount policy at runtime.
ARG DEBIAN_BASE=debian:trixie-slim
FROM ${DEBIAN_BASE}
ARG DEBIAN_SNAPSHOT=20261001T000000Z
ARG SEVENZIP_VERSION=25.01+dfsg-1~deb13u2
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
ARG OPENJDK25_JRE_VERSION=25.0.4.1+1-1~deb13u1
ARG OPENJDK25_JDK_VERSION=25.0.4.1+1-1~deb13u1
ARG GHIDRA_VERSION=12.1.3
ARG GHIDRA_TAG=Ghidra_12.1.3_build
ARG GHIDRA_DATE=20260818
ARG GHIDRA_SHA256=93a5d11a9ad510622acaaf908c556a7b9b764d338e78a7567f3689bf5081fd54
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/${GHIDRA_TAG}/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/reverse/bin:/usr/local/bin:/usr/bin:/bin GHIDRA_HOME=/opt/ghidra
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\n' "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends \
      "7zip=${SEVENZIP_VERSION}" "ffmpeg=${FFMPEG_VERSION}" \
      ca-certificates curl file libarchive-tools libmirage11 gir1.2-mirage-3.2 \
      bchunk unshield innoextract msitools cabextract unar lhasa arj mtools \
      llvm rizin wabt libopenmpt0 python3 unzip \
      "openjdk-25-jre-headless=${OPENJDK25_JRE_VERSION}" \
      "openjdk-25-jdk-headless=${OPENJDK25_JDK_VERSION}" \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && ln -sf /usr/bin/7z /usr/local/bin/7zz \
 && mkdir -p /opt/reverse/bin /opt/reverse/licenses /opt/reverse/ghidra_scripts /opt/reverse/tmp \
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
 && useradd --uid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin reverse \
 && chmod 1777 /opt/reverse/tmp
COPY --chmod=0444 runner.py /opt/reverse/runner.py
COPY --chmod=0444 LIZENZEN.md /opt/reverse/licenses/README.md
COPY --chmod=0444 ghidra/ExportFunctions.java /opt/reverse/ghidra_scripts/ExportFunctions.java
RUN set -eu; { printf 'debian_snapshot=%s\n' "${DEBIAN_SNAPSHOT}"; printf '7zip=%s\n' "$(7zz --help 2>&1 | head -1)"; printf 'ffmpeg=%s\n' "$(ffmpeg -version | head -1)"; printf 'rizin=%s\n' "$(rizin -v | head -1)"; printf 'python=%s\n' "$(python3 --version)"; printf 'java=%s\n' "$(java -version 2>&1 | head -1)"; printf 'ghidra=%s sha256=%s\n' "${GHIDRA_VERSION}" "${GHIDRA_SHA256}"; } > /opt/reverse/versionen.txt \
 && chmod 0444 /opt/reverse/versionen.txt
USER 65532:65532
WORKDIR /arbeit
ENTRYPOINT ["python3", "-u", "/opt/reverse/runner.py"]
