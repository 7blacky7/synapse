---
name: projekt-regeln
description: Coding-Standards und Commit-Konventionen fuer das Synapse-Projekt anzeigen und aendern. Aktiviere bei "projekt regeln", "coding standards", "commit konventionen aendern".
---

# Projekt-Regeln bearbeiten

## Ablauf

1. Aktuelle Regeln laden:
   - read_memory(project: "<aktuelles-projekt>", name: "projekt-regeln")
   - read_memory(project: "<aktuelles-projekt>", name: "commit-konventionen")

2. Aktuelle Werte dem User anzeigen

3. User fragen was geaendert werden soll:
   - Coding-Standards anpassen?
   - Commit-Konventionen anpassen?

4. Geaenderte Werte speichern:
   → write_memory(project, name: "projekt-regeln", category: "rules", content: <neuer Wert>, tags: ["setup"])
   → write_memory(project, name: "commit-konventionen", category: "rules", content: <neuer Wert>, tags: ["setup"])

5. Bestaetigung anzeigen

## Hinweise
- <aktuelles-projekt> = das Projekt das gerade in Synapse aktiv ist (aus get_project_status oder Kontext)
- Nur geaenderte Memories ueberschreiben, unveraenderte nicht anfassen
