# Synapse: Umgebungen, Testsysteme, Workspace-Scopes und isolierte Arbeitsstaende

Stand: 2026-08-16

Diese Datei beschreibt die geplante Weiterentwicklung des bisherigen Synapse-Workspace-Konzepts zu einer allgemeinen Umgebungs- und Testsystem-Infrastruktur. Sie fasst die gemeinsam festgelegten Anforderungen zusammen und trennt ausdruecklich zwischen dem aktuellen, bereits vorhandenen Verhalten und der Zielarchitektur.

Die Datei ist bewusst detailliert, weil die Erweiterung tief in mehrere Kernbereiche von Synapse eingreift: Workspace-Orchestrierung, Shell-Routing, File-Tools, File-Plaene, Versionierung, Audit, Code-Intel, Parser, Qdrant/Embeddings, WebUI, Auth/Token, reale Testhardware, virtuelle Maschinen und spaetere Merge-Logik.

---

## 1. Grundidee

Synapse soll nicht nur lokale Rechner und kurzlebige Docker-Workspaces als Ausfuehrungsorte kennen, sondern mehrere Arten von Arbeits- und Testumgebungen zentral verwalten koennen.

Die drei Hauptklassen sind:

1. Reale Hardware
   - macOS-Rechner
   - Windows-Rechner
   - Linux-Rechner
   - Android-Telefone/Tablets
   - Raspberry Pi / andere Linux-Geraete
   - spaeter Hardware-Testbench, z. B. ESP32

2. Virtuelle Maschinen
   - freigegebene Windows-VMs
   - freigegebene Linux-VMs
   - andere per SSH oder vergleichbarem Transport erreichbare VMs

3. Synapse Workspaces
   - kurzlebiger Test-Workspace wie heute
   - persistenter Arbeits-Workspace mit Live-Sync von Synapse/PG in den Workspace
   - optional isolierter Entwicklungs-Workspace mit eigenem temporaerem Code-Stand

Wichtig: Diese drei Klassen duerfen in der UI unter einem gemeinsamen Bereich erscheinen, technisch muessen ihre Sicherheits- und Datenmodelle jedoch klar getrennt bleiben.

---

## 2. Unveraenderliche Grundregeln

### 2.1 PostgreSQL bleibt Source of Truth

Der echte Projektstand lebt weiterhin in PostgreSQL, insbesondere in `code_files` und den zugehoerigen Versions-/Audit-Tabellen.

Normaler Schreibweg:

```text
Agent
  -> Synapse files(...)
  -> PostgreSQL
  -> Parser / Indexierung
  -> PG -> Dateisystem/Workspace-Sync
```

Nicht erlaubt als Standard:

```text
Workspace-Datei direkt editieren
  -> automatisch zurueck nach PostgreSQL
```

Der normale Workspace bleibt ein Spiegel bzw. Ausfuehrungsort, niemals die primaere Wahrheit.

### 2.2 Einseitiger Sync bleibt Standard

Im normalen Workspace-Modus gilt:

```text
PostgreSQL / Synapse
        |
        v
Workspace
```

Kein automatischer Rueck-Sync aus dem Workspace in den echten Projektstand.

### 2.3 Git ist nicht die interne Wahrheit von Synapse

Git kann weiterhin verwendet werden fuer:

- Verteilung ueber das Internet
- externe Rechner
- Releases
- echte Repository-Historie

Der Agenten-Arbeitsflow bleibt aber Synapse-zentriert:

- `files`
- `code_intel`
- `shell`
- Audit
- File-Versionen
- Plans
- Thoughts

### 2.4 Scope ist ein Kernbestandteil, kein UI-Filter

Wenn isolierte Workspace-Staende eingefuehrt werden, muss der Scope durch die gesamte Daten- und Toolpipeline laufen. Es reicht nicht, nur `workspace` oder nur `code_intel` um einen Scope-Parameter zu erweitern.

---

## 3. Aktueller IST-Zustand in Synapse

Dieser Abschnitt beschreibt den Stand, der am 2026-08-16 im aktuellen `synapse`-Projekt per `code_intel` geprueft wurde.

### 3.1 Mehrere benannte Workspaces existieren bereits

Der Workspace-Orchestrator unterstuetzt bereits benannte Workspaces pro Projekt.

Wichtige vorhandene Eigenschaften:

- `project_workspaces`
- Workspace-Name (`name`, Default `main`)
- eigenes Container-Lifecycle
- eigenes persistentes HOME-Volume
- eigene CPU-/RAM-/PID-/tmpfs-Limits
- unterschiedliche Images
- Rollen/Templates
- `pin`
- Idle-Stop
- LRU-Eviction
- proxynet-DNS pro Workspace

Der per Projekt erlaubte Workspace-Cap wird heute ueber `SYNAPSE_WS_PER_PROJECT_CAP` gesteuert; aktueller Default im Orchestrator ist 6.

Hinweis: Mindestens eine Toolbeschreibung spricht noch von `Max 3 pro Projekt`. Das ist bereits Dokumentationsdrift und muss bei einer spaeteren Guide-Ueberarbeitung bereinigt werden.

### 3.2 Shell kann bereits automatisch auf Workspace ausweichen

Das `shell`-Tool kennt bereits:

```text
target = auto | local | workspace
```

Im Auto-Modus gilt heute vereinfacht:

```text
lokaler FileWatcher/Daemon aktiv
  -> local

lokaler FileWatcher/Daemon nicht aktiv
  -> workspace
```

Damit ist die Idee "Workspace als Arbeitsplattform nutzen, falls local nicht aktiv ist" bereits teilweise vorhanden.

### 3.3 PG -> Workspace Live-Sync existiert bereits

Der Workspace-Orchestrator lauscht bereits auf:

```text
LISTEN synapse_code_file_change
```

Bei Aenderung von `code_files` wird die betroffene Datei inkrementell in den Workspace materialisiert.

Die bestehende Implementierung dokumentiert explizit:

```text
PG = Source of Truth, Container = live-Mirror
```

### 3.4 Source-Dateien im Workspace sind absichtlich read-only

Die materialisierten Projektquellen werden aktuell u. a. als:

```text
uid=0
gid=0
mode=0444
```

in den Workspace geschrieben.

Damit kann der normale Workspace-User die Source-Dateien nicht direkt per Shell veraendern. Das erzwingt den korrekten Weg:

```text
files -> PG -> Auto-Sync -> Workspace
```

Diese Eigenschaft soll im normalen `mirror`-Modus erhalten bleiben.

### 3.5 File-Plan-Mechanik ist bereits stark ausgebaut

`file_batch_plans` und `file-batch.ts` besitzen bereits:

- Plan-Phase
- Preview
- erwartete Hashes
- erneute Hash-Pruefung vor Commit
- Stale-Erkennung
- Re-Apply auf Basis des verifizierten Standes
- Multi-File-Operationen
- Co-Edit-Unterstuetzung
- Konflikterkennung
- Agent-ID
- Reason
- Batch-ID
- File-Versionen

Diese Mechanik ist die Grundlage fuer spaetere Workspace-Overlays und Merge-Plans.

### 3.6 Aktuelle harte Annahme: nur ein echter Projekt-Code-Stand

`file_batch_plans` kennt heute im Kern:

```text
project
owner_agent_id
ops
expected_hashes
...
```

Es existiert kein echter Workspace-Code-Scope.

`planBatch()` laedt seine Baseline aktuell aus dem echten Projektstand.

`commitBatch()` prueft den erwarteten Hash ebenfalls gegen den echten Projektstand und schreibt danach wieder in den echten Projektstand.

### 3.7 Aktuelle harte Annahme: alle Workspaces eines Projekts teilen dieselben Sources

Der aktuelle Workspace-Orchestrator verwendet fuer `/workspace` ein projektweites Volume.

Das bedeutet:

```text
Projekt synapse
  /workspace Volume
      |-- main
      |-- db-1
      |-- qa
      |-- app
```

Alle sehen denselben Source-Stand.

Nur das HOME ist workspace-spezifisch.

Das ist ideal fuer mehrere Test-/Service-Container mit demselben Quellstand, verhindert aber isolierte Entwicklungsstaende pro Workspace.

### 3.8 File-Audit besitzt aktuell keinen Scope

`file_versions` enthaelt aktuell u. a.:

- project
- file_path
- content
- content_hash
- edit_action
- agent_id
- batch_id
- size_bytes
- reason
- feature_tag
- parent_version_id
- git_commit_sha
- agent_note

Es fehlen fuer die geplante Erweiterung mindestens:

- scope_type
- scope_id / workspace_id
- optional merge_id

Aktuell bedeutet ein `file_versions`-Eintrag deshalb automatisch: Aenderung des echten Projektstandes.

---

## 4. Neue Oberstruktur des bisherigen Workspace-Konzepts

Der Begriff `workspace` soll im Guide und in der WebUI nicht mehr als Synonym fuer "Docker-Testcontainer" verstanden werden.

Zielmodell:

```text
Synapse Umgebungen
|
|-- Reale Hardware
|     |-- macOS
|     |-- Windows
|     |-- Linux
|     |-- Android
|     `-- spaeter Embedded-Testbench
|
|-- Virtuelle Maschinen
|     |-- Windows VM
|     |-- Linux VM
|     `-- weitere freigegebene SSH-VMs
|
`-- Synapse Workspaces
      |-- mirror/test
      |-- persistent work platform
      `-- isolated workspace
```

Langfristig kann ein uebergeordnetes Tool-/Guide-Konzept sinnvoll sein, z. B. `environment` oder `target`. Das bestehende `workspace`-Tool kann trotzdem fuer Docker-Workspace-Lifecycle erhalten bleiben, um bestehende Clients nicht zu brechen.

---

## 5. Reale Hardware als Testsystem

### 5.1 Zweck

Docker, Sandboxen und VMs fangen viele Fehler ab, aber nicht alle Fehler, die erst auf echter Hardware bzw. echten Betriebssystemen auftreten.

Beispiele:

- reale GPU-/Display-Treiber
- Cocoa unter macOS
- Android App-Lifecycle
- reale Berechtigungen
- echtes Bluetooth/WLAN
- Energieverwaltung
- Hardware-Sensorik
- echte Bildschirm-/DPI-/Scaling-Eigenheiten
- reales Audio/Video
- USB-/ADB-Verhalten
- spaeter ESP32-/Embedded-Verhalten

Deshalb soll Synapse echte Endsystemtests als eigene Teststufe verwalten.

### 5.2 Testsysteme bekommen eigene Tokens

Testsysteme sollen nicht den normalen Agenten-/Session-Token verwenden.

Geplant ist ein eigener Testsystem-Token bzw. eigener Scope, z. B. logisch:

```text
testsystem:<id>
```

Der Token darf nur eng begrenzte Aktionen ausfuehren, z. B.:

- Heartbeat senden
- eigenen Status setzen
- eigene Sperre setzen/entfernen
- Besitzer-Nachricht setzen
- Capabilities melden
- ggf. Artefakte registrieren

Er darf nicht pauschal Projektcode oder normale Synapse-Ressourcen bearbeiten.

### 5.3 Statusmodell

Mindestens folgende Zustaende sind sinnvoll:

```text
available
light_only
blocked
offline
```

Bedeutung:

- `available`: normale freigegebene Tests erlaubt
- `light_only`: nur leichte Tests erlaubt, keine schweren Builds/GPU/Video/Lasttests
- `blocked`: Besitzer hat Tests aktiv gesperrt
- `offline`: Testsystem-App/Agent/Heartbeat nicht erreichbar oder erforderliche Debug-Verbindung nicht aktiv

### 5.4 Besitzer-Nachricht

Der Besitzer eines Testsystems soll optional einen freien Hinweis hinterlegen koennen, z. B.:

```text
"Ich moechte gerade zocken. Bitte bis 20 Uhr keine Tests."
```

Synapse muss diese Nachricht an Agenten weiterreichen, wenn sie einen Test auf dem gesperrten System anfordern.

### 5.5 Sperre muss serverseitig greifen

Die Sperre darf nicht nur lokal in einer Tray-/Mobile-App angezeigt werden.

Vor jedem Remote-Test muss Synapse selbst pruefen:

```text
Testsystem bekannt?
Token gueltig?
Heartbeat frisch?
Status erlaubt?
Capability vorhanden?
```

Bei `blocked` darf gar kein SSH-/ADB-Testversuch erzeugt werden.

### 5.6 Vorgefertigte Agentenantwort

Wenn ein System gesperrt ist, soll Synapse eine strukturierte Antwort liefern, z. B.:

```text
REMOTE_TEST_SYSTEM_BLOCKED
system: macbook-freund
reason: gaming
message: "Bin bis 20 Uhr am Zocken."
action:
  - keine weiteren Verbindungsversuche
  - Task als wartend markieren
  - lokal/Workspace weiterarbeiten, falls moeglich
```

Damit wird verhindert, dass mehrere Agenten dieselbe gesperrte Hardware immer wieder anfragen.

---

## 6. macOS Testsystem

### 6.1 Grundidee

