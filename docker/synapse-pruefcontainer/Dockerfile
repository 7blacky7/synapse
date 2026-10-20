# synapse-pruefcontainer (P16-T5, Stufe S3): Syntaxpruefung fuer Sprachen ausserhalb des Node-Prozesses.
#
# Bauen (aus dem Repo-Wurzelverzeichnis, braucht Netz fuer rustup, pip und die Basis-Images):
#   docker build -t synapse-pruefcontainer:latest docker/synapse-pruefcontainer
# Die API startet den Container selbst (packages/rest-api/src/services/pruef-container.ts): bei Bedarf,
# Idle-Stop, Neustart nach Absturz. Laufzeit-Haertung setzt die API beim Anlegen: NetworkMode none,
# read-only rootfs, tmpfs /tmp (noexec), User 65532, cap_drop ALL, no-new-privileges, Speicher-/CPU-/PID-Limit.
#
# Etappen: E1 Rust (rustfmt als reiner Parser). E2 Python (ast im Pruefserver, Python 3.14 + fissix fuer den
# Python-2-Rueckfall), Shell (bash -n), Go (gofmt -e). E3a PHP (php -l), Ruby (ruby -c), Lua (luac -p) aus Debian
# trixie in der Endstufe (je ein Paket, zusammen ca. +75 MB entpackt). Sprachen mit grossem Einzelwerkzeug = eigene
# Builder-Stufe, die Endstufe kopiert nur das Werkzeug. Zig bewusst NICHT (ast-check ist versionsabhaengig: zig 0.17
# meldet 36 von 241 Dateien eines 0.14-Projekts; Binary 160-180 MB).
# E3b Kotlin + Java: EIN JVM-Hilfsprozess (jvm/JvmPruefer.java), den pruefserver.py traege startet. Kotlin-Parser aus
# kotlin-compiler-embeddable (PSI), Java ueber die javac-API (nur parse). JVM-Laufzeit per jlink (nur die noetigen
# Module), Bibliotheken per Maven nur im Builder.
# P16-T16 E1: projektweite TypeScript-Build-Pruefung (pruefer_tsbuild.py): Node-Binary + typescript (npm nur im
# Builder, --ignore-scripts) unter /opt/pruef/tsc; tsc laeuft nur mit --noEmit im tmpfs, keine Projekt-node_modules.
# P16-T16 E2: projektweite Go-/Python-Pruefung (pruefer_projekt.py): vollstaendige Go-Toolchain (go build -o /dev/null +
# go vet, CGO aus, kein Netz/Toolchain-Download) und Pyright-CLI samt typeshed; Downloads nur im Builder mit fester
# Version + SHA256 (LIZENZEN.md). Zusaetzlich ca. 260-340 MB entpackt. Fuer Go-Projekte tmpfs_mb >= 384 einplanen
# (GOCACHE der Standardbibliothek ~40 MB je Programmfamilie, geteilt unter /tmp/pruef-gocache).

