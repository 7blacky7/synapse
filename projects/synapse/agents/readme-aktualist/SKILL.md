---
name: readme-aktualist
model: haiku
expertise: Technische Dokumentation, Developer Experience, Open-Source READMEs
created: 2026-03-25
updated: 2026-03-25
---

# Regeln

- Validierte Kennzahlen (Integration-Tests sub-sub-tester, 2026-03-25): Heartbeat exakt 15s, Unix Socket IPC zuverlässig, Event-System 6/6 ack-Rate, Persistenz session-übergreifend bestätigt. Diese Werte können sicher in der README dokumentiert werden.
- Alle Fakten aus Synapse-Memories + Code verifizieren, NICHT erfinden.
- README Zeilen-Budget: max 800 Zeilen (aktuell 748).
- Synapse Agent-Regeln befolgen: Agent-ID an alle Calls, Onboarding pflicht, Suchreihenfolge code_intel→Semantic→Glob→Read
- MCP-Tools nutzen: code_intel, search, memory, chat, event, specialist, docs, plan, proposal, thought, project, channel, admin, watcher

# Fehler → Lösung

- Glob für README.md NICHT mit Wildcard suchen — gibt node_modules Treffer. Stattdessen Read mit absolutem Pfad: /home/blacky/dev/synapse/README.md
- update_skill schreibt in falsche Sektion wenn "Regel" als "fehler" übergeben wird — Sektion immer explizit prüfen.
- Edit mit falschem exaktem String schlägt fehl → Immer vorher Read mit limit durchführen um exakten String zu sehen
- Keine Worktrees bei Synapse-Projekten nutzen — Branches statt Worktrees

# Patterns

- README-Update-Workflow für Synapse: (1) admin(index_stats) + search(memory) parallel für Architektur-Kontext, (2) Read README.md direkt mit absolutem Pfad, (3) docs(get_for_file) VOR Edits, (4) Surgical edits statt Rewrite, (5) Zeilenzahl unter 800 prüfen, (6) commit-arbeit Skill, (7) channel(post) Zusammenfassung
- Synapse MCP-Tool Score-Cutoff: 0.65+ vertrauen, 0.60-0.65 validieren, <0.60 Fallback zu Glob
- Bugfix-Recherche: Keywords spezifisch (z.B. "token sync session JSONL", "sliding timeout writeAndCollect"), nicht allgemein
- Commit-Pattern: type(scope): kurzbeschreibung mit Author "Moritz Kolar <moritz.kolar@gmail.com>" und konventionellen Types (feat, fix, docs, etc.)
- Surgical Edits: Nur betroffene Abschnitte ändern, nicht ganze Dateien rewrite

## Knowledge Gained (2026-03-25)

- 5 neue Bugfixes im Specialist-System dokumentiert: Sliding Timeout, Token-Sync, Stuck-Detection, Heartbeat Parallel, getPendingEvents Broadcasts
- README-Zeilen-Budget aktuell: 748/800 (93% utilization)
- Specialist Context-Ceiling: Opus/Sonnet 200k Tokens (nicht 400k), Haiku 200k (nicht variable)
- Startup-Verhalten neu dokumentiert: Heartbeat startet sofort (30s MCP-Init delay), Parallel zu Initial Wake, Token-Sync ab Sekunde 1

---

**Session 2026-03-25:** Task "README mit 5 Bugfixes aktualisieren" erfolgreich abgeschlossen.

---

## Auto-Handoff Design-Proposal (2026-03-26)

**Task:** Feature-Design für Auto-Handoff bei 65-75% Context
**Status:** ✅ DESIGN-PROPOSAL ABGESCHLOSSEN (Thought 1f94f65d-e9a9-41dc-8835-e6e4c0b3d4b8)

### Gelernt aus Code-Analyse

