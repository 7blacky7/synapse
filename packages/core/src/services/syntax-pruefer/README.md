# Syntax-Prüfer

[Synapse](../../../../../README.md) › [Pakete](../../../../README.md) › [Core](../../../README.md) › [Quellcode](../../README.md) › [Services](../README.md) › Syntax-Prüfer

## Zweck

Dieser Ordner bündelt die Syntax-Prüfer der ersten Prüfungsstufe für Schreibvorgänge. Er meldet Syntax- und Grammatikfehler mit Quellpositionen und strukturierten Meldungen; allgemeine Typ- und Lint-Prüfungen sind davon getrennt. Der Katalog kann im Worker-Pool oder auf Wunsch im Hauptthread ausgeführt werden.

## Prüfablauf und Grenzen

Der Core ordnet eine Datei anhand ihrer Endung oder eines eingetragenen Dateinamens den passenden Prüfern zu. Geprüft wird der neue Inhalt vor dem Persistieren des Einzelschreibwegs; Befunde außerhalb der geänderten Zeilen gelten nur dann als neu verursacht, wenn der vorherige Stand fehlerfrei war. Ein harter Syntaxfehler blockiert das Schreiben, solange er nicht mit einer ausreichenden Begründung quittiert wurde. Bei Planänderungen ordnet der Core Befunde den verursachenden Operationen zu; sperrende Befunde verhindern den Plan-Commit. Signaturmuster werden separat nach dem Schreiben geprüft.

Der eigene Node-Worker-Pool startet standardmäßig zwei Worker, begrenzt auf höchstens acht und die verfügbare Kernzahl. `SYNTAX_WORKER_THREADS=0` schaltet den Pool ab und führt Prüfungen im Hauptthread aus. Ein Worker darf je Auftrag standardmäßig fünf Sekunden laufen und erhält standardmäßig 256 MB Heap; für den ersten Auftrag kommt während des Aufwärmens standardmäßig ein Zuschlag von 30 Sekunden hinzu. Höchstens 64 Aufträge warten in der Queue. Drei aufeinanderfolgende Worker-Ausfälle legen einen Poolslot still; ein späterer Auftrag versucht ihn nach standardmäßig 60 Sekunden wiederzubeleben. Der Pool hält bis zu 128 Ergebnisse nach Prüfer, Pfad und Inhalts-Hash bereit.

Das Gesamtbudget kommt vom aufrufenden Fehlerprüfdienst. Läuft ein Prüfer über dieses Budget, ist das Prüfergebnis zunächst teilweise und das Schreiben geht weiter; ein später gefundener Fehler wird als Hinweis dem ursprünglichen Schreibstand nachgereicht. Wirft ein Prüfer oder ist der Pool nicht verfügbar, protokolliert der Dienst den Fehler und fährt ohne diesen Prüfer fort. Ein ausgebliebener Befund bedeutet in diesen Fällen daher keine bestätigte Fehlerfreiheit.

Quellbelege: [`pool.ts`](pool.ts) (Workergrenzen und Cache), [`fehlermuster-pruefung.ts`](../fehlermuster-pruefung.ts) (Budget, Befunde und Quittierung), [`code-write.ts`](../code-write.ts) (Schreibsperre) und [`plan-befunde.ts`](../plan-befunde.ts) (Befunde je Operation).

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