ARG DEBIAN_TAG=bookworm-slim
ARG RUST_VERSION=1.96.1
# Python-Grammatik = Interpreter der Endstufe: neueste stabile Version, damit neue Syntax (PEP 695/701/758) kein
# Fehlalarm wird. Beim Anheben den FP-Lauf wiederholen (pruef-container-fp.mjs python).
ARG PYTHON_TAG=3.14-slim-trixie
ARG GO_TAG=1.26-trixie
ARG FISSIX_VERSION=24.4.24
# E3a: Debian-Pakete der Endstufe (trixie: PHP 8.4, Ruby 3.3, Lua 5.4). Beim Anheben FP-Lauf wiederholen.
ARG APT_PAKETE="php8.4-cli ruby lua5.4 make libstdc++6"
# E3b: neueste stabile Kotlin-Version (Grammatik des Kotlin-Parsers) und JDK 25 LTS (Java-Sprachstand = JDK).
# Beim Anheben FP-Lauf wiederholen (pruef-container-fp.mjs kotlin / java).
ARG KOTLIN_VERSION=2.4.21
# P16-T13: Scala (scalameta) und Groovy im selben JVM-Hilfsprozess. Beim Anheben FP-Lauf wiederholen (scala / groovy).
ARG SCALAMETA_VERSION=4.17.4
ARG GROOVY_VERSION=5.0.2
ARG MAVEN_TAG=3.9-eclipse-temurin-25
# P16-T11: tree-sitter (Python-Bindings) + Grammatiken aus tree-sitter-language-pack (nur im Builder; die Pack-Version
# legt die Grammatik-Staende fest). Beim Anheben FP-Lauf je tree-sitter-Sprache wiederholen.
ARG TREE_SITTER_VERSION=0.26.0
ARG TS_PACK_VERSION=1.21.3
# P16-T13: naga-cli (WGSL-Parser von wgpu). Beim Anheben FP-Lauf wiederholen (pruef-container-fp.mjs wgsl).
ARG NAGA_VERSION=30.0.1
# P16-T14: Build-/Konfig-Sprachen. Meson-Parser (mesonbuild.mparser, ohne Interpreter); pruefgo = Go-Binary aus
# pruefgo/ (buildkit, hclsyntax, buildtools, go-jsonnet; Versionen fest in pruefgo/go.mod); make + ld aus Debian trixie.
# Beim Anheben FP-Lauf wiederholen (pruef-container-fp.mjs make|meson|linkerscript|dockerfile|hcl|starlark|jsonnet).
ARG MESON_VERSION=1.12.1
# P16-T16 E1: Node (nur das Binary) + TypeScript-Compiler fuer die Build-Pruefung. TYPESCRIPT_VERSION = Version der
# Projekte (packages/core: ^5.9.3); beim Anheben Basis neu pruefen (code_check build_status pruefen:true).
ARG NODE_TAG=24-trixie-slim
ARG TYPESCRIPT_VERSION=5.9.3

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

# ─── Stufe naga (P16-T13): naga-cli fuer WGSL, ~5 MB, nur gegen glibc/libgcc gelinkt (trixie wie die Endstufe) ───
FROM rust:${RUST_VERSION}-slim-trixie AS naga
ARG NAGA_VERSION
RUN CARGO_PROFILE_RELEASE_STRIP=true cargo install --locked --root /out/naga "naga-cli@${NAGA_VERSION}" \
 && /out/naga/bin/naga --version && ls -la /out/naga/bin

# --- P16-T16 E3c Rust ---
# Offizielles versioniertes Image; keine weiteren Downloads, kein rustup zur Laufzeit.
# Vollstaendiges rustc/cargo/Host-std (ohne rustdoc/Clippy/docs): ~550-750 MB entpackt.
FROM rust:${RUST_VERSION}-slim-trixie AS rustprojekt
RUN SYSROOT="$(rustc --print sysroot)" \
 && mkdir -p /out/rust/bin /out/rust/lib \
 && cp "$SYSROOT/bin/cargo" "$SYSROOT/bin/rustc" /out/rust/bin/ \
 && cp -a "$SYSROOT/lib/." /out/rust/lib/ \
 && mkdir -p /out/rust/runtime \
 && for bin in /out/rust/bin/* "$SYSROOT/lib/"*.so*; do ldd "$bin" 2>/dev/null; done | awk '$3 ~ "^/" {print $3}' | sort -u > /tmp/rust-runtime.txt \
 && while read -r so; do case "$so" in "$SYSROOT"/*|*/libc.so.*|*/libm.so.*|*/libgcc_s.so.*|*/ld-linux*) ;; *) cp -L "$so" /out/rust/runtime/ ;; esac; done < /tmp/rust-runtime.txt \
 && /out/rust/bin/cargo --version && /out/rust/bin/rustc --version \
 && { cargo --version; rustc --version; } > /out/rust/version \
 && du -sm /out/rust
# --- Ende P16-T16 E3c Rust ---

# ─── Stufe go: nur gofmt (statisch gelinkt, ~3 MB) ───
FROM golang:${GO_TAG} AS go
RUN mkdir -p /out/bin /out/versionen \
 && cp /usr/local/go/bin/gofmt /out/bin/ \
 && go env GOVERSION > /out/versionen/go \
 && cat /out/versionen/go

# ─── Stufe pruefgo (P16-T14): Original-Parser fuer Dockerfile (buildkit), HCL (hclsyntax), Starlark (buildtools/
# buildifier) und Jsonnet (go-jsonnet) als EIN statisches Binary (~7 MB). Module + Pruefsummen in pruefgo/go.mod/go.sum. ───
FROM golang:${GO_TAG} AS pruefgo
COPY pruefgo/ /bau/
RUN cd /bau && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/bin/pruefgo . \
 && /out/bin/pruefgo --version \
 && printf 'FROM alpine\nRUN echo 1\n' | /out/bin/pruefgo dockerfile | grep -qx '\[\]'

