#!/usr/bin/env bash
# context-handoff.sh — Beendet aktuelle Claude-Session und startet neue mit Synapse-Kontext
#
# ##############################################################################
# ##  ⚠️  NUR MIT DEM EIGENEN BASH-TOOL AUSFUEHREN  ⚠️                        ##
# ##                                                                          ##
# ##  NIEMALS ueber shell(action:"exec") der Synapse-API oder des lokalen     ##
# ##  MCP-Servers starten. DER DESKTOP DES USERS STUERZT DABEI AB.            ##
# ##                                                                          ##
# ##  Grund: Das Skript sucht den Claude-Prozess ueber die Prozesskette und   ##
# ##  beendet ihn. Ueber die Synapse-Shell ausgefuehrt haengt es an einer     ##
# ##  anderen Elternkette (Daemon bzw. Container) — der Kill trifft dann      ##
# ##  nicht die Claude-Session, sondern reisst die Desktop-Sitzung mit.       ##
# ##                                                                          ##
# ##  RICHTIG:  Bash-Tool -> bash ~/.claude/skills/.../context-handoff.sh ... ##
# ##  FALSCH:   shell(exec, command: "bash .../context-handoff.sh ...")       ##
# ##############################################################################
#
# Verwendung (vom Koordinator aufgerufen NACHDEM Synapse gespeichert wurde):
#   bash ~/.claude/skills/synapse-nutzung/scripts/context-handoff.sh \
#     <projekt-verzeichnis> <projekt-name> <aufgabe>
#
# VORAUSSETZUNG: Claude wurde mit claude-session.sh gestartet (Wrapper)!
# Der Wrapper erkennt den Handoff-Marker und startet die neue Session automatisch.
#
# CLI-Flags (z.B. --dangerously-skip-permissions) werden automatisch vom
# laufenden Claude-Prozess uebernommen und an die neue Session weitergegeben.

set -euo pipefail

PROJECT_DIR="${1:?Fehler: Projekt-Verzeichnis als 1. Argument noetig}"
PROJEKT_NAME="${2:?Fehler: Projekt-Name als 2. Argument noetig}"
AUFGABE="${3:-Setze die Arbeit fort}"
AGENT_ID="${4:-koordinator}"

# Agent-ID muss Koordinator-Pattern erfuellen (siehe onboarding.ts):
# - exakt "koordinator" ODER
# - beginnt mit "koordinator-"
# Sonst wird die neue Session als "subagent" eingestuft und bekommt nicht die
# coordinator-only Regeln. Bei Verstoss: Fallback auf "koordinator".
if [ "$AGENT_ID" != "koordinator" ] && [[ "$AGENT_ID" != koordinator-* ]]; then
  echo "WARNUNG: Agent-ID '$AGENT_ID' erfuellt nicht das Koordinator-Pattern (koordinator | koordinator-*)."
  echo "         Falle zurueck auf '${AGENT_ID}', sonst wird die neue Session als subagent eingestuft."
  AGENT_ID="koordinator"
fi

# Sicherheitscheck: Wrapper muss laufen
SESSION_PID="${CLAUDE_WRAPPER_PID:-}"
if [ -z "$SESSION_PID" ]; then
  echo ""
  echo "FEHLER: CLAUDE_WRAPPER_PID nicht gesetzt."
  echo "Handoff funktioniert nur wenn Claude ueber den Wrapper gestartet wurde:"
  echo "  bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh"
  echo "  (oder: cc <projekt-verzeichnis>)"
  echo ""
  echo "Handoff abgebrochen."
  exit 1
fi

HANDOFF_MARKER="/tmp/.claude-handoff-pending-${SESSION_PID}"

# Validierung
if [ ! -d "$PROJECT_DIR" ]; then
  echo "FEHLER: Verzeichnis existiert nicht: $PROJECT_DIR"
  exit 1
fi

# --- Claude-Prozess finden ---

find_claude_pid() {
  local pid=$$
  for _ in 1 2 3 4 5 6 7 8; do
    local parent
    parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$parent" ] || [ "$parent" = "1" ] && break
    local cmd
    cmd=$(ps -o comm= -p "$parent" 2>/dev/null || true)
    if [[ "$cmd" == "node" ]] || [[ "$cmd" == "claude" ]]; then
      echo "$parent"
      return 0
    fi
    pid="$parent"
  done
  echo "$pid"
}

# --- CLI-Flags aus dem laufenden Prozess extrahieren ---
# Versucht Flags aus /proc/<pid>/cmdline zu lesen.
# Fallback: Sucht den Wrapper-Prozess (claude-session.sh) und liest dessen Args.
# Die Flags werden zeilenweise in eine .flags-Datei geschrieben,
# damit claude-session.sh sie an die neue Session weitergeben kann.
#
# HINWEIS: claude-session.sh nutzt seit v2 primaer die INITIAL_FLAGS Bash-Variable
# (ueberlebt Loop-Iterationen). Diese .flags-Datei ist ein zusaetzlicher Fallback.

