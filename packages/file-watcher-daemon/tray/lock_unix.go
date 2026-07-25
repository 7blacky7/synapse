//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// acquireSingleInstanceLock haelt einen flock auf ~/.synapse/file-watcher/tray.lock.
// Der Lock wird vom OS automatisch freigegeben wenn der Prozess endet (auch bei
// Crash oder kill -9).
//
// Es laeuft immer genau EINE Instanz — und ein erneuter Start ersetzt die laufende,
// statt stillschweigend nichts zu tun. Frueher beendete sich die zweite Instanz
// einfach selbst. Ein Doppelklick auf das Desktop-Icon sah dann aus wie "gestartet",
// tatsaechlich lief die alte Binary weiter — nach einem Tray-Update kam der neue
// Stand so nie hoch, ohne dass es irgendwo aufgefallen waere.
//
// Der Vorgaenger wird ueber die PID aus der Lock-Datei gefunden, nicht ueber die
// Prozessliste. Genau daran ist restart-tray.sh gescheitert: es suchte per pkill -f
// den vollen Pfad, der Tray lief aber als "./tray" — kein Treffer, und das Skript
// meldete trotzdem Erfolg.
func acquireSingleInstanceLock() *os.File {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	lockPath := filepath.Join(home, ".synapse", "file-watcher", "tray.lock")
	_ = os.MkdirAll(filepath.Dir(lockPath), 0o755)
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil // Lock nicht anlegbar — lieber ohne Lock starten als gar nicht
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		vorgaenger := lesePidAusLock(f)
		if vorgaenger > 0 && vorgaenger != os.Getpid() && istTrayProzess(vorgaenger) {
			fmt.Fprintf(os.Stderr, "Tray laeuft bereits (PID %d) — wird beendet, diese Instanz uebernimmt.\n", vorgaenger)
			_ = syscall.Kill(vorgaenger, syscall.SIGTERM)
		} else {
			fmt.Fprintln(os.Stderr, "Tray-Lock ist belegt, aber kein passender Vorgaenger feststellbar — warte auf Freigabe.")
			vorgaenger = 0
		}

		// Auf die Freigabe warten: SIGTERM laesst dem Vorgaenger Zeit, sein Menue
		// abzubauen und Verbindungen zu schliessen. Erst danach faellt der Lock.
		uebernommen := false
		for i := 0; i < 40; i++ { // bis zu 10 s
			time.Sleep(250 * time.Millisecond)
			if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
				uebernommen = true
				break
			}
			if i == 20 && vorgaenger > 0 {
				fmt.Fprintf(os.Stderr, "PID %d reagiert nicht auf SIGTERM — SIGKILL.\n", vorgaenger)
				_ = syscall.Kill(vorgaenger, syscall.SIGKILL)
			}
		}
		if !uebernommen {
			fmt.Fprintln(os.Stderr, "Vorgaenger gibt den Lock nicht frei — beende.")
			f.Close()
			os.Exit(1)
		}
	}

	_ = f.Truncate(0)
	_, _ = f.Seek(0, 0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	return f
}

// lesePidAusLock liest die PID, die die laufende Instanz in die Lock-Datei
// geschrieben hat. Liefert 0, wenn dort nichts Brauchbares steht.
func lesePidAusLock(f *os.File) int {
	roh := make([]byte, 32)
	n, _ := f.ReadAt(roh, 0)
	if n <= 0 {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(roh[:n])))
	if err != nil {
		return 0
	}
	return pid
}

// istTrayProzess schuetzt vor PID-Wiederverwendung: in der Lock-Datei koennte eine
// PID stehen, die inzwischen einem fremden Prozess gehoert — den darf der Tray
// nicht abschiessen. Wo /proc nicht existiert (etwa macOS), gilt der gehaltene
// Lock selbst als Nachweis.
func istTrayProzess(pid int) bool {
	ziel, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return true
	}
	if eigen, err := os.Executable(); err == nil && ziel == eigen {
		return true
	}
	return strings.HasSuffix(ziel, "/tray")
}
