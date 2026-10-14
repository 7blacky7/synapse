package main

// P18-T63: Reverse-Fenster zeigt fehlende PC-Zuordnung mit Knopf "Diesen PC zuordnen".
// Nur Fake-Transport (a9Setup), t.TempDir(); keine echte API, kein echter Daemon.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"fyne.io/fyne/v2"
	fynetest "fyne.io/fyne/v2/test"
	"fyne.io/fyne/v2/widget"
)

const t63Fehler = "Explizite Daemon-Hostbindung fehlt."

func TestP18T63WannPruefen(t *testing.T) {
	ok := reverseDaemonStatus{Aktiv: true, Modus: "api"}
	if reverseZuordnungPruefen(ok, nil, nil, nil) {
		t.Fatal("Normalbetrieb darf keine Zusatzabfragen ausloesen")
	}
	for name, s := range map[string]reverseDaemonStatus{
		"offen":      {Aktiv: true, Modus: "offen", Fehler: t63Fehler},
		"fehler":     {Aktiv: true, Modus: "fehler"},
		"api+Fehler": {Aktiv: true, Modus: "api", Fehler: "irgendwas"},
	} {
		if !reverseZuordnungPruefen(s, nil) {
			t.Errorf("%s: nicht geprueft", name)
		}
	}
	if reverseZuordnungPruefen(reverseDaemonStatus{Modus: "aus"}, nil) {
		t.Fatal("ausgeschaltete Bibliothek geprueft")
	}
	if reverseZuordnungPruefen(reverseDaemonStatus{}, errors.New("offline")) {
		t.Fatal("ohne Daemon geprueft")
	}
	// API-Code allein reicht, auch wenn der Daemon nicht antwortet.
	apiErr := reverseFehlerAus(409, []byte(`{"success":false,"error":{"code":"daemon_host_nicht_gebunden","message":"Hostbindung fehlt"}}`))
	if !reverseZuordnungPruefen(reverseDaemonStatus{}, errors.New("offline"), nil, apiErr) {
		t.Fatal("API-Code daemon_host_nicht_gebunden nicht erkannt")
	}
	if reverseZuordnungPruefen(ok, nil, reverseFehlerAus(500, []byte(`{"code":"anders"}`))) {
		t.Fatal("fremder Code loest Pruefung aus")
	}
}

func TestP18T63TexteUndDaemonFehler(t *testing.T) {
	if got := reverseZuordnungText(reversePCZuordnung{Host: "pc-1"}); !strings.Contains(got, "Dieser PC ist noch nicht bei Synapse zugeordnet: pc-1") {
		t.Fatalf("fehlt: %q", got)
	}
	if got := reverseZuordnungText(reversePCZuordnung{Host: "pc-1", Zugeordnet: "pc-2"}); !strings.Contains(got, "anderen PC zugeordnet: pc-2") {
		t.Fatalf("anderer: %q", got)
	}
	if got := reverseZuordnungText(reversePCZuordnung{Host: "pc-1", Zugeordnet: "pc-1"}); got != "" {
		t.Fatalf("passend: %q", got)
	}
	if got := reverseZuordnungText(reversePCZuordnung{Fehler: errors.New("Lokaler Daemon nicht erreichbar")}); !strings.Contains(got, "nicht geprüft werden: Lokaler Daemon") {
		t.Fatalf("Fehler: %q", got)
	}
	if (reversePCZuordnung{Host: "a", Zugeordnet: "b"}).Fehlt() || !(reversePCZuordnung{Host: "a"}).Fehlt() {
		t.Fatal("Fehlt() falsch")
	}
	text := reverseDaemonText(reverseDaemonStatus{Aktiv: true, Modus: "offen", Fehler: t63Fehler, Auftraege: []reverseDaemonAuftrag{
		{Pfad: "/lib/a.iso", Fehler: "HTTP 409"}, {Pfad: "/lib/b.iso"}, {Pfad: "/lib/c.iso", Fehler: "x"}, {Pfad: "/lib/d.iso", Fehler: "y"}, {Pfad: "/lib/e.iso", Fehler: "z"}}})
	for _, teil := range []string{"Fehler: " + t63Fehler, "Transfer a.iso: HTTP 409", "Transfer d.iso: y", "…"} {
		if !strings.Contains(text, teil) {
			t.Errorf("Daemon-Text ohne %q:\n%s", teil, text)
		}
	}
	if strings.Contains(text, "e.iso") || strings.Contains(text, "b.iso") {
		t.Errorf("zu viele/fehlerfreie Transfers im Text:\n%s", text)
	}
}

