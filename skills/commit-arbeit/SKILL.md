---
name: committ-arbeit
description: Commit-Workflow fuer saubere, reviewbare Commits. Konventionelle Commits, logische Aufteilung, Patch-Staging, Sicherheitspruefungen. Verwende diesen Skill IMMER wenn du Aenderungen committen willst.
---

# Commit-Arbeit

Erstelle Commits, die leicht zu ueberpruefen und sicher zu verschicken sind.

## Pflicht-Konfiguration

**Autor fuer JEDEN Commit:**
```
Moritz Kolar <moritz.kolar@gmail.com>>
```

Setze den Autor IMMER explizit:
```bash
git commit --author="Moritz Kolar <moritz.kolar@gmail.com>" ...
```

**Sprache:** Alle Commit-Nachrichten, Kommentare und Ausgaben sind auf Deutsch.

---

## Wann diesen Skill verwenden

- IMMER wenn Aenderungen committed werden sollen
- IMMER wenn der User "commit", "committen", "einchecken" oder aehnliches sagt
- Bei `/committ-arbeit` Aufruf

---

## Commit-Stil: Konventionelle Commits (PFLICHT)

### Format

```
type(scope): Kurzbeschreibung

Hauptteil (was/warum, kein Implementierungstagebuch)

Footer (BREAKING CHANGE bei Bedarf)

```

### Erlaubte Types

| Type | Verwendung |
|------|-----------|
| `feat` | Neue Funktionalitaet |
| `fix` | Bugfix |
| `refactor` | Code-Umstrukturierung ohne Verhaltensaenderung |
| `style` | Formatierung, Whitespace (kein Code-Aenderung) |
| `docs` | Dokumentation |
| `test` | Tests hinzufuegen/aendern |
| `chore` | Build, Dependencies, Tooling |
| `perf` | Performance-Verbesserung |
| `ci` | CI/CD-Aenderungen |
| `revert` | Rueckgaengigmachung |

### Regeln fuer die Kurzbeschreibung (Subject Line)

- **Maximal 72 Zeichen** (harte Grenze)
- Kleinbuchstaben nach dem Doppelpunkt
- Kein Punkt am Ende
- Imperativ verwenden ("aendere", nicht "aendert" oder "geaendert")
- Scope ist empfohlen aber optional (z.B. `feat(auth):`, `fix(api):`)

### Regeln fuer den Hauptteil (Body)

- Beschreibe WAS sich geaendert hat und WARUM
- Kein Implementierungstagebuch
- Leerzeile zwischen Subject und Body
- Zeilenumbruch bei 80 Zeichen

---

## Arbeitsablauf (Checkliste)

### Schritt 1: Arbeitsbaum inspizieren

```bash
git status
git diff
git diff --stat
```

Analysiere:
- Welche Dateien wurden geaendert?
- Welche Dateien sind neu (untracked)?
- Gibt es gestaged vs. ungestaged Aenderungen?

### Schritt 2: Logische Grenzen festlegen

Pruefe ob die Aenderungen aufgeteilt werden muessen. Trenne nach:

| Trennung | Beispiel |
|----------|---------|
| Feature vs. Refaktor | Neue Funktion ≠ Code-Aufraeumaktion |
| Backend vs. Frontend | API-Aenderung ≠ UI-Aenderung |
| Formatierung vs. Logik | Whitespace-Fixes ≠ Bugfix |
| Tests vs. Produktionscode | Testdatei ≠ Quelldatei |
| Dependency-Updates vs. Verhalten | package.json bump ≠ Feature |

**Faustregel:** Wenn es nicht verwandte Aenderungen gibt → mehrere kleine Commits.

Wenn Aenderungen INNERHALB einer Datei gemischt sind → Patch-Staging planen (Schritt 3).

### Schritt 3: Gezielt stagen

**Fuer saubere Aenderungen (ganze Dateien):**
```bash
git add <datei1> <datei2>
```

**Fuer gemischte Aenderungen (Patch-Staging):**
```bash
git add -p <datei>
```

**NIEMALS `git add .` oder `git add -A` verwenden!**
Immer gezielt einzelne Dateien oder Patches stagen.

**Fehler beim Stagen korrigieren:**
```bash
git restore --staged <pfad>
git restore --staged -p <pfad>
```

### Schritt 4: Gestagtes ueberpruefen

```bash
git diff --cached
```

**Vernunftspruefungen (PFLICHT):**

- [ ] Keine Geheimnisse (.env, Credentials, API-Keys, Tokens)
- [ ] Kein versehentliches Debug-Logging (console.log, print, fmt.Println zum Debuggen)
- [ ] Kein unabhaengiges Formatierungschurn (nur Whitespace-Aenderungen die nicht zum Commit gehoeren)
- [ ] Keine temporaeren Dateien (.tmp, .bak, .swp)
- [ ] Keine Build-Artefakte (dist/, build/, node_modules/)

