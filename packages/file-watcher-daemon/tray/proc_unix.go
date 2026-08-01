//go:build !windows

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// istLokalerGPUHelperProzess schuetzt vor PID-Wiederverwendung: in der PID-Datei kann
// eine Nummer stehen, die inzwischen einem fremden Prozess gehoert — den darf der
// Tray weder als "laeuft schon" zaehlen noch abschiessen. Geprueft wird die
// Kommandozeile, weil der Helfer als "node .../compute-node-agent/dist/index.js"
// laeuft und damit nicht ueber den Programmnamen erkennbar ist.
//
// Wo /proc nicht existiert, ist keine Aussage moeglich; dann gilt der Prozess als
// fremd. Fail closed ist hier richtig: lieber einmal zu viel neu starten als einen
// fremden Prozess zu toeten.
func istLokalerGPUHelperProzess(pid int) bool {
	if pid <= 0 {
		return false
	}
	roh, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	// cmdline trennt die Argumente mit Nullbytes.
	kommando := strings.ReplaceAll(string(roh), "\x00", " ")
	return strings.Contains(kommando, "compute-node-agent")
}

// istEigenerOllama belegt, dass der Prozess auf dem dedizierten Port unser
// eigener ist: seine PID steht in gpu-ollama.pid, er lebt noch, und seine
// Umgebung nennt sowohl den dedizierten Port als auch genau das angeforderte
// Modellverzeichnis. Faellt eine dieser Aussagen aus, gilt der Prozess als
// fremd — lieber einmal zu viel ablehnen als einen fremden Daemon vereinnahmen.
//
// modelDir muss bereits normalisiert sein; verglichen wird gegen die ebenso
// normalisierte Angabe aus der Prozessumgebung.
func istEigenerOllama(pidPath, modelDir string) bool {
	roh, err := os.ReadFile(pidPath)
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(roh)))
	if err != nil || pid <= 0 {
		return false
	}
	umgebung, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return false // Prozess weg oder fremder Eigentuemer
	}
	hostBelegt, zielBelegt := false, false
	for _, feld := range strings.Split(string(umgebung), "\x00") {
		if feld == "OLLAMA_HOST="+gpuOllamaHost {
			hostBelegt = true
			continue
		}
		if strings.HasPrefix(feld, "OLLAMA_MODELS=") {
			if norm, e := normalizeGPUModelDir(strings.TrimPrefix(feld, "OLLAMA_MODELS=")); e == nil && norm == modelDir {
				zielBelegt = true
			}
		}
	}
	return hostBelegt && zielBelegt
}

// prozessBeenden schickt erst SIGTERM und laesst dem Helfer Zeit, seine laufenden
// Embedding-Jobs abzuschliessen und sich abzumelden. Erst wenn er nach fuenf
// Sekunden nicht reagiert, folgt SIGKILL.
func prozessBeenden(pid int) error {
	if pid <= 0 {
		return nil
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		if err == syscall.ESRCH {
			return nil // schon weg
		}
		return err
	}
	for i := 0; i < 20; i++ { // bis zu 5 s
		time.Sleep(250 * time.Millisecond)
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			return nil
		}
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		return err
	}
	return nil
}
