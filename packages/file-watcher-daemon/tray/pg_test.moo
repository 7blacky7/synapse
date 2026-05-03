importiere pg_client

setze db auf neu PgClient("192.168.50.65", 5432, "synapse", "synapse")
db.verbinde()
zeige "ready: " + text(db.ready)

setze sql auf "SELECT m.id::text AS id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') AS zeit FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = 'synapse' AND c.name = 'agent-id-prop' ORDER BY m.id DESC LIMIT 5"
setze r auf db.frage(sql)
zeige "rows: " + text(r["anzahl"]) + " fehler: " + text(r["fehler"])
setze i auf 0
solange i < länge(r["rows"]):
    setze m auf r["rows"][i]
    zeige m["zeit"] + " " + m["sender"] + ": " + m["content"]
    setze i auf i + 1

setze sql2 auf "SELECT id, COALESCE(model, '') AS model FROM agent_sessions WHERE project = 'synapse' AND status = 'active' ORDER BY id LIMIT 3"
setze r2 auf db.frage(sql2)
zeige "agents: " + text(r2["anzahl"])

setze sql3 auf "SELECT id::text AS id, COALESCE(file_path, '') AS file_path, COALESCE(agent_id, '<unbekannt>') AS agent_id FROM file_versions WHERE project = 'synapse' ORDER BY id DESC LIMIT 3"
setze r3 auf db.frage(sql3)
zeige "events: " + text(r3["anzahl"])

db.schliesse()
