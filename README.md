# 🧠 Synapse — lokales KI-Gedächtnis, Code-Intelligence & Agenten-Orchestrierung

Synapse verbindet lokale Projekte mit einer persistenten Wissensbasis und Werkzeugen für KI-Agenten. PostgreSQL hält Dateien, Wissen, Tasks und Jobs; Qdrant ergänzt die semantische Suche. Lokale MCP-Clients verwenden stdio, Web-Clients die REST-API mit MCP-over-HTTP.

Stand dieser Dokumentation: 13.10.2026. Die verbindlichen Werkzeug-Parameter kommen aus `tools/list`; `guide` erklärt die Aktionen. Nicht jedes Werkzeug ist auf jedem Transport verfügbar.

## Architektur

```text
Lokale KI-CLI ── MCP/stdio ──┐
                           ├── core ── PostgreSQL (Quelle der Wahrheit)
Web-KI / Web-UI ── REST ────┘       └── Qdrant (abgeleiteter Suchindex)
                           │
                           ├── lokaler TS-Daemon ── Dateisystem / Shell / Spezialisten
                           ├── Agenten-Wrapper ── Provider-Runtime
                           ├── Docker-Workspaces ── isolierte Builds und Tests
                           └── Prüfcontainer ── Syntaxprüfung ohne Ausführen des Codes
```

| Bestandteil | Aufgabe und Einstieg |
|---|---|
| [`packages/core`](packages/core/src/index.ts) | Gemeinsame Services, Parser, PostgreSQL-Schema, Embeddings, Qdrant, Wissens- und Dateiwerkzeuge |
| [`packages/mcp-server`](packages/mcp-server/src/server.ts) | Lokaler MCP-Server; konsolidierte Werkzeuge über stdio |
| [`packages/rest-api`](packages/rest-api/src/server.ts) | Fastify-API, MCP-over-HTTP/SSE, Authentifizierung, Workspace- und Runtime-Verwaltung |
| [`packages/agents`](packages/agents/src/wrapper.ts) | Persistente Spezialisten, Wrapper, Prozessverwaltung, Heartbeat und Kontextrotation |
| [`packages/agents-gemini`](packages/agents-gemini/src/runtime.ts) | Gemini-Runtime; CLI-/API-Konfiguration ist vom Embedding-Provider unabhängig |
| [`packages/agents-antigravity`](packages/agents-antigravity/package.json) | Weitere Provider-Integration |
| [`packages/file-watcher-daemon-ts`](packages/file-watcher-daemon-ts/src/main.ts) | TypeScript-Daemon: Watcher, PG↔Dateisystem-Sync, Shell-/Specialist-/Project-Init-Worker und lokale HTTP-API |
| [`packages/file-watcher-daemon`](packages/file-watcher-daemon/README.md) | Ältere Moo-Watcher-Variante; daneben Tray-Oberflächen in Moo und Go |
| [Tray](packages/file-watcher-daemon/tray/tray.go) | Lokale Bedienung und API-Anbindung; auch GPU-/Ollama-Helfer-Konfiguration |
| [`packages/compute-node-agent`](packages/compute-node-agent/src/index.ts) | Zusätzliche Ollama-Rechenknoten für verteilte Embedding-Arbeit |
| [`packages/web-ui`](packages/web-ui/src/App.tsx) | React-Oberfläche mit Anmeldung, Projekt-/Agenten-/Wissensansichten und Runtime-Bedienung; einzelne Oberflächen enthalten noch Mock-Daten |
| [Prüfcontainer](docker/synapse-pruefcontainer/pruefserver.py) | Sprachspezifische Parse-Werkzeuge über JSON-Zeilen; Docker-Attach, kein Netzwerk im Container |
| [Workspace-Images](docker/synapse-workspace/README.md) | Projekt-Sandboxen; [Podman-Variante](docker/synapse-workspace-podman/README.md) für Container-Builds |

### Datenfluss und Persistenz

`storeFileContent` speichert Inhalt, Hash und Metadaten zunächst in `code_files`. Parsing und Embedding laufen entkoppelt; Parser erzeugen Symbole, Referenzen, Statements und Call-Kanten. Chunks liegen in PostgreSQL und werden anschließend nach Qdrant eingebettet.

