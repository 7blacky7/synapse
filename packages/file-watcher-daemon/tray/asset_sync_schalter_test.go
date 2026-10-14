package main

// P13-T45: Config-Schreiben des Asset-Sync-Schalters (Felder bleiben erhalten) und
// Meldung an den lokalen Daemon. Nur t.TempDir() und httptest, keine echte config.json.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const t45Basis = `{
  "port": 7878,
  "synapse_api_token": "nur-test",
  "fremd": {"tief": [1, 2.50, "x"]},
  "projekte": [
    {"name": "a", "pfad": "/tmp/a", "enabled": true, "file_count": 12345678901234, "unbekannt": "bleibt",
     "asset_sync": {"verwaltet": true, "host": "h1", "optionen": {"chunkBytes": 65536}}},
    {"name": "b", "pfad": "/tmp/b", "enabled": false}
  ]
}`

func t45Config(t *testing.T, inhalt string) string {
	t.Helper()
	pfad := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(pfad, []byte(inhalt), 0o640); err != nil {
		t.Fatal(err)
	}
	return pfad
}

func t45Lesen(t *testing.T, pfad string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&cfg); err != nil {
		t.Fatalf("config.json nach dem Schreiben nicht lesbar: %v\n%s", err, data)
	}
	return cfg
}

func TestT45SetzeAssetSyncAktivBehaeltFelder(t *testing.T) {
	pfad := t45Config(t, t45Basis)
	if leseAssetSyncAktiv(pfad, "a") || leseAssetSyncAktiv(pfad, "b") {
		t.Fatal("Standard muss aus sein")
	}
	if err := setzeAssetSyncAktiv(pfad, "a", true); err != nil {
		t.Fatal(err)
	}
	cfg := t45Lesen(t, pfad)
	if cfg["synapse_api_token"] != "nur-test" || cfg["port"] != json.Number("7878") {
		t.Fatalf("Kopf-Felder verloren: %v", cfg)
	}
	roh, _ := os.ReadFile(pfad)
	if !strings.Contains(string(roh), "2.50") {
		t.Fatalf("Fremdfeld nicht unveraendert erhalten:\n%s", roh)
	}
	projekte := cfg["projekte"].([]any)
	a := projekte[0].(map[string]any)
	if a["unbekannt"] != "bleibt" || a["file_count"] != json.Number("12345678901234") || a["pfad"] != "/tmp/a" || a["enabled"] != true {
		t.Fatalf("Projektfelder verloren: %v", a)
	}
	as := a["asset_sync"].(map[string]any)
	if as["aktiv"] != true || as["verwaltet"] != true || as["host"] != "h1" {
		t.Fatalf("asset_sync falsch: %v", as)
	}
	if as["optionen"].(map[string]any)["chunkBytes"] != json.Number("65536") {
		t.Fatalf("asset_sync.optionen verloren: %v", as)
	}
	if _, da := projekte[1].(map[string]any)["asset_sync"]; da {
		t.Fatal("anderes Projekt darf nicht veraendert werden")
	}
	if !leseAssetSyncAktiv(pfad, "a") || leseAssetSyncAktiv(pfad, "b") {
		t.Fatal("leseAssetSyncAktiv nach Setzen falsch")
	}

	// Projekt ohne asset_sync bekommt das Objekt neu; Ausschalten behaelt verwaltet/host.
	if err := setzeAssetSyncAktiv(pfad, "b", true); err != nil {
		t.Fatal(err)
	}
	if err := setzeAssetSyncAktiv(pfad, "a", false); err != nil {
		t.Fatal(err)
	}
	if leseAssetSyncAktiv(pfad, "a") || !leseAssetSyncAktiv(pfad, "b") {
		t.Fatal("Umschalten a aus / b an fehlgeschlagen")
	}
	as = t45Lesen(t, pfad)["projekte"].([]any)[0].(map[string]any)["asset_sync"].(map[string]any)
	if as["verwaltet"] != true || as["host"] != "h1" || as["aktiv"] != false {
		t.Fatalf("Ausschalten hat asset_sync veraendert: %v", as)
	}

	st, err := os.Stat(pfad)
	if err != nil || st.Mode().Perm() != 0o640 {
		t.Fatalf("Dateirechte nicht erhalten: %v %v", st.Mode().Perm(), err)
	}
	if _, err := os.Stat(pfad + ".tray.tmp"); !os.IsNotExist(err) {
		t.Fatal("Temp-Datei liegen geblieben")
	}
}

func TestT45SetzeAssetSyncAktivFehlerAendertNichts(t *testing.T) {
	faelle := map[string]struct{ inhalt, name string }{
		"unbekanntes Projekt":    {t45Basis, "fehlt"},
		"kaputtes JSON":          {`{"projekte": [`, "a"},
		"asset_sync kein Objekt": {`{"projekte":[{"name":"a","pfad":"/tmp/a","asset_sync":5}]}`, "a"},
		"ohne projekte":          {`{"port": 1}`, "a"},
	}
	for titel, f := range faelle {
		t.Run(titel, func(t *testing.T) {
			pfad := t45Config(t, f.inhalt)
			if err := setzeAssetSyncAktiv(pfad, f.name, true); err == nil {
				t.Fatal("Fehler erwartet")
			}
			data, _ := os.ReadFile(pfad)
			if string(data) != f.inhalt {
				t.Fatalf("Datei wurde trotz Fehler geaendert:\n%s", data)
			}
		})
	}
	if err := setzeAssetSyncAktiv(filepath.Join(t.TempDir(), "fehlt.json"), "a", true); err == nil {
		t.Fatal("fehlende Datei muss Fehler liefern")
	}
}

func TestT45MeldeAssetSyncAnDaemon(t *testing.T) {
	var gesehen struct {
		methode, pfad, typ string
		body               map[string]any
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gesehen.methode, gesehen.pfad, gesehen.typ = r.Method, r.URL.Path, r.Header.Get("Content-Type")
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &gesehen.body)
		if strings.Contains(r.URL.Path, "unbekannt") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"ok":false,"error":"Projekt \"unbekannt\" nicht gefunden"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"aktiv":true,"neu_gestartet":true}`))
	}))
	defer srv.Close()

	if err := meldeAssetSyncAnDaemon(srv.URL+"/", "mein projekt", true); err != nil {
		t.Fatal(err)
	}
	if gesehen.methode != http.MethodPost || gesehen.pfad != "/projects/mein projekt/asset-sync" || gesehen.typ != "application/json" || gesehen.body["aktiv"] != true {
		t.Fatalf("Anfrage falsch: %+v", gesehen)
	}
	if err := meldeAssetSyncAnDaemon(srv.URL, "unbekannt", false); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("404 muss als Fehler mit Status kommen: %v", err)
	}
	if gesehen.body["aktiv"] != false {
		t.Fatalf("aktiv:false nicht uebertragen: %+v", gesehen.body)
	}
	srv.Close()
	if err := meldeAssetSyncAnDaemon(srv.URL, "a", true); err == nil {
		t.Fatal("nicht erreichbarer Daemon muss Fehler liefern")
	}
}
