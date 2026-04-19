#!/usr/bin/env bash
# ============================================================
# E2E-Test-Szenarien fuer Synapse FileWatcher Daemon
#
# Prueft: HTTP-API, Polling, Worker-Lifecycle, Multi-Projekt,
# Fehlerfaelle, Daemon-Restart.
# ============================================================
set -uo pipefail
# Kein `set -e` — wait_for_log soll bei Timeout nicht das Skript killen,
# sondern als FAIL in der Scoreboard auftauchen.

DAEMON_BIN="${DAEMON_BIN:-/tmp/synapse-fwd}"
PORT=7878
BASE="http://127.0.0.1:$PORT"
LOG=/tmp/fwd_e2e.log
PID_FILE=/tmp/fwd_e2e.pid

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0
fail=0

# ---------- Helpers ----------
assert() {
    local name="$1"; shift
    if "$@"; then
        echo -e "${GREEN}PASS${NC} $name"
        pass=$((pass+1))
    else
        echo -e "${RED}FAIL${NC} $name"
        fail=$((fail+1))
    fi
}

# Wartet auf Log-Muster und scored es direkt als PASS/FAIL.
assert_log() {
    local name="$1"; local pattern="$2"; local timeout="${3:-5}"
    if wait_for_log "$pattern" "$timeout"; then
        echo -e "${GREEN}PASS${NC} $name"
        pass=$((pass+1))
    else
        echo -e "${RED}FAIL${NC} $name (log-pattern nicht gefunden: $pattern)"
        fail=$((fail+1))
    fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Startet den Daemon detached. Standardmaessig frische Config. Mit
# --keep-config bleibt die bestehende config.json erhalten (fuer Restart-Test).
daemon_start() {
    if [[ "${1:-}" != "--keep-config" ]]; then
        rm -f ~/.synapse/file-watcher/config.json
        rm -rf ~/.synapse/file-watcher/projects 2>/dev/null || true
        truncate -s 0 "$LOG" 2>/dev/null || true
    fi
    nohup stdbuf -oL -eL "$DAEMON_BIN" >> "$LOG" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    local pid; pid=$(cat "$PID_FILE")
    if ! kill -0 "$pid" 2>/dev/null; then
        echo -e "${RED}FATAL: Daemon startete nicht${NC}"
        cat "$LOG"
        exit 1
    fi
}

daemon_stop() {
    if [[ -f "$PID_FILE" ]]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        wait "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
}

cleanup_all() {
    daemon_stop
    mock_stop 2>/dev/null || true
}
trap cleanup_all EXIT

# Wartet bis ein Log-Muster erscheint (Timeout in Sekunden).
wait_for_log() {
    local pattern="$1"; local timeout="${2:-5}"
    local waited=0
    while (( waited < timeout )); do
        grep -q -- "$pattern" "$LOG" && return 0
        sleep 0.2
        waited=$((waited+1))
    done
    return 1
}

# Zaehlt Events im Log fuer ein Projekt.
count_event() {
    local name="$1"; local typ="$2"
    grep -c -- "\[$name\] $typ " "$LOG" || true
}

# ============================================================
# Szenarien
# ============================================================

echo "=========================================="
echo "  FileWatcher Daemon — E2E Szenarien"
echo "=========================================="

daemon_start

# ---- Szenario 1: /health ----
resp=$(curl -sf "$BASE/health")
assert "1-health-200" [ -n "$resp" ]
assert "1-health-contains-ok" grep -q '"status":"ok"' <<< "$resp"

# ---- Szenario 2: Host-Status ----
resp=$(curl -sf "$BASE/host/status")
assert "2-host-status-online" grep -q '"online":true' <<< "$resp"

# ---- Szenario 3: Leere Projektliste ----
resp=$(curl -sf "$BASE/projects")
assert "3-empty-projects" grep -q '"projekte":\[\]' <<< "$resp"

# ---- Szenario 4: Projekt registrieren ----
TEST_DIR_A=/tmp/fw_test_a
rm -rf "$TEST_DIR_A" && mkdir -p "$TEST_DIR_A"
resp=$(curl -sf -X POST "$BASE/projects" -d '{"name":"A","pfad":"'"$TEST_DIR_A"'"}')
assert "4-register-A-ok" grep -q '"ok":true' <<< "$resp"
wait_for_log "\[A\] initial"
assert "4-worker-A-started" grep -q '\[daemon\] gestartet: A' "$LOG"

# ---- Szenario 5: File-Add ----
sleep 0.5
echo hallo > "$TEST_DIR_A/foo.txt"
assert_log "5-add-event" "\[A\] added $TEST_DIR_A/foo.txt" 5

# ---- Szenario 6: File-Modify ----
sleep 2   # warten bis busy-mode zyklisch feuert und mtime sich aendert
echo welt > "$TEST_DIR_A/foo.txt"
assert_log "6-modify-event" "\[A\] modified $TEST_DIR_A/foo.txt" 6

# ---- Szenario 7: File-Delete ----
rm "$TEST_DIR_A/foo.txt"
assert_log "7-delete-event" "\[A\] deleted $TEST_DIR_A/foo.txt" 6

# ---- Szenario 8: Verschachtelte Directories ----
mkdir -p "$TEST_DIR_A/sub/deep"
echo x > "$TEST_DIR_A/sub/deep/tief.txt"
assert_log "8-nested-add" "\[A\] added $TEST_DIR_A/sub/deep/tief.txt" 6

# ---- Szenario 9: Duplicate registration → 409 ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" \
    -d '{"name":"A","pfad":"'"$TEST_DIR_A"'"}')