Wenn eine dieser Pruefungen fehlschlaegt: Zurueck zu Schritt 3 und bereinigen.

### Schritt 5: Aenderung beschreiben (Vor dem Commit)

Beschreibe die gestagten Aenderungen in 1-2 Saetzen:
- **Was** hat sich geaendert?
- **Warum** wurde die Aenderung gemacht?

**Wenn du es nicht klar beschreiben kannst:** Das Commit ist zu gross oder zu gemischt → zurueck zu Schritt 2.

### Schritt 6: Commit erstellen

```bash
git commit --author="Moritz Kolar <moritz.kolar@gmail.com>>" -m "$(cat <<'EOF'
type(scope): kurzbeschreibung

Hauptteil: Was und warum.
EOF
)"
```

**Wichtig:**
- IMMER `--author="Moritz Kolar <moritz.kolar@gmail.com>>"` setzen
- IMMER HEREDOC fuer mehrzeilige Nachrichten verwenden
- NIEMALS `--no-verify` verwenden
- NIEMALS `--amend` verwenden (ausser explizit angefragt)

### Schritt 7: Kleinste relevante Verifikation

Fuehre die schnellste sinnvolle Pruefung durch BEVOR du weitermachst:

| Projekttyp | Pruefung |
|------------|---------|
| Node/TS | `npm run lint` oder `npm test` |
| Python | `pytest` oder `ruff check` |
| Go | `go vet ./...` oder `go test ./...` |
| Allgemein | `git log --oneline -3` zur Kontrolle |

Wenn die Pruefung fehlschlaegt:
1. Problem beheben
2. Neuen Commit erstellen (NICHT amend!)
3. Weiter mit naechstem Commit

### Schritt 8: Wiederholen

Wiederhole Schritte 1-7 fuer den naechsten Commit, bis der Arbeitsbaum sauber ist.

---

## Ausgabe (PFLICHT nach jedem Commit-Vorgang)

Nach Abschluss IMMER bereitstellen:

### A) Commit-Uebersicht

```
## Commits erstellt

| # | Hash (kurz) | Nachricht | Dateien |
|---|-------------|-----------|---------|
| 1 | abc1234 | feat(auth): login-formular hinzufuegen | 3 |
| 2 | def5678 | test(auth): login-tests ergaenzen | 2 |
```

### B) Zusammenfassung pro Commit

Fuer jeden Commit:
- **Was:** Kurze Beschreibung der Aenderung
- **Warum:** Grund/Motivation

### C) Verwendete Befehle

Mindestens:
```
git diff --cached   (vor jedem Commit)
git status          (Arbeitsbaum-Inspektion)
```
Plus alle durchgefuehrten Tests/Lints.

---

## Sonderfaelle

### Pre-Commit Hook schlaegt fehl

1. Problem analysieren und beheben
2. Aenderungen erneut stagen
3. **NEUEN Commit erstellen** (niemals `--amend`, da der vorherige Commit NICHT existiert)

### Merge-Konflikte

1. Konflikte untersuchen (nicht blind ueberschreiben)
2. Sinnvoll aufloesen
3. Normalen Commit-Workflow fortsetzen

### Leerer Arbeitsbaum

Wenn keine Aenderungen vorhanden: Keinen leeren Commit erstellen. Dem User mitteilen.

### Sensible Dateien entdeckt

Wenn `.env`, Credentials oder aehnliches entdeckt wird:
1. **SOFORT warnen** (nicht committen!)
2. Aus Staging entfernen
3. Pruefen ob `.gitignore` aktualisiert werden muss

---

## Verbote (NIEMALS)

- `git add .` oder `git add -A`
- `git commit --no-verify`
- `git commit --amend` (ausser explizit angefragt)
- `git push --force` (ausser explizit angefragt)
- `git reset --hard`
- `git checkout .` oder `git restore .`
- Commits ohne `--author` Flag
- Englische Commit-Nachrichten
- Subject-Lines ueber 72 Zeichen
- `git add -i` (interaktiv, nicht unterstuetzt)
- `git rebase -i` (interaktiv, nicht unterstuetzt)

---

## Schnellreferenz

```
# 1. Inspizieren
git status && git diff --stat

# 2. Gezielt stagen
git add <dateien>          # Ganze Dateien
git add -p <datei>         # Patch-Staging

# 3. Pruefen
git diff --cached

# 4. Committen
git commit --author="Moritz Kolar <moritz.kolar@gmail.com>>" -m "$(cat <<'EOF'
type(scope): beschreibung

Was und warum.
EOF
)"

# 5. Verifizieren
git log --oneline -3
```
