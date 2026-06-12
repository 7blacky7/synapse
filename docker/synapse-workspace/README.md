# synapse-workspace — Docker-Image fuer die Projekt-Sandboxen

Das Image hinter `workspace`/`shell(isolated:true)`. Seit Plan **WS2**
(2026-06-12) auf **volle KI-Selbstbedienung** ausgelegt: bauen, linken,
debuggen, testen und ausfuehren — ohne Host-Eingriff.

## Bauen (Unraid / Build-Host mit Netz)

```bash
cd docker/synapse-workspace
docker build -t synapse-workspace:latest .
# danach: laufende Workspace-Container neu starten (workspace stop/start),
# damit Image + neues HOME-Volume greifen.
```

Erwartete Groesse: **~6–7 GB** (bewusst akzeptiert; User-Entscheid).
Schlankere Projekte: eigenes Image via `workspace(configure, image: ...)`.

## Was drin ist (Tier 1, Quelle: Memory workspace-test-tools-roadmap)

| Bereich | Inhalt |
|---|---|
| Toolchain | gcc/g++/make, cmake, ninja, meson, ccache (PATH-transparent), pkg-config, git |
| Dev-Libs (linken!) | sqlite3, SDL2/_image/_ttf/_mixer, curl, OpenSSL, zlib, png/jpeg/freetype, ncurses, readline, pcre2, libpq, xml2, yaml, boost |
| Debug/Analyse | gdb, lldb, valgrind, strace, ltrace, cppcheck, clang/clang-tidy, **lld** (ld.lld/lld-link), shellcheck, patchelf; Sanitizer via `-fsanitize=address,undefined,...` |
| Tests | googletest (gebaut, `-lgtest`), catch2 (v2), pytest; jest/vitest pro Projekt via npm |
| Multimedia/GL | Mesa (GL **und** Vulkan, llvmpipe Software-Rendering), OpenAL, ALSA/Pulse, ffmpeg, **Xvfb** (headless GUI/SDL), Browser-Runtime-Libs (fuer selbstinstallierte Playwright-Browser) |
| Windows | MinGW gcc/g++ (Cross-Build), **wine** 8.0 (.exe ausfuehren; Launcher heisst `wine`, nicht `wine64`), `/opt/mingw-extras` (sqlite3 + SDL2/_image als MinGW-Libs) |
| Cross/Embedded | aarch64/armhf/riscv64-GCC (+g++), arm-none-eabi (+newlib), AVR, **qemu-user-static** (Binaries direkt ausfuehren) |
| System-Emulation/Boot | **qemu-system** x86_64 + ARM64 (TCG, kein KVM noetig), qemu-utils, **OVMF/AAVMF** (UEFI-Firmware), **grub-mkrescue** (grub-pc-bin + grub-efi-amd64-bin), xorriso, mtools — Boot-ISOs bauen UND booten |
| Services (WS4-Rollen) | **PostgreSQL 15** (Server-Binaries, PATH enthaelt /usr/lib/postgresql/15/bin), **redis-server**, **uv** (/usr/local/bin) — laufen als User synapse, Daten im HOME-Volume, Start via Rollen-`init_command` |
| Runtimen | Node 20 + pnpm, Python 3 (+venv/dev), **Rust** (/opt/rust, stable + clippy/rustfmt + Targets windows-gnu/aarch64/wasm32), **Go** (/usr/local/go), OpenJDK 17 headless, Ruby, PHP-CLI |

## Selbstbedienungs-Architektur (warum das funktioniert)

1. **/home/synapse ist ein persistentes Volume pro Projekt** (WS2-A1,
   `synapse-workspace-home-<project>`): pip --user, npm-Caches, cargo install,
   rustup-Eigentoolchains, ccache, venvs, WINEPREFIX — alles ueberlebt
   Container-Restarts. Kaputt? → `workspace(reset_home)` (WS2-A2).
2. **Netz vorhanden** (deb/pypi/npm/github erreichbar) — Registries gehen,
   `apt` aber NICHT (ReadonlyRootfs, kein root): Systempakete kommen NUR
   uebers Image. Fehlt eines dauerhaft → hier ins Dockerfile + Rebuild.
3. **ENV-Ergonomie**: `PIP_BREAK_SYSTEM_PACKAGES=1` (PEP-668-Override, in der
   Sandbox legitim), `CARGO_HOME`/`GOPATH`/`CCACHE_DIR` → HOME-Volume,
   ccache-Wrapper im PATH, `git safe.directory=*` (Quellen gehoeren root).
4. **/tmp ist tmpfs mit exec** (WS2-A1) — kompilierte Wegwerf-Binaries laufen.

### Kochrezepte fuer die KI

```bash
# Python: venv im HOME (persistent) ODER direkt pip install --user
python3 -m venv ~/venvs/foo && ~/venvs/foo/bin/pip install requests

# Windows-Build + AUSFUEHREN (headless):
x86_64-w64-mingw32-gcc app.c -I/opt/mingw-extras/include \
  -L/opt/mingw-extras/lib -lsqlite3 -lSDL2 -o app.exe
WINEDLLOVERRIDES="mscoree,mshtml=" xvfb-run -a wine app.exe

# ARM bauen + sofort ausfuehren (kein binfmt noetig):
aarch64-linux-gnu-gcc -static t.c -o t && qemu-aarch64-static ./t

# GL/Vulkan headless: xvfb-run -a glxinfo | head; vulkaninfo --summary
# Rust-Sondertoolchain selbst ziehen (Image-Toolchain ist read-only):
RUSTUP_HOME=$HOME/.rustup rustup toolchain install nightly
```

## Bewusste Auslassungen (+ Selbstbedienungs-Weg)

