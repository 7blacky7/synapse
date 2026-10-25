package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// P22-T133: der Haken setzt nur cli_verlauf.aktiv; Fremdfelder (auch unbekannte im cli_verlauf-Objekt) bleiben.
func TestCliVerlaufSchalterBehaeltFremdfelder(t *testing.T) {
	pfad := filepath.Join(t.TempDir(), "config.json")
	start := `{"port":7878,"synapse_api_token":"geheim","projekte":[{"name":"a","pfad":"/a"}],"cli_verlauf":{"notiz":"x"}}`
	if err := os.WriteFile(pfad, []byte(start), 0o600); err != nil {
		t.Fatal(err)
	}
	if leseCliVerlaufAktiv(pfad) {
		t.Fatal("ohne aktiv muss der Standard aus gelten")
	}
	if err := setzeCliVerlaufAktiv(pfad, true); err != nil {
		t.Fatal(err)
	}
	if !leseCliVerlaufAktiv(pfad) {
		t.Fatal("aktiv:true nicht gesetzt")
	}
	var cfg map[string]json.RawMessage
	daten, _ := os.ReadFile(pfad)
	if err := json.Unmarshal(daten, &cfg); err != nil {
		t.Fatal(err)
	}
	for _, feld := range []string{"port", "synapse_api_token", "projekte"} {
		if _, ok := cfg[feld]; !ok {
			t.Fatalf("Fremdfeld %s verloren", feld)
		}
	}
	var cv map[string]any
	_ = json.Unmarshal(cfg["cli_verlauf"], &cv)
	if cv["notiz"] != "x" || cv["aktiv"] != true {
		t.Fatalf("cli_verlauf falsch: %v", cv)
	}
	if st, _ := os.Stat(pfad); st.Mode().Perm() != 0o600 {
		t.Fatalf("Dateirechte geaendert: %v", st.Mode().Perm())
	}
	if err := setzeCliVerlaufAktiv(pfad, false); err != nil || leseCliVerlaufAktiv(pfad) {
		t.Fatalf("ausschalten fehlgeschlagen: %v", err)
	}
}

func TestCliVerlaufSchalterKaputteDateiBleibtUnveraendert(t *testing.T) {
	pfad := filepath.Join(t.TempDir(), "config.json")
	kaputt := []byte(`{"cli_verlauf": [1,2]}`)
	_ = os.WriteFile(pfad, kaputt, 0o600)
	if err := setzeCliVerlaufAktiv(pfad, true); err == nil {
		t.Fatal("kaputtes cli_verlauf muss abbrechen")
	}
	if daten, _ := os.ReadFile(pfad); string(daten) != string(kaputt) {
		t.Fatal("Datei wurde trotz Fehler geaendert")
	}
}
