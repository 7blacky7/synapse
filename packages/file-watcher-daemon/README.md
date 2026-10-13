# Synapse FileWatcher Daemon (Moo-Variante)

## Einordnung im aktuellen System

Diese README beschreibt den älteren Moo-Watcher in `src/*.moo`. Der TypeScript-Daemon in [`../file-watcher-daemon-ts`](../file-watcher-daemon-ts/src/main.ts) übernimmt zusätzlich die direkte Core-Anbindung, PG↔Dateisystem-Synchronisation sowie Shell-, Specialist- und Project-Init-Worker. Die Tray-Oberflächen liegen daneben in [`tray/`](tray/) (Moo und Go); sie sind vom Watcher-Prozess getrennt.

Für den TypeScript-Daemon vom Repo-Root aus:

```bash
mise run build:core
pnpm run build:agents
mise run build:mcp
pnpm --filter @synapse/file-watcher-daemon-ts run build
pnpm --filter @synapse/file-watcher-daemon-ts run start
```

Konfiguration und Discovery-Dateien des TS-Daemons liegen ebenfalls unter `~/.synapse/file-watcher/`. Nicht gleichzeitig zwei Daemons für dieselben Projekte starten. Die folgenden Build-/API-Angaben gelten für die Moo-Variante, nicht als vollständige Beschreibung des TS-Daemons.

Siehe auch [Architektur und Tests](../../README.md).


Eigenständiger Hintergrund-Prozess in **moo**, der Projekte auf
Datei-Änderungen pollt und sie per HTTP-API verwaltet. Läuft unabhängig
vom MCP-Server — MCP-Shutdown tötet den Daemon **nicht**.

## Build

```bash
cd src
moo-compiler compile daemon.moo -o /tmp/synapse-fwd
```

Erzeugt eine selbständige Binary.

## Start

```bash
/tmp/synapse-fwd
```

Legt Config-Verzeichnis unter `~/.synapse/file-watcher/` an:

- `config.json` — persistente Projektliste
- `daemon.pid`, `daemon.port` — Discovery
- `projects/<name>.active` — Worker-Flag-File (Stop-Signal)

Default-Port: **7878** (konfigurierbar in `config.json`).

## HTTP-API

| Method | Pfad                            | Zweck                              |
|--------|----------------------------------|-------------------------------------|
| GET    | `/health`                        | `{status, uptime_ms}`               |
| GET    | `/host/status`                   | `{online, hostname, time_ms}`       |
| GET    | `/projects`                      | Projektliste + Port                 |
| POST   | `/projects`                      | Projekt registrieren + starten      |
| GET    | `/projects/<name>/status`        | `{enabled, watcher_running, …}`     |
| POST   | `/projects/<name>/enable`        | Watcher starten                     |
| POST   | `/projects/<name>/disable`       | Watcher stoppen (Flag-File löschen) |
| DELETE | `/projects/<name>`               | Projekt entfernen                   |

### Beispiel

```bash
# Projekt registrieren
curl -X POST http://localhost:7878/projects \
  -d '{"name":"mein-projekt","pfad":"/home/.../foo"}'

# Status prüfen
curl http://localhost:7878/projects/mein-projekt/status
```

## Architektur

- **Main-Thread**: HTTP-Server (`web_server` + `web_annehmen`-Loop),
  Config-Verwaltung, spawnt Worker-Threads.
- **Pro Projekt**: ein Worker-Thread (`starte(worker_main, ctx)`),
  polling-basiert mit adaptivem Intervall (200 ms busy /
  1000 ms normal / 2000 ms idle).
- **Stop-Signal**: Flag-File `projects/<name>.active` verschwindet →
  Worker beendet sich im nächsten Zyklus.

## Event-Forwarding an Synapse-REST

Wenn `config.json` ein Feld `synapse_api_url` enthaelt (z.B.
`"http://127.0.0.1:3030/api/fs/events"`), postet jeder Worker pro
FS-Change einen Event:

```json
{
  "projekt": "mein-projekt",
  "typ": "added|modified|deleted",
  "pfad": "/abs/pfad/zur/datei",
  "mtime": 1776600000
}
```

Bei leerem Feld (Default) → nur stdout-Log, kein Netzwerk.

Gegenstueck: `packages/rest-api/src/routes/fs-events.ts` nimmt Events
entgegen und delegiert an `indexFile` / `removeFile` aus dem Core.

## Abhängigkeiten

- moo-Compiler mit First-Class-Functions
  (Branch `feat/first-class-functions` im moo-Repo, PR #1)
- `datei_mtime` / `datei_ist_verzeichnis` / `datei_mkdir` Runtime-Builtins

## Tests

Siehe `tests/` für das Test-Skript.