// t63Fake: Daemon (/host/status, /reverse/status, /reverse/konfig) und API (Hostbindung).
type t63Fake struct {
	mu         sync.Mutex
	gebunden   string
	posts      []string
	konfig     []map[string]any
	bindFehler bool
}

func (f *t63Fake) runde(t *testing.T) a9RoundTrip {
	return func(r *http.Request) (*http.Response, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/host/status":
			return rv7JSON(r, 200, map[string]any{"online": true, "hostname": "pc-t63"}), nil
		case "/api/project-init/restore/host-binding":
			if r.Method == http.MethodPost {
				var b struct{ Hostname string }
				if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
					return nil, err
				}
				f.posts = append(f.posts, b.Hostname)
				if f.bindFehler {
					return rv7JSON(r, 403, map[string]any{"success": false, "error": map[string]any{"code": "verboten"}}), nil
				}
				f.gebunden = b.Hostname
			}
			var host any
			if f.gebunden != "" {
				host = f.gebunden
			}
			return rv7JSON(r, 200, map[string]any{"success": true, "hostname": host}), nil
		case "/reverse/status":
			if f.gebunden == "" {
				return rv7JSON(r, 200, map[string]any{"aktiv": true, "pfad": "/lib", "modus": "offen", "fehler": t63Fehler, "auftraege": []any{}}), nil
			}
			return rv7JSON(r, 200, map[string]any{"aktiv": true, "pfad": "/lib", "modus": "api", "auftraege": []any{}}), nil
		case "/reverse/konfig":
			var b map[string]any
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				return nil, err
			}
			f.konfig = append(f.konfig, b)
			return rv7JSON(r, 200, map[string]any{"ok": true}), nil
		case "/api/reverse/sync-optionen", "/api/reverse/fundstellen":
			return rv7JSON(r, 503, map[string]any{"success": false, "error": map[string]any{"code": "deaktiviert"}}), nil
		}
		t.Errorf("unerwartet %s %s", r.Method, r.URL.Path)
		return a9Response(r, 404, strings.NewReader("")), nil
	}
}

func TestP18T63ZuordnenUndNeuversuch(t *testing.T) {
	f := &t63Fake{}
	a9Setup(t, f.runde(t))
	oldPort := port
	port = 12345
	t.Cleanup(func() { port = oldPort })
	ctx := context.Background()

	z := reverseLadePCZuordnung(ctx)
	if !z.Fehlt() || z.Host != "pc-t63" {
		t.Fatalf("vorher: %+v", z)
	}
	cfg := rv7Config(t, `{"reverse_bibliothek":{"aktiv":true,"pfad":"`+filepath.ToSlash(t.TempDir())+`"},"fremd":1}`)
	neuversuch, err := reversePCZuordnen(ctx, cfg, z.Host, "http://127.0.0.1:12345")
	if err != nil || neuversuch != nil {
		t.Fatalf("zuordnen: %v / %v", err, neuversuch)
	}
	if z = reverseLadePCZuordnung(ctx); z.Fehlt() || z.Zugeordnet != "pc-t63" {
		t.Fatalf("nachher: %+v", z)
	}
	if !reflect.DeepEqual(f.posts, []string{"pc-t63"}) || len(f.konfig) != 1 || !reflect.DeepEqual(f.konfig[0], map[string]any{"aktiv": true}) {
		t.Fatalf("posts=%v konfig=%v", f.posts, f.konfig)
	}
	// Bibliothek aus: kein Daemon-Anstoss.
	aus := rv7Config(t, `{"reverse_bibliothek":{"aktiv":false}}`)
	if neuversuch, err := reversePCZuordnen(ctx, aus, "pc-t63", "http://127.0.0.1:12345"); err != nil || neuversuch != nil || len(f.konfig) != 1 {
		t.Fatalf("aus: %v %v %v", err, neuversuch, f.konfig)
	}
	// Server lehnt ab: Fehler, kein Daemon-Anstoss.
	f.bindFehler = true
	if _, err := reversePCZuordnen(ctx, cfg, "pc-t63", "http://127.0.0.1:12345"); err == nil || len(f.konfig) != 1 {
		t.Fatalf("Ablehnung: %v %v", err, f.konfig)
	}
	if _, err := reversePCZuordnen(ctx, cfg, "", "http://127.0.0.1:12345"); err == nil {
		t.Fatal("leerer Host akzeptiert")
	}
}

