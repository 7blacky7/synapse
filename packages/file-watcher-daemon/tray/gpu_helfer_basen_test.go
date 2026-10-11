package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// P15-T11: der GPU-Helfer bevorzugt synapse_api_url aus config.json (LAN), der
// Aussteller des Compute-Tokens bleibt Rueckfall.
func TestGpuHelferApiBasen(t *testing.T) {
	const tunnel = "https://tunnel.example"
	const lan = "http://192.168.1.10:3456"
	faelle := []struct {
		name, issuer, konfig, bevorzugt, rueckfall string
	}{
		{"LAN bevorzugt, Tunnel Rueckfall", tunnel, lan, lan, tunnel},
		{"Schraegstrich und Leerraum", tunnel + "/", " " + lan + "/ ", lan, tunnel},
		{"keine Konfig -> nur Aussteller", tunnel, "", tunnel, ""},
		{"Konfig = Aussteller -> kein doppelter Rueckfall", tunnel, tunnel + "/", tunnel, ""},
		{"kein Aussteller -> nur Konfig", "", lan, lan, ""},
	}
	for _, f := range faelle {
		b, r := gpuHelferApiBasen(f.issuer, f.konfig)
		if b != f.bevorzugt || r != f.rueckfall {
			t.Errorf("%s: gpuHelferApiBasen(%q, %q) = (%q, %q), erwartet (%q, %q)", f.name, f.issuer, f.konfig, b, r, f.bevorzugt, f.rueckfall)
		}
	}
}

func envWert(env []string, name string) (string, bool) {
	for _, e := range env {
		if strings.HasPrefix(e, name+"=") {
			return strings.TrimPrefix(e, name+"="), true
		}
	}
	return "", false
}

// Schalter aus -> nur die oeffentliche Adresse wie vor P15-T11; an -> LAN mit Rueckfall;
// die Embed-Pause wird nur durchgereicht, wenn sie eingestellt ist.
func TestGpuHelferStartwerte(t *testing.T) {
	const tunnel = "https://tunnel.example"
	const lan = "http://192.168.1.10:3456"
	pause := 75

	aus := gpuHelferStartwerte(tunnel, lan, gpuHelferEinstellungen{})
	if aus.ApiURL != tunnel || aus.Rueckfall != "" || aus.ApiArt != "oeffentlich" {
		t.Errorf("Schalter aus: %+v", aus)
	}
	env := aus.env()
	if v, _ := envWert(env, "SYNAPSE_API_URL_RUECKFALL"); v != "" {
		t.Errorf("Schalter aus: Rueckfall gesetzt: %q", v)
	}
	if _, ok := envWert(env, "EMBED_MIN_GAP_MS"); ok {
		t.Errorf("ohne Eintrag darf EMBED_MIN_GAP_MS nicht gesetzt werden (core-Default): %v", env)
	}

	an := gpuHelferStartwerte(tunnel, lan, gpuHelferEinstellungen{LanBevorzugen: true, EmbedPauseMs: &pause})
	if an.ApiURL != lan || an.Rueckfall != tunnel || an.ApiArt != "lan" {
		t.Errorf("Schalter an: %+v", an)
	}
	env = an.env()
	if v, _ := envWert(env, "SYNAPSE_API_URL"); v != lan {
		t.Errorf("SYNAPSE_API_URL = %q", v)
	}
	if v, _ := envWert(env, "SYNAPSE_API_URL_RUECKFALL"); v != tunnel {
		t.Errorf("SYNAPSE_API_URL_RUECKFALL = %q", v)
	}
	if v, _ := envWert(env, "EMBED_MIN_GAP_MS"); v != "75" {
		t.Errorf("EMBED_MIN_GAP_MS = %q, erwartet 75", v)
	}
	if v, _ := envWert(env, "SYNAPSE_NODE_STATUS_DATEI"); !strings.HasSuffix(v, "gpu-helfer-status.json") {
		t.Errorf("SYNAPSE_NODE_STATUS_DATEI = %q", v)
	}

	ohneKonfig := gpuHelferStartwerte(tunnel, "", gpuHelferEinstellungen{LanBevorzugen: true})
	if ohneKonfig.ApiURL != tunnel || ohneKonfig.Rueckfall != "" || ohneKonfig.ApiArt != "oeffentlich" {
		t.Errorf("Schalter an ohne synapse_api_url: %+v", ohneKonfig)
	}
	if an == aus {
		t.Error("Startwerte an/aus gleich - die Beobachtung wuerde keinen Neustart ausloesen")
	}
}

