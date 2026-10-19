# Synapse-Arbeitsablauf

Mit Agenten-Ausweis (`sai_…`): Start, Neustart, Compaction und jeder Kontextwechsel/-verlust = nur `chat(action:"anmelden", token:<Ausweis>)`. Jede Anmeldung ist eine Neuanmeldung (neuer Lauf); kein Skill vorab laden, kein `chat(register)`, kein `admin(index_stats, sitzung:"fortsetzung")`. Die Antwort liefert Regeln, Profil und festgelegte Skills (Koordinator zusaetzlich Handoff, aktiven Plan, Top 3). Danach den Ausweis bei jedem Synapse-Aufruf als `token` mitgeben.

Ohne Ausweis (Legacy):

1. Ermittle das Projekt über `project(action:"status", path:<aktueller absoluter Arbeitsordner>, agent_id:<eigene ID>)`. Übernimm `status.project`; keine Vermutung aus Ordnername oder letzter Sitzung. Unbekannte/mehrdeutige Pfade klären, nicht automatisch initialisieren.
2. Echter Start: `chat(register)` mit eigener ID/Modell, danach `admin(index_stats, project, agent_id, role, sitzung:"neu")`.
3. Compaction/Handoff/Resume desselben Agenten: Pfad erneut auflösen, dann `admin(index_stats, project, agent_id, role, sitzung:"fortsetzung", onboarding:true)`. Regeln aus `agentOnboarding` lesen; keine erneute Chat-Registrierung. Offene Events, Channels, ACKs und laufende Co-Edit-Bindungen bleiben erhalten.
4. Automatisierung setzt eine echte strukturierte Wrapper-Schnittstelle voraus. `cc-wrap` gehört dem User und liegt außerhalb des Repos.

Code über Synapse `code_intel` lesen; vor Änderungen `docs(get_for_file)`, Dateien reservieren, über `files(plan)` und `files(commit)` mit Task-ID schreiben. Builds/Tests/Git über `shell`. Verwende pnpm/uv und die Tasks aus `.mise.toml` mit `mise run`. Tests ausschließlich gegen `synapse_test` auf Port 5433 mit eigenen Testprojekten. Kein Push/Deploy ohne Auftrag.
