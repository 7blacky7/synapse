package main

// gpu_helfer_einstellungen.go — Einstellungen des lokalen GPU-Helfers (P15-T11).
//
// DATEI: ~/.synapse/file-watcher/gpu-helfer.json, z. B.
//   {"lan_bevorzugen": true, "embed_pause_ms": 75}
// Fehlt die Datei oder ein Schluessel: LAN aus (nur die oeffentliche Adresse wie
// vor P15-T11), Embed-Pause = core-Default (EMBED_MIN_GAP_MS wird nicht gesetzt).
//
// ⚠️ BEWUSST NICHT config.json: der TS-Daemon haelt config.json im Speicher (beim
// Start geladen) und schreibt bei jeder Projektaenderung genau diese Kopie zurueck
// (file-watcher-daemon-ts/src/config.ts saveConfig). Ein spaeter vom Tray oder von
// der KI gesetzter Schluessel waere beim naechsten Projekt-Save wieder weg.
//
// STANDARD LAN AUS (User 11.10.2026: "Stell dir vor, mein PC steht auf einmal
// woanders oder der Server wird dezentralisiert"): eine LAN-Adresse gilt nur im
// eigenen Netz. In einem fremden Netz kann dieselbe private IP ein fremdes Geraet
// sein — der Helfer schickte ihm sein Compute-Token im Klartext, und der Rueckfall
// greift nur bei Verbindungsfehlern, nicht bei einer fremden Antwort. Deshalb
// bewusst einschalten, wo das Netz bekannt ist.
//
// WER SCHREIBT, IST EGAL (Haekchen im GPU-Fenster, Daemon-Befehl der KI, Hand):
// gpuHelferEinstellungenBeobachten vergleicht alle paar Sekunden die gewuenschten
// Startwerte mit denen des laufenden Helfers und startet ihn bei Abweichung neu.
// NEUSTART STATT NEULADEN: die Embed-Pause liest core beim Laden als Konstante
// (MIN_GAP_MS), die Adressliste steht ab dem Start fest. Ein Neustart kostet ein
// paar Sekunden (Registrierung), SIGTERM gibt dabei alle offenen Claims zurueck.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type gpuHelferEinstellungen struct {
	LanBevorzugen bool `json:"lan_bevorzugen"`
	EmbedPauseMs  *int `json:"embed_pause_ms,omitempty"`
}

// gpuHelferStart sind die Werte, mit denen ein Helfer gestartet wird bzw. wurde.
type gpuHelferStart struct {
	ApiURL       string `json:"api_url"`
	Rueckfall    string `json:"rueckfall"`
	ApiArt       string `json:"api_art"`
	EmbedPauseMs string `json:"embed_pause_ms"`
}

func gpuHelferDatei(name string) string {
	return filepath.Join(filepath.Dir(gpuConfigPath()), name)
}

func gpuHelferEinstellungenPfad() string { return gpuHelferDatei("gpu-helfer.json") }
func gpuHelferStatusPfad() string        { return gpuHelferDatei("gpu-helfer-status.json") }
func gpuHelferStartPfad() string         { return gpuHelferDatei("local-gpu-helper.start.json") }

func ladeGPUHelferEinstellungen() gpuHelferEinstellungen {
	var e gpuHelferEinstellungen
	roh, err := os.ReadFile(gpuHelferEinstellungenPfad())
	if err != nil {
		return e
	}
	if json.Unmarshal(roh, &e) != nil {
		return gpuHelferEinstellungen{}
	}
	if e.EmbedPauseMs != nil && *e.EmbedPauseMs < 0 {
		e.EmbedPauseMs = nil // ungueltig -> core-Default
	}
	return e
}

// setzeGPUHelferEinstellung aendert EINEN Schluessel und laesst alle anderen
// (auch unbekannte) stehen. Atomar per tmp + rename.
func setzeGPUHelferEinstellung(schluessel string, wert interface{}) error {
	felder := map[string]json.RawMessage{}
	if roh, err := os.ReadFile(gpuHelferEinstellungenPfad()); err == nil {
		if err := json.Unmarshal(roh, &felder); err != nil {
			return fmt.Errorf("%s ist kein gueltiges JSON: %w", gpuHelferEinstellungenPfad(), err)
		}
	}
	if wert == nil {
		delete(felder, schluessel)
	} else {
		w, err := json.Marshal(wert)
		if err != nil {
			return err
		}
		felder[schluessel] = w
	}
	daten, err := json.MarshalIndent(felder, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(gpuHelferEinstellungenPfad()), 0700); err != nil {
		return err
	}
	tmp := gpuHelferEinstellungenPfad() + ".tmp"
	if err := os.WriteFile(tmp, daten, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, gpuHelferEinstellungenPfad())
}

