package main

// P8-T17: ausschliesslich httptest-APIs und Fyne-Testtreiber.
// Die Basis-Rotkontrolle prueft den registrierten PG-Zugang als Ergebnis
// und bricht VOR einem Fehler-Reload ab: auch am Basisstand keine Live-DB.
import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	fynetest "fyne.io/fyne/v2/test"
	"fyne.io/fyne/v2/widget"
)

func p8t17KeinPG(t *testing.T) {
	t.Helper()
	for _, driver := range sql.Drivers() {
		if driver == "postgres" {
			t.Fatal("Tray hat weiterhin einen registrierten PostgreSQL-Zugang; Fehler-Reload wird zum Schutz der Live-DB nicht ausgefuehrt")
		}
	}
}

func TestP8T17KeinPostgresZugang(t *testing.T) { p8t17KeinPG(t) }

// Verhindert echte Requests auch dann, wenn apiBases weitere Standardadressen
// probiert. Nur die ausdruecklich erlaubten httptest-Server sind erreichbar.
func p8t17NurAttrappen(t *testing.T, urls ...string) {
	t.Helper()
	old := apiHttpClient
	allowed := map[string]bool{}
	for _, u := range urls { allowed[u] = true }
	apiHttpClient = &http.Client{Timeout: time.Second, Transport: chatTransport(func(r *http.Request) (*http.Response, error) {
		if !allowed[r.URL.Scheme+"://"+r.URL.Host] {
			return nil, fmt.Errorf("gesperrte Testadresse")
		}
		return http.DefaultTransport.RoundTrip(r)
	})}
	t.Cleanup(func() { apiHttpClient = old })
}

// Reflexion ermoeglicht dieselben Tests am Basisstand: dort fehlt nur das
// Statuslabel, das getestete Ergebnis ist dann leer statt "API nicht erreichbar".
// Keine neuen Exporte/Felder als Compile-Rotkontrolle.
func p8t17Label(obj interface{}, name string) *widget.Label {
	field := reflect.ValueOf(obj).Elem().FieldByName(name)
	if !field.IsValid() { return nil }
	label := widget.NewLabel("")
	field.Set(reflect.ValueOf(label))
	return label
}

func p8t17Detail() *DetailWindow {
	w := &DetailWindow{ProjectName: "sol14-fixture"}
	w.AgentTable = neueTabelle([]string{"Agent","Modell","Status","Kontext","Aktivitaet"}, func() [][]string { return w.AgentRows })
	w.EventTable = neueTabelle([]string{"Zeit","Agent","Datei","Aktion","Grund","Feature"}, func() [][]string { return w.EventRows })
	w.ActivityTable = neueTabelle([]string{"Zeit","Tool","Action","Agent","OK","ms","Ergebnis"}, func() [][]string { return w.ActivityRows })
	w.filterText.Store("")
	p8t17Label(w, "AgentStatus")
	p8t17Label(w, "EventStatus")
	p8t17Label(w, "ActivityStatus")
	return w
}

func p8t17Chat() *ChatWindow {
	w := &ChatWindow{ProjectName:"sol14-fixture", ChannelName:"team"}
	w.MessageBox = container.NewVBox()
	w.MessageScroll = container.NewVScroll(w.MessageBox)
	w.AgentTable = neueTabelle([]string{"Agent","Rolle"}, func() [][]string { return w.AgentRows })
	p8t17Label(w, "MessageStatus")
	p8t17Label(w, "AgentStatus")
	return w
}

