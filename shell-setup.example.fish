# ===========================================
# SYNAPSE SHELL-SETUP (Fish)
# ===========================================
# Fuege diese Zeilen in ~/.config/fish/config.fish ein.
# Wird von Synapse Hooks und Scripts benoetigt (chat-notify, coordinator-watch, event-check).

# Synapse DB-URL fuer Hooks und Scripts
# WICHTIG: Ohne diese Variable funktionieren Chat-Notifications und Event-Watcher NICHT.
set -gx SYNAPSE_DB_URL "postgresql://synapse:password@localhost:5432/synapse"
