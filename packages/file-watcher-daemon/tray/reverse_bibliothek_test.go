package main

// P18-T17 (RV7): Reverse-Bibliothek im Tray. Nur t.TempDir(), Fake-Transport
// (a9Setup) und httptest — keine echte config.json, keine echte API, kein PG.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"fyne.io/fyne/v2"
	fynetest "fyne.io/fyne/v2/test"
	"fyne.io/fyne/v2/widget"
)

const rv7Basis = `{
  "port": 7878,
  "synapse_api_token": "nur-test",
  "fremd": {"tief": [1, 2.50, "x"], "gross": 12345678901234567},
  "projekte": [
    {"name": "spiel", "pfad": "/tmp/rv7-projekte/spiel", "enabled": true, "unbekannt": "bleibt"}
  ],
  "reverse_bibliothek": {"zukunft": {"v": 2}}
}`

func rv7Config(t *testing.T, inhalt string) string {
	t.Helper()
	pfad := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(pfad, []byte(inhalt), 0o640); err != nil {
		t.Fatal(err)
	}
	return pfad
}

func rv7Lesen(t *testing.T, pfad string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&cfg); err != nil {
		t.Fatalf("config.json nicht lesbar: %v\n%s", err, data)
	}
	return cfg
}

func rv7JSON(r *http.Request, status int, wert any) *http.Response {
	raw, _ := json.Marshal(wert)
	return a9Response(r, status, bytes.NewReader(raw))
}

func TestRV7DefaultBeiLeererKonfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	erwartet := filepath.Join(home, "synapse-reverse")
	for name, inhalt := range map[string]string{
		"fehlt":       "",
		"leer":        "{}",
		"objekt":      `{"reverse_bibliothek":{}}`,
		"null":        `{"reverse_bibliothek":null}`,
		"leerer-pfad": `{"reverse_bibliothek":{"pfad":"  "}}`,
	} {
		t.Run(name, func(t *testing.T) {
			pfad := filepath.Join(t.TempDir(), "config.json")
			if inhalt != "" {
				if err := os.WriteFile(pfad, []byte(inhalt), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			k, err := leseReverseKonfig(pfad)
			if err != nil || k.Pfad != erwartet || k.PfadGesetzt || k.Aktiv || k.GeloeschteAusblenden {
				t.Fatalf("Default greift nicht: %+v err=%v", k, err)
			}
		})
	}
	// Kaputte Datei: Fehler, aber Default bleibt fuer die Anzeige.
	pfad := rv7Config(t, `{"reverse_bibliothek":"kaputt"}`)
	if k, err := leseReverseKonfig(pfad); err == nil || k.Pfad != erwartet {
		t.Fatalf("kaputte Konfig: %+v err=%v", k, err)
	}
}

func TestRV7OrdnerwahlPersistiertUndErhaeltFelder(t *testing.T) {
	pfad := rv7Config(t, rv7Basis)
	ziel := filepath.Join(t.TempDir(), "originale")
	if err := setzeReverseKonfig(pfad, map[string]interface{}{"aktiv": true, "pfad": ziel}); err != nil {
		t.Fatal(err)
	}
	cfg := rv7Lesen(t, pfad)
	if cfg["port"] != json.Number("7878") || cfg["synapse_api_token"] != "nur-test" {
		t.Fatalf("Top-Level-Felder verloren: %v", cfg)
	}
	fremd := cfg["fremd"].(map[string]any)
	if fremd["gross"] != json.Number("12345678901234567") || !reflect.DeepEqual(fremd["tief"], []any{json.Number("1"), json.Number("2.50"), "x"}) {
		t.Fatalf("fremde Felder/Zahlen veraendert: %v", fremd)
	}
	projekt := cfg["projekte"].([]any)[0].(map[string]any)
	if projekt["unbekannt"] != "bleibt" {
		t.Fatalf("Projektfelder verloren: %v", projekt)
	}
	rb := cfg["reverse_bibliothek"].(map[string]any)
	if rb["aktiv"] != true || rb["pfad"] != ziel || rb["zukunft"] == nil {
		t.Fatalf("reverse_bibliothek falsch: %v", rb)
	}
	k, err := leseReverseKonfig(pfad)
	if err != nil || !k.Aktiv || k.Pfad != ziel || !k.PfadGesetzt || k.GeloeschteAusblenden {
		t.Fatalf("Ruecklesen: %+v %v", k, err)
	}
	// Schalter "lokal geloeschte ausblenden" (Vertragsergaenzung 1): nur dieses Feld aendert sich.
	if err := setzeReverseKonfig(pfad, map[string]interface{}{"geloeschte_ausblenden": true}); err != nil {
		t.Fatal(err)
	}
	k, err = leseReverseKonfig(pfad)
	if err != nil || !k.Aktiv || k.Pfad != ziel || !k.GeloeschteAusblenden {
		t.Fatalf("geloeschte_ausblenden: %+v %v", k, err)
	}
	if rv7Lesen(t, pfad)["reverse_bibliothek"].(map[string]any)["zukunft"] == nil {
		t.Fatal("unbekanntes Feld in reverse_bibliothek verloren")
	}
	info, _ := os.Stat(pfad)
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("Dateirechte veraendert: %o", info.Mode().Perm())
	}
	eintraege, _ := os.ReadDir(filepath.Dir(pfad))
	if len(eintraege) != 1 {
		t.Fatalf("Temp-Dateien liegen geblieben: %v", eintraege)
	}
}

func TestRV7FehlerBeimSpeichernAendertNichts(t *testing.T) {
	for _, kaputt := range []string{"{kaputt", "null", "[]", `{"reverse_bibliothek":"text"}`, `{"reverse_bibliothek":[1]}`} {
		t.Run(kaputt, func(t *testing.T) {
			pfad := rv7Config(t, kaputt)
			if err := setzeReverseKonfig(pfad, map[string]interface{}{"aktiv": true}); err == nil {
				t.Fatal("kaputte Konfig akzeptiert")
			}
			danach, _ := os.ReadFile(pfad)
			if string(danach) != kaputt {
				t.Fatalf("Datei veraendert: %s", danach)
			}
			eintraege, _ := os.ReadDir(filepath.Dir(pfad))
			if len(eintraege) != 1 {
				t.Fatalf("Temp-Dateien liegen geblieben: %v", eintraege)
			}
		})
	}
	fehlt := filepath.Join(t.TempDir(), "config.json")
	if err := setzeReverseKonfig(fehlt, map[string]interface{}{"aktiv": true}); err == nil {
		t.Fatal("fehlende config.json akzeptiert")
	}
	if _, err := os.Stat(fehlt); !os.IsNotExist(err) {
		t.Fatal("fehlende config.json wurde angelegt")
	}
}

