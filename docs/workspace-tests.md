# Tests im Workspace-Container

Der Workspace erhält Quellen aus PostgreSQL. Im Projektroot wird pnpm-lock.yaml als Buildmetadatum synchronisiert, bleibt aber in Suche und Embeddings ausgeblendet. Paketordner, .git und echte .env-Dateien bleiben gesperrt. Nach dem Daemon-Neustart und PG-Sync den Workspace materialisieren und mit pnpm install --frozen-lockfile installieren. Keine neue Lockdatei im Container erzeugen.

Für package.json-Verzeichnisse stellt materialize ausschließlich node_modules und dist als Build-Artefaktverzeichnisse bereit. Quellfiles bleiben root:root/0444; vor jedem Exec setzt die API außerdem /workspace selbst auf root:root/0755, damit Rootquellen nicht durch Unlink/Ersetzen umgangen werden. Home und /tmp bleiben für Werkzeuge und eigene Testdaten verfügbar. Builds nutzen die Tasks aus .mise.toml.

Das Systemprojekt erhält im Workspace ausschließlich den explizit konfigurierten Testzugang aus SYNAPSE_TEST_DATABASE_URL, dessen Ziel mit der bestehenden privaten Serverfreigabe übereinstimmen muss. Für andere Projekte bleibt der Registry-Zugang aus project(projekt_db) maßgeblich. Keine System-DB-Zugangsdaten, kein neues Secret im Repo oder in den Aufrufparametern. Laufzeit-DB-Guards beziehen ihre Sollidentität weiterhin aus privaten Jobmetadaten.

Die API erkennt eine direkt gestartete Node-Testdatei nativ und kanonisch unter packages/*/tests/** oder scripts/test-*. Nur im Workspace-Ausführungsweg entfällt für diese Datei die statische Datei-Schreibprüfung. DB-, Netzwerk-, Prozess- und Selbstschutzprüfungen bleiben wirksam. Produktquellen, unbestätigte Pfade und der lokale Daemon erhalten diese Ausnahme nicht. Testdateien mit nicht unterstützten Starterflags/Loadern brauchen weiterhin einen klar aufgelösten direkten Aufruf.

Eigene Liveprobe nach dem Deploy:
- shell isolated:true, command node packages/core/tests/workspace-datei-p10-t68.mjs
- anschließend A12 mit der aktuellen Team-Testdatei im Container ausführen.

Die Liveprobe schreibt nur in eine eigene mkdtemp-Wurzel und versucht Schreiben, chmod, Rename und Entfernen ausschließlich an workspace-source-p10-t68.txt. Alle vier Quelländerungen müssen vom Betriebssystem abgewiesen werden. Ein grüner Metadatentest ersetzt diesen tatsächlichen Nachweis nicht.

Offener Maßstab zur Abnahme: Der unveränderte lokale t83/t84-Guard lässt einige rein indirekte Importformen aus dem alten Gegenfallkorpus durch. Die Entscheidung dazu liegt beim Koordinator (thought ea416db6); T68 führt keine neue lokale statische Helfer-/Pfadanalyse ein.
