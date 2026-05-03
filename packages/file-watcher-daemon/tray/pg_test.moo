importiere pg_client
setze db auf neu PgClient("192.168.50.65", 5432, "synapse", "synapse")
db.verbinde()
setze q auf neu QueryMessage("SELECT 1 AS eins")
db.sock.schreibe_bytes(q.zu_bytes())
setze i auf 0
solange i < 10:
    setze m auf db.empfange_eine_message()
    wenn m == nichts:
        zeige "iter " + text(i) + ": EOF"
        setze i auf 99
    sonst:
        zeige "iter " + text(i) + ": typ=" + text(m["typ"]) + " bodylen=" + text(länge(m["body"]))
        setze i auf i + 1
db.schliesse()
