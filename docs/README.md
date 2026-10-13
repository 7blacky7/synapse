# Zusammenhang der Synapse-Komponenten

[Synapse](../README.md) › Dokumentation

## Zweck

Diese Seite verbindet die Paketdokumentation mit Ansichten des implementierten Systems. Die Bilder zeigen Zugänge, Datenhaltung, Agenten, Ausführung und Embedding. Einzelheiten stehen in den verlinkten Ordner-READMEs; Entwürfe liegen getrennt unter [Konzepte](konzepte/README.md).

## Inhalt

| Datei / Unterordner | Aufgabe |
| --- | --- |
| [bilder/README.md](bilder/README.md) | SVG-Vorschauen mit Quellenübersicht |
| [konzepte/README.md](konzepte/README.md) | Architekturentwürfe; Umsetzung jeweils gesondert prüfen |

## Gesamtbild

![Lokaler MCP-Server und REST-API verwenden Core, PostgreSQL und Qdrant.](bilder/ueberblick.svg)

Der [MCP-Server](../packages/mcp-server/README.md) und die [REST-API](../packages/rest-api/README.md) nutzen die gemeinsamen [Core-Dienste](../packages/core/README.md). [PostgreSQL](../packages/core/src/db/README.md) hält die maßgeblichen Inhalte und Metadaten. [Qdrant](../packages/core/src/qdrant/README.md) enthält daraus abgeleitete Vektoren für die semantische Suche.

## Variante: lokale KI

![Lokale KI über stdio; der Daemon synchronisiert PostgreSQL und Arbeitsverzeichnis.](bilder/lokal.svg)

Claude Code oder Codex können den MCP-Server als lokalen Prozess über stdio ansprechen. Der [TypeScript-Daemon](../packages/file-watcher-daemon-ts/README.md) startet Watcher sowie Worker für beide Synchronisationsrichtungen zwischen PostgreSQL und Dateisystem. Seine Shell-Worker führen auf dem lokalen Rechner zugewiesene Aufträge aus.

## Variante: Web-Zugang

![claude.ai und Browser erreichen den API-Container über einen vorgeschalteten Tunnel.](bilder/web.svg)

claude.ai verwendet HTTP-MCP; die [Web-UI](../packages/web-ui/README.md) verwendet REST unter `/api`. Die API registriert Authentifizierung, MCP und REST-Routen und liefert auch die gebaute Web-UI aus. Ein Cloudflare-Tunnel kann den externen Zugang zum API-Container bilden. Er gehört zur vorgeschalteten Infrastruktur; ein lokaler HTTP-Zugang braucht ihn nicht. Die [Container-Dokumentation](../docker/README.md) beschreibt die im Repository enthaltenen Images.

## Variante: Agententeam

![Koordinator, Channels und Events, Spezialisten-Wrapper, externer Codex-Weg sowie Jev.](bilder/agenten.svg)

Der [Spezialisten-Wrapper](../packages/agents/README.md) liest adressierte Channel-Nachrichten und weckt den verwalteten CLI-Prozess. Channels und Events liegen in PostgreSQL; ihre Dienste stehen unter [Core-Services](../packages/core/src/services/README.md). Codex kann über den externen, vom User verwalteten `cc-wrap` betrieben werden. `cc-send` dient dort als kurzes Wecksignal; die Wrapper-Implementierung liegt außerhalb dieses Repositories.

Jev kann bei aktivierter Abwesenheitsregel begrenzte Rückfragen entscheiden. Der Dienst ersetzt nicht die Zuständigkeit des Users oder Koordinators für gesperrte Entscheidungskategorien.

## Variante: Shell-Ausführung und Syntaxprüfung

![REST-Shell wählt Daemon oder Workspace; Dateiprüfungen laufen separat im Prüfcontainer.](bilder/ausfuehrung.svg)

[Shell-Startprüfung und Laufzeit](bilder/shell.svg) · [Syntaxprüfung und Erklärungsfälle](bilder/pruefung.svg)

Im REST-MCP-Pfad wählt `target=auto` den lokalen Daemon bei frischem Heartbeat, andernfalls den [Workspace-Container](../docker/synapse-workspace/README.md). Ein ausdrücklich gesetztes Ziel überschreibt diese Auswahl; `isolated` erzwingt den Workspace. Der [Prüfcontainer](../docker/synapse-pruefcontainer/README.md) gehört zum Syntaxprüfpfad: Er erhält Prüfaufträge als JSON und hat keinen Netzwerkzugang. Er ist kein Shell-Ausführungsziel.

## Variante: Indexierung und Embedding

![Parser erzeugt Chunks; Server-Worker oder Compute-Nodes liefern Embeddings über Claims zurück.](bilder/embedding.svg)

Der [Parser](../packages/core/src/parser/README.md) zerlegt Quelltext in Symbole und Chunks. Die Inhalte und der Arbeitsstand liegen in PostgreSQL. Server-Worker oder [Compute-Nodes](../packages/compute-node-agent/README.md) bearbeiten Embedding-Claims mit Ollama; zurückgelieferte Vektoren werden vor dem Eintrag in Qdrant geprüft. Compute-Nodes liefern Ergebnisse über die API zurück und benötigen keinen direkten Qdrant-Zugriff.

Das [Embedding-Modul](../packages/core/src/embeddings/README.md) verwendet konfigurierte Modellwerte. Nemotron-3-Embed-1B ist ein dokumentiertes Modellprofil; Modell und Dimension sind keine festverdrahteten Fallbacks.

## Funktionsweise im Detail

### Tray und Daemon