func TestRV7PfadValidierung(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	pfad := rv7Config(t, rv7Basis)
	for _, schlecht := range []string{"", "relativ/ordner", home, home + "/", "/", "/tmp/rv7-projekte/spiel", "/tmp/rv7-projekte/spiel/sub", "/tmp/rv7-projekte"} {
		if _, err := pruefeReversePfad(pfad, schlecht); err == nil {
			t.Errorf("Pfad %q akzeptiert", schlecht)
		}
	}
	gut, err := pruefeReversePfad(pfad, " "+filepath.Join(home, "synapse-reverse", "..", "synapse-reverse")+"/ ")
	if err != nil || gut != filepath.Join(home, "synapse-reverse") {
		t.Fatalf("gueltiger Pfad: %q %v", gut, err)
	}
	if _, err := pruefeReversePfad(pfad, "/tmp/rv7-projekte/spiel-zwei"); err != nil {
		t.Fatalf("Nachbarordner mit gleichem Praefix abgelehnt: %v", err)
	}
	// K4: Punktordner direkt unter $HOME und alles darin.
	for _, gesperrt := range []string{".ssh", ".gnupg", ".config", ".config/sub", ".synapse/file-watcher"} {
		if _, err := pruefeReversePfad(pfad, filepath.Join(home, gesperrt)); err == nil {
			t.Errorf("Punktordner %q akzeptiert", gesperrt)
		}
	}
	if _, err := pruefeReversePfad(pfad, filepath.Join(home, "Spiele", ".versteckt")); err != nil {
		t.Errorf("tieferer Punktordner abgelehnt: %v", err)
	}
}

// K5: anderer Zielort beim Zurueckholen nie in einem Projekt (auch nicht per Symlink).
func TestRV7AndererOrtNichtImProjekt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	projekt := filepath.Join(t.TempDir(), "spiel")
	os.MkdirAll(filepath.Join(projekt, "assets"), 0o755)
	cfg := rv7Config(t, `{"projekte":[{"name":"spiel","pfad":`+strconvQuote(projekt)+`}]}`)
	frei := t.TempDir()
	if echt, err := reversePruefeAndererOrt(cfg, frei); err != nil || echt == "" {
		t.Fatalf("freier Ordner abgelehnt: %v", err)
	}
	for _, schlecht := range []string{projekt, filepath.Join(projekt, "assets"), "relativ", filepath.Join(frei, "fehlt"), filepath.Join(home, ".ssh")} {
		if schlecht == filepath.Join(home, ".ssh") {
			os.MkdirAll(schlecht, 0o700)
		}
		if _, err := reversePruefeAndererOrt(cfg, schlecht); err == nil {
			t.Errorf("Zielordner %q akzeptiert", schlecht)
		}
	}
	link := filepath.Join(frei, "zum-projekt")
	if err := os.Symlink(filepath.Join(projekt, "assets"), link); err == nil {
		if _, err := reversePruefeAndererOrt(cfg, link); err == nil {
			t.Error("Symlink ins Projekt akzeptiert")
		}
	}
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestRV7DaemonKonfigUndStatus(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method + " " + r.URL.Path {
		case "POST /reverse/konfig":
			var b map[string]any
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				return nil, err
			}
			bodies = append(bodies, b)
			if b["pfad"] == "/fehler" {
				return a9Response(r, 500, strings.NewReader("kaputt")), nil
			}
			return rv7JSON(r, 200, map[string]any{"success": true}), nil
		case "GET /reverse/status":
			return rv7JSON(r, 200, map[string]any{"aktiv": true, "pfad": "/lib", "modus": "api", "erkannt": 3, "wartend_stabil": []any{"a"},
				"auftraege": []any{map[string]any{"pfad": "/lib/CDs/a.iso", "art": "upload", "bytes_erledigt": "512", "groesse": 1024}}}), nil
		}
		return nil, fmt.Errorf("unerwartet %s %s", r.Method, r.URL.Path)
	}))
	ctx := context.Background()
	if err := daemonReverseKonfig(ctx, "http://127.0.0.1:1", map[string]interface{}{"aktiv": true, "pfad": "/lib"}); err != nil {
		t.Fatal(err)
	}
	if err := daemonReverseKonfig(ctx, "http://127.0.0.1:1", map[string]interface{}{"aktiv": false, "pfad": "/fehler"}); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("Daemon-Fehler nicht gemeldet: %v", err)
	}
	// M1: Filter allein geht ebenfalls an den Daemon.
	if err := daemonReverseKonfig(ctx, "http://127.0.0.1:1", map[string]interface{}{"geloeschte_ausblenden": true}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(bodies[0], map[string]any{"aktiv": true, "pfad": "/lib"}) || !reflect.DeepEqual(bodies[2], map[string]any{"geloeschte_ausblenden": true}) {
		t.Fatalf("Bodies: %v", bodies)
	}
	st, err := daemonReverseStatus(ctx)
	if err != nil || st.Modus != "api" || len(st.Auftraege) != 1 || *st.Auftraege[0].BytesErledigt != 512 {
		t.Fatalf("Status: %+v %v", st, err)
	}
	text := reverseDaemonText(st)
	for _, teil := range []string{"mit Synapse verbunden", "3 erkannt", "1 warten auf stabile Größe", "1 laufende Transfers"} {
		if !strings.Contains(text, teil) {
			t.Errorf("Daemon-Text ohne %q: %s", teil, text)
		}
	}
	// Daemon nicht erreichbar.
	apiHttpClient = &http.Client{Transport: a9RoundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })}
	if err := daemonReverseKonfig(ctx, "http://127.0.0.1:1", map[string]interface{}{"aktiv": true}); err == nil {
		t.Fatal("offline-Daemon nicht gemeldet")
	}
}

