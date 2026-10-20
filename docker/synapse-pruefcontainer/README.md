# Syntax-Prüfcontainer

[Synapse](../../README.md) › [Docker-Umgebung](../README.md) › Syntax-Prüfcontainer

## Zweck

Dieses Image stellt Parser für Syntaxprüfungen bereit, die außerhalb des Node-Prozesses laufen. Der Python-Prüfserver nimmt den Prüftext entgegen und verteilt ihn an sprachspezifische Parser. Die Hilfsprogramme prüfen Syntax und führen den geprüften Quelltext nicht als Benutzerprogramm aus.

## Containerleben und Fehlergrenzen

Beim Start der REST-API prüft der Dienst, ob Docker erreichbar und das Prüf-Image vorhanden ist. Mit `SYNTAXPRUEFUNG=0` oder `PRUEFCONTAINER=0` bleibt die Registrierung aus. Fehlt Docker oder das Image, werden die Container-Prüfer ebenfalls nicht registriert; ihre Sprachen erhalten dann aus diesem Pfad keine Syntaxprüfung. Sofern nicht mit `PRUEFCONTAINER_VORWAERMEN=0` abgeschaltet, startet die API den Container nach der Registrierung im Hintergrund vor. Sonst startet ihn der erste Prüfauftrag. Die API spricht mit PID 1 über JSON-Zeilen an stdin/stdout und setzt `NetworkMode=none`; das Container-Root-Dateisystem ist schreibgeschützt, es gibt keine Bind-Mounts, und die Prüfer führen den geprüften Quelltext nicht als Programm aus.

Der Prüfserver meldet seine Bereitschaft nach dem Start. Das normale Auftragslimit beträgt standardmäßig fünf Sekunden und beginnt nach dieser Bereitschaft; der Start selbst hat standardmäßig bis zu 60 Sekunden. Der Container wird nach zehn Minuten Leerlauf gestoppt. Der erste Auftrag jeder Sprache erhält auch in einem bereits laufenden Container ein Kaltbudget von standardmäßig drei Sekunden, weil Parser oder Grammatik erst dann initialisiert werden können. Kotlin und Java haben zusätzlich ein eigenes JVM-Kaltbudget von standardmäßig vier Sekunden. Drei Zeitüberschreitungen in Folge stoppen den Container; nach mehr als drei Starts innerhalb von fünf Minuten pausiert der Dienst standardmäßig eine Minute.

Nur benötigte Werkzeuge laufen: Alle Prüfer außer der JVM starten nur für die Dauer eines Auftrags als Unterprozess. Die JVM (Kotlin, Java, Scala, Groovy) startet erst mit der ersten Anfrage einer JVM-Sprache und beendet sich nach `PRUEFCONTAINER_JVM_IDLE_S` Sekunden ohne Anfrage (Standard 600, im Container `PRUEF_JVM_IDLE_S`). `PRUEFCONTAINER_JVM_VORWAERMEN=1` stellt das frühere Vorwärmen beim Containerstart wieder her. Gemessen (P16-T22, lokal): Container nach dem Start 43 MB, mit laufender JVM rund 140 MB, nach dem Leerlauf-Stopp wieder ohne JVM-Prozess.

Projektweite Prüfung (`code_check build_status`): TypeScript bekommt die Typdateien der Abhängigkeiten aus dem Lockfile des Projekts (`pnpm-lock.yaml`, `package-lock.json`), von der API aus der npm-Registry geladen und per `integrity` geprüft, nur `.d.ts` und `package.json` (Kern `build-typen.ts`, Schalter `BUILD_PRUEFUNG_TYPEN=0`). Go nutzt je Lauf einen leeren, beschreibbaren Modulcache im tmpfs. Fehler der Prüfumgebung (zum Beispiel ein schreibgeschütztes Verzeichnis) zählen als Schrittstatus `werkzeug` und nie als Befund. Jeder Schritt meldet `rss_mb` (höchster RSS), jedes Ergebnis den Containerspeicher (`speicher`: cgroup `memory.current`/`memory.peak`).

Ein Timeout, Containerabsturz oder Parserfehler liefert für diesen Auftrag keinen bestätigten Syntaxbefund. Der Core protokolliert den fehlgeschlagenen Prüfer und fährt mit dem Schreibvorgang fort; andere registrierte Prüfer können denselben Inhalt weiterhin prüfen und gegebenenfalls blockieren. Überschreitet ein Prüfer nur das Gesamtbudget, läuft der Auftrag weiter und ein späterer Befund wird als Hinweis nachgeliefert, nachdem der Schreibvorgang bereits fortgesetzt wurde. Ein fehlender Containerbefund belegt daher keine fehlerfreie Datei.

Quellbelege: [`pruef-container.ts`](../../packages/rest-api/src/services/pruef-container.ts) (Registrierung, Start, Budgets und Stopps), [`fehlermuster-pruefung.ts`](../../packages/core/src/services/fehlermuster-pruefung.ts) (Teilergebnis und Nachlieferung) und [`code-write.ts`](../../packages/core/src/services/code-write.ts) (Weiterlauf bei Prüferfehlern).

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