func TestP8T17APIDatenUndTransportFallback(t *testing.T) {
	p8t17KeinPG(t)
	a := fynetest.NewApp()
	defer a.Quit()
	var mu sync.Mutex
	paths := map[string]int{}
	failed := 0
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock(); failed++; mu.Unlock()
		w.WriteHeader(503)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-tray-token" { t.Error("Tray-Token aus config.json fehlt") }
		mu.Lock(); paths[r.URL.Path]++; mu.Unlock()
		w.Header().Set("Content-Type","application/json")
		switch r.URL.Path {
		case "/api/projects/sol14-fixture/agents":
			fmt.Fprint(w, `{"success":true,"agents":[{"agent_name":"fixture-agent","model":"fixture-model","status":"running","tokens_percent":"12","last_activity":"jetzt"}]}`)
		case "/api/projects/sol14-fixture/file-versions":
			fmt.Fprint(w, `{"success":true,"versions":[{"id":"10","file_path":"fixture.go","edit_action":"update","agent_id":null,"reason":"Fix\nGrund","feature_tag":null,"created_at":"2026-10-14T12:00:00Z"}]}`)
		case "/api/projects/sol14-fixture/tool-calls":
			fmt.Fprint(w, `{"success":true,"calls":[{"id":"20","ts":"2026-10-14T12:00:00Z","tool_name":"files","action":"plan","agent_id":"fixture-agent","ok":true,"duration_ms":7,"result_preview":"ok"}]}`)
		case "/api/projects/sol14-fixture/channels/team/messages":
			if r.URL.Query().Get("since_id") == "" {
				fmt.Fprint(w, `{"success":true,"order":"desc","messages":[{"id":2,"sender":"b","content":"neu","created_at":"2026-10-14T12:00:02Z"},{"id":1,"sender":"a","content":"alt","created_at":"2026-10-14T12:00:01Z"}]}`)
			} else {
				if r.URL.Query().Get("since_id") != "2" { t.Error("Polling-Cursor falsch") }
				fmt.Fprint(w, `{"success":true,"order":"asc","messages":[{"id":3,"sender":"c","content":"poll","created_at":"2026-10-14T12:00:03Z"}]}`)
			}
		case "/api/projects/sol14-fixture/channels/team/members":
			fmt.Fprint(w, `{"success":true,"members":[{"agent":"member","mitglied":true,"aktiv":true},{"agent":"poster","hat_gepostet":true}]}`)
		case "/api/projects/sol14-fixture/sessions":
			fmt.Fprint(w, `{"success":true,"sessions":[{"id":"session-agent","model":"fixture-model"}]}`)
		default: t.Errorf("unerwarteter Endpunkt: %s", r.URL.Path); w.WriteHeader(404)
		}
	}))
	defer second.Close()
	t.Setenv("SYNAPSE_API_URL", "")
	t.Setenv("SYNAPSE_API_FALLBACK_URL", "")
	t.Setenv("SYNAPSE_API_TOKEN", "")
	setupApiBaseConfig(t, map[string]string{"synapse_api_url":first.URL,"synapse_api_fallback_url":second.URL,"synapse_api_token":"fixture-tray-token"})
	p8t17NurAttrappen(t, first.URL, second.URL)

	detail, chat := p8t17Detail(), p8t17Chat()
	detail.ReloadAgenten(); detail.ReloadEvents(); detail.ReloadActivity()
	chat.ReloadAgents(); chat.ReloadMessages()
	fyne.DoAndWait(func(){})
	if len(detail.AgentRows)!=1 || detail.AgentRows[0][0]!="fixture-agent" || detail.AgentRows[0][3]!="12%" { t.Fatalf("Agentenanzeige: %v", detail.AgentRows) }
	if len(detail.EventRows)!=1 || detail.EventRows[0][1]!="<unbekannt>" || detail.EventRows[0][4]!="Fix Grund" { t.Fatalf("Versionsanzeige: %v",detail.EventRows) }
	if len(detail.ActivityRows)!=1 || detail.ActivityIDs[0]!="20" || detail.ActivityRows[0][4]!="OK" || detail.ActivityRows[0][5]!="7" { t.Fatalf("Aktivitaetsanzeige: %v",detail.ActivityRows) }
	if len(chat.AgentRows)!=2 || chat.AgentRows[0][1]!="Mitglied · aktiv" || chat.AgentRows[1][1]!="nur gepostet" { t.Fatalf("Channel-Teilnehmer: %v",chat.AgentRows) }
	if chat.LastMsgID!=2 || len(chat.MessageBox.Objects)!=2 { t.Fatalf("Erstladen/Cursor: %d/%d",chat.LastMsgID,len(chat.MessageBox.Objects)) }
	// Aufsteigende sichtbare Reihenfolge und ungekuerzter Text.
	firstBody := chat.MessageBox.Objects[0].(*fyne.Container).Objects[1].(*widget.Label)
	if firstBody.Text!="alt" { t.Fatalf("Chat-Reihenfolge: %q",firstBody.Text) }
	chat.ReloadMessages()
	fyne.DoAndWait(func(){})
	if chat.LastMsgID!=3 || len(chat.MessageBox.Objects)!=3 { t.Fatal("Polling verliert Nachrichten") }
	sessions, err := apiFetchSessions("sol14-fixture")
	if err!=nil || len(sessions)!=1 || sessions[0].Id!="session-agent" { t.Fatalf("Sessions: %v %v",sessions,err) }
	mu.Lock()
	defer mu.Unlock()
	if failed!=1 || paths["/api/projects/sol14-fixture/channels/team/messages"]!=2 { t.Fatalf("Fallback/Cache: failed=%d paths=%v",failed,paths) }
}

