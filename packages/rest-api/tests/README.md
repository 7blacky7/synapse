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

### Bildprobe (P13-T14/P13-T15)

[`bildprobe-p13-t15.test.mjs`](bildprobe-p13-t15.test.mjs) prüft mit einer Fake-Uhr Default/Max, Mehrfachabruf im Fenster, Schließzeit, eigene 410-Fehlercodes und CF-IP. Lauf: `node packages/rest-api/tests/bildprobe-p13-t15.test.mjs`.

[`bildprobe-p13-t14.test.mjs`](bildprobe-p13-t14.test.mjs) prüft PNG-Dekodierung/CRC, den Inline-Bildblock über beide MCP-Wege, Zeitfenster- und Einmal-Links, Ablauf, parallele Abrufe und die genaue Auth-Ausnahme. Ein Query-Mock ersetzt alle Datenbankzugriffe; es wird keine Datenbankverbindung aufgebaut.

Nach den Core-, MCP- und API-Builds läuft die Probe mit `node packages/rest-api/tests/bildprobe-p13-t14.test.mjs`. `BILDPROBE_VORSCHAU=1` legt zusätzlich ein zufälliges Bild zur eigenen Sichtprüfung unter `/tmp/synapse-p13-t14/positivkontrolle.png` ab. Das Codewort wird weder ausgegeben noch in Auditdaten gespeichert.

Das Testwerkzeug wird mit `admin(action:'bildprobe', modus:'inline'|'link')` aufgerufen; `probe_id` und das gelesene `wort` prüfen dieselbe Probe. Die Prüfung liefert auch Abrufzeit, IP, User-Agent und HTTP-Status für bekannte Links. Links sind standardmäßig mehrfach bis `offen_bis` (ISO, UTC) lesbar. `offen_sekunden` bestimmt das Fenster ab Erzeugung; `einmalig:true` verbraucht den Link beim ersten Abruf. Danach gilt `410` mit `bildprobe_verbraucht`, nach Ablauf `bildprobe_abgelaufen`. `CF-Connecting-IP` wird bei vorhandenem Header als Abruf-IP erfasst; POST zum Erzeugen/Prüfen bleibt authentifiziert. Prozessneustarts verlieren diese Testdaten.

| Umgebung | Standard / Wirkung |
|---|---|
| `SYNAPSE_BILDPROBE_BASE_URL` | Öffentliche Basisadresse; sonst `SYNAPSE_PUBLIC_URL`, `SYNAPSE_API_URL`, zuletzt `http://localhost:3456`. Für entfernte Oberflächen ausdrücklich die öffentliche Adresse setzen. |
| `SYNAPSE_BILDPROBE_TTL_MS` | 600000 ms Inline-Lebensdauer und zusätzliches Metadatenfenster nach Ablauf; verkürzt das Linkfenster nicht. Bereinigung erfolgt bei weiterer Nutzung. |
| `SYNAPSE_BILDPROBE_OFFEN_S` | 600 Sekunden Default-Linkfenster ab Erzeugung, durch `offen_sekunden` überschreibbar |
| `SYNAPSE_BILDPROBE_OFFEN_MAX_S` | 3600 Sekunden Maximalfenster; höhere/ungültige Aufrufwerte werden abgewiesen, nicht gekappt |
| `SYNAPSE_BILDPROBE_WIDTH` / `SYNAPSE_BILDPROBE_HEIGHT` | 480 / 160 Pixel |
| `SYNAPSE_BILDPROBE_MAX_PROBEN` | 128 gleichzeitig aufbewahrte Proben; bei Erreichen sichtbarer Kapazitätsfehler |
| `SYNAPSE_API_URL` / `SYNAPSE_API_TOKEN` | Für stdio-Link-Proben: API-Adresse und vorhandener Bearer-Ausweis. Inline im stdio-Prozess benötigt diese Brücke nicht. |

Ungültige Konfigurationswerte werden sichtbar abgewiesen. Die Probe prüft nur Transport und Bildsichtbarkeit; ob ChatGPT Chat/Work oder claude.ai die Bilder tatsächlich sehen beziehungsweise Links mehrfach abrufen, muss nach dem Deployment in diesen Oberflächen gemessen werden.

## Schnittstellen nach außen

Die Tests bauen Fastify-Apps oder verwenden REST-Routen und prüfen deren Verhalten über HTTP-Injection. Einige Streckentests vergleichen die REST-API mit dem [Core](../../core/src/README.md) und dem [MCP-Server](../../mcp-server/README.md). Die Implementierung der REST-Routen und Middleware liegt im [REST-API-Quellcode](../src/README.md).

## Abhängigkeiten

Die Tests verwenden Node.js-Testmodule und das gebaute REST-API-Paket; einzelne Suites laden außerdem Core- oder MCP-Server-Builds. Prüfcontainer-Suites binden Docker und ein Prüfcontainer-Image ein; wenn diese Voraussetzungen fehlen, kennzeichnen sie den Lauf als übersprungen. Datenbankgestützte Tests sind ausschließlich mit der Testdatenbank `synapse_test` und eigenen Testprojekten auszuführen.

## Siehe auch

- [REST-API-Paket](../README.md)
- [Core-Quellcode](../../core/src/README.md)
- [MCP-Server](../../mcp-server/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
