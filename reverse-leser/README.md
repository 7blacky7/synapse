# Externe Reverse-Leser (Schnittstelle 1)

Autorenvertrag: packages/core/src/services/reverse-leser-vertrag.ts.
Ausführung und unabhängige Prüfung: docker/synapse-reverse/leser.py und
packages/rest-api/src/services/reverse-leser-executor.ts. Manifest und Quellen
werden getrennt von Nutzdaten als unveränderliche registrierte Revision gepinnt.
Diese Pakete sind noch nicht global registriert/aktiviert. Produktstandard AUS.

Registrierung verlangt explizite Nachher-Erwartungen:
`leser_quelle={project,stand:"nachher",manifest_pfad,manifest_version_id,
manifest_sha256,manifest_bytes,dateien:[{pfad,version_id,sha256,bytes}]}`.
Manifestpfad ist ein sicherer relativer Projektpfad; Codedateien sind relativ
zu dessen Ordner. SHA256 und UTF8-Bytezahl sind für Manifest und jede Datei
Pflicht. Eine absichtlich leere Code-Nebendatei verwendet bytes:"0" samt
Leerhash. Manifest und Einstiegspunkt werden unabhängig validiert.

version_id bezeichnet die Änderung, deren NACHHER-Stand gemeint ist.
file_versions.content selbst ist der VORHER-Stand. Der gemeinsame Reverse-
Nachher-Resolver liest die erste nächste Version aus einem anderen Batch,
sonst den nicht gelöschten aktuellen PG-Inhalt exakt desselben Projektpfads.
Er prüft tatsächliche Bytes/Hash gegen Quellenmetadaten UND Erwartungen.
Nur Manifest und explizit angegebene, mit manifest.dateien identische Pfade
sind lesbar; es gibt keinen Vorher-, Diff-, FS- oder SSH-Fallback.
Alte Registrierungsblöcke ohne stand/Erwartungen werden abgewiesen.

Die Registry speichert den normalisierten Request und seine geprüften
Quellbelege unveränderlich. Die Revisionsidentität enthält logische
Anker/Hash/Bytes; eine spätere andere physische Lesestelle ändert sie nicht.
Ein bestätigter gleicher Registrierungsretry bleibt auch nach Quellenlöschung
gültig. Gleicher Lesername und Version mit anderer Quelle sind ein Konflikt.
Registrierung erzeugt nur einen Entwurf, keine Jobs oder Aktivierung.

Die spätere Paketbereitstellung nutzt denselben Resolver. Vorhandene
hashgeprüfte eigene Pakete werden wiederverwendet; für fehlende Bytes muss
die historische Nachher-Quelle weiterhin nachweisbar sein. Eine Registry-
Bestätigung allein garantiert daher keine spätere Rekonstruktion gelöschter
Projektquellen. Bereits gespeicherte alte Leserrevisionen behalten ihren
expliziten Legacy-Vorher-Beleg; neue Aufrufe können diesen Weg nicht wählen.
Neue Paketdateien sind umask-unabhängig0444, neue eigene Paketordner0555.
Unlesbare bestehende Pakete werden abgewiesen und nicht still repariert.

Der Einstiegspunkt liest eine JSON-Zeile auf stdin: Schnittstelle, Eintrag/Datei,
Quellhash/-größe, Leserrevision/Codehash, Generation, Einstellungsrevision,
RO-Eingabepfad, eigener RW-Ausgabepfad, cursor und grenzen. Der Ausgabebereich
ist für Leserartefakte leer; allein der bereits vom Parent geöffnete Spool
.leser-protokoll.jsonl darf existieren und wird vom Leser nie geschrieben.
grenzen.version ist 1; die vom Host projizierte PG-Policy enthält zwingend:
zeit_ms, ram_mib, dateien, bytes, cpu, datei_bytes, protokoll_bytes, zeile_bytes,
eingabe_bytes, lese_bytes, tiefe, poll_ms, wait_ms (positive Dezimalstrings).
Keine Env-/Defaultgrenzen.
Fehlt diese Projektion, scheitert der Leser sichtbar mit pg_grenzen_fehlen.
Teil-B-Anschluss: Batch 28389, leser_stdin projiziert ausschließlich die
serverseitigen Grenzen; Leserwünsche können PG-Policy nicht erhöhen.

Nur Python3-Standardbibliothek; keine Installation, Shell, Netzwerkzugriffe,
Projektpfade oder weitere Eingabedateien. Der Host prüft Berechtigungen, Hashpins,
Mounts und JSONL unabhängig. Ein Exit0 oder ein behauptetes Ende ist kein Beweis.
Lokale Pfade sind nur für eigene Prozess-Fixtures; im Container /eingabe RO,
/leser RO, /opt/reverse RO, /arbeit eigener Versuch RW.

## Records und Wiederaufnahme

