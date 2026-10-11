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

ARG DEBIAN_TAG=bookworm-slim
ARG RUST_VERSION=1.96.1
# Python-Grammatik = Interpreter der Endstufe: neueste stabile Version, damit neue Syntax (PEP 695/701/758) kein
# Fehlalarm wird. Beim Anheben den FP-Lauf wiederholen (pruef-container-fp.mjs python).
ARG PYTHON_TAG=3.14-slim-trixie
ARG GO_TAG=1.26-trixie
ARG FISSIX_VERSION=24.4.24
# E3a: Debian-Pakete der Endstufe (trixie: PHP 8.4, Ruby 3.3, Lua 5.4). Beim Anheben FP-Lauf wiederholen.
ARG APT_PAKETE="php8.4-cli ruby lua5.4 make"
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

# ─── Endstufe: Python-Basis (Interpreter fuer Pruefserver und Python-ast), bash ist enthalten ───
FROM python:${PYTHON_TAG}
ARG FISSIX_VERSION
ARG APT_PAKETE
ARG MESON_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ${APT_PAKETE} \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
# fissix (lib2to3-Fork, reiner Python-Parser) nur fuer den Python-2-Rueckfall; danach pip entfernen (wird zur
# Laufzeit nicht gebraucht, spart Platz und Angriffsflaeche).
RUN pip install --no-cache-dir --root-user-action=ignore --target /opt/pruef/py "fissix==${FISSIX_VERSION}" "meson==${MESON_VERSION}" \
 && rm -rf /opt/pruef/py/fissix/tests \
 && python3 -m pip uninstall -y --root-user-action=ignore pip \
 && rm -rf /usr/share/doc /usr/share/man /usr/share/locale /root/.cache
COPY --from=rust --chmod=0555 /out/bin/ /opt/pruef/bin/
COPY --from=rust --chmod=0555 /out/lib/ /opt/pruef/lib/
COPY --from=go --chmod=0555 /out/bin/ /opt/pruef/bin/
COPY --from=naga --chmod=0555 /out/naga/bin/naga /opt/pruef/bin/naga
COPY --from=pruefgo --chmod=0555 /out/bin/pruefgo /opt/pruef/bin/pruefgo
COPY --from=binutils --chmod=0555 /out/bin/ld /opt/pruef/bin/ld
COPY --from=binutils --chmod=0555 /out/lib/ /opt/pruef/lib/
COPY --from=go --chmod=0444 /out/versionen/go /opt/pruef/versionen/go
COPY --from=jvm --chmod=0555 /out/jvm/ /opt/pruef/jvm/
COPY --from=jvm --chmod=0444 /out/versionen/kotlin /out/versionen/java /out/versionen/scala /out/versionen/groovy /opt/pruef/versionen/
COPY --chmod=0444 pruefserver.py pruefer_jvm.py pruefer_naga.py pruefer_build.py /opt/pruef/
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
 && chmod -R a+rX /opt/pruef/cache /opt/pruef/versionen && ls -la /opt/pruef/cache/fissix/*/
LABEL synapse.pruefcontainer="1" org.opencontainers.image.title="synapse-pruefcontainer"
USER 65532:65532
WORKDIR /opt/pruef/leer
ENTRYPOINT ["python3", "-u", "/opt/pruef/pruefserver.py"]
