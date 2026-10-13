# Gemini-Live-Viewer

[Synapse](../../../../README.md) › [Übergeordneter Ordner](../README.md) › Gemini-Live-Viewer

## Zweck

Dieser Ordner enthält die Browser-Oberfläche für den Gemini-Runtime-Monitor. Sie zeigt Runtime-Ereignisse, Werkzeugaufrufe und Nutzungswerte eines Runs an.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.html`](index.html) | Rendert mit appendTurn die Ereignisse aus /events und verlinkt das vollständige Run-Protokoll unter /run.jsonl. |

## Schnittstellen nach außen

[MonitorServer](../monitor-server.ts) liefert `index.html` unter `/` aus. Die Oberfläche verbindet sich per `EventSource` mit `/events`; `appendTurn`, `escapeHtml`, `fmt` und `fmtTs` bereiten Ereignisse für die Anzeige auf.

## Abhängigkeiten

Die Oberfläche verwendet Browser-DOM und Server-Sent Events. Ihr Datenvertrag ist das `MonitorEvent`-Format des [Monitor-Servers](../monitor-server.ts); die enthaltene Kostendarstellung verwendet lokale Preisannahmen und ersetzt keine Abrechnung.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Runtime](../runtime.ts)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
