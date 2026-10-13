# MCP-Server-Tests

[Synapse](../../../README.md) › MCP-Server-Paket › Tests

## Zweck

Dieser Ordner enthält direkte Prüfungen für den stdio-MCP-Server. Die Suites sichern JSON-Antworten einschließlich Onboarding- und Event-Beigaben sowie das Verhalten des Shell-Tools mit einem Mock-Daemon ab.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`proposal-json-p10-t13.test.mjs`](proposal-json-p10-t13.test.mjs) | Prüft Proposal-Aktionen über den echten stdio-Server, darunter JSON-Antworten, erstmaliges Onboarding und Event-Hinweise. |
| [`shell_tool.test.mjs`](shell_tool.test.mjs) | Prüft den Handler des Shell-Tools mit Testdatenbank, isoliertem Home und Mock-Daemon. |

## Schnittstellen nach außen

Die Tests starten den gebauten [MCP-Server](../README.md) über den MCP-SDK-stdio-Transport und rufen Tools auf. Die Suites laden außerdem Core-Services und verwenden die gemeinsame [Core-Testbereinigung](../../core/tests/_helfer/README.md). Die getesteten Tool-Implementierungen liegen im [MCP-Server-Quellcode](../src/README.md).

## Abhängigkeiten

Die Tests verwenden Node.js-Test- und Laufzeitmodule, das MCP-SDK, den gebauten MCP-Server und Core-Builds. Datenbankgestützte Tests sind ausschließlich mit der Testdatenbank `synapse_test` und eigenen Testprojekten auszuführen.

## Siehe auch

- [MCP-Server-Paket](../README.md)
- [Core-Tests](../../core/tests/README.md)
- [Testhilfen](../../core/tests/_helfer/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
