# Agenten-Runtime-Image

[Synapse](../../README.md) › [Docker-Umgebung](../README.md) › Agenten-Runtime-Image

## Zweck

Das Image `synapse-agent-runtime` ist die Grundlage für Hauptagent und Spezialisten im Container (P22, Architektur B): Der Synapse-Daemon läuft im Container im Startprofil `runtime`, daneben liegen Claude Code und Codex als versionierte Installationen. Identität, Kontingent, Policy und Daten bleiben bei der Synapse-API; der Container hat keinen Datenbankzugang.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [Dockerfile](Dockerfile) | Baut Daemon/Wrapper (pnpm deploy), legt ein CLI-Bundle in exakten Versionen an und erzeugt das Laufzeit-Image. |
| [Dockerfile.dockerignore](Dockerfile.dockerignore) | Hält `node_modules`, `dist` und fremde Pakete aus dem Build-Kontext. |

## Funktionsweise

### Startprofil runtime

Der Container startet `node /opt/synapse/current/dist/runtime-main.js` ([runtime-main.ts](../../packages/file-watcher-daemon-ts/src/runtime-main.ts), [startprofile/runtime.ts](../../packages/file-watcher-daemon-ts/src/startprofile/runtime.ts)). Gestartet werden nur Runtime-Fähigkeiten: Bereitstellung des CLI-Bundles, CLI-Autoupdate, Anzeige des API-Zugangs und die Statusdatei `/state/executor/status.json`. Watcher, Sync, Shell-Worker, Project-Init, PC-Heartbeat, Tray-Dateien, die lokale PC-API und die API-Weiterleitung (7879) laufen hier nicht. Der DB-Zugang ist gesperrt, auch wenn eine `DATABASE_URL` gesetzt wäre.

Die Agentensteuerung (Aufträge holen, Wrapper starten) ist in diesem Stand noch aus: Sie kommt mit dem Runtime-Daemon-Zugang und Runtime-`agent_start` (P22-T5) und dem persistenten Wrapper (P22-T6). Den API-Zugang liest der Daemon wie am PC aus `~/.synapse/file-watcher/config.json` (`synapse_api_url`, `synapse_api_token`); im Container schreibt ihn die API, nachdem der User den Runtime-Daemon-Zugang in der Web-UI ausgestellt hat.

### CLI-Versionen

Jede CLI-Version liegt in einem eigenen Verzeichnis `~/.local/share/synapse-cli/<cli>/versions/<version>/` mit `synapse-version.json`; aktiv ist, worauf der Launcher-Symlink `~/.local/bin/<cli>` zeigt ([cli-versionen.ts](../../packages/file-watcher-daemon-ts/src/cli-versionen.ts)). Claude Code wird mit dem offiziellen nativen Installer in einem Wegwerf-HOME unter `~/.local/share/synapse-cli/.installer-tmp` installiert (nicht in `/tmp`: das tmpfs der Runtime-Container hat 256 MB) und von dort übernommen, damit der Installer weder den aktiven Launcher noch alte Versionen anfasst. Codex wird per `pnpm add @openai/codex@<version>` in sein Versionsverzeichnis installiert; der pnpm-Store liegt unter `~/.local/share/synapse-cli/.pnpm-store`.

Ein Update installiert die neue Version daneben, prüft `--version` und tauscht danach nur den Symlink. Laufende Agenten behalten ihre Dateien und werden nicht beendet; der nächste Start nimmt die neue Version. Wie am PC bleiben nach einem Update die neuesten vier Versionen liegen, ältere werden entfernt (`SYNAPSE_RUNTIME_CLI_BEHALTEN`, `--behalten`, `cli aufraeumen`). Nie entfernt werden die aktive Version, das Rollback-Ziel und Versionen, aus denen gerade ein Prozess läuft. Der native Claude-Updater wird bewusst nicht benutzt, weil er alte Versionen selbst löscht und damit den Rollback wegnimmt. Jede Installation, Umschaltung und jedes Rollback steht mit Quelle (`manuell`, `automatisch`, `bundle`, `auftrag`) und Akteur in `~/.local/share/synapse-cli/<cli>/verlauf.jsonl`.

Liegt unter `~/.local/bin/<cli>` ein fremder Launcher (zum Beispiel die bisherige npm-Installation der heutigen Runtime-Container), ersetzt weder Bundle noch Autoupdate ihn. Erst ein ausdrückliches `use` oder `update` schaltet um; eine echte Datei wird dabei als `<cli>.vor-synapse-<zeit>` beiseitegelegt, und `rollback` stellt den alten Stand wieder her.

