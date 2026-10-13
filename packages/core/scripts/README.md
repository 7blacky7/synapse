# Core-Skripte

[Synapse](../../../README.md) › [Pakete](../../README.md) › [Core-Paket](../README.md) › Skripte

## Zweck

Die Skripte in diesem Ordner unterstützen Core-Tests und einzelne Datenüberführungen. Der größte Teil erzeugt temporäre Asset-Fixtures für die zugehörigen Inspektoren; weitere Skripte prüfen Channel-Funktionen oder überführen Skill- und Tech-Doc-Bestände nach PostgreSQL.

## Inhalt

### Asset-Fixtures

| Datei | Aufgabe |
|---|---|
| [`asset-fixtures.mjs`](asset-fixtures.mjs) | Erzeugt allgemeine Dateien für Asset-Intel-Tests. |
| [`asset-fixtures-3d.mjs`](asset-fixtures-3d.mjs) | Erzeugt Fixtures für 3D-Inspektoren. |
| [`asset-fixtures-archiv.mjs`](asset-fixtures-archiv.mjs) | Erzeugt Archiv- und SQLite-Fixtures. |
| [`asset-fixtures-dcc.mjs`](asset-fixtures-dcc.mjs) | Erzeugt Fixtures für DCC-Dateiformate. |
| [`asset-fixtures-exe.mjs`](asset-fixtures-exe.mjs) | Erzeugt PE- und ELF-Fixtures. |
| [`asset-fixtures-medien.mjs`](asset-fixtures-medien.mjs) | Erzeugt Medien-Fixtures. |
| [`asset-fixtures-textur.mjs`](asset-fixtures-textur.mjs) | Erzeugt Textur-Fixtures. |
| [`asset-fixtures-unreal.mjs`](asset-fixtures-unreal.mjs) | Erzeugt Unreal-Asset-Fixtures. |

### Proben und Datenabgleich

| Datei | Aufgabe |
|---|---|
| [`ch5-archivieren.mjs`](ch5-archivieren.mjs) | Prüft Freigabestände und archiviert ausgewählte Channels. |
| [`ch6-feed-probe.mjs`](ch6-feed-probe.mjs) | Prüft, ob der Nachrichten-Feed den Anfang eines langen Channels erreichen kann. |
| [`ch8-nachrichten-archiv-probe.mjs`](ch8-nachrichten-archiv-probe.mjs) | Prüft das Ausblenden und reversible Wiederherstellen archivierter Channel-Nachrichten. |
| [`ci2-gegenmessung.mjs`](ci2-gegenmessung.mjs) | Vergleicht Suchtreffer einer Textsuche mit und ohne zerlegten Volltextindex. |
| [`skills-nach-pg.mjs`](skills-nach-pg.mjs) | Überführt Skill-Abschnitte aus Qdrant in die PostgreSQL-Tabelle `skill_sections`. |
| [`tech-docs-nach-pg.mjs`](tech-docs-nach-pg.mjs) | Gleicht den Tech-Docs-Bestand zwischen PostgreSQL und den bisherigen Qdrant-Daten ab. |

## Schnittstellen nach außen

Die Fixture-Generatoren stellen Funktionen bereit, mit denen Tests temporäre Dateien anlegen und anschließend bereinigen können. Die Channel-Proben und Datenabgleichsskripte importieren Funktionen aus dem gebauten [Core-Einstieg](../src/index.ts); die Such-Gegenmessung verwendet zusätzlich PostgreSQL-Abfragen.

## Abhängigkeiten

Die Skripte greifen auf die Core-Implementierung und deren Laufzeitbibliotheken zurück. Asset-Inspektoren, die diese Fixtures auswerten, sind im Bereich [Asset-Intel](../src/asset-intel/README.md) eingeordnet. Die Datenabgleichsskripte beziehen Daten aus Qdrant und PostgreSQL; die Core-Module dafür liegen in [Qdrant](../src/qdrant/README.md), [Datenbank](../src/db/README.md) und [Embeddings](../src/embeddings/README.md).

## Siehe auch

- [Core-Paket](../README.md)
- [Core-Quellcode](../src/README.md)
- [Core-Tests](../tests/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
