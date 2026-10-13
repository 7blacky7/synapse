# REST-API-Tests

[Synapse](../../../README.md) › REST-API-Paket › Tests

## Zweck

Dieser Ordner enthält Prüfungen für die HTTP- und JSON-RPC-Seite der REST API. Die Suites testen unter anderem die Weitergabe gemeinsamer Tool-Antworten, Agenten- und Ereignisabläufe, Code- und Asset-Abfragen sowie die Absicherung des Prüfcontainers.

## Inhalt

| Thema | Dateien |
|---|---|
| Agentenlaufzeit und Artefakte | [`agent-runtime.test.mjs`](agent-runtime.test.mjs), [`artefakt.test.mjs`](artefakt.test.mjs), [`runtime-root.test.mjs`](runtime-root.test.mjs) |
| Asset-Intelligence | [`asset-intel-strecken.test.mjs`](asset-intel-strecken.test.mjs), [`asset-intel-weiche.test.mjs`](asset-intel-weiche.test.mjs) |
| Chat, Ereignisse und Herkunft | [`chat-lifecycle-p10-t16.test.mjs`](chat-lifecycle-p10-t16.test.mjs), [`chat-unread-p10-t49.test.mjs`](chat-unread-p10-t49.test.mjs), [`event-escalation-p10-t8.test.mjs`](event-escalation-p10-t8.test.mjs), [`event-lifecycle-p10-t17.test.mjs`](event-lifecycle-p10-t17.test.mjs), [`user-herkunft-p10-t41.test.mjs`](user-herkunft-p10-t41.test.mjs) |
| Codeindex, Pfadsuche und Streckenvergleich | [`code-intel-limit-p10-t20.test.mjs`](code-intel-limit-p10-t20.test.mjs), [`code-intel-path-p4-t76.test.mjs`](code-intel-path-p4-t76.test.mjs), [`search-path-pg-p10-t15.test.mjs`](search-path-pg-p10-t15.test.mjs), [`streckenvergleich.test.mjs`](streckenvergleich.test.mjs) |
| Wissen | [`memory-is-update-p10-t12.test.mjs`](memory-is-update-p10-t12.test.mjs) |
| Prüfcontainer und Parser-Sprachen | [`pruef-container-build.test.mjs`](pruef-container-build.test.mjs), [`pruef-container-erstpruefung.test.mjs`](pruef-container-erstpruefung.test.mjs), [`pruef-container-fp.mjs`](pruef-container-fp.mjs), [`pruef-container-funktional.test.mjs`](pruef-container-funktional.test.mjs), [`pruef-container-jvm.test.mjs`](pruef-container-jvm.test.mjs), [`pruef-container-mutation.mjs`](pruef-container-mutation.mjs), [`pruef-container-system.test.mjs`](pruef-container-system.test.mjs), [`pruef-container.test.mjs`](pruef-container.test.mjs), [`pruef-container-treesitter.test.mjs`](pruef-container-treesitter.test.mjs) |

## Schnittstellen nach außen

Die Tests bauen Fastify-Apps oder verwenden REST-Routen und prüfen deren Verhalten über HTTP-Injection. Einige Streckentests vergleichen die REST-API mit dem [Core](../../core/src/README.md) und dem [MCP-Server](../../mcp-server/README.md). Die Implementierung der REST-Routen und Middleware liegt im [REST-API-Quellcode](../src/README.md).

## Abhängigkeiten

Die Tests verwenden Node.js-Testmodule und das gebaute REST-API-Paket; einzelne Suites laden außerdem Core- oder MCP-Server-Builds. Prüfcontainer-Suites binden Docker und ein Prüfcontainer-Image ein; wenn diese Voraussetzungen fehlen, kennzeichnen sie den Lauf als übersprungen. Datenbankgestützte Tests sind ausschließlich mit der Testdatenbank `synapse_test` und eigenen Testprojekten auszuführen.

## Siehe auch

- [REST-API-Paket](../README.md)
- [Core-Quellcode](../../core/src/README.md)
- [MCP-Server](../../mcp-server/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
