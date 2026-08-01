//go:build windows

package main

import (
	"os"
	"time"
)

// istLokalerGPUHelperProzess kann unter Windows die Kommandozeile eines fremden
// Prozesses nicht ohne Zusatzabfrage lesen. Als Nachweis dient darum, dass die
// PID ueberhaupt noch existiert — dieselbe Ersatzregel, die istTrayProzess dort
// anwendet, wo /proc fehlt.
func istLokalerGPUHelperProzess(pid int) bool {
	if pid <= 0 {
		return false
	}
	_, err := os.FindProcess(pid)
	return err == nil
}

// istEigenerOllama kann unter Windows die Umgebung eines fremden Prozesses nicht
// ohne Zusatzabfrage lesen. Ohne diesen Nachweis bleibt es beim bisherigen
// Verhalten: ein belegter Port fuehrt zur Ablehnung. Fail closed.
func istEigenerOllama(pidPath, modelDir string) bool {
	return false
}

// prozessBeenden kennt unter Windows kein SIGTERM; os.Process.Kill ist der
// einzige verlaessliche Weg. Der Helfer verliert dadurch den gerade laufenden
// Job, was hinnehmbar ist: der Server gibt einen nicht bestaetigten Job wieder
// frei.
func prozessBeenden(pid int) error {
	if pid <= 0 {
		return nil
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return nil // existiert nicht mehr
	}
	if err := p.Kill(); err != nil {
		return err
	}
	for i := 0; i < 20; i++ { // bis zu 5 s
		time.Sleep(250 * time.Millisecond)
		if !istLokalerGPUHelperProzess(pid) {
			return nil
		}
	}
	return nil
}
