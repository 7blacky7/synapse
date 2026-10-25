package main

// cli_verlauf_schalter.go — P22-T133: Haken "CLI-Verlauf an Synapse" im Tray-Menue.
//
// Der Daemon (file-watcher-daemon-ts/src/cli-verlauf.ts) uebertraegt lokale Claude-Code-Sitzungen mit Synapse-Ausweis
// in den Agenten-Verlauf der Web-UI, aber nur solange cli_verlauf.aktiv:true in ~/.synapse/file-watcher/config.json
// steht (Standard aus). Er liest das Feld in jedem Takt frisch und schreibt es beim Speichern nie mit einem alten
// Stand zurueck (saveConfig). Der Tray setzt nur dieses eine Feld; alle anderen Felder bleiben als json.RawMessage
// erhalten, geschrieben wird atomar ueber eine eigene Temp-Datei (Muster asset_sync_schalter.go). Kein Daemon-Aufruf
// noetig: die Aenderung wirkt ab dem naechsten Takt (15 s).

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"fyne.io/systray"
)

// cliVerlaufLabel ist der Menuetext; der Zustand steht im Titel (wie assetSyncSchalterLabel).
func cliVerlaufLabel(aktiv bool) string {
	if aktiv {
		return "CLI-Verlauf an Synapse: AN  (klick = ausschalten)"
	}
	return "CLI-Verlauf an Synapse: AUS  (klick = einschalten)"
}

// leseCliVerlaufAktiv liefert cli_verlauf.aktiv; fehlt etwas oder ist die Datei unlesbar, gilt der Standard: aus.
func leseCliVerlaufAktiv(cfgPath string) bool {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return false
	}
	var cfg struct {
		CliVerlauf *struct {
			Aktiv *bool `json:"aktiv"`
		} `json:"cli_verlauf"`
	}
	if json.Unmarshal(data, &cfg) != nil || cfg.CliVerlauf == nil || cfg.CliVerlauf.Aktiv == nil {
		return false
	}
	return *cfg.CliVerlauf.Aktiv
}

// setzeCliVerlaufAktiv setzt cli_verlauf.aktiv in cfgPath und laesst alles andere unveraendert. Eine unlesbare
// Datei oder ein kaputtes cli_verlauf-Feld brechen ab, ohne zu schreiben.
func setzeCliVerlaufAktiv(cfgPath string, aktiv bool) error {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return fmt.Errorf("config.json nicht lesbar: %v", err)
	}
	felder := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &felder); err != nil {
		return fmt.Errorf("config.json ist nicht lesbar (%v) — es wurde nichts geaendert", err)
	}
	cv := map[string]json.RawMessage{}
	if r, ok := felder["cli_verlauf"]; ok && strings.TrimSpace(string(r)) != "null" {
		if err := json.Unmarshal(r, &cv); err != nil {
			return fmt.Errorf("cli_verlauf in config.json ungueltig (%v) — es wurde nichts geaendert", err)
		}
	}
	wert, _ := json.Marshal(aktiv)
	cv["aktiv"] = wert
	neuCv, err := json.Marshal(cv)
	if err != nil {
		return err
	}
	felder["cli_verlauf"] = neuCv
	neu, err := json.MarshalIndent(felder, "", "  ")
	if err != nil {
		return err
	}
	neu = append(neu, '\n')

	modus := os.FileMode(0o600)
	if st, err := os.Stat(cfgPath); err == nil {
		modus = st.Mode().Perm()
	}
	tmp := cfgPath + ".tray-cli.tmp"
	if err := os.WriteFile(tmp, neu, modus); err != nil {
		return fmt.Errorf("Schreiben fehlgeschlagen: %v", err)
	}
	if err := os.Chmod(tmp, modus); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("Dateirechte nicht setzbar: %v", err)
	}
	if err := os.Rename(tmp, cfgPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("Ersetzen der config.json fehlgeschlagen: %v", err)
	}
	return nil
}

// cliVerlaufAktiv liest den aktuellen Wert fuer den Menuetext.
func cliVerlaufAktiv() bool {
	pfad, err := trayConfigPfad()
	if err != nil {
		return false
	}
	return leseCliVerlaufAktiv(pfad)
}

// cliVerlaufUmschalten ist der Klick-Handler: Wert von der Platte umkehren, schreiben, Menuetext nachziehen.
func cliVerlaufUmschalten(item *systray.MenuItem) {
	pfad, err := trayConfigPfad()
	if err != nil {
		log.Printf("[tray] CLI-Verlauf: %v", err)
		return
	}
	neu := !leseCliVerlaufAktiv(pfad)
	if err := setzeCliVerlaufAktiv(pfad, neu); err != nil {
		log.Printf("[tray] CLI-Verlauf: config.json nicht geaendert: %v", err)
		return
	}
	log.Printf("[tray] CLI-Verlauf an Synapse: %v", neu)
	item.SetTitle(cliVerlaufLabel(neu))
}
