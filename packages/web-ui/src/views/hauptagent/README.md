# Hauptagent-Ansichten

[Synapse](../../../../../README.md) › [Pakete](../../../../README.md) › [Web-Oberfläche](../../../README.md) › [Quellcode](../../README.md) › [Ansichten] › [Hauptagent]

## Zweck

Dieser Ordner enthält die aus der Workspace-Quelle herausgelösten Ansichten und Helfer für den Hauptagenten. Die Module bewahren die bestehende Logik, Texte und Styles; ergänzt werden nur die für eigenständige Dateien erforderlichen Importe und Exporte.

## Inhalt

| Datei | Zweck |
|---|---|
| [hauptagent-konstanten.ts](hauptagent-konstanten.ts) | Konstante für die maximale Werkzeugliste |
| [zitat-teile.ts](zitat-teile.ts) | Zerlegt Zitat-Blöcke und führt Nachrichten-Zitate mit den gefundenen Zitaten zusammen |

## Funktionsweise und Schnittstellen

[hauptagent-konstanten.ts](hauptagent-konstanten.ts) exportiert `TOOL_LISTE_MAX`. [zitat-teile.ts](zitat-teile.ts) exportiert `zitatTeile`; die Funktion übernimmt unverändert die bisherige Nachrichtenzitat-Logik.

## Abhängigkeiten

[zitat-teile.ts](zitat-teile.ts) verwendet die gemeinsamen Nachrichtentypen sowie den bestehenden Zitat-Block-Parser. Die Konstanten-Datei ist unabhängig. Beide Module importieren keine Workspace-Hülle.

## Siehe auch

- [Ansichten](../README.md)
- [Gemeinsame Bausteine](../../components/gemeinsam/README.md)
