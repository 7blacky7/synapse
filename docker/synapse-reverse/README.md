# synapse-reverse container (RV11)

### Zulauf vor einem Reverse-Image-Wechsel (P18-T97)

`reverse_pipeline_halt` ist ein dauerhafter globaler Produkt-Schalter (Standard AUS, nur ausdrücklich; keine intern-/Env-Übersteuerung).
EIN sperrt neue Fachzulassungen. Setter und Fachpfade teilen einen PG-Transaktionslock: der Setter-Commit ist der Cut.
Vorher atomar gebundene Pending dürfen weiter geclaimt werden; laufende Eltern veröffentlichen ihr Ergebnis, legen aber keine Folgeaufträge an.
Ungebundene Jobs des generischen P20-Endpunkts laufen nie und bleiben im Drain-Zähler sichtbar. Das gilt auch bei Halt AUS.
`reverse status` zeigt nach Projektbindung `zulauf.halt`, globale Pending/Running-Zähler und begrenzte Bindungsdiagnosen.
Die Zähler sind nur das logische Tor; physisches Containerende muss der Koordinator zusätzlich belegen.

Betriebsfolge: Halt-Vorlauf-API deployen, Halt EIN mit Auditgrund setzen, Pending/Running auf 0 drainen und physisches Ende belegen,
dann `reverse_siedler3` global AUS auditieren, erst danach Legacy-Abbau/Image/Runtime wechseln. Rollback behält diese Halt-fähige API.
Explizite isolierte Leser-Testläufe bleiben ein gesondert autorisierter Weg; während des Drains werden keine Tests gestartet.
Diese Implementierung setzt selbst keinen Schalter und startet weder Deploy noch Container.


This image provides static extraction and analysis tools. Original programs are data and are never launched. P20 must enforce network disabled, read-only rootfs, user 65532, cap_drop ALL, no-new-privileges, quotas, and the mount policy in thought 51ea56f7.

## Build

Run from the repository root. The base image and upstream archives are pinned in the Dockerfile; Debian packages come from the dated main snapshot.

    docker buildx build --provenance=false --load \
      -f docker/synapse-reverse/Dockerfile -t synapse-reverse:rv11 docker/synapse-reverse

`--provenance=false` makes the local image manifest digest comparable across identical rebuilds. Exact Debian package versions are recorded in `/opt/reverse/versionen-pakete.txt`; upstream versions and SHA-256 values are in `/opt/reverse/versionen.txt`. Python 3.13 is the RV26 reader runtime; it uses the standard library only, with no pip/npm or package installation at runtime.

Check the runtime boundary with:

    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges synapse-reverse:rv11 --self-probe

Expected JSON reports UID 65532, blocked DNS/TCP, and an empty forbidden-tools list.

## Runner

Runner accepts one JSON request per input line, e.g. the executor format `{"kommando":"extrahieren","eingabe":"/bib/<storage_key>","ausgabe":"/arbeit/<jobId>","grenzen":{...}}`. `auftrag_id` is optional; without it the job id is the folder name of `ausgabe` (if both are given they must match). Commands include spurtabelle and extrahieren. The separate leser_ausfuehren command uses the external reader contract documented below. Each request returns progress and a completion record `{status:"fertig", werkzeug_version, format, dauer_s, manifest:[{pfad,groesse,sha256}], ausgabe_bytes}`. Supported limits are zeitlimit_s, max_dateien, max_bytes, max_tiefe, max_kompressionsfaktor.

`extrahieren` picks the extractor from the file content only, never from the extension: ISO9660 (`CD001` at 0x8001/0x8801/0x9001), UDF (`NSR02`/`NSR03` in the volume recognition sequence), 7z, RAR, ZIP/JAR/APK, PE, CAB, OLE/MSI, gzip, bzip2, xz, tar, LHA, ARJ and CUE sheets (text with a `FILE ... BINARY` line). Anything else, e.g. a raw `.img`/`.bin` without these markers, returns `{status:"fehler", fehlercode:"nicht_unterstuetzt", manifest:[]}` without guessing. Tools run with `TMPDIR=/tmp` and `HOME=/tmp`; with a read-only rootfs P20 must mount `/tmp` as tmpfs.

## Disc images (P18-T49/RV34)

