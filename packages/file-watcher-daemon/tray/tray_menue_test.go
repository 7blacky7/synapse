package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// P8-T21: Menue-Layout und Workspaces-Abruf.

func testProjekte(anzahl, aktivJeder int) []Project {
	out := make([]Project, 0, anzahl)
	for i := 0; i < anzahl; i++ {
		out = append(out, Project{Name: fmt.Sprintf("p%02d", i), Enabled: i%aktivJeder == 0})
	}
	return out
}

func artIndex(l []menueEintrag, art menueArt) int {
	for i, e := range l {
		if e.Art == art {
			return i
		}
	}
	return -1
}

func TestHauptmenueGlobaleObenInaktiveImUntermenue(t *testing.T) {
	projs := testProjekte(87, 4) // 22 aktiv, 65 inaktiv, gemischt
	l := hauptmenueLayout(true, projs)

	wantStart := []menueArt{menueStatus, menueTrenner, menueVerbinden, menueAssetSync, menueReverse,
		menueGPU, menueWorkspaces, menueTrenner, menueNeuLaden, menueDeaktivieren, menueBeenden, menueTrenner}
	for i, art := range wantStart {
		if l[i].Art != art {
			t.Fatalf("Eintrag %d: Art %d, erwartet %d", i, l[i].Art, art)
		}
	}
	if len(l) >= maxHauptmenueEintraege {
		t.Fatalf("%d Haupteintraege, erwartet < %d", len(l), maxHauptmenueEintraege)
	}
	var oben []string
	for _, e := range l {
		if e.Art == menueProjekt {
			if !e.Projekt.Enabled {
				t.Fatalf("inaktives Projekt %s im Hauptmenue", e.Projekt.Name)
			}
			oben = append(oben, e.Projekt.Name)
		}
	}
	if len(oben) != maxAktiveProjekteOben || oben[0] != "p00" || oben[1] != "p04" {
		t.Fatalf("aktive oben: %v", oben)
	}
	iw := artIndex(l, menueWeitereAktive)
	ii := artIndex(l, menueInaktive)
	if iw < 0 || ii < 0 || iw > ii || ii != len(l)-1 {
		t.Fatalf("Gruppen falsch: weitere=%d inaktive=%d len=%d", iw, ii, len(l))
	}
	if got := gruppenLabel(l[iw]); got != "Weitere aktive Projekte (2)" {
		t.Fatalf("Label weitere: %q", got)
	}
	if got := gruppenLabel(l[ii]); got != "Inaktive Projekte (65)" {
		t.Fatalf("Label inaktive: %q", got)
	}
	for _, p := range l[ii].Gruppe {
		if p.Enabled {
			t.Fatalf("aktives Projekt %s unter Inaktive", p.Name)
		}
	}
}

func TestHauptmenueWenigeAktiveOhneWeitere(t *testing.T) {
	projs := []Project{{Name: "a", Enabled: true}, {Name: "b"}, {Name: "c", Enabled: true}}
	l := hauptmenueLayout(true, projs)
	if artIndex(l, menueWeitereAktive) >= 0 {
		t.Fatal("Weitere aktive darf bei wenigen Projekten nicht erscheinen")
	}
	ii := artIndex(l, menueInaktive)
	if ii < 0 || len(l[ii].Gruppe) != 1 || l[ii].Gruppe[0].Name != "b" {
		t.Fatalf("Inaktive-Gruppe: %+v", l)
	}
	if l[ii-2].Projekt.Name != "a" || l[ii-1].Projekt.Name != "c" {
		t.Fatal("Reihenfolge der aktiven Projekte nicht erhalten")
	}

	// Alle aktiv: kein Inaktive-Untermenue.
	l = hauptmenueLayout(true, []Project{{Name: "a", Enabled: true}})
	if artIndex(l, menueInaktive) >= 0 {
		t.Fatal("Inaktive-Untermenue ohne inaktive Projekte")
	}
}

func TestHauptmenueOfflineUndLeer(t *testing.T) {
	l := hauptmenueLayout(false, testProjekte(5, 1))
	if l[2].Art != menueDaemonStarten {
		t.Fatalf("offline: Daemon starten nicht direkt unter dem Status: %+v", l[2])
	}
	if artIndex(l, menueDeaktivieren) >= 0 || artIndex(l, menueProjekt) >= 0 {
		t.Fatal("offline: Deaktivieren/Projekte duerfen nicht erscheinen")
	}
	if l[len(l)-1].Art != menueBeenden {
		t.Fatal("offline: Beenden muss letzter Eintrag sein")
	}

	l = hauptmenueLayout(true, nil)
	if l[len(l)-1].Art != menueKeineProjekte {
		t.Fatal("ohne Projekte fehlt '(keine Projekte)'")
	}
}