```text
Dateisystem → Watcher → code_files → Parser → strukturierter Code-Index
                                    └──────→ Chunks → Embeddings → Qdrant
files-Werkzeug → PostgreSQL + Versionen → Daemon/Workspace-Sync → Dateisystem
```

Existenz, Vollständigkeit, Regeln und direkte Wissensabrufe kommen aus PostgreSQL. Beispielsweise lesen `memory(list/read)` und Namens-/ID-Abrufe direkt aus PG; `memory(search)` verwendet Qdrant für Ähnlichkeit. Ein Vektor-Nachzug darf hinterherhinken: `embeddings_pending` bedeutet keinen Verlust des gespeicherten Inhalts.

Wichtige Tabellen sind `code_files`, `code_chunks`, `code_symbols`, `code_references`, `code_statements`, `code_call_edges`, `memories`, `thoughts`, `plans`, `proposals`, `tech_docs`, `skill_sections`, `file_versions`, `file_batch_plans`, `shell_jobs`, `specialist_jobs`, `project_init_jobs`, `agent_events`, `tool_calls` sowie Chat-/Channel-/Workspace-Tabellen. Qdrant enthält projektbezogene Collections wie `project_<name>_code` und `project_<name>_memories`.

## Aktuelle MCP-Werkzeuge

Die Liste ist mit [stdio-Register](packages/mcp-server/src/server.ts) und [REST-Register](packages/rest-api/src/routes/mcp.ts) abgeglichen. „Beide“ bezeichnet stdio und REST-MCP; einzelne Aktionen können trotzdem unterschiedliche Grenzen haben. Jev wird bei globaler Abschaltung aus der Werkzeugliste gefiltert.

| Werkzeug | Kurzzweck | Transport |
|---|---|---|
| `project` | Projekte registrieren/initialisieren, Status, Setup, Aktivierung, Projekt-Datenbank | Beide |
| `code_intel` | Baum, Funktionen, Variablen, Symbole, Referenzen, Statements, Calls, Flow, Entrypoints, Parser-Diagnose und Suche | Beide |
| `asset_intel` | Binärdateien/Assets inspizieren, Objekte und Abhängigkeiten abfragen, fehlende Referenzen und Verschiebevorschau | Beide |
| `search` | Semantische Suche nach Code, Wissen, Tech-Doku und Pfaden | Beide |
| `files` | Versionierte Dateibearbeitung, Plan/Commit, Co-Edit, Reservierungen, History und Rollback | Beide |
| `files_batch` | Separater Zugang zu denselben Batch-/Co-Edit-Aktionen für Clients mit gecachtem `files`-Schema | REST |
| `shell` | Befehle, Einzelabruf, Logs, History, Aktivität, Abbruch und Hinweis-Sichtbarkeit | Beide |
| `memory` | Dauerhaftes Projektwissen und Regeln; lesen, listen, schreiben, ändern, suchen, Dateibezug | Beide |
| `thought` | Erkenntnisse, Zwischenstände und Handoffs; optional mit Task-Verknüpfung | Beide |
| `plan` | Mehrere Projektpläne, Tasks, Prioritäten, Zuordnung und Status | Beide |
| `proposal` | Änderungsvorschläge speichern, lesen, suchen und bewerten; keine automatische Codeänderung | Beide |
| `chat` | Agenten-Adressbuch, Broadcasts, Direktnachrichten und Spezialisten-Inbox | Beide |
| `channel` | Projektbezogene Team-Boards, Mitgliedschaften, Nachrichten und Lesemarken | Beide |
| `event` | Steuersignale emittieren, offene Events lesen und bestätigen | Beide |
| `specialist` | Persistente Spezialisten starten, wecken, konfigurieren, stoppen und entfernen | Beide |
| `docs` | Tech-Doku und dateispezifischer Wissens-Airbag | Beide |
| `skills` | Skills/Sections lesen, semantisch suchen und pflegen; PG zuerst, Vektor-Nachzug danach | REST |
| `code_check` | Syntax-/Fehlermusterprüfung und generische Erklärungen/offene Fälle | Beide |
| `ignore` | Index-Sichtbarkeit und Sperrregeln prüfen und verwalten | Beide |
| `free_models` | Modell-Pool und verfügbare Modelle abfragen | stdio |
| `jev` | Erlaubte Rückfragen entscheiden, Protokoll/Durchsicht sowie Entscheidungs-Topf | Beide |
| `admin` | Statistik, Wartung und Jev-/Budget-/Kontextprofil-Steuerung | Beide |
| `guide` | Werkzeugübersicht, Detail-Doku und einzelne Aktionen | Beide |
| `workspace` | Sandbox-Lifecycle, benannte Instanzen, Rollen und Ressourcen-Konfiguration | REST |
| `artefakt` | HTML-Artefakt in den Antwortstrom der Web-UI liefern | REST, Hauptagenten-Kontext |
| `intern` | Interne Diagnose, Worker-/Warteschlangen-/Embedding-Steuerung | REST, nur mit `SYNAPSE_INTERN_TOOL=1` |