// Die Einstellungsdatei wird gezielt geaendert: fremde Schluessel bleiben, null entfernt.
func TestSetzeGPUHelferEinstellung(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	pfad := gpuHelferEinstellungenPfad()
	if !strings.HasPrefix(pfad, home) {
		t.Fatalf("Pfad nicht unter HOME: %s", pfad)
	}
	if e := ladeGPUHelferEinstellungen(); e.LanBevorzugen || e.EmbedPauseMs != nil {
		t.Fatalf("ohne Datei muss alles aus sein: %+v", e)
	}
	if err := os.MkdirAll(filepath.Dir(pfad), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pfad, []byte(`{"fremd":"bleibt","embed_pause_ms":75}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := setzeGPUHelferEinstellung("lan_bevorzugen", true); err != nil {
		t.Fatal(err)
	}
	e := ladeGPUHelferEinstellungen()
	if !e.LanBevorzugen || e.EmbedPauseMs == nil || *e.EmbedPauseMs != 75 {
		t.Errorf("nach Setzen: %+v", e)
	}
	if err := setzeGPUHelferEinstellung("lan_bevorzugen", false); err != nil {
		t.Fatal(err)
	}
	if ladeGPUHelferEinstellungen().LanBevorzugen {
		t.Error("Zurueckschalten auf aus wirkt nicht")
	}
	if err := setzeGPUHelferEinstellung("embed_pause_ms", nil); err != nil {
		t.Fatal(err)
	}
	roh, _ := os.ReadFile(pfad)
	var felder map[string]interface{}
	if err := json.Unmarshal(roh, &felder); err != nil {
		t.Fatal(err)
	}
	if felder["fremd"] != "bleibt" {
		t.Errorf("fremder Schluessel verloren: %s", roh)
	}
	if _, da := felder["embed_pause_ms"]; da {
		t.Errorf("null muss den Schluessel entfernen: %s", roh)
	}
	if err := os.WriteFile(pfad, []byte(`{"embed_pause_ms":-5}`), 0600); err != nil {
		t.Fatal(err)
	}
	if ladeGPUHelferEinstellungen().EmbedPauseMs != nil {
		t.Error("negative Pause muss als nicht gesetzt gelten")
	}
}

// Nur ein Klick des Menschen schreibt; der programmatische Abgleich nie.
func TestLanHaekchenSchreiben(t *testing.T) {
	faelle := []struct {
		an, programmatisch, datei, erwartet bool
	}{
		{true, false, false, true},  // Mensch schaltet ein
		{false, false, true, true},  // Mensch schaltet aus
		{true, true, true, false},   // Abgleich nach KI-Aenderung: kein Rueckschreiben/Neustart
		{false, true, false, false}, // Abgleich nach KI-Aenderung (aus)
		{true, true, false, false},  // programmatisch, selbst wenn es abwiche
		{true, false, true, false},  // Wert steht schon in der Datei
	}
	for _, f := range faelle {
		if got := lanHaekchenSchreiben(f.an, f.programmatisch, f.datei); got != f.erwartet {
			t.Errorf("lanHaekchenSchreiben(%v, %v, %v) = %v, erwartet %v", f.an, f.programmatisch, f.datei, got, f.erwartet)
		}
	}
}

// Der Pruefktakt meldet dem offenen Fenster den Dateistand; nach dem Schliessen nicht mehr,
// und das Schliessen eines alten Fensters meldet ein neueres nicht ab.
func TestGpuFensterBenachrichtigen(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := setzeGPUHelferEinstellung("lan_bevorzugen", true); err != nil {
		t.Fatal(err)
	}
	aufrufe := 0
	var zuletzt gpuHelferEinstellungen
	alt := meldeGPUFensterAn(func(e gpuHelferEinstellungen, _ string) { aufrufe++; zuletzt = e })
	gpuFensterBenachrichtigen()
	if aufrufe != 1 || !zuletzt.LanBevorzugen {
		t.Fatalf("Fenster nicht benachrichtigt: aufrufe=%d %+v", aufrufe, zuletzt)
	}
	// KI/Daemon schaltet aus -> naechster Takt meldet aus
	if err := setzeGPUHelferEinstellung("lan_bevorzugen", false); err != nil {
		t.Fatal(err)
	}
	gpuFensterBenachrichtigen()
	if aufrufe != 2 || zuletzt.LanBevorzugen {
		t.Fatalf("Aenderung nicht gemeldet: aufrufe=%d %+v", aufrufe, zuletzt)
	}
	neuAufrufe := 0
	neu := meldeGPUFensterAn(func(gpuHelferEinstellungen, string) { neuAufrufe++ })
	meldeGPUFensterAb(alt)
	gpuFensterBenachrichtigen()
	if neuAufrufe != 1 || aufrufe != 2 {
		t.Fatalf("Abmelden des alten Fensters hat das neue getroffen: neu=%d alt=%d", neuAufrufe, aufrufe)
	}
	meldeGPUFensterAb(neu)
	gpuFensterBenachrichtigen()
	if neuAufrufe != 1 {
		t.Fatal("nach dem Schliessen noch benachrichtigt")
	}
}
