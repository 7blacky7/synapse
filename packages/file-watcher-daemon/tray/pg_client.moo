# ============================================================
# moo Postgres-Client — Wire-Protocol v3 in pure moo
#
# Verbindet sich per TCP direkt mit einem Postgres-Server,
# implementiert den Startup-Handshake, sendet Simple Queries
# und parst die Binary-Responses (RowDescription + DataRow).
#
# Tests gegen lokalen Container 127.0.0.1:5433
#   user='mootest', database='mootest', trust-Auth
# ============================================================

# ------------------------------------------------------------
# Byte/Int Helfer
# ------------------------------------------------------------

funktion int32_be(n):
    # Big-Endian 4-Byte-Kodierung einer non-negativen int
    setze b0 auf boden(n / (256 * 256 * 256)) % 256
    setze b1 auf boden(n / (256 * 256)) % 256
    setze b2 auf boden(n / 256) % 256
    setze b3 auf n % 256
    gib_zurück [b0, b1, b2, b3]

funktion bytes_int16(liste, off):
    gib_zurück liste[off] * 256 + liste[off + 1]

funktion bytes_int32(liste, off):
    setze a auf liste[off] * 256 * 256 * 256
    setze b auf liste[off + 1] * 256 * 256
    setze c auf liste[off + 2] * 256
    setze d auf liste[off + 3]
    gib_zurück a + b + c + d

# Liest null-terminated C-String ab offset, gibt [text, neue_off] zurueck
funktion lies_cstr(liste, off):
    setze buchstaben auf []
    solange off < länge(liste) und liste[off] != 0:
        buchstaben.hinzufügen(liste[off])
        setze off auf off + 1
    # \0 ueberspringen
    setze off auf off + 1
    setze s auf bytes_neu(buchstaben)
    gib_zurück [s, off]

# Text in Liste<int> umwandeln
funktion text_zu_bytes(s):
    gib_zurück bytes_zu_liste(s)

# Liste anhängen (gibt neue Liste zurück fuers Fluent-Building)
funktion anhaengen_bytes(ziel, quelle):
    setze i auf 0
    solange i < länge(quelle):
        ziel.hinzufügen(quelle[i])
        setze i auf i + 1

# ------------------------------------------------------------
# Message-Klassen (Vererbung fuer unterschiedliche Request-Typen)
# ------------------------------------------------------------

klasse PgMessage:
    funktion erstelle():
        selbst.typ = "basis"

    funktion zu_bytes():
        gib_zurück []

klasse StartupMessage(PgMessage):
    funktion erstelle(user, datenbank):
        selbst.typ = "startup"
        selbst.user = user
        selbst.datenbank = datenbank

    funktion zu_bytes():
        # Payload: protocol + "user\0<user>\0database\0<db>\0\0"
        setze body auf []
        # Protocol-Version 3.0 = 196608 = 0x00030000
        anhaengen_bytes(body, int32_be(196608))
        anhaengen_bytes(body, text_zu_bytes("user"))
        body.hinzufügen(0)
        anhaengen_bytes(body, text_zu_bytes(selbst.user))
        body.hinzufügen(0)
        anhaengen_bytes(body, text_zu_bytes("database"))
        body.hinzufügen(0)
        anhaengen_bytes(body, text_zu_bytes(selbst.datenbank))
        body.hinzufügen(0)
        body.hinzufügen(0)
        # Gesamtlaenge inkl. Length-Feld selbst (4 bytes)
        setze gesamt auf 4 + länge(body)
        setze msg auf []
        anhaengen_bytes(msg, int32_be(gesamt))
        anhaengen_bytes(msg, body)
        gib_zurück msg

klasse QueryMessage(PgMessage):
    funktion erstelle(sql):
        selbst.typ = "query"
        selbst.sql = sql

    funktion zu_bytes():
        setze body auf []
        anhaengen_bytes(body, text_zu_bytes(selbst.sql))
        body.hinzufügen(0)
        setze gesamt auf 4 + länge(body)
        setze msg auf []
        msg.hinzufügen(81)  # 'Q'
        anhaengen_bytes(msg, int32_be(gesamt))
        anhaengen_bytes(msg, body)
        gib_zurück msg

klasse TerminateMessage(PgMessage):
    funktion erstelle():
        selbst.typ = "terminate"

    funktion zu_bytes():
        gib_zurück [88, 0, 0, 0, 4]  # 'X' + length=4

# ------------------------------------------------------------
# PgClient: Verbindung + Query-Loop
# ------------------------------------------------------------