func TestP8T17AusfallLoeschtStaleDatenUndBewahrtChatCursor(t *testing.T) {
	p8t17KeinPG(t)
	a := fynetest.NewApp()
	defer a.Quit()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){ w.WriteHeader(503) }))
	defer bad.Close()
	t.Setenv("SYNAPSE_API_URL","")
	t.Setenv("SYNAPSE_API_FALLBACK_URL","")
	setupApiBaseConfig(t,map[string]string{"synapse_api_url":bad.URL,"synapse_api_fallback_url":bad.URL})
	p8t17NurAttrappen(t,bad.URL)
	detail,chat := p8t17Detail(),p8t17Chat()
	detail.AgentRows=[][]string{{"stale"}}
	detail.EventRows=[][]string{{"stale"}}
	detail.ActivityRows=[][]string{{"stale"}}
	detail.ActivityIDs=[]string{"old"}
	chat.AgentRows=[][]string{{"stale"}}
	chat.LastMsgID=42
	chat.MessageBox.Add(makeMsgItem("alt","user","behalten"))
	detail.ReloadAgenten(); detail.ReloadEvents(); detail.ReloadActivity()
	chat.ReloadAgents(); chat.ReloadMessages()
	fyne.DoAndWait(func(){})
	if len(detail.AgentRows)+len(detail.EventRows)+len(detail.ActivityRows)+len(detail.ActivityIDs)+len(chat.AgentRows)!=0 { t.Fatal("Ausfall zeigt veraltete Daten") }
	if chat.LastMsgID!=42 || len(chat.MessageBox.Objects)!=1 { t.Fatal("Ausfall verliert Chat-Verlauf oder Cursor") }
	for _,x := range []struct{obj interface{}; name string}{{detail,"AgentStatus"},{detail,"EventStatus"},{detail,"ActivityStatus"},{chat,"AgentStatus"},{chat,"MessageStatus"}} {
		f := reflect.ValueOf(x.obj).Elem().FieldByName(x.name)
		if !f.IsValid() || !strings.HasPrefix(f.Interface().(*widget.Label).Text,"API nicht erreichbar") { t.Fatalf("Ausfall ohne sichtbaren Status: %s",x.name) }
	}
}

// 401/403 duerfen keinen Transport-Rueckfall und keinen PG-Zugang ausloesen.
func TestP8T17AuthFehlerOhneFallback(t *testing.T) {
	p8t17KeinPG(t)
	for _,status := range []int{401,403} {
		t.Run(fmt.Sprint(status),func(t *testing.T){
			a:=fynetest.NewApp(); defer a.Quit()
			hits:=0
			server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){ hits++; w.WriteHeader(status); _=json.NewEncoder(w).Encode(map[string]bool{"success":false}) }))
			defer server.Close()
			t.Setenv("SYNAPSE_API_URL","");t.Setenv("SYNAPSE_API_FALLBACK_URL","")
			setupApiBaseConfig(t,map[string]string{"synapse_api_url":server.URL})
			p8t17NurAttrappen(t,server.URL)
			w:=p8t17Detail();w.ReloadAgenten();fyne.DoAndWait(func(){})
			if hits!=1 || len(w.AgentRows)!=0 { t.Fatalf("Authfehler: hits=%d rows=%v",hits,w.AgentRows) }
		})
	}
}