Der Hauptagenten-Kontext der Web-Runtime bekommt gezielt nur `artefakt`, nicht die ganze Tool-Liste. Authentifizierung und Agenten-Kontext beeinflussen also die sichtbare Oberfläche.

### Code- und Asset-Intelligence

`code_intel(search)` sucht standardmäßig lexikalisch in PG und liefert Trefferzeilen. `semantic:true` nutzt Embeddings; `search_batch` bündelt mehrere semantische Anfragen. Für die Analyse: Baum → Suche → Funktionen/Referenzen → Flow → gezielter Dateiausschnitt. Die [Parser-Registry](packages/core/src/parser/index.ts) umfasst unter anderem TypeScript/JavaScript, Python, Go, Rust, Java, C/C++, SQL, Shell, YAML/TOML, PowerShell, Vue/Svelte und Shader-Sprachen. Sie liefert eine praktische Analyseebene, keine vollständige Compiler-Semantik für jede Sprache. PDF-, Word- und Excel-Inhalte werden über den [Dokument-Service](packages/core/src/services/documents.ts) extrahiert.

Assets werden getrennt in `asset_files`, `asset_objects` und `asset_references` gespeichert. Inspektoren unterstützen unter anderem 3D, Bilder/Texturen, Audio/Video, Archive, SQLite, PE/ELF, DCC- und Unreal-Dateien. Es werden abgeleitete Daten gespeichert; Binärinhalt wird nicht als Quelltext in `code_files` geschrieben.

`asset_intel` bietet `tree`, `inspect`, `objects`, `references`, `used_by`, `missing`, `graph`, `roots`, `orphans`, `search`, `search_batch`, `move_preview` und `health`. Asset-Pfade können von `code_intel` zu `asset_intel` weitergeleitet werden. Ohne lokalen Asset-Watcher entsteht kein neuer Inspektionsbestand; unterstützte Formate und Versionen begrenzen die Analyse.

## Dateien, Co-Edit und Prüfungen

Dateischreibaktionen laufen über PostgreSQL und erzeugen versionierte Snapshots. Pfade bleiben relativ zum Projekt; Ausbruch über den Root und gesperrte Ziele werden abgelehnt.

1. Zieldateien mit `files(reservation_add)` koordinieren.
2. Mit `files(plan)` einen Entwurf erstellen; Anker und erwartete Hashes schützen vor Drift.
3. Bei gemeinsamen Plänen fremde Ops mit `plan_status(op_index)` prüfen und eigene Ops per `coedit_add` beitragen.
4. `coedit_ready` beziehungsweise `coedit_no_changes` melden; Fehler am eigenen Entwurf mit `plan_update` korrigieren.
5. Mit `files(commit, wait_sync:true)` materialisieren; `auf_platte`/Hash prüfen, bevor lokaler Build oder Test beginnt.
6. `history`, `versions`, `get_version`, `restore` und `restore_batch` dienen Review und Rückbau.

