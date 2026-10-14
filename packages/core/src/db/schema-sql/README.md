# SQL-Schema-Spiegel

[Synapse](../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Datenbank](../README.md) › SQL-Schema

## Zweck

Dieser Ordner enthält nummerierte SQL-Dateien mit der Struktur der Synapse-Datenbank. Die Dateien spiegeln Tabellen, Funktionen, Trigger und Beziehungen für den Kaltstart; die ausgeführte Laufzeitdefinition liegt in [`schema.ts`](../schema.ts). Die SQL-Dateien enthalten kein Nutzdaten-Backup und bilden nicht alle externen oder zur Laufzeit gepflegten Werte ab.

## Inhalt

### Grundlagen und Wissensdaten

| Datei | Aufgabe |
|---|---|
| [`00_extensions_types.sql`](00_extensions_types.sql) | Definiert benötigte PostgreSQL-Erweiterungen und Typen. |
| [`05_funktionen.sql`](05_funktionen.sql) | Enthält Datenbankfunktionen, unter anderem für Änderungsbenachrichtigungen. |
| [`10_projekte.sql`](10_projekte.sql) | Definiert Projekt-, Workspace- und Workspace-Rollentabellen. |
| [`20_wissen.sql`](20_wissen.sql) | Definiert Wissensdatensätze wie Memories, Thoughts, Pläne, Vorschläge und Tech-Dokumentation. |
| [`21_wissen_stuecke.sql`](21_wissen_stuecke.sql) | Definiert Status und Stücke für den versionierten Wissens-Stückindex. |

### Codeindex und Agenten

| Datei | Aufgabe |
|---|---|
| [`30_code_intelligence.sql`](30_code_intelligence.sql) | Definiert Code-Dateien, Symbole, Referenzen, Chunks, Aufrufkanten, Statements und Parse-Status. |
| [`40_agenten.sql`](40_agenten.sql) | Definiert Agent-Sitzungen, Events, Chat, Spezialistenkanäle und zugehörige Laufzeitdaten. |
| [`45_modelle_embedding.sql`](45_modelle_embedding.sql) | Definiert Modell-, Embedding-, Cutoff- und Schaltertabellen. |
| [`47_modell_pool.sql`](47_modell_pool.sql) | Definiert Provider, Zugangsdaten, Modelle und Ereignisse des freien Modellpools. |

### Shell, Dateien und Sicherung

| Datei | Aufgabe |
|---|---|
| [`47-shell-altbestand.sql`](47-shell-altbestand.sql) | Definiert Gruppen und Bezüge des Shell-Altbestands. |
| [`50_dateien.sql`](50_dateien.sql) | Definiert Datei-Versionen, Änderungspläne, Reservierungen, Waits und Watcher-Daten. |
| [`51_file_task_zuordnung.sql`](51_file_task_zuordnung.sql) | Definiert die Zuordnung von Datei-Versionen zu Plan-Tasks. |
| [`52_shell_sicherung.sql`](52_shell_sicherung.sql) | Definiert Shell-Sicherungsregeln, Risiko-Verben, Antworttopf und Auditdaten. |
| [`60_shell.sql`](60_shell.sql) | Definiert Shell-Jobs und Ausgabestream-Chunks. |
| [`61_shell_sicherungs_audit.sql`](61_shell_sicherungs_audit.sql) | Enthält die Ergänzung für das Shell-Sicherungs-Audit. |
| [`62_shell_demaskierungen.sql`](62_shell_demaskierungen.sql) | Ergänzt Gefahrkennzeichen und Rückfrage-Stufe im Shell-Katalog sowie die Liste bestätigt demaskierter Shell-Jobs. |

### Authentifizierung, Skills und weitere Fachbereiche

| Datei | Aufgabe |
|---|---|
| [`70_auth.sql`](70_auth.sql) | Definiert OAuth-Clients, Tokens, TOTP und Provider-Zugangsdaten. |
| [`80_skills.sql`](80_skills.sql) | Definiert Skill-Namen, Skill-Abschnitte und Hook-Daten. |
| [`85_audit.sql`](85_audit.sql) | Definiert Fehlermuster und den Audit-Store für Tool-Aufrufe. |
| [`90_trigger.sql`](90_trigger.sql) | Bündelt Trigger, die Datenbankänderungen weitergeben. |
| [`95_asset_intel.sql`](95_asset_intel.sql) | Definiert Asset-Dateien, -Objekte und -Referenzen. |
| [`95_foreign_keys.sql`](95_foreign_keys.sql) | Ergänzt Fremdschlüsselbeziehungen zwischen den Fachbereichen. |

## Schnittstellen nach außen

[`schema.ts`](../schema.ts) ist die Laufzeit-Schemadefinition; dieser Ordner enthält deren SQL-Spiegel für Datenbankstrukturen. Die nummerierten Dateien werden außerdem vom gebündelten PostgreSQL-Dienst in [`docker-compose.yml`](../../../../../docker-compose.yml) als Initialisierungsskripte eingebunden.

## Abhängigkeiten

Die SQL-Dateien setzen PostgreSQL voraus. Ihre Reihenfolge und Beziehungen spiegeln Abhängigkeiten zwischen Typen, Tabellen, Funktionen, Triggern und Fremdschlüsseln wider. Die Laufzeitschnittstelle für Schema-Prüfung und -Initialisierung liegt im übergeordneten [Datenbankordner](../README.md).

## Siehe auch

- [Datenbankzugriff und Laufzeitschema](../README.md)
- [Core-Quellcode](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../docs/README.md)