Ein fremder Mac kann als echter macOS-Testknoten dienen, ohne dass der Entwickler physisch davor sitzt.

Moeglicher Ablauf:

```text
Synapse Agent
  -> Projekt ueber Synapse aendern
  -> aktuellen Stand auf Mac bringen
  -> ueber SSH Build/Test starten
  -> Screenshot/JSON/Video/Logs erzeugen
  -> Artefakte zurueckholen
  -> Agent analysiert
  -> naechster Fix ueber Synapse
```

Git kann fuer den Transport verwendet werden, ist aber nicht zwingend. Alternativ sind SSH/SCP/rsync-basierte Transfers denkbar.

### 6.2 Lokale Status-App / Tray / Menueleiste

Auf dem Mac kann spaeter eine kleine App laufen, idealerweise selbst in Moo geschrieben.

Anzeige z. B.:

```text
Moo Testsystem
- bereit
- Tests laufen
- Tests pausiert
- Test abgeschlossen
- Test fehlgeschlagen
```

Aktionen fuer den Besitzer:

- Tests erlauben
- nur leichte Tests erlauben
- Tests komplett sperren
- Nachricht eingeben

Damit sieht der Besitzer jederzeit, wann Synapse den Rechner verwendet.

---

## 7. Android als reales Testsystem

### 7.1 USB ist nicht dauerhaft erforderlich

Android kann spaeter drahtlos als Testsystem verwendet werden, wenn Wireless Debugging/ADB entsprechend eingerichtet ist.

Die Synapse-Testsystem-App soll erkennen, ob das Geraet fuer Synapse wirklich testbar ist.

Wenn erforderliche Voraussetzungen nicht gegeben sind, gilt das Geraet fuer Synapse als `offline` oder nicht testbereit.

### 7.2 Die App selbst darf den Status steuern

Die Android-App ist das Gegenstueck zum macOS-Tray.

Sie meldet u. a.:

- System-ID
- Android-Version
- Architektur
- Akku
- Netzwerkzustand
- Testfreigabe
- optionale Nachricht
- ADB/Debug-Erreichbarkeit soweit erkennbar

### 7.3 Debugging nicht vortaeuschen

Eine normale App soll nicht behaupten, systemseitiges Debugging eigenmaechtig aktivieren zu koennen, wenn Android dies nicht erlaubt.

Stattdessen:

```text
Wireless Debugging aktiv: ja/nein
ADB erreichbar: ja/nein
Synapse-Freigabe: ja/nein
```

Wenn die Debugging-Voraussetzungen fehlen, ist das Geraet nicht fuer Agententests freigegeben.

---

## 8. Virtuelle Maschinen

VMs sollen als eigene Umgebungsart verwaltet werden.

Grundmodell:

```text
VM
- id
- name
- platform
- arch
- transport (z. B. ssh)
- host/address
- capabilities
- status
- optional owner/message
```

Beispiele:

- Windows Test-VM
- Linux Test-VM

Auch bei VMs soll Synapse wissen, ob das System testbereit ist, statt blind Verbindungsversuche auszufuehren.

---

## 9. Workspace-Modi

Es sollen mindestens drei logische Betriebsarten unterscheidbar sein.

### 9.1 `mirror` / Testmodus

Das entspricht weitgehend dem heutigen Verhalten.

Eigenschaften:

- PG ist Wahrheit
- automatischer PG -> Workspace-Sync
- Source read-only
- kein eigener Code-Stand
- kein Rueckschreiben
- Workspace kann kurz gestartet und nach Tests wieder gestoppt werden
- gut fuer Build-/Integration-/Sandboxtests

### 9.2 Persistente Arbeitsplattform

Der Workspace kann bewusst als dauerhafter Arbeitsrechner eines Projekts festgelegt werden.

Anwendungsfall:

- lokaler Rechner ist aus
- Agenten sollen trotzdem bauen/testen/Services starten koennen
- Synapse API laeuft zentral

Eigenschaften:

- PG -> Workspace Live-Sync aktiv
- Shell kann gezielt oder automatisch dort laufen
- Source weiter ueber Synapse `files`
- Workspace kann `pinned` oder anderweitig persistent gehalten werden
- kein eigener Code-Overlay notwendig

Dieser Modus benoetigt deutlich weniger neue Technik als der isolierte Workspace, weil ein grosser Teil bereits vorhanden ist.

### 9.3 `isolated` Workspace

Dieser Modus ist optional und soll eher selten verwendet werden.

Zweck:

- groessere experimentelle Aenderung
- Alternativimplementierung
- Agent soll einen isolierten Projektzweig ausprobieren
- kein direkter Einfluss auf echten Projektstand

Eigenschaften:

- eigener temporaerer Source-Stand
- eigener Scope
- eigene File-Plaene
- eigene Versionen/Audit
- eigener Parser-/Code-Intel-Stand
- keine dauerhaften Qdrant-Embeddings
- spaeter optional Merge in den echten Projektstand

---

## 10. Scope-Modell

### 10.1 Default muss voll rueckwaertskompatibel bleiben

Bestehende Tool-Aufrufe ohne Scope muessen weiterhin exakt den echten Projektstand meinen.

Logisch:

```text
scope_type = project
scope_id   = NULL
```

### 10.2 Workspace-Scope

Ein isolierter Workspace bekommt z. B.:

```text
scope_type = workspace
scope_id   = <workspace-id oder stabiler workspace-key>
```

Wichtig: Der sichtbare Name (`dev-a`) und eine interne stabile ID sollten nicht unnoetig vermischt werden. Ein spaeterer Rename des Workspaces darf den Audit-Trail nicht zerstoeren.

Empfehlung:

```text
workspace_id = UUID/stabile interne ID
workspace_name = lesbarer Name
```

### 10.3 Scope-Schluessel

Die logische Identitaet einer Datei wird zukuenftig:

```text
project + scope_type + scope_id + file_path
```

Nicht mehr nur:

```text
project + file_path
```

---

## 11. File-Tools muessen scope-aware werden

Der Scope muss in alle relevanten `files`-Operationen einfließen.

Mindestens:

- create
- update
- delete
- move
- copy
- read
- replace_lines
- insert_after
- delete_lines
- search_replace
- search_replace_batch
- versions
- get_version
- restore
- restore_batch
- plan
- commit
- cancel
- plan_status
- history
- Reservierungen / Co-Edit-Funktionen

### 11.1 Default

Ohne Scope-Parameter:

```text
project scope
```

Damit bleiben alte Agenten und Clients kompatibel.

### 11.2 Workspace-Read ist ein effektiver Read

Ein isolierter Workspace darf nicht einfach nur seine Overlay-Tabelle lesen.

Er muss den effektiven Dateistand aufloesen:

```text
Workspace-Overlay vorhanden?
  |
  |-- modified -> Workspace-Inhalt
  |-- created  -> Workspace-Inhalt
  |-- deleted  -> Datei gilt in diesem Workspace als nicht vorhanden
  `-- nein     -> Projekt-Datei verwenden
```

---

## 12. Zentrale effektive Datei-Aufloesung

Es sollte eine zentrale, gemeinsam verwendete Funktion bzw. Service-Schicht geben, sinngemaess:

```text
resolveEffectiveFile(project, scope, file_path)
```

Diese eine Definition muss von allen betroffenen Systemen genutzt werden:

- files(read)
- files(plan)
- expected_hash baseline
- code_intel(file)
- Parser
- Merge
- Move/Copy/Delete
- ggf. File-History-Aufloesung

Ziel: Kein unterschiedliches Verhalten zwischen `files` und `code_intel`.

---

## 13. Overlay statt Vollkopie

Ein isolierter Workspace soll nicht alle Projektdateien in PostgreSQL duplizieren.

Stattdessen werden nur Abweichungen gespeichert.

Moegliches Modell:

```text
workspace_code_files
- workspace_id
- project
- file_path
- change_type: created | modified | deleted
- content
- content_hash
- base_hash
- base_version_id optional
- parser_version
- parsed_at
- created_at
- updated_at
```

Beispiel:

Projekt hat 2.000 Dateien.

`dev-a` aendert 7 Dateien.

Dann enthaelt das Workspace-Overlay nur diese 7 Abweichungen, nicht 2.000 Kopien.

---

## 14. Neue Datei, geaenderte Datei, geloeschte Datei

Code-Intel und File-Tools muessen sauber unterscheiden:

### Projektdatei unveraendert im Workspace

```text
kein Overlay
-> Projektversion gilt
```

### Datei im Workspace geaendert

```text
change_type=modified
-> Workspaceversion ueberschreibt Projektversion fuer diesen Scope
```

### Datei im Workspace neu erstellt

```text
change_type=created
-> nur im Workspace sichtbar
```

### Datei im Workspace geloescht

```text
change_type=deleted
-> fuer diesen Workspace unsichtbar
-> im echten Projekt weiterhin vorhanden
```

### Unterschiedliche Workspaces

`dev-a` und `dev-b` duerfen dieselbe `file_path` komplett unterschiedlich enthalten, ohne sich gegenseitig im Index/Audit zu vermischen.

---

## 15. File-Plaene im Workspace

### 15.1 Bestehende Mechanik wiederverwenden

Der heutige File-Plan besitzt bereits viele benoetigte Eigenschaften:

- Baseline Hash
- Preview
- Stale Check
- Re-Apply
- Multi-File
- Co-Edit
- Agent Audit

Diese Logik soll scope-aware gemacht werden, nicht neu erfunden werden.

### 15.2 File-Plan bekommt Scope

Logisch mindestens:

```text
file_batch_plans
- project
- scope_type
- scope_id
- ... bestehende Felder
```

Ein Workspace-Plan prueft seine Hashes gegen den effektiven Workspace-Stand, nicht gegen den reinen Projektstand.

### 15.3 Project-Plan und Workspace-Plan sind getrennt

Ein offener Plan auf:

```text
project/synapse/src/x.ts
```

darf nicht automatisch einen Plan auf:

```text
workspace/dev-a/synapse/src/x.ts
```

blockieren.

---

## 16. Reservierungen und Co-Editing

Heute ist die Identitaet stark an `project + file_path` gekoppelt.

Zukuenftig muss die Reservierung scope-aware sein:

```text
project + scope_type + scope_id + file_path
```

Beispiel:

```text
PROJECT      src/foo.ts -> Agent A
WORKSPACE A  src/foo.ts -> Agent B
WORKSPACE B  src/foo.ts -> Agent C
```

Diese drei Reservierungen duerfen parallel existieren.

Innerhalb desselben Scopes bleibt die bestehende Co-Edit-/Reservierungslogik bestehen.

---

## 17. Audit und File-Versionen

### 17.1 Scope muss im Audit sichtbar sein

Workspace-Aenderungen duerfen niemals wie echte Projekt-Aenderungen aussehen.

Mindestens benoetigt:

```text
scope_type
scope_id
```

Optional fuer lesbare Darstellung kann `workspace_name` beim Lesen aufgeloest werden, sollte aber nicht die stabile Identitaet ersetzen.

### 17.2 Merge-Audit

Ein Merge benoetigt einen eigenen Audit-Zusammenhang, z. B.:

```text
merge_id
source_scope
source_scope_id
target_scope=project
base_ref
files_seen
auto_merged
conflicts
requested_by
approved_by
created_at
committed_at
```

### 17.3 Beispiel im Audit

```text
PROJECT
Agent A aenderte src/test.ts direkt im echten Projektstand.

WORKSPACE dev-a
Agent B aenderte src/test.ts nur im isolierten Workspace.

WORKSPACE dev-b
Agent C aenderte dieselbe Datei anders.

MERGE dev-a -> PROJECT
6 Dateien automatisch zusammengefuehrt, 1 Konflikt manuell geloest.
```

---

## 18. Code-Intel muss scope-aware werden

Der Scope darf nicht nur ein Filter auf `code_files` sein. Auch alle abgeleiteten Parserdaten muessen sauber zum Workspace gehoeren.

Betroffen sind logisch u. a.:

- Dateien
- Funktionen
- Variablen
- Symbole
- Referenzen
- Statements
- Call-Kanten
- Flow
- Entrypoints
- lexikalischer Suchindex in PostgreSQL

### 18.1 Standard-Code-Intel

Ohne Workspace-Angabe:

```text
code_intel(project="synapse", ...)
-> echter Projektstand
```

### 18.2 Workspace-Code-Intel

Zukuenftig z. B. sinngemaess:

```text
code_intel(project="synapse", workspace="dev-a", ...)
```

oder ein expliziter Scope-Parameter.

Die genaue API-Benennung ist spaeter festzulegen. Wichtig ist die Semantik.

### 18.3 Effektiver Workspace-Baum

Code-Intel fuer einen Workspace muss logisch sehen:

```text
Projektdateien
- alle Pfade, die im Workspace geloescht wurden
- Projektversionen der Pfade, die im Workspace ueberschrieben wurden
+ Workspace modified/created overlays
```

Das Ergebnis darf nicht Projekt- und Workspace-Symbole derselben Datei gleichzeitig enthalten.

---

## 19. Parser im Workspace: JA

Isolierte Workspace-Dateien muessen geparst werden, damit folgende Funktionen korrekt sind:

- tree
- functions
- variables
- symbols
- references
- calls
- flow
- statements
- entrypoints
- lexikalische Suche

Der Parser ist fuer den Workspace-Code-Stand notwendig.

---

## 20. Embeddings im isolierten Workspace: NEIN

Dies ist eine wichtige feste Designentscheidung.

Workspace-Overlays sollen keine normalen Projekt-Embeddings erzeugen.

Gruende:

1. Unnoetige doppelte Embedding-Kosten.
2. Unnoetige doppelte Qdrant-Punkte.
3. Experimenteller Code wuerde die semantische Suche des echten Projekts verunreinigen.
4. Ein Workspace kann spaeter verworfen werden.
5. Mehrere Workspaces koennen widerspruechliche Versionen derselben Datei enthalten.

Deshalb:

```text
PROJECT
-> Parser
-> PG Code-Intel
-> Embedding
-> Qdrant