Reservierungen sind Koordination, keine exklusiven Schreiblocks. Pläne laufen nicht automatisch ab. Ein Cancel in einem gemeinsamen Plan zieht nur eigene Ops zurück; fremde Beiträge bleiben erhalten. Ein Commit kann auf aktive, noch nicht bereite Beteiligte warten.

`task_id` akzeptiert UUID oder Kurz-ID wie `P9-T25`. Neue Schreibaufrufe ohne Task-Zuordnung erhalten eine Warnung; Altversionen ohne Task bleiben gültig und werden nicht automatisch migriert. `task_zuordnen` ordnet ausgewählte Versionen explizit und auditierbar nachträglich zu. `ohne_task:true` und `seit` begrenzen entsprechende History-Abfragen.

Die Syntaxprüfung kann einen fehlerhaften Plan vor dem Schreiben sperren. Der [Prüfcontainer](docker/synapse-pruefcontainer/pruefserver.py) benutzt reine Parse-Werkzeuge mit Zeitlimits, zum Beispiel Python-AST, `bash -n`, `gofmt`, `rustfmt`, JVM-/Tree-sitter- und Build-Sprachprüfer. Er führt den eingereichten Nutzer-Code nicht aus. Bekannte Fehlermuster und generische Erklärungen ergänzen die Diagnose.

## Shell, Sicherung und Logs

`shell(exec)` wählt einen lokalen Daemon mit frischem Heartbeat oder einen Docker-Workspace. `target:"local"` erzwingt den Daemon, `target:"workspace"` beziehungsweise `isolated:true` die Sandbox. `executed_via` nennt den Ausführungsort. Source-Edits erfolgen in beiden Fällen über `files`.

Lokale Jobs können nach dem anfänglichen Warten mit `running_background` zurückkehren und weiterlaufen. Eine neue Channel-Nachricht kann das Warten früher mit `running` und `unterbrochen_durch` beenden; sie bricht den Job nicht ab. Ergebnisse holt man mit der Job-UUID über `get`/`log`, nicht mit der `stream_id`. `get_stream` ist im REST-Werkzeug noch nicht implementiert.

Die Shell-Sicherung prüft Befehlstext und aufgelöste Lage, einschließlich Inline-Skripten. Ein Ergebnis kann Hinweis, Anleitung oder Sperre sein. Eine notwendige Bestätigung nutzt die bestehende Rollen-/Namensprüfung und muss zur geprüften Lage passen. Protokolle und Antworten maskieren sensible Werte; ein berechtigter unmaskierter Anzeigeabruf braucht einen Audit-Grund.

History liefert begrenzte Kommando-/Ausgabevorschauen. `get`/`log` dienen dem gezielten vollständigen Abruf; `get(detail:"full")` ergänzt die volle maskierte Sicherungsanalyse. `activity` verbindet Shell-Jobs und Tool-Aktivität.

## Wissen, Jev und Agenten

Memories halten dauerhaftes Projektwissen, Thoughts Zwischenstände, Plans Tasks und Proposals Vorschläge. Dokumente und Skills ergänzen Regeln und Fachwissen. UUIDs beziehungsweise unterstützte eindeutige Präfixe ermöglichen gezielte Abrufe.

Jev beantwortet freigegebene Kategorien wie Variante, Reihenfolge, Umsetzungsweg und Formulierung, wenn der User-Abwesenheitsschalter aktiv ist. Entscheidungen werden protokolliert und sind als Jev-Entscheidungen erkennbar. Verbotene Kategorien wie Deploy, Git, Secrets, Live-DB oder Schema werden darüber nicht entschieden.

Entscheidungs- und Erklärungs-Topf verwenden IDs statt Namen: volle UUID oder eindeutiger Präfix mit mindestens acht Zeichen. Neue Topf-Einträge benötigen keinen Namen. Gibt es für einen Erklärungsfall keine passende generische Erklärung, bleibt ein offener Fall in der bestehenden Warteschlange; es entsteht kein zweiter Erklärungsweg.