Disc images use one shared model: every image parser returns only the *Spurtabelle* (versioned JSON, `disc.py`, mirrored by `ReverseSpurtabelle` in `packages/core/src/services/reverse-spurtabelle.ts`); one shared extractor does the rest. The parser registry (`disc.py`, `REGISTRY`, `REGISTRY_VERSION`) detects the format by content/footer and companion files (CUE, CloneCD `[CloneCD]`, MDS/MDX, B6T, NRG, CDI, cdrdao TOC, C2D, CIF, raw 2352 sectors) and picks the first available parser. libMirage (via `python3-gi`) is the default parser; own parsers register in front of it (`registriere(..., vorne=True)`). A known format without an available parser returns `format_nicht_unterstuetzt` with `format_detail`; a CUE without libMirage keeps the old `bchunk` path.

Parsing and extraction run in their own process (`python3 -I disc.py <auftrag.json>`) with the job time limit, `RLIMIT_AS` (`grenzen.parser_ram_mb`, default 2048) and `RLIMIT_FSIZE`; the output is checked while it grows. Files are offered to libMirage through symlinks with their original names (`eingabe_name`, `begleitdateien[].name`). The extractor writes `spurtabelle.json`, `daten/session<N>.iso` (2048-byte user data from MODE1/MODE2 Form 1 sectors at their absolute LBA; for a later session its volume descriptors are copied to sector 16, recorded as `verweis`), `audio/spurNN.wav` (16-bit stereo 44.1 kHz LE, pregap excluded unless `optionen.wav_pregap`), `rohspuren/spurNN.raw` for MODE2 Form 2/formless/mixed tracks, and then unpacks each ISO with 7-Zip into `inhalt/session<N>/`. Manifest entries of these files carry `art` and `metadaten` (WAV: `asset`, `asset_art: musik`). `kommando: "spurtabelle"` without `werkzeug` returns only the table. Validation rejects tracks outside their file, overlapping tracks and invalid sector sizes (`beschaedigt` / `nicht_unterstuetzt`).

The output folder must be empty and unique to the job. The API must validate the manifest before atomic publication. Ghidra's post-script exports JSONL, one function per row. The runtime has no pip/npm or package installation path.


## PE resources (P18-T76)

The existing E runner can extract individual PE resource leaves with `pe_ressourcen.py`. It uses the same directory/data-entry layout as `exe-pe-resource` (P21-T9): type/name/language directories use offsets relative to the resource root; payload RVAs must map entirely to file-backed section bytes. It never loads or executes the original program.

The global product switch `reverse_pe_ressourcen` defaults to OFF and must be enabled explicitly (the switch `alle` does not enable it). Manage it through `admin(profil_schalter_setzen, profil_funktion:"reverse_pe_ressourcen", ebene:"global", aktiv, grund)` or Settings → Reverse-Bibliothek. The optional internal switch of the same name, mode `freigegeben`, is a temporary override only when the API started with the intern tool enabled. Expiration, disabled intern mode or an unavailable override returns to the product value. The executor passes the effective value and its source to each E job as `optionen.pe_ressourcen` and `optionen.pe_ressourcen_stand`.

**Extraction cost and retained data:** Changing the effective global PE-resource switch, including switching OFF, changes the E profile and schedules full E extraction for automatically analysed complete media when admission is open. The retired Siedler switch no longer changes this profile. Image/tool version changes also require the durable admission halt before deployment. Existing derived files, IDs, provenance and hashes are retained; completed analyses remain reusable.

For each PE found during recursive E extraction, output goes beside the source under `<source>~ressourcen/` (a numbered suffix avoids existing directories). Numeric directory-entry indices form safe filenames; original type/name/language remain in metadata. Every leaf has an unchanged `.bin` and source offset, length, SHA-256 and codepage. ICON adds ICO/PNG, BITMAP adds BMP, and STRING/DIALOG/VERSION add UTF-8 text. Version text includes localized strings, the original fixed-info bytes and structured file/product versions. Unknown resource types remain raw. Existing E date/byte/depth/ratio/time budgets apply to the combined output. Corrupt nodes preserve good siblings and produce a partial result with diagnostics.

Manifest metadata uses the existing T71 origin (`herkunft.archiv/pfad/tiefe`) plus `pe_ressource`; the normal E importer persists it in `reverse_dateien`. Use `reverse(dateien)` for provenance/paging, `reverse(inspect)` for metadata, and `reverse(ansicht)` for ICO/PNG/BMP. No new public tool parameters are introduced.

