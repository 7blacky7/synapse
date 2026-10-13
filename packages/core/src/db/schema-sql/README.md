# Datenbank-Schema als SQL

Diese nummerierten SQL-Dateien sind der Kaltstart-Spiegel des Synapse-Schemas. Die aktuelle Laufzeitdefinition steht in [`schema.ts`](../schema.ts); historische Exportzählungen beschreiben den heutigen Stand nicht zuverlässig.

## Laufzeit und Kaltstart

Die API initialisiert das Schema beim Start über `initSynapse(..., { schema: 'ausfuehren' })`. MCP-stdio und Wrapper prüfen standardmäßig den Stand über `schema_stand`. `SYNAPSE_SCHEMA` erlaubt `ausfuehren`, `pruefen` und `aus`; bei einer leeren DB kann der Prüfweg einmal initialisieren. **API zuerst** starten/aktualisieren.

Die SQL-Spiegelung wird von der Laufzeitinitialisierung nicht automatisch aktualisiert. Nach Schemaänderungen müssen beide Wege zusammen gepflegt und separat geprüft werden. Ein erfolgreiches inkrementelles Laufzeit-DDL beweist nicht den Aufbau aller Exportdateien auf einer leeren Datenbank.

## Aufbaureihenfolge

Dateien alphabetisch ausführen. Extensions/Typen kommen zuerst, Funktionen vor Triggern und Fremdschlüssel nach ihren Tabellen.

| Bereich | Dateien |
|---|---|
| Grundlagen | `00_extensions_types.sql`, `05_funktionen.sql` |
| Projekte/Wissen/Code | `10_projekte.sql`, `20_wissen.sql`, `30_code_intelligence.sql` |
| Agenten/Modelle | `40_agenten.sql`, `45_modelle_embedding.sql`, `47_modell_pool.sql` |
| Dateien/Shell | `50_dateien.sql`, `60_shell.sql` |
| Auth/Skills/Audit | `70_auth.sql`, `80_skills.sql`, `85_audit.sql` |
| Trigger/Assets/Fremdschlüssel | `90_trigger.sql`, `95_asset_intel.sql`, `95_foreign_keys.sql` |

Einzelne Ergänzungen sind von Hand gepflegt und können Fremdschlüssel inline enthalten. Die Nummerierung und tatsächlichen Abhängigkeiten sind maßgeblich.

## Neue Installation

[Compose](../../../../../docker-compose.yml) bietet `--profile bundled`: PostgreSQL legt Rolle und Datenbank aus `POSTGRES_*` an und lädt diesen Ordner als `/docker-entrypoint-initdb.d`. Das geschieht nur beim ersten Start mit leerem Datenverzeichnis. Zugangsdaten müssen zur API-`DATABASE_URL` passen.

Bei manuell bereitgestellter Datenbank zuerst Rolle, Rechte und leere Datenbank einrichten. Anschließend mit einem dafür autorisierten Betreiberzugang:

```bash
for f in packages/core/src/db/schema-sql/*.sql; do
  psql -v ON_ERROR_STOP=1 -d synapse -f "$f"
done
```

Der Aufruf setzt einen passenden PostgreSQL-Verbindungskontext voraus. `ON_ERROR_STOP=1` verhindert, dass nach einem Fehler unbemerkt weitergearbeitet wird. Die Exportdateien sind kein allgemeiner Wiederholungs-Migrationsweg für bestehende Datenbanken.

## Grenzen und Prüfung

- Dieser Ordner ist Struktur, kein Backup und keine Wiederherstellung von Nutzerdaten.
- Rollen, Rechte, reale Passwörter und Qdrant-Vektoren werden damit nicht eingerichtet.
- Modellprofile, Rollen-Templates und andere benötigte Stammdaten haben eigene Initialisierungswege.
- Ein historischer `pg_dump` oder alte Objektzahlen sind keine aktuelle Abnahme des Schema-Spiegels.
- Änderungen auf einer leeren Test-DB und gegen einen passenden Bestandsstand prüfen; keine Produktions-Probe durch Testskripte.

Datenbanktests laufen ausschließlich in `synapse_test` auf Port 5433, mit isoliertem eigenem Projekt/Schema. Die [Root-README](../../../../../README.md#tests) beschreibt den Testweg. Eine neue Gesamtprobe wurde durch diese Dokumentationsänderung nicht ausgeführt.

## Pflege

`schema.ts` ist der Laufzeitweg. Zugehörige SQL-Dateien bei Änderungen mitpflegen, Abhängigkeiten prüfen und den Kaltstart separat testen. Ein autorisierter Schema-Export kann die Pflege unterstützen:

```bash
pg_dump --schema-only --no-owner --no-privileges -h <host> -U <user> -d <database> -f schema.sql
```

Keine fremden Projektobjekte oder Zugangsdaten in den Synapse-Spiegel übernehmen. Exportierte Sequenz-Startwerte ersetzen keinen Datenbestand.