Agenten werden über Chat registriert und über Channels, Inbox und Events koordiniert. Events wie `WORK_STOP`, `CRITICAL_REVIEW`, `ARCH_DECISION` und `NEW_TASK` verlangen eine explizite Bestätigung. Der Spezialisten-Wrapper verwaltet Provider-Prozesse, Heartbeat, Wake/Stop, Wissensstand und Kontextrotation. Agentenwissen kann über PG-/HTTP-Brücken geladen werden; vorhandene lokale Skill-Dateien bleiben ein eigener Weg. Runtime- und Provider-Zugangsdaten sind vom Embedding-Modell getrennt.

Der [Codex-PostToolUse-Hook](scripts/codex-kontext-hook.mjs) liest Kontext-/Tokenwerte aus dem Transkript und gibt einen Handoff-Hinweis an der konfigurierten Schwelle aus. Lokale Hook-Installation und Provider-Login sind getrennte Betreiberkonfiguration.

### Antwortformat und Hinweise

REST und stdio verwenden den gemeinsamen Helfer [`tool-antwort.ts`](packages/core/src/services/tool-antwort.ts). Kompaktes JSON lässt bedeutungslose Nullfelder weg; `false`, `0`, leere Listen und semantisch wichtige Nullwerte wie `exit_code:null` bleiben erhalten. `shell/get` und `channel/feed` liefern im kompakten stdio-Format zusätzlich konsistentes `structuredContent`. `SYNAPSE_TOOL_ANTWORT_KOMPAKT=0` ist der Format-Rückweg; interne Skill-Telemetrie bleibt intern.

Optionale Anhänge sind unter anderem `pending_events`, `unreadChat`, `unread_channels`, `shell_activity`, `open_plans`, Werkzeugregeln und Skill-Vorschläge:

- Neue Chat-/Channel-Hinweise erscheinen pro Empfänger einmal je Neuigkeit. Der PG-Zustand bleibt über REST/stdio- und Prozesswechsel erhalten.
- Benachrichtigt bedeutet nicht gelesen: tatsächliche Chat-/Channel-Lesemarken sind getrennt.
- Shell-Hinweise erscheinen auch in Shell-Antworten; eigene laufende Jobs sind eingeschlossen. Jobs, die bereits in derselben Antwort stehen, werden nicht nochmals angehängt.
- `get`/`log` quittieren Shell-Hinweise nur für den abholenden Empfänger. Start und Abschluss bleiben getrennte Zustellungen.
- Ohne effektive Agent-ID entstehen keine personenbezogenen Zustellmarken. DM-Hinweise brauchen einen auflösbaren Projektkontext, Channel-Hinweise folgen den Mitgliedschaften.
- `project(hinweise)` steuert die optionalen Hinweise eines Projekts.

## Workspaces

Der REST-Orchestrator verwaltet benannte Docker-Instanzen wie `main`, `app`, `db-1` und `qa`. Sie teilen die Source-Sicht `/workspace`, haben aber getrennte HOME-Volumes und konfigurierbare Ressourcen/Rollen. Source-Dateien sind schreibgeschützt; Build-Artefakte benötigen freigegebene Pfade.

Container erreichen sich über DNS-Namen, etwa `synapse-ws-<projekt>-app`; Container-IPs gehören nicht in Projektkonfigurationen. Rollen können Dienste über `init_command` starten. Idle-Stop, Pinning und Limits begrenzen den Betrieb. Die [Podman-Variante](docker/synapse-workspace-podman/README.md) ermöglicht Container-Builds, ohne den Docker-Socket in die Projekt-Sandbox zu reichen.

## Embeddings: Nemotron-3-Embed-1B

Der aktuelle dokumentierte Modellstand verwendet Ollama mit **Nemotron-3-Embed-1B**, **1024 Dimensionen**. Das gepflegte [Modellprofil](scripts/p15-t8-modellprofile-startwerte.sql) enthält:

```text
Modell:    hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest
Dimension: 1024
Anfrage:   query:
Dokument:  passage:
```

Die Präfixe enthalten jeweils ein abschließendes Leerzeichen. Präfixe, Stückgrößen, Kontext-/Batchwerte und kalibrierte Score-Schwellen werden je Modell/Digest in PostgreSQL gepflegt. Fehlende Kalibrierung wird gemeldet; es gibt keinen stillen festverdrahteten Modell-Ersatz.

