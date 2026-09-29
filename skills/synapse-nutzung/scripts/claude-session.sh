#!/usr/bin/env bash
# claude-session.sh — Wrapper der Claude mit automatischem Context-Handoff startet
#
# Verwendung (statt "claude" direkt):
#   bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh [args...]
#
# Alias einrichten:
#   fish: alias cc "bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh"
#   bash: alias cs='bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh'
#
# Was passiert:
# 1. Startet Claude normal mit allen uebergebenen Argumenten
# 2. Wenn Claude beendet wird, prueft es auf Handoff-Marker
# 3. Falls Handoff-Marker existiert: startet neue Claude-Session mit Synapse-Prompt
#    UND uebernimmt die CLI-Flags (Permissions, Model, etc.) vom Vorgaenger
# 4. Falls kein Marker: beendet sich normal

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"
LOG="/tmp/.claude-session.log"

# Session-ID: eigene PID als stabiler Bezeichner fuer alle tmp-Dateien
export CLAUDE_WRAPPER_PID=$$
HANDOFF_MARKER="/tmp/.claude-handoff-pending-$$"
AGENT_REGISTRY="/tmp/.claude-agents-$$"

if [ -z "$CLAUDE_BIN" ]; then
  echo "FEHLER: claude CLI nicht gefunden"
  exit 1
fi

# Logging-Funktion
log() {
  echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"
}

log "=== WRAPPER START (PID $$) ==="
log "Cmdline: $0 $*"

# Initiale CLI-Flags fuer Handoffs sichern (ohne --resume/--continue — gilt nur fuer den ersten Start).
# Der erste Start nutzt "$@" direkt, INITIAL_FLAGS nur fuer Handoff-Wiederholungen.
INITIAL_FLAGS=()
_skip_next=false
for _f in "$@"; do
  if $_skip_next; then _skip_next=false; continue; fi
  case "$_f" in
    --resume|-r|--continue|-c) _skip_next=true; continue ;;
  esac
  INITIAL_FLAGS+=("$_f")
done
unset _f _skip_next

# Persistente Flag-Datei als Backup (ueberlebt auch wenn Bash-Array verloren geht)
FLAGS_BACKUP="/tmp/.claude-session-flags-$$"
printf '%s\n' "${INITIAL_FLAGS[@]}" > "$FLAGS_BACKUP"
trap 'rm -f "$FLAGS_BACKUP"; rm -rf "$AGENT_REGISTRY"' EXIT
log "INITIAL_FLAGS gesichert: ${INITIAL_FLAGS[*]:-(keine)}"
log "FLAGS_BACKUP: $FLAGS_BACKUP"

# Aufraeumen falls alter Marker existiert
rm -f "$HANDOFF_MARKER" "${HANDOFF_MARKER}.script" "${HANDOFF_MARKER}.flags"

# Handoff-Zaehler (fuer Debug-Ausgabe)
HANDOFF_COUNT=0

# Hilfsfunktion: Flags deduplizieren (behebt local-bug)
add_flag_unique() {
  local flag_to_add="$1"
  shift
  local -a existing=("$@")
  local ef
  for ef in "${existing[@]}"; do
    [[ "$ef" == "$flag_to_add" ]] && return 1
  done
  return 0
}