Tray-Aktionen, SSE und Polling führen zu sichtbarem Status; der Daemon verbindet Registry, Watcher, Dateisynchronisation und lokale Aufträge. [Tray](../packages/file-watcher-daemon/tray/README.md#funktionsweise) · [Daemon](../packages/file-watcher-daemon-ts/src/README.md#funktionsweise).

[Schaubild tray](bilder/tray.svg) · [Schaubild daemon](bilder/daemon.svg)

### Dateiänderungen

Ein gemeinsamer Entwurf durchläuft Prüfung und PG-Commit. Versionierung, Co-Edit und die getrennte Plattenbestätigung machen die Grenzen sichtbar. [Schreibweg](../packages/core/src/services/README.md#dateiänderungen-co-edit-und-platten-synchronisation).

[Schaubild files](bilder/files.svg)

### Shell und Workspaces

Zielwahl, Startprüfung und Prozessende sind getrennte Entscheidungen. Workspace-Zustände erklären Bereitstellung, Materialisierung und Ressourcen. [Shell](../packages/core/src/services/README.md#shell-ausführung-und-workspaces) · [Workspaces](../packages/rest-api/src/services/README.md#funktionsweise-workspaces).

[Schaubild shell](bilder/shell.svg) · [Schaubild workspace](bilder/workspace.svg)

### Kommunikation

Channels, Chat, Inbox und Events speichern unterschiedliche Arten von Nachrichten. Hinweis, tatsächliches Lesen und Quittierung besitzen eigene Zustandsmarken. [Zustellung und Lesestand](../packages/core/src/services/README.md#kommunikation-und-hinweiszustellung).

[Schaubild kommunikation](bilder/kommunikation.svg)

### Spezialisten-Wrapper

Wrapper und CLI sind getrennte Prozesse. Ereignisse, Heartbeats, Status und Kontextwechsel bestimmen Aktivierung, Rotation und Wiederanlauf. [Wrapper](../packages/agents/src/README.md#funktionsweise).

[Schaubild wrapper](bilder/wrapper.svg)

### Jev

Schalter, erlaubte Kategorien, Präzedenz und Confidence begrenzen Entscheidungen. Budget, Fehlerpfade und Durchsicht bleiben eigene Prüfungen. [Entscheidungsweg](../packages/core/src/services/README.md#jev-und-entscheidungen).

[Schaubild jev](bilder/jev.svg)

### Syntaxprüfung

Die Prüfung vor dem Schreiben und die asynchrone Erklärung eines Fehlers sind getrennte Wege. Prüferausfälle und unvollständige Ergebnisse haben ausdrücklich beschriebene Grenzen. [Prüfung und Erklärungsfälle](../packages/core/src/services/README.md#syntaxprüfung-und-erklärungsfälle).

[Schaubild pruefung](bilder/pruefung.svg)

### Indexierung und Assets

Parser erzeugen Strukturen und Chunks; Claims verteilen die Embedding-Arbeit. Binäre Assets verwenden einen eigenen begrenzten Inspektionspfad. [Parser](../packages/core/src/parser/README.md#funktionsweise) · [Embedding](../packages/core/src/embeddings/README.md#funktionsweise) · [Assets](../packages/core/src/asset-intel/README.md#funktionsweise).

[Schaubild embedding](bilder/embedding.svg) · [Schaubild asset](bilder/asset.svg)

### Authentifizierung und Projekte

Tokenprüfung schützt die HTTP-Grenze; Rollen und Onboarding bestimmen den Projektkontext. Eine Registry-Zuordnung und ein ausdrücklicher Init-Auftrag bleiben verschiedene Vorgänge. [Authentifizierung](../packages/rest-api/src/services/README.md#funktionsweise-authentifizierung) · [Onboarding und Anlage](../packages/core/src/services/README.md#authentifizierung-onboarding-und-projektzuordnung).

[Schaubild auth](bilder/auth.svg)

### Web-Oberfläche und Wissen

Adapter verbinden Ansichten mit Datenquellen; Runtime-Sitzungen liefern Ereignisströme. Direkte Wissensabrufe lesen PG, semantische Suche verwendet den abgeleiteten Index. [Web-UI](../packages/web-ui/src/README.md#funktionsweise) · [Runtimes](../packages/rest-api/src/services/agent-runtime/README.md#funktionsweise) · [Wissen](../packages/core/src/services/README.md#web-oberfläche-hauptagenten-und-wissenszugriff).

[Schaubild ui](bilder/ui.svg)

## Schnittstellen nach außen

| Schnittstelle | Verbindung |
| --- | --- |
| stdio-MCP | Lokaler KI-Client ↔ MCP-Server |
| HTTP-MCP / REST | Web-KI oder Web-UI ↔ REST-API |
| PostgreSQL / Qdrant | Core ↔ maßgebliche Daten bzw. Suchindex |
| Lokales Dateisystem | Daemon ↔ Projektdateien |
| Docker-Ausführung | API ↔ Workspace bzw. separater Prüfcontainer |
| Ollama / Compute-Node-API | Embedding-Arbeit ↔ konfigurierte Recheninstanzen |

## Abhängigkeiten

Die Varianten teilen Core und die Datenspeicher. Lokale Dateisynchronisation setzt den Daemon voraus; Container-Ausführung und Syntaxprüfcontainer benötigen die jeweilige Container-Anbindung. Cloudflare und `cc-wrap` sind externe Komponenten. Die Bilder sind eigenständige SVGs mit festem dunklem Hintergrund in der GitHub-Primer-Dark-Palette, orangenen Akzenten, heller Beschriftung und mindestens 16 px Schrift und ohne externe Bild- oder Schriftressourcen.

## Siehe auch

- [Pakete](../packages/README.md)
- [Quellenbelege und alle Bilder](bilder/README.md)
- [Konzepte](konzepte/README.md)