assert "9-duplicate-409" [ "$code" = "409" ]

# ---- Szenario 10: Ungueltiger Pfad → 400 ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" \
    -d '{"name":"B","pfad":"/definitiv/gibts/nicht"}')
assert "10-bad-path-400" [ "$code" = "400" ]

# ---- Szenario 11: Malformed JSON → 400 ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" -d '{nope')
assert "11-bad-json-400" [ "$code" = "400" ]

# ---- Szenario 12: Unknown project 404 ----
code=$(curl -sw "%{http_code}" -o /dev/null "$BASE/projects/gibtsnicht/status")
assert "12-unknown-404" [ "$code" = "404" ]

# ---- Szenario 13: Zweites Projekt parallel ----
TEST_DIR_B=/tmp/fw_test_b
rm -rf "$TEST_DIR_B" && mkdir -p "$TEST_DIR_B"
curl -sf -X POST "$BASE/projects" -d '{"name":"B","pfad":"'"$TEST_DIR_B"'"}' >/dev/null
wait_for_log "\[B\] initial"
assert "13-multi-project-started" grep -q '\[daemon\] gestartet: B' "$LOG"
echo parallel > "$TEST_DIR_B/hello.txt"
assert_log "13-multi-project-event" "\[B\] added $TEST_DIR_B/hello.txt" 6

# ---- Szenario 14: Disable stoppt Worker ----
curl -sf -X POST "$BASE/projects/B/disable" >/dev/null
sleep 2
# Nach disable sollte der Worker sich beenden
assert "14-disable-logs-stop" grep -q '\[B\] Flag weg' "$LOG"
# Projekt trotzdem in Config
resp=$(curl -sf "$BASE/projects/B/status")
assert "14-disable-persisted" grep -q '"enabled":false' <<< "$resp"

# ---- Szenario 15: Re-Enable startet neuen Worker ----
before_initial=$(grep -c "\[B\] initial" "$LOG" || true)
curl -sf -X POST "$BASE/projects/B/enable" >/dev/null
sleep 1.5
after_initial=$(grep -c "\[B\] initial" "$LOG" || true)
assert "15-reenable-new-worker" [ "$after_initial" -gt "$before_initial" ]