ISOLATED WORKSPACE
-> Parser
-> PG Workspace-Code-Intel
-> KEIN Projekt-Embedding
-> KEIN normaler Qdrant-Punkt
```

### 20.1 Semantische Suche im Workspace

Initial darf semantische Suche im Workspace eingeschraenkt sein.

Moegliche erste Semantik:

- Projekt-Qdrant bleibt fuer den Basisstand verwendbar
- Workspace-Aenderungen sind nur ueber exakte/lexikalische/Symbol-/Reference-Suche aktuell

Das ist akzeptabel, weil Code-Intel ohnehin discovery-first und nicht primar embedding-first verwendet wird.

### 20.2 Spaetere Option

Falls spaeter notwendig, koennte ein temporaerer Workspace-Vektorindex getrennt vom Projektindex aufgebaut werden. Das ist aktuell ausdruecklich kein Muss und sollte nicht Teil der ersten Implementierung sein.

---

## 21. Parser-/Indexdaten muessen den Workspace eindeutig kennen

Ein Scope nur an `code_files` reicht nicht.

Wenn Workspace-Code geparst wird, muessen die abgeleiteten Datensaetze eindeutig angeben, aus welchem Workspace-Stand sie stammen.

Sonst entsteht z. B. folgende unzulaessige Situation:

```text
PROJECT src/x.ts -> Funktion foo Version A
WORKSPACE dev-a src/x.ts -> Funktion foo Version B
```

und `references(foo)` liefert beide ohne Unterscheidung.

Das darf nicht passieren.

Alle Code-Intel-Abfragen muessen immer genau einen effektiven Scope liefern.

---

## 22. Workspace-Volume-Trennung fuer isolierte Staende

Der heutige projektweite `/workspace`-Volume verhindert isolierte Code-Staende.

Fuer `isolated` Workspaces muss der Source-Stand getrennt materialisiert werden.

Moegliche Richtung:

```text
mirror/test workspace
-> projektweites Source-Volume weiterhin erlaubt

isolated workspace
-> eigenes Source-Volume pro Workspace
```

oder eine andere technisch gleichwertige Overlay-Loesung.

Wichtig ist nur:

- `dev-a` darf seine eigene effektive Source sehen
- `dev-b` darf einen anderen effektiven Stand sehen
- normale mirror-Workspaces duerfen weiterhin denselben Projektstand teilen

---

## 23. Schreibverhalten im isolierten Workspace

Auch im isolierten Modus sollen Agenten Source-Code nicht unkontrolliert mit beliebigen Shell-Kommandos veraendern.

Bevorzugtes Modell:

```text
Agent
-> files(..., scope=workspace/dev-a)
-> Workspace-Overlay in PG
-> Parser fuer Workspace-Overlay
-> Materialize effective file nach dev-a
```

Damit bleiben erhalten:

- Audit
- Plan
- Drift-Schutz
- Versionen
- Agent-ID
- Co-Edit
- Code-Intel

Ein isolierter Workspace ist also kein Freifahrtschein fuer `sed -i`/Editor-Schreibzugriffe ausserhalb der Synapse-Pipeline.

---

## 24. Merge eines isolierten Workspaces

### 24.1 Merge ist selten und bewusst

Der normale Workspace schreibt nie zurueck.

Nur ein ausdruecklicher Merge-Vorgang darf einen isolierten Workspace in Richtung Projektstand ueberfuehren.

### 24.2 Drei-Wege-Merge

Grundlage:

```text
BASE
Projektstand, auf dem der Workspace basiert

OURS
aktueller echter Projektstand

THEIRS
aktueller Workspace-Stand
```

Damit kann Synapse unterscheiden:

- nur Workspace geaendert
- nur Projekt geaendert
- beide geaendert, aber unterschiedliche Regionen
- echter Konflikt auf derselben Stelle

### 24.3 Kein direkter Write in `code_files`

Wichtige Regel:

```text
workspace merge
  -> Merge berechnen
  -> normalen PROJECT File-Plan erzeugen
  -> normale Hash-/Conflict-/Preview-Pipeline
  -> Project commit
```

Nicht:

```text
workspace content
  -> code_files direkt ueberschreiben
```

Damit wird die bestehende sichere File-Pipeline nicht umgangen.

### 24.4 Konflikte

Bei nicht eindeutig automatisch mergebaren Konflikten:

- kein automatischer Commit
- Konflikt im Merge-Preview sichtbar
- Agent/User muss entscheiden
- danach neuer/angepasster Project-Plan

---

## 25. Base-Referenz eines isolierten Workspaces

Ein isolierter Workspace muss wissen, von welchem Projektstand er gestartet ist.

Mindestens pro geaenderter Datei:

- base_hash
- optional base_version_id

Zusaetzlich kann ein Workspace einen allgemeinen Erzeugungszeitpunkt / Basis-Marker besitzen.

Die konkrete Implementierung darf nicht davon ausgehen, dass ein einzelner Git-Commit die Wahrheit beschreibt, weil Synapse-Aenderungen zwischen Git-Commits existieren koennen.

Die Merge-Basis muss deshalb aus Synapse/PostgreSQL ableitbar sein.

---

## 26. Workspace-Limits und dynamisches RAM-Budget

Ein starres Limit wie "maximal 3 isolierte Entwicklungsworkspaces pro Projekt" soll nicht die primaere technische Grenze sein. Die tatsaechlich erlaubte Anzahl soll sich dynamisch aus den Ressourcen des Systems ergeben, auf dem die Synapse-Workspaces laufen.

Die Zahl 3 kann weiterhin als Beispiel oder optionales zusaetzliches Sicherheitsmaximum dienen, darf aber nicht die einzige Kapazitaetslogik sein.

### 26.1 Grundprinzip

Synapse soll vor dem Start eines neuen Workspace pruefen:

1. Wie viel Arbeitsspeicher besitzt der Host insgesamt?
2. Wie viel Arbeitsspeicher ist aktuell noch realistisch verfuegbar?
3. Wie viel RAM muss fuer Host, Synapse-API, PostgreSQL, Docker, Dateisystem-Cache und andere Dienste reserviert bleiben?
4. Welche `mem_limit_mb` sind durch bereits aktive oder reservierte Workspaces zugesagt?
5. Wie hoch ist `mem_limit_mb` des neu angeforderten Workspace?
6. Gibt es ein zusaetzliches konfiguriertes absolutes Maximum fuer diesen Workspace-Typ?

Erst wenn das Workspace-Budget ausreicht, darf der neue Workspace gestartet werden.

### 26.2 Linux: `MemAvailable` statt nur `MemFree`

Auf Linux darf die Entscheidung nicht allein auf `MemFree` basieren. Linux verwendet freien RAM aggressiv als Cache. Fuer die Frage, wie viel Speicher ohne starken Speicherdruck noch verwendet werden kann, ist `MemAvailable` die sinnvollere Host-Metrik.

Beispiel:

```text
Host RAM gesamt:             32 GB
MemAvailable:                18 GB
Host-/Synapse-Reserve:        6 GB
---------------------------------
aktuell nutzbares Budget:    12 GB
```

Die konkrete Implementierung soll die Plattform abstrahieren, damit spaeter auch andere Hostsysteme geeignete Speicherinformationen liefern koennen.

### 26.3 Reserviertes Limit ist fuer Admission wichtiger als Momentanverbrauch

Fuer die Entscheidung, ob ein weiterer Workspace gestartet werden darf, soll Synapse primaer mit den zugesagten `mem_limit_mb` rechnen und nicht nur mit dem aktuellen RAM-Verbrauch der Container.

Grund: Ein Workspace mit einem Limit von 4096 MB kann im Leerlauf nur 500 MB verwenden und spaeter unter Build-/Testlast trotzdem mehrere GB benoetigen. Wuerde Synapse nur den Momentanverbrauch betrachten, koennten zu viele Workspaces zugelassen werden und spaeter gleichzeitig Speicherdruck erzeugen.

Beispiel:

```text
Workspace-Budget:             9 GB

dev-a mem_limit_mb:           2 GB
dev-b mem_limit_mb:           4 GB
---------------------------------
reserviert:                   6 GB
noch reservierbar:            3 GB
```

Ein neuer Workspace mit `mem_limit_mb=4096` wird abgelehnt. Ein Workspace mit `mem_limit_mb=2048` kann zugelassen werden.

### 26.4 Aktueller Verbrauch bleibt wichtig fuer Monitoring

Neben dem reservierten Limit soll Synapse den echten aktuellen Verbrauch messen und in API/WebUI anzeigen.

Damit existieren zwei unterschiedliche Werte:

```text
Admission / Sicherheitsentscheidung:
  reservierte mem_limit_mb

Monitoring / Diagnose:
  tatsaechlicher aktueller RAM-Verbrauch
```

Beide duerfen nicht miteinander verwechselt werden.

### 26.5 Host-Reserve

Synapse muss einen konfigurierbaren Mindestpuffer fuer das Hostsystem beruecksichtigen.

Moegliche Konfiguration, Namen noch nicht verbindlich:

```text
SYNAPSE_HOST_RAM_RESERVE_MB=6144
```

Der Reservewert darf auch dann nicht fuer neue Workspaces verplant werden, wenn Linux ihn momentan als verfuegbar meldet.

Ziel ist, dass Synapse niemals das Betriebssystem, PostgreSQL oder die eigene API bis an die RAM-Grenze draengt.

### 26.6 Optionales absolutes Maximum

Zusaetzlich zur dynamischen RAM-Pruefung kann ein administratives Hard-Limit sinnvoll bleiben.

Beispiel, Name noch nicht verbindlich:

```text
SYNAPSE_ISOLATED_WS_MAX=6
```

Die erlaubte Anzahl ergibt sich dann aus der strengeren Grenze:

```text
RAM-basiert moeglich:    4
Hard-Limit:              6
=> erlaubt:              4

RAM-basiert moeglich:   10
Hard-Limit:              6
=> erlaubt:              6
```

Damit skaliert ein grosser Server automatisch besser, waehrend ein kleines System geschuetzt bleibt.

### 26.7 Workspace-Typen getrennt budgetieren koennen

Die bestehende allgemeine Workspace-Cap-Logik kann als zusaetzliche Schutzschicht bestehen bleiben. Langfristig sollte aber zwischen Workspace-Arten unterschieden werden koennen:

- `mirror/test/service`: bestehende Test-/Service-Workspaces
- `isolated`: isolierte Entwicklungsworkspaces mit eigenem Source-/Scope-Stand

Isolierte Entwicklungsworkspaces sind teurer, weil sie zusaetzliche Source-Volumes/Overlays, Parserdaten, Code-Intel-Scope und Merge-/Audit-Zustand besitzen koennen. Daher darf Synapse fuer sie ein separates Budget oder Hard-Limit besitzen.

### 26.8 Start-Gate

Vor `workspace(start)` bzw. dem impliziten Start durch `shell(target="workspace")` soll fuer budgetierte Workspace-Typen ein Admission-Gate laufen.

Konzeptionell:

```text
Anfrage
  |
  v
Workspace-Konfiguration laden
  |
  v
Host-RAM / MemAvailable bestimmen
  |
  v
Host-Reserve abziehen
  |
  v
bereits zugesagte Workspace-Limits beruecksichtigen
  |
  v
angefordertes mem_limit_mb pruefen
  |
  +--> ausreichend --> Start erlaubt
  |
  +--> nicht ausreichend --> Start abgelehnt + klare Kapazitaetsdaten
```

Eine Ablehnung soll nicht nur `workspace_cap_reached` melden, sondern erklaeren koennen:

```text
angefordert:            4096 MB
noch reservierbar:      3072 MB
Host-Reserve:           6144 MB
```

Damit kann ein Agent selbst entscheiden, ob er einen kleineren Workspace anfordert oder einen nicht mehr benoetigten Workspace stoppt.

### 26.9 WebUI

Die WebUI soll spaeter mindestens anzeigen koennen:

```text
Host RAM:                32 GB
MemAvailable:          17.4 GB
Host-Reserve:             6 GB
Workspace-Budget:       11.4 GB

dev-a
  Limit:                  4 GB
  aktuell:              1.2 GB

