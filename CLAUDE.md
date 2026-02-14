# Synapse MCP - Koordinator & Agenten Regeln

## SOFORT BEI SESSION-START (PFLICHT!)

**ERSTER Tool-Call jeder Session** - keine Ausnahmen:

```
mcp__synapse__get_project_status
  project: "<verzeichnisname>"
```

Der **Projektname = Verzeichnisname** (z.B. `~/dev/synapse` → Projekt `synapse`)

---

## Grundprinzip

- **Koordinator** (Hauptagent): Plant, verteilt, sammelt Ergebnisse
- **Subagenten**: Führen aus, speichern Erkenntnisse in Synapse

---

## 1. Koordinator-Anmeldung

Nach `get_project_status` mit einzigartigem Namen anmelden:

```
mcp__synapse__read_memory
  project: "<verzeichnisname>"
  name: "projekt-regeln"
  agent_id: "koordinator-[DATUM]-[UHRZEIT]"
```

**Namensformat:** `koordinator-2026-02-05-1430` (Datum-Uhrzeit)

Die `knownAgents` in der Status-Response zeigen bereits verwendete Namen.

---

## 2. Subagenten-Regeln (PFLICHT)

Jeder Subagent MUSS:
1. Einen **einzigartigen Namen** wählen (kreativ, nie doppelt)
2. Sich **sofort nach Start** bei Synapse anmelden
3. Am Ende seine **Erkenntnisse speichern**

### Namensbeispiele für Subagenten
- `SecureGuard`, `CorsShield`, `TestForge`
- `LoggerLex`, `RateLimiter-Rex`, `AuditFalke`
- Namen müssen einzigartig und beschreibend sein

### Subagent-Prompt Template

```
Du bist ein Entwickler-Agent.
Projektname: {{PROJEKTNAME}}

## 1. SOFORT - Einzigartigen Namen wählen und anmelden:

mcp__synapse__get_project_status
  project: "{{PROJEKTNAME}}"

mcp__synapse__read_memory
  project: "{{PROJEKTNAME}}"
  name: "projekt-regeln"
  agent_id: "DEIN_EINZIGARTIGER_NAME"

## 2. Kontext holen:

mcp__synapse__search_thoughts
  project: "{{PROJEKTNAME}}"
  query: "relevantes thema"

mcp__synapse__semantic_code_search
  project: "{{PROJEKTNAME}}"
  query: "was du suchst"

## 3. Nach der Arbeit - Erkenntnisse speichern:

mcp__synapse__add_thought
  project: "{{PROJEKTNAME}}"
  source: "DEIN_NAME"
  content: "Was du gelernt/geändert hast"
  tags: ["relevante", "tags"]
```

**Hinweis:** Koordinator ersetzt `{{PROJEKTNAME}}` vor dem Spawnen.

---

## 3. Synapse Tools Übersicht

### Projekt-Management
| Tool | Beschreibung |
|------|--------------|
| `init_projekt` | Projekt initialisieren, FileWatcher starten |
| `get_project_status` | Status aus .synapse/status.json |
| `get_project_plan` | Aktuellen Plan abrufen |
| `update_project_plan` | Ziele, Architektur setzen |
| `add_plan_task` | Task zum Plan hinzufügen |

### Code-Suche
| Tool | Beschreibung |
|------|--------------|
| `semantic_code_search` | Semantisch Code finden |
| `search_by_path` | Nach Pfad-Pattern suchen |
| `search_code_with_path` | Kombiniert: Semantisch + Pfad |

### Wissensaustausch
| Tool | Beschreibung |
|------|--------------|
| `add_thought` | Erkenntnis speichern |
| `get_thoughts` | Alle Thoughts abrufen |
| `search_thoughts` | Thoughts durchsuchen |

### Memories (Dokumentation)
| Tool | Beschreibung |
|------|--------------|
| `write_memory` | Memory speichern |
| `read_memory` | Memory lesen (+ Onboarding!) |
| `search_memory` | Memories durchsuchen |
| `delete_memory` | Memory löschen |

---

## 4. Workflow

### Koordinator-Session
```
1. get_project_status → knownAgents prüfen
2. read_memory mit neuem agent_id anmelden
3. get_project_plan → Aktuellen Stand holen
4. Subagenten spawnen ({{PROJEKTNAME}} ersetzen!)
5. Nach Subagent-Arbeit: search_thoughts lesen
```

### Subagent-Session
```
1. get_project_status (Projektname aus Prompt)
2. read_memory mit einzigartigem Namen anmelden
3. search_thoughts / semantic_code_search → Kontext
4. Task ausführen
5. add_thought → Erkenntnisse speichern
```

---

## 5. Wichtige Regeln

1. **ERSTER Tool-Call = get_project_status** - immer!
2. **Namen NIEMALS wiederverwenden** - knownAgents in Status prüfen
3. **Subagenten melden sich SOFORT an** - nicht erst am Ende
4. **Erkenntnisse IMMER speichern** - auch bei Fehlern
5. **Koordinator sammelt** - liest Thoughts nach Agent-Arbeit
