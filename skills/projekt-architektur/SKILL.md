---
name: projekt-architektur
description: Architektur-Uebersicht und Design-Entscheidungen fuer das Synapse-Projekt anzeigen und bearbeiten. Aktiviere bei "projekt architektur", "architektur uebersicht", "design entscheidungen".
---

# Projekt-Architektur bearbeiten

## Ablauf

1. Aktuelle Architektur-Infos laden:
   - read_memory(project: "<aktuelles-projekt>", name: "architektur-uebersicht")
   - read_memory(project: "<aktuelles-projekt>", name: "design-entscheidungen")

2. Aktuelle Werte dem User anzeigen (oder "Noch nicht erfasst")

3. User befragen:
   - Architektur-Uebersicht beschreiben/anpassen?
   - Design-Entscheidungen dokumentieren/anpassen?

4. Geaenderte Werte speichern:
   → write_memory(project, name: "architektur-uebersicht", category: "architecture", content: <Wert>, tags: ["setup"])
   → write_memory(project, name: "design-entscheidungen", category: "decision", content: <Wert>, tags: ["setup"])

5. Bestaetigung anzeigen

## Hinweise
- <aktuelles-projekt> = das Projekt das gerade in Synapse aktiv ist (aus get_project_status oder Kontext)
- Nur geaenderte Memories ueberschreiben, unveraenderte nicht anfassen