### Bedienung

    docker exec <container> synapse-runtime status
    docker exec <container> synapse-runtime cli list
    docker exec <container> synapse-runtime cli update claude            # latest
    docker exec <container> synapse-runtime cli update codex 0.163.0
    docker exec <container> synapse-runtime cli use claude <version>
    docker exec <container> synapse-runtime cli rollback claude
    docker exec <container> synapse-runtime cli aufraeumen codex 3
    docker exec <container> synapse-runtime cli verlauf codex 20

Ausgabe ist JSON. `install` installiert nur, `update` installiert und schaltet um, `--erzwingen` erlaubt eine Rückstufung per `update`.

### Startkonfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `SYNAPSE_RUNTIME_NAME` | – | `claude` bzw. `codex`; setzt der Containerstart (nicht das Image, das für beide Runtimes gilt). Ohne den Wert startet die Agentensteuerung (P22-T6) nicht. Der Daemon meldet sich damit als `synapse-runtime-<name>` (= `container_name`, daran ist der Runtime-Daemon-Zugang gebunden; Daemon-ID `daemon-synapse-runtime-<name>-<pid>`). Ein `--hostname` ist nicht nötig. |
| `SYNAPSE_RUNTIME_CLI_AUTOUPDATE` | an | Automatisches Update von Claude und Codex durch den Daemon. Von der API angelegte Container setzen `0`: Das Update entscheidet dort die API (`synapse-runtime cli update` per docker exec, immer an, unabhängig vom Schalter `runtime_ueberwachung`; abschaltbar nur über die Einstellung `cli_update_automatisch`). |
| `SYNAPSE_RUNTIME_CLI_AUTOUPDATE_STUNDEN` | `24` | Abstand der Autoupdate-Läufe; erster Lauf 5 Minuten nach dem Start. |
| `SYNAPSE_RUNTIME_CLI_KANAL_CLAUDE` / `_CODEX` | `latest` | npm-dist-tag oder exakte Version als Ziel des Autoupdates. Das Autoupdate stuft nie zurück und ersetzt keinen fremden Launcher. |
| `SYNAPSE_RUNTIME_CLI_BEHALTEN` | `4` | Wie viele Versionen je CLI nach einem Update höchstens bleiben (wie der Claude-Updater am PC); `0` = alle, `1` wird zu `2` (aktive + Rollback-Ziel). |
| `SYNAPSE_RUNTIME_CLIS` | `claude,codex` | Welche CLIs der Daemon verwaltet. |
| `SYNAPSE_RUNTIME_STATE_DIR` | `/state/executor` | Ort von `status.json`. |
| `SYNAPSE_RUNTIME_RUN_DIR` | `/tmp/synapse-runtime` | PID-Marker (ephemer). |
| `SYNAPSE_CLI_BASIS` / `SYNAPSE_CLI_LAUNCHER_DIR` | `~/.local/share/synapse-cli` / `~/.local/bin` | Installbereich und Launcher. |

Die Statusdatei zeigt Profil, Image-Revision, Daemon- und Node-Version, jeden Konfigurationswert mit Quelle (`env` oder `standard`), den Zustand jeder Komponente mit Grund, alle CLI-Versionen samt aktivem Launcher, das letzte Autoupdate-Ergebnis und den letzten Fehler. Zugangswerte stehen nie darin.

Ob der Hauptagent überhaupt arbeitet, entscheidet weiter allein der Produkt-Schalter `hauptagent` auf der API (Standard AUS, mit befristetem intern-Override). Ohne ausgestellten Zugang bekommt der Daemon keine Arbeit.

## Umstellung bestehender Container

Die laufenden Runtime-Container (`synapse-runtime-claude`, `synapse-runtime-codex`) bleiben unverändert; `claude-driver.ts` und `codex-driver.ts` installieren dort weiterhin wie bisher. Der Wechsel auf dieses Image ist ein eigener, vom User freigegebener Betriebsschritt: Image bauen und taggen, in `AGENT_RUNTIME_ALLOWED_IMAGES` aufnehmen, Runtime mit demselben Root (`/mnt/z/dockdata/synapse-agent-runtime/<runtime>`, siehe [runtime-root.ts](../../packages/rest-api/src/services/agent-runtime/runtime-root.ts)) neu konfigurieren. Auth (`/root/.claude`, `/root/.claude.json`, `/root/.codex`) und die bisherige Installation unter `/root/.local` bleiben dabei erhalten; der Launcher wechselt erst mit einem ausdrücklichen `synapse-runtime cli use|update`.

