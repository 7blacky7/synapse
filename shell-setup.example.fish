# ===========================================
# SYNAPSE SHELL-SETUP (Fish)
# ===========================================
# Fuege diese Zeilen in ~/.config/fish/config.fish ein.
# Der Hook bezieht API-URL und Token aus ~/.synapse/file-watcher/config.json
# oder SYNAPSE_API_URL / SYNAPSE_API_TOKEN.

# Claude Code mit automatischem Context-Handoff + volle Rechte
# claude-session.sh liest Synapse-Kontext (Handoff-Thoughts, Chat) beim Start
# --dangerously-skip-permissions: Agenten koennen ohne Rueckfrage arbeiten
alias cc "bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh --dangerously-skip-permissions"