// rv7FakeFundstellen liefert drei Seiten (Zahlen teils als Text wie im SQL-Snapshot).
func rv7FakeFundstellen(t *testing.T, r *http.Request, aufrufe *[]string) *http.Response {
	if r.Header.Get("Authorization") != "Bearer p13_a9-test-only" || r.Header.Get("X-Synapse-Contract-Version") != "1" {
		t.Errorf("Bearer/Vertrag fehlt: %v", r.Header)
	}
	cursor := r.URL.Query().Get("cursor")
	*aufrufe = append(*aufrufe, cursor)
	seiten := map[string]map[string]any{
		"": {"success": true, "vollstaendig": false, "cursor": "c1", "dateien": []any{
			map[string]any{"id": "1", "rel_pfad": "CDs/Siedler3/disk1.iso", "sha256": "aa", "reverse_id": 7, "status": "S2", "art": "image", "lokal": "gesehen",
				"fortschritt": map[string]any{"dateien_gesamt": 4, "dateien_fertig": 4, "bytes_gesamt": "4096", "bytes_erledigt": "4096"},
				"vorschlag":   map[string]any{"haupt": "disk1.iso", "fehlende_dateien": []any{"disk2.iso"}, "confidence": 0.82}},
			map[string]any{"id": "2", "rel_pfad": "CDs/Siedler3/disk2.iso", "status": "erkannt", "lokal": "geloescht_lokal"},
		}},
		"c1": {"success": true, "vollstaendig": false, "cursor": "c2", "dateien": []any{
			map[string]any{"id": "3", "rel_pfad": "CDs/alt.bin", "status": "hochgeladen", "lokal": "geloescht_lokal", "medium_id": nil},
			map[string]any{"id": "4", "rel_pfad": "Tools\\setup.exe", "status": "fehler", "fehlercode": "upload_fehler", "lokal": "fehlt", "hinweis_ausgeblendet": true, "gesichert": false},
		}},
		"c2": {"success": true, "vollstaendig": true, "cursor": nil, "dateien": []any{
			map[string]any{"id": "5", "rel_pfad": "einzeln.exe", "status": "entpackt", "lokal": "gesehen"},
		}},
	}
	seite, ok := seiten[cursor]
	if !ok {
		t.Errorf("unbekannter Cursor %q", cursor)
		return rv7JSON(r, 400, map[string]any{"success": false})
	}
	return rv7JSON(r, 200, seite)
}

func TestRV7StatusbaumAusMehrseitigerAntwort(t *testing.T) {
	var aufrufe []string
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/reverse/fundstellen" {
			return nil, fmt.Errorf("unerwartet %s", r.URL.Path)
		}
		return rv7FakeFundstellen(t, r, &aufrufe), nil
	}))
	dateien, err := apiReverseFundstellen(context.Background())
	if err != nil || len(dateien) != 5 || !reflect.DeepEqual(aufrufe, []string{"", "c1", "c2"}) {
		t.Fatalf("Paginierung: n=%d aufrufe=%v err=%v", len(dateien), aufrufe, err)
	}
	if dateien[0].ReverseID != "7" || *dateien[0].Fortschritt.BytesGesamt != 4096 || !dateien[3].HinweisAusgeblendet {
		t.Fatalf("Felder falsch gelesen: %+v", dateien[0])
	}
	auftraege := []reverseDaemonAuftrag{{Pfad: "/lib/CDs/Siedler3/disk2.iso", Art: "upload"}, {Pfad: "Neu/kommt.iso", Art: "upload"}}
	b := baueReverseBaum(dateien, auftraege, "/lib", reverseFilter{AusgeblendeteZeigen: true})
	if !reflect.DeepEqual(b.Kinder[""], []string{"d:CDs", "d:Neu", "d:Tools", "f:einzeln.exe"}) {
		t.Fatalf("Wurzel: %v", b.Kinder[""])
	}
	if !reflect.DeepEqual(b.Kinder["d:CDs"], []string{"d:CDs/Siedler3", "f:CDs/alt.bin"}) {
		t.Fatalf("CDs: %v", b.Kinder["d:CDs"])
	}
	if !reflect.DeepEqual(b.Kinder["d:CDs/Siedler3"], []string{"f:CDs/Siedler3/disk1.iso", "f:CDs/Siedler3/disk2.iso"}) {
		t.Fatalf("Siedler3: %v", b.Kinder["d:CDs/Siedler3"])
	}
	if !reflect.DeepEqual(b.Kinder["d:Tools"], []string{"f:Tools/setup.exe"}) {
		t.Fatalf("Backslash-Pfad nicht verschachtelt: %v", b.Kinder["d:Tools"])
	}
	if b.Knoten["f:CDs/Siedler3/disk2.iso"].Auftrag == nil || b.Knoten["f:Neu/kommt.iso"].Datei != nil {
		t.Fatal("Daemon-Transfers nicht zugeordnet")
	}
	cds := b.Knoten["d:CDs"]
	if cds.Gesamt != 3 || cds.Gesichert != 2 || cds.Warnungen != 1 || b.Dateien != 5 || b.Gesichert != 3 {
		t.Fatalf("Zaehler: cds=%+v baum=%d/%d", cds, b.Dateien, b.Gesichert)
	}
	if b.Knoten["d:Tools"].Warnungen != 1 || b.Ausgeblendet != 0 {
		t.Fatalf("Tools/Fehler: %+v ausgeblendet=%d", b.Knoten["d:Tools"], b.Ausgeblendet)
	}
	// Ausgeblendeter Hinweis (id 4) ist ohne Filter "ausgeblendete Hinweise zeigen" weg.
	standard := baueReverseBaum(dateien, nil, "/lib", reverseFilter{})
	if _, ok := standard.Knoten["f:Tools/setup.exe"]; ok || standard.Ausgeblendet != 1 || standard.Dateien != 4 {
		t.Fatalf("ausgeblendeter Hinweis sichtbar ohne Filter: %d/%d", standard.Dateien, standard.Ausgeblendet)
	}
	if _, ok := standard.Knoten["d:Tools"]; ok {
		t.Fatal("leerer Ordner bleibt stehen")
	}
	// Globaler Schalter "lokal geloeschte ausblenden".
	ohne := baueReverseBaum(dateien, nil, "/lib", reverseFilter{GeloeschteAusblenden: true, AusgeblendeteZeigen: true})
	if ohne.Ausgeblendet != 2 || ohne.Knoten["f:CDs/alt.bin"] != nil || ohne.Knoten["f:CDs/Siedler3/disk2.iso"] != nil {
		t.Fatalf("lokal geloeschte nicht ausgeblendet: %d", ohne.Ausgeblendet)
	}
	// Titel und Details.
	if titel := reverseKnotenTitel(b.Knoten["f:CDs/alt.bin"]); !strings.Contains(titel, "lokal gelöscht – Original sicher auf Unraid") || !strings.Contains(titel, reverseTextGesichert) {
		t.Fatalf("Titel alt.bin: %s", titel)
	}
	if titel := reverseKnotenTitel(b.Knoten["f:CDs/Siedler3/disk2.iso"]); !strings.Contains(titel, "lokal gelöscht, noch nicht gesichert") || !strings.Contains(titel, reverseTextNichtGesichert) {
		t.Fatalf("Titel disk2: %s", titel)
	}
	detail := strings.Join(reverseKnotenZeilen(b.Knoten["f:CDs/Siedler3/disk1.iso"]), "\n")
	for _, teil := range []string{"analysiert bis Stufe S2", "Datenträger-Image", "Dateien: 4 / 4 fertig", "Bytes: 4,0 KiB / 4,0 KiB", reverseTextGesichert} {
		if !strings.Contains(detail, teil) {
			t.Errorf("Detail ohne %q:\n%s", teil, detail)
		}
	}
	text, ok := reverseVorschlagText(dateien[0].Vorschlag)
	if !ok || !strings.Contains(text, "Hauptdatei: disk1.iso") || !strings.Contains(text, "• disk2.iso") || !strings.Contains(text, "Confidence: 0.82") || !strings.Contains(text, "Tool reverse") {
		t.Fatalf("Vorschlag: %s", text)
	}
	if _, ok := reverseVorschlagText(dateien[1].Vorschlag); ok {
		t.Fatal("fehlender Vorschlag als vorhanden gemeldet")
	}
}