dev-b
  Limit:                  2 GB
  aktuell:              860 MB

noch reservierbar:      5.4 GB
```

Damit ist sichtbar, warum ein weiterer Workspace erlaubt oder abgelehnt wurde.

### 26.10 Keine starre Drei-Workspace-Annahme in Scope-/Merge-Logik

Wichtig fuer die restliche Architektur: Scope-, Audit-, Parser-, File-Plan- und Merge-Code darf niemals fest von genau drei isolierten Workspaces ausgehen.

Die Anzahl ist eine Ressourcen-/Policy-Entscheidung des Orchestrators. Das Datenmodell muss beliebig viele Workspace-IDs korrekt auseinanderhalten koennen, auch wenn die aktuelle Konfiguration nur wenige gleichzeitig zulaesst.

Die urspruengliche Idee, isolierte Entwicklungsworkspaces bewusst selten zu verwenden, bleibt bestehen. Die technische Begrenzung wird jedoch ressourcenbasiert statt starr modelliert.

---

## 27. Shell-Routing in der Zielarchitektur

Langfristig soll ein Agent zwischen mehreren Ausfuehrungszielen waehlen koennen.

Beispiele:

```text
local
workspace:main
workspace:dev-a
vm:windows-test
hardware:macbook-freund
hardware:pixel5
```

Nicht jede Umgebung braucht dieselbe Shell-Semantik.

### 27.1 Workspace

Bestehende `shell(target="workspace")` Logik kann weiterverwendet/erweitert werden.

### 27.2 VM

Remote-Shell ueber freigegebenen Transport, z. B. SSH.

### 27.3 Reale Hardware

Vor Ausfuehrung immer Availability-/Capability-Gate des Testsystems pruefen.

### 27.4 Android

Nicht klassische Shell voraussetzen; ADB-/App-Testaktionen koennen eine spezialisierte Remote-Ausfuehrung benoetigen.

---

## 28. Testsystem-Capabilities

Ein Testsystem soll seine Faehigkeiten melden koennen.

Beispiel macOS:

```json
{
  "platform": "macos",
  "arch": "arm64",
  "capabilities": [
    "build",
    "shell",
    "ui",
    "screenshot",
    "video",
    "cocoa"
  ]
}
```

Beispiel Android:

```json
{
  "platform": "android",
  "arch": "arm64",
  "capabilities": [
    "adb",
    "install_apk",
    "launch_app",
    "logcat",
    "screenshot",
    "ui_test"
  ]
}
```

Synapse soll damit vorab pruefen, ob ein Testsystem fuer eine Aufgabe geeignet ist.

---

## 29. Teststufen / Testmatrix

Langfristiges Ziel ist eine klare Unterscheidung zwischen simuliertem/isoliertem und echtem Endsystem-Test.

Beispiel:

```text
Build             OK
Workspace-Test    OK
VM Windows        OK
Pixel 5           OK
macOS ARM64       wartend / nicht verfuegbar
```

Damit ist transparent, welche Aussage ein gruener Test wirklich erlaubt.

---

## 30. WebUI: aktueller Stand

Die aktuelle WebUI im aktiven Stand wurde geprueft.

Sie besitzt im Kern:

- Chat
- Memory
- Dashboard
- Graph
- Login

`App.tsx` verwendet aktuell die Tabs:

```text
chat
memory
dashboard
graph
```

Es existierte bzw. existiert in einem anderen Branch bereits ein groesserer Mock. Dieser darf bei spaeterer UI-Arbeit als Ideenquelle geprueft werden, ist aber nicht mit dem aktuellen IST-Zustand gleichzusetzen.

---

## 31. WebUI: neuer Bereich fuer Umgebungen

Die neue Verwaltung sollte nicht einfach in das bereits grosse Dashboard gequetscht werden.

Vorgeschlagene Hauptansicht:

```text
Umgebungen / Testsysteme
|
|-- Reale Hardware
|-- Virtuelle Maschinen
`-- Workspaces
```

### 31.1 Reale Hardware

Pro System anzeigen:

- Name
- Plattform
- Architektur
- Status
- letzte Verbindung / Heartbeat
- Capabilities
- Besitzer-Nachricht
- Token-Status
- Testfreigabe
- aktueller Test / Agent optional

### 31.2 VMs

- Name
- Plattform
- Adresse/Transport
- Status
- Capabilities
- letzte Erreichbarkeit
- ggf. Freigabe

### 31.3 Workspaces

- Projekt
- Name
- Typ (`mirror`, persistent work, `isolated`)
- Status
- Rolle
- Ressourcen
- pinned
- Sync-Zustand
- eigener Overlay-Stand ja/nein
- Anzahl geaenderter Dateien
- Merge-Status
- Konfliktzahl

---

## 32. WebUI: Tokenverwaltung

Die bisherige WebUI besitzt noch keine vollwertige zentrale Service-/Testsystem-Token-Verwaltung.

Die neue UI sollte mindestens koennen:

- Testsystem anlegen
- Token erzeugen
- Token nur einmal im Klartext anzeigen
- Token erneuern
- Token widerrufen
- letzten Einsatz anzeigen
- Scope/System-ID anzeigen

Klartext-Tokens duerfen serverseitig nicht dauerhaft gespeichert werden; bestehende Auth-Mechaniken mit Hash-Speicherung koennen als Vorbild dienen.

---

## 33. Bestehendes Vorbild: Embedding Nodes

Die aktuelle Synapse-Implementierung fuer Embedding-Nodes besitzt bereits mehrere Konzepte, die fuer Testsysteme als Vorlage dienen koennen:

- eigener Node-Token
- Token an Node-ID gebunden
- register
- self
- heartbeat
- Status
- serverseitige Validierung

Die Testsystem-Infrastruktur soll nicht blind kopiert werden, kann aber dieselben bewaehrten Muster fuer Identity, Heartbeat und Token-Bindung verwenden.

---

## 34. Auth-Gate

Aktuell existieren bereits Service-Tokens und Scope-Werte, aber der allgemeine Auth-Hook wertet die Scopes noch nicht vollstaendig als fein granulierte Berechtigungen aus.

Fuer Testsysteme ist echte Scope-/Rollenvalidierung Pflicht.

Ein Testsystem-Token darf nicht allein deshalb alle normalen `/api/*` Funktionen verwenden duerfen, weil es formal ein gueltiger Bearer-Token ist.

Dieser Punkt ist ein eigener Sicherheits-Gate fuer die Implementierung.

---

## 35. Audit der Remote-Testausfuehrungen

Neben File-Audit sollte auch Remote-Testaktivitaet nachvollziehbar sein.

Mindestens:

- welches Testsystem
- welcher Agent
- welches Projekt
- welcher Scope/Workspace-Stand
- welches Kommando/Testprofil
- Start/Ende
- Ergebnis
- Blockierung durch Besitzer
- Artefakte

Bei echter Hardware ist besonders wichtig, unterscheiden zu koennen:

```text
Test wurde nicht ausgefuehrt, weil System blockiert
```

von:

```text
Test wurde ausgefuehrt und ist fehlgeschlagen
```

---

## 36. Artefakte echter Tests

Synapse soll spaeter Testartefakte einem Testlauf zuordnen koennen.

Moegliche Artefakte:

- Screenshots
- UI-Sidecar JSON
- Videos
- GIF
- Logs
- Build-Logs
- Exit-Codes
- Crash-Dumps
- App-Pakete
- Testreports

Fuer Moo ist dies besonders interessant, weil die Sprache bereits eigene UI-Test-/Capture-Funktionen besitzt und Screenshots/JSON/Video fuer KI-Auswertung erzeugen kann.

---

## 37. Keine Vermischung von Projekt- und Workspace-Code-Intel

Dies ist eine harte Invariante.

Verbotener Zustand:

```text
code_intel(project="synapse")
-> liefert Symbole aus PROJECT und dev-a gemischt
```

Ebenso verboten:

```text
code_intel(workspace="dev-a")
-> liefert fuer dieselbe file_path gleichzeitig Projekt- und Workspace-Symbolversion
```

Es darf fuer jede effektive Datei nur eine sichtbare Version im gewaehlten Scope geben.

---

## 38. Keine Workspace-Embeddings in Projekt-Qdrant

Ebenfalls harte Invariante.

Ein isolierter Workspace darf keine experimentellen Code-Chunks in die normale Projekt-Collection von Qdrant schreiben.

Erst nach erfolgreichem Merge und normalem Projekt-Commit darf die neue Projektversion in die normale Embedding-Pipeline gelangen.

---

## 39. Merge und Embedding

Nach Merge:

```text
Workspace
-> Merge-Preview
-> Project File-Plan
-> Project Commit
-> code_files aktualisiert
-> normaler Parser
-> normales Embedding
-> Qdrant aktualisiert
```

Damit bleibt Qdrant immer ein abgeleiteter Index des echten Projektstandes.

---

## 40. Rueckwaertskompatibilitaet

Bestehende Agenten duerfen durch das Scope-System nicht ploetzlich in einem unbekannten Workspace arbeiten.

Deshalb:

- kein Scope angegeben -> echter Projektstand
- kein Workspace angegeben -> heutige Semantik
- neue isolierte Funktionen nur opt-in

Auch bestehende REST-/MCP-Clients muessen weiterhin funktionieren.

---

## 41. Alte Tool-Schema-Caches beachten

Im Projekt existiert bereits eine reale Falle: alte MCP-Clients koennen neue Parameter still verwerfen.

Das ist fuer `scope` besonders gefaehrlich.

Beispiel:

Agent glaubt:

```text
files(... scope=workspace/dev-a ...)
```

Alter Client verwirft `scope` still.

Server fuehrt Operation gegen PROJECT aus.

Das waere katastrophal.

Deshalb muss die Scope-Einfuehrung so gestaltet werden, dass ein fehlender/verworfener Workspace-Scope nicht unbemerkt eine destruktive Projekt-Aenderung ausloest.

Moegliche Schutzideen:

- neue Actions fuer Workspace-Schreibwege statt nur optionalem Parameter in kritischen Alt-Clients
- serverseitige Workspace-Session/Context-ID
- Versions-/Capability-Handshake
- harte Validierung bei Workspace-spezifischen Tools

Dieser Gate muss vor Implementierung konkret geloest werden.

---

## 42. `code_intel.scope` Namenskonflikt beachten

`code_intel` besitzt heute bereits einen Parameter namens `scope`, der fuer `statements/flow` einen Funktions-/Scope-Namen bedeutet.

Deshalb darf ein neuer Datei-/Workspace-Scope nicht unueberlegt ebenfalls `scope` heissen.

Bessere moegliche Namen:

- `workspace`
- `workspace_id`
- `source_scope`
- `code_scope`

Die genaue API muss so gewaehlt werden, dass bestehende `flow(scope="funktion")` Calls nicht brechen.

---

## 43. Datenbankmigrationen

Die Erweiterung wird Schema-Aenderungen benoetigen.

Voraussichtlich betroffen:

- project_workspaces
- file_batch_plans
- file_versions
- file_reservations / Co-Edit Tabellen
- neue Workspace-Overlay-Tabelle(n)
- Code-Intel Tabellen
- neue Testsystem-Tabellen
- ggf. Testlauf-/Artefakt-Tabellen

Bei Schema-Aenderungen gilt weiterhin die bestehende Synapse-Regel: kompletter `SCHEMA_SQL` muss vor Deploy transaktional gegen die echte DB probeweise ausgefuehrt werden.

---

## 44. Moegliches Datenmodell fuer Testsysteme

Nur als Designrichtung, nicht als festes finales Schema:

```text
test_systems
- id
- name
- type: hardware | vm
- platform
- arch
- transport
- address
- status
- owner_message
- capabilities jsonb
- token_hash / token binding
- last_seen
- created_at
- updated_at
```

Optional getrennt:

```text
test_system_runs
- id
- test_system_id
- project
- source_scope_type
- source_scope_id
- agent_id
- status
- started_at
- finished_at
- result
```

---

## 45. Moegliches Datenmodell fuer Workspace-Overlays

Designrichtung:

```text
workspace_code_files
- id
- workspace_id
- project
- file_path
- change_type
- content
- content_hash
- base_hash
- base_version_id
- parser_version
- parsed_at
- created_by
- created_at
- updated_at
```

Unique logisch:

```text
workspace_id + file_path
```

---

## 46. Moegliches Scope-Feld fuer bestehende Tabellen

Beispiel:

```text
scope_type text NOT NULL DEFAULT 'project'
scope_id uuid NULL
```

Constraint sinngemaess:

```text
scope_type='project'   -> scope_id IS NULL
scope_type='workspace' -> scope_id IS NOT NULL
```

Die genaue Entscheidung zwischen Erweiterung bestehender Tabellen und separaten Workspace-Tabellen muss vor Implementierung mit Query-/Index-/Migrationskosten bewertet werden.

---

## 47. Ein gemeinsames Scope-Modul ist Pflicht

Die Scope-Aufloesung darf nicht in jedem Service neu implementiert werden.

Benötigt wird ein zentraler Service fuer z. B.:

- Scope normalisieren
- Workspace-ID validieren
- effektive Datei lesen
- Basisdatei lesen
- Overlay lesen
- Scope-aware Hash bestimmen
- Scope-aware Existenz pruefen
- Scope-aware Pfadliste erzeugen

Damit werden Inkonsistenzen zwischen `files`, `code_intel`, Parser und Merge verhindert.

---

## 48. Phasen fuer die spaetere Umsetzung

Eine moegliche sichere Reihenfolge:

### Phase A: Environment/Testsystem Grundmodell

- Testsystem-DB
- Token/Scope
- Heartbeat
- Availability
- Owner Message
- WebUI-Grundansicht
- noch kein Remote-Exec erzwingen

### Phase B: reale Testsystem-Gates

- SSH-Testtarget
- VM-Testtarget
- Android/ADB spaeter
- serverseitige Availability-Pruefung
- Audit

### Phase C: Workspace-Modi formalisieren

- `mirror`
- persistent work platform
- `isolated` als vorbereiteter Typ
- Guide/Tool-Namensschema bereinigen

### Phase D: Scope-Grundschicht

- Scope-Service
- DB-Felder/IDs
- File-Read-Aufloesung
- noch kein Workspace-Write

### Phase E: Workspace Overlay + File-Tools

- Overlay-Tabelle
- scope-aware create/update/delete/move/copy/read
- scope-aware plan/commit
- scope-aware versions/history
- scope-aware Reservierungen

### Phase F: Parser/Code-Intel

- Workspace Parserdaten
- scope-aware functions/symbols/references/calls/flow/etc.
- KEINE Workspace-Embeddings

### Phase G: isolierte Workspace-Materialisierung

- eigenes Source-Volume/Overlay pro isolated Workspace
- PG Workspace-Overlay -> Container Sync
- Shell gezielt auf diesen effektiven Stand

### Phase H: Merge

- Base/OURS/THEIRS
- 3-Wege-Merge
- Konflikt-Preview
- Erzeugung normaler Project File-Plans
- Merge-Audit

---

## 49. Mindesttests fuer Scope-Einfuehrung

Die Scope-Erweiterung darf nicht nur mit Happy-Path-Tests abgenommen werden.

Mindestens pruefen:

1. Projektdatei unveraendert, Workspace liest Projektversion.
2. Workspace modifiziert Datei, PROJECT liest weiterhin alte echte Version.
3. Workspace erstellt neue Datei, PROJECT sieht sie nicht.
4. Workspace loescht Datei, PROJECT besitzt sie weiterhin.
5. dev-a und dev-b aendern dieselbe file_path unterschiedlich.
6. code_intel PROJECT liefert nur PROJECT-Symbole.
7. code_intel dev-a liefert effektive dev-a-Symbole.
8. References/Calls vermischen keine Scopes.
9. Workspace Plan blockiert Project Plan nicht.
10. Project Plan blockiert Workspace Plan nicht.
11. Zwei Agenten im selben Workspace werden weiterhin ueber Co-Edit koordiniert.
12. Workspace-Aenderung erzeugt kein Projekt-Qdrant-Embedding.
13. Merge erzeugt erst nach Project-Commit normales Embedding.
14. Stale Project-Stand nach Workspace-Erzeugung wird im Merge erkannt.
15. Gleichzeitige unterschiedliche Aenderungen sind automatisch mergebar.
16. Gleichzeitige gleiche Region erzeugt Konflikt.
17. Alter Client darf einen verworfenen Workspace-Parameter nicht als Project-Write ausfuehren.
18. Audit zeigt Scope eindeutig.
19. Restore im Workspace veraendert nicht PROJECT.
20. Workspace-Loeschung entfernt seinen Overlay-/Parserstand sauber, ohne Project-Daten zu beruehren.

---

## 50. Mindesttests fuer reale Testsysteme

1. Heartbeat frisch -> available.
2. Heartbeat abgelaufen -> offline.
3. Besitzer setzt blocked -> Remote-Exec wird vor SSH/ADB verhindert.
4. Besitzer-Nachricht wird Agent angezeigt.
5. light_only verhindert schwere Testklasse.
6. Testsystem-Token kann kein fremdes Testsystem veraendern.
7. Testsystem-Token kann keine normalen Projekt-APIs missbrauchen.
8. Token widerrufen -> naechster Heartbeat abgelehnt.
9. Capability fehlt -> Test wird nicht gestartet.
10. Test-Audit unterscheidet blockiert, fehlgeschlagen und erfolgreich.

---

## 51. Aktuelle Haupt-Gates

Die derzeit groessten technischen Gates fuer isolierte Workspace-Staende sind:

1. `/workspace`-Sources werden heute pro Projekt geteilt.
2. File-Plaene kennen keinen Workspace-Scope.
3. File-Versionen/Audit kennen keinen Workspace-Scope.
4. Reservierungen kennen keinen Workspace-Scope.
5. File-CRUD kennt keinen Workspace-Scope.
6. Code-Intel kennt keinen echten Dateistand-Scope.
7. Parser-/Symbol-/Reference-Daten sind nicht workspace-isoliert.
8. Qdrant-Pipeline muss Workspace-Embeddings explizit verhindern.
9. Merge-Schicht existiert noch nicht.
10. Auth-Scope fuer Testsystem-Token muss wirklich serverseitig erzwungen werden.
11. Tool-Schema-Caching kann neue optionale Parameter gefaehrlich verschlucken.
12. WebUI besitzt noch keine Umgebungs-/Testsystem-/Token-Verwaltung.

---

## 52. Was schon sehr gut wiederverwendbar ist

Keine Neuentwicklung noetig fuer die Grundideen von:

- mehreren benannten Workspaces
- Workspace Lifecycle
- Ressourcenlimits
- Rollen/Templates
- persistentem HOME
- Shell Workspace Routing
- Local -> Workspace Fallback
- PG -> Workspace Auto-Sync
- read-only Source Enforcement
- File-Plan Preview
- expected hashes
- Stale-Erkennung
- Re-Apply
- File-Versionierung
- Batch IDs
- Agent Audit
- Co-Edit-Konflikterkennung
- Heartbeat-/Node-Token-Muster aus Embedding-Nodes

Die neue Architektur sollte diese vorhandenen Systeme erweitern statt Parallelwelten zu bauen.

---

## 53. Zielbild

Langfristig soll ein Agent bewusst erkennen und waehlen koennen, wo er arbeitet und wo er testet.

Beispiel:

```text
Projekt: moo

Source of Truth:
  PostgreSQL PROJECT

Arbeitsumgebung:
  workspace/dev-main (persistent mirror)

Experiment:
  workspace/esp32-runtime (isolated)

Tests:
  workspace/qa            -> Linux Sandbox
  vm/windows-test         -> Windows VM
  hardware/pixel5         -> Android Echtgeraet
  hardware/macbook-freund -> macOS ARM64 Echtgeraet
```

Und Synapse kann transparent anzeigen:

```text
Build                  OK
Workspace Integration  OK
Windows VM             OK
Android Pixel 5        OK
macOS ARM64             BLOCKED: Besitzer nutzt Rechner
```

---

## 54. Wichtigste Architektur-Invarianten in Kurzform

1. PostgreSQL bleibt Wahrheit.
2. Normaler Workspace-Sync ist nur PG -> Workspace.
3. Workspace schreibt nie automatisch in PROJECT zurueck.
4. Isolierte Workspace-Aenderungen leben in eigenem Scope/Overlay.
5. Project und Workspace Audit werden nie vermischt.
6. Project und Workspace Code-Intel werden nie vermischt.
7. Parser im Workspace: ja.
8. Normale Qdrant-Embeddings im Workspace: nein.
9. Erst Project-Merge/Commit erzeugt normale Embeddings.
10. Merge schreibt nie direkt nach `code_files`, sondern erzeugt einen normalen Project-File-Plan.
11. Scope muss durch alle File-Tools, Plans, Reservierungen, Versionen und Code-Intel laufen.
12. Eine zentrale effektive Datei-Aufloesung ist Pflicht.
13. Reale Testsysteme besitzen eigene eng begrenzte Tokens.
14. Besitzer-Sperre wird serverseitig vor Remote-Zugriff erzwungen.
15. Alte Clients duerfen einen verlorenen Workspace-Parameter niemals still als PROJECT-Write ausfuehren.

---

## 55. Noch offene Designentscheidungen vor Implementierung

Diese Punkte sind bewusst noch nicht final festgelegt:

- Name des uebergeordneten Tools/Guides (`environment`, `target`, andere Bezeichnung).
- Exakte REST/MCP-Parameter fuer Datei-Scope ohne Konflikt mit bestehendem `code_intel.scope`.
- Ob bestehende Code-Intel-Tabellen Scope-Spalten bekommen oder fuer Workspace-Parserdaten separate Tabellen verwendet werden.
- Ob `file_versions` direkt Scope-Spalten bekommt oder Workspace-Versionen separat gespeichert werden.
- Exaktes Overlay-Schema.
- Exakte Materialisierungsstrategie fuer isolated Workspace-Volumes.
- Exakte 3-Wege-Merge-Bibliothek bzw. eigene Merge-Implementierung.
- Umgang mit Binary Files im Workspace-Merge.
- genaue Retention fuer verworfene Workspace-Audits.
- ob isolierte Workspaces nach Merge automatisch geloescht, archiviert oder manuell geschlossen werden.
- ob eine spaetere temporaere semantische Workspace-Suche gebraucht wird.

Diese Entscheidungen muessen vor der jeweiligen Implementierungsphase codebasiert gegen den dann aktuellen Stand von Synapse geprueft werden.

---

## 56. Zusammenfassung

Das Vorhaben ist groesser als eine Erweiterung des Docker-Workspace-Tools. Es fuehrt ein allgemeines Konzept fuer Arbeits- und Testumgebungen ein und erweitert Synapse um echte, voneinander getrennte Code-Staende.

Der normale Standard bleibt bewusst einfach und sicher:

```text
Synapse/PG
-> Workspace mirror
-> bauen/testen
```

Nur bei ausdruecklich isolierten Entwicklungsworkspaces kommt hinzu:

```text
PROJECT
-> Workspace-Overlay
-> eigener Parser/Code-Intel-Stand
-> keine Embeddings
-> optionaler 3-Wege-Merge
-> normaler Project File-Plan
-> Project Commit
-> normale Embedding-Pipeline
```

Reale Hardware und VMs erweitern diese Architektur um den fehlenden letzten Testschritt, den Docker und Sandboxen prinzipbedingt nicht vollstaendig ersetzen koennen.

Diese Datei dient als Architekturgrundlage. Vor konkreter Implementierung ist jeder betroffene Bereich erneut mit `code_intel` gegen den dann aktuellen Live-Code zu pruefen, damit keine veralteten Annahmen aus diesem Entwurf ungeprueft in Code umgesetzt werden.



---

## 51. Qualitätsprüfung für deutschsprachige persistente Inhalte

Unabhängig von der Workspace-/Testsystem-Architektur soll Synapse bei der Erstellung deutschsprachiger persistenter Inhalte die Ausgabe vor dem Speichern auf typische ASCII-Umschreibungen deutscher Sonderzeichen prüfen.

Betroffen sind insbesondere Memories, Thoughts/Gedanken, neu erzeugte oder vollständig generierte Markdown-Dateien (`*.md`) und vergleichbare längerfristig gespeicherte deutschsprachige Dokumentationsinhalte.

### 51.1 Ziel und Beispiele

KI-Agenten erzeugen gelegentlich `fuer`, `ueber`, `moeglich`, `Aenderung` oder `groesser`, obwohl UTF-8 verfügbar ist. In normalem deutschem Fließtext sollen stattdessen `für`, `über`, `möglich`, `Änderung` und `größer` verwendet werden.

### 51.2 Prüfung vor Persistierung

Vor dem endgültigen Schreiben soll das jeweilige Tool den Agententext auf potenzielle ASCII-Umschreibungen wie `ae`, `ue`, `oe` und `ss` prüfen. Eine rein mechanische globale Ersetzung ist ausdrücklich verboten: Diese Zeichenfolgen können legitimer Bestandteil von Namen, Code, URLs, Dateipfaden, Variablen, technischen Begriffen oder fremdsprachigem Text sein.

Die Prüfung ist deshalb ein Qualitäts-Gate und kein blindes Search/Replace.

### 51.3 Verhalten bei einem Treffer

Wenn Synapse mit ausreichender Sicherheit erkennt, dass deutschsprachiger Fließtext unnötige ASCII-Umschreibungen enthält, soll der Schreibvorgang nicht unbemerkt mit dieser Fassung abgeschlossen werden. Die Tool-Antwort soll klar darauf hinweisen, dass normale UTF-8-Umlaute/Sonderzeichen verwendet werden sollen. Der Agent korrigiert anschließend den Inhalt und schreibt erneut.

### 51.4 Technische Inhalte schützen

Von automatischer Veränderung beziehungsweise aggressiver Beanstandung müssen insbesondere Codeblöcke, Inline-Code, URLs, Dateipfade, Hashes/IDs, Symbolnamen, strukturierte technische Inhalte, Eigennamen und bewusst ASCII-kompatible Formate ausgenommen werden.