- **.NET**: `dotnet-install.sh` ins HOME. **emscripten**: emsdk ins HOME.
  **wasmtime**: `cargo install wasmtime-cli`. **Playwright-Browser**:
  `npx playwright install chromium` (Systemlibs sind im Image).
- **wine32**: nur x64-Windows-Binaries (eigene MinGW-x86_64-Builds reichen).
- **Android (NDK/SDK/Emulator), KVM/QEMU-system, DinD**: eigenes
  **Tier-2-Image** (Privilegien/Devices noetig) — siehe Roadmap-Memory;
  Matrix-Idee: `synapse-workspace-android`, via configure pro Projekt setzbar.
- **macOS**: unmoeglich ohne Apple-HW (Tier 3); WebKit-Tests via Playwright.

## Versions-Pins (Layer 7/8) — Update-Anleitung

| Pin | Wert | Update |
|---|---|---|
| sqlite-Amalgamation | 3450300 (2024er-Pfad) | sqlite.org/download → ENV `SQLITE_AMALGAMATION` + Jahres-Pfad in Layer 7 |
| SDL2-mingw | 2.30.5 | github.com/libsdl-org/SDL releases → ENV `SDL2_MINGW_VERSION` |
| SDL2_image-mingw | 2.8.2 | analog `SDL2_IMAGE_MINGW_VERSION` |
| Go | 1.23.4 | go.dev/dl → ENV `GO_VERSION` |
| Node | 20 (NodeSource) | ENV `NODE_VERSION` |
| Rust | stable zur Buildzeit | Rebuild zieht aktuelles stable |

Alle Pins + kritische Paketnamen wurden am 2026-06-12 gegen die Quellen
verifiziert (HTTP 200). Bricht ein Download im Build: Pin pruefen.


## Multi-Workspace (WS3): Backend + App im selben Netz testen

Pro Projekt sind mehrere **benannte Workspaces** moeglich (Cap via ENV
`SYNAPSE_WS_PER_PROJECT_CAP`, Default 6; Param `name`, Default `main`;
Regex `^[a-z0-9][a-z0-9-]{0,19}$`). Alle teilen sich das
`/workspace`-Volume (eine Quelle, ein PG-Sync), haben aber **eigenes**
Home-Volume, eigene Caps und eigenes Image (`configure` mit `name`).
DNS im proxynet = Container-Name: `main` heisst wie bisher
`synapse-ws-<projekt>`, benannte heissen `synapse-ws-<projekt>-<name>`.

Kochrezept Netzwerk-Integrationstest (Backend ↔ Client):

```text
1. workspace(configure, project, name:"server", mem_limit_mb: 1024)   # optional
2. workspace(exec, project, name:"server",
     command:"node server.js &", expose_ports:[3000])
   → internal_urls: { 3000: "http://synapse-ws-<projekt>-server:3000" }
3. shell(exec, project, isolated:true, workspace:"app",
     command:"curl -s http://synapse-ws-<projekt>-server:3000/health")
   → echter HTTP-Roundtrip ueber das Docker-Netz, wie im Einsatz.
4. workspace(pin, project, name:"server")   # Server gegen Idle-Stop schuetzen
5. reset_home/stop wirken pro Workspace (name mitgeben).
```

Hinweise: Builds besser im Home (`~/build-server`, `~/build-app`) oder in
getrennten Unterordnern ausfuehren — `/workspace` ist geteilt, parallele
Builds in denselben Output-Ordner (z.B. `dist/`) beissen sich. Der globale
Container-Cap (LRU) zaehlt weiterhin Container, nicht Projekte.


## Workspace-Rollen (WS4): Rolle = Template, Instanz = Geraet

Rollen sind editierbare Templates (image, caps, `init_command`) — global
oder projekt-scoped, **NIE fest**: `workspace(role_set/role_list/role_delete)`
(`project` weglassen = global; projekt-scoped schlaegt global). Jede Rolle ist
**beliebig oft instanziierbar**; der Workspace-Name bleibt frei (db-1, db-2,
app, qa, ...). `init_command` laeuft nach JEDEM Container-Start als User
synapse (Dienste-Bootstrap, 120s Timeout; Fehler → `last_error`, Container
bleibt nutzbar; Template-Edits wirken ab dem naechsten Start).

Seed-Rollen (nur Startpunkt): `dev`, `server`, `app`, `wine-qa`,
`db-postgres` (initdb in `$HOME/pgdata` + pg_ctl start, Port 5432, Socket
`/tmp`), `db-redis` (Port 6379, Persistenz im HOME).

Kochrezept "3 Geraete" (db ↔ app ↔ wine-qa):

```text
1. workspace(exec, project, name:"db-1", role:"db-postgres",
     command:"pg_isready -h /tmp")    # Instanz entsteht lazy, init faehrt PG hoch
2. workspace(exec, project, name:"app", role:"server",
     command:"node server.js &", expose_ports:[3000])
   # app erreicht die DB: postgres://synapse@synapse-ws-<projekt>-db-1:5432
3. workspace(exec, project, name:"qa", role:"wine-qa",
     command:"curl -s http://synapse-ws-<projekt>-app:3000/health")
   # + Windows-Client: WINEDLLOVERRIDES="mscoree,mshtml=" xvfb-run -a wine client.exe
4. Zweite DB? name:"db-2", role:"db-postgres" — gleiche Rolle, neue Instanz.
   Rollen sind Templates, keine Slots.
```

Ehrlichkeit Mobile: echtes iOS ist ohne Apple-HW unmoeglich (Tier 3);
Android-Emulator braucht KVM → Tier-2-Image, andockbar als Rolle
(`role_set` mit eigenem `image`). Das Muster "N Geraete im selben Netz"
funktioniert heute mit Linux-Instanzen.
