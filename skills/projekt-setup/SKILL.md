---
name: projekt-setup
description: Startet den Synapse Projekt-Setup Wizard. Erfasst Projektbeschreibung, Coding-Standards, Commit-Konventionen und Skills. Aktiviere bei "projekt setup", "projekt einrichten", "setup wizard".
---

# Projekt-Setup Wizard

## Ablauf

1. Aktuelle Setup-Memories laden:
   - list_memories(project: "<aktuelles-projekt>", category: "rules")
   - list_memories(project: "<aktuelles-projekt>", category: "documentation")
   Wenn Memories mit Tag "setup" existieren → als Defaults anzeigen

2. Technologien erkennen:
   - detect_technologies(path: "<projekt-pfad>")

3. README lesen wenn vorhanden (erste 500 Zeichen als Kontext)

4. User befragen (mit Vorschlaegen aus Tech-Detection + README + bestehenden Memories):

   **Frage 1: Projektzweck**
   → write_memory(project, name: "projekt-beschreibung", category: "documentation", content: <Antwort>, tags: ["setup"])

   **Frage 2: Coding-Standards** (Vorausgefuellt aus erkannten Technologien)
   → write_memory(project, name: "projekt-regeln", category: "rules", content: <Antwort>, tags: ["setup"])

   **Frage 3: Commit-Konventionen** (Sprache, Format, Autor)
   → write_memory(project, name: "commit-konventionen", category: "rules", content: <Antwort>, tags: ["setup"])

   **Frage 4: Relevante Skills/Frameworks** (Was sollen Agenten koennen?)
   → write_memory(project, name: "verfuegbare-skills", category: "rules", content: <Antwort>, tags: ["setup", "coordinator-only"])

5. Abschluss:
   - Zusammenfassung aller gespeicherten Werte anzeigen
   - Hinweis: "Nutze /projekt-regeln um Standards spaeter zu aendern"
   - Hinweis: "Nutze /projekt-architektur um die Architektur zu dokumentieren"

## Hinweise
- Alle Fragen sind optional — User kann mit "ok", "passt", "weiter" ueberspringen
- Bei bestehenden Werten als Default vorschlagen
- Fragen einzeln stellen, nicht alle auf einmal
- Alle 4 Fragen auf einmal anzeigen mit aktuellen Werten, User sagt welche er aendern will
- <aktuelles-projekt> = das Projekt das gerade in Synapse aktiv ist (aus get_project_status oder Kontext)