Beispiel: `src/uebertragung.ts` darf niemals automatisch in einen anderen Dateipfad umbenannt werden.

### 51.5 Scope der Prüfung

Das Gate gilt primär für deutschsprachigen natürlichen Fließtext. Eine spätere Implementierung kann dafür erkannte Sprache, typische deutsche Wörter, das Verhältnis von Fließtext zu Code sowie maskierte Markdown-Code-Fences und Inline-Code kombinieren.

### 51.6 Betroffene Tool-Wege

Die Prüfung muss serverseitig an den zentralen Persistierungswegen sitzen und darf nicht nur in der WebUI implementiert werden. Mindestens berücksichtigen:

```text
memory(write/create/update)
thought(write/create/update)
files(create/update) bei *.md und natürlichsprachlichem Dokumentinhalt
```

Wenn mehrere Tools denselben Persistierungsservice verwenden können, soll die Prüfung zentral wiederverwendet werden.

### 51.7 Kein stilles Umschreiben

Bevorzugter Ablauf:

```text
Agent liefert Text
       ↓
Synapse prüft
       ↓
auffällige ASCII-Umschreibung erkannt
       ↓
Write wird mit verständlichem Qualitäts-Hinweis zurückgewiesen
       ↓
Agent korrigiert seine Ausgabe
       ↓
erneuter Write
```

Synapse soll nicht unbemerkt Wörter verändern und dadurch möglicherweise technische Begriffe beschädigen.

### 51.8 Audit

Ein wegen dieses Gates abgelehnter Schreibversuch darf als Validierungsereignis im normalen Tool-Audit sichtbar sein. Es darf jedoch keine fehlerhafte Zwischenversion in der eigentlichen Memory-, Thought- oder Dateihistorie erzeugt werden.

### 51.9 Mindesttests

1. `Das ist fuer den spaeteren Test moeglich.` wird beanstandet.
2. `Das ist für den späteren Test möglich.` wird akzeptiert.
3. Ein Codeblock mit `const fuerTest = true;` wird nicht verändert.
4. Ein Dateipfad `src/uebertragung.ts` wird nicht verändert.
5. Eine URL mit `ue` wird nicht verändert.
6. `groesser` in eindeutig deutschem Fließtext wird als Kandidat für `größer` erkannt.
7. `ss` wird nicht pauschal zu `ß` konvertiert.
8. Englischer oder technischer Text wird nicht aufgrund zufälliger `ae/oe/ue`-Folgen blockiert.
9. Abgelehnter Inhalt erzeugt keine persistente Zwischenversion.
10. Das Gate funktioniert identisch über MCP, REST und WebUI, weil es serverseitig am Persistierungsweg sitzt.



### 51.10 Channel-Nachrichten und kontextarmes Erfolgsverhalten

Das gleiche Qualitäts-Gate soll auch für deutschsprachige Channel-Nachrichten gelten, weil diese von anderen Agenten gelesen und als Arbeitskontext weiterverwendet werden.

Betroffen sind damit zusätzlich insbesondere:

```text
channel(send/write/message)
```

Der Hook soll asymmetrisch antworten:

- Fehlerfall: kurzer, konkreter Hinweis auf die erkannten problematischen Schreibweisen und Aufforderung zur Korrektur.
- Erfolgsfall: kein erklärender Zusatztext und möglichst kein zusätzlicher Kontext. Der Write läuft normal durch und die Tool-Antwort bleibt so klein wie möglich.

Ziel ist, dass ein Agent die Regel nur dann erneut in seinen Kontext bekommt, wenn er sie tatsächlich verletzt. Wer korrekt mit UTF-8-Umlauten und Sonderzeichen schreibt, soll nicht bei jedem erfolgreichen Persistierungs- oder Channel-Write erneut dieselbe Qualitätsregel zurückerhalten.

Beispiel Fehlerfall:

```text
Abgelehnt: Im deutschen Fließtext wurden wahrscheinlich unnötige ASCII-Umschreibungen erkannt:
"fuer" -> "für", "spaeter" -> "später". Bitte korrigieren und erneut senden.
```

Beispiel Erfolgsfall:

```text
success: true
```

beziehungsweise die ohnehin notwendige normale Tool-Antwort ohne zusätzlichen Qualitäts-Hinweis.

Diese Eigenschaft ist ausdrücklich auch eine Kontext-Optimierung: korrekt arbeitende Agenten verbrauchen weniger Kontext, während falsch arbeitende Agenten direkt beim verursachenden Schreibvorgang den passenden Hinweis erhalten.



---

## 57. Agent-Runtime-Schicht für Main-Agent, Spezialisten, Dreamer und Verwalter

Die Agent-Runtime-Schicht ist bewusst von Workspaces, Testsystemen und dem eigentlichen Synapse-Projektstand zu trennen.

### 57.1 Grundprinzip

Synapse bleibt die zentrale persistente Instanz. Agenten-Runtimes sind austauschbare Ausführungsumgebungen für LLM-Agenten.

```text
Synapse API / PostgreSQL
        |
        +-- lokaler Zugriff bleibt vollständig möglich
        +-- Web-Zugriff bleibt vollständig möglich
        +-- Agent-Runtime-Hosts
                |
                +-- Claude Code CLI
                +-- Codex CLI
                +-- API-basierte Agenten
                +-- später weitere Backends
```

Wichtig: Es darf für diese Architektur keine zweite Synapse-Instanz mit eigener PostgreSQL-/Qdrant-Wahrheit gestartet werden. Alle Runtimes arbeiten gegen dieselbe Synapse API. Dadurch werden weder Projektcode noch Memories, Thoughts, Parserdaten oder Embeddings durch eine zweite Synapse-Instanz dupliziert.

### 57.2 Agent, Runtime, Modell und Authentifizierung sind getrennte Begriffe

Ein logischer Agent darf nicht fest an einen Provider gebunden sein.

```text
Agent
!= Runtime
!= Modell
!= Authentifizierung
```

Beispiel:

```text
Agent: synapse-main
Rolle: main
Runtime: codex-cli
Auth: ChatGPT-Account
```

kann später ohne Identitätsverlust zu

```text
Agent: synapse-main
Rolle: main
Runtime: openai-api
Auth: API-Key
```

oder zu einer Claude-/lokalen Runtime wechseln.

### 57.3 Claude-Code-Spezialisten im Container

Die bereits vorhandenen Spezialisten sollen funktional unverändert bleiben. Der Unterschied ist nur ihr Ausführungsort.

Heute:

```text
Synapse
-> Wrapper
-> Claude Code lokal auf dem Benutzer-PC
-> Synapse-Tools
```

Ziel:

```text
Synapse
-> Wrapper/Runtime-Manager
-> Claude Code auf Agent-Runtime-Host im Docker
-> Synapse API/MCP
```

Ein Agent-Runtime-Host soll pro Projekt eine Projektordnerstruktur erzeugen, damit Claude Code in einem eindeutigen Projektkontext startet.

Beispiel:

```text
/runtime/projects/moo/
    .synapse/
        agents/
            <agent-name>/
```

Der echte Projektcode muss nicht die Source of Truth dieses Runtime-Verzeichnisses sein. Lesen/Schreiben erfolgt weiterhin über Synapse-Tools. Das Runtime-Verzeichnis dient primär Projektidentität, Wrapper-/Agentenstatus und dem erwarteten lokalen Kontext der CLI.

### 57.4 Kein Docker-in-Docker als Standard

Die Agent-Runtime soll nicht als eigene zweite Docker-Welt innerhalb eines Docker-Daemons betrieben werden. Stattdessen verwaltet Synapse beziehungsweise ein Runtime-Manager normale Agent-Container auf dem vorgesehenen Docker-Host.

Damit bleibt der Lifecycle kontrollierbar:

```text
Image aktualisieren
-> Agent kontrolliert stoppen/Handoff
-> Container ersetzen
-> persistentes Auth-Volume wieder mounten
-> Agent mit gleicher Synapse-Identität neu starten
```

### 57.5 Modell-Login getrennt von Synapse-Zugriff

Claude-/Codex-Account-Login und Synapse-Authentifizierung sind getrennt.

Für CLI-Account-Logins soll ein persistentes Auth-Volume vorgesehen werden. Die WebUI kann dafür ein Terminal des Runtime-Hosts öffnen, damit der Benutzer sich interaktiv anmelden kann.

API-basierte Runtimes erhalten ihre Provider-Credentials aus der Runtime-Konfiguration/Secret-Verwaltung.

### 57.6 Synapse-Zugriff der Agenten

Containerisierte Spezialisten sollen sich gegenüber Synapse wie die heutigen lokalen Spezialisten verhalten. Sie benötigen die normalen Synapse-Tools und müssen sich mit ihrer tatsächlichen Agentenidentität und ihrem Projekt anmelden können.

Der Runtime-Host selbst kann eine eigene Host-Identität besitzen. Die konkrete Agentenidentität bleibt jedoch pro gespawnter Agentensitzung erhalten und darf bei Context-Rotation nicht verloren gehen.

```text
agent_id = moo-parser-pruefer
project  = moo
session  = austauschbar
```

Bei Context-Rotation wird nur die Modellsitzung ersetzt. Agentenidentität, Rolle, Projekt, Wissen und Zustand liegen in Synapse.

### 57.7 Main-Agent als austauschbare Agentenrolle

Der Main-Agent soll keine fest verdrahtete Runtime sein. Er wird als eigener Agent mit einer speziellen globalen Rolle erzeugt.

Beim Wechsel des Main-Agenten:

```text
alter Main-Agent
-> Handoff nach Synapse
-> neuer Agent wird mit Rolle main erzeugt
-> liest Zustand aus Synapse
-> übernimmt die Hauptoberfläche
```

Lokale Nutzung und Web-Nutzung bleiben parallel und ohne Einschränkung möglich.

### 57.8 Spezialisten, Main-Agent, Dreamer und Verwalter nutzen dieselbe Runtime-Grundlage

Die Rollen unterscheiden sich über Prompt, Rechte/Fähigkeiten, Lebensdauer, Sichtbarkeit und Aufgaben, nicht über eine völlig andere technische Agentenplattform.

Mögliche Rollen:

```text
main
verwalter
dreamer
project-coordinator
specialist
```

Die bereits in Thoughts dokumentierten Dreamer-/Verwalter-Konzepte bleiben maßgeblich für deren Verhalten. Diese Architektur beschreibt nur ihre gemeinsame Runtime-Basis.

### 57.9 Eigenes globales Orchestrierungs-Tool nur für Main-Agent/Verwalter

Globale Agentensteuerung soll nicht an normale Spezialisten ausgeliefert werden.

Ein separates Tool, Arbeitstitel `orchestrator` oder `agent_control`, kann unter anderem bereitstellen:

```text
status
spawn eigener Main-Hilfsagenten
wake
heartbeat_policy
sleep/resume
stop
```

Normale Projekt-Spezialisten sehen dieses Tool nicht. Projektbezogene Spezialisten werden weiterhin über die jeweiligen Projektkoordinatoren verwaltet.

Der Main-Agent darf insbesondere Projektkoordinatoren wecken beziehungsweise deren Aktivitätslage steuern, ohne deren eigentliche Projektkoordination zu übernehmen.

### 57.10 Heartbeat bleibt erhalten, wird aber steuerbar

Der aktuelle Wrapper besitzt bereits einen echten Heartbeat-/Polling-Pfad. Er holt in einem Sammelabruf Konfiguration, Channel-Nachrichten, Inbox und weitere Synapse-Items und verarbeitet zusätzlich Context-Rotation, Stuck-Detection und Wake-Ereignisse.

Der heutige Keep-Alive-Fallback sendet bei ausbleibender Aktivität sinngemäß eine feste Anweisung wie:

```text
HEARTBEAT — Keine neuen Nachrichten.
Führe deinen laufenden Task fort oder poste einen Status-Update.
```

Diese feste Anweisung soll zu einer durch Synapse verwalteten Heartbeat-Policy werden.

Damit werden zwei Dinge getrennt steuerbar:

```text
WANN wird geprüft/geweckt?
-> Heartbeat-Intervall

WAS soll der Agent bei einem leeren Heartbeat tun?
-> Heartbeat-Policy / Anweisung
```

Beispiele:

```text
active
-> laufende Arbeit fortsetzen

observe
-> nur relevante Änderungen prüfen

idle_check
-> keine neue Arbeit beginnen; bei keiner Relevanz HEARTBEAT_OK

dream_cycle
-> Dreamer-spezifische Nachtaufgabe
```

Der Main-Agent beziehungsweise Verwalter kann die Policy und gegebenenfalls den Takt an die Aktivitätslage anpassen.

Wichtig: Der Heartbeat soll nicht vollständig durch Tool-Hooks ersetzt werden. Ein idle Agent verwendet gerade keine Synapse-Tools und würde ohne Wrapper-/Runtime-Polling keine neue Lage erkennen.

### 57.11 Wrapper/Runtime hört auch dann zu, wenn das LLM idle ist