func TestRV7PaginierungGrenzen(t *testing.T) {
	for name, antwort := range map[string]map[string]any{
		"ohne-cursor": {"success": true, "vollstaendig": false, "cursor": nil, "dateien": []any{}},
		"gleicher":    {"success": true, "vollstaendig": false, "cursor": "immer", "dateien": []any{}},
		"abgelehnt":   {"success": false},
	} {
		t.Run(name, func(t *testing.T) {
			aufrufe := 0
			a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
				aufrufe++
				if aufrufe > 10 {
					t.Fatal("Endlosschleife")
				}
				return rv7JSON(r, 200, antwort), nil
			}))
			if _, err := apiReverseFundstellen(context.Background()); err == nil {
				t.Fatal("ungueltige Seite akzeptiert")
			}
		})
	}
	t.Run("410-neu-beginnen", func(t *testing.T) {
		var aufrufe []string
		abgelaufen := false
		a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
			if r.URL.Query().Get("cursor") == "c1" && !abgelaufen {
				abgelaufen = true
				aufrufe = append(aufrufe, "410")
				return rv7JSON(r, 410, map[string]any{"success": false, "error": map[string]any{"code": "manifest_abgelaufen"}}), nil
			}
			return rv7FakeFundstellen(t, r, &aufrufe), nil
		}))
		dateien, err := apiReverseFundstellen(context.Background())
		if err != nil || len(dateien) != 5 || !reflect.DeepEqual(aufrufe, []string{"", "410", "", "c1", "c2"}) {
			t.Fatalf("410: n=%d aufrufe=%v err=%v", len(dateien), aufrufe, err)
		}
	})
}

func TestRV7SicherNurAbHochgeladen(t *testing.T) {
	// Rueckfall ohne Feld gesichert: Status ab 'hochgeladen'.
	for status, sicher := range map[string]bool{"": false, "erkannt": false, "fehler": false, "unbekannt": false,
		"hochgeladen": true, "entpackt": true, "S0": true, "S1": true, "S2": true, "S3": true} {
		text := reverseSicherungText(reverseIstGesichert(&reverseFundstelle{Status: status}))
		if (text == reverseTextGesichert) != sicher || (!sicher && text != reverseTextNichtGesichert) {
			t.Errorf("Status %q: %q", status, text)
		}
	}
	// M3: das API-Feld gesichert hat Vorrang (Analysefehler nach sicherem Upload).
	var zeile reverseFundstelle
	if err := json.Unmarshal([]byte(`{"rel_pfad":"a.iso","status":"fehler","fehlercode":"s1_fehler","gesichert":true,"lokal":"geloescht_lokal"}`), &zeile); err != nil {
		t.Fatal(err)
	}
	if !reverseIstGesichert(&zeile) {
		t.Fatal("gesichert:true bei Status fehler nicht beachtet")
	}
	if text, warnung := reverseLokalHinweis(&zeile); text != "lokal gelöscht – Original sicher auf Unraid" || warnung {
		t.Fatalf("Hinweis bei gesichert:true: %q %v", text, warnung)
	}
	nein := false
	if reverseIstGesichert(&reverseFundstelle{Status: "hochgeladen", Gesichert: &nein}) {
		t.Fatal("gesichert:false bei Status hochgeladen ignoriert")
	}
	b := baueReverseBaum([]reverseFundstelle{zeile}, nil, "", reverseFilter{})
	if b.Gesichert != 1 || !strings.Contains(reverseKnotenTitel(b.Knoten["f:a.iso"]), reverseTextGesichert) {
		t.Fatalf("Baum ignoriert gesichert: %d %s", b.Gesichert, reverseKnotenTitel(b.Knoten["f:a.iso"]))
	}
	for _, fall := range []struct {
		lokal, status, text string
		warnung             bool
	}{
		{"geloescht_lokal", "hochgeladen", "lokal gelöscht – Original sicher auf Unraid", false},
		{"geloescht_lokal", "erkannt", "lokal gelöscht, noch nicht gesichert", true},
		{"fehlt", "S1", "verschoben/umbenannt", false},
		{"gesehen", "S1", "", false},
	} {
		text, warnung := reverseLokalHinweis(&reverseFundstelle{Lokal: fall.lokal, Status: fall.status})
		if text != fall.text || warnung != fall.warnung {
			t.Errorf("%+v -> %q %v", fall, text, warnung)
		}
	}
}

