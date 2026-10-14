//go:build linux

package main

// P9-T20: echter Tray-/GLFW-Prozess unter privatem Xvfb + D-Bus.
// API und lokaler Daemon sind httptest-Attrappen; HOME liegt in t.TempDir.
// Kein Dienstneustart, kein echter Tray/Daemon, keine Live-Projekte.
// Aktivierung ausdruecklich: SYNAPSE_TRAY_GUI_TESTS=1.
import (
	"bufio"
	"database/sql"
	"net"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"
)

// Der Basisstand enthaelt dbInit im Produktions-main. Diese Rotkontrolle
// darf daher nur in einem Netz-Namespace mit ausschliesslich Loopback laufen.
func p9t20BasisFehler() error {
	for _, d := range sql.Drivers() {
		if d != "postgres" { continue }
		interfaces, err := net.Interfaces()
		if err != nil { return err }
		for _, i := range interfaces {
			if i.Flags & net.FlagUp != 0 && i.Flags & net.FlagLoopback == 0 {
				return fmt.Errorf("Basis-GUI-Probe braucht isolierten Netz-Namespace (nur Loopback), sonst koennte dbInit die Live-DB kontaktieren")
			}
		}
	}
	return nil
}

func p9t20IsolierteBasis(t *testing.T) {
	t.Helper()
	if err := p9t20BasisFehler(); err != nil { t.Fatal(err) }
}

type p9t20Log struct {
	mu sync.Mutex
	text strings.Builder
}
func (l *p9t20Log) Write(p []byte) (int,error) {
	l.mu.Lock(); defer l.mu.Unlock()
	return l.text.Write(p)
}
func (l *p9t20Log) snapshot() string {
	l.mu.Lock(); defer l.mu.Unlock()
	return l.text.String()
}

func p9t20Bis(t *testing.T,limit time.Duration,probe func()bool,logs *p9t20Log) {
	t.Helper()
	deadline:=time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if probe(){ return }
		time.Sleep(25*time.Millisecond)
	}
	t.Fatalf("Tray-Probe nicht bereit innerhalb %v:\n%s",limit,logs.snapshot())
}

// TestMain laeuft auf der Hauptgoroutine des Testbinary. Normale Testfunktionen
// laufen in testing.tRunner-Goroutinen: LockOSThread bindet nur den OS-Thread,
// macht diese aber NICHT zur Fyne-Hauptgoroutine. Vor der Fyne-Loop wuerde
// SetCloseIntercept deshalb in einer UI-Warteschlange haengen (Job5b498321).
// Der Kindprozess startet hier den unveraenderten PRODUKTIONS-main und dessen
// RunWithExternalLoop-Exitcallback. Alle uebrigen Tests laufen normal ueber m.Run.
func TestMain(m *testing.M) {
	if os.Getenv("SOL14_TRAY_CHILD")!="1" { os.Exit(m.Run()) }
	if err := p9t20BasisFehler(); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(2) }
	runtime.LockOSThread()
	fake:=os.Getenv("SOL14_FAKE_URL")
	apiHttpClient=&http.Client{Timeout:time.Second,Transport:chatTransport(func(r *http.Request)(*http.Response,error){
		if r.URL.Scheme+"://"+r.URL.Host!=fake { return nil,fmt.Errorf("gesperrte Testadresse") }
		return http.DefaultTransport.RoundTrip(r)
	})}
	go func(){
		scanner:=bufio.NewScanner(os.Stdin)
		for scanner.Scan(){
			if scanner.Text()!="window"{ continue }
			fyne.Do(func(){
				w:=myApp.NewWindow("P9-T20 Attrappe")
				w.SetContent(widget.NewLabel("Testfenster"))
				zeigeFyneFenster(w)
				// Show wird auf dem UI-Faden ausgefuehrt; Close erst spaeter,
				// damit tatsaechlich ein GLFW-Fenster initialisiert wurde.
				time.AfterFunc(time.Second,func(){ fyne.Do(func(){
					w.Close()
					time.AfterFunc(time.Second,func(){ fyne.Do(func(){
						for _, current := range myApp.Driver().AllWindows() {
							if current == w { fmt.Println("P9T20_WINDOW_NOT_CLOSED"); return }
						}
						fmt.Println("P9T20_WINDOW_CLOSED")
					}) })
				}) })
			})
		}
	}()
	main()
	os.Exit(9) // unerwartet zurueckgekehrtes main darf nicht als PASS gelten.
}

