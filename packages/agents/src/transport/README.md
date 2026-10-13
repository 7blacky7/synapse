# Wrapper-Zugriffsschicht

[Synapse](../../../../README.md) › [Übergeordneter Ordner](../README.md) › Wrapper-Zugriffsschicht

## Zweck

Dieser Ordner kapselt die Datenzugriffe des Spezialisten-Wrappers. PostgreSQL- und HTTP-Implementierung bedienen einen gemeinsamen Vertrag und erfassen ihre Fehlerbilanz.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | `erzeugeTransport` wählt anhand von SYNAPSE_WRAPPER_TRANSPORT die Zugriffsschicht. |
| [`typen.ts`](typen.ts) | `WrapperTransport` definiert Umgebung und gemeinsame Datenformen. |
| [`pg.ts`](pg.ts) | `PgTransport` implementiert den PostgreSQL-Zugriff mit Core-Funktionen. |
| [`api.ts`](api.ts) | `ApiTransport` implementiert den HTTP-Zugriff mit Bearer-Authentifizierung. |
| [`zaehler.ts`](zaehler.ts) | `Buchhaltung` und `BilanzWaechter` erfassen Aufrufe, Fehler und die Transportbilanz. |

## Schnittstellen nach außen

`erzeugeTransport` liefert einen `WrapperTransport`; ohne Auswahl beziehungsweise mit `pg` verwendet die Fabrik PostgreSQL, mit `api` HTTP. Der Vertrag enthält Nachrichten-, Status-, Heartbeat- und Sammelabruf-Datenformen. Das HTTP-Gegenstück liegt in der [Wrapper-Brücke](../../../rest-api/src/routes/wrapper-bridge.ts).

## Abhängigkeiten

Der PG-Weg verwendet pg und [Core](../../../core/README.md). Der API-Weg benötigt den API-Endpunkt und eine autorisierte Token-Konfiguration; tatsächliche Zugangsdaten gehören nicht in diese Dokumentation.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Wrapper](../wrapper.ts)
- [Wissenszugriff](../wissen/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
