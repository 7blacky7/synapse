# Datenbank-Schema als SQL

Struktur-Abzug der Synapse-Datenbank: **nur Struktur, keine Daten**.
Es steht kein einziges `INSERT` in diesen Dateien.

Zweck: Das Repo klonen und die Datenbank von null aufbauen koennen, ohne Zugriff
auf eine laufende Instanz.

## Verhaeltnis zu `schema.ts` — bitte zuerst lesen

`packages/core/src/db/schema.ts` ist der **ausgefuehrte Weg**: `ensureSchema()`
laesst beim Start ein idempotentes DDL-Skript laufen (`CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Im laufenden Betrieb entsteht das
Schema dort und nur dort.

Die Dateien in diesem Ordner sind die **SQL-Spiegelung** davon, erzeugt mit
`pg_dump` aus der laufenden Datenbank. Sie werden nicht automatisch ausgefuehrt.

> **Achtung, das ist die Stelle, an der etwas stillschweigend auseinanderlaeuft:**
> Wer `schema.ts` aendert, aendert die Datenbank — aber nicht diesen Ordner.
> Der Export wird dadurch veraltet, ohne dass irgendetwas fehlschlaegt.
> Nach Schema-Aenderungen also neu exportieren (Kommando unten).

## Aufbaureihenfolge

Die Zahlen im Dateinamen **sind** die Reihenfolge. Alphabetisch sortiert ergibt
sich genau die richtige Abfolge:

| Datei | Inhalt |
|---|---|
| `00_extensions_types.sql` | Extensions (pg_trgm, pgcrypto), 4 ENUM-Typen |
| `05_funktionen.sql` | 11 PL/pgSQL-Funktionen |
| `10_projekte.sql` | Projekte, Workspaces, Workspace-Rollen, Ignore-Regeln |
| `20_wissen.sql` | Memories, Gedanken, Plaene, Vorschlaege, Tech-Docs |
| `30_code_intelligence.sql` | Code-Index: Dateien, Symbole, Referenzen, Chunks, Statements, Call-Kanten, Parser-Status |
| `40_agenten.sql` | Agenten-Sessions, Events, Onboardings, Spezialisten-Channels, Wrapper-Status |
| `45_modelle_embedding.sql` | Modell-Registry, Embedding-Knoten (Ollama/GPU-Lastverteilung) |
| `50_dateien.sql` | Datei-Versionierung, Batch-Plaene, Watcher, Daemon-Heartbeats |
| `60_shell.sql` | Shell-Job-Queue |
| `70_auth.sql` | Tokens, TOTP, OAuth-Clients, Provider-Credentials |
| `80_skills.sql` | Skills und Skill-Hook-Telemetrie |
| `85_audit.sql` | Audit-Trail (`tool_calls`) und Fehlermuster |
| `90_trigger.sql` | 11 Trigger |
| `95_foreign_keys.sql` | alle 19 Fremdschluessel |

**Warum diese Aufteilung funktioniert:** Fremdschluessel stehen NICHT inline in den
`CREATE TABLE`, sondern gesammelt in `95_foreign_keys.sql`. Dadurch ist die
Reihenfolge der Sachgebiets-Dateien (10 bis 85) untereinander beliebig — nur
drei Dinge sind zwingend: Extensions und Typen zuerst, Funktionen vor den
Triggern, Fremdschluessel zuletzt. Genau dafuer stehen die Nummern 00/05 und 90/95.

## Umfang

Ausgezaehlt aus den Dateien dieses Ordners:

```text
49 Tabellen          49 Primaerschluessel      19 Fremdschluessel
91 CREATE INDEX       5 UNIQUE-Constraints     12 CHECK-Constraints
15 Sequences          4 ENUM-Typen              2 Extensions
11 Funktionen        11 Trigger                 0 Views
```

Die 91 sind die ausdruecklichen `CREATE INDEX`; PostgreSQL legt zusaetzlich je
einen Index pro Primaerschluessel und UNIQUE-Constraint an, im Katalog stehen
danach also mehr.

## Aufbauen

```bash
createdb synapse
for f in packages/core/src/db/schema-sql/*.sql; do
  psql -v ON_ERROR_STOP=1 -d synapse -f "$f"
done
```

`ON_ERROR_STOP=1` ist wichtig: ohne das laeuft psql nach einem Fehler weiter und
hinterlaesst eine halb aufgebaute Datenbank, die auf den ersten Blick in Ordnung
aussieht.

## ⚠️ Pruefstatus — was gemessen ist und was nicht

Hier stehen zwei verschiedene Aussagen, und sie duerfen nicht vermischt werden.

**Der urspruengliche Vollabzug WURDE geprueft (02.08.2026).** Er wurde gegen eine
leere PostgreSQL-16-Instanz aufgebaut und das Ergebnis mit der Quelldatenbank
verglichen: `pg_dump` gegen `pg_dump` ergab keinen einzigen Unterschied
(2221 zu 2221 Zeilen), und 54 Tabellen, 540 Spalten, 157 Katalog-Indizes,
19 Fremdschluessel, 12 Trigger und 16 Sequences stimmten auf beiden Seiten
ueberein, Indizes und Constraints auch namentlich.

**Die Fassung, die hier liegt, ist NICHT geprueft.** Sie ist aus diesem Vollabzug
entstanden, indem 25 Bloecke mit Fremdobjekten entfernt wurden (siehe naechster
Abschnitt). Dieser gekuerzte Stand wurde **nicht** gegen eine Datenbank
aufgebaut — Probelaeufe gegen Datenbanken sind seit dem 02.08.2026 auf Anweisung
untersagt. Der Aufbau ist damit **abgeleitet, nicht bewiesen**.

**Was am gekuerzten Stand geprueft wurde, ist eine rein statische Kontrolle** — sie
faengt genau die Fehlerart, die beim Entfernen von Bloecken entsteht, naemlich einen
Verweis, dessen Ziel weg ist:

- alle Dollar-Quotings paarweise geschlossen (kein abgeschnittener Funktionsrumpf)
- jede Datei endet auf einem abgeschlossenen Statement
- jeder der 19 Fremdschluessel findet Quell- UND Zieltabelle im Export
- jeder der 11 Trigger findet seine Tabelle UND seine Funktion
- jeder Index findet seine Tabelle, jedes `nextval`-DEFAULT seine Sequence,
  jeder ENUM-Verweis seinen Typ

Ergebnis: kein haengender Verweis. Das ist ein sinnvoller Filter, aber es ist
Textpruefung, kein PostgreSQL. Syntaxfehler, Typkonflikte oder
Reihenfolgeprobleme, die erst der Server bemerkt, kann sie nicht sehen.

### So schliesst man die Luecke, wenn ein Probelauf erlaubt ist

Es braucht keine Datenbank des Betriebs — eine wegwerfbare Instanz genuegt, und
danach ist nichts uebrig:

```bash
docker run -d --name schema-probe -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=probe postgres:16
docker cp packages/core/src/db/schema-sql schema-probe:/sql
docker exec schema-probe sh -c 'set -e; for f in /sql/*.sql; do psql -U postgres -d probe -q -v ON_ERROR_STOP=1 -f "$f"; done'
docker rm -f schema-probe
```

Laeuft das ohne Fehler durch, ist der Aufbau bewiesen statt abgeleitet. Wer
zusaetzlich gegen die laufende Datenbank abgleichen will, macht von beiden ein
`pg_dump --schema-only --no-owner --no-privileges` und vergleicht die Ausgaben —
die Differenz muss dann genau die im naechsten Abschnitt genannten Fremdobjekte
sein und sonst nichts. Das ist die schaerfste Probe: sie zeigt auch
Abweichungen, die keine Zaehlung bemerkt.

## Absichtlich NICHT enthalten: Fremdobjekte aus der Produktions-Datenbank

In der laufenden Datenbank stehen Objekte, die **nicht zu Synapse gehoeren**. Sie
wurden aus diesem Export entfernt, damit eine frische Installation sie nicht
uebernimmt. Wer den Bestand mit diesen Dateien vergleicht, findet in der
Datenbank also mehr als hier — das ist Absicht, kein Fehler im Export.

| Entferntes Objekt | Herkunft (ermittelt 02.08.2026) |
|---|---|
| Tabellen `agent_profiles`, `agents`, `cli_agents`, `swarm_events` samt Constraints und Indizes | aus einem Antigravity-Integrationsversuch vom 25.05.2026; im Repo existiert dazu kein Code |
| Funktion `notify_swarm_event()` und Trigger `trigger_swarm_event_inserted` | gehoeren zu `swarm_events` |
| Schema `drizzle` mit `__drizzle_migrations` | eine Migration des FREMDEN Projekts `ai-tools-directory` vom 04.05.2026, die versehentlich gegen diese Datenbank lief |
| Extension `citext` | keine einzige Spalte in der Datenbank nutzt diesen Typ |

Kein Synapse-Code liest oder schreibt diese Objekte, und keiner der 19
Fremdschluessel beruehrt sie. Ob sie auch in der Produktionsdatenbank entfernt
werden, ist eine Entscheidung des Betreibers und hier NICHT getroffen.

## Was hier sonst NICHT drin ist

- **Keine Daten.** Auch keine Stammdaten: `model_registry`, `workspace_roles` und
  `project_ignore_rules` starten leer. Wer Vorgaben braucht, muss sie separat
  einspielen.
- **Keine Rollen, Rechte oder Passwoerter** (`--no-owner --no-privileges`).
  Wie Datenbank und Rolle `synapse` ueberhaupt entstehen, sagt das Repo an keiner
  Stelle — das ist eine offene Luecke, die diese Dateien nicht schliessen.
- **Keine Qdrant-Collections.** Die Vektoren liegen ausserhalb von PostgreSQL;
  in der Datenbank ist keine `vector`-Extension installiert.
- **Keine Sequence-Staende.** Alle Sequences starten bei 1 — richtig fuer eine
  leere Datenbank, aber es ist kein Backup.

Dieser Export ersetzt kein Backup. Er baut eine leere Datenbank auf, mehr nicht.

## Neu erzeugen nach Schema-Aenderungen

```bash
pg_dump --schema-only --no-owner --no-privileges -h <host> -U <user> -d synapse -f schema.sql
```

Danach die Bloecke auf die Sachgebiets-Dateien verteilen und die oben genannten
Fremdobjekte wieder aussortieren. Zwei Fallstricke, die beim Erstellen dieses
Exports real aufgetreten sind:

1. Neuere `pg_dump`-Versionen klammern die Ausgabe in die psql-Metabefehle
   `\restrict` / `\unrestrict`. Beim Zerlegen landet das schliessende
   `\unrestrict` ohne sein Gegenstueck in der letzten Datei und bricht dort mit
   `not currently in restricted mode` ab. Beide Zeilen ersatzlos entfernen.
2. Die Client-Version sollte zur Server-Version passen (hier: PostgreSQL 16).
   Gibt es lokal kein `pg_dump`, geht es ueber Docker:
   `docker run --rm -e PGPASSWORD=... postgres:16 pg_dump -h <host> -U <user> ...`
