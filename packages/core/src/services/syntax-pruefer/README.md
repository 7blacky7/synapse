# Syntax-Prüfer

[Synapse](../../../../../README.md) › [Pakete](../../../../README.md) › [Core](../../../README.md) › [Quellcode](../../README.md) › [Services](../README.md) › Syntax-Prüfer

## Zweck

Dieser Ordner bündelt die Syntax-Prüfer der ersten Prüfungsstufe für Schreibvorgänge. Er meldet Syntax- und Grammatikfehler mit Quellpositionen und strukturierten Meldungen; allgemeine Typ- und Lint-Prüfungen sind davon getrennt. Der Katalog kann im Worker-Pool oder auf Wunsch im Hauptthread ausgeführt werden.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Registriert die Standardprüfer bei der Fehlerprüfung und stellt Pooldiagnose sowie geordnetes Beenden bereit. |
| [`katalog.ts`](katalog.ts) | Enthält die Prüferdefinitionen, Zuordnungen von Dateitypen und die sprachspezifischen Syntaxprüfungen. |
| [`cmake.ts`](cmake.ts) | Prüft CMake-Dateien mit einem Parser für Syntax und Verschachtelung, ohne Befehle auszuführen. |
| [`pool.ts`](pool.ts) | Verwaltet den isolierten Worker-Pool, Auftragsgrenzen, Zeitlimits und Ergebnis-Caches. |
| [`worker.ts`](worker.ts) | Lädt den Prüferkatalog in einem Node-Worker und verarbeitet Prüfaufträge aus dem Pool. |

## Schnittstellen nach außen

[`registriereStandardSyntaxPruefer()`](index.ts) meldet die Prüfer beim gemeinsamen Dienst [`fehlermuster-pruefung.ts`](../fehlermuster-pruefung.ts) an. Der Core-Einstieg [`src/index.ts`](../../index.ts) exportiert die Registrierungs- und Poolfunktionen; REST-API und MCP-Server rufen die Registrierung beim Start auf ([REST](../../../../rest-api/src/server.ts), [MCP](../../../../mcp-server/src/server.ts)). Die Registrierung liefert die Namen der verfügbaren Prüfer zurück; `syntaxPoolZustand()` liefert den Poolstatus und `beendeSyntaxPool()` beendet den Pool.

## Abhängigkeiten

Die Prüfer übergeben ihre Meldungen an `fehlermuster-pruefung.ts`. `index.ts` verbindet den Katalog mit `pool.ts`; der Pool startet `worker.ts` über Node-`worker_threads`. Der Katalog lädt die benötigten Syntaxbibliotheken bei Bedarf über Node-`createRequire`; die CMake-Prüfung ist im Ordner als eigener Parser umgesetzt.

## Siehe auch

- [Services](../README.md)
- [Core-Quellcode](../../README.md)
- [Zusammenhang](../../../../../docs/README.md)
