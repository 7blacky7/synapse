---
name: projekt-status
description: Zeigt alle gespeicherten Projekt-Informationen (Regeln, Architektur, Beschreibung). Aktiviere bei "projekt status", "projekt infos", "was weiss synapse ueber das projekt".
---

# Projekt-Status Uebersicht

## Ablauf

1. Alle Memories laden:
   - list_memories(project: "<aktuelles-projekt>")

2. Formatierte Uebersicht anzeigen:

   ### Projekt-Beschreibung
   - projekt-beschreibung (documentation)

   ### Regeln
   - projekt-regeln (rules)
   - commit-konventionen (rules)
   - agenten-regeln (rules)
   - verfuegbare-skills (rules, coordinator-only)

   ### Architektur
   - architektur-uebersicht (architecture)
   - design-entscheidungen (decision)

   Fuer jede Memory: Name, Kategorie, Inhalt (gekuerzt auf 200 Zeichen)

3. Hinweise anzeigen:
   - "Nutze /projekt-setup um den Setup-Wizard nochmal zu starten"
   - "Nutze /projekt-regeln um Coding-Standards zu aendern"
   - "Nutze /projekt-architektur um die Architektur zu bearbeiten"

## Hinweise
- <aktuelles-projekt> = das Projekt das gerade in Synapse aktiv ist (aus get_project_status oder Kontext)
- Nicht vorhandene Memories als "Noch nicht erfasst" markieren