Tests: `uv run --no-project python -B -m unittest discover -s docker/synapse-reverse -p 'test_*.py'` and `node packages/core/tests/reverse-pe-ressourcen-p18-t76.test.mjs` (the latter requires the Synapse shell's synapse_test:5433 database). `probe-pe-ressourcen.sh <existing-image> <original-exe> <working-sources>` is the coordinator's no-deploy probe: original read-only, output in container tmpfs.


## Ghidra graph and raw normalizers (P18-T74 / RV14)

The existing requested S3 job, controlled by the product switch reverse_s3 (default OFF), runs Ghidra once. ExportFunctions.java exports each function's decompilation, callees (including address space), string/data/import references, and an instruction listing when decompilation fails. Runner limits supply the per-function entry/text/time bounds; the existing output guard and S3 PG budget bound publication. No rizin S2 analysis or second Ghidra pass is started.

After successful Ghidra analysis the same job may collect static S1 stdout with rz-bin (-zj, -ij, -sj); WASM/class magic selects wasm-objdump or javap instead. Fixed s1-* raw files stay in the analysis dataset. normalisierer-status.json reports missing tools, time or budget limits without raw values. The API checks size, SHA-256, regular-file/no-link properties and the job manifest before parsing; all names/text/contexts pass through the shared reverse mask catalog. Only masked records and counters enter the existing reverse code tables. S1 enrichment keeps the current inspector fingerprint; S2 output uses the same S3 job's derived S2 fingerprint. Filename-like strings become RV30 candidates.

For `reverse(verknuepfungen)`, S1 loader hints (including legacy filename candidates) come only from recognized code formats (`pe`, `elf`, `macho`, `mach-o`, `wasm`, `class`, `dex`) or files with a current completed/partial S2 or S3 layer. Arbitrary data containers, images, and script/configuration files such as INI/CFG/LUA/TXT without such a code layer are not S1 sources. This is a source definition, not a result cap; S1-only PE files remain eligible. A function filter uses S3 references only because S1 candidates have no proven source function. Candidates are read in complete keyset batches; `analyse_verweise` controls batch size, while time or other analysis limits remain visible in `analyse_gekappt`.

`reverse(symbols)` also returns `adresse` as a hexadecimal string and `groesse_bytes` as a decimal string, both null when unavailable. Strings preserve exact 64-bit values.

Use existing reverse(calls/references/functions/file) to read the results. A failed function has an S2 .asm function symbol; its S3 placeholder does not duplicate the function symbol. Call/reference source lines point to the calling function's header, while reference context includes the exact machine address. A Ghidra EXTERNAL offset is an index in a separate address space: it is labelled, for example, callee_receiver:"EXTERNAL:0x00000010", call_kind:"import" and is never resolved to a RAM address with the same number.

Tests: node packages/core/tests/reverse-rea1-p18-t74-rv14.test.mjs uses a private schema in synapse_test:5433; optional P18_REA_NORMAL_JSONL / P18_REA_FALLBACK_JSONL point to the coordinator's generated AUTORUN test exports, with S1 raw files beside them. uv run --no-project python -B -m unittest discover -s docker/synapse-reverse -p 'test_*.py' covers runner and extractor contracts.

Coordinator probe: probe-ghidra.sh <existing-image> <original-exe> <working-sources>, with FORCE_FALLBACK=1 for the test-only subclass that forces entry to fail while retaining real Ghidra instructions/graph. Originals mount read-only; all container output is tmpfs. TESTEXPORT_TAR=1 emits generated analysis files as a tar stream; pipe stdout directly into a local scratch directory, never a tool log. A rebuilt reverse image is needed to use the new exporter in production.


## Siedler 3: externer Leser (P18-T97)

Der eingebaute Decoder und sein Image-COPY wurden entfernt. Formatwissen liegt ausschließlich
im versionierten Paket reverse-leser/siedler3/ mit Manifest/Registryvertrag; Fachbelege stehen
am Reverse-Eintrag rev-die-siedler-3-229a52 als Erkenntnisse/@ref.
Der generische Runner lädt keinen Siedler-Decoder und kennt keine Siedler-Dispatch-/Statuszweige.
Explizite alte Requests mit werkzeug:siedler3 oder optionen.siedler3=true scheitern sichtbar
mit format_nicht_unterstuetzt / reverse_siedler3_stillgelegt, bevor ein Ausgabeordner entsteht.
Ein alter false-Wert samt passivem Stand bleibt gemäß Vertrag folgenlos; neue API-Requests senden diese Felder nicht mehr.

reverse_siedler3 bleibt als historischer Kompatibilitätsname sichtbar: effektiv immer AUS,
Produkt/intern-EIN und -AUS werden vor jedem Schreiben abgewiesen. Vorhandene PG-Werte und alle alten Dateien/Hashes/Belege
bleiben erhalten. E-Profil und neue Executorrequests enthalten nur noch die PE-Funktion.
Siedler-Ausgaben entstehen ausschließlich über registrierte allgemeine Leser; Quake-PAK
belegt denselben unveränderten generischen Ausführungsvertrag.

Nach abgeschlossenem V6 ersetzt der eigene feste Fixtureindex
reverse-leser/tests/fixtures/siedler3-golden-v1.json das ausführbare Legacy-Oracle.
Die120 Zufallsfälle prüfen unabhängig Pixel/Quellverbrauch/Offsets; feste PNG-Bytegoldens
einschließlich des historisch belegten Shadow17x6-Falls sowie WAV/Rohbytes bleiben zusätzlich streng.
Der alte Test-Einstieg leitet auf diese externen Regressionen weiter; --export ist entfernt.
Tests erst in der ausdrücklich ausgerufenen Testphase ausführen.

### Gemeinsamer Image-/Runtimewechsel: nur durch den Koordinator

Halt-Vorlauf A zuerst deployen, reverse_pipeline_halt EIN auditieren. WorkJob-Pending/Running
UND lokale API-Aufträge (S0/S1/S3-Nachzug, offene/laufende Arbeit und lebende Leases) müssen
auf null drainen. Physisches Ende zusätzlich belegen. Ungebundene generische Pending halten
das Tor rot. Dann Legacy-Schalter global und effektiv AUS auditieren.
Erst jetzt B mit neu gebautem Reverse-Image und dazu passendem neuem RO-Runtime-Pin
aus den Nachher-Versionen bereitstellen. Alter Runtime-Runner und neues Image dürfen nicht
gemischt werden; im alten Runner steckt noch der entfernte Legacy-Import.
Checkpoint-/Leser-/P20-/Routecode bleibt unverändert; T103-Signalproben gehören zur Testphase.
Rollback: Halt-fähige A-API, altes Image und dazugehöriger alter Runtime-Pin, Legacy effektiv AUS.
Kein automatisches Neu-E/Nachziehen oder Löschen; Halt AUS erst nach gesonderter Betriebsfreigabe.

## Externe Leser: Teil B (noch standardmäßig AUS)

Der Produkt-Schalter `reverse_leser` ist erforderlich. Teil B erzeugt selbst keine
Aufträge und stellt keine neuen Tool-Aktionen bereit. Teil D liefert autorisierte
P20-Jobs (`reverse-leser` / `reverse_leser`) mit genau einer Bindung in
`reverse_leser_laeufe`. Claims verwenden den vorhandenen P20-Dienst, eigene
Capability-Hooks und die bestehende Reverse-Serveridentität.

Jeder Job bekommt eine eigene Lifecycle-Instanz. Gemountet werden ausschließlich:
- die hashgebundene Eingabedatei nach `/eingabe:ro`,
- die freigegebene Leserrevision nach `/leser:ro`,
- der vertrauenswürdige generische Adapter nach `/opt/reverse:ro`,
- ein eigener Versuch nach `/arbeit:rw`.

Kein Gesamtmount von `/bib`, kein Projekt-Share. Ausgabe liegt unter
`<reverseRoot>/<eintrag>/.intern/leser/<generation>/<job>/<versuch>/`.
Vorhandene Ausgaben werden weder geleert noch überschrieben.
Docker erzwingt network none, readonly root, UID/GID 65532, CapDrop ALL,
no-new-privileges sowie CPU/RAM/PIDs/tmpfs aus dem PG-Einstellungssnapshot.
Zeit-, Datei-, Protokoll- und Metadatengrenzen kommen ebenfalls aus PG.
Der Kindprozess läuft als isolierter Python-Interpreter ohne Installation.
Die zusätzliche Baumaufsicht ist eine Abbruchgrenze, keine Dateisystemquote:
zwischen zwei Messungen sind Überschreitungen möglich.

### Ein-Build-Weg für V6

Das bestehende Image startet bereits `/opt/reverse/runner.py`. Ein RO-Bindmount
dieses Verzeichnisses stellt den generischen Adapter ohne Image-Neubau bereit.
Das Dockerfile wird erst beim abschließenden, gemeinsamen Build geändert.

Der Snapshot wird ausschließlich über die gemeinsame Reverse-API bereitgestellt:
`leser_runtime_liste/get` zeigen Registry, Standardrevision, Imagebezug und
Share-Prüfung. `leser_runtime_bereitstellen` liest ausschließlich den PG-Nachher-Stand
von checkpoint.py, leser.py und runner.py unter docker/synapse-reverse/ des
Projekts synapse. `runtime_quelle` enthält zwingend
`{project:"synapse",stand:"nachher",dateien:[{pfad,version_id,sha256,bytes}]}`;
SHA-256 und positive dezimale UTF8-Bytezahl sind Erwartungen des Aufrufers.
Keine freien Pfade und kein impliziter Vorher-/Aktuell-Fallback.

`version_id` ist der Änderungsanker: file_versions.content speichert den Stand
VOR der Änderung. Der Dienst liest für NACHHER den Vorher-Inhalt der nächsten
Version aus einem anderen Batch; Co-Edit-Zeilen desselben Batches zählen nicht.
Fehlt ein Nachfolger, liest er den nicht gelöschten aktuellen code_files-Inhalt
derselben Datei. Alle drei Quellen stammen aus einer READ-ONLY/REPEATABLE-READ-Sicht.
Tatsächliche UTF8-Bytes werden gegen Hashmetadaten UND Request-SHA/Bytes geprüft.
Abweichung liefert `leser_runtime_nachher_geaendert`, fehlender Nachher-Stand
`leser_runtime_nachher_fehlt`. Keine Diff-Rekonstruktion, FS-/SSH-Lesequelle
oder Änderung der Quelltabellen. Alte Quellenblöcke ohne die Pflichtfelder
werden abgewiesen; bereits registrierte Runtimes bleiben verwendbar.

Die logische Identität ist Projekt/Pfad/Nachher-Anker/SHA/Bytes. Der unveränderliche
Runtime-/Requestbeleg nennt zusätzlich die physische Lesestelle (nächste Versions-ID
oder code_file_id/updated_at), Ankerbatch und tatsächlich berechneten Hash/Bytes.
Eigene begonnen-/bereitgestellt-Ereignisse halten den Beleg append-only fest;
die Registry behält den ersten Quellenbeleg. Spätere gleichwertige Quellenbelege
stehen im zugehörigen Requestereignis. Der Inhaltspin enthält keine Versions-IDs.
Ein bestätigter Retry prüft eigenen gespeicherten Requestbeleg und komplettes
RO-Paket statt inzwischen veränderte Projektquellen erneut aufzulösen.
Ein Crash nach Rename kann mit eigenem begonnen-Beleg und vollständig geprüftem
Ziel fortgesetzt werden. Fehlt das Ziel, wird derselbe Nachher-Bezug erneut
geprüft; andere Bytes werden niemals still übernommen. Ein anderer Payload
unter demselben Akteur/Idempotenzschlüssel wird als Konflikt abgewiesen.
Vorschau ist Standard; Schreiben verlangt `vorschau:false`, `grund` und
`runtime_schluessel`. User oder bestätigter Koordinator benötigen dafür den
globalen Produkt-Schalter `reverse_leser_runtime_verwaltung` (Standard AUS).
Die Leser-Ausführung darf während der Bereitstellung weiter AUS bleiben.

Die API hasht die unveränderten UTF-8-Quellen. `index.json` ist exakt
`{dateien:[{pfad,sha256,bytes}]}`, Liste nach Pfad sortiert, Bytes als
Dezimalstrings. Der kanonische SHA-256 dieses Index pinnt den kompletten
RO-Snapshot unter `<reverseRoot>/.intern/leser-runtime/<pin>/`.
Versionen/Herkunft, Image-Digest und Audit stehen gesondert in PG.
Dateien/Verzeichnisse sind 0444/0555; Extras, Symlinks und Hardlinks sind
unzulässig. Vorhandene Snapshots werden geprüft und nie ersetzt.
Abgebrochene Bereitstellungsreste bleiben als Diagnose erhalten.

Bereitstellen aktiviert nichts. `leser_runtime_aktivieren/deaktivieren`
verlangen `runtime_basis_revision` aus get und einen Idempotenzschlüssel;
die append-only Aktivierungsrevision ist zugleich der globale Standard
für das serverseitig konfigurierte Image. Neue Leserläufe und Nachzugscans
pinnen ihn in PG. Retry/Resume übernimmt keine neue Runtime. Fehlender
oder inkompatibler Pin endet sichtbar; der Folgejob bleibt bearbeitbar.
Der Executor prüft Registry, Imagebezug und den gesamten Baum vor dem
RO-Mount. `SYNAPSE_REVERSE_LESER_RUNTIME_SHA256` hat keine Autorität mehr.

Ein API-/Core-Deploy genügt, solange das bestehende Image Python3 und den
Entrypoint `python3 -u /opt/reverse/runner.py` bereitstellt. Native
Abhängigkeiten und Image-Digest bleiben Infrastruktur; die Datei-Bytes
kommen aus dem hashgebundenen Nachher-Stand der Änderungsanker, nicht aus einer Image-Extraktion.
Der Snapshot gilt nur für den Lesercontainer; E/S3 behalten ihren Altweg.
Die echte Sandbox-/Mount-Abnahme erfolgt gesondert in V6.

Leserpakete liegen separat unter `<reverseRoot>/.intern/leser/<revision>/…`.
Der registrierte `storage_key` bezeichnet einen Ordner mit exakt den in
`manifest.dateien` genannten Quelldateien. Die Hashes müssen den unveränderlichen
Quellbelegen der Registry entsprechen. Materialisierung/Freigabe erfolgen erst
in Teil D. RO-Pakete und Eingabedateien müssen für UID 65532 lesbar sein;
der Adapter verändert keine Originalrechte.

### Protokoll und Publikation

`leser_ausfuehren` startet nur den gepinnten Python-Einstiegspunkt. Er erhält
eine Vertragszeile auf stdin und schreibt UTF-8-JSONL auf stdout. stdout bleibt
in `.leser-protokoll.jsonl` auf dem Share; stderr wird begrenzt verworfen.
`schritt.segment` verweist auf JSONL mit ausschließlich Objekt-Records.
Member-ID, Objektpfad und Artefaktpfad sind innerhalb eines Schritts eindeutig.
Ausgabe- und Segmentdateien müssen vollständig deklariert sein.

Nach dem Prozessende stoppt der Host den gesamten Jobcontainer über P20,
einschließlich entkoppelter Kindprozesse. Erst nach bestätigtem Containerende
prüft er JSONL, Pfade, Links, Quellbereiche, Typen, Länge/Hash jeder Datei,
Zähler und genau einen letzten Endmarker. Exit 0 allein genügt nicht.
Ein leeres Ergebnis wird derzeit als fehlender Datenbeleg abgelehnt.
Bei `teilweise` sind Grund, offene Menge und Cursor verpflichtend.
Protokoll-/Artefaktbytes bleiben auf dem Share; PG bekommt nur Status,
Manifestverweis, Hash, Cursor und exakte Zähler unter dem P20-Lease-Fence.
Alte Generationen werden nicht gelöscht. Member-Resume und die gesicherte
Übergabe eines früheren Checkpoints gehören zu Teil C; ein gesetzter
`cursor_key` wird bis dahin ausdrücklich abgelehnt.

Abnahme muss Transport-/DB-Proben von echten Unraid-Sandboxproben unterscheiden.
Erforderlich: Netzversuch, Fremdschreiben, Endlosschleife, Riesenausgabe,
Symlink, fehlendes/kaputtes Ende, falsche Hashes sowie zwei isolierte Jobs.


### P18-T103: geordneter SIGTERM (Abnahme separat)

Der echte Runner installiert als PID1 einen SIGTERM-Latch mit Wakeup-Pipe. Im Import
entstehen keine Signalhandler/FDs. Idle nimmt nach TERM keinen Auftrag mehr an und endet
143; normale EOF bleibt0. Der Handler führt selbst weder I/O noch Journal-/Lockarbeit aus.
Aktive Werkzeuge erhalten TERM, bei Bedarf KILL mit reap innerhalb der gepinnten
prozess_wait_ms; Polling nutzt guard_intervall_ms. Der äußere Stop-/Lease-Fence bleibt
im unveränderten P20/T105-Weg. Neue Env-Zeitbudgets werden nicht eingeführt.

Checkpoint-E stoppt vor der nächsten Arbeitseinheit. Nur vollständig bestätigte Member
erscheinen im gehashten Manifest; Datei-fsync, bereit-Commit, rename/Ordner-fsync und
fertig-Commit bleiben in dieser Reihenfolge. Unbestätigte Zwischenfiles bleiben erhalten.
Ein konsistenter Signalcheckpoint meldet teilweise/signal_sigterm, nie eine erfolgreiche
leere Tabelle. Der Executor hält nach bestätigtem Teilimport; kein Auto-Release. Resume
braucht unveränderte Herkunft/Runtime/Einstellungen und das bisherige importiert_sha-ACK.
Alte Runtime-Journale werden nach Deploy nicht auf einen neuen Pin umgedeutet.
E ohne Journal und S3 behalten Rohreste, ohne einen Resume-Cursor zu erfinden.

Ein Leserabbruch erzeugt KEINEN künstlichen JSONL-Endmarker. leser_runner_sigterm bezeichnet
das Signal des Parents; leser_exit und Diagnose signal/exit_code bleiben der tatsächlich
beobachtete Kindstatus VOR Cleanup. Cleanupfehler ersetzen keinen früheren Grund.
Vollständige gespeicherte Protokollzeilen werden gesichert, Fragmente nicht als gültige
Records gezählt. Hostvalidierung/physisches Ende/Fence bleiben zwingend; ein Abbruch
ersetzt keine aktuelle Generation. Leser-Resume mit cursor_key bleibt ausdrücklich offen.

Tests werden erst in der gebündelten Testphase gestartet:
docker/synapse-reverse/test_runner_signale.py, packages/rest-api/tests/reverse-signal-p18-t103.test.mjs
und reverse-signal-p18-t103-v6.test.mjs. Eigene Prozessfixtures beweisen keine PID1-Semantik.
Echte V6-Proben gegen den exakten Image-/Runtimepin erfolgen nur im gesondert autorisierten
Fenster. Zähe native Calls können kooperative Checks verzögern; Exit137 ist kein bestandener
SIGTERM-Test. Unsichere Bytes/fehlender Endbeleg bleiben als Restbefund sichtbar.

Kein eigener Image-Neubau: gemäß411f7b6c erst nach V6 Legacy separat abbauen, dann EIN
gemeinsames Image bauen und genau dieses mit Idle/E-vor-nach-fsync/Leser-Signalen abnehmen.
Im damaligen T103-Schritt blieben Dockerfile/Legacy-Hunks unverändert; der spätere P18-T97-Abbau ist oben dokumentiert. Alle sechs
P20-Schutzdateien müssen vor/nach jedem Commit bytegleich zur Basis3d3d377f sein.
Projektpfade, Schalter und Blockübernahme werden nicht verändert.


#### Reviewfix R1–R3 (6fe31bd2)

S3-Signalrückhalt wird vor dem terminalen Status unter Policy-/Lease-Fence in
reverse_auftraege.uebernahme gespeichert (retention + job-/quellgebundener Beleg).
Nur dieser explizite Rückhalt wird im normalen Aufräumtakt berücksichtigt; andere
terminale S3-Arbeit bleibt unverändert. Scheitert die Sicherung, kein terminaler
Statuswechsel und kein Cleanup. Ein verlorener Fence publiziert keinen Rückhalt.

Der Handler merkt zusätzlich die monotone Signalzeit (nur Clock/Skalare, kein I/O).
Ein einmaliger absoluter Ablauf wird aus diesem Zeitpunkt und dem gepinnten
prozess_wait_ms gebildet und an Leser und Sweep geteilt. TERM/KILL/Poll-Latenz
verbrauchen dieselbe Restzeit; ein weiterer Sweep erhält kein neues Zeitkonto.
Docker stopSeconds verwendet denselben PG-Wert auf volle Sekunden aufgerundet.
Native/fsync-Latenz bleibt durch diese kooperativen Grenzen nicht hart garantiert.

Spätes Parent-TERM nach Leserreturn verwendet denselben festen Parentcode mit
unverändertem Kindexit/Protokollverweis; ein bereits beobachteter Kindfehler gewinnt.
Vor Kindstart sind Kindfelder null. Ein Signal-Ende erfindet keinen Leser-Endmarker.
R1 prüft N2 gegen synapse_test mit echten Cleanup-Takten/Bytehashes/Leaseverlust;
R2/R3 prüft N1 mit Fake-Uhr und echter Runner-Publikationsgrenze.
