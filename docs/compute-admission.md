# P20 R2.2 – gemeinsame GPU-Admission

Die neue Zulassung ergänzt die vorhandenen Chunk- und Work-Job-Claims. Standard ist aus: `SYNAPSE_COMPUTE_ADMISSION=1` aktiviert die serverseitige Zulassung. Bestehende Antworten ohne das neue Feature behalten ihren Vertrag.

Drei Größen bleiben getrennt:

- `leasedChunks`: vorhandene fachliche Chunk-Leases, einschließlich Prefetch.
- `domains`: wartende Anforderungen und reservierte HTTP-Stapel je physischer Domain. Eine Grant kann kurz auf einen lokalen Queue-Slot warten; die Zahl beschreibt Admissionreservierungen, keine gemessene GPU-Auslastung.
- `models`: einmalige VRAM-Reservation je kanonischem Modell und Domain. Modell und `:latest`-Alias teilen diese Reservation.

## Vertrauenswürdige Bindung und Konfiguration

`SYNAPSE_COMPUTE_RESOURCE_BINDINGS` bindet ausgegebene Node-IDs an Host und Geräte. Mehrere Prozesse auf demselben Gerät verwenden denselben `computePhysicalDeviceKey`: die JSON-Darstellung `[hostResourceDomain,deviceId]`. Eine einzige gebundene GPU ist eindeutig. Bei mehreren Geräten wählt `SYNAPSE_COMPUTE_ADMISSION_DEVICES` die Betreiberzuordnung je Node. Das ist keine Cliententscheidung und keine VRAM-Summe über mehrere GPUs.

`SYNAPSE_COMPUTE_ADMISSION_DOMAINS` enthält pro Geräteschlüssel:

| Feld | Bedeutung |
| --- | --- |
| maxHttp | Gemeinsame maximale Zahl gleichzeitig reservierter GPU-HTTP-/Work-Slots |
| interactiveReserve | Für Interaktiv freigehaltene Slots; Hintergrund/Nachzug können sie nicht belegen |
| vramMb | Betreiberlimit für die gemeinsame VRAM-Reservation |
| modelMb | Modellname zu reservierten MiB, aus Profil/Messung; keine Modellwerte im Code |
| pollMs | PG-Wiederprüfung außerhalb der Transaktion; Standard 50 ms |
| maxWaitMs | Höchste Wartezeit auf einen Grant; Standard 30000 ms |
| agingMs | Aging der Prioritätsklasse; Standard 300000 ms |

Modellnamen werden kanonisiert. Widersprüchliche Budgets für Modell und `:latest` werden abgewiesen. Die erste deklarierte Policy wird unter Host-/Gerätelock in `compute_admission_domains` gebunden. Weitere Prozesse müssen denselben kanonischen Policyhash liefern. Abweichungen ergeben `admission_domain_config_conflict`, statt mit unterschiedlichen Caps zu rechnen.

Zusätzlich begrenzt aktuelle `ComputeResources`-Telemetrie das Budget: GPU-Gesamt/frei müssen `measured`, `device` und anhand der PG-Zeit `fresh` sein. `SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS` legt das zulässige Alter fest. Nur beobachtete eigene Modellresidenz erhält einen Kredit. Fehlende/stale Werte bleiben unbekannt. GPU-Work-Job-Reservationen einer Hostdomain werden konservativ berücksichtigt, auch nach verlorener Lease. Neue GPU-Grants müssen die gebundene Hostdomain oder den physischen Geräteschlüssel liefern; ein beliebiger Namespace ist keine Geräteauthority. Noch nicht zuordenbare Legacy-GPUarbeit verhindert eine neue Ressourcenzusage.

Der API-Server erhält seine lokale private Identität erst nach erfolgreichem `ServerExecutor.start()`. Backendadresse und Modell des tatsächlichen Requests müssen zum registrierten Knoten passen. Die konfigurierte Server-Gerätewahl muss zur Admission-Gerätewahl passen. Prozesse ohne diese Anbindung werden gesperrt und nach Herkunft als `uncovered` sichtbar.

## Ausführung und API

Host-Advisory-Lock kommt vor GPU-Lock, danach Knoten-/Registry-/Job-/Chunklocks. Die Transaktionen enden vor Ollama, Qdrant, Docker und Dateizugriffen. Lokale Limits `EMBED_MAX_CONCURRENT` und `SYNAPSE_NODE_MAX_CONCURRENCY` bleiben Backpressure. Während PG-Wartens gibt ein Frame seinen lokalen Slot frei und erwirbt ihn nach dem Grant wieder; wartende Hintergrundframes blockieren dadurch keinen lokalen Interaktivslot.

