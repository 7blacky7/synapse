package main

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
	"fyne.io/systray"
)

type Project struct {
	Name    string `json:"name"`
	Pfad    string `json:"pfad"`
	Enabled bool   `json:"enabled"`
	// P13-T45: vom Daemon (/projects); nil bei aelterem Daemon -> Wert aus config.json.
	AssetSyncAktiv *bool `json:"asset_sync_aktiv,omitempty"`
}

type ProjectsResponse struct {
	Projekte []Project `json:"projekte"`
}

type ChannelInfo struct {
	Name string `json:"name"`
}

type ChannelsResponse struct {
	Channels []ChannelInfo `json:"channels"`
}

// Workspace = ein Container-Workspace auf der synapse-api (siehe project_workspaces Tabelle).
type Workspace struct {
	Project     string `json:"project"`
	Status      string `json:"status"` // active | warming | cold | stopping | error (project_workspaces.status)
	Pinned      bool   `json:"pinned"`
	ContainerId string `json:"container_id"`
}

type WorkspacesResponse struct {
	Success    bool        `json:"success"`
	Workspaces []Workspace `json:"workspaces"`
}

// ProjectMenuHandles stores menu items for incremental updates
type ProjectMenuHandles struct {
	SubMenu   *systray.MenuItem
	CheckItem *systray.MenuItem
	Enabled   bool
	// P13-T45: Schalter Asset-Sync je Projekt (asset_sync.aktiv).
	AssetItem      *systray.MenuItem
	AssetSyncAktiv bool
}

var (
	myApp                fyne.App
	menuMutex            sync.Mutex
	projects             []Project
	connected            bool
	port                 int
	sseActive            atomic.Bool
	refreshChan          = make(chan struct{}, 1)
	stopChan             = make(chan struct{})
	lastProjectSignature string
	wasOnline            bool
	projectHandles       = make(map[string]*ProjectMenuHandles)
	statusItem           *systray.MenuItem

	// synapse-api (Workspaces)
	synapseApiUrl          string
	workspaces             []Workspace
	workspacesZustand      string // wsZustand* (P8-T21); "" = noch nicht abgerufen
	lastWorkspaceSignature string
	nextWorkspacePoll      time.Time

	// Channels: Rebuild-Trigger. Ohne das erscheinen neu angelegte Channels
	// erst nach manuellem "Neu laden", weil getProjectSignature nur Projektnamen
	// hasht (Channels waren im Trigger unsichtbar).
	lastChannelSignature string
	currentChannelSig    string
	nextChannelPoll      time.Time

	// Window tracking
	openWindows = make(map[string]*DetailWindow)
	windowLock  sync.Mutex
	openChats   = make(map[string]*ChatWindow)
	chatLock    sync.Mutex
)

// DetailWindow represents the main detail tabs for a project
type DetailWindow struct {
	Window        fyne.Window
	ProjectName   string
	AgentTable    *widget.Table
	AgentRows     [][]string
	AgentKeys     []string
	EventTable    *widget.Table
	EventRows     [][]string
	ActivityTable *widget.Table
	ActivityRows  [][]string
	ActivityIDs   []string
	FilterEntry   *widget.Entry
	PathLabel     *widget.Label
	ActiveLabel   *widget.Label
	ChunksLabel   *widget.Label
	FilesLabel    *widget.Label
	Tabs          *container.AppTabs
	AgentStatus   *widget.Label
	EventStatus   *widget.Label
	ActivityStatus *widget.Label
	// P8-T20: Auswahl ueber Schluessel statt Zeilenindex (nur UI-Faden).
	agentAuswahl      tabellenAuswahl
	eventAuswahl      tabellenAuswahl
	aktivitaetAuswahl tabellenAuswahl
	// Filtertext fuer ReloadEvents (Goroutine) und Entprell-Zaehler.
	filterText atomic.Value
	filterNr   atomic.Uint64
	// ladet verhindert, dass sich ReloadAll-Durchgaenge bei langsamer API stauen.
	ladet atomic.Bool
	// Ein geschlossenes Fenster wird nur versteckt (SetCloseIntercept), damit es
	// beim naechsten Oeffnen sofort wieder da ist. Ohne diese Marke lief die
	// Auffrisch-Schleife trotzdem weiter darueber: vier Abfragen je Projekt,
	// alle drei Sekunden, rund um die Uhr, fuer ein Fenster das niemand sieht.
	sichtbar atomic.Bool
}

// ChatWindow represents the channel chat window
type ChatWindow struct {
	Window        fyne.Window
	ProjectName   string
	ChannelName   string
	MessageBox    *fyne.Container
	MessageScroll *container.Scroll
	MessageStatus *widget.Label
	AgentStatus   *widget.Label
	LastMsgID     int64
	AgentTable    *widget.Table
	AgentRows     [][]string
	InputEntry    *widget.Entry
	loadingMsgs   atomic.Bool
	loadingAgs    atomic.Bool
	sichtbar      atomic.Bool
}

func main() {
	// Single-Instance: zweite Instanz beendet sich sofort (flock/LockFileEx).
	lockFile := acquireSingleInstanceLock()
	if lockFile != nil {
		defer lockFile.Close()
	}

	myApp = app.New()
	// P8-T20: haelt die Fyne-Loop am Leben, wenn das letzte sichtbare Fenster
	// geschlossen wird (Ursache des Absturzes beim Schliessen, siehe fenster.go).
	ankerFenster = legeAnkerFensterAn(myApp)

	start, end := systray.RunWithExternalLoop(onReady, trayBeenden)
	start()

	// Fyne event loop blocks main thread
	myApp.Run()

	end()
}

func onReady() {
	systray.SetTitle("Synapse FileWatcher")
	systray.SetTooltip("Synapse FileWatcher")

	port = readPort()
	synapseApiUrl = readSynapseApiUrl()
	systray.SetIcon(makeIcon(false))

	go runRefreshLoop(stopChan)
	go runPollLoop(stopChan)
	go startSSE(stopChan)
	go runLiveRefreshLoop(stopChan)
	// P15-T11: gpu-helfer.json (Haekchen, KI ueber den Daemon, Hand) -> laufenden Helfer neu starten.
	go gpuHelferEinstellungenBeobachten(stopChan)

	triggerRefresh()
}

func triggerRefresh() {
	select {
	case refreshChan <- struct{}{}:
	default:
	}
}

func runRefreshLoop(stop chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case <-refreshChan:
			refresh()
		}
	}
}

func runPollLoop(stop chan struct{}) {
	ticks := 0
	for {
		select {
		case <-stop:
			return
		case <-time.After(1 * time.Second):
			ticks++
			limit := 1
			if sseActive.Load() {
				limit = 10
			}
			if ticks >= limit {
				triggerRefresh()
				ticks = 0
			}
		}
	}
}

func runLiveRefreshLoop(stop chan struct{}) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			// NUR SICHTBARE FENSTER. Geschlossene bleiben absichtlich in der Map
			// (Hide statt Dispose, damit sie beim naechsten Oeffnen sofort stehen) —
			// aber sie duerfen den Server nicht weiter abfragen.
			windowLock.Lock()
			for _, w := range openWindows {
				if !w.sichtbar.Load() {
					continue
				}
				go w.ReloadAll()
			}
			windowLock.Unlock()

			chatLock.Lock()
			for _, w := range openChats {
				if !w.sichtbar.Load() {
					continue
				}
				go w.ReloadAll()
			}
			chatLock.Unlock()
		}
	}
}

func startSSE(stop chan struct{}) {
	client := &http.Client{
		Timeout: 0,
	}
	for {
		select {
		case <-stop:
			return
		default:
		}

		u := fmt.Sprintf("http://127.0.0.1:%d/events", port)
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}
		req.Header.Set("Accept", "text/event-stream")

		resp, err := client.Do(req)
		if err != nil {
			sseActive.Store(false)
			time.Sleep(5 * time.Second)
			continue
		}

		sseActive.Store(true)
		reader := bufio.NewReader(resp.Body)

		bodyClosed := make(chan struct{})
		go func() {
			select {
			case <-stop:
				_ = resp.Body.Close()
			case <-bodyClosed:
			}
		}()

		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				triggerRefresh()
			}
		}

		close(bodyClosed)
		_ = resp.Body.Close()
		sseActive.Store(false)

		select {
		case <-stop:
			return
		case <-time.After(5 * time.Second):
		}
	}
}