func TestProjektSignaturErkenntAktivWechsel(t *testing.T) {
	vorher := getProjectSignature([]Project{{Name: "a", Enabled: true}, {Name: "b"}})
	nachher := getProjectSignature([]Project{{Name: "a", Enabled: true}, {Name: "b", Enabled: true}})
	if vorher == nachher {
		t.Fatal("Wechsel aktiv/inaktiv muss die Signatur aendern (Rebuild)")
	}
	if vorher != getProjectSignature([]Project{{Name: "a", Enabled: true}, {Name: "b"}}) {
		t.Fatal("gleicher Stand muss gleiche Signatur liefern (kein unnoetiger Rebuild)")
	}
}

func TestWorkspaceSignaturUnterscheidetZustaende(t *testing.T) {
	seen := map[string]string{}
	for _, z := range []string{"", wsZustandOK, wsZustandNichtVerbunden, wsZustandOffline} {
		s := getWorkspaceSignature(nil, z)
		if alt, ok := seen[s]; ok {
			t.Fatalf("Zustand %q und %q haben dieselbe Signatur %q", z, alt, s)
		}
		seen[s] = z
	}
}

// --- Workspaces ueber den API-Weg (Token) ---

type wsTransport func(*http.Request) (*http.Response, error)

func (f wsTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func wsAntwort(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func wsTestSetup(t *testing.T, token string, rt wsTransport) {
	t.Helper()
	t.Setenv("SYNAPSE_API_URL", "")
	t.Setenv("SYNAPSE_API_FALLBACK_URL", "")
	t.Setenv("SYNAPSE_API_TOKEN", "")
	setupApiBaseConfig(t, map[string]string{
		"synapse_api_url":   "http://tray-test.invalid",
		"synapse_api_token": token,
	})
	old := apiHttpClient
	apiHttpClient = &http.Client{Transport: rt}
	t.Cleanup(func() { apiHttpClient = old })
}

func TestFetchWorkspacesSchicktToken(t *testing.T) {
	calls := 0
	wsTestSetup(t, "tray-service-token", func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method != http.MethodGet || r.URL.Host != "tray-test.invalid" || r.URL.Path != "/api/workspaces" {
			t.Fatalf("unerwarteter Request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer tray-service-token" {
			return wsAntwort(401, `{"error":"unauthorized"}`), nil
		}
		return wsAntwort(200, `{"success":true,"workspaces":[{"project":"synapse","status":"active","pinned":true,"container_id":"c1"},{"project":"x","status":"cold"}]}`), nil
	})
	ws, zustand := fetchWorkspaces()
	if zustand != wsZustandOK || len(ws) != 2 || ws[0].Project != "synapse" || !ws[0].Pinned {
		t.Fatalf("zustand=%q ws=%+v", zustand, ws)
	}
	if calls != 1 {
		t.Fatalf("%d Requests statt 1", calls)
	}
	if got := workspacesLabel(ws, zustand); got != "Workspaces  (1/2)" {
		t.Fatalf("Label %q", got)
	}
}

func TestFetchWorkspacesOhneToken401NichtVerbunden(t *testing.T) {
	calls := 0
	wsTestSetup(t, "", func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Authorization") != "" {
			t.Fatal("ohne Token darf kein Authorization-Header gehen")
		}
		return wsAntwort(401, `{"error":"unauthorized"}`), nil
	})
	ws, zustand := fetchWorkspaces()
	if zustand != wsZustandNichtVerbunden || ws != nil {
		t.Fatalf("zustand=%q ws=%v", zustand, ws)
	}
	if calls != 1 {
		t.Fatalf("401 ist eine echte Antwort, kein Weiterprobieren: %d Requests", calls)
	}
	if got := workspacesLabel(ws, zustand); got != "Workspaces (nicht verbunden)" {
		t.Fatalf("Label %q", got)
	}
}

func TestFetchWorkspacesNetzfehlerOffline(t *testing.T) {
	wsTestSetup(t, "tray-service-token", func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("verbindung abgelehnt")
	})
	ws, zustand := fetchWorkspaces()
	if zustand != wsZustandOffline || ws != nil {
		t.Fatalf("zustand=%q ws=%v", zustand, ws)
	}
	if got := workspacesLabel(ws, zustand); got != "Workspaces (offline)" {
		t.Fatalf("Label %q", got)
	}
}

func TestWorkspaceActionSchicktTokenUndBody(t *testing.T) {
	calls := 0
	wsTestSetup(t, "tray-service-token", func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method != http.MethodPost || r.URL.Path != "/api/projects/demo/workspace/pin" {
			t.Fatalf("unerwarteter Request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer tray-service-token" {
			t.Fatal("Token fehlt")
		}
		var body map[string]bool
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || !body["pinned"] {
			t.Fatalf("Body %v err=%v", body, err)
		}
		return wsAntwort(200, `{"success":true}`), nil
	})
	workspaceAction("demo", "pin", `{"pinned":true}`)
	if calls != 1 {
		t.Fatalf("%d Requests statt 1", calls)
	}
}
