#!/bin/bash
# Reagiert auf zwei Trigger-Files:
#   start-requested → spawnt Daemon
#   stop-requested  → killt Daemon
TRIGGER_DIR="$HOME/.synapse/file-watcher"
DAEMON="$HOME/dev/synapse/packages/file-watcher-daemon-ts/dist/main.js"
LOG="$TRIGGER_DIR/daemon.log"
PID_FILE="$TRIGGER_DIR/daemon.pid"

MCP_JSON="$HOME/.mcp.json"
[ -f "$HOME/dev/synapse/.mcp.json" ] && MCP_JSON="$HOME/dev/synapse/.mcp.json"
eval "$(jq -r '.mcpServers.synapse.env | to_entries[] | "export \(.key)=\(.value|@sh)"' "$MCP_JSON" 2>/dev/null)"

daemon_url() {
  local port
  port=$(cat "$TRIGGER_DIR/daemon.port" 2>/dev/null)
  [ -z "$port" ] && port=7878
  echo "http://127.0.0.1:$port"
}

# Details-Dialog: listet die letzten 50 watcher_events fuer ein Projekt,
# Auswahl-Klick oeffnet die Datei (xdg-open), "Explorer"-Button den Ordner.
handle_details() {
  local name="$1"
  local url
  url="$(daemon_url)"
  local title="FileWatcher: $name"
  local json
  json=$(curl -sf --max-time 4 "$url/projects/$name/history?limit=50" 2>/dev/null)
  if [ -z "$json" ]; then
    zenity --error --title="$title" --text="Konnte Historie nicht laden (Daemon offline?)" 2>/dev/null
    return
  fi
  local pfad
  pfad=$(curl -sf --max-time 3 "$url/projects/$name/status" 2>/dev/null | jq -r '.pfad // empty')
  # Jede Zeile: <event> <file_path> <created_at>
  local rows
  rows=$(echo "$json" | jq -r '.events[] | [.event_type, .file_path, .created_at] | @tsv')
  if [ -z "$rows" ]; then
    zenity --info --title="$title" --text="Keine Events fuer $name\nPfad: ${pfad:-?}" 2>/dev/null
    return
  fi
  # zenity --list mit 3 Spalten, print-column=2 (file_path)
  local sel
  sel=$(echo "$rows" | zenity --list \
      --title="$title" \
      --text="Projekt: $name\nPfad: ${pfad:-?}\n\nDoppelklick/OK: Datei oeffnen" \
      --width=820 --height=520 \
      --column="Event" --column="Datei" --column="Zeit" \
      --print-column=2 \
      --separator=$'\n' 2>/dev/null)
  [ -z "$sel" ] && return
  # Auswahl kann sein:
  #   - absoluter Pfad (/home/...)            → direkt nutzen
  #   - watcher-internes Format (home/...)    → fuehrenden Slash voranstellen
  #   - echter Relativpfad (packages/...)     → an projekt-pfad anhaengen
  local target="$sel"
  case "$target" in
    /*)              : ;;
    home/*|root/*|tmp/*|mnt/*|var/*|opt/*|usr/*|etc/*)
                     target="/$sel" ;;
    *)               [ -n "$pfad" ] && target="$pfad/$sel" ;;
  esac
  if [ -e "$target" ]; then
    setsid xdg-open "$target" >/dev/null 2>&1 &
  else
    # Datei existiert nicht mehr (z.B. unlink) → Verzeichnis oeffnen
    local dir
    dir=$(dirname "$target")
    [ -d "$dir" ] && setsid xdg-open "$dir" >/dev/null 2>&1 &
  fi
}

# Loeschen-Dialog: Bestaetigung + DELETE /projects/:name am Daemon.
# Disk-Dateien und PG-Eintraege (code_files) bleiben unveraendert.
handle_delete() {
  local name="$1"
  local url
  url="$(daemon_url)"
  zenity --question \
      --title="FileWatcher: $name entfernen?" \
      --text="Projekt '$name' aus FileWatcher entfernen?\n\nDateien auf Disk bleiben unveraendert." \
      --ok-label="Entfernen" --cancel-label="Abbrechen" 2>/dev/null
  if [ $? -ne 0 ]; then
    return
  fi
  local resp
  resp=$(curl -sf -X DELETE --max-time 4 "$url/projects/$name" 2>/dev/null)
  if [ -z "$resp" ]; then
    zenity --error --title="FileWatcher" --text="Loeschen von '$name' fehlgeschlagen (Daemon offline?)" 2>/dev/null
  fi
}

# Agenten-Dialog: listet Spezialisten aus .synapse/agents/status.json (via Daemon).
# Auswahl → Bestaetigung → POST stop (SIGTERM auf wrapperPid).
handle_agents() {
  local name="$1"
  local url
  url="$(daemon_url)"
  local title="Agenten: $name"
  local json
  json=$(curl -sf --max-time 4 "$url/projects/$name/specialists" 2>/dev/null)
  if [ -z "$json" ]; then
    zenity --error --title="$title" --text="Konnte Spezialisten-Liste nicht laden (Daemon offline?)" 2>/dev/null
    return
  fi
  local rows
  rows=$(echo "$json" | jq -r '.specialists | to_entries[] | [.key, .value.model, .value.status, ((.value.tokens.percent // 0 | tostring) + "%"), (.value.lastActivity // "" | split("T")[1] // "")] | @tsv')
  if [ -z "$rows" ]; then
    local max
    max=$(echo "$json" | jq -r '.maxSpecialists // 7')
    zenity --info --title="$title" --text="Keine aktiven Spezialisten fuer $name\nMax: $max" 2>/dev/null
    return
  fi
  local sel
  sel=$(echo "$rows" | zenity --list \
      --title="$title" \
      --text="Projekt: $name\n\nDoppelklick/OK = Spezialist stoppen (Bestaetigung folgt)" \
      --width=780 --height=440 \
      --column="Name" --column="Modell" --column="Status" --column="Tokens" --column="Aktiv (UTC)" \
      --print-column=1 \
      --separator=$'\n' 2>/dev/null)
  [ -z "$sel" ] && return
  zenity --question \
      --title="$title" \
      --text="Spezialist '$sel' stoppen?\n\nSIGTERM geht an den Wrapper. Eintrag wird aus status.json entfernt." \
      --ok-label="Stoppen" --cancel-label="Abbrechen" 2>/dev/null
  [ $? -ne 0 ] && return
  local resp
  resp=$(curl -sf -X POST --max-time 4 "$url/projects/$name/specialists/$sel/stop" 2>/dev/null)
  if [ -z "$resp" ]; then
    zenity --error --title="$title" --text="Stoppen von '$sel' fehlgeschlagen." 2>/dev/null
  else
    zenity --info --title="$title" --text="Spezialist '$sel' gestoppt." 2>/dev/null
  fi
}

while true; do
  if [ -f "$TRIGGER_DIR/start-requested" ]; then
    rm -f "$TRIGGER_DIR/start-requested"
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[start-watcher] Daemon laeuft bereits" >> "$LOG"
    else
      echo "[start-watcher] Starte Daemon..." >> "$LOG"
      setsid nohup node "$DAEMON" >> "$LOG" 2>&1 < /dev/null &
      disown
    fi
  fi
  if [ -f "$TRIGGER_DIR/stop-requested" ]; then
    rm -f "$TRIGGER_DIR/stop-requested"
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[start-watcher] Stoppe Daemon (Tray-Beenden)" >> "$LOG"
      kill "$(cat "$PID_FILE")"
      rm -f "$PID_FILE" "$TRIGGER_DIR/daemon.port"
    fi
  fi
  if [ -f "$TRIGGER_DIR/details-requested" ]; then
    name=$(cat "$TRIGGER_DIR/details-requested" 2>/dev/null | tr -d '\r\n')
    rm -f "$TRIGGER_DIR/details-requested"
    if [ -n "$name" ]; then
      echo "[start-watcher] Details: $name" >> "$LOG"
      handle_details "$name" &
      disown
    fi
  fi
  if [ -f "$TRIGGER_DIR/delete-requested" ]; then
    name=$(cat "$TRIGGER_DIR/delete-requested" 2>/dev/null | tr -d '\r\n')
    rm -f "$TRIGGER_DIR/delete-requested"
    if [ -n "$name" ]; then
      echo "[start-watcher] Delete: $name" >> "$LOG"
      handle_delete "$name" &
      disown
    fi
  fi
  if [ -f "$TRIGGER_DIR/agents-requested" ]; then
    name=$(cat "$TRIGGER_DIR/agents-requested" 2>/dev/null | tr -d '
')
    rm -f "$TRIGGER_DIR/agents-requested"
    if [ -n "$name" ]; then
      echo "[start-watcher] Agents: $name" >> "$LOG"
      handle_agents "$name" &
      disown
    fi
  fi
  sleep 2
done