Grundregel:

```text
LLM kann idle/schlafend sein.
Wrapper/Runtime-Manager bleibt erreichbar.
```

Wake-Ereignisse dürfen nicht davon abhängen, dass der LLM-Agent selbst zuerst ein Tool aufruft.

Der vorhandene Live-Kanal/Notify-Pfad kann der schnelle Weg bleiben; ein leichter Poll/Heartbeat bleibt das Sicherheitsnetz für verlorene Verbindungen.

### 57.12 Skalierung der Agent-Runtime-Hosts

Es gibt keine konzeptionelle Grenze von fünf Agenten je Host. Ein Runtime-Host kann Agenten aus mehreren Projekten gleichzeitig tragen. Die reale Grenze wird später über CPU, RAM, Prozess-/Provider-Limits und Runtime-Policies bestimmt.

Viele registrierte Agenten bedeuten nicht, dass alle gleichzeitig aktiv sein müssen. Idle-/Waiting-Agenten können mit langen Heartbeat-Intervallen oder passender Policy praktisch keine laufende Arbeit verursachen.

### 57.13 Sicherer Einführungsweg ohne zweite Synapse

Die Agent-Runtime-Schicht muss zunächst vollständig additiv gebaut werden.

Verbot für die erste Phase:

```text
keine zweite PostgreSQL-Datenbank
keine zweite Qdrant-Collection-Wahrheit
kein zweiter FileWatcher für dieselben Projekte
keine zweite Parser-/Embedding-Pipeline für denselben Projektstand
keine automatische Ablösung der lokalen Spezialisten
```

Die erste Runtime darf nur Client der bestehenden Synapse API sein.

Damit kann sie getestet und jederzeit entfernt werden, ohne den vorhandenen Synapse-Betrieb oder Datenbestand zu verändern.

### 57.14 Empfohlene Reihenfolge für die Runtime-Implementierung

Phase R1 — Runtime-Abstraktion ohne Container und ohne automatisches Spawn:

- gemeinsames Runtime-Profil definieren
- Backend-Typen: Claude CLI, Codex CLI, API
- Agent/Runtime/Model/Auth sauber trennen
- noch keinen vorhandenen Spezialistenpfad ersetzen

Phase R2 — einzelner externer Agent-Runtime-Host:

- Container manuell/über WebUI anlegen
- persistentes Auth-Volume
- Terminal zum CLI-Login
- ausschließlich Synapse API/MCP als Daten-/Tool-Weg
- Test in einem ungefährlichen Testprojekt

Phase R3 — einen vorhandenen Spezialisten optional auf diesen Host routen:

- Opt-in pro Spawn/Agent
- lokale Ausführung bleibt Default/Fallback
- gleiche agent_id/Projektanmeldung wie lokal
- Context-Rotation und Respawn prüfen

Phase R4 — Runtime-Manager und automatische Host-Auswahl:

- mehrere Agenten pro Host
- Ressourcen-/Statusanzeige
- Lifecycle start/stop/restart
- weiterhin keine Änderung an Workspace-Scopes oder Projekt-Wahrheit nötig

Phase R5 — Main-Agent als eigener Runtime-Agent:

- eigenes Main-Profil
- austauschbares Backend
- Hauptoberfläche an Agentenidentität statt Provider koppeln
- globales Orchestrierungs-Tool nur an Main/Verwalter

Phase R6 — Heartbeat-Policy zentral steuerbar machen:

- bestehende Wrapper-Konfiguration erweitern
- feste Keep-Alive-Anweisung ablösen
- Main/Verwalter kann Policy/Takt ändern
- Live-Wake + Poll-Sicherheitsnetz beibehalten

Phase R7 — erst danach Dreamer/Verwalter und weitere Automatisierung auf diese Runtime-Schicht migrieren.

### 57.15 Was ausdrücklich später kommt

Die folgenden großen Themen sollen nicht mit der ersten Runtime-Einführung vermischt werden:

- isolierte Workspace-Scopes
- Workspace-Overlay-Dateisystem
- scope-fähige File-Tools
- scope-fähiges Code-Intel
- Workspace-Merge
- reale Testsysteme/Device-Farm

Sie können dieselbe spätere WebUI und Infrastruktur nutzen, sind aber eigenständige Risikobereiche.



---

## 58. WebUI-Vorphase vor Runtime- und Infrastrukturumbau

Bevor Agent-Runtime, Main-Agent, Testsysteme, isolierte Workspace-Scopes oder Merge-Logik produktiv umgesetzt werden, soll die WebUI als sichere Vorphase neu strukturiert werden. Ziel ist ausdrücklich nicht, neue produktive Runtime-Logik zu aktivieren, sondern das spätere Bedienmodell sichtbar, prüfbar und professionell zu machen.

### 58.1 Sicherheitsgrenze

Die erste WebUI-Phase darf keine zweite Synapse-Instanz, keinen zweiten FileWatcher, keine zweite Parser-Pipeline und keine zweite Embedding-Pipeline starten. Erlaubt sind bestehende Read-Endpunkte, reine UI-/Adapterstrukturen und Mock-Daten. Noch nicht aktivieren: Agent-Runtime-Container, Spezialisten-Migration, Main-Agent-Umschaltung, reale Testgeräte, Workspace-Scopes oder Merge-Logik.

### 58.2 Ein Projekt ist genau ein UI-Objekt

Ein wiederkehrendes UI-Problem ist ausdrücklich zu vermeiden: Ein Projekt darf in einer Projektübersicht nicht mehrfach erscheinen, nur weil dazu Memories, Thoughts, Tasks, Channels, Workspaces oder andere Datentypen existieren.

Falsch:

```text
synapse - project
synapse - memory
synapse - thought
synapse - task
moo - project
moo - thought
```

Richtig:

```text
synapse
moo
browsergame
```

Thoughts, Memories, Channels, Tasks, Agenten, Workspaces und Statistiken sind Beziehungen beziehungsweise Unteransichten des Projekts.

### 58.3 Go-Tray als fachliche Referenz

Die Projektansicht des vorhandenen Go-Trays dient als Referenz für die Projektidentität. Dort wird jedes echte Projekt genau einmal angezeigt; Aktivstatus und Aktionen verändern den Eintrag, erzeugen aber keine zusätzlichen Projektzeilen.

Grundregel für die WebUI:

```text
1 Projekt in Synapse = 1 Projektkarte / 1 Projektzeile / 1 Navigationseintrag
```

### 58.4 Vorgesehene Hauptbereiche

```text
Übersicht
Projekte
Agenten
Agent Hosts
Runtimes
Workspaces
Testsysteme
Dreamer
Verwalter
System
```

Die WebUI soll wie eine professionelle Control-Plane aufgebaut sein, nicht wie eine Sammlung einzelner Debug-Seiten.

### 58.5 Projektübersicht und Projektdetail

Die globale Projektübersicht bleibt kompakt, zum Beispiel:

```text
● synapse
  Hauptprojekt · aktiv
  6 aktive Agenten · 2 Workspaces · letzte Aktivität vor 1 min

● moo

### 58.6 Agenten, Hosts, Runtimes und Main-Agent

Agenten sollen jeweils genau einmal als logische Agenten erscheinen. Session-Wechsel, Context-Rotation oder Heartbeat-Events dürfen keine scheinbaren Duplikate erzeugen. Session- und Laufhistorie gehören ins Agentendetail.

Agent Host und Runtime sind getrennte Begriffe. Ein Host kann mehrere Runtimes und viele Agenten aus verschiedenen Projekten tragen. Beispiel:

```text
claude-unraid-01
Status: bereit
RAM: 6.2 / 32 GB
Agenten: 8
Runtimes: Claude CLI, Codex CLI

[Terminal] [Konfiguration] [Agenten]
```

Runtime-Beispiel:

```text
Claude Code  · CLI · Account · angemeldet
Codex        · CLI · ChatGPT Account · nicht eingerichtet
OpenAI API   · API · API-Key-Profil · konfiguriert
```

Der Main-Agent soll bereits als austauschbarer Agent sichtbar sein, zunächst mit Mock-Daten. Heartbeat-Intervall und Heartbeat-Policy sind getrennt darzustellen, damit erkennbar bleibt, wann ein Agent geweckt wird und welche Anweisung er dabei erhält.

### 58.7 Mock-Daten und Suchindex

Mock-Daten sind ausdrücklich erlaubt. Sie sollen in einem klaren Pfad wie `packages/web-ui/src/mock/` liegen. Wenn sie normale `code_intel`-Suchen stören, dürfen sie mit der bestehenden Ignore-Funktion im Modus `ausgeblendet` aus der normalen Sichtbarkeit genommen werden. Nicht `gesperrt`: Die Dateien dürfen weiter in PostgreSQL liegen und versioniert werden; sie sollen nur Suchresultate nicht verschmutzen.

Mock- und Echtdaten sollen dieselben ViewModels verwenden:

```text
UI Component
     |
     v
ProjectViewModel / AgentViewModel / HostViewModel
     ^
     |
Mock Adapter    REST Adapter
```

Keine Komponente soll selbst entscheiden, ob ihre Daten aus Mock oder REST kommen.

### 58.8 Designanforderung

Die Oberfläche soll als zusammenhängendes professionelles Produkt gestaltet werden. Keine lose Sammlung generischer Karten, keine zufälligen Farbverläufe und keine Debug-Dashboard-Optik. Für die Umsetzung gelten die vorhandenen Synapse-WebUI-Regeln und der Frontend-Design-Skill.

Informationsfluss:

```text
Navigation
→ Entität auswählen
→ Status verstehen
→ Details öffnen
→ gezielte Aktion
```

Nicht: alle verfügbaren Datensätze gleichzeitig anzeigen.

### 58.9 Empfohlene WebUI-Phasen

UI-0 — Ist-Aufnahme: aktuelle WebUI, vorhandene REST-Endpunkte, Go-Tray-Projekt-/Statusmodell und Design-Regeln mit `code_intel` erfassen. Keine produktiven Änderungen.

UI-1 — Informationsarchitektur und Designsystem: Hauptnavigation, gemeinsames Layout, Design Tokens, Projektübersicht mit exakt einem Eintrag pro Projekt, responsive Grundstruktur und Mock-Adapter.

UI-2 — Kernansichten mit Mock-Daten: Übersicht, Projekte, Projektdetail, Agenten, Agent Hosts, Runtimes, Workspaces, Testsysteme, Main-Agent-Bereich und Systemstatus. Dreamer/Verwalter nur als vorbereitete Ansichten, ohne ihre vorhandene Logik neu zu erfinden.

UI-3 — vorhandene echte Read-Endpunkte verdrahten: Mock-Daten dort ersetzen, wo stabile Read-Endpunkte existieren. Gemischte API-Datensätze niemals direkt als Projektliste rendern; Adapter müssen echte Projekte deduplizieren und Beziehungen getrennt modellieren.

UI-4 — Runtime-API-Vertrag erst nach visueller/fachlicher Abnahme definieren: Agent-Host-Modell, Runtime-Profile, Terminal-/Auth-Flow, Main-Agent-Verwaltung und Heartbeat-Policy-Endpunkte.

UI-5 — erst danach erste echte Runtime gemäß Abschnitt 57.

### 58.10 Abnahmekriterien

1. Jedes Projekt erscheint global exakt einmal.
2. Thoughts, Memories, Tasks und Channels erzeugen keine zusätzlichen Projektzeilen.
3. Projekt-Unterdaten erscheinen erst im Projektdetail oder als verdichtete Kennzahl.
4. Ein Agent bleibt trotz Session-/Context-Rotation ein logischer Agent.
5. Agent Host und Runtime sind getrennte UI-Entitäten.
6. Main-Agent ist austauschbar dargestellt, nicht als fest verdrahtetes Modell.
7. Heartbeat-Intervall und Heartbeat-Policy sind getrennt sichtbar.
8. Mock-Daten sind über Adapter gekapselt.
9. Mock-Dateien können aus `code_intel` ausgeblendet werden, ohne sie aus PostgreSQL zu entfernen.
10. Keine UI-Aktion startet versehentlich eine zweite Synapse-, Parser- oder Embedding-Instanz.
11. Die Oberfläche wirkt als ein zusammenhängendes professionelles Produkt.
12. Produktive Runtime-Schreibaktionen werden erst nach UI-Abnahme aktiviert.

### 58.11 Auftrag für eine separate ChatGPT-Work-Session

Die erste Work-Session soll ausschließlich UI-0 bis UI-3 bearbeiten. Kernauftrag: aktuelle Synapse-WebUI und Go-Tray mit `code_intel` untersuchen und die WebUI als professionelle Control-Plane neu aufbauen. Harte Informationsregel: Ein Projekt ist genau ein UI-Objekt; Memories, Thoughts, Tasks, Channels, Agenten und Workspaces sind Beziehungen/Unteransichten und dürfen die globale Projektliste nie vervielfachen. Für noch nicht existierende Runtime-/Testsystem-Funktionen Mock-Daten über eine getrennte Adapter-Schicht verwenden. Produktive Runtime-, Wrapper-, Parser-, Embedding- oder Workspace-Scope-Logik in dieser Phase nicht aktivieren. Vor WebUI-Code vorhandene WebUI, Go-Tray und Frontend-Design-Regeln lesen.

  aktiv
  2 aktive Agenten · kein Workspace · letzte Aktivität vor 8 min

○ browsergame
  deaktiviert
  keine laufenden Agenten
```

