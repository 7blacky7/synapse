#!/usr/bin/env bash
# post-edit-framework-docs.sh
# Erkennt Frameworks in bearbeiteten Code-Dateien und zeigt verfuegbare Docs an
# Liest aus Synapse Qdrant 6333: tech_docs_cache Collection
# Integriert in Synapse — nutzt dasselbe System wie search_tech_docs / add_tech_doc

set -euo pipefail

INPUT=$(cat)
if [ -z "$INPUT" ]; then exit 0; fi
if ! command -v jq &>/dev/null; then exit 0; fi

# Dateipfad aus tool_input extrahieren
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
if [ -z "$FILE_PATH" ]; then exit 0; fi

# Extension pruefen
EXT="${FILE_PATH##*.}"
EXT="${EXT,,}" # lowercase

declare -A LANG_MAP=(
  [tsx]=javascript [ts]=javascript [jsx]=javascript [js]=javascript
  [vue]=javascript [svelte]=javascript [mjs]=javascript [cjs]=javascript
  [go]=go
  [py]=python
  [rb]=ruby
  [rs]=rust
  [php]=php
  [css]=css [scss]=css [sass]=css [less]=css
  [html]=html [htm]=html [ejs]=html [hbs]=html
  [tmpl]=html [gohtml]=html [pug]=html
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
    # from 'package' / require('package') / import 'package'
    while IFS= read -r pkg; do
      pkg="${pkg%%/*}"  # @scope/pkg -> @scope (handled below)
      pkg="${pkg#@}"    # @scope -> scope
      if [ -n "$pkg" ] && [ "${#pkg}" -gt 1 ]; then
        DETECTED+=("$pkg")
      fi
    done < <(echo "$FILE_CONTENT" | grep -oP "(?:from\s+['\"]|require\s*\(['\"])(@?[a-z0-9][\w./-]*)" | grep -oP "['\"](@?[a-z0-9][\w./-]*)" | tr -d "\"'" || true)
    ;;
  go)
    while IFS= read -r pkg; do
      # Nur externe Packages (github.com, golang.org, etc.)
      if echo "$pkg" | grep -qP '^(github\.com|gitlab\.com|golang\.org|google\.golang\.org|gopkg\.in|go\.uber\.org|go\.etcd\.io|k8s\.io|gorm\.io)'; then
        short="${pkg##*/}"
        if [ -n "$short" ]; then
          DETECTED+=("$short")
        fi
      fi
    done < <(echo "$FILE_CONTENT" | grep -oP '["'"'"'`]([^"'"'"'`]+)["'"'"'`]' | tr -d '"'"'"'`' || true)
    ;;
  python)
    STDLIBS="os sys json re typing datetime collections logging time math random io pathlib functools itertools"
    while IFS= read -r pkg; do
      if ! echo " $STDLIBS " | grep -q " $pkg "; then
        DETECTED+=("$pkg")
      fi
    done < <(echo "$FILE_CONTENT" | grep -oP '(?:^|\n)\s*(?:from|import)\s+([a-z_][a-z0-9_]*)' | grep -oP '[a-z_][a-z0-9_]*$' || true)
    ;;
  rust)
    while IFS= read -r pkg; do
      if [ "$pkg" != "std" ] && [ "$pkg" != "core" ] && [ "$pkg" != "alloc" ]; then
        DETECTED+=("$pkg")
      fi
    done < <(echo "$FILE_CONTENT" | grep -oP 'use\s+([a-z_][a-z0-9_]*)::' | grep -oP '[a-z_][a-z0-9_]*(?=::)' || true)
    ;;
  ruby)
    while IFS= read -r pkg; do
      pkg="${pkg%%/*}"
      DETECTED+=("$pkg")
    done < <(echo "$FILE_CONTENT" | grep -oP "require\s+['\"]([^'\"]+)['\"]" | grep -oP "['\"][^'\"]+['\"]" | tr -d "\"'" || true)
    ;;
  php)
    while IFS= read -r pkg; do
      DETECTED+=("${pkg,,}")
    done < <(echo "$FILE_CONTENT" | grep -oP 'use\s+([A-Z][a-zA-Z0-9]*)' | grep -oP '[A-Z][a-zA-Z0-9]*' || true)
    ;;
  css)
    if echo "$FILE_CONTENT" | grep -q '@tailwind\|@apply'; then DETECTED+=("tailwindcss"); fi
    if echo "$FILE_CONTENT" | grep -q 'bootstrap\|--bs-'; then DETECTED+=("bootstrap"); fi
    ;;
  html)
    if echo "$FILE_CONTENT" | grep -qP 'x-data\s*=|x-show\s*=|x-model\s*='; then DETECTED+=("alpinejs"); fi
    if echo "$FILE_CONTENT" | grep -qP 'hx-get\s*=|hx-post\s*=|hx-trigger\s*='; then DETECTED+=("htmx"); fi
    if echo "$FILE_CONTENT" | grep -qP 'v-model\s*=|v-if\s*=|v-for\s*='; then DETECTED+=("vue"); fi
    if echo "$FILE_CONTENT" | grep -q 'cdn\.tailwindcss\.com\|tailwind'; then DETECTED+=("tailwindcss"); fi
    if echo "$FILE_CONTENT" | grep -qP 'class\s*=.*(?:btn|container|row|col-|navbar|modal)'; then DETECTED+=("bootstrap"); fi
    ;;
