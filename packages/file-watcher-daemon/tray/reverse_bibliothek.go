package main

// reverse_bibliothek.go — P18-T17 (RV7): globaler Reverse-Bibliotheksordner im Tray.
//
// Der Tray kennt nur die Synapse-API und den lokalen Daemon (Regel
// regel-pc-nur-ueber-api-kein-lokaler-db-zugang): kein PG, keine Zugangsdaten.
//
//   - config.json (~/.synapse/file-watcher/config.json) top-level
//     reverse_bibliothek {aktiv, pfad, geloeschte_ausblenden}. Geschrieben wird atomar
//     (Temp-Datei + rename), alle fremden Felder bleiben als json.RawMessage erhalten.
//   - Lokaler Daemon: GET /reverse/status, POST /reverse/konfig {aktiv, pfad}.
//   - API (Bearer + Vertrag1): GET /api/reverse/sync-optionen,
//     GET /api/reverse/fundstellen (paginiert), POST /api/reverse/fundstellen/hinweis,
//     GET /api/reverse/fundstellen/original (Binaerweg aus api_binary.go).
//
// Diese Datei enthaelt nur Logik ohne Fyne; das Fenster steht in reverse_bibliothek_ui.go.

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
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Konfiguration (config.json)
// ---------------------------------------------------------------------------

type reverseBibliothekKonfig struct {
	Aktiv                bool
	Pfad                 string
	PfadGesetzt          bool // false = Anzeige-Default, noch nicht in config.json
	GeloeschteAusblenden bool
}

// reverseStandardPfad: Anzeige-Default ~/synapse-reverse (kein absoluter Hardcode).
func reverseStandardPfad() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("Home-Verzeichnis nicht ermittelbar: %v", err)
	}
	return filepath.Join(home, "synapse-reverse"), nil
}

// leseReverseKonfig liest reverse_bibliothek aus cfgPath. Fehlt die Datei, das Objekt
// oder pfad, gilt der Standard (aus, ~/synapse-reverse). Bei unlesbarer Datei kommt
// der Standard zusammen mit dem Fehler zurueck.
func leseReverseKonfig(cfgPath string) (reverseBibliothekKonfig, error) {
	var k reverseBibliothekKonfig
	if standard, err := reverseStandardPfad(); err == nil {
		k.Pfad = standard
	}
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return k, nil
		}
		return k, fmt.Errorf("config.json nicht lesbar: %v", err)
	}
	var cfg struct {
		Reverse *struct {
			Aktiv                *bool   `json:"aktiv"`
			Pfad                 *string `json:"pfad"`
			GeloeschteAusblenden *bool   `json:"geloeschte_ausblenden"`
		} `json:"reverse_bibliothek"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return k, fmt.Errorf("reverse_bibliothek in config.json nicht lesbar: %v", err)
	}
	if r := cfg.Reverse; r != nil {
		if r.Aktiv != nil {
			k.Aktiv = *r.Aktiv
		}
		if r.Pfad != nil && strings.TrimSpace(*r.Pfad) != "" {
			k.Pfad = strings.TrimSpace(*r.Pfad)
			k.PfadGesetzt = true
		}
		if r.GeloeschteAusblenden != nil {
			k.GeloeschteAusblenden = *r.GeloeschteAusblenden
		}
	}
	if k.Pfad == "" {
		return k, fmt.Errorf("Standardordner nicht ermittelbar")
	}
	return k, nil
}

type reverseProjektPfad struct{ Name, Pfad string }

// reverseProjektPfade liest projekte[].{name,pfad} aus config.json (fehlende Datei = keine).
func reverseProjektPfade(cfgPath string) ([]reverseProjektPfad, error) {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("config.json nicht lesbar: %v", err)
	}
	var cfg struct {
		Projekte []struct {
			Name string `json:"name"`
			Pfad string `json:"pfad"`
		} `json:"projekte"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("Projektliste in config.json nicht lesbar: %v", err)
	}
	var out []reverseProjektPfad
	for _, p := range cfg.Projekte {
		if strings.TrimSpace(p.Pfad) != "" {
			out = append(out, reverseProjektPfad{Name: p.Name, Pfad: filepath.Clean(p.Pfad)})
		}
	}
	return out, nil
}