# ─── Stufe binutils (P16-T14): nur GNU ld (ld.bfd) und seine Bibliotheken, ohne den Rest von binutils ───
FROM python:${PYTHON_TAG} AS binutils
RUN apt-get update && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /out/bin /out/lib \
 && cp "$(readlink -f /usr/bin/ld.bfd)" /out/bin/ld \
 && for so in $(ldd /usr/bin/ld.bfd | awk '/=> \// {print $3}' | grep -E 'lib(bfd|ctf|sframe|jansson|opcodes)'); do cp "$so" /out/lib/; done \
 && ls -la /out/bin /out/lib

# ─── Stufe tsc (P16-T16 E1): Node-Binary + typescript, Probe mit tsc --version ───
FROM node:${NODE_TAG} AS tsc
ARG TYPESCRIPT_VERSION
RUN mkdir -p /out/bin /out/tsc /out/versionen && cd /out/tsc \
 && npm install --no-audit --no-fund --ignore-scripts --omit=dev "typescript@${TYPESCRIPT_VERSION}" \
 && cp "$(command -v node)" /out/bin/node \
 && /out/bin/node /out/tsc/node_modules/typescript/lib/tsc.js --version > /out/versionen/tsc \
 && cat /out/versionen/tsc && du -sh /out/tsc /out/bin/node

# ─── P16-T16 E2 Vorbereitung: vollständige Go-Toolchain, offizielles versioniertes Archiv ───
# Debian-main-Go ist aelter als der vorhandene gofmt-Stand (1.26); upstream mit SHA256 statt Sprachdowngrade.
FROM debian:${DEBIAN_TAG} AS goprojekt
ARG TARGETARCH
# Neueste stabile Version (go.dev, 14.10.2026): eine neuere Toolchain prueft aeltere go.mod-Staende mit, umgekehrt nicht.
ARG GO_PROJEKT_VERSION=1.27.2
ARG GO_PROJEKT_SHA256_AMD64=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5
ARG GO_PROJEKT_SHA256_ARM64=94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && GO_ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && case "$GO_ARCH" in amd64) SHA="$GO_PROJEKT_SHA256_AMD64" ;; arm64) SHA="$GO_PROJEKT_SHA256_ARM64" ;; *) exit 1 ;; esac \
 && curl --fail --location --proto '=https' --tlsv1.2 "https://go.dev/dl/go${GO_PROJEKT_VERSION}.linux-${GO_ARCH}.tar.gz" -o /tmp/go.tar.gz \
 && printf '%s  /tmp/go.tar.gz\n' "$SHA" | sha256sum -c - \
 && mkdir -p /out/versionen && tar -xzf /tmp/go.tar.gz -C /out \
 && /out/go/bin/go version > /out/versionen/gobuild \
 && rm /tmp/go.tar.gz

# ─── P16-T16 E2 Vorbereitung: Pyright-CLI + bundled typeshed, Node aus E1 wiederverwenden ───
FROM node:${NODE_TAG} AS pyright
ARG PYRIGHT_VERSION=1.1.414
ARG PYRIGHT_SHA256=bf5f473f6167c0d14175492c3263d783b4489a6956e1c06c18e15228e3a3fa42
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl --fail --location --proto '=https' --tlsv1.2 "https://registry.npmjs.org/pyright/-/pyright-${PYRIGHT_VERSION}.tgz" -o /tmp/pyright.tgz \
 && printf '%s  /tmp/pyright.tgz\n' "$PYRIGHT_SHA256" | sha256sum -c - \
 && mkdir -p /out/pyright /out/versionen \
 && tar -xzf /tmp/pyright.tgz --strip-components=1 -C /out/pyright \
 && node /out/pyright/index.js --version > /out/versionen/pyright \
 && test -f /out/pyright/dist/typeshed-fallback/LICENSE \
 && rm /tmp/pyright.tgz
# Verifizierter Original-Tarball ist CLI-ready; nur optionale macOS-Abhängigkeit fsevents entfällt auf Linux.
# Keine Projektpakete, Install-Skripte oder Netzdownloads zur Laufzeit.

