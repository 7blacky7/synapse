# Agenten-Quellcode

[Synapse](../../../README.md) › [Übergeordneter Ordner](../README.md) › Agenten-Quellcode

## Zweck

Dieser Ordner enthält die gemeinsame Implementierung persistenter Spezialisten-Wrapper. Er trennt KI-Prozess, Kommunikation, Zustandsentscheidungen sowie Wissen und Status in eigene Module.

## Inhalt

### Exports und Laufzeit

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Bündelt die öffentlichen Paket-Exports. |
| [`types.ts`](types.ts) | `SpecialistConfig`, `SpecialistStatus` und `StatusFile` beschreiben Konfiguration und Statusformen. |
| [`models.ts`](models.ts) | `resolveModel` und `loadFromDb` verbinden die Modell-Registry mit dem statischen Bootstrap-Rückfall. |
| [`detect.ts`](detect.ts) | `detectClaudeCli` ermittelt Informationen zur verfügbaren Claude-CLI. |
| [`runtime-pfad.ts`](runtime-pfad.ts) | `loeseRuntimePfad` löst die Laufzeitdatei einer Provider-Runtime auf. |
| [`process.ts`](process.ts) | `ProcessManager` kapselt den KI-Subprozess und dessen Nachrichten-/Ereignisschnittstelle. |
| [`wrapper.ts`](wrapper.ts) | Verbindet KI-Prozess, Socket-Steuerung, Heartbeat und Wissenszugriff im Wrapper-Prozess. |

### Kommunikation und Zustandssteuerung

| Datei / Unterordner | Aufgabe |
|---|---|
| [`channels.ts`](channels.ts) | Re-exportiert Core-Funktionen wie `createChannel`, `joinChannel` und `postMessage`. |
| [`inbox.ts`](inbox.ts) | Re-exportiert Core-Funktionen wie `postToInbox`, `checkInbox` und `getInboxHistory`. |
| [`channel-push.ts`](channel-push.ts) | `baueChannelPush` erzeugt adressierte Volltexte und begrenzte Vorschauen für Channel-Nachrichten. |
| [`heartbeat.ts`](heartbeat.ts) | `HeartbeatController` verwaltet Unix-Sockets und JSON-RPC-Kommandos zu Wrappern. |
| [`heartbeat-state.ts`](heartbeat-state.ts) | `createState`, `onEvent` und `nextDelayMs` bilden die adaptive Heartbeat-Zustandsmaschine. |
| [`heartbeat-entscheidung.ts`](heartbeat-entscheidung.ts) | `entscheideAbgeschaltet` bestimmt die Wrapper-Reaktion bei abgeschaltetem Heartbeat. |
| [`leerlauf-entscheidung.ts`](leerlauf-entscheidung.ts) | `nachLeerlaufWake` und `beiEchtemAnlass` steuern die Leerlauf-Pause von Keep-alive-Weckrufen. |
| [`rotations-marker.ts`](rotations-marker.ts) | `rotationsMarkerAktion` bestimmt die Wirksamkeit eines angeforderten Rotations-Markers. |
| [`token-stand.ts`](token-stand.ts) | `berechneTokenStand` leitet den Kontextstand aus Claude-Session-JSONL-Ereignissen ab. |

### Wissen und Status

| Datei / Unterordner | Aufgabe |
|---|---|
| [`prompts.ts`](prompts.ts) | `buildSpecialistPrompt` erstellt den Systemprompt aus Konfiguration und Wissen. |
| [`werkzeuge-laden.ts`](werkzeuge-laden.ts) | `baueWerkzeugHinweis` erstellt den Hinweis zum gezielten Laden benötigter Werkzeuge. |
| [`skills.ts`](skills.ts) | `readMeta`, `readSkillFile` und `writeSkillFile` verwalten lokale Metadaten und Wissensdateien. |
| [`status.ts`](status.ts) | `readStatus`, `writeStatus` und `updateSpecialist` pflegen den lokalen Statuscache neben dem primären PG-Status. |
| [`schema.ts`](schema.ts) | `AGENTS_SCHEMA` und `ensureAgentsSchema` definieren und initialisieren Agenten-Datenbankobjekte. |

### Zugriffsschichten

| Datei / Unterordner | Aufgabe |
|---|---|
| [`transport/`](transport/README.md) | Enthält den austauschbaren Zugriff über PostgreSQL oder HTTP. |
| [`wissen/`](wissen/README.md) | Enthält Dateisystem- und API-Adapter für Agentenwissen. |

## Schnittstellen nach außen

[index.ts](index.ts) bündelt die Paket-Exports. [HeartbeatController](heartbeat.ts) verwendet JSON-RPC über Unix-Sockets; [wrapper.ts](wrapper.ts) ist das Gegenstück im Spezialistenprozess. [types.ts](types.ts) beschreibt Konfiguration und Statusformen.

## Abhängigkeiten

Die Implementierung verwendet Node-Prozess-, Socket- und Dateisystem-Schnittstellen sowie [Core](../../core/README.md). Die [Transportadapter](transport/README.md) trennen Datenzugriffe, die [Wissensadapter](wissen/README.md) die Quelle des Agentenwissens.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [MCP-Anbindung](../../mcp-server/src/tools/specialists.ts)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
