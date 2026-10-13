# Agentenwissen

[Synapse](../../../../README.md) › [Übergeordneter Ordner](../README.md) › Agentenwissen

## Zweck

Dieser Ordner kapselt den Zugriff auf Metadaten, Wissensabschnitte und Systemprompt eines Spezialisten. Eine gemeinsame Schnittstelle kann lokale Dateien oder die API als Quelle verwenden.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | `erzeugeWissen` und `gewaehlteWissensQuelle` wählen den Wissensadapter. |
| [`typen.ts`](typen.ts) | `WissensZugriff` definiert Vertrag und Ergebnisformen des Agentenwissens. |
| [`datei.ts`](datei.ts) | `DateiWissen` implementiert den Zugriff auf lokale Agenten-Dateien. |
| [`api.ts`](api.ts) | `ApiWissen` implementiert den Zugriff über die HTTP-Wissensschnittstelle. |

## Schnittstellen nach außen

Die Fabrik in [index.ts](index.ts) bietet den gewählten Wissenstransport an. Die API-Implementierung verbindet sich mit den [Agenten-Wissensrouten](../../../rest-api/src/routes/agent-wissen.ts); der Dateiweg verwendet die lokale Wissensverwaltung.

## Abhängigkeiten

Der Dateiweg nutzt [skills.ts](../skills.ts) und [prompts.ts](../prompts.ts). Der API-Weg benötigt autorisierten HTTP-Zugriff; der gemeinsame Vertrag steht in [typen.ts](typen.ts).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Wrapper](../wrapper.ts)
- [Datenzugriff](../transport/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