extract_claude_flags() {
  local pid="$1"
  local -a flags=()

  # Strategie 1: /proc/<pid>/cmdline des Claude-Prozesses lesen
  if [ -f "/proc/$pid/cmdline" ]; then
    local -a args=()
    while IFS= read -r -d '' arg; do
      args+=("$arg")
    done < "/proc/$pid/cmdline" || true

    local i=0
    while [ $i -lt ${#args[@]} ]; do
      case "${args[$i]}" in
        # Boolean-Flags (ohne Wert)
        --dangerously-skip-permissions|--allow-dangerously-skip-permissions)
          flags+=("${args[$i]}")
          ;;
        # Flags mit einem Wert-Argument
        --permission-mode|--allowedTools|--allowed-tools|--disallowedTools|--disallowed-tools|--add-dir|--append-system-prompt|--system-prompt|--effort)
          flags+=("${args[$i]}")
          if [ $((i+1)) -lt ${#args[@]} ]; then
            i=$((i + 1))
            flags+=("${args[$i]}")
          fi
          ;;
      esac
      i=$((i + 1))
    done
  else
    echo "WARNUNG: /proc/$pid/cmdline nicht lesbar" >&2
  fi

  # Strategie 2 (Fallback): Wrapper-Prozess (claude-session.sh) suchen
  # pgrep -f matched auch sich selbst, daher filtern wir eigene PID raus
  if [ ${#flags[@]} -eq 0 ]; then
    local wrapper_pid=""
    local -a pids=()
    mapfile -t pids < <(pgrep -f "claude-session\.sh" 2>/dev/null)
    for candidate in "${pids[@]}"; do
      # Eigene PID und Subshells ausschliessen
      [ "$candidate" = "$$" ] && continue
      local cname
      cname=$(ps -o comm= -p "$candidate" 2>/dev/null || true)
      if [[ "$cname" == "bash" ]]; then
        wrapper_pid="$candidate"
        break
      fi
    done

    if [ -n "$wrapper_pid" ] && [ -f "/proc/$wrapper_pid/cmdline" ]; then
      local -a wrapper_args=()
      while IFS= read -r -d '' arg; do
        wrapper_args+=("$arg")
      done < "/proc/$wrapper_pid/cmdline" || true

      local w_i=0
      while [ $w_i -lt ${#wrapper_args[@]} ]; do
        case "${wrapper_args[$w_i]}" in
          --dangerously-skip-permissions|--allow-dangerously-skip-permissions)
            flags+=("${wrapper_args[$w_i]}")
            ;;
          --permission-mode|--allowedTools|--allowed-tools|--disallowedTools|--disallowed-tools)
            flags+=("${wrapper_args[$w_i]}")
            if [ $((w_i+1)) -lt ${#wrapper_args[@]} ]; then
              w_i=$((w_i + 1))
              flags+=("${wrapper_args[$w_i]}")
            fi
            ;;
        esac
        w_i=$((w_i + 1))
      done

      if [ ${#flags[@]} -gt 0 ]; then
        echo "CLI-Flags aus Wrapper (PID $wrapper_pid) uebernommen: ${flags[*]}"
      fi
    fi
  fi

  # Schreibe Flags zeilenweise (eine Flag/Wert pro Zeile)
  if [ ${#flags[@]} -gt 0 ]; then
    printf '%s\n' "${flags[@]}" > "${HANDOFF_MARKER}.flags"
    echo "CLI-Flags uebernommen: ${flags[*]}"
  else
    echo "Keine CLI-Flags erkannt (Wrapper INITIAL_FLAGS werden trotzdem verwendet)"
  fi
}

# --- Prozess finden + Flags extrahieren ---

TARGET_PID=$(find_claude_pid)
extract_claude_flags "$TARGET_PID"

# --- Handoff-Prompt generieren ---

HANDOFF_PROMPT="Du bist die Fortsetzung einer vorherigen Session die wegen Context-Limit gewechselt hat.

PFLICHT — Fuehre diese Schritte in DIESER Reihenfolge aus:

1. Lade den synapse-nutzung Skill (er enthaelt deine Arbeitsregeln)

2. Projekt pruefen — NICHT blind init aufrufen:
   project(action: 'status', path: '${PROJECT_DIR}')
   Nur WENN nicht initialisiert oder status='stopped':
     project(action: 'init', path: '${PROJECT_DIR}', name: '${PROJEKT_NAME}', agent_id: '${AGENT_ID}')
   (init ist einmalig und stoesst den Setup-Flow an; ein laufendes Projekt braucht es nicht.)

3. Registrieren:
   chat(action: 'register', id: '${AGENT_ID}', project: '${PROJEKT_NAME}', model: '<dein Modell>')

4. Projekt-Regeln laden — NICHT ueberspringen, sonst arbeitest du ohne die Regeln:
   admin(action: 'index_stats', project: '${PROJEKT_NAME}', agent_id: '${AGENT_ID}', role: 'koordinator')
   Die Antwort enthaelt die rollenspezifischen Projekt-Regeln. Lies sie vollstaendig.

5. Letzte Team-Nachrichten:
   chat(action: 'get', project: '${PROJEKT_NAME}', limit: 10)

6. Handoff-Kontext laden (action ist SEARCH, nicht get — get erwartet eine id):
   thought(action: 'search', project: '${PROJEKT_NAME}', query: 'session-uebergabe')
   → Lies den/die Handoff-Thought(s) vollstaendig.
   → Erst NACH dem Lesen und nur den bereits verarbeiteten loeschen:
     thought(action: 'delete', project: '${PROJEKT_NAME}', id: '<id>')
   Es koennen mehrere Handoffs existieren, die sich ergaenzen statt ersetzen — pruefe das Datum.

7. Aufgabe: ${AUFGABE}

WICHTIG:
- ZUERST Kontext lesen, DANN arbeiten.
- Suchreihenfolge: code_intel zuerst (tree/functions/symbols/references/search), dann Glob/Grep, Read zuletzt.
- Mehrere Dateien aendern: IMMER files(action:'plan') + commit in EINEM atomaren Aufruf.
- BUILD-PRUEFUNG: niemals durch eine Pipe. 'pnpm build 2>&1 | tail' liefert den Exit-Code von tail,
  also immer 0 — und tsc schreibt das dist auch bei Fehlern. Immer EXIT=\$? pruefen plus grep auf 'error TS'.
- Bei Unsicherheit zu einem Tool: guide(tool_name) fragen, das kostet keinen MCP-Kontext."

# --- Handoff-Daten schreiben (wird vom Wrapper gelesen) ---

cat > "${HANDOFF_MARKER}.script" << SCRIPTEOF
HANDOFF_PROMPT=$(printf '%q' "$HANDOFF_PROMPT")
HANDOFF_MODEL="opus[1m]"
cd "$PROJECT_DIR"
SCRIPTEOF

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           CONTEXT-HANDOFF AKTIVIERT                 ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║ Synapse: Handoff-Thought + Chat gespeichert          ║"
echo "║ Projekt: ${PROJEKT_NAME}"
echo "║ Aufgabe: ${AUFGABE:0:50}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# --- Agent-Guard: Warte auf Background-Tasks BEVOR CC gekillt wird ---
# CC muss noch leben damit Agenten weiter laufen und sich abmelden koennen!
AGENT_REGISTRY="/tmp/.claude-agents-${SESSION_PID}"
if [ -d "$AGENT_REGISTRY" ] && [ -n "$(ls "$AGENT_REGISTRY/" 2>/dev/null)" ]; then
  AGENT_COUNT=$(ls "$AGENT_REGISTRY/" | wc -l)
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  printf "║   WARTE AUF %d AGENTEN (CC bleibt am Leben)%-10s║\n" "$AGENT_COUNT" ""
  echo "║   Agenten koennen jetzt noch sauber abschliessen    ║"
  echo "╚══════════════════════════════════════════════════════╝"

  ELAPSED=0
  MAX_WAIT="${AGENT_HANDOFF_TIMEOUT:-300}"  # 5 Min Standard, via Env konfigurierbar
  while [ -d "$AGENT_REGISTRY" ] && [ -n "$(ls "$AGENT_REGISTRY/" 2>/dev/null)" ]; do
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
      echo "Timeout nach ${MAX_WAIT}s — Registry leeren und Handoff erzwingen"
      rm -rf "$AGENT_REGISTRY"  # Leeren: nach CC-Kill sterben Agenten sowieso
      break
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    REMAINING=$(ls "$AGENT_REGISTRY/" 2>/dev/null | wc -l)
    echo "  Noch ${REMAINING} Agenten aktiv... (${ELAPSED}s/${MAX_WAIT}s)"
  done
  echo "Alle Agenten fertig — starte Handoff..."
  echo ""
fi

# Setze Handoff-Marker (Wrapper erkennt diesen nach Claude-Exit)
touch "$HANDOFF_MARKER"

echo "Beende aktuelle Claude-Session (PID: $TARGET_PID)..."

# Kill im Hintergrund mit kurzer Verzoegerung (damit diese Ausgabe noch ankommt)
(sleep 0.5 && kill "$TARGET_PID" 2>/dev/null) &
disown

exit 0
