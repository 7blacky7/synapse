package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
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

// ProjectMenuHandles stores menu items for incremental updates
type ProjectMenuHandles struct {
	SubMenu   *systray.MenuItem
	CheckItem *systray.MenuItem
	Enabled   bool
}

var (
	myApp                  fyne.App
	menuMutex              sync.Mutex
	projects               []Project
	connected              bool
	port                   int
	sseActive              atomic.Bool
	refreshChan            = make(chan struct{}, 1)
	stopChan               = make(chan struct{})
	lastProjectSignature   string
	wasOnline              bool
	projectHandles         = make(map[string]*ProjectMenuHandles)
	statusItem             *systray.MenuItem

	// DB connection
	db                     *sql.DB
	dbErr                  error

	// Window tracking
	openWindows            = make(map[string]*DetailWindow)
	windowLock             sync.Mutex
	openChats              = make(map[string]*ChatWindow)
	chatLock               sync.Mutex
)

// DetailWindow represents the main detail tabs for a project
type DetailWindow struct {
	Window       fyne.Window
	ProjectName  string
	AgentTable   *widget.Table
	AgentRows    [][]string
	EventTable   *widget.Table
	EventRows    [][]string
	FilterEntry  *widget.Entry
	PathLabel    *widget.Label
	ActiveLabel  *widget.Label
	ChunksLabel  *widget.Label
	FilesLabel   *widget.Label
}

// ChatWindow represents the channel chat window
type ChatWindow struct {
	Window       fyne.Window
	ProjectName  string
	ChannelName  string
	MessageTable *widget.Table
	MessageRows  [][]string
	LastMsgID    int64
	AgentTable   *widget.Table
	AgentRows    [][]string
	InputEntry   *widget.Entry
	loadingMsgs  atomic.Bool
	loadingAgs   atomic.Bool
}

func main() {
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

func quitApp() {
	home, _ := os.UserHomeDir()
	stopTrigger := filepath.Join(home, ".synapse", "file-watcher", "stop-requested")
	_ = os.WriteFile(stopTrigger, []byte(""), 0644)
	systray.Quit()
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

func toggleProject(name string, currentlyEnabled bool) {
	action := "enable"
	if currentlyEnabled {
		action = "disable"
	}
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/%s", port, url.QueryEscape(name), action)
	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Post(u, "application/json", nil)
	if err == nil {
		resp.Body.Close()
	}
	triggerRefresh()
}

func getProjectSignature(projs []Project) string {
	var names []string
	for _, p := range projs {
		names = append(names, p.Name)
	}
	// Sign with sorting to keep signature stable
	return strings.Join(names, "|")
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
			check := sm.AddSubMenuItemCheckbox("Aktiv", "", enabled)
			sm.AddSeparator()

			itOeffnen := sm.AddSubMenuItem("Oeffnen...", "")
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
			itLoeschen := sm.AddSubMenuItem("Loeschen...", "")
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

			// Active checkbox handler
			go func(pName string, item *systray.MenuItem) {
				for range item.ClickedCh {
					toggleProject(pName, projectHandles[pName].Enabled)
				}
			}(name, check)
		}
	}

	systray.AddSeparator()
	mReload := systray.AddMenuItem("Neu laden", "")
	go func() {
		for range mReload.ClickedCh {
			triggerRefresh()
		}
	}()
	mQuit := systray.AddMenuItem("Beenden", "")
	go func() {
		for range mQuit.ClickedCh {
			quitApp()
		}
	}()

	lastProjectSignature = getProjectSignature(projs)
	wasOnline = connected
}

