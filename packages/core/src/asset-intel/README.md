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

## Funktionsweise

Der lokale Dateiwächter reicht ein Änderungsereignis nur dann an Asset-Intel weiter, wenn es als Asset markiert ist. Der Asset-Zweig läuft neben dem Textindex und darf dessen Verarbeitung nicht unterbrechen. Beim Start gleicht der Wächter vorhandene Asset-Einträge mit dem Dateisystem ab; unveränderte Dateien werden übersprungen. Neue, geänderte oder mit neuerer Inspektorversion fällige Dateien werden in eine begrenzte Warteschlange gestellt. Doppelte wartende Ereignisse desselben Projektpfads werden zusammengeführt.

Ein Worker liest den Dateikopf und die Registry ordnet das Format zuerst anhand von Magic Bytes, dann anhand der Endung zu. Der Inspektor greift über `AssetSource` begrenzt und schreibgeschützt auf Bytes zu. Größen-, Lese-, Zeit-, Objekt- und Verschachtelungsgrenzen beschränken die Auswertung. Das Ergebnis enthält erkannte Metadaten, Objekte, Verweise und Warnungen; Rohdatei-Inhalte werden nicht als Asset-Index gespeichert.

Der Store schreibt die abgeleiteten Daten nach PostgreSQL in `asset_files`, `asset_objects` und `asset_references`. Abfragen lesen diesen Bestand für Baum, Suche, Objektlisten, Verweise und Graphen. Bei fehlender Quelle bleibt der Datensatz mit Status „Quelle nicht gefunden“ bestehen; der Startabgleich entfernt ihn erst nach der Aufbewahrungsfrist. Ein harter Worker-Abbruch oder eine nicht erkannte Datei wird als Status beziehungsweise Warnung sichtbar. Fehlt die Asset-Tabelle im Datenbankschema, wird nur der Asset-Weg bis zum Neustart abgeschaltet; der Code-Index läuft weiter.

Medien-Embeddings sind ein anderer Pfad: Bilder und Videos werden über den Core-Medienindexierer in eine eigene Qdrant-Collection eingebettet. Asset-Intel liefert dagegen strukturierte Dateimetadaten und Verweise; es erzeugt keine semantischen Medienvektoren.

## Siehe auch

- [Inspectoren](inspectors/README.md)
- [Parser](../parser/README.md)
- [Core-Quellcode](../README.md)
- [Core-Paket](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
- [Textparser](../parser/README.md)
- [Embedding-, Wissens- und Medienwege](../embeddings/README.md)
- [Asset-Datenfluss](../../../../docs/bilder/asset.svg)
