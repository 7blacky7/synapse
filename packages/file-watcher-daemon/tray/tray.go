package main

import (
	"bufio"
	"bytes"
	"database/sql"
	_ "embed"
	"encoding/json"
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
	_ "github.com/lib/pq"
)

type Project struct {
	Name    string `json:"name"`
	Pfad    string `json:"pfad"`
	Enabled bool   `json:"enabled"`
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
	workspacesAvailable    bool
	lastWorkspaceSignature string
	nextWorkspacePoll      time.Time

	// Channels: Rebuild-Trigger. Ohne das erscheinen neu angelegte Channels
	// erst nach manuellem "Neu laden", weil getProjectSignature nur Projektnamen
	// hasht (Channels waren im Trigger unsichtbar).
	lastChannelSignature string
	currentChannelSig    string
	nextChannelPoll      time.Time

	// DB connection
	db    *sql.DB
	dbErr error

	// Window tracking
	openWindows = make(map[string]*DetailWindow)
	windowLock  sync.Mutex
	openChats   = make(map[string]*ChatWindow)
	chatLock    sync.Mutex
)

// DetailWindow represents the main detail tabs for a project
type DetailWindow struct {
	Window      fyne.Window
	ProjectName string
	AgentTable  *widget.Table
	AgentRows   [][]string
	EventTable  *widget.Table
	EventRows   [][]string
	FilterEntry *widget.Entry
	PathLabel   *widget.Label
	ActiveLabel *widget.Label
	ChunksLabel *widget.Label
	FilesLabel  *widget.Label
}

// ChatWindow represents the channel chat window
type ChatWindow struct {
	Window        fyne.Window
	ProjectName   string
	ChannelName   string
	MessageBox    *fyne.Container
	MessageScroll *container.Scroll
	LastMsgID     int64
	AgentTable    *widget.Table
	AgentRows     [][]string
	InputEntry    *widget.Entry
	loadingMsgs   atomic.Bool
	loadingAgs    atomic.Bool
}