func refresh() {
	menuMutex.Lock()
	defer menuMutex.Unlock()

	port = readPort()

	u := fmt.Sprintf("http://127.0.0.1:%d/projects", port)
	client := &http.Client{Timeout: 1 * time.Second}
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

	sig := getProjectSignature(projs)

	// Fall 1: Online status changed OR projects set changed -> Full rebuild
	if connected != wasOnline || sig != lastProjectSignature {
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
					handle.CheckItem.Check()
					handle.SubMenu.SetTitle("●  " + name)
				} else {
					handle.CheckItem.Uncheck()
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

	fyne.Do(func() {
		w.Window = myApp.NewWindow("Projekt: " + name)
		w.Window.Resize(fyne.NewSize(1200, 800))
		w.Window.SetCloseIntercept(func() {
			w.Window.Hide()
		})

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
							resp, err := client.Post(u, "application/json", nil)
							if err == nil {
								resp.Body.Close()
							}
							w.ReloadAgenten()
						}()
					}
				}, w.Window)
			} else {
				dialog.ShowInformation("Stoppen", "Kein Spezialist ausgewaehlt.", w.Window)
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
		btnOpenE := widget.NewButton("Oeffnen", func() {
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
						client := &http.Client{Timeout: 1 * time.Second}
						resp, err := client.Post(u, "application/json", nil)
						if err == nil {
							resp.Body.Close()
						}
						fyne.Do(func() {
							dialog.ShowInformation("Reindex", "Reindex gestartet. Fortschritt im Daemon-Log.", w.Window)
						})
					}()
				}
			}, w.Window)
		})

		btnDelete := widget.NewButton("Projekt loeschen", func() {
			dialog.ShowConfirm("Loeschen?", fmt.Sprintf("Projekt '%s' wirklich loeschen?\nIndex und Watcher-Eintrag werden entfernt.\nDer Ordner auf der Platte bleibt unberuehrt.", name), func(ok bool) {
				if ok {
					go func() {
						u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s/delete", port, url.QueryEscape(name))
						client := &http.Client{Timeout: 1 * time.Second}
						resp, err := client.Post(u, "application/json", nil)
						if err == nil {
							resp.Body.Close()
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

		tabAktionen := container.NewVBox(
			btnReindex,
			btnDelete,
		)

		tabs := container.NewAppTabs(
			container.NewTabItem("Agenten", tabAgenten),
			container.NewTabItem("Events", tabEvents),
			container.NewTabItem("Status", tabStatus),
			container.NewTabItem("Aktionen", tabAktionen),
		)

		w.Window.SetContent(tabs)
		w.Window.Show()
	})
	openWindows[name] = w
	windowLock.Unlock()

	go w.ReloadAll()
}

func (w *DetailWindow) ReloadAll() {
	w.ReloadAgenten()
	w.ReloadEvents()
	w.ReloadStatus()
}

func (w *DetailWindow) ReloadAgenten() {
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

func (w *DetailWindow) ReloadEvents() {
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
			newRows = append(newRows, []string{timeStr, agent, file, action, reason, feature})
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
		chunks := "-"
		if v, ok := statusMap["chunks"].(float64); ok {
			chunks = fmt.Sprintf("%d", int(v))
		}
		files := "-"
		if v, ok := statusMap["files"].(float64); ok {
			files = fmt.Sprintf("%d", int(v))
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

	fyne.Do(func() {
		w.Window = myApp.NewWindow("Chat: #" + channelName + " (" + projectName + ")")
		w.Window.Resize(fyne.NewSize(1000, 600))
		w.Window.SetCloseIntercept(func() {
			w.Window.Hide()
		})

		w.MessageTable = widget.NewTable(
			func() (int, int) { return len(w.MessageRows), 3 },
			func() fyne.CanvasObject { return widget.NewLabel("Template") },
			func(id widget.TableCellID, cell fyne.CanvasObject) {
				label := cell.(*widget.Label)
				if id.Row < len(w.MessageRows) && id.Col < 3 {
					label.SetText(w.MessageRows[id.Row][id.Col])
				}
			},
		)
		w.MessageTable.SetColumnWidth(0, 130)
		w.MessageTable.SetColumnWidth(1, 100)
		w.MessageTable.SetColumnWidth(2, 450)

		w.MessageTable.OnSelected = func(id widget.TableCellID) {
			if id.Row < len(w.MessageRows) {
				msgContent := w.MessageRows[id.Row][2]
				w.Window.Clipboard().SetContent(msgContent)
			}
		}

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

		leftSide := container.NewBorder(widget.NewLabel("Nachrichten:"), nil, nil, nil, w.MessageTable)
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
		w.Window.SetContent(mainContent)
		w.Window.Show()
	})
	openChats[key] = w
	chatLock.Unlock()

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

	var query string
	var args []interface{}

	firstLoad := w.LastMsgID == 0
	if firstLoad {
		query = "SELECT m.id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = $1 AND c.name = $2 ORDER BY m.id DESC LIMIT 50"
		args = []interface{}{w.ProjectName, w.ChannelName}
	} else {
		query = "SELECT m.id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = $1 AND c.name = $2 AND m.id > $3 ORDER BY m.id LIMIT 50"
		args = []interface{}{w.ProjectName, w.ChannelName, w.LastMsgID}
	}

	rows, err := dbQuery(query, args...)
	if err != nil {
		return
	}
	defer rows.Close()

	var newMsgs [][]string
	var maxID = w.LastMsgID
	for rows.Next() {
		var id int64
		var sender, content, timeStr string
		if err := rows.Scan(&id, &sender, &content, &timeStr); err == nil {
			newMsgs = append(newMsgs, []string{timeStr, sender, content})
			if id > maxID {
				maxID = id
			}
		}
	}

	if len(newMsgs) > 0 {
		w.LastMsgID = maxID
		if firstLoad {
			for i, j := 0, len(newMsgs)-1; i < j; i, j = i+1, j-1 {
				newMsgs[i], newMsgs[j] = newMsgs[j], newMsgs[i]
			}
			fyne.Do(func() {
				w.MessageRows = newMsgs
				w.MessageTable.Refresh()
				w.MessageTable.ScrollTo(widget.TableCellID{Row: len(w.MessageRows) - 1, Col: 0})
			})
		} else {
			fyne.Do(func() {
				w.MessageRows = append(w.MessageRows, newMsgs...)
				w.MessageTable.Refresh()
				w.MessageTable.ScrollTo(widget.TableCellID{Row: len(w.MessageRows) - 1, Col: 0})
			})
		}
	}
}

func (w *ChatWindow) ReloadAgents() {
	if w.loadingAgs.Swap(true) {
		return
	}
	defer w.loadingAgs.Store(false)

	rows, err := dbQuery("SELECT id, COALESCE(model, '') FROM agent_sessions WHERE project = $1 AND status = 'active' ORDER BY id", w.ProjectName)
	if err != nil {
		return
	}
	defer rows.Close()

	var newRows [][]string
	for rows.Next() {
		var id, model string
		if err := rows.Scan(&id, &model); err == nil {
			newRows = append(newRows, []string{id, model})
		}
	}
	fyne.Do(func() {
		w.AgentRows = newRows
		w.AgentTable.Refresh()
	})
}

func makeIcon(connected bool) []byte {
	size := 64
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	var outerColor color.RGBA
	if connected {
		outerColor = color.RGBA{76, 175, 80, 255}
	} else {
		outerColor = color.RGBA{84, 84, 84, 255}
	}
	innerColor := color.RGBA{30, 30, 30, 255}

	drawCircle := func(cx, cy, r int, col color.RGBA) {
		for y := -r; y < r; y++ {
			for x := -r; x < r; x++ {
				if x*x+y*y < r*r {
					img.Set(cx+x, cy+y, col)
				}
			}
		}
	}

	drawCircle(size/2, size/2, 28, outerColor)
	drawCircle(size/2, size/2, 12, innerColor)

	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}