`EMBEDDING_PROVIDER` ist konfigurierbar, standardmäßig `ollama`. `OLLAMA_MODEL` muss explizit gesetzt sein; andere Provider benötigen `EMBEDDING_MODEL` und ihre Zugangskonfiguration. Ein vorhandener Google-Key wählt nicht automatisch Google als Embedding-Standard. Google, OpenAI-kompatible Provider und Cohere bleiben unterstützte Alternativen.

Modell oder Dimension nicht bloß in einer bestehenden Collection umschalten: Dimension und Vektorraum müssen zum gespeicherten Bestand passen. Modellkennung, Collection-Vertrag und kontrolliertes Neu-Einbetten gehören zusammen. Zusätzliche Compute-Nodes übernehmen den Referenzvertrag des Servers.

## Setup und Entwicklung

Voraussetzungen: mise, pnpm, PostgreSQL, Qdrant und für den aktuellen Modellstand ein erreichbarer Ollama-Dienst mit installiertem Nemotron-Modell. Docker wird für API-Container, Workspaces und Prüfcontainer benötigt. Provider-CLI/Auth oder API-Keys für Agenten sind separat einzurichten.

Die [`.mise.toml`](.mise.toml) konfiguriert lokal Node 20; [`package.json`](package.json) verlangt Node ≥20. Das [API-Dockerfile](Dockerfile) verwendet Node 22 und pnpm 10.33.0.

```bash
cd ~/dev/synapse
mise install
pnpm install --frozen-lockfile
mise run build
```

Verfügbare mise-Aufgaben:

```bash
mise tasks
mise run build:core
mise run build:api
mise run build:mcp
mise run dev          # MCP-Entwicklung
mise run dev:api
mise run lint
mise run clean
```

Weitere Paket-Skripte stehen in den jeweiligen `package.json`, etwa `pnpm run build:agents` und `pnpm --filter @synapse/file-watcher-daemon-ts run build`. Konfiguration erfolgt über Umgebung/`.env`; reale Zugangsdaten gehören weder ins Git noch in README-Beispiele.

### Datenbank und Schema

Die API initialisiert das Laufzeitschema aus [`schema.ts`](packages/core/src/db/schema.ts). `SYNAPSE_SCHEMA` kennt `ausfuehren`, `pruefen` und `aus`; MCP/Wrapper prüfen standardmäßig den Stand. **API zuerst** starten beziehungsweise aktualisieren. Eine leere Datenbank kann beim Prüfen einmal initialisiert werden.

Die nummerierten SQL-Dateien sind der Kaltstart-Spiegel. Aufbau, Reihenfolge und Grenzen beschreibt die [Schema-README](packages/core/src/db/schema-sql/README.md). Für Schemaänderungen müssen Laufzeitschema und Spiegel gemeinsam geprüft werden; alte Tabellenzählungen sind kein Nachweis für den heutigen Stand.

### MCP-Konfiguration (lokal)