func TestP9T20SIGTERM(t *testing.T) {
	if os.Getenv("SYNAPSE_TRAY_GUI_TESTS")!="1" { t.Skip("GUI-Probe nur mit SYNAPSE_TRAY_GUI_TESTS=1 unter Xvfb/D-Bus") }
	if os.Getenv("DISPLAY")=="" || os.Getenv("DBUS_SESSION_BUS_ADDRESS")=="" { t.Fatal("privaten Xvfb und D-Bus verwenden") }
	p9t20IsolierteBasis(t)
	for _,scenario:=range []string{"a-direkt","b-menue-60s","c-fenster-geschlossen"} {
		t.Run(scenario,func(t *testing.T){
			started:=time.Now()
			fake:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
				w.Header().Set("Content-Type","application/json")
				switch r.URL.Path {
				case "/events":
					w.Header().Set("Content-Type","text/event-stream")
					w.WriteHeader(200)
					if f,ok:=w.(http.Flusher);ok{ f.Flush() }
					<-r.Context().Done()
				case "/projects":
					// Zustandswechsel nach zwei Sekunden erzwingt mindestens
					// einen echten weiteren rebuildMenu-Durchgang (Fall b).
					if time.Since(started)>2*time.Second {
						fmt.Fprint(w,`{"projekte":[{"name":"sol14-fixture","pfad":"/tmp/sol14-fixture","enabled":false}]}`)
					} else { fmt.Fprint(w,`{"projekte":[]}`) }
				default:
					fmt.Fprint(w,`{"success":true,"workspaces":[],"channels":[],"projects":[]}`)
				}
			}))
			defer fake.Close()
			home:=t.TempDir()
			dir:=filepath.Join(home,".synapse","file-watcher")
			if err:=os.MkdirAll(dir,0700);err!=nil{ t.Fatal(err) }
			if err:=os.WriteFile(filepath.Join(dir,"config.json"),[]byte(fmt.Sprintf(`{"synapse_api_url":%q,"synapse_api_fallback_url":%q,"synapse_api_token":"fixture","projekte":[]}`,fake.URL,fake.URL)),0600);err!=nil{ t.Fatal(err) }
			if err:=os.WriteFile(filepath.Join(dir,"daemon.port"),[]byte(strings.TrimPrefix(fake.URL,"http://127.0.0.1:")),0600);err!=nil{ t.Fatal(err) }
			exe,err:=os.Executable();if err!=nil{ t.Fatal(err) }
			cmd:=exec.Command(exe,"-test.run=^$")
			// Uebernehmen nur fuer Anzeige/D-Bus/Runtime, HOME/API explizit
			// ersetzen. Keine Datenbank-, GPU-, Daemon- oder Service-Konfig.
			for _,v:=range os.Environ(){
				if strings.HasPrefix(v,"HOME=")||strings.HasPrefix(v,"SYNAPSE_")||strings.HasPrefix(v,"DATABASE_URL=")||strings.HasPrefix(v,"SOL14_"){continue}
				cmd.Env=append(cmd.Env,v)
			}
			cmd.Env=append(cmd.Env,"HOME="+home,"SYNAPSE_API_URL="+fake.URL,"SYNAPSE_API_FALLBACK_URL="+fake.URL,"SYNAPSE_API_TOKEN=fixture","SOL14_TRAY_CHILD=1","SOL14_FAKE_URL="+fake.URL)
			logs:=&p9t20Log{}
			cmd.Stdout=logs;cmd.Stderr=logs
			input,err:=cmd.StdinPipe();if err!=nil{t.Fatal(err)}
			defer input.Close()
			if err:=cmd.Start();err!=nil{t.Fatal(err)}
			processStarted:=time.Now()
			done:=make(chan error,1)
			go func(){done<-cmd.Wait()}()
			defer func(){ _=cmd.Process.Kill() }()
			p9t20Bis(t,20*time.Second,func()bool{return strings.Contains(logs.snapshot(),"Menue neu aufgebaut:")},logs)
			switch scenario {
			case "b-menue-60s":
				p9t20Bis(t,70*time.Second,func()bool{return time.Since(processStarted)>=60*time.Second && strings.Count(logs.snapshot(),"Menue neu aufgebaut:")>=2},logs)
			case "c-fenster-geschlossen":
				if _,err:=fmt.Fprintln(input,"window");err!=nil{t.Fatal(err)}
				p9t20Bis(t,20*time.Second,func()bool{return strings.Contains(logs.snapshot(),"P9T20_WINDOW_CLOSED")},logs)
			}
			before:=logs.snapshot()
			t.Logf("SIGTERM %s nach %v; Menue-Aufbauten=%d",scenario,time.Since(processStarted),strings.Count(before,"Menue neu aufgebaut:"))
			if err:=cmd.Process.Signal(syscall.SIGTERM);err!=nil{t.Fatal(err)}
			select {
			case err:=<-done:
				after:=logs.snapshot()
				// Nur den Log-Zuwachs ab Signal pruefen, wie im Task verlangt.
				delta:=after[len(before):]
				if err!=nil || !cmd.ProcessState.Success() {t.Fatalf("Exit muss 0 sein: %v\n%s",err,delta)}
				if strings.Contains(strings.ToLower(delta),"panic"){t.Fatalf("Panic nach SIGTERM:\n%s",delta)}
				t.Logf("Exit=0, panic im Log-Zuwachs=0 (%s)",scenario)
			case <-time.After(10*time.Second):
				t.Fatalf("SIGTERM beendet Tray nicht:\n%s",logs.snapshot())
			}
		})
	}
}