# ---- Szenario 16: Delete entfernt Projekt ----
curl -sf -X DELETE "$BASE/projects/B" >/dev/null
resp=$(curl -sf "$BASE/projects")
not_in_list() { ! grep -q '"name":"B"' <<< "$resp"; }
assert "16-delete-removes-from-list" not_in_list

# ---- Szenario 17: Stress — 20 Dateien schnell ----
for i in $(seq 1 20); do
    echo "stress-$i" > "$TEST_DIR_A/stress_$i.txt"
done
sleep 3
adds=$(grep -c "\[A\] added $TEST_DIR_A/stress_" "$LOG" || true)
assert "17-stress-all-20-detected" [ "$adds" -eq 20 ]

# ---- Szenario 18: Daemon-Restart → Config wird geladen, Worker starten ----
daemon_stop
sleep 0.5
# Config jetzt persistent — bei Restart sollte A automatisch starten
daemon_start --keep-config
sleep 1
resp=$(curl -sf "$BASE/projects")
assert "18-restart-config-loaded" grep -q '"name":"A"' <<< "$resp"
assert_log "18-restart-worker-respawned" "\[daemon\] gestartet: A" 3

# ---- Szenario 19: Missing field: name ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" -d '{"pfad":"/tmp"}')
assert "19-missing-name-400" [ "$code" = "400" ]

# ---- Szenario 20: Missing field: pfad ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" -d '{"name":"X"}')
assert "20-missing-pfad-400" [ "$code" = "400" ]

# ---- Szenario 21: File-Move (mv foo bar) → delete-und-add-Paar ----
TEST_DIR_C=/tmp/fw_test_c
rm -rf "$TEST_DIR_C" && mkdir -p "$TEST_DIR_C"
curl -sf -X POST "$BASE/projects" -d '{"name":"C","pfad":"'"$TEST_DIR_C"'"}' >/dev/null
wait_for_log "\[C\] initial"
echo original > "$TEST_DIR_C/original.txt"
assert_log "21-initial-file-added" "\[C\] added $TEST_DIR_C/original.txt" 8
mv "$TEST_DIR_C/original.txt" "$TEST_DIR_C/umbenannt.txt"
assert_log "21-move-detects-delete" "\[C\] deleted $TEST_DIR_C/original.txt" 5
assert_log "21-move-detects-add" "\[C\] added $TEST_DIR_C/umbenannt.txt" 5

# ---- Szenario 22: Hidden files (beginnen mit .) ----
echo hidden > "$TEST_DIR_C/.versteckt"
assert_log "22-hidden-file-detected" "\[C\] added $TEST_DIR_C/.versteckt" 5

# ---- Szenario 23: Filename mit Leerzeichen + Umlauten ----
echo x > "$TEST_DIR_C/mit Leerzeichen und Üäö.txt"
sleep 3
adds=$(grep -F -c "Leerzeichen" "$LOG" || true)
assert "23-special-chars" [ "$adds" -ge 1 ]

# ---- Szenario 24: Disable → watcher_running=false ----
curl -sf -X POST "$BASE/projects/C/disable" >/dev/null
sleep 2
resp=$(curl -sf "$BASE/projects/C/status")
assert "24-disable-watcher-running-false" grep -q '"watcher_running":false' <<< "$resp"

# ---- Szenario 25: PUT auf /projects → 404 (Methode nicht unterstuetzt) ----
code=$(curl -sw "%{http_code}" -o /dev/null -X PUT "$BASE/projects")
assert "25-unsupported-method-404" [ "$code" = "404" ]

# ---- Szenario 26: Performance — 50 Adds in einem Schwung ----
curl -sf -X POST "$BASE/projects/C/enable" >/dev/null
wait_for_log "\[C\] initial" 3
TEST_DIR_D=/tmp/fw_test_d
rm -rf "$TEST_DIR_D" && mkdir -p "$TEST_DIR_D"
curl -sf -X POST "$BASE/projects" -d '{"name":"D","pfad":"'"$TEST_DIR_D"'"}' >/dev/null
wait_for_log "\[D\] initial"
start_ms=$(date +%s%3N)
for i in $(seq 1 50); do
    echo "burst-$i" > "$TEST_DIR_D/file_$i.txt"
