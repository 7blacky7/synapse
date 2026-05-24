package main

import (
	"bufio"
	"bytes"
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

	"fyne.io/systray"
)

type Project struct {
	Name    string `json:"name"`
	Pfad    string `json:"pfad"`
	Enabled bool   `json:"enabled"`
}

type ProjectsResponse struct {
	Projekte []Project `json:"projekte"`
}

var (
	menuMutex   sync.Mutex
	projects    []Project
	connected   bool
	port        int
	sseActive   atomic.Bool
	refreshChan = make(chan struct{}, 1)
	stopChan    = make(chan struct{})
)

func main() {
	systray.Run(onReady, onExit)
}

func onReady() {
	systray.SetTitle("Synapse FileWatcher")
	systray.SetTooltip("Synapse FileWatcher")

	// Trigger initial refresh
	port = readPort()
	systray.SetIcon(makeIcon(false))

	go runRefreshLoop(stopChan)
	go runPollLoop(stopChan)
	go startSSE(stopChan)

	triggerRefresh()
}

func onExit() {
	close(stopChan)
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
	_, _ = client.Post(u, "application/json", nil)
	triggerRefresh()
}

func deleteProject(name string) {
	u := fmt.Sprintf("http://127.0.0.1:%d/projects/%s", port, url.QueryEscape(name))
	req, err := http.NewRequest("DELETE", u, nil)
	if err == nil {
		client := &http.Client{Timeout: 1 * time.Second}
		_, _ = client.Do(req)
	}
	triggerRefresh()
}

func refresh() {
	menuMutex.Lock()
	defer menuMutex.Unlock()

	port = readPort()

	u := fmt.Sprintf("http://127.0.0.1:%d/projects", port)
	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		connected = false
		projects = nil
	} else {
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			var apiResp ProjectsResponse
			if err := json.NewDecoder(resp.Body).Decode(&apiResp); err == nil {
				connected = true
				projects = apiResp.Projekte
			} else {
				connected = false
				projects = nil
			}
		} else {
			connected = false
			projects = nil
		}
	}

	systray.SetIcon(makeIcon(connected))
	systray.ResetMenu()

	statusText := fmt.Sprintf("Daemon: OFFLINE  (%d)", port)
	if connected {
		statusText = fmt.Sprintf("Daemon: online  (%d)", port)
	}
	_ = systray.AddMenuItem(statusText, "")
	systray.AddSeparator()

	if !connected {
		_ = systray.AddMenuItem(fmt.Sprintf("Daemon starten: %s", getDaemonPath()), "")
	} else if len(projects) == 0 {
		_ = systray.AddMenuItem("keine Projekte registriert", "")
	} else {
		for _, proj := range projects {
			name := proj.Name
			enabled := proj.Enabled

			label := fmt.Sprintf("○  %s", name)
			if enabled {
				label = fmt.Sprintf("●  %s", name)
			}

			projMenu := systray.AddMenuItem(label, "")

			toggleLabel := "aktivieren"
			if enabled {
				toggleLabel = "deaktivieren"
			}
			mToggle := projMenu.AddSubMenuItem(toggleLabel, "")
			mDelete := projMenu.AddSubMenuItem("entfernen", "")

			go func(pName string, curEnabled bool) {
				for range mToggle.ClickedCh {
					toggleProject(pName, curEnabled)
				}
			}(name, enabled)

			go func(pName string) {
				for range mDelete.ClickedCh {
					deleteProject(pName)
				}
			}(name)
		}
	}

	systray.AddSeparator()

	home, _ := os.UserHomeDir()
	configDir := filepath.Join(home, ".synapse", "file-watcher")

	mConfig := systray.AddMenuItem("Config-Ordner oeffnen", "")
	go func() {
		for range mConfig.ClickedCh {
			openConfigDir(configDir)
		}
	}()

	mRefresh := systray.AddMenuItem("jetzt aktualisieren", "")
	go func() {
		for range mRefresh.ClickedCh {
			triggerRefresh()
		}
	}()

	mQuit := systray.AddMenuItem("Tray beenden", "")
	go func() {
		for range mQuit.ClickedCh {
			systray.Quit()
		}
	}()
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