// readSynapseApiUrl liest synapse_api_url aus ~/.synapse/file-watcher/config.json.
// Fallback: http://127.0.0.1:3456 (DEFAULT_SYNAPSE_API_URL im TS-Daemon).
func readSynapseApiUrl() string {
	const fallback = "http://127.0.0.1:3456"
	home, err := os.UserHomeDir()
	if err != nil {
		return fallback
	}
	cfgFile := filepath.Join(home, ".synapse", "file-watcher", "config.json")
	data, err := os.ReadFile(cfgFile)
	if err != nil {
		return fallback
	}
	var cfg struct {
		SynapseApiUrl string `json:"synapse_api_url"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fallback
	}
	if strings.TrimSpace(cfg.SynapseApiUrl) == "" {
		return fallback
	}
	return strings.TrimRight(strings.TrimSpace(cfg.SynapseApiUrl), "/")
}

func readPort() int {
	home, err := os.UserHomeDir()
	if err != nil {
		return 7878
	}
	portFile := filepath.Join(home, ".synapse", "file-watcher", "daemon.port")
	data, err := os.ReadFile(portFile)
	if err != nil {
		return 7878
	}
	var p int
	_, err = fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &p)
	if err != nil || p <= 0 {
		return 7878
	}
	return p
}

func getDaemonPath() string {
	if runtime.GOOS == "windows" {
		temp := os.Getenv("TEMP")
		if temp == "" {
			temp = os.Getenv("TMP")
		}
		if temp == "" {
			temp = `C:\temp`
		}
		return filepath.Join(temp, "synapse-fwd.exe")
	}
	return "/tmp/synapse-fwd"
}

func daemonStarten() {
	home, _ := os.UserHomeDir()
	startTrigger := filepath.Join(home, ".synapse", "file-watcher", "start-requested")
	_ = os.WriteFile(startTrigger, []byte("1"), 0644)
}

// daemonStoppen schreibt stop-requested — start-watcher.sh stoppt den Daemon.
// Der Tray-Prozess laeuft weiter (Menuepunkt "Deaktivieren").
func daemonStoppen() {
	home, _ := os.UserHomeDir()
	stopTrigger := filepath.Join(home, ".synapse", "file-watcher", "stop-requested")
	_ = os.WriteFile(stopTrigger, []byte(""), 0644)
}

// quitApp stoppt den Daemon UND beendet den Tray-Prozess wirklich.
// systray.Quit() allein liess den Fyne-Loop haengen (Prozess lebte weiter,
// User-Report 2026-06-06) — daher harter os.Exit-Fallback nach Grace-Period.
func quitApp() {
	daemonStoppen()
	systray.Quit()
	time.AfterFunc(2*time.Second, func() { os.Exit(0) })
}

func openConfigDir(path string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	_ = cmd.Start()
}

func toggleLabel(enabled bool) string {
	if enabled {
		return "Aktiv: AN  (klick = deaktivieren)"
	}
	return "Aktiv: AUS  (klick = aktivieren)"
}

func toggleProject(name string, currentlyEnabled bool) {
	// 1. ZUERST frischen State holen
	uStatus := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/status", port, url.QueryEscape(name))
	client := &http.Client{Timeout: 1 * time.Second}

	enabled := currentlyEnabled
	respStatus, err := client.Get(uStatus)
	if err != nil {
		log.Printf("[tray] toggleProject %s: GET status FEHLER: %v (port=%d)", name, err, port)
	} else {
		defer respStatus.Body.Close()
		var statusMap map[string]interface{}
		if err := json.NewDecoder(respStatus.Body).Decode(&statusMap); err == nil {
			if v, ok := statusMap["enabled"].(bool); ok {
				enabled = v
			}
		}
	}

	// 2. Aktion bestimmen
	action := "enable"
	if enabled {
		action = "disable"
	}

	// 3. POST ausführen
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/%s", port, url.QueryEscape(name), action)
	resp, err := client.Post(u, "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		log.Printf("[tray] toggleProject %s: POST FEHLER: %v", name, err)
		return
	}
	defer resp.Body.Close()

	// 4. Statuscode prüfen
	if resp.StatusCode == 200 {
		newState := !enabled
		menuMutex.Lock()
		if handle, ok := projectHandles[name]; ok {
			handle.Enabled = newState
			if newState {
				handle.CheckItem.SetTitle(toggleLabel(true))
				handle.SubMenu.SetTitle("●  " + name)
			} else {
				handle.CheckItem.SetTitle(toggleLabel(false))
				handle.SubMenu.SetTitle("○  " + name)
			}
		}
		menuMutex.Unlock()
	}

	// 5. triggerRefresh() am Ende
	triggerRefresh()
}

// P8-T21: Abrufzustand der Workspaces.
const (
	wsZustandOK             = "ok"
	wsZustandNichtVerbunden = "nicht_verbunden" // API antwortet 401/403: kein/falsches Token
	wsZustandOffline        = "offline"         // keine Adresse der Kette erreichbar
)

// Workspace-Abruf im Hintergrund. nextWorkspacePoll und die Ergebnisse
// gehoeren unter wsAbrufMu (nicht menuMutex), weil der Abruf in einer eigenen
// Goroutine laeuft.
var (
	wsAbrufMu      sync.Mutex
	wsAbrufLaeuft  atomic.Bool
	wsAbrufListe   []Workspace
	wsAbrufZustand string
)

// fetchWorkspaces geht ueber den API-Weg des Trays (api_client.go: Token aus
// SYNAPSE_API_TOKEN bzw. config.json, Adresskette LAN -> Tunnel). Vorher ging
// hier ein nackter http.Client OHNE Authorization-Header an synapseApiUrl; seit
// die API auth-scharf ist, kam immer 401 und das Menue stand dauerhaft auf
// "Workspaces (offline)".
func fetchWorkspaces() ([]Workspace, string) {
	var data WorkspacesResponse
	if _, err := apiRequest(http.MethodGet, "/api/workspaces", &data); err != nil {
		log.Printf("[tray] Workspaces abrufen: %v", err)
		return nil, workspaceFehlerZustand(err)
	}
	return data.Workspaces, wsZustandOK
}

// workspaceFehlerZustand: 401/403 ist eine echte Antwort der API (nicht
// verbunden), alles andere heisst "nicht erreichbar".
func workspaceFehlerZustand(err error) string {
	var httpErr *apiBinaryHTTPError
	if errors.As(err, &httpErr) && (httpErr.Status == http.StatusUnauthorized || httpErr.Status == http.StatusForbidden) {
		return wsZustandNichtVerbunden
	}
	return wsZustandOffline
}

// workspacePollAbstand: ok alle 30 s; nicht verbunden nach 1 min erneut (damit
// ein frisch hinterlegtes Token schnell wirkt); offline 5 min Backoff.
func workspacePollAbstand(zustand string) time.Duration {
	switch zustand {
	case wsZustandOK:
		return 30 * time.Second
	case wsZustandNichtVerbunden:
		return time.Minute
	default:
		return 5 * time.Minute
	}
}

// starteWorkspaceAbruf holt die Workspaces in einer Goroutine. refresh() haelt
// menuMutex; die API-Kette (bis 10 s je Adresse) darf das Menue nicht blockieren.
// Ist ein Abruf schon unterwegs, passiert nichts.
func starteWorkspaceAbruf() {
	if !wsAbrufLaeuft.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer wsAbrufLaeuft.Store(false)
		ws, zustand := fetchWorkspaces()
		wsAbrufMu.Lock()
		wsAbrufListe = ws
		wsAbrufZustand = zustand
		nextWorkspacePoll = time.Now().Add(workspacePollAbstand(zustand))
		wsAbrufMu.Unlock()
		triggerRefresh()
	}()
}

func workspaceAction(project, action string, body string) {
	pfad := fmt.Sprintf("/api/projects/%s/workspace/%s", url.PathEscape(project), action)
	if _, err := apiRequestBody(http.MethodPost, pfad, json.RawMessage(body), nil); err != nil {
		log.Printf("[tray] workspace %s %s FEHLER: %v", action, project, err)
	}
	// Poll-Throttle uebersteuern: ohne Reset bliebe der angezeigte Status
	// nach Start/Stop bis zu 30s alt (nextWorkspacePoll liegt in der Zukunft).
	wsAbrufMu.Lock()
	nextWorkspacePoll = time.Time{}
	wsAbrufMu.Unlock()
	triggerRefresh()
}

func getWorkspaceSignature(ws []Workspace, zustand string) string {
	if zustand != wsZustandOK {
		return "zustand:" + zustand
	}
	parts := make([]string, 0, len(ws)+1)
	parts = append(parts, "ok")
	for _, w := range ws {
		pin := "u"
		if w.Pinned {
			pin = "p"
		}
		parts = append(parts, w.Project+":"+w.Status+":"+pin)
	}
	return strings.Join(parts, "|")
}

// getProjectSignature: Name UND Aktiv-Zustand (P8-T21). Wechselt ein Projekt
// zwischen aktiv und inaktiv, wandert es zwischen Hauptmenue und dem Untermenue
// "Inaktive Projekte" — das braucht einen Rebuild.
func getProjectSignature(projs []Project) string {
	parts := make([]string, 0, len(projs))
	for _, p := range projs {
		zustand := "0"
		if p.Enabled {
			zustand = "1"
		}
		parts = append(parts, p.Name+":"+zustand)
	}
	return strings.Join(parts, "|")
}

// getChannelSignature holt fuer jedes Projekt die Channel-Liste und baut daraus
// eine Signatur. Aendert sie sich (neuer/geloeschter Channel), loest refresh()
// einen Menue-Rebuild aus — sonst erschienen neue Channels erst nach manuellem
// "Neu laden".
// CH-5 (15.08.2026): Zeigt das Menue archivierte Channels mit an?
// Ein GLOBALER Schalter, nicht pro Projekt: er beantwortet die Frage "raeume ich gerade auf
// oder arbeite ich", und die stellt sich nicht je Projekt getrennt.
// CH-8 (15.08.2026): derselbe Schalter entscheidet auch, ob archivierte NACHRICHTEN in einem
// offenen Channel mitkommen (apiFetchChannelMessages). Beides ist dieselbe Frage.
var archivAnzeigen atomic.Bool

// channelsUrlFuer baut die Abfrage-URL und haengt den Archiv-Parameter an, wenn der
// Schalter steht. Eine Stelle fuer beide Aufrufer (Signatur-Poll und Menue-Aufbau) —
// zwei getrennte Stellen waeren sofort auseinandergelaufen.
func channelsUrlFuer(port int, projekt string) string {
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/channels", port, url.QueryEscape(projekt))
	if archivAnzeigen.Load() {
		u += "?archiv=1"
	}
	return u
}

func getChannelSignature(projs []Project, p int) string {
	client := &http.Client{Timeout: 1 * time.Second}
	parts := make([]string, 0, len(projs))
	for _, proj := range projs {
		channelsUrl := channelsUrlFuer(p, proj.Name)
		var names []string
		if chResp, err := client.Get(channelsUrl); err == nil {
			var chData ChannelsResponse
			if json.NewDecoder(chResp.Body).Decode(&chData) == nil {
				for _, ch := range chData.Channels {
					names = append(names, ch.Name)
				}
			}
			chResp.Body.Close()
		}
		parts = append(parts, proj.Name+"#"+strings.Join(names, ","))
	}
	return strings.Join(parts, "|")
}

// rebuildMenu baut das Menue komplett neu auf. Reihenfolge und Gruppierung
// kommen aus hauptmenueLayout (tray_menue.go, P8-T21): globale Eintraege oben,
// darunter die aktiven Projekte, die inaktiven im Untermenue.
func rebuildMenu(projs []Project) {
	systray.ResetMenu()
	projectHandles = make(map[string]*ProjectMenuHandles)
	// Zaehlt die LayoutUpdated-Signale dieses Aufbaus (fyne systray v1.12.1:
	// ResetMenu, jeder Separator, jedes Update eines bestehenden Eintrags).
	signale := 1

	statusText := "Daemon: OFFLINE"
	if connected {
		statusText = fmt.Sprintf("Daemon: online  (%d)", port)
	}

	client := &http.Client{Timeout: 1 * time.Second}
	layout := hauptmenueLayout(connected, projs)
	for _, e := range layout {
		switch e.Art {
		case menueStatus:
			statusItem = systray.AddMenuItem(statusText, "")
		case menueTrenner:
			systray.AddSeparator()
			signale++
		case menueDaemonStarten:
			mStart := systray.AddMenuItem("Daemon starten", "")
			go func() {
				for range mStart.ClickedCh {
					daemonStarten()
				}
			}()
		case menueVerbinden:
			// TRAY-3: Verbindung zur Synapse-API einrichten. Der Menuetext zeigt sofort,
			// ob schon ein Token hinterlegt ist — der Nutzer muss nirgends nachsehen.
			verbindungsLabel := "Mit Synapse verbinden …"
			if apiToken() != "" {
				verbindungsLabel = "Synapse-Verbindung …"
			}
			mVerbinden := systray.AddMenuItem(verbindungsLabel, "Zugang zur Synapse-API einrichten")
			go func() {
				for range mVerbinden.ClickedCh {
					fyne.Do(zeigeVerbindungsFenster)
				}
			}()
		case menueAssetSync:
			// P13-T27/A9: serverseitige Projektbindung und Asset-Sync neben bestehender UI.
			mAssets := systray.AddMenuItem("Projekte auf diesem PC / Asset-Sync …", "Bindung, Transfers und offene Konflikte")
			go func() {
				for range mAssets.ClickedCh {
					fyne.Do(zeigeAssetSyncFenster)
				}
			}()
		case menueReverse:
			// P18-T17/RV7: globaler Reverse-Bibliotheksordner, Policy aus der API, Statusbaum.
			mReverse := systray.AddMenuItem("Reverse-Bibliothek …", "Ordner für Originale, Einstellungen von Synapse und Status je Fundstelle")
			go func() {
				for range mReverse.ClickedCh {
					fyne.Do(zeigeReverseBibliothekFenster)
				}
			}()
		case menueImages:
			// P18-T65: ISO-Abbild nur lesend als Laufwerk einbinden (udisks). Neuer Eintrag ->
			// das abschliessende statusItem.SetTitle unten liefert das LayoutUpdated (P8-T21).
			mImages := systray.AddMenuItem("Image einbinden …", "ISO-Abbild nur lesend als Laufwerk einbinden, eingebundene öffnen oder auswerfen")
			go func() {
				for range mImages.ClickedCh {
					fyne.Do(func() { zeigeIsoFenster(true) })
				}
			}()
		case menueGPU:
			mGPU := systray.AddMenuItem("Lokale GPU / Ollama …", "GPU-Modell vergleichen, einrichten oder sperren")
			go func() {
				for range mGPU.ClickedCh {
					fyne.Do(zeigeGPUFenster)
				}
			}()
		case menueWorkspaces:
			signale += baueWorkspacesMenue()
		case menueNeuLaden:
			mReload := systray.AddMenuItem("Neu laden", "")
			go func() {
				for range mReload.ClickedCh {
					triggerRefresh()
				}
			}()
		case menueDeaktivieren:
			mDisable := systray.AddMenuItem("Deaktivieren", "Daemon stoppen — Tray laeuft weiter")
			go func() {
				for range mDisable.ClickedCh {
					daemonStoppen()
					triggerRefresh()
				}
			}()
		case menueBeenden:
			mQuit := systray.AddMenuItem("Beenden", "Daemon stoppen + Tray beenden")
			go func() {
				for range mQuit.ClickedCh {
					quitApp()
				}
			}()
		case menueKeineProjekte:
			systray.AddMenuItem("(keine Projekte)", "")
		case menueProjekt:
			sm := systray.AddMenuItem(projektLabel(e.Projekt), "")
			signale += baueProjektUntermenue(sm, e.Projekt, client)
		case menueWeitereAktive, menueInaktive:
			gruppe := systray.AddMenuItem(gruppenLabel(e), "")
			for _, p := range e.Gruppe {
				sm := gruppe.AddSubMenuItem(projektLabel(p), "")
				signale += baueProjektUntermenue(sm, p, client)
			}
		}
	}

	// P8-T21: abschliessendes LayoutUpdated. fyne.io/systray (v1.12.1,
	// systray_menu_unix.go addOrUpdateMenuItem) sendet fuer NEU angelegte Eintraege
	// kein LayoutUpdated, nur fuer ResetMenu, Separatoren und Updates bestehender
	// Eintraege. Ohne dieses Update holt KDE das Layout zuletzt beim letzten
	// Separator und zeigt alles danach Angelegte nie an. SetTitle auf einen
	// bestehenden Eintrag loest genau ein refresh() mit voller Revision aus.
	statusItem.SetTitle(statusText)
	signale++

	log.Printf("[tray] Menue neu aufgebaut: %d Haupteintraege, %d Projekte (%d aktiv), %d LayoutUpdated",
		len(layout), len(projs), len(aktiveProjekte(projs)), signale)

	lastProjectSignature = getProjectSignature(projs)
	lastWorkspaceSignature = getWorkspaceSignature(workspaces, workspacesZustand)
	lastChannelSignature = currentChannelSig
	wasOnline = connected
}

// Workspaces-Untermenue: Handle und Untereintraege (nur unter menuMutex), damit
// eine Workspace-Aenderung ohne kompletten Rebuild nachgezogen werden kann.
var (
	wsMenuItem       *systray.MenuItem
	wsUnterEintraege []*systray.MenuItem
	wsUnterAnzahl    int // alle Eintraege unter wsMenuItem (inkl. Start/Stop/Pin)
)

// baueWorkspacesMenue legt das Workspaces-Untermenue (WS-P6) an. Rueckgabe:
// Zahl der dabei ausgeloesten LayoutUpdated.
func baueWorkspacesMenue() int {
	wsMenuItem = systray.AddMenuItem(workspacesLabel(workspaces, workspacesZustand), synapseApiUrl)
	fuelleWorkspacesMenue(wsMenuItem)
	if workspacesZustand != wsZustandOK {
		wsMenuItem.Disable() // Update eines bestehenden Eintrags -> ein LayoutUpdated
		return 1
	}
	return 0
}

// aktualisiereWorkspacesMenue zieht eine Workspace-Aenderung nach, OHNE das
// ganze Menue neu aufzubauen (P8-T21). systray.ResetMenu entfernt jeden alten
// Eintrag einzeln und sendet dabei je Eintrag ein LayoutUpdated (gemessen: ~540
// Signale bei 87 Projekten). Hier werden nur die Workspace-Untereintraege
// ersetzt. Rueckgabe: Zahl der ausgeloesten LayoutUpdated.
func aktualisiereWorkspacesMenue() int {
	if wsMenuItem == nil {
		return 0
	}
	signale := wsUnterAnzahl // jedes Remove eines Eintrags im Layout sendet eins
	for _, e := range wsUnterEintraege {
		e.Remove()
	}
	if workspacesZustand == wsZustandOK {
		wsMenuItem.Enable()
	} else {
		wsMenuItem.Disable()
	}
	signale++
	fuelleWorkspacesMenue(wsMenuItem)
	// Neu angelegte Untereintraege senden selbst kein LayoutUpdated (siehe
	// rebuildMenu); das SetTitle auf den bestehenden Eintrag zum Schluss liefert
	// das abschliessende Signal mit vollstaendigem Layout.
	wsMenuItem.SetTitle(workspacesLabel(workspaces, workspacesZustand))
	signale++
	return signale
}

// fuelleWorkspacesMenue legt die Untereintraege des Workspaces-Menues an.
func fuelleWorkspacesMenue(wsMenu *systray.MenuItem) {
	wsUnterEintraege = nil
	wsUnterAnzahl = 0
	if workspacesZustand != wsZustandOK {
		return
	}
	if len(workspaces) == 0 {
		wsUnterEintraege = append(wsUnterEintraege, wsMenu.AddSubMenuItem("(keine Workspaces)", ""))
		wsUnterAnzahl = 1
		return
	}
	for _, w := range workspaces {
		wsCopy := w
		label := "○  " + wsCopy.Project
		switch wsCopy.Status {
		case "active":
			label = "●  " + wsCopy.Project
		case "warming", "stopping":
			label = "◐  " + wsCopy.Project
		case "error":
			label = "⚠  " + wsCopy.Project
		}
		if wsCopy.Pinned {
			label += "  📌"
		}
		sub := wsMenu.AddSubMenuItem(label, fmt.Sprintf("status=%s container=%s", wsCopy.Status, wsCopy.ContainerId))
		wsUnterEintraege = append(wsUnterEintraege, sub)
		wsUnterAnzahl += 4

		itStart := sub.AddSubMenuItem("Start", "")
		go func(name string) {
			for range itStart.ClickedCh {
				go workspaceAction(name, "start", "{}")
			}
		}(wsCopy.Project)

		itStop := sub.AddSubMenuItem("Stop", "")
		go func(name string) {
			for range itStop.ClickedCh {
				go workspaceAction(name, "stop", "{}")
			}
		}(wsCopy.Project)

		pinLabel := "Pin"
		pinBody := `{"pinned":true}`
		if wsCopy.Pinned {
			pinLabel = "Unpin"
			pinBody = `{"pinned":false}`
		}
		itPin := sub.AddSubMenuItem(pinLabel, "")
		go func(name, body string) {
			for range itPin.ClickedCh {
				go workspaceAction(name, "pin", body)
			}
		}(wsCopy.Project, pinBody)
	}
}

// baueProjektUntermenue fuellt das Untermenue eines Projekts und registriert die
// Handles. Aktive Projekte bekommen das bisherige Untermenue (Aktiv-Schalter,
// Asset-Sync, Oeffnen, Archiv, Channels, Loeschen). Inaktive bekommen nur den
// Aktiv-Schalter und "Oeffnen..." (P8-T21): keine Channels, kein Asset-Sync (der
// Daemon beobachtet inaktive Projekte nicht), kein Loeschen (liegt im Fenster unter
// Aktionen), keine Trenner. Jeder Eintrag kostet beim naechsten ResetMenu ein
// LayoutUpdated, jeder Trenner sofort eins; dazu spart es je Projekt einen
// HTTP-Abruf. Rueckgabe: Zahl der ausgeloesten LayoutUpdated.
func baueProjektUntermenue(sm *systray.MenuItem, p Project, client *http.Client) int {
	name := p.Name
	enabled := p.Enabled
	signale := 0

	// Reguläres Item statt Checkbox: AddSubMenuItemCheckbox feuert ClickedCh
	// auf KDE/SNI nicht zuverlässig, reguläre Items schon. State steht im Titel.
	check := sm.AddSubMenuItem(toggleLabel(enabled), "")
	var assetItem *systray.MenuItem
	assetAktiv := false
	if enabled {
		// P13-T45: Asset-Sync je Projekt (config.json asset_sync.aktiv, Standard aus).
		assetAktiv = assetSyncAktivFuer(p)
		assetItem = sm.AddSubMenuItem(assetSyncSchalterLabel(assetAktiv), "Asset-Dateien dieses Projekts mit dem Share synchronisieren")
		go func(pName string, item *systray.MenuItem) {
			for range item.ClickedCh {
				go assetSyncUmschalten(pName)
			}
		}(name, assetItem)
		sm.AddSeparator()
		signale++
	}

	itOeffnen := sm.AddSubMenuItem("Öffnen...", "")
	go func(projName string) {
		for range itOeffnen.ClickedCh {
			openDetail(projName)
		}
	}(name)

	if enabled {
		// Fetch channels
		channelsUrl := channelsUrlFuer(port, name)
		var channels []string
		if chResp, err := client.Get(channelsUrl); err == nil {
			var chData ChannelsResponse
			if json.NewDecoder(chResp.Body).Decode(&chData) == nil {
				for _, ch := range chData.Channels {
					channels = append(channels, ch.Name)
				}
			}
			chResp.Body.Close()
		}

		// CH-5: Umschalter direkt ueber den Channels — dort, wo man ihn braucht.
		// Der Haken zeigt den AKTUELLEN Zustand; ein Klick kehrt ihn um und baut das
		// Menue neu auf, damit die Wirkung sofort sichtbar ist.
		archivLabel := "Archiv anzeigen"
		if archivAnzeigen.Load() {
			archivLabel = "✓ Archiv wird angezeigt"
		}
		mArchiv := sm.AddSubMenuItem(archivLabel, "Archivierte Channels und Nachrichten ein-/ausblenden (Inhalte bleiben erhalten)")
		go func(item *systray.MenuItem) {
			for range item.ClickedCh {
				archivAnzeigen.Store(!archivAnzeigen.Load())
				triggerRefresh()
			}
		}(mArchiv)

		if len(channels) > 0 {
			sm.AddSeparator()
			signale++
			for _, ch := range channels {
				mChannel := sm.AddSubMenuItem("# "+ch, "")
				go func(pName, cName string, item *systray.MenuItem) {
					for range item.ClickedCh {
						openChat(pName, cName)
					}
				}(name, ch, mChannel)
			}
		}

		sm.AddSeparator()
		signale++
		itLoeschen := sm.AddSubMenuItem("Löschen...", "")
		go func(projName string) {
			for range itLoeschen.ClickedCh {
				openDetailAuf(projName, "Aktionen") // Loeschen liegt im Tab Aktionen
			}
		}(name)
	}

	projectHandles[name] = &ProjectMenuHandles{
		SubMenu:        sm,
		CheckItem:      check,
		Enabled:        enabled,
		AssetItem:      assetItem, // nil bei inaktiven Projekten (Fall 3 und Klick pruefen das)
		AssetSyncAktiv: assetAktiv,
	}

	// Active toggle handler. Nach einem Rebuild kann das Handle fehlen (Projekt
	// entfernt) — dann den Daemon-Status entscheiden lassen statt nil zu lesen.
	go func(pName string, item *systray.MenuItem) {
		for range item.ClickedCh {
			menuMutex.Lock()
			aktiv := false
			if h := projectHandles[pName]; h != nil {
				aktiv = h.Enabled
			}
			menuMutex.Unlock()
			toggleProject(pName, aktiv)
		}
	}(name, check)
	return signale
}

func refresh() {
	menuMutex.Lock()
	defer menuMutex.Unlock()

	port = readPort()

	u := fmt.Sprintf("http://127.0.0.1:%d/projects", port)
	// 3s statt 1s: waehrend der Daemon kurz beschaeftigt ist (Initial-Scan,
	// GC-Pause) soll die Online-Probe nicht in den Timeout laufen und faelschlich
	// OFFLINE flackern. Ein wirklich toter Daemon antwortet gar nicht → schnell offline.
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(u)

	var projs []Project
	if err != nil {
		connected = false
	} else {
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			var apiResp ProjectsResponse
			if err := json.NewDecoder(resp.Body).Decode(&apiResp); err == nil {
				connected = true
				projs = apiResp.Projekte
			} else {
				connected = false
			}
		} else {
			connected = false
		}
	}

	systray.SetIcon(makeIcon(connected))

	// Workspaces gedrosselt und im Hintergrund pollen (synapse-api, P8-T21):
	// refresh() laeuft im 1s/10s-Takt; der Abruf selbst setzt den naechsten
	// Termin je Ergebnis (ok 30 s, nicht verbunden 1 min, offline 5 min) und
	// stoesst danach ein refresh() an. Hier wird nur der letzte Stand gelesen.
	wsAbrufMu.Lock()
	if time.Now().After(nextWorkspacePoll) {
		nextWorkspacePoll = time.Now().Add(30 * time.Second) // vorlaeufig bis der Abruf fertig ist
		starteWorkspaceAbruf()
	}
	workspaces = wsAbrufListe
	workspacesZustand = wsAbrufZustand
	wsAbrufMu.Unlock()
	wsSig := getWorkspaceSignature(workspaces, workspacesZustand)

	// Channels gedrosselt pollen (alle 5s) — damit neu angelegte Channels einen
	// Rebuild ausloesen, ohne dass refresh() (1s-Takt) die API mit N Calls/s flutet.
	// P8-T21: nur aktive Projekte, denn nur sie zeigen Channels im Menue.
	if connected && time.Now().After(nextChannelPoll) {
		currentChannelSig = getChannelSignature(aktiveProjekte(projs), port)
		nextChannelPoll = time.Now().Add(5 * time.Second)
	}

	sig := getProjectSignature(projs)

	// Fall 1: Online-Status ODER Projekt-Set (inkl. Aktiv-Zustand) ODER
	//         Channel-Set geaendert -> Full rebuild (zieht Workspaces mit)
	if connected != wasOnline || sig != lastProjectSignature || currentChannelSig != lastChannelSignature {
		rebuildMenu(projs)
		return
	}

	// Fall 1b (P8-T21): nur Workspaces geaendert -> nur dieses Untermenue
	// ersetzen. Ein Rebuild wuerde jeden der ~500 Eintraege einzeln entfernen.
	if wsSig != lastWorkspaceSignature {
		n := aktualisiereWorkspacesMenue()
		lastWorkspaceSignature = wsSig
		log.Printf("[tray] Workspaces-Menue aktualisiert (%s): %d LayoutUpdated", workspacesZustand, n)
	}

	// Fall 2: Offline remained -> Nothing to do
	if !connected {
		return
	}

	// Fall 3: Inkrementell nur noch der Asset-Sync-Schalter. Ein Wechsel
	// aktiv/inaktiv aendert die Projekt-Signatur und baut oben neu auf (Fall 1).
	for _, p := range projs {
		if handle, ok := projectHandles[p.Name]; ok {
			if a := assetSyncAktivFuer(p); handle.AssetItem != nil && handle.AssetSyncAktiv != a {
				handle.AssetSyncAktiv = a
				handle.AssetItem.SetTitle(assetSyncSchalterLabel(a))
			}
		}
	}
}

// Detail window implementation
func openDetail(name string) { openDetailAuf(name, "") }

// openDetailAuf oeffnet das Projektfenster und waehlt optional einen Tab
// (Menue "Loeschen..." landet so direkt bei "Aktionen").
func openDetailAuf(name, tab string) {
	windowLock.Lock()
	if w, ok := openWindows[name]; ok {
		windowLock.Unlock()
		fyne.Do(func() {
			zeigeVersteckt(w.Window, &w.sichtbar)
			w.zeigeTab(tab)
		})
		go w.ReloadAll()
		return
	}

	w := &DetailWindow{
		ProjectName: name,
	}

	w.AgentStatus = widget.NewLabel("")
	w.EventStatus = widget.NewLabel("")
	w.ActivityStatus = widget.NewLabel("")

	// Tab 1: Agenten
	w.AgentTable = neueTabelle([]string{"Agent", "Modell", "Status", "Kontext", "Letzte Aktivität"},
		func() [][]string { return w.AgentRows })
	w.AgentTable.SetColumnWidth(0, 150)
	w.AgentTable.SetColumnWidth(1, 150)
	w.AgentTable.SetColumnWidth(2, 100)
	w.AgentTable.SetColumnWidth(3, 80)
	w.AgentTable.SetColumnWidth(4, 180)

	w.AgentTable.OnSelected = func(id widget.TableCellID) {
		w.agentAuswahl.waehle(w.AgentKeys, id.Row, id.Col)
	}

	btnStop := widget.NewButton("Stoppen", func() {
		if agentName := w.agentAuswahl.schluessel; agentName != "" {
			dialog.ShowConfirm("Stoppen?", fmt.Sprintf("Spezialist '%s' stoppen?\nSIGTERM geht an den Wrapper.", agentName), func(ok bool) {
				if ok {
					go func() {
						u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/specialists/%s/stop", port, url.QueryEscape(name), url.QueryEscape(agentName))
						client := &http.Client{Timeout: 1 * time.Second}
						resp, err := client.Post(u, "application/json", bytes.NewReader([]byte("{}")))
						if err == nil {
							resp.Body.Close()
						}
						w.ReloadAgenten()
					}()
				}
			}, w.Window)
		} else {
			dialog.ShowInformation("Stoppen", "Kein Spezialist ausgewählt.", w.Window)
		}
	})

	btnRefA := widget.NewButton("Aktualisieren", func() {
		go w.ReloadAgenten()
	})

	tabAgenten := container.NewBorder(w.AgentStatus, container.NewHBox(btnStop, btnRefA), nil, nil, w.AgentTable)

	// Tab 2: Events
	w.FilterEntry = widget.NewEntry()
	w.FilterEntry.SetPlaceHolder("Substring in Datei/Agent/Reason/Feature...")
	w.filterText.Store("")
	w.FilterEntry.OnChanged = func(text string) {
		// Entprellt: erst 300 ms nach dem letzten Tastendruck neu laden (vorher
		// startete jeder Tastendruck einen eigenen Abruf).
		w.filterText.Store(text)
		nr := w.filterNr.Add(1)
		time.AfterFunc(300*time.Millisecond, func() {
			if w.filterNr.Load() == nr {
				w.ReloadEvents()
			}
		})
	}

	w.EventTable = neueTabelle([]string{"Zeit", "Agent", "Datei", "Aktion", "Grund", "Feature"},
		func() [][]string { return w.EventRows })
	w.EventTable.SetColumnWidth(0, 130)
	w.EventTable.SetColumnWidth(1, 100)
	w.EventTable.SetColumnWidth(2, 350)
	w.EventTable.SetColumnWidth(3, 80)
	w.EventTable.SetColumnWidth(4, 250)
	w.EventTable.SetColumnWidth(5, 120)

	w.EventTable.OnSelected = func(id widget.TableCellID) {
		w.eventAuswahl.waehle(eventSchluessel(w.EventRows), id.Row, id.Col)
	}

	btnRefE := widget.NewButton("Aktualisieren", func() {
		go w.ReloadEvents()
	})
	btnOpenE := widget.NewButton("Öffnen", func() {
		idx := zeileZuSchluessel(eventSchluessel(w.EventRows), w.eventAuswahl.schluessel)
		if idx < 0 {
			dialog.ShowInformation("Öffnen", "Keine Zeile ausgewählt.", w.Window)
			return
		}
		go w.OpenEventFile(w.EventRows[idx][2])
	})

	tabEvents := container.NewBorder(
		container.NewVBox(w.EventStatus, container.NewBorder(nil, nil, widget.NewLabel("Filter:"), nil, w.FilterEntry)),
		container.NewHBox(btnRefE, btnOpenE),
		nil,
		nil,
		w.EventTable,
	)

	// Tab 3: Aktivitaet — ALLE geloggten Tool-Aufrufe (tool_calls: code_intel,
	// files, shell, alles). Details-Knopf oeffnet ein eigenes Fenster mit dem
	// vollen (ungekuerzten) Inhalt der ausgewaehlten Zeile.
	w.ActivityTable = neueTabelle([]string{"Zeit", "Tool", "Action", "Agent", "OK", "ms", "Ergebnis"},
		func() [][]string { return w.ActivityRows })
	w.ActivityTable.SetColumnWidth(0, 130)
	w.ActivityTable.SetColumnWidth(1, 110)
	w.ActivityTable.SetColumnWidth(2, 150)
	w.ActivityTable.SetColumnWidth(3, 120)
	w.ActivityTable.SetColumnWidth(4, 60)
	w.ActivityTable.SetColumnWidth(5, 80)
	w.ActivityTable.SetColumnWidth(6, 320)

	w.ActivityTable.OnSelected = func(id widget.TableCellID) {
		w.aktivitaetAuswahl.waehle(w.ActivityIDs, id.Row, id.Col)
	}

	btnRefAkt := widget.NewButton("Aktualisieren", func() {
		go w.ReloadActivity()
	})
	btnDetailAkt := widget.NewButton("Details", func() {
		if id := w.aktivitaetAuswahl.schluessel; id != "" {
			// Auf dem UI-Faden: frueher per go-Routine, das Fenster entstand damit
			// ausserhalb des Fyne-Fadens.
			showActivityDetailWindow(name, id)
		} else {
			dialog.ShowInformation("Details", "Keine Zeile ausgewählt.", w.Window)
		}
	})

	tabAktivitaet := container.NewBorder(w.ActivityStatus, container.NewHBox(btnRefAkt, btnDetailAkt), nil, nil, w.ActivityTable)

	// Tab 4: Status
	w.PathLabel = widget.NewLabel("-")
	w.ActiveLabel = widget.NewLabel("-")
	w.ChunksLabel = widget.NewLabel("-")
	w.FilesLabel = widget.NewLabel("-")
	// Lange Pfade umbrechen statt abschneiden, und kopierbar machen.
	w.PathLabel.Wrapping = fyne.TextWrapWord
	w.PathLabel.Selectable = true

	statusForm := widget.NewForm(
		widget.NewFormItem("Pfad:", w.PathLabel),
		widget.NewFormItem("Aktiv:", w.ActiveLabel),
		widget.NewFormItem("Chunks:", w.ChunksLabel),
		widget.NewFormItem("Dateien:", w.FilesLabel),
	)

	btnRefS := widget.NewButton("Aktualisieren", func() {
		go w.ReloadStatus()
	})

	tabStatus := container.NewBorder(nil, container.NewHBox(btnRefS), nil, nil, statusForm)

	// Tab 4: Aktionen
	btnReindex := widget.NewButton("Neu indexieren (alles)", func() {
		dialog.ShowConfirm("Neu indexieren?", fmt.Sprintf("Projekt '%s' komplett neu indexieren?\n\nVerwirft Parse UND Embeddings: jede Datei wird neu eingelesen\nund neu embedded. Das kostet Rechenzeit und Geld.\n\nWenn nur ein Parser besser geworden ist, reicht 'Neu parsen'.", name), func(ok bool) {
			if ok {
				go func() {
					u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/reindex", port, url.QueryEscape(name))
					client := &http.Client{Timeout: 5 * time.Second}
					resp, err := client.Post(u, "application/json", bytes.NewReader([]byte("{}")))
					// Frueher wurde JEDER Fehler verschluckt und trotzdem "Reindex
					// gestartet" gemeldet. Dadurch fiel nie auf, dass der Daemon diese
					// Route gar nicht hat. Jetzt ehrlich melden was passiert ist.
					var meldung string
					var fehler error
					if err != nil {
						fehler = err
					} else {
						status := resp.StatusCode
						resp.Body.Close()
						switch {
						case status == 404:
							fehler = fmt.Errorf("Der Daemon kennt /projects/%s/reindex nicht (HTTP 404).", name)
						case status >= 400:
							fehler = fmt.Errorf("Daemon antwortete mit HTTP %d.", status)
						default:
							meldung = "Reindex gestartet. Fortschritt im Daemon-Log."
						}
					}
					fyne.Do(func() {
						if fehler != nil {
							dialog.ShowError(fehler, w.Window)
							return
						}
						dialog.ShowInformation("Reindex", meldung, w.Window)
					})
				}()
			}
		}, w.Window)
	})

	// REPARSE-3: Symbole neu erzeugen, Embeddings unangetastet lassen.
	// Der Gegenpart zu "Neu indexieren": nach einer Parser-Verbesserung sind nur
	// die abgeleiteten Symbole veraltet, der Dateiinhalt und damit die Vektoren
	// sind unveraendert gueltig.
	btnReparse := widget.NewButton("Neu parsen (ohne Embeddings)", func() {
		dialog.ShowConfirm("Neu parsen?", fmt.Sprintf("Projekt '%s' neu parsen?\n\nErzeugt ALLES neu, was der Parser liefert:\nFunktionen, Klassen, Variablen, Importe, Strings,\nStatements, Aufruf-Kanten und Cross-File-Verweise.\n\nNur die Embeddings bleiben unangetastet — deshalb\nkostet es nichts. Sinnvoll, wenn ein Parser verbessert\nwurde und der Index noch den alten Stand zeigt.", name), func(ok bool) {
			if ok {
				go func() {
					u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/reparse", port, url.QueryEscape(name))
					client := &http.Client{Timeout: 5 * time.Second}
					resp, err := client.Post(u, "application/json", bytes.NewReader([]byte("{}")))
					// Fehler NICHT verschlucken — siehe btnReindex: dort wurde frueher
					// jeder Fehler geschluckt und trotzdem Erfolg gemeldet, weshalb
					// monatelang niemand merkte, dass die Route gar nicht existierte.
					var meldung string
					var fehler error
					if err != nil {
						fehler = err
					} else {
						status := resp.StatusCode
						resp.Body.Close()
						switch {
						case status == 404:
							fehler = fmt.Errorf("Der Daemon kennt /projects/%s/reparse nicht (HTTP 404). Daemon zu alt?", name)
						case status >= 400:
							fehler = fmt.Errorf("Daemon antwortete mit HTTP %d.", status)
						default:
							meldung = "Reparse gestartet. Symbole werden neu erzeugt, die Embeddings bleiben unangetastet.\nFortschritt im Daemon-Log."
						}
					}
					fyne.Do(func() {
						if fehler != nil {
							dialog.ShowError(fehler, w.Window)
							return
						}
						dialog.ShowInformation("Reparse", meldung, w.Window)
					})
				}()
			}
		}, w.Window)
	})

	btnDelete := widget.NewButton("Projekt löschen", func() {
		dialog.ShowConfirm("Löschen?", fmt.Sprintf("Projekt '%s' wirklich löschen?\nIndex und Watcher-Eintrag werden entfernt.\nDer Ordner auf der Platte bleibt unberührt.", name), func(ok bool) {
			if ok {
				go func() {
					// TRAY-5: Frueher ging hier ein POST auf /projects/<name>/delete raus,
					// das der Daemon nie kannte. Er hat DELETE /projects/<name> — genau
					// diese Route wird jetzt benutzt, eine neue braucht es nicht.
					// Ausserdem wurde jeder Fehler verschluckt: das Fenster ging zu und
					// der Eintrag verschwand aus der Liste, egal ob wirklich etwas
					// geloescht wurde. Beim naechsten Refresh war das Projekt wieder da.
					u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s", port, url.QueryEscape(name))
					req, err := http.NewRequest(http.MethodDelete, u, nil)
					var fehler error
					if err != nil {
						fehler = err
					} else {
						client := &http.Client{Timeout: 5 * time.Second}
						resp, ferr := client.Do(req)
						if ferr != nil {
							fehler = ferr
						} else {
							status := resp.StatusCode
							resp.Body.Close()
							if status >= 400 {
								fehler = fmt.Errorf("Daemon antwortete mit HTTP %d — das Projekt wurde NICHT geloescht.", status)
							}
						}
					}
					if fehler != nil {
						fyne.Do(func() {
							dialog.ShowError(fehler, w.Window)
						})
						return
					}
					windowLock.Lock()
					delete(openWindows, name)
					windowLock.Unlock()
					// Wirklich schliessen statt nur verstecken: das Projekt ist weg, das
					// versteckte Fenster wurde nie wieder gebraucht. Das Ankerfenster haelt
					// die App dabei am Leben.
					fyne.Do(func() {
						w.sichtbar.Store(false)
						w.Window.Close()
					})
					triggerRefresh()
				}()
			}
		}, w.Window)
	})

	// REEMBED-3: Nach einem Wechsel des Embedding-Modells sind die alten Vektoren
	// wertlos (anderer Vektorraum) und bei abweichender Dimension unbrauchbar.
	// Verwirft die Qdrant-Collection und laesst neu embedden — PostgreSQL bleibt
	// inhaltlich unangetastet, zurueckgesetzt werden nur die Embedding-Marker.
	btnReembed := widget.NewButton("Embeddings neu erzeugen", func() {
		dialog.ShowConfirm(
			"Embeddings neu erzeugen?",
			fmt.Sprintf("Alle Code-Embeddings von '%s' verwerfen und neu erzeugen?\n\n"+
				"Fuer den Fall dass das Embedding-Modell gewechselt wurde.\n"+
				"Die Qdrant-Collection wird neu angelegt, PostgreSQL bleibt unveraendert\n"+
				"(Inhalte, Symbole, Chunks und Versionen bleiben erhalten).\n\n"+
				"Das Neu-Embedden laeuft danach im Hintergrund und kann dauern.", name),
			func(ok bool) {
				if !ok {
					return
				}
				go func() {
					res, err := apiReembedProject(name)
					fyne.Do(func() {
						if err != nil {
							dialog.ShowError(err, w.Window)
							return
						}
						if !res.Success {
							dialog.ShowError(fmt.Errorf("%s: %s", res.Error, res.Message), w.Window)
							return
						}
						dialog.ShowInformation("Embeddings zurueckgesetzt", res.Message, w.Window)
					})
				}()
			}, w.Window)
	})

	tabAktionen := container.NewVBox(
		btnReparse,
		btnReindex,
		btnReembed,
		btnDelete,
	)

	w.Tabs = container.NewAppTabs(
		container.NewTabItem("Agenten", tabAgenten),
		container.NewTabItem("Events", tabEvents),
		container.NewTabItem("Aktivität", tabAktivitaet),
		container.NewTabItem("Status", tabStatus),
		container.NewTabItem("Aktionen", tabAktionen),
	)

	openWindows[name] = w
	windowLock.Unlock()

	fyne.Do(func() {
		w.Window = myApp.NewWindow("Projekt: " + name)
		w.Window.Resize(fyne.NewSize(1200, 800))
		versteckbaresFenster(w.Window, &w.sichtbar)
		w.sichtbar.Store(true)
		w.Window.SetContent(w.Tabs)
		w.zeigeTab(tab)
		zeigeFyneFenster(w.Window)
	})

	go w.ReloadAll()
}

// zeigeGPUFenster zeigt zuerst den serverseitigen Sollzustand. Erst der
// Verwenden-Klick fuehrt die Hardwaremessung aus; vor diesem Gate wird Ollama
// weder abgefragt noch gestartet.
func zeigeGPUFenster() {
	// P8-T20: hoechstens EIN GPU-Fenster; Schliessen beendet den Tray nicht mehr (fenster.go).
	oeffneEinzelFenster("gpu", "Lokale GPU / Ollama", bauGPUFenster)
}

// bauGPUFenster fuellt das GPU-Fenster; die Rueckgabe raeumt beim Schliessen auf.
func bauGPUFenster(fenster fyne.Window) func() {
	status := widget.NewLabel("API-Einstellungen werden geladen …")
	status.Wrapping = fyne.TextWrapWord
	// Vergleichstext als LABEL, nicht als deaktiviertes Eingabefeld: ein
	// disabled Entry wird von Fyne ausgegraut und ist auf dunklem Grund kaum zu
	// lesen — ausgerechnet fuer die beiden 64-stelligen Digests, um die es hier
	// geht. Ein Label nimmt ausserdem die Hoehe, die der Inhalt braucht, statt
	// drei Zeilen mit Rollbalken zu zeigen.
	details := widget.NewLabel("")
	details.Wrapping = fyne.TextWrapWord
	details.TextStyle = fyne.TextStyle{Monospace: true}
	// KEIN TOTP-Feld mehr (User-Vorgabe 01.08.2026): Einrichten UND Sperren
	// laufen ueber das vorhandene Daemon-Token aus config.json. Der Server
	// akzeptiert es fuer beides, laesst aber ein compute-node-Token nicht zu —
	// ein Knoten kann seine eigene Sperre also weiterhin nicht aufheben.
	modelDir := widget.NewEntry()
	// Das Modellverzeichnis wird ERMITTELT, nicht geraten. Zwei Fallen an einem Tag:
	// (1) Ein eigenes Verzeichnis unter .synapse haette einen 4,7-GB-Pull ausgeloest,
	//     obwohl die Datei mit identischem Digest bereits auf der Platte lag.
	// (2) Die feste Vorgabe ~/.ollama/models zeigte auf ein Verzeichnis mit zwei
	//     alten Modellen — Ollama laeuft hier als SYSTEMDIENST und benutzt
	//     /usr/share/ollama/.ollama/models. Das dedizierte Ollama startete damit ohne das
	// gesuchte Modell und der Knoten kam nie zustande.
	// P15-T6: Welches Modell gesucht wird, sagt der Referenzvertrag (hier stand fest
	// "qwen3-embedding:8b"). Bis er da ist, gilt das erste lesbare Verzeichnis; danach wird
	// nach dem Vertragsmodell gesucht, solange der Nutzer das Feld nicht selbst geaendert hat.
	vorschlagModelDir := ermittleModellVerzeichnis("")
	modelDir.SetText(vorschlagModelDir)
	gpuSelect := widget.NewSelect([]string{"GPU 0"}, nil)
	gpuSelect.SetSelectedIndex(0)

	var ref apiEmbeddingReferenceResponse
	var refOK bool
	go func() {
		r, err := apiFetchEmbeddingReference()
		if err != nil {
			fyne.Do(func() { status.SetText("API-Einstellungen nicht belegbar: " + err.Error()) })
			return
		}
		ref, refOK = r, true
		vertragsDir := ermittleModellVerzeichnis(ref.Reference.Model)
		fyne.Do(func() {
			if modelDir.Text == vorschlagModelDir {
				modelDir.SetText(vertragsDir)
			}
		})
		all, hardwareErr := detectAllGPUHardware()
		options := make([]string, 0, len(all))
		for i, h := range all {
			options = append(options, fmt.Sprintf("GPU %d: %s — %d MB gesamt / %d MB frei", i, h.Name, h.TotalMB, h.FreeMB))
		}
		// HIER STAND gpuComparisonText(ref, nil, nil): weder das lokal installierte
		// Modell noch die Hardware wurden uebergeben, obwohl beides in dieser
		// Funktion bereits vorliegt bzw. mit einem Aufruf zu haben ist. Die Anzeige
		// meldete deshalb "Lokales Modell: (nicht vorhanden)" und "Hardware: noch
		// nicht geprueft", waehrend qwen3-embedding:8b mit identischem Digest auf
		// dem Standard-Ollama lag (gemessen 01.08.2026).
		lokal, _ := localOllamaTag(ref.Reference.Model)
		var erste *gpuHardware
		if len(all) > 0 {
			erste = &all[0]
		}
		fyne.Do(func() {
			details.SetText(gpuComparisonText(ref, lokal, erste))
			if hardwareErr != nil || len(options) == 0 {
				gpuSelect.Options = []string{"Keine messbare NVIDIA-GPU"}
				gpuSelect.SetSelectedIndex(0)
				gpuSelect.Disable()
				// Kein hardwareErr.Error() auf nil: eine Panik hier beendete den ganzen Tray.
				grund := "keine NVIDIA-GPU gemeldet"
				if hardwareErr != nil {
					grund = hardwareErr.Error()
				}
				status.SetText("API-Einstellungen geladen. " + grund)
				return
			}
			gpuSelect.Options = options
			gpuSelect.SetSelectedIndex(0)
			gpuSelect.Enable()
			status.SetText("API-Einstellungen und GPU-Liste geladen. Vor Ollama wird die gewählte GPU erneut gemessen.")
		})
	}()

	// P15-T11: LAN-Adresse nur als Option (Standard aus, Begruendung in gpu_helfer_einstellungen.go).
	// Das Haekchen schreibt gpu-helfer.json; ein laufender Helfer startet mit der neuen Adresswahl neu.
	adressStatus := widget.NewLabel("")
	adressStatus.Wrapping = fyne.TextWrapWord
	lanCheck := widget.NewCheck("API im LAN bevorzugen (synapse_api_url aus config.json, öffentliche Adresse als Rückfall)", nil)
	lanCheck.SetChecked(ladeGPUHelferEinstellungen().LanBevorzugen)
	// Nur auf dem UI-Faden gelesen/gesetzt (fyne.Do), daher ohne Mutex.
	lanProgrammatisch := false
	lanCheck.OnChanged = func(an bool) {
		if !lanHaekchenSchreiben(an, lanProgrammatisch, ladeGPUHelferEinstellungen().LanBevorzugen) {
			return
		}
		go func() {
			if err := setzeGPUHelferEinstellung("lan_bevorzugen", an); err != nil {
				fyne.Do(func() { status.SetText("Einstellung nicht gespeichert: " + err.Error()) })
				return
			}
			neu, err := gpuHelferBeiAenderungNeustarten()
			fyne.Do(func() {
				switch {
				case err != nil:
					status.SetText("Gespeichert, Neustart des GPU-Helfers fehlgeschlagen: " + err.Error())
				case neu:
					status.SetText("Gespeichert; GPU-Helfer startet mit der neuen Adresswahl neu.")
				default:
					status.SetText("Gespeichert; gilt beim nächsten Start des GPU-Helfers.")
				}
			})
			// Der Helfer meldet seine Adresse nach der Registrierung (wenige Sekunden).
			time.Sleep(4 * time.Second)
			t := gpuHelferStatusText()
			fyne.Do(func() { adressStatus.SetText(t) })
		}()
	}

	var toggleButton *widget.Button
	// P15-T9: fuer einen laufenden Helfer gab es nur "Sperren". Stoppen beendet den Prozess (SIGTERM ->
	// der Helfer gibt seine offenen Claims zurueck), laesst die Registry aber unangetastet.
	var stopButton *widget.Button
	// knopfBeschriften wird erst weiter unten belegt, aber schon hier von
	// startSetup gebraucht — daher die Vorab-Deklaration.
	var knopfBeschriften func()
	startSetup := func(index int, h gpuHardware, mustPull bool) {
		toggleButton.Disable()
		status.SetText("Einrichtung läuft …")
		// Kein TOTP mehr im Fenster: der Server nimmt das Daemon-Token als Ausweis.
		// Der leere String schaltet apiHoleComputeToken auf genau diesen Weg um.
		codeValue := ""
		modelDirValue := strings.TrimSpace(modelDir.Text)
		go func() {
			freshHardware, err := detectGPUHardware(index, ref.Reference.RequiredTotalVramMb, ref.Reference.RequiredFreeVramMb)
			h = freshHardware
			cfg := loadGPUNodeConfig()
			if cfg.NodeID == "" && err == nil {
				cfg.NodeID = defaultGPUNodeID()
				// Nur die stabile Identitaet darf einen fehlgeschlagenen ersten
				// Versuch ueberleben. Credential und Setup-Felder folgen erst
				// nach erfolgreichem Voll-Digest-Gate.
				err = saveGPUNodeConfig(gpuNodeConfig{NodeID: cfg.NodeID})
			}
			cfg.ModelDir, cfg.GPUIndex = modelDirValue, index
			if err == nil {
				if e := os.MkdirAll(cfg.ModelDir, 0700); e != nil {
					err = fmt.Errorf("Zielpfad nicht nutzbar: %w", e)
				}
			}
			if err == nil && mustPull {
				err = ensureGPUModelDiskSpace(cfg.ModelDir, ref.Download.ModelSizeGb)
			}
			// Der kurzlebige TOTP wird sofort gegen ein langlebiges, node-scoped
			// Compute-Token getauscht. Bis Pull und Voll-Digest-Gate erfolgreich
			// sind, bleibt es nur im Speicher; der TOTP selbst wird nie gespeichert
			// oder geloggt und eine bestehende Konfiguration bleibt unveraendert.
			if err == nil {
				tok, tokenErr := apiHoleComputeToken(codeValue, cfg.NodeID)
				err = tokenErr
				if tokenErr == nil {
					cfg.ComputeToken, cfg.Issuer = tok.Token, tok.Issuer
				}
			}
			if err == nil {
				err = startDedicatedOllama(cfg.ModelDir, index)
			}
			if err == nil && mustPull {
				if pullErr := pullGPUModel(ref.Reference.Model, cfg.ModelDir, index); pullErr != nil {
					err = fmt.Errorf("Modelldownload fehlgeschlagen; Node ist nicht gebunden. Der dedizierte Ollama-Prozess kann weiterlaufen und Partialdaten koennen in %s liegen: %w", cfg.ModelDir, pullErr)
				}
			}
			var tag *ollamaTag
			if err == nil {
				tag, err = localOllamaTag(ref.Reference.Model)
			}
			if err == nil && (ref.Reference.ModelDigest == nil || tag == nil ||
				!gpuDigestsMatch(*ref.Reference.ModelDigest, tag.Digest)) {
				err = errors.New("Digest fehlt oder weicht ab; Node wird nicht gebunden")
			}
			if err == nil {
				// Erst der belegte Voll-Digest macht das Credential zu einer
				// gueltigen persistenten Node-Konfiguration (0600, atomar).
				err = saveGPUNodeConfig(cfg)
			}
			if err == nil {
				err = startLokalenGPUHelper(cfg)
			}
			effectiveStatus := ""
			if err == nil {
				deadline := time.Now().Add(45 * time.Second)
				for time.Now().Before(deadline) {
					self, selfErr := apiFetchOwnEmbeddingNode(cfg.NodeID, cfg.Issuer, cfg.ComputeToken)
					if selfErr == nil {
						effectiveStatus = self.Node.EffectiveStatus
						// ⚠️ busy GEHOERT DAZU. Hier stand bis zum 01.08.2026 nur ready und
						// locked — ein Knoten, der sofort einen Chunk annimmt, steht aber auf
						// busy und erreichte ready nie. Der Handshake scheiterte damit an
						// seinem eigenen Erfolg: je schneller der Knoten arbeitete, desto
						// sicherer meldete die Oberflaeche "nicht eingerichtet".
						// GEMESSEN im selben Moment, in dem der Tray den Fehler zeigte:
						// status=busy, active_jobs=1, gesperrt=false.
						// Der Server wertet busy laengst als nutzbar (listEmbeddingNodes:
						// usable = ready || busy) — der Tray war die einzige Stelle, die
						// strenger urteilte als die Instanz, die entscheidet.
						if effectiveStatus == "ready" || effectiveStatus == "busy" || effectiveStatus == "locked" {
							break
						}
					}
					time.Sleep(1500 * time.Millisecond)
				}
				if effectiveStatus != "ready" && effectiveStatus != "busy" && effectiveStatus != "locked" {
					err = fmt.Errorf("Registry-Handshake wurde nicht innerhalb von 45 Sekunden bereit; zuletzt gemeldeter Zustand: %q", effectiveStatus)
				}
			}
			fyne.Do(func() {
				toggleButton.Enable()
				if err != nil {
					status.SetText("Nicht eingerichtet: " + err.Error())
				} else if effectiveStatus == "locked" {
					status.SetText(fmt.Sprintf("Registry bestätigt: %s ist dauerhaft gesperrt_vom_user.", cfg.NodeID))
					details.SetText(gpuComparisonText(ref, tag, &h))
				} else {
					status.SetText(fmt.Sprintf("Registry bestätigt %s: %s; %d MB gesamt / %d MB frei gemessen.", strings.ToUpper(effectiveStatus), cfg.NodeID, h.TotalMB, h.FreeMB))
					details.SetText(gpuComparisonText(ref, tag, &h))
				}
			})
			knopfBeschriften()
		}()
	}

	// gpuZustandLesen beantwortet die einzige Frage, die der Knopf braucht: wird
	// die lokale GPU gerade verwendet? Die Registry ist die Wahrheit ueber die
	// Sperre, der laufende Helfer die Wahrheit ueber den Betrieb — erst beides
	// zusammen ergibt den Zustand. Geht ueber das Netz, gehoert also nie auf den
	// UI-Faden.
	gpuZustandLesen := func() (eingerichtet, gesperrt, laeuft bool) {
		cfg := loadGPUNodeConfig()
		if strings.TrimSpace(cfg.NodeID) == "" {
			return false, false, false
		}
		laeuft = laufenderLokalerGPUHelper() > 0
		if self, err := apiFetchOwnEmbeddingNode(cfg.NodeID, cfg.Issuer, cfg.ComputeToken); err == nil {
			gesperrt = self.Node.EffectiveStatus == "locked"
		}
		return true, gesperrt, laeuft
	}

	// knopfBeschriften macht den Knopf zur Zustandsanzeige: er sagt, was gerade
	// gilt, und was ein Klick daraus macht. Vorher gab es zwei Knoepfe, von denen
	// immer einer wirkungslos war — und nach dem Sperren fuehrte keiner zurueck.
	knopfBeschriften = func() {
		eingerichtet, gesperrt, laeuft := gpuZustandLesen()
		adressText := gpuHelferStatusText()
		fyne.Do(func() {
			adressStatus.SetText(adressText)
			switch {
			case !eingerichtet:
				toggleButton.SetText("Meine GPU verwenden")
			case gesperrt:
				toggleButton.SetText("GPU ist gesperrt — klicken zum Verwenden")
			case laeuft:
				toggleButton.SetText("GPU wird verwendet — klicken zum Sperren")
			default:
				toggleButton.SetText("GPU eingerichtet, Helfer läuft nicht — klicken zum Starten")
			}
			toggleButton.Enable()
			if laeuft {
				stopButton.Enable()
			} else {
				stopButton.Disable()
			}
		})
	}
	// verwendenStarten ist der bisherige Verwenden-Weg: Hardware messen, Digest
	// pruefen, notfalls das Modell laden und einrichten. Laeuft auf dem UI-Faden,
	// weil er einen Dialog zeigen kann. Jeder vorzeitige Ausstieg muss den Knopf
	// wieder freigeben — sonst bleibt er nach einem Fehlversuch tot.
	verwendenStarten := func() {
		if !refOK {
			status.SetText("API-Einstellungen sind nicht belegbar; keine lokale Aktion.")
			toggleButton.Enable()
			return
		}
		// Ausweis ist das Daemon-Token. Fehlt es, kann hier nichts eingerichtet
		// werden — die Anfrage braucht dann gar nicht erst rauszugehen.
		if strings.TrimSpace(apiToken()) == "" {
			status.SetText("Es liegt kein Synapse-Token vor. Bitte zuerst über \"Mit Synapse verbinden\" ein Token holen.")
			toggleButton.Enable()
			return
		}
		index := gpuSelect.SelectedIndex()
		h, err := detectGPUHardware(index, ref.Reference.RequiredTotalVramMb, ref.Reference.RequiredFreeVramMb)
		if err != nil {
			status.SetText(err.Error())
			details.SetText(gpuComparisonText(ref, nil, &h))
			toggleButton.Enable()
			return
		}
		tag, tagErr := localOllamaTag(ref.Reference.Model)
		if tagErr == nil && tag != nil {
			if ref.Reference.ModelDigest == nil || !gpuDigestsMatch(*ref.Reference.ModelDigest, tag.Digest) {
				status.SetText("Digest weicht ab oder ist nicht konfiguriert; Node wird nicht gebunden.")
				details.SetText(gpuComparisonText(ref, tag, &h))
				toggleButton.Enable()
				return
			}
			startSetup(index, h, false)
			return
		}
		msg := fmt.Sprintf("Modell fehlt. Vor dem Start werden %.1f GB nach %s geladen. Fortfahren?", ref.Download.ModelSizeGb, modelDir.Text)
		if ref.Download.ModelSizeGb <= 0 {
			// P15-T6: die API nennt die Groesse aus Ollama /api/tags; unbekannt -> keine erfundene Zahl.
			msg = fmt.Sprintf("Modell fehlt. Die API kennt die Downloadgröße nicht; ohne sie ist keine Speicherprüfung möglich (%s).", modelDir.Text)
		}
		dialog.NewConfirm("Download bestätigen", msg, func(ok bool) {
			if ok {
				startSetup(index, h, true)
				return
			}
			// Abbruch ist kein Fehler, darf den Knopf aber nicht gesperrt lassen.
			go knopfBeschriften()
		}, fenster).Show()
	}

	// sperrenAusfuehren setzt die Registry-Sperre UND beendet den lokalen Helfer.
	// Das Beenden geschieht auch dann, wenn die Sperre fehlschlaegt: der Nutzer
	// hat "sperren" gedrueckt, und ein weiterlaufender Helfer waere das Gegenteil.
	// Vorher blieb er stehen und lief endlos in 403 node_not_usable.
	sperrenAusfuehren := func(nodeID string) {
		err := apiSetEmbeddingLockMitDaemonToken(nodeID, true)
		stopErr := stopLokalenGPUHelper()
		fyne.Do(func() {
			switch {
			case err != nil && stopErr != nil:
				status.SetText("Sperren fehlgeschlagen: " + err.Error() + "; zusaetzlich " + stopErr.Error())
			case err != nil:
				status.SetText("Sperren fehlgeschlagen: " + err.Error() + "; der lokale GPU-Helfer wurde beendet.")
			case stopErr != nil:
				status.SetText("GPU ist als gesperrt_vom_user markiert, aber " + stopErr.Error())
			default:
				status.SetText("GPU ist gesperrt; der lokale GPU-Helfer wurde beendet.")
			}
		})
		knopfBeschriften()
	}

	// EIN Knopf statt zwei: sein Text nennt den Zustand, sein Klick kehrt ihn um.
	// Das Entsperren steckt bewusst im Verwenden-Zweig — ohne das kam der Nutzer
	// aus der Sperre nicht mehr heraus, weil der Handshake in locked haengenblieb.
	toggleButton = widget.NewButton("Meine GPU verwenden", func() {
		toggleButton.Disable()
		status.SetText("Zustand wird geprüft …")
		go func() {
			eingerichtet, gesperrt, laeuft := gpuZustandLesen()
			cfg := loadGPUNodeConfig()
			switch {
			case eingerichtet && !gesperrt && laeuft:
				sperrenAusfuehren(cfg.NodeID)
			case eingerichtet && gesperrt:
				if err := apiSetEmbeddingLockMitDaemonToken(cfg.NodeID, false); err != nil {
					fyne.Do(func() { status.SetText("Entsperren fehlgeschlagen: " + err.Error()) })
					knopfBeschriften()
					return
				}
				fyne.Do(func() {
					status.SetText("Sperre aufgehoben; Einrichtung läuft …")
					verwendenStarten()
				})
			default:
				fyne.Do(verwendenStarten)
			}
		}()
	})
	stopButton = widget.NewButton("GPU-Helfer stoppen", func() {
		stopButton.Disable()
		status.SetText("GPU-Helfer wird beendet …")
		go func() {
			if err := stopLokalenGPUHelper(); err != nil {
				fyne.Do(func() { status.SetText("Stoppen fehlgeschlagen: " + err.Error()) })
			} else {
				fyne.Do(func() {
					status.SetText("GPU-Helfer beendet. Der Knoten bleibt registriert und ungesperrt; offene Aufträge hat er zurückgegeben.")
				})
			}
			knopfBeschriften()
		}()
	})
	stopButton.Disable()
	// Nachmessen auf Knopfdruck: Hardware und lokales Modell koennen sich
	// jederzeit aendern (anderes Modell geladen, Spiel belegt VRAM). Ohne diesen
	// Knopf muesste man das Fenster schliessen und neu oeffnen, um einen
	// aktuellen Stand zu sehen.
	pruefButton := widget.NewButton("Hardware und Modell neu prüfen", func() {
		status.SetText("Messe Hardware und lokales Modell …")
		go func() {
			all, hardwareErr := detectAllGPUHardware()
			var lokal *ollamaTag
			if refOK {
				lokal, _ = localOllamaTag(ref.Reference.Model)
			}
			options := make([]string, 0, len(all))
			for i, h := range all {
				options = append(options, fmt.Sprintf("GPU %d: %s — %d MB gesamt / %d MB frei", i, h.Name, h.TotalMB, h.FreeMB))
			}
			gewaehlt := gpuSelect.SelectedIndex()
			fyne.Do(func() {
				if hardwareErr != nil || len(options) == 0 {
					status.SetText("Hardware nicht messbar: " + fmt.Sprint(hardwareErr))
					if refOK {
						details.SetText(gpuComparisonText(ref, lokal, nil))
					}
					return
				}
				gpuSelect.Options = options
				if gewaehlt >= 0 && gewaehlt < len(options) {
					gpuSelect.SetSelectedIndex(gewaehlt)
				} else {
					gpuSelect.SetSelectedIndex(0)
				}
				gpuSelect.Enable()
				idx := gpuSelect.SelectedIndex()
				if idx < 0 || idx >= len(all) {
					idx = 0
				}
				if refOK {
					details.SetText(gpuComparisonText(ref, lokal, &all[idx]))
				}
				status.SetText(fmt.Sprintf("Neu gemessen: %d GPU(s), lokales Modell %s.", len(all),
					map[bool]string{true: "gefunden", false: "nicht gefunden"}[lokal != nil]))
			})
		}()
	})

	// Scrollbar: lange Digests/Statusmeldungen passten auf kleinen Bildschirmen nicht.
	fenster.SetContent(container.NewVScroll(container.NewVBox(status, details,
		widget.NewLabel("GPU-Auswahl"), gpuSelect, pruefButton,
		widget.NewLabel("Modell-Zielpfad (vor Download prüfen)"), modelDir,
		container.NewHBox(toggleButton, stopButton),
		lanCheck, adressStatus)))
	// Der 5-s-Pruefktakt (gpuHelferEinstellungenBeobachten) fuehrt Haekchen und Adressstatus nach,
	// solange das Fenster offen ist - auch wenn KI/Daemon gpu-helfer.json geaendert haben.
	fensterNr := meldeGPUFensterAn(func(e gpuHelferEinstellungen, text string) {
		fyne.Do(func() {
			if lanCheck.Checked != e.LanBevorzugen {
				lanProgrammatisch = true
				lanCheck.SetChecked(e.LanBevorzugen)
				lanProgrammatisch = false
			}
			adressStatus.SetText(text)
		})
	})
	fenster.Resize(fyne.NewSize(820, 760))
	// Beim Oeffnen zeigt der Knopf sofort den echten Zustand statt einer Vorgabe.
	go knopfBeschriften()
	return func() { meldeGPUFensterAb(fensterNr) }
}

// zeigeVerbindungsFenster oeffnet die Verbindungs-Einrichtung (TRAY-3).
//
// Der Nutzer tippt den 6-stelligen Code aus seiner Authenticator-App ein, der
// Tray holt sich damit selbst ein Token (6 Monate gueltig) und schreibt es in
// die config.json. Kein Terminal, kein curl, kein Datei-Editieren.
func zeigeVerbindungsFenster() {
	oeffneEinzelFenster("verbindung", "Synapse-Verbindung", bauVerbindungsFenster)
}

// bauVerbindungsFenster fuellt das Verbindungsfenster (P8-T20: Einzelfenster).
func bauVerbindungsFenster(fenster fyne.Window) func() {

	status := widget.NewLabel("Status wird geprueft …")
	status.Wrapping = fyne.TextWrapWord

	hinweis := widget.NewLabel(
		"Oeffne deine Authenticator-App und gib den aktuellen 6-stelligen Code ein.\n" +
			"Der Zugang gilt danach ein halbes Jahr — du musst das nicht taeglich wiederholen.")
	hinweis.Wrapping = fyne.TextWrapWord

	codeFeld := widget.NewEntry()
	codeFeld.SetPlaceHolder("z. B. 123456")

	ergebnis := widget.NewLabel("")
	ergebnis.Wrapping = fyne.TextWrapWord

	// Aktuellen Zustand im Hintergrund ermitteln, damit das Fenster sofort aufgeht.
	go func() {
		var text string
		if apiToken() == "" {
			text = "Noch nicht verbunden — es ist kein Zugang hinterlegt."
		} else if basis, err := apiVerbindungPruefen(); err != nil {
			text = "Ein Zugang ist hinterlegt, wird aber abgelehnt oder ist nicht erreichbar:\n" +
				err.Error() + "\n\nMit einem neuen Code kannst du ihn hier ersetzen."
		} else {
			text = "Verbunden mit " + basis
		}
		fyne.Do(func() { status.SetText(text) })
	}()

	var knopf *widget.Button
	verbinden := func() {
		code := strings.TrimSpace(codeFeld.Text)
		if code == "" {
			ergebnis.SetText("Bitte den Code aus der App eingeben.")
			return
		}
		knopf.Disable()
		ergebnis.SetText("Verbinde …")

		go func() {
			antwort, err := apiHoleServiceToken(code, "tray")
			if err == nil {
				err = speichereApiToken(antwort.Token)
			}

			var meldung string
			if err != nil {
				meldung = "Hat nicht geklappt: " + err.Error()
			} else if basis, pruefErr := apiVerbindungPruefen(); pruefErr != nil {
				// Gespeichert, aber der Gegentest scheitert — ehrlich benennen statt
				// Erfolg zu melden.
				meldung = "Zugang gespeichert, aber der Test schlug fehl: " + pruefErr.Error()
			} else {
				meldung = "Verbunden mit " + basis + ".\nGueltig bis " +
					zeitLesbar(antwort.ExpiresAt) + ". Der Zugang ist gespeichert."
			}

			fyne.Do(func() {
				ergebnis.SetText(meldung)
				codeFeld.SetText("")
				knopf.Enable()
				if err == nil {
					status.SetText("Verbunden.")
					triggerRefresh()
				}
			})
		}()
	}

	// Enter im Eingabefeld loest ebenfalls aus — sonst tippt man den Code und
	// sucht dann den Knopf.
	codeFeld.OnSubmitted = func(string) { verbinden() }
	knopf = widget.NewButton("Verbinden", verbinden)

	fenster.SetContent(container.NewVScroll(container.NewVBox(
		status,
		widget.NewSeparator(),
		hinweis,
		codeFeld,
		knopf,
		ergebnis,
	)))
	fenster.Resize(fyne.NewSize(480, 360))
	// Tastatur: Code sofort tippen, Enter verbindet.
	fenster.Canvas().Focus(codeFeld)
	return nil
}

func (w *DetailWindow) ReloadAll() {
	// Kein Stau: laeuft noch ein Durchgang (langsame API), faellt dieser Takt aus.
	if w.ladet.Swap(true) {
		return
	}
	defer w.ladet.Store(false)
	w.ReloadAgenten()
	w.ReloadEvents()
	w.ReloadActivity()
	w.ReloadStatus()
}

func (w *DetailWindow) ReloadAgenten() {
	agents, err := apiFetchAgents(w.ProjectName)
	var rows [][]string
	var keys []string
	for _, a := range agents {
		key := "legacy:" + a.AgentName
		label := a.AgentName
		if a.IdentityId != "" {
			key = "identity:" + a.IdentityId
			label += " [" + a.IdentityId + "]"
		}
		keys = append(keys, key)
		rows = append(rows, []string{label, a.Model, a.Status, a.TokensPercent + "%", a.LastActivity})
	}
	fyne.Do(func() {
		zeigeAPIStatus(w.AgentStatus, err)
		w.AgentRows = rows
		w.AgentKeys = keys
		w.AgentTable.Refresh()
		w.agentAuswahl.nachfuehren(w.AgentTable, keys)
	})
}

// kuerzeAnzeige entfernt Zeilenumbrueche und begrenzt auf 200 Runen — identisch
// fuer den API- und den PG-Zweig, damit beide dieselbe Darstellung liefern.
func kuerzeAnzeige(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	r := []rune(s)
	if len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return s
}

func (w *DetailWindow) ReloadEvents() {
	filter := strings.ToLower(w.filterTextWert())
	versions, err := apiFetchFileVersions(w.ProjectName, 50)
	var rows [][]string
	for _, v := range versions {
		if filter != "" {
			haystack := strings.ToLower(oderLeer(v.AgentId, "") + " " + v.FilePath + " " +
				oderLeer(v.Reason, "") + " " + oderLeer(v.FeatureTag, ""))
			if !strings.Contains(haystack, filter) {
				continue
			}
		}
		rows = append(rows, []string{
			pgZeitKurz(v.CreatedAt), oderLeer(v.AgentId, "<unbekannt>"), v.FilePath,
			oderLeer(v.EditAction, ""), kuerzeAnzeige(oderLeer(v.Reason, "")), kuerzeAnzeige(oderLeer(v.FeatureTag, "")),
		})
	}
	fyne.Do(func() {
		zeigeAPIStatus(w.EventStatus, err)
		w.EventRows = rows
		w.EventTable.Refresh()
		w.eventAuswahl.nachfuehren(w.EventTable, eventSchluessel(rows))
	})
}

// okText macht aus dem bool-Erfolgsfeld eine anzeigbare Kurzform.
func okText(ok bool) string {
	if ok {
		return "OK"
	}
	return "FEHLER"
}

// dauerText macht aus einer nullable Millisekundenzahl einen anzeigbaren String.
func dauerText(ms *int) string {
	if ms == nil {
		return "-"
	}
	return fmt.Sprintf("%d", *ms)
}

func (w *DetailWindow) ReloadActivity() {
	calls, err := apiFetchToolCalls(w.ProjectName, 50)
	var rows [][]string
	var ids []string
	for _, c := range calls {
		rows = append(rows, []string{
			pgZeitKurz(c.Ts), c.ToolName, oderLeer(c.Action, ""), oderLeer(c.AgentId, "<unbekannt>"),
			okText(c.Ok), dauerText(c.DurationMs), kuerzeAnzeige(oderLeer(c.ResultPreview, "")),
		})
		ids = append(ids, c.Id)
	}
	fyne.Do(func() {
		zeigeAPIStatus(w.ActivityStatus, err)
		w.ActivityRows = rows
		w.ActivityIDs = ids
		w.ActivityTable.Refresh()
		w.aktivitaetAuswahl.nachfuehren(w.ActivityTable, ids)
	})
}

// showActivityDetailWindow oeffnet ein EIGENES Fenster mit dem vollen Inhalt
// eines einzelnen Tool-Call-Eintrags (Argumente + Ergebnis ungekuerzt bis zum
// serverseitigen Cap) — aufgerufen ueber den \"Details\"-Knopf im Aktivitaet-Tab.
// Muss auf dem UI-Faden laufen. Je Tool-Call hoechstens ein Fenster.
func showActivityDetailWindow(projectName, id string) {
	oeffneEinzelFenster("toolcall:"+projectName+":"+id, "Tool-Call: "+id, func(fenster fyne.Window) func() {
		bauActivityDetailFenster(fenster, projectName, id)
		return nil
	})
}

func bauActivityDetailFenster(fenster fyne.Window, projectName, id string) {
	kopf := lesefeld("Wird geladen …", false)

	// Lesefelder statt deaktivierter Eingabefelder: die waren ausgegraut (auf
	// dunklem Grund kaum lesbar) und nicht kopierbar.
	argsBox := lesefeld("", true)
	ergebnisBox := lesefeld("", true)

	split := container.NewVSplit(
		container.NewBorder(widget.NewLabel("Argumente:"), nil, nil, nil, container.NewVScroll(argsBox)),
		container.NewBorder(widget.NewLabel("Ergebnis:"), nil, nil, nil, container.NewVScroll(ergebnisBox)),
	)
	split.Offset = 0.35

	fenster.SetContent(container.NewBorder(
		container.NewVBox(kopf, widget.NewSeparator()),
		nil, nil, nil,
		split,
	))
	fenster.Resize(fyne.NewSize(820, 640))

	go func() {
		detail, err := apiFetchToolCallDetail(projectName, id)
		fyne.Do(func() {
			if err != nil {
				kopf.SetText("Konnte Details nicht laden: " + err.Error())
				return
			}
			fehlerZeile := ""
			if detail.Error != nil && *detail.Error != "" {
				fehlerZeile = "\nFehler: " + *detail.Error
			}
			kopf.SetText(fmt.Sprintf(
				"%s\nTool: %s   Action: %s\nAgent: %s   Status: %s   Dauer: %s ms%s",
				pgZeitKurz(detail.Ts), detail.ToolName, oderLeer(detail.Action, "-"),
				oderLeer(detail.AgentId, "<unbekannt>"), okText(detail.Ok), dauerText(detail.DurationMs), fehlerZeile,
			))
			argsBox.SetText(oderLeer(detail.ArgsPreview, "(keine Argumente aufgezeichnet)"))
			ergebnisText := oderLeer(detail.Result, "(kein Ergebnis gespeichert)")
			if detail.ResultTruncated != nil && *detail.ResultTruncated {
				bytes := 0
				if detail.ResultBytes != nil {
					bytes = *detail.ResultBytes
				}
				ergebnisText += fmt.Sprintf("\n\n… gekuerzt, volle Groesse: %d Bytes", bytes)
			}
			ergebnisBox.SetText(ergebnisText)
		})
	}()
}

func (w *DetailWindow) ReloadStatus() {
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/status", port, url.QueryEscape(w.ProjectName))
	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		fyne.Do(func() {
			w.PathLabel.SetText("-")
			w.ActiveLabel.SetText("? (Daemon nicht erreichbar)")
			w.ChunksLabel.SetText("-")
			w.FilesLabel.SetText("-")
		})
		return
	}
	defer resp.Body.Close()

	var statusMap map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&statusMap); err == nil {
		pfad := "-"
		if v, ok := statusMap["pfad"].(string); ok {
			pfad = v
		}
		active := "nein"
		if v, ok := statusMap["enabled"].(bool); ok && v {
			active = "ja"
		}
		// Chunks und Dateien kommen aus der API, NICHT vom Daemon: dessen
		// /projects/:name/status liefert nur name/pfad/enabled/running. Der Tray
		// las hier frueher statusMap["chunks"]/["files"] — Felder, die es dort nie
		// gab — und zeigte deshalb dauerhaft "-", ununterscheidbar von "Wert ist 0".
		chunks, files := "-", "-"
		if st, statErr := apiFetchStats(w.ProjectName); statErr == nil && st.Success {
			chunks = fmt.Sprintf("%d", st.Stats.Collections.Code.Vectors)
			files = fmt.Sprintf("%d", st.Stats.TotalFiles)
		}

		fyne.Do(func() {
			w.PathLabel.SetText(pfad)
			w.ActiveLabel.SetText(active)
			w.ChunksLabel.SetText(chunks)
			w.FilesLabel.SetText(files)
		})
	}
}

// filterTextWert liefert den Filtertext; aus Goroutinen lesbar (Entry.Text nicht).
func (w *DetailWindow) filterTextWert() string {
	v, _ := w.filterText.Load().(string)
	return v
}

// zeigeTab waehlt den Tab mit diesem Titel (leer = unveraendert). UI-Faden.
func (w *DetailWindow) zeigeTab(titel string) {
	if titel == "" || w.Tabs == nil {
		return
	}
	for _, it := range w.Tabs.Items {
		if it.Text == titel {
			w.Tabs.Select(it)
			return
		}
	}
}

// eventSchluessel: Zeit, Agent, Datei und Aktion kennzeichnen eine Event-Zeile.
func eventSchluessel(rows [][]string) []string { return spaltenSchluessel(rows, 0, 1, 2, 3) }

// OpenEventFile laesst den Daemon die Datei im Editor oeffnen.
func (w *DetailWindow) OpenEventFile(filePath string) {
	if filePath == "" {
		return
	}
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/open-file", port, url.QueryEscape(w.ProjectName))
	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Post(u, "text/plain", strings.NewReader(filePath))
	if err == nil {
		resp.Body.Close()
	}
}

// Chat window implementation
func openChat(projectName, channelName string) {
	key := projectName + "::" + channelName
	chatLock.Lock()
	if w, ok := openChats[key]; ok {
		chatLock.Unlock()
		// P8-T20: sichtbar wieder setzen — sonst blieb die Live-Aktualisierung nach
		// dem Wiederoeffnen aus und der Chat zeigte einen eingefrorenen Stand.
		fyne.Do(func() {
			zeigeVersteckt(w.Window, &w.sichtbar)
			w.Window.Canvas().Focus(w.InputEntry)
		})
		go w.ReloadAll()
		return
	}

	w := &ChatWindow{
		ProjectName: projectName,
		ChannelName: channelName,
	}

	// Nachrichten: scrollbare Liste mehrzeiliger Wrapping-Labels (kein Truncation,
	// kein Überlappen, voller Text immer lesbar — ersetzt die starre Tabelle).
	w.MessageStatus = widget.NewLabel("")
	w.AgentStatus = widget.NewLabel("")
	w.MessageBox = container.NewVBox()
	w.MessageScroll = container.NewVScroll(w.MessageBox)

	w.AgentTable = neueTabelle([]string{"Agent", "Rolle"}, func() [][]string { return w.AgentRows })
	w.AgentTable.SetColumnWidth(0, 140)
	w.AgentTable.SetColumnWidth(1, 170)

	w.InputEntry = widget.NewEntry()
	w.InputEntry.SetPlaceHolder("Nachricht eingeben... (Enter zum Senden)")
	// Text auf dem UI-Faden abnehmen und das Feld sofort leeren: ein zweites Enter
	// sendet so nicht dieselbe Nachricht noch einmal.
	senden := func() {
		text := w.InputEntry.Text
		if strings.TrimSpace(text) == "" {
			return
		}
		w.InputEntry.SetText("")
		go w.SendMessage(text)
	}
	w.InputEntry.OnSubmitted = func(string) { senden() }

	btnSend := widget.NewButton("Senden", senden)
	btnRef := widget.NewButton("Aktualisieren", func() {
		go w.ReloadAll()
	})

	leftSide := container.NewBorder(container.NewVBox(widget.NewLabel("Nachrichten:"), w.MessageStatus), nil, nil, nil, w.MessageScroll)
	rightSide := container.NewBorder(container.NewVBox(widget.NewLabel("Teilnehmer in #"+w.ChannelName+":"), w.AgentStatus), nil, nil, nil, w.AgentTable)

	split := container.NewHSplit(leftSide, rightSide)
	split.Offset = 0.7

	bottomControls := container.NewBorder(
		widget.NewLabel("Nachricht:"),
		nil,
		nil,
		container.NewHBox(btnSend, btnRef),
		w.InputEntry,
	)

	mainContent := container.NewBorder(nil, bottomControls, nil, nil, split)

	openChats[key] = w
	chatLock.Unlock()

	fyne.Do(func() {
		w.Window = myApp.NewWindow("Chat: #" + channelName + " (" + projectName + ")")
		w.Window.Resize(fyne.NewSize(1000, 600))
		versteckbaresFenster(w.Window, &w.sichtbar)
		w.sichtbar.Store(true)
		w.Window.SetContent(mainContent)
		zeigeFyneFenster(w.Window)
		w.Window.Canvas().Focus(w.InputEntry)
	})

	go w.ReloadAll()
}

func (w *ChatWindow) SendMessage(content string) {
	if strings.TrimSpace(content) == "" {
		return
	}
	if err := sendeTrayUserNachricht(w.ProjectName, w.ChannelName, content); err != nil {
		fyne.Do(func() {
			// Text nicht verlieren: zurueck ins Feld, sofern dort nichts Neues steht.
			if w.InputEntry.Text == "" {
				w.InputEntry.SetText(content)
			}
			dialog.ShowError(err, w.Window)
		})
		return
	}
	go w.ReloadMessages()
}

func (w *ChatWindow) ReloadAll() {
	w.ReloadMessages()
	w.ReloadAgents()
}

func (w *ChatWindow) ReloadMessages() {
	if w.loadingMsgs.Swap(true) {
		return
	}
	defer w.loadingMsgs.Store(false)

	firstLoad := w.LastMsgID == 0

	var newMsgs [][]string
	var maxID = w.LastMsgID

	msgs, err := apiFetchChannelMessages(w.ProjectName, w.ChannelName, w.LastMsgID, 50)
	fyne.Do(func() { zeigeAPIStatus(w.MessageStatus, err) })
	if err != nil {
		return
	}
	for _, m := range msgs {
		newMsgs = append(newMsgs, []string{pgZeitKurz(m.CreatedAt), m.Sender, m.Content})
		if m.Id > maxID {
			maxID = m.Id
		}
	}

	if len(newMsgs) > 0 {
		w.LastMsgID = maxID
		fyne.Do(func() {
			// Nur mitscrollen, wenn man ohnehin unten ist — wer weiter oben liest, bleibt dort.
			mitscrollen := firstLoad || nahAmEnde(w.MessageScroll.Offset.Y, w.MessageScroll.Size().Height, w.MessageBox.MinSize().Height)
			if firstLoad {
				w.MessageBox.RemoveAll()
			}
			for _, m := range newMsgs {
				w.MessageBox.Add(makeMsgItem(m[0], m[1], m[2]))
			}
			// Begrenzen: die Liste wuchs vorher unbegrenzt.
			if n := len(w.MessageBox.Objects); n > maxChatNachrichten {
				w.MessageBox.Objects = w.MessageBox.Objects[n-maxChatNachrichten:]
			}
			w.MessageBox.Refresh()
			if mitscrollen {
				w.MessageScroll.ScrollToBottom()
			}
		})
	}
}

// maxChatNachrichten begrenzt die im Chatfenster gehaltenen Nachrichten.
const maxChatNachrichten = 500

// makeMsgItem rendert eine Chat-Nachricht als mehrzeiliges, umbrechendes Element.
// Der Text ist markier- und kopierbar (P8-T20).
func makeMsgItem(timeStr, sender, content string) fyne.CanvasObject {
	header := widget.NewLabelWithStyle("["+timeStr+"]  "+sender, fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
	body := lesefeld(content, false)
	return container.NewVBox(header, body, widget.NewSeparator())
}

func (w *ChatWindow) ReloadAgents() {
	if w.loadingAgs.Swap(true) {
		return
	}
	defer w.loadingAgs.Store(false)

	members, err := apiFetchChannelMembers(w.ProjectName, w.ChannelName)
	var rows [][]string
	for _, m := range members {
		rolle := "nur gepostet"
		if m.Mitglied {
			rolle = "Mitglied"
		}
		if m.Aktiv {
			rolle += " · aktiv"
		}
		label := m.Agent
		if m.IdentityId != "" { label += " [" + m.IdentityId + "]" }
		rows = append(rows, []string{label, rolle})
	}
	fyne.Do(func() {
		zeigeAPIStatus(w.AgentStatus, err)
		w.AgentRows = rows
		w.AgentTable.Refresh()
	})
}

// zeigeAPIStatus laeuft auf dem UI-Faden. Ein Fehler ersetzt keine Datenzeile
// und kann daher nie versehentlich als Agent/Datei/Tool-Call ausgewaehlt werden.
func zeigeAPIStatus(label *widget.Label, err error) {
	if label == nil {
		return
	}
	if err != nil {
		label.SetText("API nicht erreichbar: " + err.Error())
	} else {
		label.SetText("")
	}
}

// trayBeenden beendet den Prozess nach dem Systray-Stop ohne GLFW anzufassen.
// RunWithExternalLoop ruft dies auch bei SIGTERM auf. Ein jemals gezeigtes
// Fenster beweist keinen noch lebenden GLFW-Kontext; App.Quit schliesst auch
// das unsichtbare Ankerfenster und kann dabei NotInitialized ausloesen.
// Es gibt keine Tray-Schreibwarteschlange: Kernel/OS geben Fenster, Sockets
// und den Single-Instance-Lock beim Prozessende frei.
func trayBeenden() {
	os.Exit(0)
}

//go:embed icon.png
var iconPNG []byte

// makeIcon liefert das eingebettete Synapse-Icon. Connected = Originalfarbe (cyan),
// Offline = desaturierte (graue) Variante als Status-Indikator. Alpha bleibt erhalten.
func makeIcon(connected bool) []byte {
	if connected {
		return iconPNG
	}
	src, err := png.Decode(bytes.NewReader(iconPNG))
	if err != nil {
		return iconPNG
	}
	b := src.Bounds()
	dst := image.NewRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := src.At(x, y).RGBA()
			lum := uint8(((r*299 + g*587 + bl*114) / 1000) >> 8)
			dst.Set(x, y, color.RGBA{lum, lum, lum, uint8(a >> 8)})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, dst)
	return buf.Bytes()
}