Aktualisiertes Beispiel; die Werte sind Platzhalter beziehungsweise lokale Standard-Endpunkte:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/pfad/zu/synapse/packages/mcp-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://<user>:<password>@localhost:5432/synapse",
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "ollama",
        "OLLAMA_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest",
        "EMBEDDING_TARGET_DIM": "1024"
      }
    }
  }
}
```

Der Modellname muss zum tatsächlich installierten Ollama-Modell und dem passenden PG-Profil passen. `CONTEXT7_API_KEY` sowie externe Provider-Keys sind optional je benötigter Funktion.

### Deployment: Unraid und Cloudflare-Tunnel

Die REST-API läuft im Docker-Betrieb auf Unraid; der Cloudflare-Tunnel stellt den externen Zugang bereit. Auth-/OAuth-Routen liegen in der API. Private Serveradressen, Tunnel-Zugangsdaten und Tokens sind Betreiberkonfiguration.

Das Repo liefert das API-[Dockerfile](Dockerfile) und [Compose](docker-compose.yml):

```bash
docker compose up -d --build
```

Ohne Profil startet Compose nur die API und erwartet PostgreSQL/Qdrant außerhalb. Mit `--profile bundled` startet es auch Postgres und Qdrant; `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` müssen zur `DATABASE_URL` passen. Der SQL-Init-Mount läuft nur bei einem leeren Datenverzeichnis. Ollama, Prüfcontainer, Workspace-Images, Tunnel und lokale Daemons werden dadurch nicht automatisch vollständig eingerichtet.

Die API benötigt Docker-Zugriff für die entsprechenden Container-Funktionen. Nach einem Core-/Daemon-Update müssen lokale Prozesse den neu gebauten Stand laden; ein API-Deploy aktualisiert einen bereits laufenden lokalen Prozess nicht. Deployment und Migrationen sind Betreiberaktionen.

## Tests

**Datenbanktests ausschließlich gegen `synapse_test` auf Port 5433**, mit eigenem Testprojekt und eigener isolierter Fixture. Die Synapse-Systemdatenbank ist kein Testziel. Zugangsdaten nicht ausgeben.

Tests liegen in `packages/*/tests` und `scripts/test-*.mjs`. Es gibt keine zentrale mise-Aufgabe `test`; den benötigten Test gezielt auswählen und dessen DB-Schutz beachten. Manche Skripte verwenden `TEST_DATABASE_URL`, andere verlangen explizit `DATABASE_URL` und `SYNAPSE_DATABASE_URL` für dieselbe Test-DB.

DB-freie Beispielproben:

```bash
node packages/core/tests/tool-antwort-anhaenge-p10-t53.test.mjs
node packages/core/tests/tool-antwort-huelle-p10-t55.test.mjs
node scripts/test-db-schutz.mjs
```

[Tool-Golden](packages/core/tests/tool-antwort-kompakt-p10-t51.golden.test.mjs) und [Hinweis-Probe](packages/core/tests/tool-hinweise-p10-t62.test.mjs) testen echte REST-/stdio-Strecken in privaten Testschemas. Golden-Baselines werden vor einer Änderung erfasst; nur Laufzeitwerte normalisieren, keine Inhalte. Testverzeichnisse werden durch die [Fixture-Helfer](packages/core/tests/_helfer/test-fixture-cleanup.mjs) unter dem Projekt verwaltet.

## Wichtige Konfiguration

| Bereich | Variablen |
|---|---|
| Datenbank/Suche | `DATABASE_URL`, `SYNAPSE_DATABASE_URL`, `QDRANT_URL`, `QDRANT_API_KEY` |
| Embedding | `EMBEDDING_PROVIDER`, `OLLAMA_URL`, `OLLAMA_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_TARGET_DIM` |
| Modellprofil | `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_DOC_PREFIX`, `EMBEDDING_PRAEFIXE`, zweckbezogene Score-Übersteuerungen |
| API/Schema | `API_PORT`, `API_HOST`, `WEB_UI_DIST`, `SYNAPSE_SCHEMA`, `SYNAPSE_INTERN_TOOL` |
| Projekt/Sandbox | `SYNAPSE_WORKSPACE_ROOT`, `SYNAPSE_WS_PER_PROJECT_CAP`, `SYNAPSE_WS_PRIVILEGED_ROLES` |
| Dateiverarbeitung | `MAX_FILE_SIZE_MB`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `DEBOUNCE_MS` |
| Anzeige | `SYNAPSE_TOOL_ANTWORT_KOMPAKT` |

## Arbeitsweise für Agenten

Projekt und eigene Agent-ID eindeutig bestimmen, Regeln laden, strukturierte Lese-Werkzeuge benutzen, Änderungen als Datei-Plan vorbereiten und Wissen als Thought/Memory sichern. Große Berichte stehen im Wissensspeicher; der Channel enthält die kurze Referenz. Projektarbeit liegt unter `~/dev/`.

Code-Index und Assets sind Leseansichten. Dateiversionierung und PostgreSQL sind die Grundlage für Änderungen und Recovery; Git dient dem Review und Commit, nicht dem Umgehen des Sync.

## Lizenz

MIT
