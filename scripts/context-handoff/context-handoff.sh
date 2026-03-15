#!/usr/bin/env bash
# context-handoff.sh — Beendet aktuelle Claude-Session und startet neue mit Synapse-Kontext
#
# PROTOTYP — Experimentelles Feature, API kann sich aendern
#
# Verwendung (vom Koordinator aufgerufen NACHDEM Synapse gespeichert wurde):
#   bash /pfad/zu/synapse/scripts/context-handoff/context-handoff.sh \
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

HANDOFF_MARKER="/tmp/.claude-handoff-pending"

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
  if [ ${#flags[@]} -eq 0 ]; then
    local wrapper_pid=""
    local -a pids=()
    mapfile -t pids < <(pgrep -f "claude-session\.sh" 2>/dev/null)
    for candidate in "${pids[@]}"; do
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

1. Registrieren:
   register_chat_agent(id: 'koordinator', project: '${PROJEKT_NAME}')

2. Handoff-Kontext laden:
   search_thoughts(query: 'session-uebergabe', project: '${PROJEKT_NAME}')
   → Lies den Thought, extrahiere CHAT-SEIT Timestamp

3. Chat-Verlauf laden (nur relevante Nachrichten):
   get_chat_messages(project: '${PROJEKT_NAME}', agent_id: 'koordinator', since: '<CHAT-SEIT>', limit: 20)
   → Kontext von anderen Agenten und vorheriger Session

4. Handoff-Thought loeschen nach dem Lesen

5. Aufgabe: ${AUFGABE}

WICHTIG:
- ZUERST Kontext lesen, DANN arbeiten
- Synapse-Regeln befolgen (synapse-nutzung Skill laden)"

# --- Handoff-Daten schreiben (wird vom Wrapper gelesen) ---

cat > "${HANDOFF_MARKER}.script" << SCRIPTEOF
HANDOFF_PROMPT=$(printf '%q' "$HANDOFF_PROMPT")
HANDOFF_MODEL="opus"
cd "$PROJECT_DIR"
SCRIPTEOF

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           CONTEXT-HANDOFF AKTIVIERT                 ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║ Synapse: Thought + Memory gespeichert               ║"
echo "║ Projekt: ${PROJEKT_NAME}"
echo "║ Aufgabe: ${AUFGABE:0:50}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Setze Handoff-Marker (Wrapper erkennt diesen nach Claude-Exit)
touch "$HANDOFF_MARKER"

echo "Beende aktuelle Claude-Session (PID: $TARGET_PID)..."

# Kill im Hintergrund mit kurzer Verzoegerung (damit diese Ausgabe noch ankommt)
(sleep 0.5 && kill "$TARGET_PID" 2>/dev/null) &
disown

exit 0