## Verwaltete Synapse-Mod (P22-T194)

Quelle sind `mods/synapse-inbox` und der explizite Marketplace `mods/.claude-plugin/marketplace.json`. Der Imagebau paketiert ausschließlich diese Mod unter `/opt/synapse/<revision>/mods`, mit Version und SHA256 je Datei. Der Runtime-Daemon legt nach dem HOME-Mount `/root/.claude/synapse-mods/<revision>` als Verweis auf das geprüfte Image-Paket an. Die Arbeitskopie `/projects/synapse/mods` ist kein Produktions-Ladepfad. Ein COPY nach /root allein würde durch den persistenten HOME-Mount verdeckt.

`/etc/claude-code/managed-settings.json` ruft den Image-policyHelper auf. Er erzeugt je CLI-Prozess die vollständige managed Policy aus dem API-Startstand: `allowManagedHooksOnly:true`, genau `synapse-inbox@synapse-runtime`, der eingebaute Guard bleibt erhalten. `disableAllHooks` wird nur für die freigegebenen verwalteten Komponenten aufgehoben. Der enge T190-Read-Guard steht in derselben Policy, mit unverändertem Pfad-/Symlink-Vertrag, PG-Zeitlimit und `onFailure:block`. Benutzer-, Projekt- und fremde Plugin-Hooks bleiben gesperrt; `--mcp-config` bleibt nutzbar.

Der Produkt-Schalter `runtime_synapse_mods` ist Standard AUS, global/projektbezogen über admin profil_schalter_setzen und die bestehende Profilverwaltung einstellbar; ein intern-Override ist ausschließlich befristet. Ein neuer Start übernimmt den Stand. `cache_waechter` (ebenfalls Standard AUS) schaltet zusätzlich die Messung frei. `SYNAPSE_RUNTIME_MOD_POLICY=1` und der Marketplace-Pfad sind Image-Infrastruktur, keine zweite Schalterquelle. Bei Schalter AUS (Standard) startet `process.ts` nicht verwaltet: der policyHelper (`runtime-mod-policy-helper.js`) gibt `{"managedSettings":{}}` aus, ohne Paketprüfung, und die CLI läuft mit denselben Argumenten wie ohne dieses Image (`--settings` mit `disableAllHooks` bzw. T190-Guard). Nur bei EIN setzt `process.ts` für den CLI-Prozess `SYNAPSE_RUNTIME_MOD_VERWALTET=1`; erst dann gilt die vollständige managed Policy. Die Wrapper-Cache-Telemetrie läuft nur, wenn `cache_waechter` beim Start EIN war (`SYNAPSE_CACHE_WAECHTER_START=1` im API-Startstand); sonst ruft der Wrapper `/cache-waechter` nie ab. Ein defektes Mod-Paket stoppt den Runtime-Daemon nicht (Status `runtime-mods` aus mit Fehler). Der Runtime-Status zeigt Paketpfade, Revision, Version und Hash; Start-/Cache-Debug zeigt Quelle, Ablauf, Messung und Fehler.

Im Container startet die gemeinsame Mod nur Cache-Telemetrie. Sie meldet über einen eigenen Unix-Socket an ihren Wrapper; dieser verwendet den vorhandenen authentifizierten API-Transport. Keine Mod-Inbox, kein prompt.submit und kein eigener Weckweg. Mod und Wrapper bleiben getrennte Messquellen derselben Sitzung; Tokenwerte werden nicht addiert. TTL-Zeiten sind Schätzungen, kein bewiesener Cache-Ablauf.

Dieses Image erfordert die nachgewiesene CLI-Kompatibilität mit managed Mods und policyHelper (Testphase mit gepinnter CLI). Laufende Runtimes werden weder beim Commit noch beim Schalten aktualisiert oder neu gestartet; die Umstellung bleibt der eigene freigegebene Deploy-Schritt.

## Abhängigkeiten

Basis ist `node:22-bookworm-slim` mit `ca-certificates`, `curl`, `bash`, `git` und `procps`; pnpm kommt fest versioniert über corepack. Die Pakete stammen aus [file-watcher-daemon-ts](../../packages/file-watcher-daemon-ts/README.md), [agents](../../packages/agents/README.md) und [core](../../packages/core/README.md).

## Siehe auch

- [Daemon-Quellcode](../../packages/file-watcher-daemon-ts/src/README.md)
- [Docker-Umgebung](../README.md)
