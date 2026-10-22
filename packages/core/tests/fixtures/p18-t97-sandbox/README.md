# P18-T97: V6-Sandbox-Testmaterial

Diese 27 Dateien bereiten Schritt 1b des Ablaufentwurfs `bcbb38c6` vor.
Sie führen keine Registrierung, Jobs, Schalteränderungen oder Containerstarts aus.
**Die adversarialen Leser niemals auf dem PC ausführen.** Nur Syntax, Verträge,
Hashes und TAR-Verzeichnis dürfen vor dem gesonderten Live-Go geprüft werden.

## Bestand und TAR

Zwölf eigenständige Pakete enthalten je `manifest.json` und `leser.py`:
referenz, netz, fremdschreiben, endlosschleife, ausgabeflut, symlink, hardlink,
ende-fehlt, ende-falsch, fork, parallel und signal.
Hinzu kommen diese README, `erwartungen.json` und `v6-sandbox-test.tar`.

Die TAR enthält nur zwei reguläre, nicht ausführbare Dateien:
`a.v6` und `b.v6` (je 18 Bytes, Magic `V6P18T97`, Marker A/B).
USTAR, mtime/uid/gid 0, Modus 0644, keine Links oder Verzeichnisse.
TAR: **3072 Bytes**, SHA-256 **ba09685451845396c4021a3b2a2108d5de99023916f77cb0f594f14aa1eb0739**.

`erwartungen.json` versioniert die TAR-Bytes als Base64 sowie Hash, Maße,
Quelltexte der synthetischen Eingaben und Referenz-Artefakthashes.
Die explizite Koordinatorfreigabe vom 22.10.2026 erlaubt ausschließlich die
Ableitung per Synapse-Shell: Base64 daraus lesen, mit `base64 -d` nach
`v6-sandbox-test.tar` schreiben, Hash und Größe vergleichen.
Kein Generator, keine lokale Extraktion, keine zusätzlichen Dateien.
Das ersetzt die separate `eingaben.tar.b64` aus dem Entwurf, damit es bei
exakt 27 Dateien einschließlich der vom User benötigten TAR bleibt.

## Vertrag und Schutz vor versehentlicher Ausführung

Jedes Paket benötigt Schnittstelle 1 und das vollständige `grenzen.version=1`.
Fehlende/ungültige Grenzen führen zum Abbruch, kein Fallback auf Env.
Nur die zwei bekannten Quellhashes und genau 18 Bytes werden akzeptiert.
UID 65532, Arbeitsverzeichnis /arbeit sowie /eingabe und /arbeit im Auftrag
sind Pflicht. Diese Schutzprüfung ersetzt NICHT den externen Sandboxbeleg.
Python-Standardbibliothek, keine externen Imports, Downloads oder Installation.

Manifestwünsche: 5 s, 128 MiB, 16 Dateien, 65536 Bytes; parallel/signal 30 s.
PG bleibt maßgeblich, Wünsche erhöhen keine PG-Grenze.
Fixture-Notbremsen begrenzen den Versuch zusätzlich: keine rekursiven Forks,
höchstens cgroup-PIDs+2 Versuche (PIDs maximal 64), Dateiflut maximal 8 MiB,
Streamflut maximal 64 MiB, absolute Notbremse 62 s.
`fixture_probeumfang_zu_gross` / Notbremse sind fehlende Testvoraussetzungen,
**kein bestandener Sandbox-Guard**.

## Späterer Ablauf, heute nicht ausführen

1. Koordinator belegt Runtime-Pin und funktionierenden Publisher (P18-T102).
   User legt nur die TAR per Tray in den Bibliotheksordner.
2. Eigener synthetischer Reverse-Testeintrag; ausschließlich E, anschließend
   bestätigt/gebunden und E fertig. Keine Siedler-/XP-Datei verwenden.
3. Jeden Leser mit exakten files-Versionen über `leser_registrieren` registrieren;
   Entwurf belassen, niemals aktivieren.
4. Koordinator setzt `reverse_leser` befristet (Vorschlag 30 Minuten) und bei
   freiem Testfenster PG `executor_parallel=2`; Altwerte/Quellen sichern.
   Alle anderen Produktschalter bleiben AUS.
5. `leser_testen` ausschließlich im Testmodus, mit eigenem Testschlüssel je Versuch.
   Derselbe Schlüssel muss deduplizieren. Ein neuer Testschlüssel ändert NICHT
   die Leser-Nutzlast. Lauf-/Leser-/Runtime-Pin, Quellhash und Policy belegen.