// TestP18T63FensterHeadless: Reverse-Fenster zeigt Hinweis + Knopf, Knopf ordnet zu und stoesst den Daemon an.
func TestP18T63FensterHeadless(t *testing.T) {
	previousApp := fyne.CurrentApp()
	baseApp := fynetest.NewApp()
	app := a9SerialApp{App: baseApp, driver: &a9SerialDriver{Driver: baseApp.Driver()}}
	fyne.SetCurrentApp(app)
	oldApp, oldPort := myApp, port
	myApp = app
	port = 12345
	f := &t63Fake{}
	a9Setup(t, f.runde(t))
	home, _ := os.UserHomeDir()
	cfgPfad := filepath.Join(home, ".synapse", "file-watcher", "config.json")
	if err := os.MkdirAll(filepath.Dir(cfgPfad), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPfad, []byte(`{"synapse_api_url":"https://secondary.test","reverse_bibliothek":{"aktiv":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fyne.DoAndWait(zeigeReverseBibliothekFenster)
	t.Cleanup(func() {
		fyne.DoAndWait(func() {
			if reverseFenster != nil {
				reverseFenster.Close()
			}
			myApp = oldApp
			port = oldPort
		})
		baseApp.Quit()
		fyne.SetCurrentApp(previousApp)
	})
	sichtbarMit := func(teil string) bool {
		gefunden := false
		a9Visit(reverseFenster.Content(), func(o fyne.CanvasObject) {
			if l, ok := o.(*widget.Label); ok && l.Visible() && strings.Contains(l.Text, teil) {
				gefunden = true
			}
		})
		return gefunden
	}
	knopf := func() *widget.Button {
		var b *widget.Button
		a9Visit(reverseFenster.Content(), func(o fyne.CanvasObject) {
			if w, ok := o.(*widget.Button); ok && w.Text == "Diesen PC zuordnen" {
				b = w
			}
		})
		return b
	}
	a9WaitWidget(t, func() bool {
		return sichtbarMit("Dieser PC ist noch nicht bei Synapse zugeordnet: pc-t63") && sichtbarMit("Fehler: "+t63Fehler) &&
			knopf() != nil && knopf().Visible() && !knopf().Disabled()
	})
	fyne.DoAndWait(func() { fynetest.Tap(knopf()) })
	a9WaitWidget(t, func() bool {
		return sichtbarMit("Dieser PC ist jetzt zugeordnet: pc-t63. Der lokale Daemon versucht es sofort erneut.") &&
			!sichtbarMit("noch nicht bei Synapse zugeordnet") && !knopf().Visible() && sichtbarMit("mit Synapse verbunden")
	})
	f.mu.Lock()
	defer f.mu.Unlock()
	if !reflect.DeepEqual(f.posts, []string{"pc-t63"}) || len(f.konfig) != 1 || f.konfig[0]["aktiv"] != true {
		t.Fatalf("posts=%v konfig=%v", f.posts, f.konfig)
	}
}
