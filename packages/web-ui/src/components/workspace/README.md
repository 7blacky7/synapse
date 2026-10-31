# Workspace-Komponenten

[Synapse](../../../../../README.md) › [Pakete](../../../../README.md) › [Web-Oberfläche](../../../README.md) › [Quellcode](../../README.md) › [Komponenten](../README.md) › Workspace

## Zweck

Dieser Ordner enthält die Bausteine der Synapse-Arbeitsfläche. Die Module werden schrittweise aus der bisherigen Arbeitsflächen-Hülle herausgelöst und behalten dabei ihre bestehende Logik, Texte und Styles unverändert.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [workspace-typen.ts](workspace-typen.ts) | Exportiert Theme und Props der Arbeitsfläche. |
| [workspace-konstanten.ts](workspace-konstanten.ts) | Enthält die responsive Grenze der Arbeitsfläche. |
| [akzent-kontrast.ts](akzent-kontrast.ts) | Ermittelt die lesbare Vordergrundfarbe zum Akzent. |

## Schnittstellen

Die Module werden von der Arbeitsflächen-Hülle und den ausgelagerten Ansichten verwendet. Sie importieren keine Ansicht und keine Arbeitsflächen-Hülle.

## Abhängigkeiten

Die Typen und die Konstante sind eigenständig. [akzent-kontrast.ts](akzent-kontrast.ts) verwendet ausschließlich Standardfunktionen von JavaScript.

## Siehe auch

- [Komponenten](../README.md)
- [Ursprüngliche Arbeitsflächen-Hülle](../SynapseWorkspaceMock.tsx)