6. Pro Job UID, RO-Root, NetworkMode none, CapDrop ALL, Ressourcen und Mounts prüfen.
   Nur einzelne Eingabe und gepinnte Pakete RO, eigener Ausgabeordner RW;
   kein /bib, Projektshare, Docker-Socket oder fremder Arbeitsordner.
7. Ergebnisse und tatsächliche Messwerte mit `erwartungen.json` vergleichen.
   Exit 0 oder Status fertig allein reicht nicht. Testmodus muss
   `aktive_generation_ersetzt=false` liefern.

## Fälle und Varianten

- **referenz:** ein gültiges Objekt, fsync-Artefakt gleich der synthetischen Quelle.
- **netz:** je ein kurzer TCP-/UDP-Versuch an 192.0.2.1:9 (Dokumentationsadresse).
  Keine DNS-Abfrage/Portsuche. Vor Durchführung Ziel durch Koordinator bestätigen.
  Nur belegte Netzabwehr plus NetworkMode none zählt; Timeout allein nicht.
- **fremdschreiben:** /eingabe sowie synthetische Schreibziele unter /leser,
  /opt/reverse, / und /arbeit-nachbar; /arbeit und /tmp als positive Kontrollen.
  Bei erfolgreichem Fremdschreiben Exit 42, Serie stoppen und Belege erhalten.
  Die synthetische Nachbaradresse beweist allein keine Isolation echter Paralleljobs.
- **endlosschleife:** CPU-Last bis Sandbox-Abbruch; zusätzliche Notbremse darf
  nicht irrtümlich als erfolgreicher Deadline-Beleg gelten.
- **ausgabeflut:** A überlange Zeile, B Artefakt größer als Schrittbudget.
  Die ebenfalls implementierten Varianten `stderr` und `protokoll` benötigen
  vor ihrem späteren Versuch eine eigene unveränderliche Leserrevision
  (`VARIANTE` per freigegebenem files-Plan setzen, neu registrieren/pinnen).
  Kein Ändern eines laufenden Pakets; heute nur die Standardrevision vorbereiten.
  Ein früherer Guard kann spätere verdecken; nur den gemessenen Guard abhaken.
- **symlink/hardlink:** Links ausschließlich im eigenen RW-Baum erzeugen.
  Ihre Erstellung darf gelingen, ihre Akzeptanz muss scheitern.
- **ende-fehlt:** A Objekt ohne Ende, B danach abgeschnittenes JSON, jeweils Exit 0.
- **ende-falsch:** A falscher Objektzähler, B Daten nach Ende, jeweils Exit 0.
  Zusatzvariante `VARIANTE="leer"` wie oben nur mit neuer gepinnter Revision.
- **fork:** begrenzte, nichtrekursive Kinder; Cgroup-Grenze und EAGAIN messen.
  Kinder werden geordnet beendet und eingesammelt; kein Einfluss auf fremde PIDs.
- **parallel:** A/B schreiben denselben relativen Namen mit unterschiedlichen
  Markern und Generationen. Zwei Container und überlappende Zeiträume belegen;
  zwei Queue-Einträge allein genügen nicht. Hash des Artefakts hängt von der
  jeweiligen Generation ab und wird im Lauf unabhängig geprüft.
- **signal:** nummerierter fsync-Marker, dann Warten ohne Erfolgs-Ende.
  **OFFEN:** SIGTERM-Handler und freigegebener Steuerweg gehören zu P18-T103,
  erst nach V6 beim zweiten Reverse-Image-Bau. Auch Idle-Signalprobe bleibt offen.
  Diese Fixture aktiviert keine Signalprobe und sendet selbst kein Signal an PID 1.

## Abbruch, Nachhervergleich und Aufräumen

Bei fremden Jobs, Policywechsel, ungültigen Mounts/UID, Außenverbindung,
Fremdschreiben, Cross-Job-Zugriff oder falschem Erfolg: keine weiteren Starts,
eigenen Job nur über freigegebenen Lifecycle beenden, Belege erhalten.
Keine aktive Generation, keine Assets/Code aus diesen Tests publizieren.
Vorher/Nachher gegen den Projektstand NACH diesem beabsichtigten Fixture-Commit
vergleichen; normale Index-/Versions-/Auditänderungen getrennt ausweisen.
Koordinator stellt Schalter und PG-Werte zurück und deaktiviert Testleser.
Testeintrag nur archivieren; physisches Entfernen erst über T99.
Kein direktes SQL-DELETE und kein Aufräumen fremder Share-/Projektdaten.
