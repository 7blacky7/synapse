package main

// asset_sync_schalter.go — P13-T45: Schalter "Asset-Sync" je Projekt im Tray-Menue.
//
// Seit P13-T44 synct der Daemon nur Projekte mit projekte[].asset_sync.aktiv:true in
// ~/.synapse/file-watcher/config.json (Standard aus). Der Tray setzt genau dieses eine
// Feld. Alle anderen Felder — oben, im Projekt und im asset_sync-Objekt, auch solche,
// die der Tray nicht kennt — bleiben als json.RawMessage erhalten (Muster wie
// speichereApiToken in api_client.go). Geschrieben wird atomar ueber eine eigene
// Temp-Datei, damit sich Tray und Daemon (config.json.tmp) nicht in die Quere kommen.
//
// Danach meldet der Tray den Wert an den LOKALEN Daemon (POST /projects/:name/asset-sync).
// Der Daemon uebernimmt ihn in seine Konfiguration im Speicher, speichert und startet nur
// die Asset-Bindung dieses Projekts neu. Kein DB-Zugriff, keine Zugangsdaten — nur
// lokale Datei und lokaler Daemon (Regel regel-pc-nur-ueber-api-kein-lokaler-db-zugang).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// trayConfigPfad liefert ~/.synapse/file-watcher/config.json.
func trayConfigPfad() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("Home-Verzeichnis nicht ermittelbar: %v", err)
	}
	return filepath.Join(home, ".synapse", "file-watcher", "config.json"), nil
}

// assetSyncSchalterLabel ist der Menuetext; der Zustand steht im Titel (wie toggleLabel).
func assetSyncSchalterLabel(aktiv bool) string {
	if aktiv {
		return "Asset-Sync: AN  (klick = ausschalten)"
	}
	return "Asset-Sync: AUS  (klick = einschalten)"
}

// leseAssetSyncAktiv liefert projekte[name].asset_sync.aktiv. Fehlt etwas oder ist die
// Datei nicht lesbar, gilt der Standard: aus.
func leseAssetSyncAktiv(cfgPath, name string) bool {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return false
	}
	var cfg struct {
		Projekte []struct {
			Name      string `json:"name"`
			AssetSync *struct {
				Aktiv *bool `json:"aktiv"`
			} `json:"asset_sync"`
		} `json:"projekte"`
	}
	if json.Unmarshal(data, &cfg) != nil {
		return false
	}
	for _, p := range cfg.Projekte {
		if p.Name == name {
			return p.AssetSync != nil && p.AssetSync.Aktiv != nil && *p.AssetSync.Aktiv
		}
	}
	return false
}

// assetSyncAktivFuer: Wert vom Daemon (/projects liefert asset_sync_aktiv), bei aelterem
// Daemon ohne das Feld aus der config.json.
func assetSyncAktivFuer(p Project) bool {
	if p.AssetSyncAktiv != nil {
		return *p.AssetSyncAktiv
	}
	pfad, err := trayConfigPfad()
	if err != nil {
		return false
	}
	return leseAssetSyncAktiv(pfad, p.Name)
}

