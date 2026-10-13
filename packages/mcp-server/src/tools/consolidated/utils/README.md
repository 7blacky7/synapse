# Werkzeug-Hilfen

[Synapse](../../../../../../README.md) › [Übergeordneter Ordner](../README.md) › Werkzeug-Hilfen

## Zweck

Dieser Ordner enthält kleine Hilfen für konsolidierte Werkzeugadapter. Batch-Verarbeitung und der Respawn-Trigger sind von den fachlichen Handlern getrennt.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`batch.ts`](batch.ts) | `batchOrSingle` verarbeitet Einzelwerte oder Arrays mit getrennten Ergebnis-/Fehlerlisten; `toArray` vereinheitlicht Eingaben. |
| [`respawn-trigger.ts`](respawn-trigger.ts) | Re-exportiert `maybeTriggerRespawn` aus Core für den Thought-Adapter. |

## Schnittstellen nach außen

[batch.ts](batch.ts) exportiert `batchOrSingle` und `toArray`. [respawn-trigger.ts](respawn-trigger.ts) stellt `maybeTriggerRespawn` für den Thought-Adapter bereit.

## Abhängigkeiten

Batch-Verarbeitung verwendet JavaScript-Promises; der Respawn-Adapter bezieht seine Funktion aus [Core](../../../../../core/README.md).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Thought-Adapter](../thought.ts)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
