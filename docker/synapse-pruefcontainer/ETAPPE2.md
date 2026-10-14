# P16-T16 Etappe 2: Go und Python projektweit im bestehenden Prüfcontainer

Stand 14.10.2026. Vorbereitung sol-11 (thought 26799282), geprüft, korrigiert und an die API angeschlossen von claude-e2. Kein neuer Container (User-Entscheidung db49c8d6): dasselbe Image, derselbe Prüfserver, dieselbe Semaphore wie die TS-Build-Prüfung (E1). Bestehende Syntaxprüfer und das E1-Protokoll `build` bleiben unverändert.

## Ablauf

- API (core `services/build-pruefung.ts`): dieselbe Build-Stufe wie E1 – Schalter (Standard aus), Ergebnis-Cache je Inhalts-Schnappschuss, nur NEUE Diagnosen gegenüber der Basis, Warteschlange der commits, `teilweise` sperrt nie. Zusätzlich je Plan ein Go- und ein Python-Teil; mehrere Teile werden zu einem Stand zusammengefasst (`teile`, `laeuft` gewinnt).
- Projekte: Go = Ordner mit `go.mod` (tiefste Wurzel je geänderter Datei; Module, die ein betroffenes Modul per lokalem `replace` einbinden, transitiv mit). Python = Ordner mit `pyproject.toml`/`setup.py`/`setup.cfg`, sonst die Projektwurzel.
- Schnappschuss aus PG (`code_files`) plus Plan-Schatten; nichts von der Platte, nichts ins Projekt. Go: nur das Modul selbst (verschachtelte Module nur über lokales replace), `vendor/modules.txt` wird mitgeschickt. Python: alle `.py`/`.pyi` unter der Wurzel, `.python-version` (3.x) setzt den Sprachstand.
- Transport (rest-api `pruef-container.ts`): `{"gobuild": {...}}` bzw. `{"pyright": {...}}`; ein Image ohne E2 antwortet ohne diesen Schlüssel -> `nicht_verfuegbar` (sperrt nicht).
- Sprachen abwählbar: `code_check(build_einstellungen, modus:'setzen', sprachen:['go'] | 'keine', project?)`, sonst Env `BUILD_PRUEFUNG_SPRACHEN`, Standard go+python. `build_status` zeigt `basis_sprachen`, `pruefen:true` prüft die Basis aller Sprachen (Feld `sprachen`).

## Container-Protokoll (pruefer_projekt.py)

```json
{"id":11,"gobuild":{"dateien":[{"pfad":"m/go.mod","inhalt":"module example.invalid/m\n\ngo 1.26\n"},{"pfad":"m/a.go","inhalt":"package main\nfunc main() {}\n"}],"projekte":["m"],"zeitlimit_s":300,"heap_mb":512}}
```

```json
{"id":12,"pyright":{"dateien":[{"pfad":"p/a.py","inhalt":"from b import f\nx: int = f('text')\n"},{"pfad":"p/b.py","inhalt":"def f(x: int) -> int:\n    return x\n"}],"projekte":["p"],"python_version":"3.14","zeitlimit_s":300,"heap_mb":512}}
```

Antwort `{"id":11,"ok":true,"gobuild":{"status":"fertig|teilweise","projekte":[{"projekt":"m","schritt":"build|vet|pyright","status":"fertig|zeitlimit|speicher|ausgabe|abhaengigkeiten|cgo|fehler","rc":0,"ms":12}],"diagnosen":[{"datei":"m/a.go","zeile":2,"spalte":4,"code":"go|vet|<Pyright-Regel>","meldung":"...","schwere":"error|warning|information","projekt":"m"}],"werkzeug":"go 1.27.2 (linux/amd64)","dauer_ms":42}}`.

- Go: `go build -mod=readonly|vendor -p=1 -gcflags=-e -o /dev/null ./...`, danach `go vet` (typprüft auch `_test.go`). Typfehler (`go`, auch `vet: ...`) = error; vet-Analyzerbefunde (`vet`) = warning, sperren nicht. Eingerückte Folgezeilen (have/want) hängen an der Meldung.
- Pyright: feste Image-CLI, Kontrollkonfiguration außerhalb der Quellen, Ausführungswurzel = Projektordner, `src/` automatisch als extraPath, `useLibraryCodeForTypes=false`. Nicht aufgelöste Importe (`reportMissingImports`) lassen den Lauf `fertig` mit `abdeckung: unvollstaendig` – dort Unknown, also keine Folgefehler; die übrigen Diagnosen bleiben belastbar.
- `abhaengigkeiten` (Go-Module fehlen offline, `requires go >=`), `cgo` (cgo-Dateien ohne C-Compiler ungeprüft), `zeitlimit`, `speicher`, `ausgabe`, `fehler` -> Auftrag `teilweise`, sperrt nie.
- Budgets der API (zeitlimit_s bis 3600, heap_mb bis 16384) werden im Container auf die Betreibergrenzen geklemmt, nicht abgelehnt.

## Nur prüfen

