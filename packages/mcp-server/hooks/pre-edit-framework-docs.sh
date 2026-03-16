#!/usr/bin/env bash
# pre-edit-framework-docs.sh
# PreToolUse:Edit|Write — zeigt Framework-Docs BEVOR der Agent schreibt
# Pro Agent + Framework nur 1x (Marker-File pro Agent-ID)

set -euo pipefail

INPUT=$(cat)
if [ -z "$INPUT" ]; then exit 0; fi
if ! command -v jq &>/dev/null; then exit 0; fi

# Dateipfad aus tool_input extrahieren
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
if [ -z "$FILE_PATH" ]; then exit 0; fi

# Agent-ID ermitteln (gesetzt von chat-notify.sh)
CURRENT_AGENT_FILE="/tmp/synapse-current-agent"
if [ -f "$CURRENT_AGENT_FILE" ]; then
  AGENT_ID=$(cat "$CURRENT_AGENT_FILE")
else
  AGENT_ID="${SYNAPSE_AGENT_ID:-koordinator}"
fi

# Extension pruefen
EXT="${FILE_PATH##*.}"
EXT="${EXT,,}"

declare -A LANG_MAP=(
  [tsx]=javascript [ts]=javascript [jsx]=javascript [js]=javascript
  [vue]=javascript [svelte]=javascript [mjs]=javascript [cjs]=javascript
  [go]=go [py]=python [rb]=ruby [rs]=rust [php]=php
  [css]=css [scss]=css [sass]=css [less]=css
  [html]=html [htm]=html [ejs]=html [hbs]=html [tmpl]=html [gohtml]=html [pug]=html
)

LANG="${LANG_MAP[$EXT]:-}"
if [ -z "$LANG" ]; then exit 0; fi

# Datei lesen (erste 50 Zeilen fuer Imports)
if [ ! -f "$FILE_PATH" ]; then exit 0; fi
FILE_CONTENT=$(head -n 50 "$FILE_PATH" 2>/dev/null || true)
if [ -z "$FILE_CONTENT" ]; then exit 0; fi

# Framework-Imports extrahieren
DETECTED=()

case "$LANG" in
  javascript)
    while IFS= read -r pkg; do
      pkg="${pkg%%/*}"; pkg="${pkg#@}"
      if [ -n "$pkg" ] && [ "${#pkg}" -gt 1 ]; then DETECTED+=("$pkg"); fi
    done < <(echo "$FILE_CONTENT" | grep -oP "(?:from\s+['\"]|require\s*\(['\"])(@?[a-z0-9][\w./-]*)" | grep -oP "['\"](@?[a-z0-9][\w./-]*)" | tr -d "\"'" || true)
    ;;
  go)
    while IFS= read -r pkg; do
      if echo "$pkg" | grep -qP '^(github\.com|gitlab\.com|golang\.org|google\.golang\.org|gopkg\.in|go\.uber\.org)'; then
        short="${pkg##*/}"; [ -n "$short" ] && DETECTED+=("$short")
      fi
    done < <(echo "$FILE_CONTENT" | grep -oP '["'"'"'`]([^"'"'"'`]+)["'"'"'`]' | tr -d '"'"'"'`' || true)
    ;;
  python)
    STDLIBS="os sys json re typing datetime collections logging time math random io pathlib functools itertools"
    while IFS= read -r pkg; do
      echo " $STDLIBS " | grep -q " $pkg " || DETECTED+=("$pkg")
    done < <(echo "$FILE_CONTENT" | grep -oP '(?:^|\n)\s*(?:from|import)\s+([a-z_][a-z0-9_]*)' | grep -oP '[a-z_][a-z0-9_]*$' || true)
    ;;
  rust)
    while IFS= read -r pkg; do
      [ "$pkg" != "std" ] && [ "$pkg" != "core" ] && [ "$pkg" != "alloc" ] && DETECTED+=("$pkg")
    done < <(echo "$FILE_CONTENT" | grep -oP 'use\s+([a-z_][a-z0-9_]*)::' | grep -oP '[a-z_][a-z0-9_]*(?=::)' || true)
    ;;
  css)
    echo "$FILE_CONTENT" | grep -q '@tailwind\|@apply' && DETECTED+=("tailwindcss")
    echo "$FILE_CONTENT" | grep -q 'bootstrap\|--bs-' && DETECTED+=("bootstrap")
    ;;
  html)
    echo "$FILE_CONTENT" | grep -qP 'x-data\s*=' && DETECTED+=("alpinejs")
    echo "$FILE_CONTENT" | grep -qP 'hx-get\s*=' && DETECTED+=("htmx")
    echo "$FILE_CONTENT" | grep -qP 'v-model\s*=' && DETECTED+=("vue")
    ;;
esac

if [ ${#DETECTED[@]} -eq 0 ]; then exit 0; fi
mapfile -t UNIQUE < <(printf '%s\n' "${DETECTED[@]}" | sort -u)
if [ ${#UNIQUE[@]} -eq 0 ]; then exit 0; fi

# Alias-Mapping
declare -A ALIASES=(
  [react]=react [next]=next [vue]=vue [svelte]=svelte [express]=express
  [tailwindcss]=tailwind [prisma]=prisma [zustand]=zustand [playwright]=playwright
  [fastify]=fastify [gin]=gin [fiber]=fiber [gorm]=gorm
  [django]=django [flask]=flask [fastapi]=fastapi
  [tokio]=tokio [axum]=axum [serde]=serde
  [alpinejs]=alpinejs [htmx]=htmx [bootstrap]=bootstrap
)

MAPPED=()
for fw in "${UNIQUE[@]}"; do
  MAPPED+=("${ALIASES[${fw,,}]:-${fw,,}}")
done

# Pro Agent+Framework Marker — nur neue Frameworks anzeigen
NEW_FW=()
for fw in "${MAPPED[@]}"; do
  MARKER="/tmp/synapse-fwdocs-${AGENT_ID}-${fw}.marker"
  if [ ! -f "$MARKER" ]; then
    NEW_FW+=("$fw")
    touch "$MARKER"
  fi
done

if [ ${#NEW_FW[@]} -eq 0 ]; then exit 0; fi

FW_LIST=$(printf '%s, ' "${NEW_FW[@]}")
FW_LIST="${FW_LIST%, }"

CONTEXT_MSG="=== SYNAPSE TECH-DOCS ===\nErkannte Frameworks: ${FW_LIST}\n\nDocs verfuegbar! Abrufen mit:\n  search_tech_docs(query: \"${FW_LIST}\", scope: \"all\")"

jq -nc --arg c "$(printf '%b' "$CONTEXT_MSG")" \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$c}}'

exit 0
