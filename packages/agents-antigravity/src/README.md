# Antigravity-Runtime

[Synapse](../../../README.md) › [Übergeordneter Ordner](../README.md) › Antigravity-Runtime

## Zweck

Dieser Ordner enthält den Adapter zwischen dem Spezialisten-Wrapper und der Antigravity-CLI. Er bietet einen Standalone-Modus und ein Claude-CLI-kompatibles Nachrichtenprotokoll für den Wrapper-Modus.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`runtime.ts`](runtime.ts) | Verbindet in main, runStandalone und runWrapperMode die Wrapper-Nachrichten mit runAgy und der agy-CLI. |

## Schnittstellen nach außen

`runAgy` kapselt den CLI-Prozess; `emitStdout` erzeugt Stream-JSON-Ereignisse. `readWrapperEnv` und `extractUserInput` lesen Wrapper-Konfiguration und Nachrichten. Der Quellcode verwendet für Folge-Turns `--continue`, dessen Bezug auf die jüngste Conversation die Parallelität mehrerer Profile begrenzt.

## Abhängigkeiten

Der Adapter verwendet Node-Prozess-/Dateisystem-Schnittstellen und `resolveModel` aus [Agenten](../../agents/README.md). `GOOGLE_API_KEY` und `GEMINI_API_KEY` werden aus dem CLI-Unterprozess-Environment entfernt; das trennt diese Runtime vom [Gemini-API-Adapter](../../agents-gemini/README.md).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Wrapper](../../agents/src/wrapper.ts)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
