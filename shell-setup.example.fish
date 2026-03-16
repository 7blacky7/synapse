# ===========================================
# SYNAPSE SHELL-SETUP (Fish)
# ===========================================
# Fuege diese Zeilen in ~/.config/fish/config.fish ein.
# Wird von Synapse Hooks, Scripts und Context-Handoff benoetigt.

# Synapse DB-URL fuer Hooks und Scripts
# WICHTIG: Ohne diese Variable funktionieren Chat-Notifications, Event-Watcher
# und Coordinator-Watch NICHT.
set -gx SYNAPSE_DB_URL "postgresql://synapse:password@localhost:5432/synapse"

# Claude Code mit automatischem Context-Handoff + volle Rechte
# claude-session.sh liest Synapse-Kontext (Handoff-Thoughts, Chat) beim Start
# --dangerously-skip-permissions: Agenten koennen ohne Rueckfrage arbeiten
alias cc "bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh --dangerously-skip-permissions"
