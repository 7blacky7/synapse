# Syntax-Prüfcontainer

[Synapse](../../README.md) › [Docker-Umgebung](../README.md) › Syntax-Prüfcontainer

## Zweck

Dieses Image stellt Parser für Syntaxprüfungen bereit, die außerhalb des Node-Prozesses laufen. Der Python-Prüfserver nimmt den Prüftext entgegen und verteilt ihn an sprachspezifische Parser. Die Hilfsprogramme prüfen Syntax und führen den geprüften Quelltext nicht als Benutzerprogramm aus.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [Dockerfile](Dockerfile) | Definiert mehrstufige Image-Builds und bündelt Parser, JVM-Hilfsprozess und Laufzeit. |
| [Prüfserver](pruefserver.py) | Verarbeitet Prüf-Anfragen und stellt Parserfunktionen sowie Status- und Versionsinformationen bereit. |
| [Build-Sprachprüfer](pruefer_build.py) | Prüft Build- und Konfigurationssprachen wie Make, Meson und Linkerskripte. |
| [JVM-Prüfer-Adapter](pruefer_jvm.py) | Verwaltet den JVM-Hilfsprozess für JVM-Sprachen. |
| [Naga-Prüfer](pruefer_naga.py) | Prüft WGSL mit naga, wobei nur Syntaxbefunde übernommen werden. |
| [Tree-sitter-Prüfer](pruefer_treesitter.py) | Lädt registrierte Tree-sitter-Grammatiken und erzeugt Syntaxbefunde. |
| [Tree-sitter-Sprachmodule](ts_sprachen/README.md) | Beschreibt Grammatik, Dateiendungen, Prüfmodus und Proben der Sprachmodule. |
| [Grammatik-Download im Build](ts_holen.py) | Holt beim Image-Build die Grammatiken, die von den Sprachmodulen vorgesehen sind. |
| [JVM-Parser](jvm/README.md) | Enthält Parser für JVM-Sprachen und ihre Maven-Abhängigkeiten. |
| [Go-Parser](pruefgo/README.md) | Bündelt Parser für Dockerfile-, HCL-, Starlark- und Jsonnet-Syntax. |

## Schnittstellen nach außen

Der Prüfserver kommuniziert über seine standardisierte Ein-/Ausgabe-Schnittstelle mit dem aufrufenden Dienst. Die REST-API verwaltet den Containerlebenszyklus und verbindet die Syntaxprüfung mit dem Dateischreibweg. Für einzelne Prüfungen reichen Adapter den Quelltext an spezialisierte Werkzeuge weiter und liefern Befunde zurück.

## Abhängigkeiten

Das Image kombiniert Python und Bash mit ausgewählten Parsern und Laufzeitbibliotheken. Die JVM-Unterkomponenten liegen unter [jvm](jvm/README.md); Build-Konfigurationsparser kommen aus [pruefgo](pruefgo/README.md). Tree-sitter-Grammatiken werden aus den Modulen in [ts_sprachen](ts_sprachen/README.md) abgeleitet. Die REST-API-Anbindung ist unter [Prüfcontainer-Service](../../packages/rest-api/src/services/README.md) eingeordnet.

## Siehe auch

- [Docker-Umgebung](../README.md)
- [Syntaxprüfung im Core](../../packages/core/src/services/syntax-pruefer/README.md)
- [REST-API](../../packages/rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