func TestRV7PolicyAusAPI(t *testing.T) {
	for _, fall := range []struct {
		max    int64
		erwart string
	}{{4 << 30, "Max. Dateigröße: 4,0 GiB"}, {1536 << 20, "Max. Dateigröße: 1,5 GiB"}} {
		a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
			if r.URL.Path != "/api/reverse/sync-optionen" || r.Header.Get("X-Synapse-Contract-Version") != "1" {
				return nil, fmt.Errorf("unerwartet %s", r.URL.Path)
			}
			return rv7JSON(r, 200, map[string]any{"success": true, "host": "pc", "chunkBytes": 8 << 20, "maxDateiBytes": fall.max, "maxBatch": 50, "stabilMs": 5000,
				"loesch_verhalten": "behalten", "erlaubt_alle_dateien": false, "endungen": map[string]any{"images": []string{"iso", "bin", "nrg"}, "companions": []any{
					map[string]any{"format": "cue", "endungen": []string{"cue"}, "referenzen": "cue", "pflicht": []string{}, "optional": []string{}},
					map[string]any{"format": "mds", "endungen": []string{"mds"}, "pflicht": []string{"mdf"}, "optional": []string{"md0", "md1"}},
				}}}), nil
		}))
		o, err := apiReverseSyncOptionen(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		text := strings.Join(reversePolicyZeilen(o), "\n")
		for _, teil := range []string{fall.erwart, "Erkannte Image-Endungen: .bin, .iso, .nrg", "Begleitdateien: .cue → Dateien laut Inhalt; .mds → .mdf (Pflicht), .md0 (optional), .md1 (optional)",
			"Lösch-Verhalten: behalten: lokales Löschen entfernt nichts auf Unraid", "nur die genannten Endungen", "Upload-Block 8,0 MiB", "max. 50 Dateien", "5s"} {
			if !strings.Contains(text, teil) {
				t.Errorf("Policy ohne %q:\n%s", teil, text)
			}
		}
	}
	mit := strings.Join(reversePolicyZeilen(reverseSyncOptionen{LoeschVerhalten: json.RawMessage(`"mitloeschen"`)}), "\n")
	if !strings.Contains(mit, "nicht umgesetzt") || !strings.Contains(mit, "entfernt nichts auf Unraid") {
		t.Fatalf("mitloeschen wird angeboten/falsch angezeigt: %s", mit)
	}
	leer := strings.Join(reversePolicyZeilen(reverseSyncOptionen{}), "\n")
	if !strings.Contains(leer, "vom Server nicht gemeldet") || !strings.Contains(leer, "keine gemeldet") {
		t.Fatalf("leere Policy: %s", leer)
	}
}

// rv7ServerSyncOptionen: Antwortform von GET /api/reverse/sync-optionen (services/
// reverse-eingang.ts syncOptionen, Route ergaenzt success:true). Katalog (endungen,
// loesch_verhalten, maxBatch, stabilMs) wortgleich mit den Server-Defaults aus
// dist/config/reverse-eingang.js (Job ab3ec96c); Budgetwerte (chunkBytes, timeoutMs,
// maxDateiBytes …) kommen aus der Server-Konfiguration und sind hier Beispielwerte.
const rv7ServerSyncOptionen = `{"success":true,"host":"daemon_fixture","chunkBytes":8388608,"timeoutMs":600000,"retryMs":30000,"scanMs":60000,
"maxDateiBytes":68719476736,"parallelTransfers":2,"maxBatch":10000,"stabilMs":2000,"loesch_verhalten":"behalten",
"endungen":{"images":["iso","img","bin","nrg","cdi","mdf"],"companions":[
{"format":"cue","endungen":["cue"],"referenzen":"cue","pflicht":[],"optional":[]},
{"format":"ccd","endungen":["ccd"],"pflicht":["img"],"optional":["sub"]},
{"format":"mds","endungen":["mds"],"pflicht":["mdf"],"optional":["md0","md1"]},
{"format":"toc","endungen":["toc"],"referenzen":"cue","pflicht":[],"optional":[]},
{"format":"b5t","endungen":["b5t"],"pflicht":["b5i"],"optional":[]},
{"format":"b6t","endungen":["b6t"],"pflicht":["b6i"],"optional":[]}]},"erlaubt_alle_dateien":true}`

// TestRV7VertragSyncOptionenServerform (B1): die echte Server-JSON geht durch den Go-Decoder.
func TestRV7VertragSyncOptionenServerform(t *testing.T) {
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		return a9Response(r, 200, strings.NewReader(rv7ServerSyncOptionen)), nil
	}))
	o, err := apiReverseSyncOptionen(context.Background())
	if err != nil {
		t.Fatalf("Serverform nicht lesbar: %v", err)
	}
	if len(o.Endungen.Companions) != 6 || o.Endungen.Companions[1].Format != "ccd" || !reflect.DeepEqual(o.Endungen.Companions[1].Optional, []string{"sub"}) {
		t.Fatalf("companions: %+v", o.Endungen.Companions)
	}
	text := strings.Join(reversePolicyZeilen(o), "\n")
	for _, teil := range []string{"Max. Dateigröße: 64,0 GiB", "Erkannte Image-Endungen: .bin, .cdi, .img, .iso, .mdf, .nrg",
		".ccd → .img (Pflicht), .sub (optional)", ".b6t → .b6i (Pflicht)", ".toc → Dateien laut Inhalt", "Angenommen werden alle Dateien.",
		"Lösch-Verhalten: behalten: lokales Löschen entfernt nichts auf Unraid"} {
		if !strings.Contains(text, teil) {
			t.Errorf("Policy ohne %q:\n%s", teil, text)
		}
	}
	// Tolerant: aeltere Form mit Strings bricht nicht.
	var alt reverseSyncOptionen
	if err := json.Unmarshal([]byte(`{"endungen":{"images":[".iso"],"companions":["cue"]}}`), &alt); err != nil || reverseCompanionText(alt.Endungen.Companions[0]) != ".cue" {
		t.Fatalf("String-Companions: %+v %v", alt, err)
	}
}