func reverseNormPfad(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

// reversePfadInnerhalb: kind == eltern oder kind liegt darunter.
func reversePfadInnerhalb(kind, eltern string) bool {
	rel, err := filepath.Rel(reverseNormPfad(eltern), reverseNormPfad(kind))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// pruefeReversePfad: absolut, nicht Laufwerkswurzel, nicht $HOME selbst, weder in
// einem Projekt noch ein Projekt enthaltend. Liefert den bereinigten Pfad.
func pruefeReversePfad(cfgPath, pfad string) (string, error) {
	pfad = strings.TrimSpace(pfad)
	if pfad == "" {
		return "", fmt.Errorf("Kein Ordner gewählt")
	}
	if !filepath.IsAbs(pfad) {
		return "", fmt.Errorf("Der Ordner muss ein absoluter Pfad sein: %s", pfad)
	}
	sauber := filepath.Clean(pfad)
	if sauber == filepath.VolumeName(sauber)+string(filepath.Separator) {
		return "", fmt.Errorf("Die Laufwerkswurzel ist als Reverse-Bibliothek nicht erlaubt")
	}
	if home, err := os.UserHomeDir(); err == nil && reverseNormPfad(home) == reverseNormPfad(sauber) {
		return "", fmt.Errorf("Das Home-Verzeichnis selbst ist als Reverse-Bibliothek nicht erlaubt — bitte einen Unterordner wählen")
	}
	if err := reversePruefePunktordner(sauber); err != nil {
		return "", err
	}
	projekte, err := reverseProjektPfade(cfgPath)
	if err != nil {
		return "", err
	}
	for _, p := range projekte {
		if reversePfadInnerhalb(sauber, p.Pfad) {
			return "", fmt.Errorf("Der Ordner liegt im Projekt %q (%s) — die Reverse-Bibliothek muss außerhalb der Projekte liegen", p.Name, p.Pfad)
		}
		if reversePfadInnerhalb(p.Pfad, sauber) {
			return "", fmt.Errorf("Der Ordner enthält das Projekt %q (%s) — bitte einen eigenen Ordner wählen", p.Name, p.Pfad)
		}
	}
	return sauber, nil
}

// reversePruefePunktordner (K4): Punktordner direkt unter $HOME (~/.ssh, ~/.gnupg,
// ~/.config …) und alles darin sind gesperrt — ihr Inhalt soll nie hochgeladen werden.
func reversePruefePunktordner(pfad string) error {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return nil
	}
	if !reversePfadInnerhalb(pfad, home) {
		return nil
	}
	rel, err := filepath.Rel(reverseNormPfad(home), reverseNormPfad(pfad))
	if err != nil || rel == "." {
		return nil
	}
	erster := strings.Split(filepath.ToSlash(rel), "/")[0]
	if strings.HasPrefix(erster, ".") {
		return fmt.Errorf("Versteckte Ordner direkt im Home-Verzeichnis (%s) sind gesperrt — bitte einen anderen Ordner wählen", filepath.Join(home, erster))
	}
	return nil
}

// reversePruefeAndererOrt (K5): frei gewählter Zielordner beim Zurückholen. Muss
// existieren, ein echter Ordner sein und liegt weder in einem Projekt noch in einem
// gesperrten Punktordner — auch nicht über Symlinks. Liefert den aufgelösten Ordner.
func reversePruefeAndererOrt(cfgPath, ordner string) (string, error) {
	ordner = strings.TrimSpace(ordner)
	if !filepath.IsAbs(ordner) {
		return "", fmt.Errorf("Der Zielordner muss ein absoluter Pfad sein: %s", ordner)
	}
	st, err := os.Stat(ordner)
	if err != nil || !st.IsDir() {
		return "", fmt.Errorf("Der Zielordner existiert nicht oder ist kein Ordner: %s", ordner)
	}
	echt, err := filepath.EvalSymlinks(ordner)
	if err != nil {
		return "", fmt.Errorf("Zielordner nicht auflösbar: %v", err)
	}
	projekte, err := reverseProjektPfade(cfgPath)
	if err != nil {
		return "", err
	}
	for _, kandidat := range []string{filepath.Clean(ordner), echt} {
		if err := reversePruefePunktordner(kandidat); err != nil {
			return "", err
		}
		for _, p := range projekte {
			projektEcht := p.Pfad
			if e, err := filepath.EvalSymlinks(p.Pfad); err == nil {
				projektEcht = e
			}
			if reversePfadInnerhalb(kandidat, p.Pfad) || reversePfadInnerhalb(kandidat, projektEcht) {
				return "", fmt.Errorf("Der Zielordner liegt im Projekt %q (%s) — bitte einen Ort außerhalb der Projekte wählen", p.Name, p.Pfad)
			}
		}
	}
	return echt, nil
}

// setzeReverseKonfig setzt die genannten Felder in reverse_bibliothek und laesst alles
// andere unveraendert. Jeder Fehler bricht ab, bevor geschrieben wird.
func setzeReverseKonfig(cfgPath string, aenderung map[string]interface{}) error {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return fmt.Errorf("config.json nicht lesbar (%v) — es wurde nichts geändert", err)
	}
	felder := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &felder); err != nil {
		return fmt.Errorf("config.json ist nicht lesbar (%v) — es wurde nichts geändert", err)
	}
	if felder == nil {
		return fmt.Errorf("config.json muss ein Objekt sein — es wurde nichts geändert")
	}
	rb := map[string]json.RawMessage{}
	if roh, ok := felder["reverse_bibliothek"]; ok && strings.TrimSpace(string(roh)) != "null" {
		if err := json.Unmarshal(roh, &rb); err != nil {
			return fmt.Errorf("reverse_bibliothek in config.json ungültig (%v) — es wurde nichts geändert", err)
		}
	}
	for schluessel, wert := range aenderung {
		roh, err := json.Marshal(wert)
		if err != nil {
			return err
		}
		rb[schluessel] = roh
	}
	neuRb, err := json.Marshal(rb)
	if err != nil {
		return err
	}
	felder["reverse_bibliothek"] = neuRb
	neu, err := json.MarshalIndent(felder, "", "  ")
	if err != nil {
		return err
	}
	return reverseSchreibeAtomar(cfgPath, append(neu, '\n'))
}

// reverseSchreibeAtomar: eigene Temp-Datei im selben Ordner, fsync, Rechte uebernehmen, rename.
func reverseSchreibeAtomar(ziel string, inhalt []byte) error {
	modus := os.FileMode(0o600)
	if st, err := os.Stat(ziel); err == nil {
		modus = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(ziel), ".config-reverse-*.tmp")
	if err != nil {
		return fmt.Errorf("Schreiben fehlgeschlagen: %v", err)
	}
	name := tmp.Name()
	fertig := false
	defer func() {
		if !fertig {
			os.Remove(name)
		}
	}()
	if _, err := tmp.Write(inhalt); err != nil {
		tmp.Close()
		return fmt.Errorf("Schreiben fehlgeschlagen: %v", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("Schreiben fehlgeschlagen: %v", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("Schreiben fehlgeschlagen: %v", err)
	}
	if err := os.Chmod(name, modus); err != nil {
		return fmt.Errorf("Dateirechte nicht setzbar: %v", err)
	}
	if err := os.Rename(name, ziel); err != nil {
		return fmt.Errorf("Ersetzen der config.json fehlgeschlagen: %v", err)
	}
	fertig = true
	return nil
}

// ---------------------------------------------------------------------------
// Tolerante JSON-Typen (Zahlen kommen teils als Text, z. B. bytes_gesamt::text)
// ---------------------------------------------------------------------------

type flexZahl int64

func (z *flexZahl) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		return nil
	}
	s = strings.Trim(s, `"`)
	if s == "" {
		*z = 0
		return nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		*z = flexZahl(n)
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return fmt.Errorf("Zahl erwartet, erhalten %s", s)
	}
	*z = flexZahl(int64(f))
	return nil
}

type flexText string

func (t *flexText) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		*t = ""
		return nil
	}
	var text string
	if err := json.Unmarshal(b, &text); err == nil {
		*t = flexText(text)
		return nil
	}
	*t = flexText(s) // Zahl oder anderes Literal unveraendert als Text
	return nil
}

// rohZahl: Zahl, Zahl als Text oder Laenge einer Liste.
func rohZahl(raw json.RawMessage) (int64, bool) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return 0, false
	}
	var z flexZahl
	if err := json.Unmarshal(raw, &z); err == nil {
		return int64(z), true
	}
	var liste []json.RawMessage
	if err := json.Unmarshal(raw, &liste); err == nil {
		return int64(len(liste)), true
	}
	return 0, false
}

// rohText: JSON-String ohne Anfuehrungszeichen, sonst kompaktes JSON.
func rohText(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) == nil {
		return buf.String()
	}
	return s
}

// menschenBytes: 4294967296 -> "4,0 GiB".
func menschenBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d Bytes", n)
	}
	wert := float64(n)
	einheiten := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	i := -1
	for wert >= 1024 && i < len(einheiten)-1 {
		wert /= 1024
		i++
	}
	return strings.Replace(fmt.Sprintf("%.1f %s", wert, einheiten[i]), ".", ",", 1)
}

// ---------------------------------------------------------------------------
// Lokaler Daemon
// ---------------------------------------------------------------------------

type reverseDaemonAuftrag struct {
	Pfad          string    `json:"pfad"`
	Art           string    `json:"art"`
	BytesErledigt *flexZahl `json:"bytes_erledigt"`
	Groesse       *flexZahl `json:"groesse"`
	Fehler        string    `json:"fehler"`
}

type reverseDaemonStatus struct {
	Aktiv         bool                   `json:"aktiv"`
	Pfad          string                 `json:"pfad"`
	Modus         string                 `json:"modus"`
	Fehler        string                 `json:"fehler"`
	Policy        json.RawMessage        `json:"policy"`
	Auftraege     []reverseDaemonAuftrag `json:"auftraege"`
	Erkannt       json.RawMessage        `json:"erkannt"`
	WartendStabil json.RawMessage        `json:"wartend_stabil"`
}

