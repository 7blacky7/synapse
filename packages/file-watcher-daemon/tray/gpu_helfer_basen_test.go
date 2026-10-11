package main

import "testing"

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