func TestRV7Deaktiviert503(t *testing.T) {
	var hosts []string
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		return rv7JSON(r, 503, map[string]any{"success": false, "error": map[string]any{"code": "deaktiviert", "message": "Reverse-Bibliothek nicht freigegeben."}}), nil
	}))
	_, err := apiReverseSyncOptionen(context.Background())
	if !errors.Is(err, errReverseDeaktiviert) || len(hosts) != 1 {
		t.Fatalf("503 deaktiviert: hosts=%v err=%v", hosts, err)
	}
	if _, err := apiReverseFundstellen(context.Background()); !errors.Is(err, errReverseDeaktiviert) {
		t.Fatalf("Fundstellen: %v", err)
	}
	if errReverseDeaktiviert.Error() != "Reverse-Bibliothek auf dem Server nicht freigegeben" {
		t.Fatal("Hinweistext geaendert")
	}
	// Anderer 5xx: naechste Basis (Transport-Fallback bleibt).
	hosts = nil
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		if len(hosts) == 1 {
			return a9Response(r, 502, strings.NewReader("bad gateway")), nil
		}
		return rv7JSON(r, 200, map[string]any{"success": true, "maxDateiBytes": 1}), nil
	}))
	if _, err := apiReverseSyncOptionen(context.Background()); err != nil || len(hosts) != 2 {
		t.Fatalf("Fallback: hosts=%v err=%v", hosts, err)
	}
	// 4xx: echte Antwort, kein Fallback.
	hosts = nil
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		return rv7JSON(r, 403, map[string]any{"success": false, "error": map[string]any{"code": "daemon_host_nicht_gebunden", "message": "Explizite Daemon-Hostbindung fehlt."}}), nil
	}))
	if _, err := apiReverseSyncOptionen(context.Background()); err == nil || len(hosts) != 1 || !strings.Contains(err.Error(), "daemon_host_nicht_gebunden") {
		t.Fatalf("403: hosts=%v err=%v", hosts, err)
	}
}

func TestRV7HinweisAusblenden(t *testing.T) {
	var bodies []map[string]any
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.Method != "POST" || r.URL.Path != "/api/reverse/fundstellen/hinweis" || r.Header.Get("Authorization") != "Bearer p13_a9-test-only" {
			return nil, fmt.Errorf("unerwartet %s %s", r.Method, r.URL.Path)
		}
		var b map[string]any
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			return nil, err
		}
		bodies = append(bodies, b)
		return rv7JSON(r, 200, map[string]any{"success": b["rel_pfad"] != "abgelehnt"}), nil
	}))
	ctx := context.Background()
	if err := apiReverseHinweis(ctx, "CDs/alt.bin", true); err != nil {
		t.Fatal(err)
	}
	if err := apiReverseHinweis(ctx, "CDs/alt.bin", false); err != nil {
		t.Fatal(err)
	}
	if err := apiReverseHinweis(ctx, "abgelehnt", true); err == nil {
		t.Fatal("success:false akzeptiert")
	}
	if err := apiReverseHinweis(ctx, " ", true); err == nil {
		t.Fatal("leerer Pfad akzeptiert")
	}
	if !reflect.DeepEqual(bodies[:2], []map[string]any{{"rel_pfad": "CDs/alt.bin", "ausblenden": true}, {"rel_pfad": "CDs/alt.bin", "ausblenden": false}}) || len(bodies) != 3 {
		t.Fatalf("Bodies: %v", bodies)
	}
}

func rv7Hash(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func rv7OriginalFake(t *testing.T, inhalt []byte, headerHash string, aufrufe *int) {
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		*aufrufe++
		if r.URL.Path != "/api/reverse/fundstellen/original" || r.URL.Query().Get("rel_pfad") != "CDs/Siedler 3/disk1.iso" {
			return nil, fmt.Errorf("unerwartet %s", r.URL.String())
		}
		resp := a9Response(r, 200, bytes.NewReader(inhalt))
		resp.Header.Set("Content-Type", "application/octet-stream")
		if headerHash != "" {
			resp.Header.Set("x-synapse-sha256", headerHash)
		}
		return resp, nil
	}))
}

func rv7KeineTemp(t *testing.T, ordner string) {
	t.Helper()
	filepath.Walk(ordner, func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasPrefix(info.Name(), ".synapse-tmp-") {
			t.Errorf("Temp-Datei liegen geblieben: %s", p)
		}
		return nil
	})
}

