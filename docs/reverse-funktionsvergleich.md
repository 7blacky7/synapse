# S3-Funktionsvergleich (P18-T75)

`reverse(action:"vergleichen", reverse_id, datei_a, datei_b)` vergleicht zwei Originalpfade desselben gebundenen Reverse-Eintrags. Kein neues Tool, kein neuer Index, keine Ausführung der Originale. REST und MCP verwenden dieselbe Reverse-Definition.

## Voraussetzungen und Schalter

- Projektberechtigung und Reverse-Bindung werden vor dem Lesen geprüft.
- Produkt-Schalter `reverse_s3` gilt auch für den Vergleich, Standard AUS. Verwaltung bleibt über vorhandene admin-/Web-UI-Funktionen.
- Befristeter Debug-Override: `intern(schalter_setzen, name:"reverse_vergleichen", modus:"freigegeben", aktiv:true|false, dauer_min:...)`. Wirkt nur bei aktivem intern-Tool und zukünftigem Ablaufdatum. Ohne intern, nach Ablauf oder Lesefehler gilt der Produktwert.
- Die Antwort enthält `schalter` mit wirksamem Wert, Quelle, Ablauf und letztem Lesefehler. AUS liefert `werkzeug_fehler / reverse_s3_aus`.
- Beide Dateien brauchen eine aktuelle fertige oder teilweise S3-Schicht. Fehlende Schichten werden über den vorhandenen Analyseweg angefordert; Antwort `schicht_nicht_fertig` mit `auftraege`.
- Nur Symbole und Code mit übereinstimmender Datei, Schicht und aktuellem Fingerabdruck werden gelesen. Zeilenfenster werden in PG aus den Code-Dateien gewonnen; große Dekompilate werden nicht pro Funktion vollständig übertragen.

## Zuordnung und Grenzen

Eindeutige Merkmale in dieser Reihenfolge: echter Name + normalisierter C-Hash, Adresse + C-Hash, echter Symbolname, C-Hash, Adresse, Tokenstruktur, Größe. Jede Runde arbeitet auf dem noch unzugeordneten Rest, jedes Symbol gehört höchstens einem Paar an. Mehrdeutige Gruppen werden nicht willkürlich gepaart.

Normalisierung entfernt Kommentare und Formatierung, neutralisiert den eigenen Funktionsnamen und adressbasierte FUN_/SUB_/DAT_/LAB_/PTR_/UNK_-Bezeichner. Strings, numerische Konstanten und Operatoren bleiben erhalten. Für schwache Kandidaten gibt es zusätzlich eine Tokenstruktur ohne Bezeichner und Zahlen; diese ist ausdrücklich kein Gleichheitsbeleg.

`sicherheit` ist `hoch`, `mittel` oder `unsicher`, dazu kommt ein maschinenlesbarer `grund`. Kein Wert beweist semantische Gleichheit. Fehlendes Dekompilat ergibt `nicht_vergleichbar`, keinen erfundenen gleichen Hash. Nicht eindeutig zugeordnete Funktionen erscheinen als `nicht_zugeordnet`, immer unsicher mit entsprechendem Grund. `nur_in:"a"|"b"` bezeichnet die Seite ohne eindeutiges Gegenstück, keine bewiesene Hinzufügung/Entfernung. Bei zugeordneten Paaren ist `nur_in:null`.

Die Übersicht enthält nur Unterschiede (`geaendert`, `verschoben`, `umbenannt`, `nicht_zugeordnet`, ggf. `nicht_vergleichbar`/`zuordnung_unsicher`). Kombinationen sind möglich. `gleich` zählt Paare ohne sichtbare Unterschiede nach Normalisierung.

Bei teilweise fertigen Schichten, fehlendem Dekompilat, unvollständiger Symbolmenge oder `packer_verdacht` ist das Ergebnis `status:"teilweise"`. `schichten`, `merkmale` und `umfang` zeigen die Datenlage.

## Paging und Diff

- `limit`, `offset`: stabile Sortierung nach Symbol-ID, `total`, `gekappt`, `naechster_offset`. Unveränderter Datenstand ist Voraussetzung für stabile Folgeseiten.
- `funktion`: eine Symbol-ID aus `unterschiede[].funktion` (auch die ID der Gegenseite wird akzeptiert). Liefert `paar` und `diff`.
- Der Rohtext-Diff ist ein Ersetzungsblock nach Abzug gleicher Anfangs-/Endzeilen, kein minimaler Edit-Diff. Jeder Eintrag enthält `art` (+/-), die Zeilennummer innerhalb der Funktion und `text`.
- `from_line`/`to_line` paginieren die Diff-Liste (1-basiert, inklusive). `naechste_zeile` setzt fort.
- Vorhandene Reverse-Limits und Antwortbudget gelten. Ein einzelner nicht ausgebbarer Eintrag ergibt `zu_gross` statt einer endlosen leeren Folgeseite.
- Zieltext wird maskiert und als `provenance.untrusted_content` gekennzeichnet.

## Abnahme

Fixture-Tests ausschließlich in einem eigenen Schema/Projekt von `synapse_test:5433`: identisch, geändert, verschoben/umbenannt, unbekannte Namen mit geändertem Dekompilat, mehrdeutige Kandidaten, fehlendes Dekompilat, Paging/Diff, veralteter Fingerabdruck, Bindungsprüfung, fehlendes S3 und Schalter-Rückfälle.

Siedler-Abnahme: `s3.exe` gegen `s3.ex_`; vorhandene Analyseergebnisse dürfen als Testexport verwendet werden. Originale bleiben unverändert. Ohne fertige S3-Ergebnisse darf kein erfolgreicher Vergleich behauptet werden.