esac

# Deduplizieren
if [ ${#DETECTED[@]} -eq 0 ]; then exit 0; fi
UNIQUE=($(printf '%s\n' "${DETECTED[@]}" | sort -u))
if [ ${#UNIQUE[@]} -eq 0 ]; then exit 0; fi

# Framework-Alias-Mapping
declare -A ALIASES=(
  [gin]=gin [echo]=echo-go [fiber]=fiber [gorm]=gorm [cobra]=cobra [viper]=viper
  [mux]=gorilla-mux [chi]=chi [sqlx]=sqlx [pgx]=pgx [zap]=zap [testify]=testify
  [react]=react [next]=next [vue]=vue [svelte]=svelte [express]=express [axios]=axios
  [tailwindcss]=tailwind [prisma]=prisma [zustand]=zustand [playwright]=playwright
  [django]=django [flask]=flask [fastapi]=fastapi [sqlalchemy]=sqlalchemy [pytest]=pytest
  [pandas]=pandas [numpy]=numpy [tokio]=tokio [axum]=axum [serde]=serde
  [alpinejs]=alpinejs [htmx]=htmx [bootstrap]=bootstrap [jquery]=jquery
  [fastify]=fastify
)

MAPPED=()
for fw in "${UNIQUE[@]}"; do
  fl="${fw,,}"
  MAPPED+=("${ALIASES[$fl]:-$fl}")
done

# ============================================
# Synapse Qdrant 6333 abfragen (tech_docs_cache)
# ============================================
QDRANT_HOST="${QDRANT_URL:-http://192.168.50.65:6333}"
# URL normalisieren (QDRANT_URL kann mit http:// kommen)
QDRANT_HOST="${QDRANT_HOST%/}"

query_synapse_docs() {
  local framework="$1"
  curl -s --max-time 3 \
    -X POST "${QDRANT_HOST}/collections/tech_docs_cache/points/scroll" \
    -H 'Content-Type: application/json' \
    -d "{\"limit\":5,\"filter\":{\"must\":[{\"key\":\"framework\",\"match\":{\"value\":\"${framework}\"}}]},\"with_payload\":true}" 2>/dev/null || echo '{}'
}

FW_LIST=$(printf '%s, ' "${MAPPED[@]}")
FW_LIST="${FW_LIST%, }"

# Alle erkannten Frameworks abfragen
DOCS_OUTPUT=""
TOTAL_DOCS=0

for fw in "${MAPPED[@]}"; do
  RESULT=$(query_synapse_docs "$fw")
  COUNT=$(echo "$RESULT" | jq '.result.points | length // 0' 2>/dev/null || echo 0)

  if [ "$COUNT" -gt 0 ]; then
    DOCS_OUTPUT+="\n[${fw}] ${COUNT} Docs gefunden:"
    for i in $(seq 0 $((COUNT - 1))); do
      TYPE=$(echo "$RESULT" | jq -r ".result.points[$i].payload.type // \"?\"")
      SECTION=$(echo "$RESULT" | jq -r ".result.points[$i].payload.section // \"\"")
      CONTENT=$(echo "$RESULT" | jq -r ".result.points[$i].payload.content // \"\"" | head -c 150)
      DOCS_OUTPUT+="\n  [${TYPE}] ${SECTION}: ${CONTENT}..."
    done
    TOTAL_DOCS=$((TOTAL_DOCS + COUNT))
  fi
done

# Context-Message bauen
if [ "$TOTAL_DOCS" -gt 0 ]; then
  CONTEXT_MSG="=== SYNAPSE TECH-DOCS ===\nErkannte Frameworks: ${FW_LIST}${DOCS_OUTPUT}\n\nMehr Context: search_tech_docs(query: \"...\", scope: \"all\") fuer globale + projekt-spezifische Docs."
else
  CONTEXT_MSG="=== SYNAPSE TECH-DOCS ===\nErkannte Frameworks: ${FW_LIST}\n\nContext7-Docs verfuegbar! Abrufen mit:\n  search_tech_docs(query: \"${FW_LIST}\", scope: \"all\")\nLaedt automatisch von Context7 und indexiert global."
fi

# Output als JSON
jq -nc --arg c "$(printf '%b' "$CONTEXT_MSG")" \
  '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$c}}'

exit 0