// setzeAssetSyncAktiv setzt projekte[name].asset_sync.aktiv in cfgPath und laesst alles
// andere unveraendert. Unlesbare Datei, unbekanntes Projekt oder ein kaputtes
// asset_sync-Feld brechen ab, ohne zu schreiben.
func setzeAssetSyncAktiv(cfgPath, name string, aktiv bool) error {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return fmt.Errorf("config.json nicht lesbar: %v", err)
	}
	felder := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &felder); err != nil {
		return fmt.Errorf("config.json ist nicht lesbar (%v) — es wurde nichts geaendert", err)
	}
	roh, ok := felder["projekte"]
	if !ok {
		return fmt.Errorf("Projekt %q steht nicht in config.json — es wurde nichts geaendert", name)
	}
	var projekte []map[string]json.RawMessage
	if err := json.Unmarshal(roh, &projekte); err != nil {
		return fmt.Errorf("projekte in config.json ungueltig (%v) — es wurde nichts geaendert", err)
	}
	gefunden := false
	for _, p := range projekte {
		var pName string
		if json.Unmarshal(p["name"], &pName) != nil || pName != name {
			continue
		}
		as := map[string]json.RawMessage{}
		if r, ok := p["asset_sync"]; ok && strings.TrimSpace(string(r)) != "null" {
			if err := json.Unmarshal(r, &as); err != nil {
				return fmt.Errorf("asset_sync von %q ungueltig (%v) — es wurde nichts geaendert", name, err)
			}
		}
		wert, _ := json.Marshal(aktiv)
		as["aktiv"] = wert
		neuAs, err := json.Marshal(as)
		if err != nil {
			return err
		}
		p["asset_sync"] = neuAs
		gefunden = true
	}
	if !gefunden {
		return fmt.Errorf("Projekt %q steht nicht in config.json — es wurde nichts geaendert", name)
	}
	neuProjekte, err := json.Marshal(projekte)
	if err != nil {
		return err
	}
	felder["projekte"] = neuProjekte
	neu, err := json.MarshalIndent(felder, "", "  ")
	if err != nil {
		return err
	}
	neu = append(neu, '\n')

	modus := os.FileMode(0o600)
	if st, err := os.Stat(cfgPath); err == nil {
		modus = st.Mode().Perm()
	}
	tmp := cfgPath + ".tray.tmp"
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

// meldeAssetSyncAnDaemon uebergibt den Schalter an den lokalen Daemon. Der Daemon setzt
// asset_sync.aktiv auch in seiner Konfiguration im Speicher (sonst wuerde sein naechstes
// Speichern den Tray-Wert wieder ueberschreiben) und startet nur die Asset-Bindung dieses
// Projekts neu. Antwortet erst nach dem Neustart, daher ein grosszuegiger Timeout.
func meldeAssetSyncAnDaemon(basis, name string, aktiv bool) error {
	body, _ := json.Marshal(map[string]bool{"aktiv": aktiv})
	u := strings.TrimRight(basis, "/") + "/projects/" + url.PathEscape(name) + "/asset-sync"
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(u, "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("Daemon nicht erreichbar: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	text, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("Daemon antwortet HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(text)))
}

// assetSyncUmschalten ist der Klick-Handler: angezeigten Zustand umkehren, in config.json
// schreiben, an den Daemon melden, Menuetext nachziehen.
func assetSyncUmschalten(name string) {
	menuMutex.Lock()
	aktuell := false
	if h, ok := projectHandles[name]; ok {
		aktuell = h.AssetSyncAktiv
	}
	daemonPort := port
	menuMutex.Unlock()
	neu := !aktuell

	pfad, err := trayConfigPfad()
	if err == nil {
		err = setzeAssetSyncAktiv(pfad, name, neu)
	}
	if err != nil {
		log.Printf("[tray] Asset-Sync %s: config.json nicht geaendert: %v", name, err)
		return
	}
	if err := meldeAssetSyncAnDaemon(fmt.Sprintf("http://127.0.0.1:%d", daemonPort), name, neu); err != nil {
		// Ein aelterer Daemon ohne den Endpunkt uebernimmt den Wert erst beim naechsten Start.
		log.Printf("[tray] Asset-Sync %s=%v in config.json gesetzt, Daemon hat ihn nicht uebernommen: %v", name, neu, err)
	} else {
		log.Printf("[tray] Asset-Sync %s=%v gesetzt und vom Daemon uebernommen", name, neu)
	}

	menuMutex.Lock()
	if h, ok := projectHandles[name]; ok && h.AssetItem != nil {
		h.AssetSyncAktiv = neu
		h.AssetItem.SetTitle(assetSyncSchalterLabel(neu))
	}
	menuMutex.Unlock()
	triggerRefresh()
}