func daemonReverseStatus(ctx context.Context) (reverseDaemonStatus, error) {
	var r reverseDaemonStatus
	err := daemonAssetJSON(ctx, "/reverse/status", &r)
	if err != nil && strings.Contains(err.Error(), "HTTP 404") {
		err = fmt.Errorf("Lokaler Daemon kennt die Reverse-Bibliothek noch nicht (HTTP 404)")
	}
	return r, err
}

// daemonReverseKonfig meldet Felder von reverse_bibliothek (aktiv, pfad,
// geloeschte_ausblenden) an den lokalen Daemon (Loopback), damit sein naechstes
// saveConfig keinen alten Wert zurueckschreibt (M1).
func daemonReverseKonfig(ctx context.Context, basis string, felder map[string]interface{}) error {
	body, err := json.Marshal(felder)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(basis, "/")+"/reverse/konfig", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := *apiHttpClient
	client.Timeout = 20 * time.Second
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Daemon nicht erreichbar")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	text, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("Daemon antwortet HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(text)))
}

func reverseDaemonModusText(modus string) string {
	switch modus {
	case "aus":
		return "aus"
	case "offen":
		return "offen (wartet auf Synapse)"
	case "api":
		return "mit Synapse verbunden"
	case "fehler":
		return "Fehler"
	case "":
		return "nicht gemeldet"
	}
	return modus
}

func reverseDaemonText(s reverseDaemonStatus) string {
	teile := []string{"Lokaler Daemon: " + reverseDaemonModusText(s.Modus)}
	if s.Aktiv {
		teile = append(teile, "aktiv")
	} else {
		teile = append(teile, "nicht aktiv")
	}
	if s.Pfad != "" {
		teile = append(teile, "Ordner "+s.Pfad)
	}
	if n, ok := rohZahl(s.Erkannt); ok {
		teile = append(teile, fmt.Sprintf("%d erkannt", n))
	}
	if n, ok := rohZahl(s.WartendStabil); ok {
		teile = append(teile, fmt.Sprintf("%d warten auf stabile Größe", n))
	}
	teile = append(teile, fmt.Sprintf("%d laufende Transfers", len(s.Auftraege)))
	text := strings.Join(teile, " · ")
	if s.Fehler != "" {
		text += "\nFehler: " + s.Fehler
	}
	// P18-T63: Fehler einzelner Transfers ebenfalls zeigen (hoechstens drei).
	n := 0
	for _, a := range s.Auftraege {
		if strings.TrimSpace(a.Fehler) == "" {
			continue
		}
		if n == 3 {
			text += "\n…"
			break
		}
		text += "\nTransfer " + filepath.Base(a.Pfad) + ": " + a.Fehler
		n++
	}
	return text
}

// ---------------------------------------------------------------------------
// PC-Zuordnung (P18-T63)
// ---------------------------------------------------------------------------
//
// Ohne explizite Daemon-Hostbindung laedt der Daemon nichts hoch (Modus "offen",
// fehler "Explizite Daemon-Hostbindung fehlt."). Die Loesung lag bisher nur im
// Fenster "Projekte auf diesem PC / Asset-Sync". Das Reverse-Fenster prueft die
// Zuordnung deshalb selbst – mit denselben Funktionen (daemonAssetHost,
// apiAssetDaemonHost, apiBindAssetDaemonHost) – und bietet denselben Knopf.

// reverseCodeHostNichtGebunden: API-Fehlercode bei fehlender Daemon-Hostbindung.
const reverseCodeHostNichtGebunden = "daemon_host_nicht_gebunden"

type reversePCZuordnung struct {
	Host       string // dieser PC laut lokalem Daemon
	Zugeordnet string // vom Server bestaetigter PC ("" = keiner)
	Fehler     error
}

// Fehlt: PC bekannt, Server hat keinen PC zugeordnet -> Knopf anbieten.
func (z reversePCZuordnung) Fehlt() bool {
	return z.Fehler == nil && z.Host != "" && z.Zugeordnet == ""
}

// AndererPC: Zugang gehoert einem anderen PC -> nur Hinweis, kein Knopf.
func (z reversePCZuordnung) AndererPC() bool {
	return z.Fehler == nil && z.Host != "" && z.Zugeordnet != "" && z.Zugeordnet != z.Host
}

// reverseZuordnungPruefen: nur nachsehen, wenn der Daemon nicht mit Synapse
// verbunden ist, einen Fehler meldet oder die API die fehlende Bindung nennt.
// Im Normalbetrieb (Modus "api", kein Fehler) entstehen keine Zusatzabfragen.
func reverseZuordnungPruefen(s reverseDaemonStatus, daemonErr error, apiFehler ...error) bool {
	for _, e := range apiFehler {
		var f *reverseAPIFehler
		if errors.As(e, &f) && f.Code == reverseCodeHostNichtGebunden {
			return true
		}
	}
	if daemonErr != nil || !s.Aktiv {
		return false
	}
	return s.Modus == "offen" || s.Modus == "fehler" || strings.TrimSpace(s.Fehler) != ""
}

// reverseLadePCZuordnung fragt den lokalen Daemon (eigener Host) und die API (Zuordnung).
func reverseLadePCZuordnung(ctx context.Context) reversePCZuordnung {
	host, err := daemonAssetHost(ctx)
	if err != nil {
		return reversePCZuordnung{Fehler: err}
	}
	zugeordnet, err := apiAssetDaemonHost(ctx)
	return reversePCZuordnung{Host: host, Zugeordnet: zugeordnet, Fehler: err}
}

// reverseZuordnungText: Klartext fuer das Fenster ("" = alles in Ordnung).
func reverseZuordnungText(z reversePCZuordnung) string {
	switch {
	case z.Fehler != nil:
		return "PC-Zuordnung konnte nicht geprüft werden: " + z.Fehler.Error()
	case z.Fehlt():
		return "Dieser PC ist noch nicht bei Synapse zugeordnet: " + z.Host + ". Ohne Zuordnung lädt der Daemon nichts hoch."
	case z.AndererPC():
		return "Der Zugang ist einem anderen PC zugeordnet: " + z.Zugeordnet + ". Dieser PC ist " + z.Host + "."
	}
	return ""
}

// reversePCZuordnen ordnet diesen PC zu (apiBindAssetDaemonHost) und stoesst den
// lokalen Daemon per POST /reverse/konfig zum sofortigen Neuversuch an (nur wenn
// die Reverse-Bibliothek aktiv ist; aktiv/pfad startet dort die Bindung neu).
// err = Zuordnung fehlgeschlagen; neuversuch = Zuordnung ok, Anstoss nicht.
func reversePCZuordnen(ctx context.Context, cfgPfad, host, daemonBasis string) (neuversuch error, err error) {
	if err := apiBindAssetDaemonHost(ctx, host); err != nil {
		return nil, err
	}
	if cfgPfad == "" {
		return fmt.Errorf("config.json nicht auffindbar"), nil
	}
	k, kErr := leseReverseKonfig(cfgPfad)
	if kErr != nil {
		return kErr, nil
	}
	if !k.Aktiv {
		return nil, nil
	}
	return daemonReverseKonfig(ctx, daemonBasis, map[string]interface{}{"aktiv": true}), nil
}

// ---------------------------------------------------------------------------
// Synapse-API
// ---------------------------------------------------------------------------

var errReverseDeaktiviert = errors.New("Reverse-Bibliothek auf dem Server nicht freigegeben")