Vollständige Memory-, Thought-, Task- oder Channel-Inhalte gehören nicht direkt in diese Liste. Erst nach Auswahl eines Projekts erscheinen Unterbereiche wie Übersicht, Agenten, Tasks/Plan, Channels, Workspaces, Code/Index, Memories, Thoughts, Audit und Einstellungen.



---

## 59. Persönlicher Wissensbereich für den Main-Agenten

Der Main-Agent soll nicht nur Projektwissen verwalten, sondern auch einen klar getrennten persönlichen Wissensbereich des Benutzers verwenden können. Ziel ist, dass der Main-Agent über längere Zeit auf persönlichen Erfahrungen, Arbeitsweisen, Präferenzen, Entscheidungen und bereitgestellten Artefakten aufbauen kann, ohne diese Inhalte mit Projekt-Memories zu vermischen.

### 59.1 Drei Wissensebenen

Synapse soll mindestens drei logisch getrennte Ebenen unterscheiden:

```text
USER MEMORY
-> gehört dem Benutzer
-> projektübergreifend
-> primär für Main-Agent / persönliche Assistenz

PROJECT MEMORY
-> gehört einem konkreten Projekt
-> Projektkoordinatoren und Projektagenten

AGENT MEMORY
-> gehört einem konkreten Agenten
-> Handoffs, Spezialwissen, Lernstand, Arbeitskontext
```

Ein USER MEMORY ist ausdrücklich kein Synapse-Projekt-Memory. Ein Eintrag wie `Ich möchte bei größeren Änderungen zuerst eine vollständige Mock-UI sehen` gilt projektübergreifend und darf nicht nur unter `project=synapse` abgelegt werden.

### 59.2 Zweck des persönlichen Wissens

Typische Kategorien:

- Erfahrungen
- Arbeitsweisen
- Präferenzen
- Entscheidungen
- technische Erfahrungen
- Kommunikationsstil
- wiederkehrende Abläufe
- persönliche Ideen
- wichtige Hinweise
- frei definierbare Kategorien/Tags

Der Main-Agent darf diese Informationen verwenden, um neue Aufgaben besser einzuordnen und frühere Entscheidungen nicht ständig erneut zu erfragen.

### 59.3 Persönliche Artefakte

Zusätzlich zu kurzen Memories soll der Benutzer persönliche Artefakte hinterlegen können. Beispiele:

- E-Mail-Auszüge oder exportierte E-Mails
- Notizen
- Textdokumente
- PDFs
- Screenshots/Bilder
- Gesprächsnotizen
- technische Dokumente
- sonstige vom Benutzer bewusst bereitgestellte Dateien

Artefakte sind nicht automatisch Memories. Sie sind Quellen, aus denen der Main-Agent bei Bedarf Informationen lesen und auf Wunsch Memory-Vorschläge ableiten kann.

Beispiel:

```text
Persönliches Artefakt: E-Mail-Verlauf mit Lieferant X
        ↓
Main-Agent erkennt wiederkehrende Präferenz/Entscheidung
        ↓
Memory-Vorschlag
        ↓
Benutzer prüft
        ↓
USER MEMORY wird gespeichert
```

### 59.4 Herkunft und Nachvollziehbarkeit

Persönliche Memories sollen ihre Herkunft optional referenzieren können:

```text
owner = user
scope = global
source_type = manual | conversation | artifact | imported
source_artifact_id = optional
created_by = user | main-agent
```

Damit bleibt später nachvollziehbar, ob eine Erinnerung direkt vom Benutzer stammt oder aus einem Artefakt beziehungsweise Gespräch vorgeschlagen wurde.

### 59.5 Main-Agent-Rechte

Der Main-Agent soll den persönlichen Wissensbereich lesen und verwalten können. Dazu gehören:

```text
list
search
read
create
update
delete
suggest
link_artifact
```

Projekt-Spezialisten erhalten diesen globalen persönlichen Wissensbereich nicht automatisch. Falls ein Projekt ausdrücklich persönliche Informationen benötigt, soll der Main-Agent gezielt relevante Informationen weitergeben oder eine freigegebene Verknüpfung herstellen.

Dadurch wird vermieden, dass jeder Spezialist sämtliche persönlichen Inhalte des Benutzers sieht.

### 59.6 Memory-Vorschläge im Gespräch

Wenn der Main-Agent eine Information erkennt, die wahrscheinlich langfristig nützlich ist, darf er einen Memory-Vorschlag erzeugen.

Beispiel UI:

```text
Memory-Vorschlag

Kategorie: Arbeitsweise

Bei größeren Synapse-Änderungen möchte der Benutzer zuerst eine vollständig bedienbare Mock-UI prüfen, bevor Backend-Funktionen produktiv verdrahtet werden.

[Speichern] [Bearbeiten] [Verwerfen]
```

Wenn der Benutzer ausdrücklich sagt `merk dir das`, `speichere das` oder sinngemäß eindeutig eine Persistierung verlangt, kann der Main-Agent entsprechend der später definierten Policy direkt speichern. Sonst ist eine Vorschau/Vorschlagslogik vorzusehen.

### 59.7 WebUI-Struktur

Für UI1–UI3 soll bereits eine vollständige Mock-Ansicht vorgesehen werden.

WICHTIGE KORREKTUR DER INFORMATIONSARCHITEKTUR:

Es gibt **keinen gemeinsamen globalen Wissensbereich**, in dem persönliche und projektbezogene Wissensarten nebeneinander auswählbar sind. Genau diese Darstellung ist ausdrücklich unerwünscht.

Die globale Ebene enthält ausschließlich persönliches, projektübergreifendes Wissen des Benutzers:

```text
GLOBAL / PERSÖNLICH
├── Meine Memories
└── Persönliche Artefakte
```

Projektwissen gehört ausschließlich in die jeweilige Projektansicht:

```text
PROJEKT: <projektname>
├── Übersicht
├── Agenten
├── Tasks / Plan
├── Channels
├── Workspaces
├── Code / Graph
├── Memories
├── Thoughts
├── Agentenwissen
├── Audit
└── Einstellungen
```

`Projekt-Memories`, `Thoughts` und projektbezogenes `Agentenwissen` dürfen **nicht** als Unterpunkte eines globalen Menüs `Wissen` erscheinen. Sie werden erst sichtbar, wenn der Benutzer ein konkretes Projekt öffnet beziehungsweise dessen Detailansicht betrachtet.

Der Main-Agent darf intern persönliches Wissen und Wissen des aktiven Projekts kombinieren. Diese Fähigkeit ist jedoch eine Agenten-/Backend-Fähigkeit und **kein Grund, die beiden Wissensebenen in der UI zusammenzulegen**.

`Meine Memories` benötigt mindestens:

- Liste/Suche
- Kategorien/Tags
- Detailansicht
- Erstellen
- Bearbeiten
- Löschen
- Wichtigkeit/Priorität
- Herkunft
- Erstellzeitpunkt
- letzter Zugriff/letzte Nutzung als spätere Option
- verknüpfte Artefakte

`Persönliche Artefakte` ist **keine Upload-Oberfläche**. Der reguläre Eingang persönlicher Dateien erfolgt später ausschließlich über den Chat mit dem Hauptagenten. Der Server übernimmt die Datei in einen privaten, nur für den Hauptagenten freigegebenen Speicherbereich und liefert dem Agenten eine stabile Referenz beziehungsweise einen Serverpfad.

Grundfluss:

```text
Benutzer
  ↓ Datei im Hauptagenten-Chat
Synapse API
  ↓ übernimmt und speichert
privates Main-Agent-Volume
  ↓ artifact_id + Serverpfad + Metadaten
Hauptagent
  ↓ sofort verarbeiten oder für Nachtlauf vormerken
USER MEMORY / persönliche Ablage
```

Die WebUI dient bei persönlichen Artefakten ausschließlich als **Kontroll- und Verwaltungsoberfläche**. Sie benötigt in UI1–UI3 mindestens:

- Dateiliste
- Suche und Statusfilter
- Dateiname
- Typ
- Größe
- Eingang/Zeitpunkt
- Quelle/Herkunft
- Verarbeitungsstatus, z. B. neu, noch nicht analysiert, verarbeitet, mit Memories verknüpft, archiviert
- Vorschau beziehungsweise Datei ansehen
- Artifact-ID
- Serverpfad als technische Information
- letzte Analyse / letzter Zugriff
- verknüpfte Memories
- erkannte beziehungsweise abgeleitete Informationen als Mock
- Nutzungshistorie als Mock
- Archivieren
- Löschen
- optional Herunterladen

Es gibt dort **kein normales Upload-Formular**, keine manuelle Tag-/Kategorie-Pflicht und keinen primären Editor für die Ablage. Der Benutzer übergibt Dateien dem Hauptagenten im Chat; der Main-Agent entscheidet sofort oder im späteren Nachtlauf über Einordnung, Analyse und Memory-Ableitung.

Beim Löschen müssen zwei Vorgänge fachlich getrennt bleiben:

```text
Datei löschen
→ Originaldatei entfernen
→ bereits erzeugte Memories bleiben bestehen

Datei + abgeleitete Memories löschen
→ separater, ausdrücklich bestätigter Vorgang
```

Ein persönliches Originalartefakt darf niemals automatisch an ein Projekt oder einen Projektspezialisten freigegeben werden. Falls Projektwissen daraus benötigt wird, gibt der Hauptagent nur die relevante Information beziehungsweise eine explizit freigegebene Ableitung weiter; das Original bleibt im privaten Main-Agent-Bereich.

In UI1–UI3 bleiben Chat-Ingest, Dateiübernahme, privates Volume, Parsing, Extraktion, Download und Persistierung vollständig Mock. Das Kontroll- und Verwaltungsverhalten soll jedoch komplett sichtbar und testbar sein.

### 59.8 Keine Vermischung mit Projektwissen

Harte Regel:

```text
USER MEMORY != PROJECT MEMORY != AGENT MEMORY
```

Diese Trennung gilt nicht nur für Daten und Berechtigungen, sondern ausdrücklich auch für die **Navigation und Informationsarchitektur der WebUI**.

Ein persönlicher Eintrag darf nicht dadurch zu Projektwissen werden, dass gerade Projekt `synapse` aktiv ist.

Umgekehrt darf ein technisches Projekt-Memory nicht automatisch als persönliche Präferenz des Benutzers interpretiert werden.

Ebenso verboten ist folgende UI-Struktur:

```text
Wissen
├── Meine Memories
├── Persönliche Artefakte
├── Projekt-Memories
├── Agentenwissen
└── Thoughts
```

Diese Struktur vermischt globale und projektgebundene Ebenen, selbst wenn einzelne Unterseiten mit `USER SCOPE` oder `PROJECT SCOPE` beschriftet werden. Ein Scope-Badge repariert keine falsche Navigation.

Stattdessen gilt:

```text
GLOBAL
├── Meine Memories
└── Persönliche Artefakte

PROJEKTDETAIL
├── Memories
├── Thoughts
└── Agentenwissen
```

Wenn das aktive Projekt gewechselt wird, ändern sich ausschließlich die projektgebundenen Unteransichten. `Meine Memories` und `Persönliche Artefakte` bleiben unverändert und projektunabhängig.

### 59.9 PostgreSQL bleibt Source of Truth

Auch der persönliche Wissensbereich folgt der allgemeinen Synapse-Grundregel:

```text
PostgreSQL zuerst
Qdrant nur als abgeleiteter semantischer Index
```

Existenz, Listen, Detailansichten, Editieren und Löschen müssen später aus PostgreSQL beantwortet werden. Semantische Suche darf Qdrant verwenden.

### 59.10 Sicherheits- und Freigabegedanke

Persönliche Artefakte können sensible Inhalte enthalten. Deshalb soll die Architektur bereits vorsehen:

- keine automatische Freigabe an alle Projektagenten
- klare Owner-/Scope-Trennung
- explizite Verknüpfungen
- Audit für Änderungen
- Herkunft eines Memory-Eintrags sichtbar
- Löschen eines Artefakts darf nicht stillschweigend unklar lassen, welche daraus erzeugten Memories weiter bestehen

Die konkrete Rechte- und Verschlüsselungslogik wird erst in einer späteren Backend-Phase definiert.

### 59.11 UI1–UI3-Abnahmekriterium

Nach UI1–UI3 muss der Benutzer den persönlichen Wissensbereich vollständig bedienen können, obwohl die Daten Mock sind. Er muss beurteilen können, wie er eigene Memories, Erfahrungen und Artefakte hinterlegt und wie der Main-Agent daraus Memory-Vorschläge ableitet. Produktive Persistierung oder automatische E-Mail-Anbindung gehört noch nicht in diese Phase.