done
sleep 4
end_ms=$(date +%s%3N)
adds=$(grep -c "\[D\] added $TEST_DIR_D/file_" "$LOG" || true)
elapsed=$((end_ms - start_ms))
echo "  (50 Adds in ${elapsed}ms gemessen, $adds erkannt)"
assert "26-perf-all-50-detected" [ "$adds" -eq 50 ]

# ---- Szenario 27: Empty body POST → 400 ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" -d '')
assert "27-empty-body-400" [ "$code" = "400" ]

# ---- Szenario 28: Malformed URL (doppelslash) → 404 ----
code=$(curl -sw "%{http_code}" -o /dev/null "$BASE/projects//foo")
assert "28-double-slash-404" [ "$code" = "404" ]

# ---- Szenario 29: Tiefe Verschachtelung (5 Ebenen) ----
DEEP="$TEST_DIR_A/a/b/c/d/e"
mkdir -p "$DEEP"
echo deep > "$DEEP/tief.txt"
assert_log "29-deep-nested-add" "\[A\] added $DEEP/tief.txt" 6

# ---- Szenario 30: Symlinks zu Datei innerhalb des Projekts ----
# (Polling liest mtime von dem Link-Ziel — erwartet: erkannt wie normale Datei)
echo target > "$TEST_DIR_A/link_target.txt"
ln -s "$TEST_DIR_A/link_target.txt" "$TEST_DIR_A/mein_link"
sleep 3
# dir_list listet den Link-Namen, datei_mtime follow-ed den Symlink (stat)
# -> sollte in snap als pfad mit mtime erscheinen
has_link=$(grep -c "\[A\] added $TEST_DIR_A/mein_link" "$LOG" || true)
assert "30-symlink-seen" [ "$has_link" -ge 1 ]

# ---- Szenario 31: Konkurrierende POSTs (2 Projekte parallel registrieren) ----
TEST_DIR_E=/tmp/fw_test_e
TEST_DIR_F=/tmp/fw_test_f
rm -rf "$TEST_DIR_E" "$TEST_DIR_F" && mkdir -p "$TEST_DIR_E" "$TEST_DIR_F"
(
    curl -sf -X POST "$BASE/projects" -d '{"name":"E","pfad":"'"$TEST_DIR_E"'"}' >/dev/null &
    curl -sf -X POST "$BASE/projects" -d '{"name":"F","pfad":"'"$TEST_DIR_F"'"}' >/dev/null &
    wait
)
sleep 2
resp=$(curl -sf "$BASE/projects")
has_e=$(grep -c '"name":"E"' <<< "$resp" || true)
has_f=$(grep -c '"name":"F"' <<< "$resp" || true)
both_concurrent() { [ "${has_e:-0}" -ge 1 ] && [ "${has_f:-0}" -ge 1 ]; }
assert "31-concurrent-both-registered" both_concurrent

# ---- Szenario 32: Status fuer beide konkurrent erstellten Projekte ----
assert_log "32-worker-E-gestartet" "\[daemon\] gestartet: E" 3
assert_log "32-worker-F-gestartet" "\[daemon\] gestartet: F" 3

# ---- Szenario 33: POST ohne Content-Type-Header ----
code=$(curl -sw "%{http_code}" -o /dev/null -X POST "$BASE/projects" \
    -H "" -d '{"name":"Z","pfad":"/tmp"}')
# Darf 200 oder 400 sein (Pfad /tmp wird existieren) — Daemon darf nicht crashen
not_5xx_or_hang() { [ "$code" != "500" ] && [ "$code" != "000" ]; }
assert "33-no-content-type-not-5xx" not_5xx_or_hang

