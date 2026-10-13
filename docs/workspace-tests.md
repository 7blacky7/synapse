# Tests im Workspace-Container

Der Workspace erhält Quellen aus PostgreSQL. Im Projektroot wird pnpm-lock.yaml als Buildmetadatum synchronisiert, bleibt aber in Suche und Embeddings ausgeblendet. Paketordner, .git und echte .env-Dateien bleiben gesperrt. Nach dem Daemon-Neustart und PG-Sync den Workspace materialisieren und mit pnpm install --frozen-lockfile installieren. Keine neue Lockdatei im Container erzeugen.

Für package.json-Verzeichnisse stellt materialize ausschließlich node_modules und dist als Build-Artefaktverzeichnisse bereit. Quellfiles bleiben root:root/0444; vor jedem Exec setzt die API außerdem /workspace selbst auf root:root/0755, damit Rootquellen nicht durch Unlink/Ersetzen umgangen werden. Home und /tmp bleiben für Werkzeuge und eigene Testdaten verfügbar. Builds nutzen die Tasks aus .mise.toml.

Das Systemprojekt erhält im Workspace ausschließlich den explizit konfigurierten Testzugang aus SYNAPSE_TEST_DATABASE_URL, dessen Ziel mit der bestehenden privaten Serverfreigabe übereinstimmen muss. Für andere Projekte bleibt der Registry-Zugang aus project(projekt_db) maßgeblich. Keine System-DB-Zugangsdaten, kein neues Secret im Repo oder in den Aufrufparametern. Laufzeit-DB-Guards beziehen ihre Sollidentität weiterhin aus privaten Jobmetadaten.

Die API erkennt eine direkt gestartete Node-Testdatei nativ und kanonisch unter packages/*/tests/** oder scripts/test-*. Nur im Workspace-Ausführungsweg entfällt für diese Datei die statische Datei-Schreibprüfung. DB-, Netzwerk-, Prozess- und Selbstschutzprüfungen bleiben wirksam. Produktquellen, unbestätigte Pfade und der lokale Daemon erhalten diese Ausnahme nicht. Testdateien mit nicht unterstützten Starterflags/Loadern brauchen weiterhin einen klar aufgelösten direkten Aufruf.

Eigene Liveprobe nach dem Deploy:
- shell isolated:true, command node packages/core/tests/workspace-datei-p10-t68.mjs
- anschließend A12 mit der aktuellen Team-Testdatei im Container ausführen.

Die Liveprobe schreibt nur in eine eigene mkdtemp-Wurzel und versucht Schreiben, chmod, Rename und Entfernen ausschließlich an workspace-source-p10-t68.txt. Alle vier Quelländerungen müssen vom Betriebssystem abgewiesen werden. Ein grüner Metadatentest ersetzt diesen tatsächlichen Nachweis nicht.

Abnahmemaßstab A (Koordinatorentscheidung bau-asset-reverse #26568): Der lokale t83/t84-Weg ist die unveränderte Baseline. Rein indirekte Importklassen B6–B8 bleiben lokal frei: alternative oder unbekannte URL-Basen, absolute Segmente in path.resolve und indirekte/umgebundene Pfadbindungen werden nicht als Importinhalt analysiert. Die vier entsprechenden Quelltext-Gegenproben in shell-test-temp-p10-t65.test.mjs heißen ausdrücklich „Bekannte lokale Grenze“ und erwarten diese Freigabe. Sie führen die Importquellen nicht aus; ihre Freigabe beweist keine ungefährlichen Seiteneffekte. T68 ergänzt keine statische JS-Analyse und keine allgemeine Bestätigungspflicht für lokale Testdateien.

Dateischreibende Tests laufen künftig über den Container-Weg. Dessen Betriebssystemschutz muss insbesondere direktes Schreiben, chmod, Rename und Unlink an Quellfiles verhindern. Echte Container-/A12-/Rootschutz-Belege stehen bis zur W3-Testphase aus. Die übrigen historischen Provenanztests der verworfenen statischen Variante sind kein Abnahmebeleg für T68; ihr alter Sollstand bleibt als Historie erkennbar und wird in der Testphase gesondert bewertet.
