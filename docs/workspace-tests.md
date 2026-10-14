# Tests im Workspace-Container

Der Workspace erhält Quellen aus PostgreSQL. Im Projektroot wird pnpm-lock.yaml als Buildmetadatum synchronisiert, bleibt aber in Suche und Embeddings ausgeblendet. Paketordner, .git und echte .env-Dateien bleiben gesperrt. Nach dem Daemon-Neustart und PG-Sync den Workspace materialisieren und mit pnpm install --frozen-lockfile installieren. Keine neue Lockdatei im Container erzeugen.

Für package.json-Verzeichnisse stellt materialize ausschließlich node_modules und dist als Build-Artefaktverzeichnisse bereit. Quellfiles bleiben root:root/0444; vor jedem Exec setzt die API außerdem /workspace selbst auf root:root/0755, damit Rootquellen nicht durch Unlink/Ersetzen umgangen werden. Die Absicherung nutzt einen festen Root-Exec mit anschließendem UID-/GID-/Mode-Nachweis; ein Tar-Eintrag für „.“ ändert Dockers Extraktionsverzeichnis nicht. Home und /tmp bleiben für Werkzeuge und eigene Testdaten verfügbar. Builds nutzen die Tasks aus .mise.toml.

Das Systemprojekt erhält im Workspace ausschließlich den explizit konfigurierten Testzugang aus SYNAPSE_TEST_DATABASE_URL, dessen Ziel mit der bestehenden privaten Serverfreigabe übereinstimmen muss. Für andere Projekte bleibt der Registry-Zugang aus project(projekt_db) maßgeblich. Keine System-DB-Zugangsdaten, kein neues Secret im Repo oder in den Aufrufparametern. Laufzeit-DB-Guards beziehen ihre Sollidentität weiterhin aus privaten Jobmetadaten.

Die API erkennt eine direkt gestartete Node-Testdatei nativ und kanonisch unter packages/*/tests/** oder scripts/test-*. Nur im Workspace-Ausführungsweg entfällt für diese Datei die statische Datei-Schreibprüfung. DB-, Netzwerk-, Prozess- und Selbstschutzprüfungen bleiben wirksam. Produktquellen, unbestätigte Pfade und der lokale Daemon erhalten diese Ausnahme nicht. Testdateien mit nicht unterstützten Starterflags/Loadern brauchen weiterhin einen klar aufgelösten direkten Aufruf.

Eigene Liveprobe nach dem Deploy:
- shell isolated:true, command node packages/core/tests/workspace-datei-p10-t68.mjs
- anschließend direkt `node packages/core/tests/asset-inspektion-share-p13-a12.test.mjs` im Container ausführen, ohne angehängte Shell-Wrappersyntax. Exitcode und Ausgabe aus der Shell-Antwort lesen.

Zusammengesetzte Wrapper mit `echo … $?`, Pipes oder nicht sicher auflösbarer Syntax können die DB-Zuordnung verhindern und bleiben dann Anleitung. Das ist kein Beleg für fehlende Testzugangsdaten; die direkte Testdatei ist der maßgebliche Aufruf.

Die Liveprobe schreibt nur in eine eigene mkdtemp-Wurzel und versucht Schreiben, chmod, Rename und Entfernen ausschließlich an workspace-source-p10-t68.txt. Alle vier Quelländerungen müssen vom Betriebssystem abgewiesen werden. Ein grüner Metadatentest ersetzt diesen tatsächlichen Nachweis nicht.

Abnahmemaßstab A (Koordinatorentscheidung bau-asset-reverse #26568): Der lokale t83/t84-Weg ist die unveränderte Baseline. Rein indirekte Importklassen B6–B8 bleiben lokal frei: alternative oder unbekannte URL-Basen, absolute Segmente in path.resolve und indirekte/umgebundene Pfadbindungen werden nicht als Importinhalt analysiert. Die vier entsprechenden Quelltext-Gegenproben in shell-test-temp-p10-t65.test.mjs heißen ausdrücklich „Bekannte lokale Grenze“ und erwarten diese Freigabe. Sie führen die Importquellen nicht aus; ihre Freigabe beweist keine ungefährlichen Seiteneffekte. T68 ergänzt keine statische JS-Analyse und keine allgemeine Bestätigungspflicht für lokale Testdateien.

Dateischreibende Tests laufen künftig über den Container-Weg. Dessen Betriebssystemschutz muss insbesondere direktes Schreiben, chmod, Rename und Unlink an Quellfiles verhindern. Die direkte A12-Probe auf t86 ist grün; der echte Docker-Ownership-Gegenfall aus t86 wird in P10-T70 korrigiert. Die Endabnahme verlangt die grüne Quellschutz-Liveprobe auf t87. Die übrigen historischen Provenanztests der verworfenen statischen Variante sind kein Abnahmebeleg für T68; ihr alter Sollstand bleibt als Historie erkennbar und wird in der Testphase gesondert bewertet.