Ollama wird am echten `embedRaw`-HTTP-Leaf zugelassen, nicht pro Text oder Prefetchclaim. Parser, Wissensstapel/-einzelwege, Core-Interaktiv und Medien liefern Herkunftskontext. Direkte ungebundene Provideraufrufe werden bei aktiver Zulassung gezählt und abgewiesen. Remote-/Cloud-Medien ohne lokale GPU erzeugen keine erfundene lokale GPU-Rechnung.

Der Computeagent benutzt ausschließlich die vorhandene API und seinen nodegebundenen Compute-Ausweis:

- `GET /api/embedding-nodes/:nodeId/admission`: aktive Admission und Poll-/Warteparameter.
- `POST` auf derselben Route: `acquire` mit Request-ID, Boot-ID, Modell, Backend und tatsächlichen Chunk-ID/Token/Hash-Refs; `finish` mit dem erhaltenen Token und bestätigtem HTTP-Ende.

Die API bestimmt Domain, Budget, Quelle und Priorität. Chunkrefs werden gegen eigene aktuelle Leases und tatsächliche Projektfreigaben geprüft. Ein Requesthash verhindert Wiederverwendung desselben Slots für andere Claimrefs/Backends. Eine clientbehauptete Projektliste ist keine Authority. Boot, Tokenhash, Knotensperre, Capabilitypolicy und Backendbindung bleiben gefencet.

Der Agent ergänzt das Protokollfeature `compute_admission` und behält vorhandene Registrierungsfeatures. Core wird erst nach ENV/Referenzbootstrap geladen. Ein alter API-Stand mit 404 oder explizit deaktivierter Admission behält den HTTP-only Clientpfad. Geerbte Server-Admissionflags führen auf dem PC niemals zu lokalen PG-Abfragen.

## Drain, Modellkontrolle und Beobachtung

Aktive Admission bricht laufende Embeddings nicht für Interaktiv ab. Globale Embeddingpause wird nicht zum Ausweichen verwendet. Internes Laden/Entladen/Messen ist exklusiv und wartet auf den Drain bereits reservierter GPU-Arbeit.

Vollständig konsumierte HTTP-Antwort bestätigt das Ende der HTTPoperation. Netzwerkverlust hält die Reservation als `unconfirmed`; Lease-/Wartetimeout ist kein physischer Freigabebeleg. Abschlüsse verwenden die ursprünglich gespeicherte Domain/Boot-/Authbindung und bleiben nach deaktivierter Neuannahme möglich. Wiederholte Abschluss-ACKs sind idempotent.

Modellreservation endet erst nach tatsächlicher `/api/ps`-Absenz auf dem gebundenen Backend. Die vor der externen Probe erfasste Modellrevision muss noch passen; ein zwischenzeitlicher neuer Grant darf durch einen alten Absenzbeleg nicht freigegeben werden.

`setDomainConfig(nodeId,expectedHash)` ist ein privater serverseitiger CAS-Anschluss für spätere Betreiber-/Brokeränderungen. Er verlangt vollständigen Drain, keine lebenden wartenden Anforderungen und bestätigte Modellabsenz. Es gibt keine öffentliche Konfigurations-Schreibroute. Erst alle Produzenten anbinden und W3 prüfen, danach einen kontrollierten Betrieb mit passenden Bindungen/Telemetrie aktivieren.

Bei aktivem Gate ergänzt der bestehende Internstatus `compute_admission` mit Herkunftszählern, geleasten Chunks, HTTPreservierungen und Modellreserven. `embedding_admission` im Work-Audit belegt die aktive Chunkzulassung; `reservedHttpBatches:0` ist Prefetch und behauptet keine GPU-Rechnung.

R2.2 allein verspricht keine universelle physische Untersekundenlatenz auf einer vollständig belegten, nicht präemptierbaren GPU. Die W3-Testphase prüft zwei Prozesse, Fake-Ollama, alle Prioritätszweige, tatsächliche HTTP-Überlappung, Caps/Reserve, kein Abort, Caller-/Lease-/Policy-/Projektfences, Herkunftsdeckung und den unveränderten Alt-Claimvertrag. Hardwarelatenz erfordert anschließend ihren eigenen Messbeleg.