**wrapper.ts Heartbeat-Mechanismus:**
- 15s Poll-Interval (POLL_INTERVAL = 15000)
- syncTokensFromHistory() liest Token-Counts aus JSONL: ~/.claude/projects/<project>/<sessionId>.jsonl
- Extrahiert: input_tokens + cache_read_input_tokens + cache_creation_input_tokens (aktueller Context)
- cumulativeOutput: Summe aller output_tokens dieser Session
- getContextPercent() = (total / ceiling) * 100
- CONTEXT_CEILINGS pro Modell: Haiku/Sonnet/Opus haben unterschiedliche Limits
- lastActivityTs, lastEventTs für Stuck-Detection (STUCK_TIMEOUT_MS = 120s)

**process.ts Agent-Lifecycle:**
- ProcessManager: EventEmitter mit Map<agentName, AgentProcess>
- AgentProcess: { agentName, model, proc, sessionId, busy, stdout, messageQueue }
- start(): spawn('claude', [...args]) mit --output-format stream-json
- sendMessage(): Message-Queue wenn busy, sequenziell verarbeitet
- stop(): SIGTERM → 5s Timeout → SIGKILL
- Lifecycle: start → busy loops → exit event

### 3-Stufen Auto-Handoff Architektur

1. **ERKENNUNG (wrapper.ts Heartbeat):**
   - Neuer Threshold HANDOFF_WARN_PERCENT (ENV var, default 70%)
   - broadcastNotification('handoff_warning', {contextPercent, threshold, agentName})
   - handoffInitiated Flag verhindert Doppel-Trigger

2. **SESSION-SAVE (Agent-Prompt):**
   - Agent empfängt handoff_warning Notification
   - thought(add, tags: ["auto-handoff", "session-state"], content: "WAS ANALYSIERT | OFFEN | NÄCHSTER SCHRITT | BRANCH | SESSION-DAUER")
   - specialist(update_skill, section: "patterns", content: "Gelernte Patterns")
   - chat(send, recipient: "koordinator", "AUTO-HANDOFF TRIGGERED bei X%")
   - Agent geht in Idle (keine weiteren Tool-Calls)

3. **NEUSTART (Koordinator):**
   - Empfängt Chat-DM von Agent
   - specialist(stop, name: agent-name)
   - specialist(spawn, name: same, task: "Lade Session-State aus Thought, setze fort")
   - chat(send, broadcast: "✅ Auto-Handoff durchgeführt")

### Implementierungs-Roadmap

- **Phase 1 (Detection + Agent-Save):** 4-6h, 60 LOC (wrapper.ts +35, types.ts +2, prompts +25)
- **Phase 2 (Koordinator-Respawn):** 2-3h, 30 LOC (coordinator +25, skill +5)
- **Phase 3 (Edge-Cases + Hardening):** 2-3h, 40 LOC (stuck-detection integration)
- **GESAMT: 8-12 Stunden**

### Edge Cases analysiert

1. Agent crasht vor Session-Save → Wrapper merkt processAlive=false, kein Auto-Respawn
2. Chat-DM schlägt fehl → Stuck-Detection (120s) → Koordinator-Event
3. Koordinator kann nicht spawnen → Kill mit SIGKILL, Retry
4. Neustart-Agent lädt State falsch → Fallback im Prompt ("arbeite von vorne")
5. Agent im git commit → handoff_warning wird trotzdem gesendet, git status prüfen

### Offene Diskussionsfragen

- Threshold 70%? Oder 65% / 75%?
- Koordinator-Trigger: Loop-Polling oder Event-Signal?
- Session-State Lebenszyklen: wie lange in Qdrant behalten?
- Nested Handoff: Sub-Agent-Handling?

**Neue SKILL-Regeln hinzugefügt:**
- Synapse Agent-Regeln: Onboarding, Suchreihenfolge, MCP-Tool Parameter
- Projekt-Duale Write Limitations dokumentieren
- Event-System Bug: 'acknowledge' → 'ack'
- Embedding-Optimierung: Deutsche -19%, Spezifität, Score-Cutoffs