Go nur das Image-Go (`GOTOOLCHAIN=local`, `GOENV/GOWORK=off`, `GOPROXY/GOSUMDB=off`, `GOVCS=*:off`, `CGO_ENABLED=0`, `GOFLAGS` leer); kein run/test/generate, kein eigener vettool, keine Projektbinärdateien. Lokale replace-Ziele müssen im Schnappschuss liegen. Pyright lädt keine Projektkonfiguration; die einzige Interpreterprobe läuft über `python-isoliert` (Image-Python mit `-I -S`, nur `-c/-V/--version`; führende Isolationsschalter wie Pyrights `-I` werden übersprungen). Kein Netz, read-only Root, noexec-tmpfs, PID/CPU/RAM-Grenzen wie bisher.

GOCACHE: geteilt unter `/tmp/pruef-gocache` (inhaltsadressiert, nur Compilerergebnisse, nichts davon wird gestartet), damit nicht jeder Lauf die Standardbibliothek neu übersetzt (gemessen: kalt ~8 s und ~40 MB für ein fmt-Programm, warm Sekundenbruchteile). Über `PRUEF_GO_CACHE_MAX_MB` (Standard 256) oder bei weniger als 64 MB freiem tmpfs wird er vor dem Lauf geleert.

## Korrekturen gegenüber der Vorbereitung (claude-e2)

1. `python-isoliert.sh` lehnte Pyrights Versionsprobe ab (Pyright 1.1.414 ruft `python -I -c ...`, gelesen in `pyright-internal.js`).
2. Budget außerhalb der Grenzen wurde abgelehnt (heap_mb > 2048, zeitlimit_s > 300) -> mit dem API-Standard (Heap = Speicher - 192) wäre jede Prüfung `teilweise` gewesen. Jetzt geklemmt.
3. Go: Folgezeilen (have/want) gingen verloren, vet-Analyzerbefunde waren nicht von Typfehlern zu unterscheiden, `no required module provides` / `import lookup disabled` fehlten in der Abhängigkeitserkennung, ohne `-gcflags=-e` brach der Compiler nach 10 Fehlern ab (Basisvergleich instabil), cgo-Dateien fielen still aus, vendor wurde ignoriert.
4. Pyright: Ausführungswurzel war die Schnappschusswurzel (Importe in Unterprojekten nicht auflösbar), `reportMissingModuleSource` (Stub vorhanden) galt als Lücke, jeder fehlende Import machte den Lauf `teilweise` (Python hätte praktisch nie geprüft).
5. Deduplizierung war O(n²) über bis zu 20 000 Diagnosen; jetzt Menge.
6. Go von 1.26.9 auf die neueste stabile 1.27.2 angehoben (neuere Toolchain prüft ältere go.mod-Stände mit, nicht umgekehrt); SHA256 aus den go.dev-Metadaten, amd64 per Download nachgeprüft. Pyright-SHA256 nachgeprüft.
7. Image-Probe `python3 /opt/pruef/pruefer_projekt.py` (Go- und Pyright-Signaturfehler über Datei-/Paketgrenze) im Dockerfile; vorher wurden nur `--version` geprüft.

## Größe und Speicher

- Go 1.27.2: amd64 70,6 MB, arm64 67,1 MB komprimiert; entpackt ca. 250–300 MB. Pyright 1.1.414: 4,2 MB komprimiert, 19,5 MB entpackt inkl. typeshed.
- Für Go-Projekte `tmpfs_mb` >= 384 einplanen (Schnappschuss + GOCACHE), Speicher wie bei E1 ~1536–2048 MB. Node-Heap und `GOMEMLIMIT` sind Prozessbudgets, die harte Grenze setzt die API.

## Offene Punkte (nicht Teil von E2)

1. Go-Module ohne Netz: kein Modulbestand im Image (`/opt/pruef/gomodcache` leer). Projekte mit externen Abhängigkeiten (z. B. Synapse-Tray) bleiben `teilweise`, solange kein vertrauenswürdiger, go.sum-gebundener Bestand über die API kommt oder das Projekt vendort.
2. go.work wird nicht ausgewertet (Module einzeln, lokale replace-Ziele werden mitgeschickt).
3. Python-Abhängigkeiten außerhalb typeshed: nur `.pyi`/Stubs aus dem Schnappschuss (`typings/`). Versionsgebundene Stubpakete müssten kontrolliert über die API kommen; kein pip/uv im Container.
4. Basisstand, Cache und Warteschlange leben wie in E1 nur im Speicher der API.
5. Image-Abnahme durch den Koordinator: Neubau (beide Architekturen), Image-Probe, Versionsproben, Go/Python-Mehrdateifehler, fehlende Abhängigkeiten, cgo/replace-Ausbruch, Pyright-Konfig-/sitecustomize-Fallen, Zeit/RAM/Ausgabe, unveränderte Syntax- und TS-Protokolle.

Quellen: [Go-Werkzeugreferenz](https://pkg.go.dev/cmd/go), [Go-Release-Metadaten](https://go.dev/dl/?mode=json), [Pyright-CLI](https://github.com/microsoft/pyright/blob/1.1.414/docs/command-line.md), [Pyright-Konfiguration](https://github.com/microsoft/pyright/blob/1.1.414/docs/configuration.md). [Werkzeuglizenzen und Prüfsummen](LIZENZEN.md).