func TestRV7ZurueckholenMitHashpruefung(t *testing.T) {
	inhalt := bytes.Repeat([]byte("siedler"), 300000)
	hash := rv7Hash(inhalt)
	rel := "CDs/Siedler 3/disk1.iso"

	t.Run("erfolg", func(t *testing.T) {
		wurzel := t.TempDir()
		aufrufe := 0
		rv7OriginalFake(t, inhalt, strings.ToUpper(hash), &aufrufe)
		ziel, err := reverseZielPfad(wurzel, rel)
		if err != nil {
			t.Fatal(err)
		}
		var gesehen int64
		if err := reverseZurueckholen(context.Background(), rel, hash, wurzel, ziel, func(n int64) { gesehen = n }); err != nil {
			t.Fatal(err)
		}
		daten, err := os.ReadFile(filepath.Join(wurzel, "CDs", "Siedler 3", "disk1.iso"))
		if err != nil || !bytes.Equal(daten, inhalt) || gesehen != int64(len(inhalt)) || aufrufe != 1 {
			t.Fatalf("installiert falsch: err=%v gesehen=%d aufrufe=%d", err, gesehen, aufrufe)
		}
		rv7KeineTemp(t, wurzel)
	})
	t.Run("hash-falsch", func(t *testing.T) {
		for name, header := range map[string]string{"header-falsch": rv7Hash([]byte("anders")), "ohne-header": ""} {
			t.Run(name, func(t *testing.T) {
				wurzel := t.TempDir()
				aufrufe := 0
				rv7OriginalFake(t, inhalt, header, &aufrufe)
				ziel, _ := reverseZielPfad(wurzel, rel)
				err := reverseZurueckholen(context.Background(), rel, "", wurzel, ziel, nil)
				if err == nil {
					t.Fatal("falscher Hash installiert")
				}
				if _, err := os.Stat(ziel); !os.IsNotExist(err) {
					t.Fatal("Ziel trotz falschem Hash angelegt")
				}
				rv7KeineTemp(t, wurzel)
			})
		}
		// Server-Hash weicht vom API-Hash der Fundstelle ab.
		wurzel := t.TempDir()
		aufrufe := 0
		rv7OriginalFake(t, inhalt, hash, &aufrufe)
		ziel, _ := reverseZielPfad(wurzel, rel)
		if err := reverseZurueckholen(context.Background(), rel, rv7Hash([]byte("x")), wurzel, ziel, nil); !errors.Is(err, errReverseHashFalsch) {
			t.Fatalf("abweichender Fundstellen-Hash: %v", err)
		}
		if _, err := os.Stat(ziel); !os.IsNotExist(err) {
			t.Fatal("Ziel angelegt")
		}
	})
	t.Run("ziel-existiert", func(t *testing.T) {
		wurzel := t.TempDir()
		aufrufe := 0
		rv7OriginalFake(t, inhalt, hash, &aufrufe)
		ziel, _ := reverseZielPfad(wurzel, rel)
		os.MkdirAll(filepath.Dir(ziel), 0o755)
		os.WriteFile(ziel, []byte("eigene Datei"), 0o600)
		err := reverseZurueckholen(context.Background(), rel, hash, wurzel, ziel, nil)
		var existiert *reverseZielExistiertFehler
		if !errors.As(err, &existiert) || existiert.Ziel != ziel || aufrufe != 0 {
			t.Fatalf("vorhandenes Ziel: err=%v aufrufe=%d", err, aufrufe)
		}
		if daten, _ := os.ReadFile(ziel); string(daten) != "eigene Datei" {
			t.Fatal("vorhandene Datei ueberschrieben")
		}
		// Ziel entsteht erst waehrend des Downloads: Installation verweigert trotzdem.
		ziel2 := filepath.Join(wurzel, "spaet.iso")
		a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
			os.WriteFile(ziel2, []byte("dazwischen"), 0o600)
			resp := a9Response(r, 200, bytes.NewReader(inhalt))
			resp.Header.Set("x-synapse-sha256", hash)
			return resp, nil
		}))
		if err := reverseZurueckholen(context.Background(), rel, hash, wurzel, ziel2, nil); !errors.As(err, &existiert) {
			t.Fatalf("spaet entstandenes Ziel: %v", err)
		}
		if daten, _ := os.ReadFile(ziel2); string(daten) != "dazwischen" {
			t.Fatal("spaet entstandene Datei ueberschrieben")
		}
		rv7KeineTemp(t, wurzel)
	})
	t.Run("abbrechen", func(t *testing.T) {
		wurzel := t.TempDir()
		ctx, cancel := context.WithCancel(context.Background())
		a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
			resp := a9Response(r, 200, io.MultiReader(bytes.NewReader(inhalt[:1000]), &rv7Blockierer{ctx: r.Context()}))
			resp.Header.Set("x-synapse-sha256", hash)
			return resp, nil
		}))
		ziel, _ := reverseZielPfad(wurzel, rel)
		fertig := make(chan error, 1)
		go func() {
			fertig <- reverseZurueckholen(ctx, rel, hash, wurzel, ziel, func(n int64) {
				if n >= 1000 {
					cancel()
				}
			})
		}()
		select {
		case err := <-fertig:
			if err == nil || !strings.Contains(err.Error(), "abgebrochen") {
				t.Fatalf("Abbruch: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("Abbruch wirkt nicht")
		}
		if _, err := os.Stat(ziel); !os.IsNotExist(err) {
			t.Fatal("Ziel nach Abbruch angelegt")
		}
		rv7KeineTemp(t, wurzel)
	})
	t.Run("nicht-gesichert", func(t *testing.T) {
		wurzel := t.TempDir()
		a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
			return rv7JSON(r, 404, map[string]any{"success": false, "error": map[string]any{"code": "nicht_gesichert"}}), nil
		}))
		ziel, _ := reverseZielPfad(wurzel, rel)
		if err := reverseZurueckholen(context.Background(), rel, hash, wurzel, ziel, nil); err == nil || !strings.Contains(err.Error(), "noch nicht gesichert") {
			t.Fatalf("404: %v", err)
		}
		rv7KeineTemp(t, wurzel)
	})
	// M2: symlinkter Unterordner der Bibliothek (oder tiefer) wird nicht verfolgt.
	t.Run("symlink-unterordner", func(t *testing.T) {
		for _, fall := range []string{"CDs", "CDs/Siedler 3"} {
			t.Run(fall, func(t *testing.T) {
				wurzel := t.TempDir()
				draussen := t.TempDir()
				link := filepath.Join(wurzel, filepath.FromSlash(fall))
				if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(draussen, link); err != nil {
					t.Skipf("Symlinks nicht verfuegbar: %v", err)
				}
				aufrufe := 0
				rv7OriginalFake(t, inhalt, hash, &aufrufe)
				ziel, err := reverseZielPfad(wurzel, rel)
				if err != nil {
					t.Fatal(err)
				}
				err = reverseZurueckholen(context.Background(), rel, hash, wurzel, ziel, nil)
				if err == nil || !strings.Contains(err.Error(), "Symlink") || aufrufe != 0 {
					t.Fatalf("Symlink verfolgt: err=%v aufrufe=%d", err, aufrufe)
				}
				eintraege, _ := os.ReadDir(draussen)
				if len(eintraege) != 0 {
					t.Fatalf("ausserhalb der Bibliothek geschrieben: %v", eintraege)
				}
				rv7KeineTemp(t, wurzel)
			})
		}
		// Datei statt Ordner im Weg.
		wurzel := t.TempDir()
		os.WriteFile(filepath.Join(wurzel, "CDs"), []byte("x"), 0o600)
		ziel, _ := reverseZielPfad(wurzel, rel)
		if err := reverseZurueckholen(context.Background(), rel, hash, wurzel, ziel, nil); err == nil {
			t.Fatal("Datei im Zielpfad akzeptiert")
		}
		// Bibliothekswurzel selbst darf ein Symlink sein (aufgeloest wird innerhalb geprueft).
		echt := t.TempDir()
		wurzelLink := filepath.Join(t.TempDir(), "bib")
		if err := os.Symlink(echt, wurzelLink); err != nil {
			t.Skip(err)
		}
		aufrufe := 0
		rv7OriginalFake(t, inhalt, hash, &aufrufe)
		ziel, _ = reverseZielPfad(wurzelLink, rel)
		if err := reverseZurueckholen(context.Background(), rel, hash, wurzelLink, ziel, nil); err != nil {
			t.Fatalf("symlinkte Wurzel: %v", err)
		}
		if _, err := os.Stat(filepath.Join(echt, "CDs", "Siedler 3", "disk1.iso")); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("pfad-ausbruch", func(t *testing.T) {
		wurzel := t.TempDir()
		for _, schlecht := range []string{"../x", "a/../../x", "", "/"} {
			if _, err := reverseZielPfad(wurzel, schlecht); err == nil {
				t.Errorf("Pfad %q akzeptiert", schlecht)
			}
		}
		if _, err := reverseZielPfad("relativ", "a"); err == nil {
			t.Error("relative Wurzel akzeptiert")
		}
	})
}

// rv7Blockierer liefert keine Bytes mehr, bis der Request abgebrochen wird.
type rv7Blockierer struct{ ctx context.Context }

func (b *rv7Blockierer) Read([]byte) (int, error) {
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}

// TestRV7FensterHeadless: echtes Fenster ohne Display, Fake-API + Fake-Daemon.
func TestRV7FensterHeadless(t *testing.T) {
	previousApp := fyne.CurrentApp()
	baseApp := fynetest.NewApp()
	app := a9SerialApp{App: baseApp, driver: &a9SerialDriver{Driver: baseApp.Driver()}}
	fyne.SetCurrentApp(app)
	oldApp, oldPort := myApp, port
	myApp = app
	port = 12345
	var mu sync.Mutex
	deaktiviert := true
	var aufrufe []string
	var daemonKonfig []map[string]any
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/reverse/sync-optionen", "/api/reverse/fundstellen":
			if deaktiviert {
				return rv7JSON(r, 503, map[string]any{"success": false, "error": map[string]any{"code": "deaktiviert"}}), nil
			}
			if r.URL.Path == "/api/reverse/sync-optionen" {
				return a9Response(r, 200, strings.NewReader(strings.Replace(rv7ServerSyncOptionen, `"maxDateiBytes":68719476736`, `"maxDateiBytes":3221225472`, 1))), nil
			}
			return rv7FakeFundstellen(t, r, &aufrufe), nil
		case "/reverse/status":
			return rv7JSON(r, 200, map[string]any{"aktiv": true, "pfad": "/lib", "modus": "api", "auftraege": []any{}}), nil
		case "/reverse/konfig":
			var b map[string]any
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				return nil, err
			}
			daemonKonfig = append(daemonKonfig, b)
			return rv7JSON(r, 200, map[string]any{"success": true}), nil
		}
		t.Errorf("unerwartet %s", r.URL.Path)
		return a9Response(r, 404, strings.NewReader("")), nil
	}))
	// setupApiBaseConfig setzt HOME auf ein Temp-Verzeichnis; config.json dort ergaenzen.
	home, _ := os.UserHomeDir()
	cfgPfad := filepath.Join(home, ".synapse", "file-watcher", "config.json")
	if err := os.MkdirAll(filepath.Dir(cfgPfad), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPfad, []byte(`{"synapse_api_url":"https://secondary.test","fremd":true}`), 0o600); err != nil {
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
	labelMit := func(teil string) bool {
		gefunden := false
		a9Visit(reverseFenster.Content(), func(o fyne.CanvasObject) {
			if l, ok := o.(*widget.Label); ok && strings.Contains(l.Text, teil) {
				gefunden = true
			}
		})
		return gefunden
	}
	a9WaitWidget(t, func() bool { return labelMit("Reverse-Bibliothek auf dem Server nicht freigegeben") })
	var eintrag *widget.Entry
	var ausblenden *widget.Check
	var aktualisieren *widget.Button
	fyne.DoAndWait(func() {
		a9Visit(reverseFenster.Content(), func(o fyne.CanvasObject) {
			switch w := o.(type) {
			case *widget.Entry:
				eintrag = w
			case *widget.Check:
				if w.Text == "lokal gelöschte ausblenden" {
					ausblenden = w
				}
			case *widget.Button:
				if w.Text == "Aktualisieren" {
					aktualisieren = w
				}
			}
		})
	})
	if eintrag == nil || eintrag.Text != filepath.Join(home, "synapse-reverse") || ausblenden == nil || ausblenden.Checked || aktualisieren == nil {
		t.Fatalf("Startzustand falsch: entry=%v", eintrag)
	}
	// Server freigeben -> Policy + Baum.
	mu.Lock()
	deaktiviert = false
	mu.Unlock()
	a9WaitWidget(t, func() bool { return !aktualisieren.Disabled() })
	fyne.DoAndWait(func() { fynetest.Tap(aktualisieren) })
	a9WaitWidget(t, func() bool {
		return labelMit("Max. Dateigröße: 3,0 GiB") && labelMit("behalten: lokales Löschen entfernt nichts auf Unraid") && labelMit("4 Fundstellen")
	})
	if labelMit("nicht freigegeben") {
		t.Fatal("Deaktiviert-Hinweis bleibt stehen")
	}
	// Schalter "lokal geloeschte ausblenden" persistiert und filtert.
	fyne.DoAndWait(func() { ausblenden.SetChecked(true) })
	a9WaitWidget(t, func() bool { return labelMit("2 Fundstellen") })
	cfg := rv7Lesen(t, cfgPfad)
	if cfg["fremd"] != true || cfg["reverse_bibliothek"].(map[string]any)["geloeschte_ausblenden"] != true {
		t.Fatalf("Schalter nicht persistiert: %v", cfg)
	}
	// M1: derselbe Wert geht an den Daemon.
	a9WaitWidget(t, func() bool { return labelMit("Filter gespeichert und vom lokalen Daemon übernommen.") })
	mu.Lock()
	defer mu.Unlock()
	if len(daemonKonfig) != 1 || !reflect.DeepEqual(daemonKonfig[0], map[string]any{"geloeschte_ausblenden": true}) {
		t.Fatalf("Daemon-Konfig: %v", daemonKonfig)
	}
	if labelMit("mitloeschen") {
		t.Fatal("mitloeschen wird angeboten")
	}
}