# ============================================================
# Event-Forwarder-Szenarien (HTTP-POST an Mock-Receiver)
# ============================================================

MOCK_PORT=7999
MOCK_RECEIVED=/tmp/fw_mock_received.jsonl
MOCK_PID_FILE=/tmp/fw_mock.pid

mock_start() {
    rm -f "$MOCK_RECEIVED"
    python3 -c "
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n)
        with open('$MOCK_RECEIVED', 'a') as f: f.write(body.decode() + '\n')
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', $MOCK_PORT), H).serve_forever()
" &
    echo $! > "$MOCK_PID_FILE"
    sleep 0.5
}

mock_stop() {
    [ -f "$MOCK_PID_FILE" ] && kill "$(cat "$MOCK_PID_FILE")" 2>/dev/null || true
    rm -f "$MOCK_PID_FILE"
}

# ---- Szenario 34: Daemon mit synapse_api_url konfiguriert → Events landen am Mock ----
daemon_stop
mock_start
cat > ~/.synapse/file-watcher/config.json <<JSON
{"port":$PORT,"projekte":[],"synapse_api_url":"http://127.0.0.1:$MOCK_PORT/fs-events"}
JSON
daemon_start --keep-config
TEST_DIR_G=/tmp/fw_test_g
rm -rf "$TEST_DIR_G" && mkdir -p "$TEST_DIR_G"
curl -sf -X POST "$BASE/projects" -d '{"name":"G","pfad":"'"$TEST_DIR_G"'"}' >/dev/null
wait_for_log "\[G\] initial" 3
sleep 0.5
echo mock_event > "$TEST_DIR_G/datei.txt"
sleep 3

received_count=$(wc -l < "$MOCK_RECEIVED" 2>/dev/null || echo 0)
assert "34-forwarder-post-count" [ "${received_count:-0}" -ge 1 ]

# Body muss projekt + typ + pfad enthalten
if [ -s "$MOCK_RECEIVED" ]; then
    first_body=$(head -1 "$MOCK_RECEIVED")
    has_projekt() { grep -q '"projekt":"G"' <<< "$first_body"; }
    has_typ_added() { grep -q '"typ":"added"' <<< "$first_body"; }
    has_pfad() { grep -q '"pfad":"/tmp/fw_test_g/datei.txt"' <<< "$first_body"; }
    assert "34-body-has-projekt" has_projekt
    assert "34-body-has-typ-added" has_typ_added
    assert "34-body-has-pfad" has_pfad
fi

# ---- Szenario 35: Delete-Event ebenfalls gepostet ----
before=$(wc -l < "$MOCK_RECEIVED" 2>/dev/null || echo 0)
rm "$TEST_DIR_G/datei.txt"
sleep 3
after=$(wc -l < "$MOCK_RECEIVED" 2>/dev/null || echo 0)
has_delete_more() { [ "${after:-0}" -gt "${before:-0}" ]; }
assert "35-delete-also-forwarded" has_delete_more

# ---- Szenario 36: Mock-Server down → Daemon crasht NICHT ----
mock_stop
sleep 0.5
echo crash_test > "$TEST_DIR_G/crash.txt"
sleep 3
# Daemon muss noch leben
daemon_pid=$(cat "$PID_FILE")
daemon_alive() { kill -0 "$daemon_pid" 2>/dev/null; }
assert "36-daemon-survives-down-receiver" daemon_alive
# Und weiter auf HTTP antworten
responsive() { curl -sf --max-time 2 "$BASE/health" >/dev/null; }
assert "36-daemon-still-responsive" responsive

# ============================================================
# Ergebnis
# ============================================================
echo
echo "=========================================="
if (( fail == 0 )); then
    echo -e "${GREEN}Alle $pass Szenarien bestanden.${NC}"
else
    echo -e "${RED}$fail von $((pass+fail)) Szenarien fehlgeschlagen.${NC}"
    echo "Log: $LOG"
fi
echo "=========================================="
exit $fail