# Hilfsfunktion: Flags aus INITIAL_FLAGS oder Backup-Datei laden
load_flags() {
  local -a flags=()

  # Primaere Quelle: INITIAL_FLAGS Bash-Array
  if [ ${#INITIAL_FLAGS[@]} -gt 0 ]; then
    flags=("${INITIAL_FLAGS[@]}")
    log "Flags aus INITIAL_FLAGS: ${flags[*]}"
  fi

  # Fallback 1: Persistente Backup-Datei
  if [ ${#flags[@]} -eq 0 ] && [ -f "$FLAGS_BACKUP" ]; then
    mapfile -t flags < "$FLAGS_BACKUP"
    # Leere Zeilen entfernen
    local -a cleaned=()
    local f
    for f in "${flags[@]}"; do
      [[ -n "$f" ]] && cleaned+=("$f")
    done
    flags=("${cleaned[@]}")
    log "Flags aus Backup-Datei: ${flags[*]:-(keine)}"
  fi

  # Fallback 2: Eigene /proc/cmdline lesen
  if [ ${#flags[@]} -eq 0 ] && [ -f "/proc/$$/cmdline" ]; then
    local -a proc_args=()
    while IFS= read -r -d '' arg; do
      proc_args+=("$arg")
    done < "/proc/$$/cmdline"

    local i=0
    while [ $i -lt ${#proc_args[@]} ]; do
      case "${proc_args[$i]}" in
        --dangerously-skip-permissions|--allow-dangerously-skip-permissions)
          flags+=("${proc_args[$i]}")
          ;;
        --permission-mode|--allowedTools|--allowed-tools|--disallowedTools|--disallowed-tools)
          flags+=("${proc_args[$i]}")
          if [ $((i+1)) -lt ${#proc_args[@]} ]; then
            i=$((i + 1))
            flags+=("${proc_args[$i]}")
          fi
          ;;
      esac
      i=$((i + 1))
    done
    log "Flags aus /proc/$$/cmdline: ${flags[*]:-(keine)}"
  fi

  printf '%s\n' "${flags[@]}"
}

while true; do
  echo ""

  if [ -f "${HANDOFF_MARKER}.script" ]; then
    # --- Handoff-Modus: Starte mit Synapse-Prompt + gesicherten Flags ---
    HANDOFF_COUNT=$((HANDOFF_COUNT + 1))
    HANDOFF_SCRIPT="${HANDOFF_MARKER}.script"
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║   CONTEXT-HANDOFF #${HANDOFF_COUNT} — Neue Session               ║"
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""

    log "--- HANDOFF #${HANDOFF_COUNT} ---"

    # Lese Handoff-Daten (HANDOFF_PROMPT, HANDOFF_MODEL, cd)
    log "Source: $HANDOFF_SCRIPT"
    source "$HANDOFF_SCRIPT"
    rm -f "$HANDOFF_SCRIPT"
    log "HANDOFF_MODEL=$HANDOFF_MODEL"
    log "HANDOFF_PROMPT length: ${#HANDOFF_PROMPT}"

    # CLI-Flags laden (mit Fallback-Kette)
    mapfile -t EXTRA_FLAGS < <(load_flags)
    log "EXTRA_FLAGS nach load_flags: ${EXTRA_FLAGS[*]:-(LEER!)}"

    # .flags-Datei von context-handoff.sh ADDITIV mergen
    if [ -f "${HANDOFF_MARKER}.flags" ]; then
      log ".flags Datei gefunden"
      mapfile -t file_flags < "${HANDOFF_MARKER}.flags"
      rm -f "${HANDOFF_MARKER}.flags"
      for lf in "${file_flags[@]}"; do
        [[ -z "$lf" ]] && continue
        if add_flag_unique "$lf" "${EXTRA_FLAGS[@]}"; then
          EXTRA_FLAGS+=("$lf")
          log "Flag aus .flags hinzugefuegt: $lf"
        else
          log "Flag aus .flags uebersprungen (Duplikat): $lf"
        fi
      done
    else
      log ".flags Datei NICHT gefunden"
    fi

    log "EXTRA_FLAGS final: ${EXTRA_FLAGS[*]:-(LEER!)}"

    # Flags entfernen die bei Handoff NICHT weitergegeben werden duerfen:
    # --model: wird separat via HANDOFF_MODEL gesetzt
    # --resume/-r/--continue/-c: wuerde die alte (erschoepfte) Session fortsetzen
    #   statt eine neue zu starten → leerer Context!
    # --session-id: gleicher Grund wie --resume
    FILTERED_FLAGS=()
    skip_next=false
    for flag in "${EXTRA_FLAGS[@]}"; do
      if $skip_next; then
        skip_next=false
        continue
      fi
      case "$flag" in
        --model|--session-id)
          skip_next=true
          continue
          ;;
        --resume|-r|--continue|-c)
          log "Flag entfernt (Handoff braucht neue Session): $flag"
          skip_next=true  # Wert (UUID) ebenfalls entfernen!
          continue
          ;;
      esac
      # Leere Eintraege ueberspringen
      [[ -z "$flag" ]] && continue
      FILTERED_FLAGS+=("$flag")
    done

    log "FILTERED_FLAGS: ${FILTERED_FLAGS[*]:-(LEER!)}"

    echo "Initiale Flags: ${INITIAL_FLAGS[*]:-(keine)}"
    echo "Aktive Flags:   ${FILTERED_FLAGS[*]:-(keine)}"
    echo "Model:          ${HANDOFF_MODEL:-opus}"
    echo ""

    # Starte Claude mit gesicherten Flags + Handoff-Prompt
    echo "Starte: claude ${FILTERED_FLAGS[*]} --model ${HANDOFF_MODEL:-opus} <prompt>"
    echo ""
    log "EXEC: $CLAUDE_BIN ${FILTERED_FLAGS[*]} --model ${HANDOFF_MODEL:-opus} <prompt>"
    "$CLAUDE_BIN" "${FILTERED_FLAGS[@]}" --model "${HANDOFF_MODEL:-opus}" "$HANDOFF_PROMPT"
    EXIT_CODE=$?
    log "Claude beendet (Exit: $EXIT_CODE)"
  else
    # --- Normaler Modus: Starte Claude mit User-Argumenten ---
    log "Normaler Start: $CLAUDE_BIN $*"
    "$CLAUDE_BIN" "$@"
    EXIT_CODE=$?
    # Nach dem ersten Start: Argumente nicht wiederverwenden
    set --
    log "Normaler Claude beendet (Exit: $EXIT_CODE)"
  fi

  # Pruefe auf Handoff-Marker
  if [ -f "$HANDOFF_MARKER" ]; then
    echo ""
    echo ">>> Context-Handoff erkannt — pruefe laufende Agenten..."
    log "Handoff-Marker gefunden"

    # Agent-Guard: Warte bis alle registrierten Tasks fertig sind
    # TTL: Stale Eintraege (CC wurde gekillt) werden nach AGENT_REGISTRY_TTL Sekunden entfernt
    STALE_TTL="${AGENT_REGISTRY_TTL:-900}"

    purge_stale_agents() {
      [ -d "$AGENT_REGISTRY" ] || return
      local now
      now=$(date +%s)
      for f in "$AGENT_REGISTRY"/*; do
        [ -f "$f" ] || continue
        local created
        created=$(stat -c %Y "$f" 2>/dev/null || echo 0)
        local age=$(( now - created ))
        if [ "$age" -gt "$STALE_TTL" ]; then
          echo "  Stale Eintrag entfernt: $(basename "$f") (${age}s alt)"
          log "Stale Eintrag entfernt: $(basename "$f") (${age}s)"
          rm -f "$f"
        fi
      done
    }

    purge_stale_agents
    if [ -d "$AGENT_REGISTRY" ] && [ -n "$(ls "$AGENT_REGISTRY/" 2>/dev/null)" ]; then
      AGENT_COUNT=$(ls "$AGENT_REGISTRY/" | wc -l)
      echo ""
      echo "╔══════════════════════════════════════════════════════╗"
      printf "║   WARTE AUF %d LAUFENDE AGENTEN...%-21s║\n" "$AGENT_COUNT" ""
      echo "║   (Handoff wird nach Abschluss fortgesetzt)          ║"
      printf "║   Stale-TTL: %-41s║\n" "${STALE_TTL}s (AGENT_REGISTRY_TTL)"
      echo "╚══════════════════════════════════════════════════════╝"
      log "${AGENT_COUNT} Agenten noch aktiv — warte (max 600s, TTL=${STALE_TTL}s)"
      WAIT_ELAPSED=0
      WAIT_MAX=600
      while [ -d "$AGENT_REGISTRY" ] && [ -n "$(ls "$AGENT_REGISTRY/" 2>/dev/null)" ]; do
        if [ $WAIT_ELAPSED -ge $WAIT_MAX ]; then
          echo "WARNUNG: Timeout nach ${WAIT_MAX}s — starte trotzdem neu"
          log "Timeout: Agenten noch aktiv, Neustart erzwungen"
          break
        fi
        sleep 5
        WAIT_ELAPSED=$((WAIT_ELAPSED + 5))
        purge_stale_agents
        REMAINING=$(ls "$AGENT_REGISTRY/" 2>/dev/null | wc -l)
        echo "  Noch ${REMAINING} Agenten aktiv... (${WAIT_ELAPSED}s)"
        log "Warte: ${REMAINING} Agenten (${WAIT_ELAPSED}s)"
      done
      echo "Alle Agenten fertig — starte neue Session..."
    fi

    echo ""
    echo ">>> Starte neue Session in 2s..."
    log "Starte Handoff-Session"
    sleep 2
    rm -f "$HANDOFF_MARKER"
    # Loop startet neu → liest ${HANDOFF_MARKER}.script + .flags
    continue
  fi

  # Kein Handoff → normal beenden
  echo ""
  echo "Claude beendet (Exit: $EXIT_CODE)"
  log "Kein Handoff, Wrapper beendet"
  break
done

log "=== WRAPPER ENDE (PID $$) ==="
