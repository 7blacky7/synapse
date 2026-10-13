# Asset-Intel

[Synapse](../../../../README.md) › [Core](../../README.md) › [Quellcode](../README.md) › Asset-Intel

## Zweck

Asset-Intel liest Nicht-Quellcode-Dateien gezielt und leitet daraus Metadaten, Objektlisten, Referenzen und Warnungen ab. Die Pipeline ist von den Text-Parsern getrennt: Inspektoren arbeiten mit begrenztem Bytezugriff über AssetSource, während die Parser Text entgegennehmen. Die Originaldateien bleiben maßgeblich; die Inspektion verändert sie nicht.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Bündelt die öffentliche Inspektionsschnittstelle und die Standard-Registry. |
| [`registry.ts`](registry.ts) | Registriert Inspektoren und erkennt Formate vorrangig anhand von Magic Bytes, danach über Dateiendungen. |
| [`run.ts`](run.ts) | Öffnet Dateien lesend, setzt Größen-, Lese-, Objekt-, Zeit- und Verschachtelungsgrenzen durch und erzeugt ein vollständiges Ergebnis. |
| [`types.ts`](types.ts) | Definiert AssetSource, Inspektor-Vertrag, Grenzen, Warnungen und das gemeinsame Ergebnisformat. |
| [`errors.ts`](errors.ts) | Enthält kontrollierte Fehler für ungültige Bytezugriffe und überschrittene Grenzen. |
| [`binary-reader.ts`](binary-reader.ts) | Liest primitive Werte mit Bereichsprüfungen aus Byteabschnitten. |
| [`generic-binary.ts`](generic-binary.ts) | Erkennt verbliebene Formate mit Magic Bytes und liefert grundlegende Metadaten. |
| [`worker-runner.ts`](worker-runner.ts) | Führt Inspektionen isoliert in einem Worker-Thread aus und beendet hängende Aufträge hart. |
| [Inspectoren](inspectors/README.md) | Gruppiert die spezialisierten Formaterkenner für 3D, Archive, DCC, ausführbare Dateien, Medien, Texturen und Unreal. |

## Schnittstellen nach außen

Aufrufer verwenden inspectAsset aus [index.ts](index.ts). Das Ergebnis enthält Status, erkannte Klasse und Format, Metadaten, Referenzen, Objekte, Warnungen sowie die Version des Inspektors. Eigene Inspektoren implementieren AssetInspector und werden über [registry.ts](registry.ts) registriert. [worker-runner.ts](worker-runner.ts) stellt AssetInspektionsWorker für Ausführung mit hartem Worker-Abbruch bereit.

## Abhängigkeiten

Die Registry und Inspektoren teilen die Verträge aus [types.ts](types.ts); [run.ts](run.ts) verbindet Formaterkennung, begrenzten Zugriff und Ergebnisbildung. Die [Inspector-Familien](inspectors/README.md) nutzen [binary-reader.ts](binary-reader.ts) für geprüfte Bytezugriffe. Textdateien laufen getrennt über den [Parser](../parser/README.md).

## Siehe auch

- [Inspectoren](inspectors/README.md)
- [Parser](../parser/README.md)
- [Core-Quellcode](../README.md)
- [Core-Paket](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