klasse PgClient:
    funktion erstelle(host, port, user, datenbank):
        selbst.host = host
        selbst.port = port
        selbst.user = user
        selbst.datenbank = datenbank
        selbst.sock = nichts
        selbst.ready = falsch
        selbst.letzte_fehler = nichts
        selbst.server_version = ""
        selbst.backend_pid = 0

    funktion verbinde():
        selbst.sock = tcp_verbinde(selbst.host, selbst.port)
        setze sm auf neu StartupMessage(selbst.user, selbst.datenbank)
        selbst.sock.schreibe_bytes(sm.zu_bytes())
        selbst.empfange_bis_ready()
        gib_zurück selbst.ready

    # Liest 1 Message: typ(1) + length(4, inkl. self) + body(length-4)
    funktion empfange_eine_message():
        setze typ_b auf selbst.sock.lesen_bytes(1)
        wenn länge(typ_b) == 0:
            gib_zurück nichts
        setze typ auf typ_b[0]
        setze laenge_b auf selbst.sock.lesen_bytes(4)
        wenn länge(laenge_b) < 4:
            gib_zurück nichts
        setze laenge auf bytes_int32(laenge_b, 0)
        setze body_len auf laenge - 4
        setze body auf []
        wenn body_len > 0:
            # Moeglicherweise in mehreren Reads
            setze rest auf body_len
            solange rest > 0:
                setze chunk auf selbst.sock.lesen_bytes(rest)
                wenn länge(chunk) == 0:
                    # EOF
                    setze rest auf 0
                sonst:
                    anhaengen_bytes(body, chunk)
                    setze rest auf rest - länge(chunk)
        setze m auf {}
        m["typ"] = typ
        m["body"] = body
        gib_zurück m

    funktion empfange_bis_ready():
        setze laeuft auf wahr
        solange laeuft:
            setze m auf selbst.empfange_eine_message()
            wenn m == nichts:
                setze laeuft auf falsch
            sonst:
                setze t auf m["typ"]
                wenn t == 82:
                    # 'R' Authentication
                    setze code auf bytes_int32(m["body"], 0)
                    wenn code != 0:
                        selbst.letzte_fehler = "Authentication nicht trivial: " + text(code)
                        setze laeuft auf falsch
                sonst wenn t == 83:
                    # 'S' ParameterStatus
                    setze erg auf lies_cstr(m["body"], 0)
                    setze name auf erg[0]
                    setze erg2 auf lies_cstr(m["body"], erg[1])
                    setze wert auf erg2[0]
                    wenn name == "server_version":
                        setze selbst.server_version auf wert
                sonst wenn t == 75:
                    # 'K' BackendKeyData
                    selbst.backend_pid = bytes_int32(m["body"], 0)
                sonst wenn t == 90:
                    # 'Z' ReadyForQuery
                    selbst.ready = wahr
                    setze laeuft auf falsch
                sonst wenn t == 69:
                    # 'E' ErrorResponse
                    setze selbst.letzte_fehler auf selbst.parse_fehler(m["body"])
                    setze laeuft auf falsch
                sonst wenn t == 78:
                    # 'N' NoticeResponse — ignorieren
                    setze ignore auf 0

    funktion parse_fehler(body):
        setze off auf 0
        setze meldung auf ""
        solange off < länge(body) und body[off] != 0:
            setze feld_typ auf body[off]
            setze off auf off + 1
            setze erg auf lies_cstr(body, off)
            setze inhalt auf erg[0]
            setze off auf erg[1]
            wenn feld_typ == 77:
                # 'M' Message
                setze meldung auf inhalt
        gib_zurück meldung

    funktion parse_row_description(body):
        setze felder auf []
        setze n auf bytes_int16(body, 0)
        setze off auf 2
        setze i auf 0
        solange i < n:
            setze erg auf lies_cstr(body, off)
            setze name auf erg[0]
            setze off auf erg[1]
            # table_oid(4) + col_attr(2) + type_oid(4) + type_size(2) + type_mod(4) + format(2) = 18 Bytes
            setze off auf off + 18
            felder.hinzufügen(name)
            setze i auf i + 1
        gib_zurück felder

    funktion parse_data_row(body, spalten):
        setze n auf bytes_int16(body, 0)
        setze off auf 2
        setze row auf {}
        setze i auf 0
        solange i < n:
            setze laenge auf bytes_int32(body, off)
            setze off auf off + 4
            wenn laenge == -1:
                row[spalten[i]] = nichts
            sonst:
                setze wert_bytes auf []
                setze j auf 0
                solange j < laenge:
                    wert_bytes.hinzufügen(body[off + j])
                    setze j auf j + 1
                row[spalten[i]] = bytes_neu(wert_bytes)
                setze off auf off + laenge
            setze i auf i + 1
        gib_zurück row

    # Simple Query — liefert Dict mit "rows", "spalten", "anzahl", "fehler"
    funktion frage(sql):
        setze q auf neu QueryMessage(sql)
        selbst.sock.schreibe_bytes(q.zu_bytes())
        setze ergebnis auf {}
        ergebnis["spalten"] = []
        ergebnis["rows"] = []
        ergebnis["anzahl"] = 0
        ergebnis["fehler"] = nichts
        ergebnis["tag"] = ""
        setze spalten auf []
        setze laeuft auf wahr
        solange laeuft:
            setze m auf selbst.empfange_eine_message()
            wenn m == nichts:
                setze laeuft auf falsch
            sonst:
                setze t auf m["typ"]
                wenn t == 84:
                    # 'T' RowDescription
                    setze spalten auf selbst.parse_row_description(m["body"])
                    ergebnis["spalten"] = spalten
                sonst wenn t == 68:
                    # 'D' DataRow
                    setze row auf selbst.parse_data_row(m["body"], spalten)
                    ergebnis["rows"].hinzufügen(row)
                sonst wenn t == 67:
                    # 'C' CommandComplete
                    setze erg auf lies_cstr(m["body"], 0)
                    ergebnis["tag"] = erg[0]
                sonst wenn t == 73:
                    # 'I' EmptyQueryResponse — ignorieren
                    setze ignore auf 0
                sonst wenn t == 69:
                    # 'E' ErrorResponse
                    ergebnis["fehler"] = selbst.parse_fehler(m["body"])
                sonst wenn t == 90:
                    # 'Z' ReadyForQuery
                    setze laeuft auf falsch
                sonst wenn t == 78:
                    # 'N' NoticeResponse ignorieren
                    setze ignore auf 0
        ergebnis["anzahl"] = länge(ergebnis["rows"])
        gib_zurück ergebnis

    funktion schliesse():
        wenn selbst.sock != nichts:
            setze tm auf neu TerminateMessage()
            selbst.sock.schreibe_bytes(tm.zu_bytes())
            selbst.sock.schliessen()
            setze selbst.sock auf nichts