stdout enthält ausschließlich UTF8-JSONL nach Teil A. Objektzeilen werden in
segment-0001.jsonl bestätigt; stdout schritt nennt dessen Hash, Bytes, Zeilen und
Recordcursor. Objekte nicht zusätzlich auf stdout duplizieren. Alle Byte-/Count-
Werte sind Dezimalstrings. Member-ID/Objektpfad enthalten Strukturposition und
Quelloffset, niemals einen nur von der Ausgabezahl abhängigen Schlüssel.
Dateinamen entstehen aus dem Member-ID-Hash, nicht aus Archivpfaden.

Der Cursor bindet Eintrag, Datei, Originalhash/-größe, Leserrevision/Codehash,
Generation und Einstellungsrevision. Ein fremder/veralteter Cursor wird abgelehnt.
Ein neuer Versuch hat einen leeren Ausgabebereich; vorhandene Ergebnisse werden
nicht überschrieben, geleert oder gelöscht. Teil C bestätigt/adoptiert die
Host-Checkpoints. Diese Pakete können mit einem bestätigten Recordcursor
fortgesetzt werden; Teil B allein erlaubt noch keinen produktiven Resume.

dateien/bytes sind SCHRITTbudgets, keine Gesamtquote. Segmentdatei und
Metadatenbytes zählen mit; max_datei begrenzt auch das Segment. GFX-Indexspeicher
und Leseblöcke sind durch ram_mib begrenzt. Fristen werden bei Reads geprüft.
An einer Grenze bleibt der nächste Record offen, mit Grund und gleichem Cursor;
ein zu großer Einzelrecord wird nicht übersprungen. Bereits bestätigte Records
werden im nächsten Schritt nicht erneut ausgegeben. PG kann zu klein für einen
einzigen Record plus Segment sein: sichtbar teilweise statt Verlust/Endlosschleife
ohne Diagnose. Protokollgrenzen bleiben zusätzlich beim Host wirksam.

Gültige leere Verzeichnisse/Tabellen haben ein strukturiertes Headerobjekt als
Beleg. Ein beschädigter Bereich meldet fehler; falsches Magic meldet
nicht_unterstuetzt. Teil B publiziert solche Endzustände ausdrücklich nicht als
Erfolg; Rohdaten/Diagnose bleiben beim Host erhalten. Hostfreigabe/Registry/
Projektübernahme werden von diesen Paketen nicht geschrieben.

## Siedler-Paket

Kanonisches Fachwissen: Reverse-Eintrag rev-die-siedler-3-229a52 und seine
Erkenntnisse/@ref in siedler3/leser.py. GFX-Headerformat
3ae70584-66b7-4cf9-8cd4-df3d3501c29e v1; historische Herkunft d3d355d5 (T83)
und 44203040 (T89). Keine Spielobjekt-/Volk-/Animations-Enumtabellen kopieren.

Die Manifest-Magicprobe ist ein gemeinsames Kandidatenbyte für GFX und SND;
der Leser verlangt anschließend die vollständige jeweilige Kennung und
konsistente Struktur. Endung/Name entscheiden nie. MZ, insbesondere Siedler3_18,
bleibt PE und wird nicht gelesen. MAP ist außerhalb dieses Pakets.

GFX bewahrt Rohrecords/RGB-Masken/Versätze/Frame-Metadaten. Nullframes sind
legitime Records mit Rohbeleg und kein Speicherfehler. Unbekannte Varianten
bleiben roh mit Grund; kein geratenes Rendering. SND liefert PCM-WAVs, bei
unvollständigem PCM-Frame zusätzlich den ganzen Rohrecord; unbekannte Codecs
nur roh mit Grund. fertig bedeutet vollständig durchlaufene Containerstruktur,
nicht vollständige semantische Dekodierung jedes Rohobjekts.
Keine PNG/GIF-/Vorschauerzeugung; Darstellung folgt im späteren Link-Schritt.

## PAK-Paket und Probe

Quake PACK wird an Magic UND Verzeichnisstruktur erkannt. Memberbereiche werden
vor Zugriff geprüft, inklusive Index-/Headerüberlappung. Leere Member bleiben
Dateien mit Hash des leeren Inhalts. Hierarchische Namen bleiben Metadaten;
gefährliche Pfade werden nie als Ausgabeziel verwendet. Enthaltene PAKs bleiben
unverändert als Member für einen getrennten Leserauftrag; keine versteckte
rekursive Komplettentpackung.

Reine lokale Prozessprobe: uv run --no-project python -B reverse-leser/tests/test_leser.py.
Alle Fixturebytes entstehen selbst im Test, keine fremden Spiel-/Live-Daten.
Keine Docker-/SSH-Probe. In V6 erst: echte Sandbox, Resume-Integration und
Siedler-Regressionsbestand (00=235,03=448,06=1430; SND00=208 WAV+45 Roh)
semantisch gegen Altbestand prüfen. Legacy wird erst nach V6 entfernt.
