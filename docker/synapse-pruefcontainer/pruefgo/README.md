# Go-Prüfer

[Synapse](../../../README.md) › [Docker-Umgebung](../../README.md) › [Syntax-Prüfcontainer](../README.md) › Go-Prüfer

## Zweck

Dieses Go-Programm bündelt Originalparser für mehrere Build- und Konfigurationsformate. Es parst Dockerfiles, HCL, Starlark und Jsonnet und gibt gefundene Syntaxfehler als JSON aus; es baut oder evaluiert die Eingaben nicht.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [main.go](main.go) | Wählt anhand des Spracharguments den Parser aus, liest den Quelltext von stdin und schreibt Befunde nach stdout. |
| [go.mod](go.mod) | Fixiert die direkten Go-Module für die Parser. |
| [go.sum](go.sum) | Hält die Prüfsummen der aufgelösten Go-Abhängigkeiten fest. |

## Schnittstellen nach außen

Das [Dockerfile](../Dockerfile) baut aus diesem Ordner ein statisches Hilfsprogramm. Der Python-Prüfserver ruft es als Prozess auf und verarbeitet dessen JSON-Ergebnis als Syntaxbefunde.

## Abhängigkeiten

Die Parserbibliotheken stammen aus den Go-Modulen für BuildKit-Dockerfile-Syntax, HCL, Bazel Buildtools und go-jsonnet. Der übergeordnete [Prüfcontainer](../README.md) enthält das erzeugte Programm zur Laufzeit.

## Siehe auch

- [Syntax-Prüfcontainer](../README.md)
- [Docker-Umgebung](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
