# Compute-Knoten: Telemetrie und Steuerung

R4.1 erweitert Register, Heartbeat und Claim-Antworten. Es gibt keinen zusätzlichen Pushkanal. Die API aktiviert `compute_control` über den vorhandenen Featurekatalog; der Client verhandelt Vertragsversion 1. Ohne Verhandlung bleiben Legacy-Antworten unverändert. Legacy-Knoten liefern keinen Freigabe-Ack.

Die API bindet die ausgestellte node_id über `SYNAPSE_COMPUTE_RESOURCE_BINDINGS` an Hostdomain und echte GPU-UUID. Der Agent misst nur die durch `SYNAPSE_GPU_INDEX` ausgewählte GPU. Fehlende/unbekannte Messungen bleiben unknown. CPU-Last entsteht aus CPU-Zeitdeltas; RAM aus der nativen Hostprobe. In einem erkannten Container werden Host-CPU/RAM nicht als gemessene Hostkapazität ausgegeben. GPU-Daten tragen device-Scope, Herkunft nvidia-smi und Messzeit; Frische bewertet die API gemäß `SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS`.

Der interne Brokerdienst `setComputeNodeControl` setzt eine boot-, revisions-, fähigkeits- und gerätegebundene Sollaktion mit Grund und Deadline. Er ist keine weitere öffentliche Steuerroute und gewährt keine Ausführungsrechte. Die vorhandene User-/Projektpolicy und der globale Lock bleiben maßgeblich; resume hebt sie nicht auf.

pause/drain/unload sperren neue Claims und Prefetch. Laufende Stapel einschließlich Ergebnisabschluss enden regulär. Noch nicht gestartete Claims werden über die bestehende Claim-Token-Prüfung zurückgegeben. Fehlgeschlagene Rückgabe, laufende Claimantwort oder verlorene Antwort verhindern den Freigabe-Ack. Eine verlorene Antwort bleibt konservativ ungeklärt; Prozessneustart oder Leaseablauf allein bestätigt keine Ressourcenfreigabe.

Nach dem Drain prüft der Agent das gebundene Gerät, fragt ausschließlich sein konfiguriertes Loopback-Ollama ab und entlädt nur das eigene Modell bei passendem Namen und vollständigem Digest. Fremde Modelle werden nicht entladen. Erst positive Abwesenheit aus /api/ps und erneute Geräteprobe erlauben ackRevision. Fehler/Timeout bleiben pending. SIGTERM meldet keinen physischen Ack.

Die API persistiert Beobachtung und Ack nur für aktuelle Bootgeneration/Revision, ohne laufende Stapel oder offene Claims, vor der Deadline und mit aktueller Gerätebeobachtung. Resource-Leases und Admission werden dadurch nicht automatisch freigegeben: der Broker muss diese Beobachtung unter seinen eigenen Fences auswerten.

Die DDL liegt in `compute-control-schema.ts`, integriert in ensureSchema, und als Spiegel `92_compute_control.sql`. Aktivierung, Test-DB-Migration und Fake-Ollama/Fake-nvidia-Matrix erfolgen in der gemeinsamen W3-Testphase; ein erfolgreicher Build ist keine funktionale Abnahme.