const reverseAntwortGrenze = 16 * 1024 * 1024

type reverseAPIFehler struct {
	Status int
	Code   string
	Text   string
}

func (e *reverseAPIFehler) Error() string {
	text := fmt.Sprintf("Synapse antwortet HTTP %d", e.Status)
	if e.Code != "" {
		text += " (" + e.Code + ")"
	}
	if e.Text != "" {
		text += ": " + e.Text
	}
	if e.Status == http.StatusNotFound && e.Code == "" {
		text += " — Server kennt diese Reverse-Route noch nicht"
	}
	return text
}

func reverseFehlerAus(status int, body []byte) *reverseAPIFehler {
	f := &reverseAPIFehler{Status: status}
	var roh struct {
		Error   json.RawMessage `json:"error"`
		Code    string          `json:"code"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(body, &roh) == nil {
		f.Code, f.Text = roh.Code, roh.Message
		var obj struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(roh.Error, &obj) == nil && (obj.Code != "" || obj.Message != "") {
			f.Code, f.Text = obj.Code, obj.Message
		} else if text := rohText(roh.Error); text != "" && f.Text == "" {
			f.Text = text
		}
	}
	if f.Code == "" && f.Text == "" {
		f.Text = strings.TrimSpace(string(body))
		if len(f.Text) > 300 {
			f.Text = f.Text[:300] + " …"
		}
	}
	return f
}

// apiReverseJSON: wie apiAssetJSON (Bearer, Vertrag1, Fallback-Kette), aber eine
// 503-Antwort mit code 'deaktiviert' ist eine echte Serverantwort und kein Grund,
// die naechste Basis zu probieren.
func apiReverseJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	client := *apiHttpClient
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	token := apiToken()
	var versuche []string
	for _, base := range apiBases() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, base+path, rdr)
		if err != nil {
			versuche = append(versuche, base+": "+err.Error())
			continue
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("X-Synapse-Contract-Version", "1")
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			forgetBase(base)
			versuche = append(versuche, base+": Transportfehler")
			continue
		}
		antwort, lesFehler := io.ReadAll(io.LimitReader(resp.Body, reverseAntwortGrenze+1))
		resp.Body.Close()
		if lesFehler != nil {
			forgetBase(base)
			versuche = append(versuche, base+": Antwort abgebrochen")
			continue
		}
		if len(antwort) > reverseAntwortGrenze {
			return fmt.Errorf("Antwort von Synapse überschreitet die Grenze")
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			rememberBase(base)
			if out == nil {
				return nil
			}
			if err := json.Unmarshal(antwort, out); err != nil {
				return fmt.Errorf("Antwort von Synapse nicht lesbar: %v", err)
			}
			return nil
		}
		fehler := reverseFehlerAus(resp.StatusCode, antwort)
		if fehler.Code == "deaktiviert" {
			return errReverseDeaktiviert
		}
		if resp.StatusCode >= 500 && resp.StatusCode < 600 {
			forgetBase(base)
			versuche = append(versuche, fmt.Sprintf("%s: HTTP %d", base, resp.StatusCode))
			continue
		}
		return fehler
	}
	return fmt.Errorf("Synapse-API nicht erreichbar: %s", strings.Join(versuche, "; "))
}

type reverseSyncOptionen struct {
	Success            *bool           `json:"success"`
	Host               string          `json:"host"`
	ChunkBytes         *flexZahl       `json:"chunkBytes"`
	MaxDateiBytes      *flexZahl       `json:"maxDateiBytes"`
	MaxBatch           *flexZahl       `json:"maxBatch"`
	StabilMs           *flexZahl       `json:"stabilMs"`
	LoeschVerhalten    json.RawMessage `json:"loesch_verhalten"`
	ErlaubtAlleDateien *bool           `json:"erlaubt_alle_dateien"`
	Endungen           struct {
		Images     []string                `json:"images"`
		Companions []reverseCompanionRegel `json:"companions"`
	} `json:"endungen"`
}

// reverseCompanionRegel: Serverform (core ReverseCompanionRegel), z. B.
// {"format":"ccd","endungen":["ccd"],"pflicht":["img"],"optional":["sub"]}.
// Ein blosser String wird tolerant als Format mit gleicher Endung gelesen.
type reverseCompanionRegel struct {
	Format     string   `json:"format"`
	Endungen   []string `json:"endungen"`
	Referenzen string   `json:"referenzen"`
	Pflicht    []string `json:"pflicht"`
	Optional   []string `json:"optional"`
}

func (r *reverseCompanionRegel) UnmarshalJSON(b []byte) error {
	var text string
	if json.Unmarshal(b, &text) == nil {
		*r = reverseCompanionRegel{Format: text, Endungen: []string{text}}
		return nil
	}
	type roh reverseCompanionRegel
	var v roh
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*r = reverseCompanionRegel(v)
	return nil
}

func reverseMitPunkt(endungen []string) []string {
	out := make([]string, 0, len(endungen))
	for _, e := range endungen {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if !strings.HasPrefix(e, ".") {
			e = "." + e
		}
		out = append(out, e)
	}
	return out
}

// reverseCompanionText: ".ccd → .img (Pflicht), .sub (optional)" bzw. ".cue (Dateien laut Inhalt)".
func reverseCompanionText(r reverseCompanionRegel) string {
	endungen := reverseMitPunkt(r.Endungen)
	if len(endungen) == 0 && r.Format != "" {
		endungen = reverseMitPunkt([]string{r.Format})
	}
	text := strings.Join(endungen, "/")
	var ziele []string
	for _, p := range reverseMitPunkt(r.Pflicht) {
		ziele = append(ziele, p+" (Pflicht)")
	}
	for _, o := range reverseMitPunkt(r.Optional) {
		ziele = append(ziele, o+" (optional)")
	}
	if r.Referenzen != "" {
		ziele = append(ziele, "Dateien laut Inhalt")
	}
	if len(ziele) > 0 {
		text += " → " + strings.Join(ziele, ", ")
	}
	return text
}

func apiReverseSyncOptionen(ctx context.Context) (reverseSyncOptionen, error) {
	var o reverseSyncOptionen
	err := apiReverseJSON(ctx, http.MethodGet, "/api/reverse/sync-optionen", nil, &o)
	if err == nil && o.Success != nil && !*o.Success {
		err = fmt.Errorf("Synapse hat die Reverse-Einstellungen abgelehnt")
	}
	return o, err
}

func reverseEndungenText(liste []string) string {
	if len(liste) == 0 {
		return "keine gemeldet"
	}
	kopie := append([]string(nil), liste...)
	sort.Strings(kopie)
	return strings.Join(kopie, ", ")
}

// reverseLoeschText: nur Anzeige. 'mitloeschen' ist serverseitig nicht umgesetzt (K7)
// und wird im Tray nirgends als Option angeboten.
func reverseLoeschText(raw json.RawMessage) string {
	text := rohText(raw)
	switch text {
	case "":
		return "vom Server nicht gemeldet"
	case "behalten":
		return "behalten: lokales Löschen entfernt nichts auf Unraid"
	case "mitloeschen":
		return "Server meldet „mitloeschen“, das ist dort nicht umgesetzt: lokales Löschen entfernt nichts auf Unraid"
	}
	return text
}

// reversePolicyZeilen: lesbare Anzeige der Server-Policy; nichts davon ist im Tray verdrahtet.
func reversePolicyZeilen(o reverseSyncOptionen) []string {
	z := []string{}
	if o.MaxDateiBytes != nil && *o.MaxDateiBytes > 0 {
		z = append(z, "Max. Dateigröße: "+menschenBytes(int64(*o.MaxDateiBytes)))
	} else {
		z = append(z, "Max. Dateigröße: vom Server nicht gemeldet")
	}
	z = append(z, "Erkannte Image-Endungen: "+reverseEndungenText(reverseMitPunkt(o.Endungen.Images)))
	if len(o.Endungen.Companions) == 0 {
		z = append(z, "Begleitdateien: keine gemeldet")
	} else {
		begleit := make([]string, 0, len(o.Endungen.Companions))
		for _, r := range o.Endungen.Companions {
			begleit = append(begleit, reverseCompanionText(r))
		}
		z = append(z, "Begleitdateien: "+strings.Join(begleit, "; "))
	}
	if o.ErlaubtAlleDateien != nil {
		if *o.ErlaubtAlleDateien {
			z = append(z, "Angenommen werden alle Dateien.")
		} else {
			z = append(z, "Angenommen werden nur die genannten Endungen.")
		}
	}
	z = append(z, "Lösch-Verhalten: "+reverseLoeschText(o.LoeschVerhalten))
	var technik []string
	if o.ChunkBytes != nil && *o.ChunkBytes > 0 {
		technik = append(technik, "Upload-Block "+menschenBytes(int64(*o.ChunkBytes)))
	}
	if o.MaxBatch != nil && *o.MaxBatch > 0 {
		technik = append(technik, fmt.Sprintf("max. %d Dateien je Meldung", int64(*o.MaxBatch)))
	}
	if o.StabilMs != nil && *o.StabilMs > 0 {
		technik = append(technik, fmt.Sprintf("Datei gilt nach %s ohne Änderung als fertig", time.Duration(int64(*o.StabilMs))*time.Millisecond))
	}
	if len(technik) > 0 {
		z = append(z, strings.Join(technik, " · "))
	}
	return z
}

type reverseFortschritt struct {
	DateienGesamt *flexZahl `json:"dateien_gesamt"`
	DateienFertig *flexZahl `json:"dateien_fertig"`
	BytesGesamt   *flexZahl `json:"bytes_gesamt"`
	BytesErledigt *flexZahl `json:"bytes_erledigt"`
}

type reverseFundstelle struct {
	ID                  flexText            `json:"id"`
	RelPfad             string              `json:"rel_pfad"`
	SHA256              string              `json:"sha256"`
	ReverseID           flexText            `json:"reverse_id"`
	Status              string              `json:"status"`
	Fehlercode          string              `json:"fehlercode"`
	MediumID            flexText            `json:"medium_id"`
	Art                 string              `json:"art"`
	Vorschlag           json.RawMessage     `json:"vorschlag"`
	Fortschritt         *reverseFortschritt `json:"fortschritt"`
	Lokal               string              `json:"lokal"`
	HinweisAusgeblendet bool                `json:"hinweis_ausgeblendet"`
	Gesichert           *bool               `json:"gesichert"` // M3: Bytes ready auf Unraid
}

type reverseFundSeite struct {
	Success      *bool               `json:"success"`
	Dateien      []reverseFundstelle `json:"dateien"`
	Vollstaendig bool                `json:"vollstaendig"`
	Cursor       *string             `json:"cursor"`
}

const (
	reverseSeitenGrenze  = 1000
	reverseEintragGrenze = 200000
)

// apiReverseFundstellen holt alle Seiten. Ein abgelaufener Snapshot (410) wird einmal
// von vorn begonnen.
func apiReverseFundstellen(ctx context.Context) ([]reverseFundstelle, error) {
	liste, err := apiReverseFundstellenLauf(ctx)
	var fe *reverseAPIFehler
	if errors.As(err, &fe) && fe.Status == http.StatusGone {
		liste, err = apiReverseFundstellenLauf(ctx)
	}
	return liste, err
}

func apiReverseFundstellenLauf(ctx context.Context) ([]reverseFundstelle, error) {
	var alle []reverseFundstelle
	cursor := ""
	gesehen := map[string]bool{}
	for seite := 0; ; seite++ {
		if seite >= reverseSeitenGrenze {
			return nil, fmt.Errorf("Fundstellenliste hat mehr als %d Seiten — abgebrochen", reverseSeitenGrenze)
		}
		pfad := "/api/reverse/fundstellen"
		if cursor != "" {
			pfad += "?cursor=" + url.QueryEscape(cursor)
		}
		var s reverseFundSeite
		if err := apiReverseJSON(ctx, http.MethodGet, pfad, nil, &s); err != nil {
			return nil, err
		}
		if s.Success != nil && !*s.Success {
			return nil, fmt.Errorf("Synapse hat die Fundstellenliste abgelehnt")
		}
		alle = append(alle, s.Dateien...)
		if len(alle) > reverseEintragGrenze {
			return nil, fmt.Errorf("Fundstellenliste überschreitet %d Einträge — abgebrochen", reverseEintragGrenze)
		}
		if s.Vollstaendig {
			return alle, nil
		}
		if s.Cursor == nil || *s.Cursor == "" {
			return nil, fmt.Errorf("Fundstellenliste unvollständig, aber ohne Cursor")
		}
		if gesehen[*s.Cursor] {
			return nil, fmt.Errorf("Synapse wiederholt denselben Cursor — abgebrochen")
		}
		gesehen[*s.Cursor] = true
		cursor = *s.Cursor
	}
}

// apiReverseHinweis blendet den Lokal-Hinweis einer Fundstelle aus (oder wieder ein).
func apiReverseHinweis(ctx context.Context, relPfad string, ausblenden bool) error {
	if strings.TrimSpace(relPfad) == "" {
		return fmt.Errorf("Fundstelle ohne Pfad")
	}
	var r struct {
		Success *bool `json:"success"`
	}
	err := apiReverseJSON(ctx, http.MethodPost, "/api/reverse/fundstellen/hinweis",
		map[string]interface{}{"rel_pfad": relPfad, "ausblenden": ausblenden}, &r)
	if err == nil && (r.Success == nil || !*r.Success) {
		err = fmt.Errorf("Synapse hat den Hinweis nicht geändert")
	}
	return err
}

// ---------------------------------------------------------------------------
// Status-Texte
// ---------------------------------------------------------------------------

// reverseIstGesichert (M3): massgeblich ist das API-Feld gesichert (Bytes ready),
// auch wenn die Analyse danach mit 'fehler' endet. Ohne Feld: Status ab 'hochgeladen'.
func reverseIstGesichert(f *reverseFundstelle) bool {
	if f == nil {
		return false
	}
	if f.Gesichert != nil {
		return *f.Gesichert
	}
	return reverseGesichert(f.Status)
}

// reverseGesichert: Rueckfall ueber den Status, ab 'hochgeladen' liegen die Bytes hash-geprueft auf Unraid.
func reverseGesichert(status string) bool {
	switch status {
	case "hochgeladen", "entpackt", "S0", "S1", "S2", "S3":
		return true
	}
	return false
}

const (
	reverseTextGesichert      = "sicher auf Unraid (Hash geprüft) – lokal löschbar"
	reverseTextNichtGesichert = "noch nicht gesichert"
)

func reverseSicherungText(gesichert bool) string {
	if gesichert {
		return reverseTextGesichert
	}
	return reverseTextNichtGesichert
}

func reverseStatusText(status string) string {
	switch status {
	case "erkannt":
		return "erkannt, Upload ausstehend"
	case "hochgeladen":
		return "hochgeladen"
	case "entpackt":
		return "entpackt"
	case "S0", "S1", "S2", "S3":
		return "analysiert bis Stufe " + status
	case "fehler":
		return "Fehler"
	case "":
		return "unbekannt"
	}
	return status
}

func reverseArtText(art string) string {
	switch art {
	case "":
		return "unbekannt"
	case "image":
		return "Datenträger-Image"
	case "ordner":
		return "Ordner"
	case "archiv":
		return "Archiv"
	}
	return art
}

// reverseLokalHinweis: Hinweis zum lokalen Zustand; warnung=true bei Datenverlust-Risiko.
func reverseLokalHinweis(f *reverseFundstelle) (text string, warnung bool) {
	switch f.Lokal {
	case "geloescht_lokal":
		if reverseIstGesichert(f) {
			return "lokal gelöscht – Original sicher auf Unraid", false
		}
		return "lokal gelöscht, noch nicht gesichert", true
	case "fehlt":
		return "verschoben/umbenannt", false
	}
	return "", false
}

// reverseHatLokalHinweis: Eintraege mit Aktionen "Hinweis ausblenden"/"Zurueckholen".
func reverseHatLokalHinweis(f *reverseFundstelle) bool {
	return f != nil && (f.Lokal == "geloescht_lokal" || f.Lokal == "fehlt")
}

// reverseVorschlagText: vorschlag lesbar (haupt, fehlende_dateien, confidence) + volles JSON.
func reverseVorschlagText(raw json.RawMessage) (string, bool) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" || s == "{}" {
		return "", false
	}
	var v struct {
		Haupt      json.RawMessage   `json:"haupt"`
		Fehlende   []json.RawMessage `json:"fehlende_dateien"`
		Confidence *float64          `json:"confidence"`
	}
	z := []string{}
	if json.Unmarshal(raw, &v) == nil {
		if h := rohText(v.Haupt); h != "" {
			z = append(z, "Hauptdatei: "+h)
		} else {
			z = append(z, "Hauptdatei: nicht bestimmt")
		}
		if len(v.Fehlende) == 0 {
			z = append(z, "Fehlende Dateien: keine")
		} else {
			z = append(z, "Fehlende Dateien:")
			for _, f := range v.Fehlende {
				z = append(z, "  • "+rohText(f))
			}
		}
		if v.Confidence != nil {
			z = append(z, fmt.Sprintf("Confidence: %.2f", *v.Confidence))
		}
	}
	var schoen bytes.Buffer
	if json.Indent(&schoen, raw, "", "  ") == nil {
		z = append(z, "", "Vollständiger Vorschlag:", schoen.String())
	} else {
		z = append(z, "", "Vollständiger Vorschlag:", s)
	}
	z = append(z, "", "Nur zur Information: Bestätigt wird über das Tool reverse bzw. die Web-UI.")
	return strings.Join(z, "\n"), true
}

// ---------------------------------------------------------------------------
// Statusbaum
// ---------------------------------------------------------------------------

type reverseKnoten struct {
	UID       string
	Name      string
	Pfad      string
	Ordner    bool
	Datei     *reverseFundstelle
	Auftrag   *reverseDaemonAuftrag
	Gesamt    int
	Gesichert int
	Warnungen int
}

type reverseBaum struct {
	Kinder       map[string][]string
	Knoten       map[string]*reverseKnoten
	Dateien      int
	Gesichert    int
	Ausgeblendet int
}

type reverseFilter struct {
	GeloeschteAusblenden bool // globaler Schalter aus config.json
	AusgeblendeteZeigen  bool // "ausgeblendete Hinweise zeigen"
}

func reverseVersteckt(f *reverseFundstelle, filter reverseFilter) bool {
	if filter.GeloeschteAusblenden && f.Lokal == "geloescht_lokal" {
		return true
	}
	return f.HinweisAusgeblendet && reverseHatLokalHinweis(f) && !filter.AusgeblendeteZeigen
}

func reversePfadTeile(rel string) []string {
	rel = strings.ReplaceAll(rel, "\\", "/")
	var out []string
	for _, teil := range strings.Split(rel, "/") {
		if teil != "" && teil != "." {
			out = append(out, teil)
		}
	}
	return out
}

// reverseRelSchluessel macht Daemon-Pfade (absolut oder relativ) mit rel_pfad vergleichbar.
func reverseRelSchluessel(wurzel, pfad string) string {
	if filepath.IsAbs(pfad) && wurzel != "" {
		if rel, err := filepath.Rel(wurzel, pfad); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			pfad = rel
		}
	}
	return strings.Join(reversePfadTeile(filepath.ToSlash(pfad)), "/")
}

// baueReverseBaum ordnet die Fundstellen wie im Ordner an (Ordnerknoten aus rel_pfad)
// und haengt laufende Daemon-Transfers an. Lokal geloeschte Dateien bleiben sichtbar,
// solange sie in der API-Liste stehen und der Filter sie nicht ausblendet.
func baueReverseBaum(dateien []reverseFundstelle, auftraege []reverseDaemonAuftrag, wurzel string, filter reverseFilter) reverseBaum {
	b := reverseBaum{Kinder: map[string][]string{}, Knoten: map[string]*reverseKnoten{}}
	b.Knoten[""] = &reverseKnoten{UID: "", Ordner: true}
	jobs := map[string]*reverseDaemonAuftrag{}
	for i := range auftraege {
		jobs[reverseRelSchluessel(wurzel, auftraege[i].Pfad)] = &auftraege[i]
	}
	benutzt := map[string]bool{}
	einhaengen := func(teile []string, bau func(uid string) *reverseKnoten) *reverseKnoten {
		eltern, ordnerPfad := "", ""
		var vorfahren []*reverseKnoten
		for _, teil := range teile[:len(teile)-1] {
			if ordnerPfad == "" {
				ordnerPfad = teil
			} else {
				ordnerPfad += "/" + teil
			}
			uid := "d:" + ordnerPfad
			k, ok := b.Knoten[uid]
			if !ok {
				k = &reverseKnoten{UID: uid, Name: teil, Pfad: ordnerPfad, Ordner: true}
				b.Knoten[uid] = k
				b.Kinder[eltern] = append(b.Kinder[eltern], uid)
			}
			vorfahren = append(vorfahren, k)
			eltern = uid
		}
		basis := "f:" + strings.Join(teile, "/")
		uid := basis
		for n := 2; b.Knoten[uid] != nil; n++ {
			uid = fmt.Sprintf("%s#%d", basis, n)
		}
		k := bau(uid)
		b.Knoten[uid] = k
		b.Kinder[eltern] = append(b.Kinder[eltern], uid)
		for _, v := range append(vorfahren, b.Knoten[""]) {
			v.Gesamt++
			if reverseIstGesichert(k.Datei) {
				v.Gesichert++
			}
			if k.Warnungen > 0 {
				v.Warnungen++
			}
		}
		return k
	}
	for i := range dateien {
		f := &dateien[i]
		if reverseVersteckt(f, filter) {
			b.Ausgeblendet++
			continue
		}
		teile := reversePfadTeile(f.RelPfad)
		if len(teile) == 0 {
			teile = []string{"(ohne Pfad)"}
		}
		schluessel := strings.Join(teile, "/")
		job := jobs[schluessel]
		if job != nil {
			benutzt[schluessel] = true
		}
		einhaengen(teile, func(uid string) *reverseKnoten {
			k := &reverseKnoten{UID: uid, Name: teile[len(teile)-1], Pfad: schluessel, Datei: f, Auftrag: job, Gesamt: 1}
			if _, warnung := reverseLokalHinweis(f); warnung || f.Status == "fehler" {
				k.Warnungen = 1
			}
			return k
		})
		b.Dateien++
		if reverseIstGesichert(f) {
			b.Gesichert++
		}
	}
	// Transfers, die der Server noch nicht als Fundstelle fuehrt.
	for schluessel, job := range jobs {
		if benutzt[schluessel] {
			continue
		}
		teile := reversePfadTeile(schluessel)
		if len(teile) == 0 {
			continue
		}
		j := job
		einhaengen(teile, func(uid string) *reverseKnoten {
			return &reverseKnoten{UID: uid, Name: teile[len(teile)-1], Pfad: schluessel, Auftrag: j, Gesamt: 1}
		})
	}
	for eltern, kinder := range b.Kinder {
		sort.SliceStable(kinder, func(i, j int) bool {
			a, c := b.Knoten[kinder[i]], b.Knoten[kinder[j]]
			if a.Ordner != c.Ordner {
				return a.Ordner
			}
			if a.Name != c.Name {
				return strings.ToLower(a.Name) < strings.ToLower(c.Name)
			}
			return a.UID < c.UID
		})
		b.Kinder[eltern] = kinder
	}
	return b
}

// reverseKnotenTitel: eine Zeile im Baum.
func reverseKnotenTitel(k *reverseKnoten) string {
	if k == nil {
		return ""
	}
	if k.Ordner {
		return fmt.Sprintf("%s/  (%d, davon %d sicher auf Unraid)", k.Name, k.Gesamt, k.Gesichert)
	}
	if k.Datei == nil {
		return k.Name + " · Upload läuft (noch nicht beim Server gemeldet) · " + reverseTextNichtGesichert
	}
	f := k.Datei
	teile := []string{k.Name, reverseStatusText(f.Status), reverseSicherungText(reverseIstGesichert(f))}
	if h, _ := reverseLokalHinweis(f); h != "" {
		if f.HinweisAusgeblendet {
			h += " (Hinweis ausgeblendet)"
		}
		teile = append(teile, h)
	}
	return strings.Join(teile, " · ")
}

// reverseKnotenZeilen: Detailansicht eines Knotens.
func reverseKnotenZeilen(k *reverseKnoten) []string {
	if k == nil {
		return nil
	}
	if k.Ordner {
		return []string{
			"Ordner: " + k.Pfad,
			fmt.Sprintf("%d Einträge, davon %d sicher auf Unraid", k.Gesamt, k.Gesichert),
			fmt.Sprintf("%d mit Warnung", k.Warnungen),
		}
	}
	z := []string{"Pfad: " + k.Pfad}
	if f := k.Datei; f != nil {
		z = append(z, "Status: "+reverseStatusText(f.Status), "Medienart: "+reverseArtText(f.Art), reverseSicherungText(reverseIstGesichert(f)))
		if h, warnung := reverseLokalHinweis(f); h != "" {
			if warnung {
				h = "WARNUNG: " + h
			}
			z = append(z, "Lokal: "+h)
			if f.HinweisAusgeblendet {
				z = append(z, "Hinweis ist ausgeblendet.")
			}
		}
		if f.Fehlercode != "" {
			z = append(z, "Fehler: "+f.Fehlercode)
		}
		if p := f.Fortschritt; p != nil {
			if p.DateienGesamt != nil {
				fertig := int64(0)
				if p.DateienFertig != nil {
					fertig = int64(*p.DateienFertig)
				}
				z = append(z, fmt.Sprintf("Dateien: %d / %d fertig", fertig, int64(*p.DateienGesamt)))
			}
			if p.BytesGesamt != nil {
				erledigt := int64(0)
				if p.BytesErledigt != nil {
					erledigt = int64(*p.BytesErledigt)
				}
				z = append(z, fmt.Sprintf("Bytes: %s / %s", menschenBytes(erledigt), menschenBytes(int64(*p.BytesGesamt))))
			}
		}
		if f.ReverseID != "" {
			z = append(z, "Reverse-Eintrag: "+string(f.ReverseID))
		}
		if f.SHA256 != "" {
			hash := f.SHA256
			if len(hash) > 16 {
				hash = hash[:16] + "…"
			}
			z = append(z, "SHA-256: "+hash)
		}
	} else {
		z = append(z, "Noch nicht beim Server gemeldet · "+reverseTextNichtGesichert)
	}
	if a := k.Auftrag; a != nil {
		art := a.Art
		if art == "" {
			art = "Transfer"
		}
		zeile := "Laufender " + art + " (lokaler Daemon)"
		if a.BytesErledigt != nil && a.Groesse != nil && *a.Groesse > 0 {
			zeile += fmt.Sprintf(": %s / %s (%d %%)", menschenBytes(int64(*a.BytesErledigt)), menschenBytes(int64(*a.Groesse)), int64(*a.BytesErledigt)*100/int64(*a.Groesse))
		}
		z = append(z, zeile)
		if a.Fehler != "" {
			z = append(z, "Transferfehler: "+a.Fehler)
		}
	}
	return z
}

// ---------------------------------------------------------------------------
// Zurueckholen von Unraid
// ---------------------------------------------------------------------------

type reverseZielExistiertFehler struct{ Ziel string }

func (e *reverseZielExistiertFehler) Error() string {
	return "Am Ziel liegt bereits eine Datei — sie wird nicht überschrieben: " + e.Ziel
}

var errReverseHashFalsch = errors.New("Prüfsumme stimmt nicht — nichts wurde installiert")

// reverseZielPfad: Originalpfad im Bibliotheksordner; rel_pfad darf nicht ausbrechen.
func reverseZielPfad(wurzel, relPfad string) (string, error) {
	if !filepath.IsAbs(wurzel) {
		return "", fmt.Errorf("Bibliotheksordner ist kein absoluter Pfad")
	}
	teile := reversePfadTeile(relPfad)
	if len(teile) == 0 {
		return "", fmt.Errorf("Fundstelle ohne Pfad")
	}
	for _, teil := range teile {
		if teil == ".." || strings.ContainsAny(teil, "\x00") || (runtime.GOOS == "windows" && strings.Contains(teil, ":")) {
			return "", fmt.Errorf("Ungültiger Pfad in der Fundstelle: %s", relPfad)
		}
	}
	ziel := filepath.Join(append([]string{filepath.Clean(wurzel)}, teile...)...)
	if !reversePfadInnerhalb(ziel, wurzel) || reverseNormPfad(ziel) == reverseNormPfad(wurzel) {
		return "", fmt.Errorf("Pfad liegt außerhalb der Reverse-Bibliothek: %s", relPfad)
	}
	return ziel, nil
}

// reversePruefeKeineSymlinks (M2): jede vorhandene Komponente zwischen wurzel und
// Dir(ziel) muss ein echter Ordner sein (Lstat, kein Symlink). Noch fehlende
// Komponenten legt MkdirAll spaeter frisch an.
func reversePruefeKeineSymlinks(wurzel, ziel string) error {
	wurzel = filepath.Clean(wurzel)
	ordner := filepath.Dir(filepath.Clean(ziel))
	if !reversePfadInnerhalb(ordner, wurzel) {
		return fmt.Errorf("Ziel liegt außerhalb von %s", wurzel)
	}
	rel, err := filepath.Rel(wurzel, ordner)
	if err != nil {
		return err
	}
	aktuell := wurzel
	if rel == "." {
		return nil
	}
	for _, teil := range strings.Split(rel, string(filepath.Separator)) {
		aktuell = filepath.Join(aktuell, teil)
		st, err := os.Lstat(aktuell)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Symlink im Zielpfad wird nicht verfolgt: %s", aktuell)
		}
		if !st.IsDir() {
			return fmt.Errorf("Im Zielpfad liegt eine Datei statt eines Ordners: %s", aktuell)
		}
	}
	return nil
}

// reversePruefeAufgeloest (M2): nach dem Anlegen muss Dir(ziel) aufgeloest innerhalb
// der aufgeloesten wurzel liegen.
func reversePruefeAufgeloest(wurzel, ziel string) error {
	w, err := filepath.EvalSymlinks(wurzel)
	if err != nil {
		return fmt.Errorf("Ordner nicht auflösbar: %v", err)
	}
	d, err := filepath.EvalSymlinks(filepath.Dir(ziel))
	if err != nil {
		return fmt.Errorf("Zielordner nicht auflösbar: %v", err)
	}
	if !reversePfadInnerhalb(d, w) {
		return fmt.Errorf("Zielordner führt aus %s heraus: %s", wurzel, d)
	}
	return nil
}

func reverseDateiHash(pfad string) (string, error) {
	f, err := os.Open(pfad)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// reverseInstalliereOhneUeberschreiben: Hardlink ist atomar und scheitert, wenn das Ziel
// existiert. Ohne Link-Unterstuetzung: Pruefen + rename (kleines Restfenster).
func reverseInstalliereOhneUeberschreiben(tmp, ziel string) error {
	if err := os.Link(tmp, ziel); err == nil {
		os.Remove(tmp)
		return nil
	} else if os.IsExist(err) {
		return &reverseZielExistiertFehler{Ziel: ziel}
	}
	if _, err := os.Lstat(ziel); err == nil {
		return &reverseZielExistiertFehler{Ziel: ziel}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(tmp, ziel)
}

// reverseZurueckholen laedt das Original von rel_pfad ueber den Binaerweg in eine
// Temp-Datei (.synapse-tmp-* in wurzel), prueft sha256 gegen x-synapse-sha256 (und
// gegen erwartet, falls bekannt) und legt die Datei erst danach an ziel ab. ziel muss
// unter wurzel liegen; Symlinks im Weg werden nicht verfolgt (M2). Ein vorhandenes
// Ziel wird nie ueberschrieben. Abbruch per ctx raeumt die Temp-Datei weg.
func reverseZurueckholen(ctx context.Context, relPfad, erwartet, wurzel, ziel string, fortschritt func(int64)) error {
	if !filepath.IsAbs(ziel) || !filepath.IsAbs(wurzel) {
		return fmt.Errorf("Ziel ist kein absoluter Pfad: %s", ziel)
	}
	if _, err := os.Lstat(ziel); err == nil {
		return &reverseZielExistiertFehler{Ziel: ziel}
	} else if !os.IsNotExist(err) {
		return err
	}
	if st, err := os.Lstat(wurzel); err == nil && st.Mode()&os.ModeSymlink == 0 && !st.IsDir() {
		return fmt.Errorf("Bibliotheksordner ist kein Verzeichnis: %s", wurzel)
	}
	if err := reversePruefeKeineSymlinks(wurzel, ziel); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(ziel), 0o755); err != nil {
		return fmt.Errorf("Zielordner nicht anlegbar: %v", err)
	}
	if err := reversePruefeKeineSymlinks(wurzel, ziel); err != nil {
		return err
	}
	if err := reversePruefeAufgeloest(wurzel, ziel); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(wurzel, ".synapse-tmp-*")
	if err != nil {
		return fmt.Errorf("Temp-Datei nicht anlegbar: %v", err)
	}
	tmpName := tmp.Name()
	tmp.Close()
	installiert := false
	defer func() {
		if !installiert {
			os.Remove(tmpName)
		}
	}()
	ergebnis, err := apiRequestBinaryWithToken(ctx, apiBinaryRequest{
		Method: http.MethodGet,
		Path:   "/api/reverse/fundstellen/original?rel_pfad=" + url.QueryEscape(relPfad),
		Header: http.Header{"Accept": []string{"application/octet-stream"}},
		// Jede Wiederholung schreibt die Temp-Datei frisch.
		OpenDestination: func() (io.WriteCloser, error) {
			return os.OpenFile(tmpName, os.O_WRONLY|os.O_TRUNC, 0o600)
		},
		Progress: func(richtung string, n int64) {
			if richtung == "download" && fortschritt != nil {
				fortschritt(n)
			}
		},
	}, apiToken())
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("Zurückholen abgebrochen")
		}
		var he *apiBinaryHTTPError
		if errors.As(err, &he) && he.Status == http.StatusNotFound && strings.Contains(he.Detail, "nicht_gesichert") {
			return fmt.Errorf("Das Original ist auf Unraid noch nicht gesichert")
		}
		return fmt.Errorf("Download fehlgeschlagen: %v", err)
	}
	serverHash := strings.ToLower(strings.TrimSpace(ergebnis.Header.Get("X-Synapse-Sha256")))
	erwartet = strings.ToLower(strings.TrimSpace(erwartet))
	if serverHash == "" {
		return fmt.Errorf("Synapse liefert keine Prüfsumme — nichts wurde installiert")
	}
	if erwartet != "" && erwartet != serverHash {
		return errReverseHashFalsch
	}
	f, err := os.OpenFile(tmpName, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	syncErr := f.Sync()
	f.Close()
	if syncErr != nil {
		return fmt.Errorf("Temp-Datei nicht gesichert: %v", syncErr)
	}
	ist, err := reverseDateiHash(tmpName)
	if err != nil {
		return fmt.Errorf("Prüfsumme nicht berechenbar: %v", err)
	}
	if ist != serverHash {
		return errReverseHashFalsch
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	// Zwischen Download und Installation erneut: kein Symlink ist nachtraeglich eingehaengt.
	if err := reversePruefeKeineSymlinks(wurzel, ziel); err != nil {
		return err
	}
	if err := reversePruefeAufgeloest(wurzel, ziel); err != nil {
		return err
	}
	if err := reverseInstalliereOhneUeberschreiben(tmpName, ziel); err != nil {
		return err
	}
	installiert = true
	return nil
}