// gpuHelferStartwerte: LAN aus -> nur der Aussteller (oeffentlich), wie vor P15-T11.
// LAN an -> synapse_api_url aus config.json zuerst, Aussteller als Rueckfall.
func gpuHelferStartwerte(issuer, konfigURL string, e gpuHelferEinstellungen) gpuHelferStart {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	s := gpuHelferStart{ApiURL: issuer, ApiArt: "oeffentlich"}
	if e.LanBevorzugen {
		b, r := gpuHelferApiBasen(issuer, konfigURL)
		s.ApiURL, s.Rueckfall = b, r
		if b != issuer {
			s.ApiArt = "lan"
		}
	}
	if e.EmbedPauseMs != nil {
		s.EmbedPauseMs = strconv.Itoa(*e.EmbedPauseMs)
	}
	return s
}

// env liefert die Umgebung fuer den Helfer. Leerer Rueckfall ueberschreibt einen
// geerbten Wert; EMBED_MIN_GAP_MS nur, wenn eingestellt (sonst core-Default).
func (s gpuHelferStart) env() []string {
	out := []string{
		"SYNAPSE_API_URL=" + s.ApiURL,
		"SYNAPSE_API_URL_RUECKFALL=" + s.Rueckfall,
		"SYNAPSE_API_URL_ART=" + s.ApiArt,
		"SYNAPSE_NODE_STATUS_DATEI=" + gpuHelferStatusPfad(),
	}
	if s.EmbedPauseMs != "" {
		out = append(out, "EMBED_MIN_GAP_MS="+s.EmbedPauseMs)
	}
	return out
}

func sollGPUHelferStart(c gpuNodeConfig) gpuHelferStart {
	return gpuHelferStartwerte(c.Issuer, readTrayConfig().SynapseApiUrl, ladeGPUHelferEinstellungen())
}

func merkeGPUHelferStart(s gpuHelferStart) {
	if daten, err := json.Marshal(s); err == nil {
		_ = os.WriteFile(gpuHelferStartPfad(), daten, 0600)
	}
}

func ladeGPUHelferStart() (gpuHelferStart, bool) {
	var s gpuHelferStart
	roh, err := os.ReadFile(gpuHelferStartPfad())
	if err != nil || json.Unmarshal(roh, &s) != nil {
		return s, false
	}
	return s, true
}

var gpuHelferNeustartMu sync.Mutex

// gpuHelferBeiAenderungNeustarten startet einen LAUFENDEN Helfer neu, wenn seine
// Startwerte nicht mehr den Einstellungen entsprechen. Ein gestoppter Helfer
// bleibt gestoppt. Ohne gemerkte Startwerte (Helfer von einem aelteren Tray)
// wird einmal neu gestartet, damit die Einstellungen sicher gelten.
func gpuHelferBeiAenderungNeustarten() (bool, error) {
	gpuHelferNeustartMu.Lock()
	defer gpuHelferNeustartMu.Unlock()
	if laufenderLokalerGPUHelper() == 0 {
		return false, nil
	}
	c := loadGPUNodeConfig()
	if strings.TrimSpace(c.ComputeToken) == "" {
		return false, nil
	}
	soll := sollGPUHelferStart(c)
	if ist, ok := ladeGPUHelferStart(); ok && ist == soll {
		return false, nil
	}
	if err := stopLokalenGPUHelper(); err != nil {
		return false, err
	}
	return true, startLokalenGPUHelper(c)
}

// gpuHelferEinstellungenBeobachten laeuft im Tray dauerhaft (alle 5 s zwei kleine
// Dateien lesen) und setzt Aenderungen aus jeder Quelle durch.
func gpuHelferEinstellungenBeobachten(stop chan struct{}) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if neu, err := gpuHelferBeiAenderungNeustarten(); err != nil {
				fmt.Fprintln(os.Stderr, "[gpu-helfer] Neustart mit neuen Einstellungen fehlgeschlagen:", err)
			} else if neu {
				fmt.Fprintln(os.Stderr, "[gpu-helfer] mit neuen Einstellungen neu gestartet")
			}
		}
	}
}

type gpuHelferStatus struct {
	Pid            int    `json:"pid"`
	Adresse        string `json:"adresse"`
	Art            string `json:"art"`
	RueckfallAktiv bool   `json:"rueckfall_aktiv"`
	EmbedPauseMs   *int   `json:"embed_pause_ms"`
	Aktualisiert   string `json:"aktualisiert"`
}

// gpuHelferStatusText: welche API-Adresse der laufende Helfer gerade benutzt.
func gpuHelferStatusText() string {
	pid := laufenderLokalerGPUHelper()
	if pid == 0 {
		return "GPU-Helfer läuft nicht."
	}
	var s gpuHelferStatus
	roh, err := os.ReadFile(gpuHelferStatusPfad())
	if err != nil || json.Unmarshal(roh, &s) != nil || s.Pid != pid {
		return "GPU-Helfer läuft; Adressstatus noch nicht gemeldet (älterer Helfer oder Start läuft)."
	}
	text := "API öffentlich: " + s.Adresse
	if s.Art == "lan" {
		text = "API im LAN: " + s.Adresse
	}
	if s.RueckfallAktiv {
		text += " — Rückfall aktiv (LAN nicht erreichbar)"
	}
	if s.EmbedPauseMs != nil {
		text += fmt.Sprintf("; Embed-Pause %d ms", *s.EmbedPauseMs)
	}
	return text
}
