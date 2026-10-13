# JVM-Prüfer

[Synapse](../../../README.md) › [Docker-Umgebung](../../README.md) › [Syntax-Prüfcontainer](../README.md) › JVM-Prüfer

## Zweck

Dieser Ordner enthält den dauerhaften JVM-Hilfsprozess für Sprachparser, die eine JVM benötigen. Er parst Kotlin, Java, Scala und Groovy; die Prüfung bleibt auf Syntax beschränkt und führt den eingereichten Quelltext nicht aus.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [JvmPruefer.java](JvmPruefer.java) | Implementiert das JSON-basierte Kommandozeilenprotokoll und die Parseradapter für Kotlin, Java, Scala und Groovy. |
| [pom.xml](pom.xml) | Deklariert die Parserbibliotheken, die beim Bau des Prüfcontainers bereitgestellt werden. |

## Schnittstellen nach außen

Der übergeordnete [Prüfserver](../pruefer_jvm.py) startet und überwacht den JVM-Prozess. Eingaben und Befunde werden zwischen den Prozessen über die standardisierte Ein-/Ausgabe ausgetauscht; der Prüfserver ist für die REST-API der äußere Integrationspunkt.

## Abhängigkeiten

Kotlin PSI stammt aus dem Kotlin-Compiler-Embeddable, Java verwendet die javac-Parser-API, Scala nutzt scalameta und Groovy dessen Compilerparser. Das übergeordnete [Dockerfile](../Dockerfile) lädt diese Bibliotheken im Build und stellt eine reduzierte JVM-Laufzeit bereit.

## Siehe auch

- [Syntax-Prüfcontainer](../README.md)
- [JVM-Adapter](../pruefer_jvm.py)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