func main() {
	// Single-Instance: zweite Instanz beendet sich sofort (flock/LockFileEx).
	lockFile := acquireSingleInstanceLock()
	if lockFile != nil {
		defer lockFile.Close()
	}

	myApp = app.New()

	start, end := systray.RunWithExternalLoop(onReady, func() {
		if db != nil {
			db.Close()
		}
		myApp.Quit()
	})

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

	dbInit()

	go runRefreshLoop(stopChan)
	go runPollLoop(stopChan)
	go startSSE(stopChan)
	go runLiveRefreshLoop(stopChan)

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
			// Refresh all open detail windows
			windowLock.Lock()
			for _, w := range openWindows {
				go w.ReloadAll()
			}
			windowLock.Unlock()

			// Refresh all open chat windows
			chatLock.Lock()
			for _, w := range openChats {
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

// DB Helpers
func dbInit() {
	connStr := "postgres://synapse@192.168.50.65:5432/synapse?sslmode=disable"
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		dbErr = err
		return
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(10 * time.Minute)

	err = db.Ping()
	if err != nil {
		dbErr = err
		db.Close()
		db = nil
	} else {
		dbErr = nil
	}
}

func dbQuery(query string, args ...interface{}) (*sql.Rows, error) {
	if db == nil {
		dbInit()
		if db == nil {
			return nil, fmt.Errorf("DB connection failed: %v", dbErr)
		}
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		if db != nil {
			db.Close()
		}
		db = nil
		return nil, err
	}
	return rows, nil
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

func fetchWorkspaces() ([]Workspace, bool) {
	if synapseApiUrl == "" {
		return nil, false
	}
	u := synapseApiUrl + "/api/workspaces"
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, false
	}
	var data WorkspacesResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, false
	}
	return data.Workspaces, true
}

func workspaceAction(project, action string, body string) {
	if synapseApiUrl == "" {
		return
	}
	u := fmt.Sprintf("%s/api/projects/%s/workspace/%s", synapseApiUrl, url.PathEscape(project), action)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(u, "application/json", strings.NewReader(body))
	if err != nil {
		log.Printf("[tray] workspace %s %s FEHLER: %v", action, project, err)
		return
	}
	resp.Body.Close()
	// Poll-Throttle uebersteuern: ohne Reset bliebe der angezeigte Status
	// nach Start/Stop bis zu 30s alt (nextWorkspacePoll liegt in der Zukunft).
	nextWorkspacePoll = time.Time{}
	triggerRefresh()
}

func getWorkspaceSignature(ws []Workspace, available bool) string {
	if !available {
		return "offline"
	}
	parts := make([]string, 0, len(ws))
	for _, w := range ws {
		pin := "u"
		if w.Pinned {
			pin = "p"
		}
		parts = append(parts, w.Project+":"+w.Status+":"+pin)
	}
	return strings.Join(parts, "|")
}

func getProjectSignature(projs []Project) string {
	var names []string
	for _, p := range projs {
		names = append(names, p.Name)
	}
	// Sign with sorting to keep signature stable
	return strings.Join(names, "|")
}

// getChannelSignature holt fuer jedes Projekt die Channel-Liste und baut daraus
// eine Signatur. Aendert sie sich (neuer/geloeschter Channel), loest refresh()
// einen Menue-Rebuild aus — sonst erschienen neue Channels erst nach manuellem
// "Neu laden".
func getChannelSignature(projs []Project, p int) string {
	client := &http.Client{Timeout: 1 * time.Second}
	parts := make([]string, 0, len(projs))
	for _, proj := range projs {
		channelsUrl := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/channels", p, url.QueryEscape(proj.Name))
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

func rebuildMenu(projs []Project) {
	systray.ResetMenu()
	projectHandles = make(map[string]*ProjectMenuHandles)

	statusText := "Daemon: OFFLINE"
	if connected {
		statusText = fmt.Sprintf("Daemon: online  (%d)", port)
	}
	statusItem = systray.AddMenuItem(statusText, "")
	systray.AddSeparator()

	if !connected {
		mStart := systray.AddMenuItem("Daemon starten", "")
		go func() {
			for range mStart.ClickedCh {
				daemonStarten()
			}
		}()
	} else if len(projs) == 0 {
		systray.AddMenuItem("(keine Projekte)", "")
	} else {
		client := &http.Client{Timeout: 1 * time.Second}
		for _, p := range projs {
			name := p.Name
			enabled := p.Enabled

			label := "○  " + name
			if enabled {
				label = "●  " + name
			}

			sm := systray.AddMenuItem(label, "")
			// Reguläres Item statt Checkbox: AddSubMenuItemCheckbox feuert ClickedCh
			// auf KDE/SNI nicht zuverlässig, reguläre Items schon. State steht im Titel.
			check := sm.AddSubMenuItem(toggleLabel(enabled), "")
			sm.AddSeparator()

			itOeffnen := sm.AddSubMenuItem("Öffnen...", "")
			go func(projName string) {
				for range itOeffnen.ClickedCh {
					openDetail(projName)
				}
			}(name)

			// Fetch channels
			channelsUrl := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/channels", port, url.QueryEscape(name))
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

			if len(channels) > 0 {
				sm.AddSeparator()
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
			itLoeschen := sm.AddSubMenuItem("Löschen...", "")
			go func(projName string) {
				for range itLoeschen.ClickedCh {
					openDetail(projName) // Delete is handled in Aktionen tab
				}
			}(name)

			projectHandles[name] = &ProjectMenuHandles{
				SubMenu:   sm,
				CheckItem: check,
				Enabled:   enabled,
			}

			// Active toggle handler
			go func(pName string, item *systray.MenuItem) {
				for range item.ClickedCh {
					toggleProject(pName, projectHandles[pName].Enabled)
				}
			}(name, check)
		}
	}

	// Workspaces-Submenu (synapse-api) — WS-P6
	systray.AddSeparator()
	wsLabel := "Workspaces (offline)"
	if workspacesAvailable {
		running := 0
		for _, w := range workspaces {
			if w.Status == "active" || w.Status == "warming" {
				running++
			}
		}
		wsLabel = fmt.Sprintf("Workspaces  (%d/%d)", running, len(workspaces))
	}
	wsMenu := systray.AddMenuItem(wsLabel, synapseApiUrl)
	if !workspacesAvailable {
		wsMenu.Disable()
	} else if len(workspaces) == 0 {
		wsMenu.AddSubMenuItem("(keine Workspaces)", "")
	} else {
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

	systray.AddSeparator()

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

	mReload := systray.AddMenuItem("Neu laden", "")
	go func() {
		for range mReload.ClickedCh {
			triggerRefresh()
		}
	}()
	// "Deaktivieren" nur wenn der Daemon laeuft — offline zeigt das Menue
	// oben bereits "Daemon starten" (rebuildMenu laeuft bei Statuswechsel neu).
	if connected {
		mDisable := systray.AddMenuItem("Deaktivieren", "Daemon stoppen — Tray laeuft weiter")
		go func() {
			for range mDisable.ClickedCh {
				daemonStoppen()
				triggerRefresh()
			}
		}()
	}
	mQuit := systray.AddMenuItem("Beenden", "Daemon stoppen + Tray beenden")
	go func() {
		for range mQuit.ClickedCh {
			quitApp()
		}
	}()

	lastProjectSignature = getProjectSignature(projs)
	lastWorkspaceSignature = getWorkspaceSignature(workspaces, workspacesAvailable)
	lastChannelSignature = currentChannelSig
	wasOnline = connected
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

	// Workspaces gedrosselt pollen (synapse-api): alle 30s reicht fuers
	// Tray-Menue — refresh() laeuft im 1s/10s-Takt und wuerde sonst die
	// API-Logs fluten. Bei Fehler/nicht verfuegbar: 5min Backoff.
	if time.Now().After(nextWorkspacePoll) {
		ws, wsOK := fetchWorkspaces()
		workspaces = ws
		workspacesAvailable = wsOK
		if wsOK {
			nextWorkspacePoll = time.Now().Add(30 * time.Second)
		} else {
			nextWorkspacePoll = time.Now().Add(5 * time.Minute)
		}
	}
	wsSig := getWorkspaceSignature(workspaces, workspacesAvailable)

	// Channels gedrosselt pollen (alle 5s) — damit neu angelegte Channels einen
	// Rebuild ausloesen, ohne dass refresh() (1s-Takt) die API mit N Calls/s flutet.
	if connected && time.Now().After(nextChannelPoll) {
		currentChannelSig = getChannelSignature(projs, port)
		nextChannelPoll = time.Now().Add(5 * time.Second)
	}

	sig := getProjectSignature(projs)

	// Fall 1: Online-Status ODER Projekt-Set ODER Workspaces ODER Channel-Set
	//         geaendert -> Full rebuild
	if connected != wasOnline || sig != lastProjectSignature || wsSig != lastWorkspaceSignature || currentChannelSig != lastChannelSignature {
		rebuildMenu(projs)
		return
	}

	// Fall 2: Offline remained -> Nothing to do
	if !connected {
		return
	}

	// Fall 3: Incremental updates for active state
	for _, p := range projs {
		name := p.Name
		newEnabled := p.Enabled
		if handle, ok := projectHandles[name]; ok {
			if handle.Enabled != newEnabled {
				handle.Enabled = newEnabled
				if newEnabled {
					handle.CheckItem.SetTitle(toggleLabel(true))
					handle.SubMenu.SetTitle("●  " + name)
				} else {
					handle.CheckItem.SetTitle(toggleLabel(false))
					handle.SubMenu.SetTitle("○  " + name)
				}
			}
		}
	}
}

// Detail window implementation
func openDetail(name string) {
	windowLock.Lock()
	if w, ok := openWindows[name]; ok {
		windowLock.Unlock()
		fyne.Do(func() {
			w.Window.Show()
			w.Window.RequestFocus()
		})
		return
	}

	w := &DetailWindow{
		ProjectName: name,
	}

	// Tab 1: Agenten
	w.AgentTable = widget.NewTable(
		func() (int, int) { return len(w.AgentRows), 5 },
		func() fyne.CanvasObject { return widget.NewLabel("Template") },
		func(id widget.TableCellID, cell fyne.CanvasObject) {
			label := cell.(*widget.Label)
			if id.Row < len(w.AgentRows) && id.Col < 5 {
				label.SetText(w.AgentRows[id.Row][id.Col])
			}
		},
	)
	w.AgentTable.SetColumnWidth(0, 150)
	w.AgentTable.SetColumnWidth(1, 150)
	w.AgentTable.SetColumnWidth(2, 100)
	w.AgentTable.SetColumnWidth(3, 80)
	w.AgentTable.SetColumnWidth(4, 180)

	var selectedAgentRow = -1
	w.AgentTable.OnSelected = func(id widget.TableCellID) {
		selectedAgentRow = id.Row
	}

	btnStop := widget.NewButton("Stoppen", func() {
		if selectedAgentRow >= 0 && selectedAgentRow < len(w.AgentRows) {
			agentName := w.AgentRows[selectedAgentRow][0]
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

	tabAgenten := container.NewBorder(nil, container.NewHBox(btnStop, btnRefA), nil, nil, w.AgentTable)

	// Tab 2: Events
	w.FilterEntry = widget.NewEntry()
	w.FilterEntry.SetPlaceHolder("Substring in Datei/Agent/Reason/Feature...")
	w.FilterEntry.OnChanged = func(text string) {
		go w.ReloadEvents()
	}

	w.EventTable = widget.NewTable(
		func() (int, int) { return len(w.EventRows), 6 },
		func() fyne.CanvasObject { return widget.NewLabel("Template") },
		func(id widget.TableCellID, cell fyne.CanvasObject) {
			label := cell.(*widget.Label)
			if id.Row < len(w.EventRows) && id.Col < 6 {
				label.SetText(w.EventRows[id.Row][id.Col])
			}
		},
	)
	w.EventTable.SetColumnWidth(0, 130)
	w.EventTable.SetColumnWidth(1, 100)
	w.EventTable.SetColumnWidth(2, 350)
	w.EventTable.SetColumnWidth(3, 80)
	w.EventTable.SetColumnWidth(4, 250)
	w.EventTable.SetColumnWidth(5, 120)

	var selectedEventRow = -1
	w.EventTable.OnSelected = func(id widget.TableCellID) {
		selectedEventRow = id.Row
	}

	btnRefE := widget.NewButton("Aktualisieren", func() {
		go w.ReloadEvents()
	})
	btnOpenE := widget.NewButton("Öffnen", func() {
		if selectedEventRow >= 0 && selectedEventRow < len(w.EventRows) {
			go w.OpenSelectedEventFile(selectedEventRow)
		}
	})

	tabEvents := container.NewBorder(
		container.NewBorder(nil, nil, widget.NewLabel("Filter:"), nil, w.FilterEntry),
		container.NewHBox(btnRefE, btnOpenE),
		nil,
		nil,
		w.EventTable,
	)

	// Tab 3: Status
	w.PathLabel = widget.NewLabel("-")
	w.ActiveLabel = widget.NewLabel("-")
	w.ChunksLabel = widget.NewLabel("-")
	w.FilesLabel = widget.NewLabel("-")

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
	btnReindex := widget.NewButton("Neu indexieren", func() {
		dialog.ShowConfirm("Neu indexieren?", fmt.Sprintf("Projekt '%s' komplett neu indexieren?", name), func(ok bool) {
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
					fyne.Do(func() {
						w.Window.Hide()
					})
					windowLock.Lock()
					delete(openWindows, name)
					windowLock.Unlock()
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
		btnReindex,
		btnReembed,
		btnDelete,
	)

	tabs := container.NewAppTabs(
		container.NewTabItem("Agenten", tabAgenten),
		container.NewTabItem("Events", tabEvents),
		container.NewTabItem("Status", tabStatus),
		container.NewTabItem("Aktionen", tabAktionen),
	)

	openWindows[name] = w
	windowLock.Unlock()

	fyne.Do(func() {
		w.Window = myApp.NewWindow("Projekt: " + name)
		w.Window.Resize(fyne.NewSize(1200, 800))
		w.Window.SetCloseIntercept(func() {
			w.Window.Hide()
		})
		w.Window.SetContent(tabs)
		w.Window.Show()
	})

	go w.ReloadAll()
}

// zeigeVerbindungsFenster oeffnet die Verbindungs-Einrichtung (TRAY-3).
//
// Der Nutzer tippt den 6-stelligen Code aus seiner Authenticator-App ein, der
// Tray holt sich damit selbst ein Token (6 Monate gueltig) und schreibt es in
// die config.json. Kein Terminal, kein curl, kein Datei-Editieren.
func zeigeVerbindungsFenster() {
	fenster := myApp.NewWindow("Synapse-Verbindung")

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

	fenster.SetContent(container.NewVBox(
		status,
		widget.NewSeparator(),
		hinweis,
		codeFeld,
		knopf,
		ergebnis,
	))
	fenster.Resize(fyne.NewSize(460, 340))
	fenster.Show()
}

func (w *DetailWindow) ReloadAll() {
	w.ReloadAgenten()
	w.ReloadEvents()
	w.ReloadStatus()
}

func (w *DetailWindow) ReloadAgenten() {
	// TRAY-2: API zuerst. Der PG-Zweig darunter bleibt vorerst als LETZTER
	// Fallback stehen, damit der Tray auch gegen eine Instanz laeuft, auf der
	// die neuen Endpunkte noch nicht deployed sind. Entfaellt sobald TRAY-1 ueberall live ist.
	if agents, apiErr := apiFetchAgents(w.ProjectName); apiErr == nil {
		var apiRows [][]string
		for _, a := range agents {
			apiRows = append(apiRows, []string{a.AgentName, a.Model, a.Status, a.TokensPercent + "%", a.LastActivity})
		}
		fyne.Do(func() {
			w.AgentRows = apiRows
			w.AgentTable.Refresh()
		})
		return
	}

	rows, err := dbQuery("SELECT agent_name, COALESCE(model, ''), status, COALESCE(tokens_percent::text, '0'), COALESCE(last_activity::text, '') FROM wrapper_status WHERE project = $1 ORDER BY last_activity DESC NULLS LAST", w.ProjectName)
	if err != nil {
		return
	}
	defer rows.Close()

	var newRows [][]string
	for rows.Next() {
		var agentName, model, status, tokens, lastAct string
		if err := rows.Scan(&agentName, &model, &status, &tokens, &lastAct); err == nil {
			newRows = append(newRows, []string{agentName, model, status, tokens + "%", lastAct})
		}
	}
	fyne.Do(func() {
		w.AgentRows = newRows
		w.AgentTable.Refresh()
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
	filter := strings.ToLower(w.FilterEntry.Text)

	// TRAY-2: API zuerst, PG als letzter Fallback (siehe ReloadAgenten).
	if versions, apiErr := apiFetchFileVersions(w.ProjectName, 50); apiErr == nil {
		var apiRows [][]string
		for _, v := range versions {
			if filter != "" {
				haystack := strings.ToLower(oderLeer(v.AgentId, "") + " " + v.FilePath + " " +
					oderLeer(v.Reason, "") + " " + oderLeer(v.FeatureTag, ""))
				if !strings.Contains(haystack, filter) {
					continue
				}
			}
			apiRows = append(apiRows, []string{
				pgZeitKurz(v.CreatedAt), oderLeer(v.AgentId, "<unbekannt>"), v.FilePath,
				oderLeer(v.EditAction, ""),
				kuerzeAnzeige(oderLeer(v.Reason, "")), kuerzeAnzeige(oderLeer(v.FeatureTag, "")),
			})
		}
		fyne.Do(func() {
			w.EventRows = apiRows
			w.EventTable.Refresh()
		})
		return
	}

	rows, err := dbQuery("SELECT COALESCE(agent_id, '<unbekannt>'), COALESCE(file_path, ''), COALESCE(edit_action, ''), COALESCE(reason, ''), COALESCE(feature_tag, ''), to_char(created_at, 'DD.MM. HH24:MI:SS') FROM file_versions WHERE project = $1 ORDER BY id DESC LIMIT 50", w.ProjectName)
	if err != nil {
		return
	}
	defer rows.Close()

	filterText := strings.ToLower(w.FilterEntry.Text)

	var newRows [][]string
	for rows.Next() {
		var agent, file, action, reason, feature, timeStr string
		if err := rows.Scan(&agent, &file, &action, &reason, &feature, &timeStr); err == nil {
			if filterText != "" {
				haystack := strings.ToLower(agent + " " + file + " " + reason + " " + feature)
				if !strings.Contains(haystack, filterText) {
					continue
				}
			}

			// Sanitize reason and feature (Bug 5)
			reasonDisplay := strings.ReplaceAll(reason, "\n", " ")
			reasonDisplay = strings.ReplaceAll(reasonDisplay, "\r", " ")
			rReason := []rune(reasonDisplay)
			if len(rReason) > 200 {
				reasonDisplay = string(rReason[:200]) + "…"
			}

			featureDisplay := strings.ReplaceAll(feature, "\n", " ")
			featureDisplay = strings.ReplaceAll(featureDisplay, "\r", " ")
			rFeature := []rune(featureDisplay)
			if len(rFeature) > 200 {
				featureDisplay = string(rFeature[:200]) + "…"
			}

			newRows = append(newRows, []string{timeStr, agent, file, action, reasonDisplay, featureDisplay})
		}
	}
	fyne.Do(func() {
		w.EventRows = newRows
		w.EventTable.Refresh()
	})
}

func (w *DetailWindow) ReloadStatus() {
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/status", port, url.QueryEscape(w.ProjectName))
	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		fyne.Do(func() {
			w.PathLabel.SetText("-")
			w.ActiveLabel.SetText("-")
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

func (w *DetailWindow) OpenSelectedEventFile(rowIdx int) {
	if rowIdx < 0 || rowIdx >= len(w.EventRows) {
		return
	}
	filePath := w.EventRows[rowIdx][2]
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
		fyne.Do(func() {
			w.Window.Show()
			w.Window.RequestFocus()
		})
		return
	}

	w := &ChatWindow{
		ProjectName: projectName,
		ChannelName: channelName,
	}

	// Nachrichten: scrollbare Liste mehrzeiliger Wrapping-Labels (kein Truncation,
	// kein Überlappen, voller Text immer lesbar — ersetzt die starre Tabelle).
	w.MessageBox = container.NewVBox()
	w.MessageScroll = container.NewVScroll(w.MessageBox)

	w.AgentTable = widget.NewTable(
		func() (int, int) { return len(w.AgentRows), 2 },
		func() fyne.CanvasObject { return widget.NewLabel("Template") },
		func(id widget.TableCellID, cell fyne.CanvasObject) {
			label := cell.(*widget.Label)
			if id.Row < len(w.AgentRows) && id.Col < 2 {
				label.SetText(w.AgentRows[id.Row][id.Col])
			}
		},
	)
	w.AgentTable.SetColumnWidth(0, 120)
	w.AgentTable.SetColumnWidth(1, 150)

	w.InputEntry = widget.NewEntry()
	w.InputEntry.SetPlaceHolder("Nachricht eingeben... (Enter zum Senden)")
	w.InputEntry.OnSubmitted = func(text string) {
		go w.SendMessage()
	}

	btnSend := widget.NewButton("Senden", func() {
		go w.SendMessage()
	})
	btnRef := widget.NewButton("Aktualisieren", func() {
		go w.ReloadAll()
	})

	leftSide := container.NewBorder(widget.NewLabel("Nachrichten:"), nil, nil, nil, w.MessageScroll)
	rightSide := container.NewBorder(widget.NewLabel("Agenten im Projekt:"), nil, nil, nil, w.AgentTable)

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
		w.Window.SetCloseIntercept(func() {
			w.Window.Hide()
		})
		w.Window.SetContent(mainContent)
		w.Window.Show()
	})

	go w.ReloadAll()
}

func (w *ChatWindow) SendMessage() {
	content := w.InputEntry.Text
	if strings.TrimSpace(content) == "" {
		return
	}

	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/channels/%s/post", port, url.QueryEscape(w.ProjectName), url.QueryEscape(w.ChannelName))

	payload := map[string]string{
		"sender":  "synapse-tray",
		"content": content,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return
	}

	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Post(u, "application/json", bytes.NewReader(payloadBytes))
	if err == nil {
		resp.Body.Close()
		fyne.Do(func() {
			w.InputEntry.SetText("")
		})
		go w.ReloadMessages()
	}
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

	// TRAY-6: API zuerst. apiFetchChannelMessages liefert IMMER aufsteigend —
	// das Umdrehen beim Erst-Laden ist deshalb allein Sache des PG-Zweigs.
	if msgs, err := apiFetchChannelMessages(w.ProjectName, w.ChannelName, w.LastMsgID, 50); err == nil {
		for _, m := range msgs {
			// Voller Inhalt inkl. Zeilenumbrüche — Wrapping-Label rendert das sauber.
			newMsgs = append(newMsgs, []string{m.CreatedAt, m.Sender, m.Content})
			if m.Id > maxID {
				maxID = m.Id
			}
		}
	} else {
		// Rueckfallebene: direkt an PostgreSQL, wie vor der Umstellung.
		var query string
		var args []interface{}
		if firstLoad {
			query = "SELECT m.id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = $1 AND c.name = $2 ORDER BY m.id DESC LIMIT 50"
			args = []interface{}{w.ProjectName, w.ChannelName}
		} else {
			query = "SELECT m.id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = $1 AND c.name = $2 AND m.id > $3 ORDER BY m.id LIMIT 50"
			args = []interface{}{w.ProjectName, w.ChannelName, w.LastMsgID}
		}

		rows, dbErr := dbQuery(query, args...)
		if dbErr != nil {
			return
		}
		defer rows.Close()

		for rows.Next() {
			var id int64
			var sender, content, timeStr string
			if scanErr := rows.Scan(&id, &sender, &content, &timeStr); scanErr == nil {
				newMsgs = append(newMsgs, []string{timeStr, sender, content})
				if id > maxID {
					maxID = id
				}
			}
		}

		// Nur dieser Weg liefert beim Erst-Laden absteigend.
		if firstLoad {
			for i, j := 0, len(newMsgs)-1; i < j; i, j = i+1, j-1 {
				newMsgs[i], newMsgs[j] = newMsgs[j], newMsgs[i]
			}
		}
	}

	if len(newMsgs) > 0 {
		w.LastMsgID = maxID
		fyne.Do(func() {
			if firstLoad {
				w.MessageBox.RemoveAll()
			}
			for _, m := range newMsgs {
				w.MessageBox.Add(makeMsgItem(m[0], m[1], m[2]))
			}
			w.MessageBox.Refresh()
			w.MessageScroll.ScrollToBottom()
		})
	}
}

// makeMsgItem rendert eine Chat-Nachricht als mehrzeiliges, umbrechendes Element.
func makeMsgItem(timeStr, sender, content string) fyne.CanvasObject {
	header := widget.NewLabelWithStyle("["+timeStr+"]  "+sender, fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
	body := widget.NewLabel(content)
	body.Wrapping = fyne.TextWrapWord
	return container.NewVBox(header, body, widget.NewSeparator())
}

func (w *ChatWindow) ReloadAgents() {
	if w.loadingAgs.Swap(true) {
		return
	}
	defer w.loadingAgs.Store(false)

	// TRAY-6: API zuerst, PostgreSQL nur noch als Rueckfallebene.
	var newRows [][]string
	if sessions, err := apiFetchSessions(w.ProjectName); err == nil {
		for _, s := range sessions {
			newRows = append(newRows, []string{s.Id, s.Model})
		}
	} else {
		rows, dbErr := dbQuery("SELECT id, COALESCE(model, '') FROM agent_sessions WHERE project = $1 AND status = 'active' ORDER BY id", w.ProjectName)
		if dbErr != nil {
			return
		}
		defer rows.Close()

		for rows.Next() {
			var id, model string
			if scanErr := rows.Scan(&id, &model); scanErr == nil {
				newRows = append(newRows, []string{id, model})
			}
		}
	}
	fyne.Do(func() {
		w.AgentRows = newRows
		w.AgentTable.Refresh()
	})
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