# ─── Stufe jvm: Kotlin-Bibliotheken (Maven), Hilfsprozess kompilieren, schlanke JVM per jlink ───
# java.desktop braucht der Kotlin-Parser (intellij-core), ohne startet KotlinCoreEnvironment nicht (gemessen).
FROM maven:${MAVEN_TAG} AS jvm
ARG KOTLIN_VERSION
ARG SCALAMETA_VERSION
ARG GROOVY_VERSION
WORKDIR /bau
COPY jvm/pom.xml jvm/JvmPruefer.java /bau/
RUN mvn -B -q dependency:copy-dependencies -Dkotlin.version=${KOTLIN_VERSION} -Dscalameta.version=${SCALAMETA_VERSION} \
      -Dgroovy.version=${GROOVY_VERSION} -DoutputDirectory=/out/jvm/lib \
 && mkdir -p /out/jvm/klassen /out/versionen \
 && javac -nowarn -cp '/out/jvm/lib/*' -d /out/jvm/klassen JvmPruefer.java \
 && jlink --add-modules java.base,java.desktop,java.logging,java.management,jdk.compiler,jdk.unsupported \
      --strip-debug --no-man-pages --no-header-files --compress=zip-6 --generate-cds-archive --output /out/jvm/rt \
 && /out/jvm/rt/bin/java -Xshare:auto -cp '/out/jvm/lib/*:/out/jvm/klassen' JvmPruefer --probe \
 && echo "kotlin-psi ${KOTLIN_VERSION}" > /out/versionen/kotlin \
 && echo "scalameta ${SCALAMETA_VERSION}" > /out/versionen/scala \
 && echo "groovy ${GROOVY_VERSION}" > /out/versionen/groovy \
 && echo "javac $(/out/jvm/rt/bin/java -XshowSettings:properties -version 2>&1 | awk '/java.version = / {print $3}')" > /out/versionen/java \
 && cat /out/versionen/kotlin /out/versionen/java && du -sh /out/jvm/*

# --- P16-T16 E3b Kotlin/Java ---
# Vollständiges JDK inkl. ct.sym für --release, gepinnte Kotlin-Bibliotheken weiterverwenden.
# Keine zusätzliche Downloadquelle; Syntaxdienst behält sein jlink-Runtime.
RUN mkdir -p /out/jdk /out/versionen \
 && cp -a "$JAVA_HOME"/. /out/jdk/ \
 && /out/jdk/bin/javac -version \
 && /out/jdk/bin/java -cp '/out/jvm/lib/*' org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -version \
 && sha256sum /out/jvm/lib/*.jar /out/jdk/release > /out/versionen/jvmprojekt-sha256 \
 && du -sk /out/jdk /out/jvm/lib > /out/versionen/jvmprojekt-groesse-kib

# ─── Stufe treesitter (P16-T11): Bindings + Grammatiken aller ts_sprachen-Module, Probe je Sprache ───
# ts_holen.py holt nur die Grammatiken, die ein Modul in ts_sprachen/ nennt, und bricht ab, wenn eine probe nicht
# stimmt. Das Pack selbst kommt NICHT ins Image (zur Laufzeit kein Netz, kein Download).
FROM python:${PYTHON_TAG} AS treesitter
ARG TREE_SITTER_VERSION
ARG TS_PACK_VERSION
RUN pip install --no-cache-dir --root-user-action=ignore --target /out/py "tree-sitter==${TREE_SITTER_VERSION}" \
 && pip install --no-cache-dir --root-user-action=ignore --no-deps --target /opt/pack "tree-sitter-language-pack==${TS_PACK_VERSION}"
COPY pruefer_treesitter.py ts_holen.py /bau/
COPY ts_sprachen/ /bau/ts_sprachen/
RUN PYTHONPATH=/out/py:/opt/pack python3 /bau/ts_holen.py /out/ts ${TS_PACK_VERSION} && du -sh /out/py /out/ts

# --- P16-T16 E3d Dart ---
FROM debian:${DEBIAN_TAG} AS dartprojekt
ARG TARGETARCH
ARG DART_VERSION=3.13.5
ARG DART_SHA256_AMD64=ea864bc64df30a6b8bdf30b2e32550f7717d9a890de8f40293aeabb924fe232b
ARG DART_SHA256_ARM64=19a731647c3ed55058ee46dde00330150e6a8729bb6121b4a31e86084c8a3e6d
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && case "$ARCH" in amd64) SDK_ARCH=x64; SHA="$DART_SHA256_AMD64" ;; arm64) SDK_ARCH=arm64; SHA="$DART_SHA256_ARM64" ;; *) exit 1 ;; esac \
 && curl --fail --location --proto '=https' --tlsv1.2 "https://storage.googleapis.com/dart-archive/channels/stable/release/${DART_VERSION}/sdk/dartsdk-linux-${SDK_ARCH}-release.zip" -o /tmp/dart.zip \
 && printf '%s  /tmp/dart.zip\n' "$SHA" | sha256sum -c - \
 && mkdir -p /out && unzip -q /tmp/dart.zip -d /out \
 && /out/dart-sdk/bin/dart --disable-analytics --version && du -sm /out/dart-sdk \
 && rm /tmp/dart.zip

# --- P16-T16 E3d C# ---
FROM debian:${DEBIAN_TAG} AS csharpprojekt
ARG TARGETARCH
ARG DOTNET_VERSION=10.0.402
ARG DOTNET_SHA512_AMD64=1904a98dda2db34ba78ba3c4fb1b224455329af91c341d83547843c1839e112b04ae699ee92fa2449a8f62249196a938723078c0c60b9f65c88539d5687729c2
ARG DOTNET_SHA512_ARM64=db85ae85527251fbb1290720ac3bf324bb1d9eea74516ef291ed4bb1f8ff6ec63a17593367f49b456115e8b24ead6d0c2ece2801e501f36a6cd4444ed01a498f
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libicu72 libssl3 libgssapi-krb5-2 zlib1g libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && case "$ARCH" in amd64) SDK_ARCH=x64; SHA="$DOTNET_SHA512_AMD64" ;; arm64) SDK_ARCH=arm64; SHA="$DOTNET_SHA512_ARM64" ;; *) exit 1 ;; esac \
 && curl --fail --location --proto '=https' --tlsv1.2 "https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_VERSION}/dotnet-sdk-${DOTNET_VERSION}-linux-${SDK_ARCH}.tar.gz" -o /tmp/dotnet.tar.gz \
 && printf '%s  /tmp/dotnet.tar.gz\n' "$SHA" | sha512sum -c - \
 && mkdir -p /out/dotnet && tar -xzf /tmp/dotnet.tar.gz -C /out/dotnet \
 && rm /tmp/dotnet.tar.gz
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_NOLOGO=1
COPY roslyn/ /bau/roslyn/
RUN bash /bau/roslyn/bauen.sh /out/roslyn /out/dotnet

# ─── Endstufe: Python-Basis (Interpreter fuer Pruefserver und Python-ast), bash ist enthalten ───
FROM python:${PYTHON_TAG}
ARG FISSIX_VERSION
ARG APT_PAKETE
ARG MESON_VERSION
# --- P16-T16 E3d C# Laufzeitbibliotheken (trixie) ---
RUN apt-get update && apt-get install -y --no-install-recommends libicu76 libssl3t64 libgssapi-krb5-2 zlib1g && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends ${APT_PAKETE} \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
# --- P16-T16 E3a C/C++ ---
# Debian signiert und prueft die Paket-Hashes; exakter GCC-Paketstand statt Compilerdownload.
# ~150-220 MB entpackt inkl. C++-Header; kleine C-TU ~16 MB, C++/Templates 128 MB bis >1 GiB.
ARG GCC_DEB_VERSION=14.2.0-19
RUN apt-get update && apt-get install -y --no-install-recommends \
      "gcc-14=${GCC_DEB_VERSION}" "g++-14=${GCC_DEB_VERSION}" libc6-dev \
 && test "$(gcc-14 -dumpfullversion)" = "14.2.0" \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY --chmod=0444 pruefer_cprojekt.py /opt/pruef/
ENV PRUEF_CC=/usr/bin/gcc-14 PRUEF_CXX=/usr/bin/g++-14
# --- Ende P16-T16 E3a C/C++ ---
# fissix (lib2to3-Fork, reiner Python-Parser) nur fuer den Python-2-Rueckfall; danach pip entfernen (wird zur
# Laufzeit nicht gebraucht, spart Platz und Angriffsflaeche).
RUN pip install --no-cache-dir --root-user-action=ignore --target /opt/pruef/py "fissix==${FISSIX_VERSION}" "meson==${MESON_VERSION}" \
 && rm -rf /opt/pruef/py/fissix/tests \
 && python3 -m pip uninstall -y --root-user-action=ignore pip \
 && rm -rf /usr/share/doc /usr/share/man /usr/share/locale /root/.cache
COPY --from=rust --chmod=0555 /out/bin/ /opt/pruef/bin/
COPY --from=rust --chmod=0555 /out/lib/ /opt/pruef/lib/
# --- P16-T16 E3c Rust (Laufzeit) ---
COPY --from=rustprojekt --chmod=0555 /out/rust/ /opt/pruef/rust/
COPY --chmod=0444 pruefer_rustprojekt.py /opt/pruef/
ENV PRUEF_CARGO=/opt/pruef/rust/bin/cargo PRUEF_RUSTC=/opt/pruef/rust/bin/rustc
# --- Ende P16-T16 E3c Rust (Laufzeit) ---
COPY --from=go --chmod=0555 /out/bin/ /opt/pruef/bin/
COPY --from=naga --chmod=0555 /out/naga/bin/naga /opt/pruef/bin/naga
COPY --from=pruefgo --chmod=0555 /out/bin/pruefgo /opt/pruef/bin/pruefgo
COPY --from=binutils --chmod=0555 /out/bin/ld /opt/pruef/bin/ld
COPY --from=binutils --chmod=0555 /out/lib/ /opt/pruef/lib/
COPY --from=go --chmod=0444 /out/versionen/go /opt/pruef/versionen/go
# --- P16-T16 E3b Kotlin/Java ---
COPY --from=jvm --chmod=0555 /out/jdk/ /opt/pruef/jdk/
COPY --from=jvm --chmod=0444 /out/versionen/jvmprojekt-sha256 /out/versionen/jvmprojekt-groesse-kib /opt/pruef/versionen/
COPY --chmod=0444 pruefer_jvmprojekt.py test_jvmprojekt.py /opt/pruef/
COPY --from=jvm --chmod=0555 /out/jvm/ /opt/pruef/jvm/
COPY --from=jvm --chmod=0444 /out/versionen/kotlin /out/versionen/java /out/versionen/scala /out/versionen/groovy /opt/pruef/versionen/
COPY --chmod=0444 pruefserver.py pruefer_jvm.py pruefer_naga.py pruefer_build.py pruefer_tsbuild.py /opt/pruef/
COPY --from=tsc --chmod=0555 /out/bin/node /opt/pruef/bin/node
COPY --from=tsc --chmod=0555 /out/tsc/ /opt/pruef/tsc/
COPY --from=tsc --chmod=0444 /out/versionen/tsc /opt/pruef/versionen/tsc
COPY --from=goprojekt --chmod=0555 /out/go/ /opt/pruef/go/
COPY --from=goprojekt --chmod=0444 /out/versionen/gobuild /opt/pruef/versionen/gobuild
COPY --from=pyright --chmod=0555 /out/pyright/ /opt/pruef/pyright/
COPY --from=pyright --chmod=0444 /out/versionen/pyright /opt/pruef/versionen/pyright
# --- P16-T16 E3d Dart/C# SDKs und vertrauter Roslyn-Prüfer ---
COPY --from=dartprojekt --chmod=0555 /out/dart-sdk/ /opt/pruef/dart/
COPY --from=csharpprojekt --chmod=0555 /out/dotnet/ /opt/pruef/dotnet/
COPY --from=csharpprojekt --chmod=0555 /out/roslyn/ /opt/pruef/roslyn/
COPY --chmod=0444 pruefer_dart_csharp.py /opt/pruef/
# P16-T21: Testphase im neuen Image, auch ohne SDKs auf dem PC ausführbar.
COPY --chmod=0444 tests/test_pruefer_dart_csharp.py /opt/pruef/tests/
COPY --chmod=0444 pruefer_projekt.py LIZENZEN.md /opt/pruef/
COPY --chmod=0555 python-isoliert.sh /opt/pruef/bin/python-isoliert
COPY --from=treesitter --chmod=0555 /out/py/ /opt/pruef/py/
COPY --from=treesitter --chmod=0555 /out/ts/ /opt/pruef/ts/
COPY --chmod=0555 pruefer_treesitter.py /opt/pruef/
COPY --chmod=0555 ts_sprachen/ /opt/pruef/ts_sprachen/
ENV PATH=/opt/pruef/bin:/usr/local/bin:/usr/bin:/bin \
    LD_LIBRARY_PATH=/opt/pruef/lib \
    PYTHONPATH=/opt/pruef/py \
    XDG_CACHE_HOME=/opt/pruef/cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
# Probe aller Werkzeuge beim Build. fissix wird vorkompiliert und legt seine Grammatik-Tabellen (Pickle) hier in
# XDG_CACHE_HOME an - zur Laufzeit ist rootfs read-only, ohne Cache scheitert der Python-2-Rueckfall.
RUN python3 -m compileall -q /opt/pruef/py && mkdir -p /opt/pruef/leer && touch /opt/pruef/rustfmt.toml && chmod 0444 /opt/pruef/rustfmt.toml \
 && /opt/pruef/bin/rustfmt --version \
 && printf 'package x\n' | /opt/pruef/bin/gofmt -e >/dev/null \
 && bash --version | head -1 \
 && php -n -v | head -1 && printf '<?php echo 1;\n' | php -n -l \
 && ruby --disable=gems -v && printf 'x = 1\n' | ruby --disable=gems -c \
 && luac5.4 -v && printf 'local x = 1\n' | luac5.4 -p - \
 && naga --version && printf 'fn f() -> i32 { return 1; }\n' | naga --validate 0 --stdin-file-path p.wgsl \
 && python3 -c "import sys; sys.path.insert(0, '/opt/pruef'); import pruefserver as s, pruefer_build as b; p = b.selbsttest(s.lauf); print('build-sprachen', sorted(b.PROBEN), p or 'probe ok'); sys.exit(1 if p else 0)" \
 && /opt/pruef/jvm/rt/bin/java -Xshare:auto -cp '/opt/pruef/jvm/lib/*:/opt/pruef/jvm/klassen' JvmPruefer --probe \
 && python3 -c "import sys; sys.path.insert(0, '/opt/pruef'); import pruefer_treesitter as t; p = t.selbsttest(); print('tree-sitter', t.info()['pack'], sorted(t.lade_sprachen()), p or 'probe ok'); sys.exit(1 if p else 0)" \
 && python3 -c "import sys; from fissix import pygram; from fissix.pgen2 import driver; print(sys.version.split()[0], 'fissix ok')" \
 && node --version && python3 /opt/pruef/pruefer_tsbuild.py \
 && /opt/pruef/go/bin/go version && node /opt/pruef/pyright/index.js --version \
 && mkdir -p /opt/pruef/gomodcache \
 && python3 /opt/pruef/pruefer_dart_csharp.py \
 && python3 /opt/pruef/pruefer_projekt.py \
 && mkdir -p /opt/pruef/jvm-classpath \
 && python3 /opt/pruef/pruefer_jvmprojekt.py \
 && python3 /opt/pruef/pruefer_rustprojekt.py \
 && python3 /opt/pruef/pruefer_cprojekt.py \
 && chmod -R a+rX /opt/pruef/cache /opt/pruef/versionen && ls -la /opt/pruef/cache/fissix/*/ \
 && find /opt/pruef -type d ! -perm -0555 -exec chmod a+rx {} + \
 && test "$(stat -c %a /opt/pruef)" = 555 -o "$(stat -c %a /opt/pruef)" = 755
# P16-T22: COPY --chmod=0444 <datei> /opt/pruef/ legt einen fehlenden Zielordner mit 0444 an (BuildKit von Docker 29,
# gemessen 20.10.2026: /opt/pruef dr--r--r--) - als User 65532 startete pruefserver.py dann nicht (Permission denied).
# Die Proben oben laufen als root und merken das nicht; deshalb hier alle Ordner durchsuchbar machen und pruefen.
LABEL synapse.pruefcontainer="1" org.opencontainers.image.title="synapse-pruefcontainer"
USER 65532:65532
WORKDIR /opt/pruef/leer
ENTRYPOINT ["python3", "-u", "/opt/pruef/pruefserver.py"]
