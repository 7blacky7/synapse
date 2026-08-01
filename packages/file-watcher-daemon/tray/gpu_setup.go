package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	gpuRequiredTotalMB = 12000
	gpuRequiredFreeMB  = 7300
	gpuOllamaHost      = "127.0.0.1:11435"
	gpuOllamaURL       = "http://" + gpuOllamaHost
	// Standard-Ollama des Nutzers. Wird NUR gelesen, nie gesteuert: liegt das Modell
	// dort bereits mit passendem Digest, waere ein erneuter 4,7-GB-Pull sinnlos.
	standardOllamaURL = "http://127.0.0.1:11434"
)

type gpuHardware struct {
	Name            string
	TotalMB, FreeMB int
}

type ollamaTag struct {
	Name    string `json:"name"`
	Model   string `json:"model"`
	Digest  string `json:"digest"`
	Details struct {
		ParameterSize     string `json:"parameter_size"`
		QuantizationLevel string `json:"quantization_level"`
	} `json:"details"`
}

type gpuNodeConfig struct {
	NodeID       string `json:"node_id"`
	ComputeToken string `json:"compute_token"`
	Issuer       string `json:"issuer"`
	ModelDir     string `json:"model_dir"`
	GPUIndex     int    `json:"gpu_index"`
}

func gpuHardwareSuitable(h gpuHardware, requiredTotal, requiredFree int) bool {
	return h.TotalMB >= requiredTotal && h.FreeMB >= requiredFree
}

// belegtVomEigenenModell liefert den VRAM in MB, den das eigene Modell bereits
// belegt.
//
// ⚠️ OHNE DIESE ZAHL SPERRT SICH DER KNOPF SELBST AUS. Die Pruefung fragt
// "sind N MB frei?", aber sobald qwen geladen ist, belegt es genau diese N MB.
// Wer den Agenten beendet und gleich wieder starten will, bekommt dann
// "gemessen 12282 MB gesamt / 2045 MB frei" — bis Ollama nach fuenf Minuten
// Leerlauf entlaedt. Gemessen am 01.08.2026, derselbe Fall wie im Agenten
// (probe.ts) und dieselbe Bauart wie die fuenf Fehler vom Vortag: eine
// Bedingung, die im Betrieb etwas anderes bedeutet als im Test.
//
// Gezaehlt wird, was in UNSERER EIGENEN Ollama-Instanz liegt (der dedizierten
// auf gpuOllamaHost). Modelle im System-Ollama oder in fremden Prozessen sind
// fremder Speicher und duerfen weiter blockieren. Faellt die Abfrage aus, gilt
// 0 — lieber einmal zu viel ablehnen als zu viel zulassen.
func belegtVomEigenenModell(ollamaURL string) int {
	if ollamaURL == "" {
		return 0
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(strings.TrimSuffix(ollamaURL, "/") + "/api/ps")
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0
	}
	var daten struct {
		Models []struct {
			Name     string `json:"name"`
			Model    string `json:"model"`
			SizeVRAM int64  `json:"size_vram"`
		} `json:"models"`
	}
	if json.NewDecoder(resp.Body).Decode(&daten) != nil {
		return 0
	}
	summe := int64(0)
	for _, eintrag := range daten.Models {
		summe += eintrag.SizeVRAM
	}
	return int(summe / (1024 * 1024))
}

func detectAllGPUHardware() ([]gpuHardware, error) {
	out, err := exec.Command("nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil, errors.New("Hardware passt nicht / nicht möglich: NVIDIA-GPU nicht messbar")
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	result := make([]gpuHardware, 0, len(lines))
	for _, line := range lines {
		parts := strings.Split(line, ",")
		if len(parts) != 3 {
			return nil, errors.New("Hardware passt nicht / nicht möglich: VRAM-Antwort unlesbar")
		}
		total, e1 := strconv.Atoi(strings.TrimSpace(parts[1]))
		free, e2 := strconv.Atoi(strings.TrimSpace(parts[2]))
		if e1 != nil || e2 != nil {
			return nil, errors.New("Hardware passt nicht / nicht möglich: VRAM nicht messbar")
		}
		result = append(result, gpuHardware{Name: strings.TrimSpace(parts[0]), TotalMB: total, FreeMB: free})
	}
	if len(result) == 0 {
		return nil, errors.New("Hardware passt nicht / nicht möglich: keine NVIDIA-GPU")
	}
	return result, nil
}
func detectGPUHardware(index, requiredTotal, requiredFree int) (gpuHardware, error) {
	all, err := detectAllGPUHardware()
	if err != nil {
		return gpuHardware{}, err
	}
	if index < 0 || index >= len(all) {
		return gpuHardware{}, errors.New("Hardware passt nicht / nicht möglich: gewählte GPU existiert nicht")
	}
	h := all[index]
	// Der Speicher des eigenen, bereits geladenen Modells zaehlt als verfuegbar
	// (siehe belegtVomEigenenModell). Gemeldet wird weiter der echte Messwert,
	// damit die Anzeige nicht luegt — nur die Entscheidung rechnet ihn hinzu.
	eigen := belegtVomEigenenModell(gpuOllamaURL)
	geprueft := h
	geprueft.FreeMB += eigen
	if !gpuHardwareSuitable(geprueft, requiredTotal, requiredFree) {
		hinweis := ""
		if eigen > 0 {
			hinweis = fmt.Sprintf(" (+%d MB bereits vom eigenen Modell belegt)", eigen)
		}
		return h, fmt.Errorf("Hardware passt nicht / nicht möglich: mindestens %d MB gesamt und %d MB frei erforderlich; gemessen %d MB gesamt / %d MB frei%s", requiredTotal, requiredFree, h.TotalMB, h.FreeMB, hinweis)
	}
	return h, nil
}

func normalizeGPUModelDigest(s string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "sha256:")
}
func gpuDigestsMatch(a, b string) bool {
	a, b = normalizeGPUModelDigest(a), normalizeGPUModelDigest(b)
	return len(a) == 64 && len(b) == 64 && a == b
}
func ptrText(v *string) string {
	if v == nil || *v == "" {
		return "(nicht konfiguriert)"
	}
	return *v
}
func platformDownload(d apiEmbeddingDownload) string {
	switch runtimeGOOS() {
	case "windows":
		return d.Windows
	case "darwin":
		return d.MacOS
	default:
		return d.Linux
	}
}

const gpuDiskReserveBytes uint64 = 1 << 30

var (
	runtimeGOOS        = func() string { return runtime.GOOS }
	gpuOllamaMu        sync.Mutex
	lokalerGPUHelperMu sync.Mutex
	gpuOllamaOwned     bool
	gpuOwnedModelDir   string
	gpuOwnedGPUIndex   int
)

func normalizeGPUModelDir(modelDir string) (string, error) {
	if strings.TrimSpace(modelDir) == "" {
		return "", errors.New("Modell-Zielpfad ist leer")
	}
	absolute, err := filepath.Abs(filepath.Clean(modelDir))
	if err != nil {
		return "", err
	}
	return filepath.Clean(absolute), nil
}

func sameOwnedOllamaTarget(ownedDir string, ownedIndex int, requestedDir string, requestedIndex int) bool {
	if ownedIndex != requestedIndex {
		return false
	}
	owned, errOwned := normalizeGPUModelDir(ownedDir)
	requested, errRequested := normalizeGPUModelDir(requestedDir)
	if errOwned != nil || errRequested != nil {
		return false
	}
	if runtimeGOOS() == "windows" {
		return strings.EqualFold(owned, requested)
	}
	return owned == requested
}

func requiredGPUModelDiskBytes(modelSizeGb float64) (uint64, error) {
	if modelSizeGb <= 0 {
		return 0, errors.New("Downloadgroesse ist nicht konfiguriert; Speicherpruefung fail-closed")
	}
	return uint64(math.Ceil(modelSizeGb*1_000_000_000)) + gpuDiskReserveBytes, nil
}

func ensureGPUModelDiskSpace(path string, modelSizeGb float64) error {
	required, err := requiredGPUModelDiskBytes(modelSizeGb)
	if err != nil {
		return err
	}
	free, err := freeDiskBytes(path)
	if err != nil {
		return fmt.Errorf("Freier Speicher am Modell-Zielpfad ist nicht messbar: %w", err)
	}
	if free < required {
		return fmt.Errorf("Zu wenig freier Speicher am Modell-Zielpfad: mindestens %.2f GB inklusive Reserve erforderlich, %.2f GB gemessen", float64(required)/1_000_000_000, float64(free)/1_000_000_000)
	}
	return nil
}

func gpuComparisonText(ref apiEmbeddingReferenceResponse, local *ollamaTag, hardware *gpuHardware) string {
	localModel, localDigest, localQuant := "(nicht vorhanden)", "(nicht vorhanden)", "(nicht vorhanden)"
	if local != nil {
		localModel = local.Name
		if localModel == "" {
			localModel = local.Model
		}
		localDigest = normalizeGPUModelDigest(local.Digest)
		localQuant = local.Details.QuantizationLevel
	}
	apiDigest := "(nicht konfiguriert)"
	if ref.Reference.ModelDigest != nil {
		apiDigest = normalizeGPUModelDigest(*ref.Reference.ModelDigest)
	}
	hw := "noch nicht geprüft"
	if hardware != nil {
		hw = fmt.Sprintf("%s — %d MB gesamt / %d MB frei", hardware.Name, hardware.TotalMB, hardware.FreeMB)
	}
	return fmt.Sprintf("API-Modell: %s\nAPI-Digest (voll): %s\nLokales Modell: %s\nLokaler Digest (voll): %s\nDigests gleich: %t\n\nAPI-Zieldimension: %d\nAPI-Native-Dimension: %d\nAPI-Quantisierung: %s\nLokal-Quantisierung: %s\nAPI-num_ctx: %d\nMindest-VRAM: %d MB gesamt / %d MB frei\n\nOllama-Download: %s\nModell-Download: %s\nDownloadgröße: %.1f GB\n\nHardware: %s", ref.Reference.Model, apiDigest, localModel, localDigest, gpuDigestsMatch(apiDigest, localDigest), ref.Reference.TargetDimension, ref.Reference.NativeDimension, ptrText(ref.Reference.Quantization), localQuant, ref.Reference.NumCtx, ref.Reference.RequiredTotalVramMb, ref.Reference.RequiredFreeVramMb, platformDownload(ref.Download), ref.Download.Model, ref.Download.ModelSizeGb, hw)
}

// ermittleModellVerzeichnis sucht den Ort, an dem die Ollama-Modelle wirklich
// liegen, statt einen Pfad zu raten.
//
// WARUM: am 01.08.2026 zeigte die Vorgabe auf ~/.ollama/models, waehrend Ollama
// auf diesem Rechner als SYSTEMDIENST laeuft und /usr/share/ollama/.ollama/models
// benutzt. qwen3-embedding:8b lag dort, im Benutzerverzeichnis lagen nur zwei
// alte Modelle. Das dedizierte Ollama startete damit auf ein Verzeichnis ohne
// das gesuchte Modell — und haette es erneut geladen.
//
// Reihenfolge: OLLAMA_MODELS aus der Umgebung, dann die beiden ueblichen Orte.
// Genommen wird der ERSTE, der lesbar ist UND das Modell enthaelt; gibt es keinen
// solchen, der erste lesbare; sonst das Benutzerverzeichnis als letzte Vorgabe.
func ermittleModellVerzeichnis(modell string) string {
	home, _ := os.UserHomeDir()
	kandidaten := []string{
		os.Getenv("OLLAMA_MODELS"),
		"/usr/share/ollama/.ollama/models",
		filepath.Join(home, ".ollama", "models"),
	}
	// Modellname bis zum Doppelpunkt ist der Verzeichnisname im Manifestbaum.
	kurz := modell
	if i := strings.IndexByte(kurz, ':'); i > 0 {
		kurz = kurz[:i]
	}
	ersterLesbare := ""
	for _, k := range kandidaten {
		if strings.TrimSpace(k) == "" {
			continue
		}
		if _, err := os.Stat(k); err != nil {
			continue
		}
		if ersterLesbare == "" {
			ersterLesbare = k
		}
		if kurz != "" {
			p := filepath.Join(k, "manifests", "registry.ollama.ai", "library", kurz)
			if _, err := os.Stat(p); err == nil {
				return k
			}
		}
	}
	if ersterLesbare != "" {
		return ersterLesbare
	}
	return filepath.Join(home, ".ollama", "models")
}

func gpuConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".synapse", "file-watcher", "gpu-node.json")
}
func loadGPUNodeConfig() gpuNodeConfig {
	var c gpuNodeConfig
	if b, e := os.ReadFile(gpuConfigPath()); e == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}
func saveGPUNodeConfig(c gpuNodeConfig) error {
	p := gpuConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err = os.WriteFile(tmp, append(b, '\n'), 0600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
func defaultGPUNodeID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("gpu-%d", time.Now().UnixNano())
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("gpu-%s-%s-%s-%s-%s",
		hex.EncodeToString(raw[0:4]), hex.EncodeToString(raw[4:6]),
		hex.EncodeToString(raw[6:8]), hex.EncodeToString(raw[8:10]),
		hex.EncodeToString(raw[10:16]))
}

// ollamaTagVon fragt genau EINE Ollama-Instanz nach einem Modell.
// Rueckgabe (nil, nil) heisst: Instanz antwortet, kennt das Modell aber nicht.
func ollamaTagVon(baseURL, model string) (*ollamaTag, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(baseURL + "/api/tags")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var p struct {
		Models []ollamaTag `json:"models"`
	}
	if err = json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return nil, err
	}
	for i := range p.Models {
		if p.Models[i].Name == model || p.Models[i].Model == model {
			return &p.Models[i], nil
		}
	}
	return nil, nil
}

// localOllamaTag sucht das Modell zuerst in der dedizierten Instanz (Port 11435,
// an Modellverzeichnis und GPU gebunden) und danach im Standard-Ollama des
// Nutzers (Port 11434).
//
// WARUM DER ZWEITE BLICK: gemessen am 01.08.2026 lag qwen3-embedding:8b mit dem
// IDENTISCHEN Digest (64b93349...) auf 127.0.0.1:11434, waehrend auf 11435 nichts
// lief. Der Tray meldete daraufhin "nicht vorhanden" und haette 4,7 GB erneut
// geladen, die bereits auf der Platte lagen.
// Der Fund im Standard-Ollama ist KEINE Freigabe: das Digest-Gate entscheidet
// weiterhin allein ueber die Verwendbarkeit, und die Ownership bleibt an die
// dedizierte Instanz gebunden. Es geht ausschliesslich darum, Vorhandenes nicht
// als fehlend auszugeben.
func localOllamaTag(model string) (*ollamaTag, error) {
	tag, err := ollamaTagVon(gpuOllamaURL, model)
	if err == nil && tag != nil {
		return tag, nil
	}
	ersterFehler := err
	if tag2, err2 := ollamaTagVon(standardOllamaURL, model); err2 == nil && tag2 != nil {
		return tag2, nil
	}
	// Nichts gefunden. Ein Fehler der dedizierten Instanz wird nur dann gemeldet,
	// wenn auch das Standard-Ollama nichts beitragen konnte — sonst waere "Port
	// 11435 antwortet nicht" eine irrefuehrende Fehlermeldung fuer den Normalfall.
	if ersterFehler != nil {
		if _, err2 := ollamaTagVon(standardOllamaURL, model); err2 != nil {
			return nil, ersterFehler
		}
	}
	return nil, nil
}

func startDedicatedOllama(modelDir string, gpuIndex int) error {
	normalizedModelDir, err := normalizeGPUModelDir(modelDir)
	if err != nil {
		return fmt.Errorf("Modell-Zielpfad ist nicht normalisierbar: %w", err)
	}
	gpuOllamaMu.Lock()
	defer gpuOllamaMu.Unlock()
	if gpuOllamaOwned {
		if sameOwnedOllamaTarget(gpuOwnedModelDir, gpuOwnedGPUIndex, normalizedModelDir, gpuIndex) {
			return nil
		}
		return fmt.Errorf("Dedizierter Ollama läuft bereits mit Ziel %s auf GPU %d; Wechsel auf Ziel %s / GPU %d wird nicht still wiederverwendet", gpuOwnedModelDir, gpuOwnedGPUIndex, normalizedModelDir, gpuIndex)
	}
	// Fail closed bleibt die Regel: ein FREMDER Prozess wird nie uebernommen.
	//
	// ⚠️ DER EIGENE IST ABER BELEGBAR — und ohne diese Pruefung sperrt sich der
	// Knopf nach jedem Tray-Neustart selbst aus. Der dedizierte Ollama ueberlebt
	// den Tray (Process.Release), waehrend gpuOllamaOwned im neuen Prozess wieder
	// false ist. Gemessen am 01.08.2026: Ollama PID 1449435 lief seit 20:01 auf
	// 11435, der Tray war ab 20:23 neu — jeder Verwenden-Klick brach mit "Port
	// belegt" ab, noch bevor der GPU-Helfer starten konnte, und die Oberflaeche
	// meldete unveraendert "Helfer laeuft nicht".
	//
	// Die Datei gpu-ollama.pid wurde bis dahin nur GESCHRIEBEN und nie gelesen,
	// obwohl sie genau diesen Nachweis fuehrt. Zusammen mit /proc/<pid>/environ
	// (OLLAMA_HOST am dedizierten Port, OLLAMA_MODELS am angeforderten Ziel) sind
	// Eigentuemerschaft UND Zielpfad nachgewiesen statt behauptet.
	pidPath := filepath.Join(filepath.Dir(gpuConfigPath()), "gpu-ollama.pid")
	if resp, e := (&http.Client{Timeout: time.Second}).Get(gpuOllamaURL + "/api/tags"); e == nil {
		resp.Body.Close()
		if istEigenerOllama(pidPath, normalizedModelDir) {
			gpuOllamaOwned = true
			gpuOwnedModelDir = normalizedModelDir
			gpuOwnedGPUIndex = gpuIndex
			return nil
		}
		return errors.New("Dedizierter Ollama-Port 11435 ist bereits belegt und gehoert nicht zu dieser Einrichtung; Prozess-Eigentuemerschaft oder Zielpfad sind nicht belegbar")
	}
	bin, err := exec.LookPath("ollama")
	if err != nil {
		return fmt.Errorf("Ollama ist nicht installiert: https://ollama.com/download")
	}
	cmd := exec.Command(bin, "serve")
	cmd.Env = append(os.Environ(), "OLLAMA_HOST="+gpuOllamaHost, "OLLAMA_MODELS="+normalizedModelDir, fmt.Sprintf("CUDA_VISIBLE_DEVICES=%d", gpuIndex))
	logf, _ := os.OpenFile(filepath.Join(filepath.Dir(gpuConfigPath()), "gpu-ollama.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if logf != nil {
		cmd.Stdout = logf
		cmd.Stderr = logf
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	_ = os.WriteFile(pidPath, []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
	_ = cmd.Process.Release()
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		if r, e := (&http.Client{Timeout: time.Second}).Get(gpuOllamaURL + "/api/tags"); e == nil {
			r.Body.Close()
			gpuOllamaOwned = true
			gpuOwnedModelDir = normalizedModelDir
			gpuOwnedGPUIndex = gpuIndex
			return nil
		}
	}
	return errors.New("Ollama konnte am dedizierten Port nicht gestartet werden")
}
func pullGPUModel(model, modelDir string, gpuIndex int) error {
	bin, err := exec.LookPath("ollama")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "pull", model)
	cmd.Env = append(os.Environ(), "OLLAMA_HOST="+gpuOllamaHost, "OLLAMA_MODELS="+modelDir, fmt.Sprintf("CUDA_VISIBLE_DEVICES=%d", gpuIndex))
	logPath := filepath.Join(filepath.Dir(gpuConfigPath()), "gpu-model-pull.log")
	logf, openErr := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if openErr != nil {
		return fmt.Errorf("Download-Log kann nicht angelegt werden: %w", openErr)
	}
	defer logf.Close()
	cmd.Stdout, cmd.Stderr = logf, logf
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("Modelldownload nach Zeitlimit abgebrochen; Log: %s", logPath)
		}
		return fmt.Errorf("Modelldownload fehlgeschlagen; Log: %s: %w", logPath, err)
	}
	return nil
}

// findComputeAgent sucht das gebaute Agent-Skript an mehreren Orten.
//
// ⚠️ WARUM SO VIELE KANDIDATEN: hier standen zwei RELATIVE Pfade, die vom
// Arbeitsverzeichnis des Trays abhingen. Gemessen am 01.08.2026 lief der Tray
// aus packages/file-watcher-daemon/tray — von dort zeigt "../compute-node-agent"
// nach packages/file-watcher-daemon/compute-node-agent und damit ins Leere;
// richtig waere "../../" gewesen. Der Agent-Start schlug still fehl, waehrend
// die Oberflaeche "bereit" meldete. Ein Pfad, der vom Arbeitsverzeichnis
// abhaengt, ist bei einem Tray immer ein Ratespiel: es startet mal aus dem
// Repo, mal aus dem Autostart, mal aus dem Dateimanager.
func findComputeAgent() (string, error) {
	if p := os.Getenv("SYNAPSE_COMPUTE_AGENT"); p != "" {
		return p, nil
	}

	const rel = "packages/compute-node-agent/dist/index.js"
	kandidaten := []string{
		filepath.Join("packages", "compute-node-agent", "dist", "index.js"),
		filepath.Join("..", "compute-node-agent", "dist", "index.js"),
		filepath.Join("..", "..", "compute-node-agent", "dist", "index.js"),
	}

	// Relativ zur eigenen Binary: liegt sie im Repo, findet sich der Agent auch
	// dann, wenn das Arbeitsverzeichnis woanders liegt.
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4 && dir != "/" && dir != "."; i++ {
			kandidaten = append(kandidaten, filepath.Join(dir, rel))
			dir = filepath.Dir(dir)
		}
	}

	// Aus der Tray-Konfiguration: dort steht der Pfad des Projekts "synapse".
	// Das ist die verlaesslichste Quelle, weil sie nicht vom Startort abhaengt.
	if cfgB, err := os.ReadFile(filepath.Join(filepath.Dir(gpuConfigPath()), "config.json")); err == nil {
		var cfg struct {
			Projekte []struct {
				Name string `json:"name"`
				Pfad string `json:"pfad"`
			} `json:"projekte"`
		}
		if json.Unmarshal(cfgB, &cfg) == nil {
			for _, p := range cfg.Projekte {
				if p.Name == "synapse" && strings.TrimSpace(p.Pfad) != "" {
					kandidaten = append(kandidaten, filepath.Join(p.Pfad, rel))
				}
			}
		}
	}

	for _, p := range kandidaten {
		if _, e := os.Stat(p); e == nil {
			a, _ := filepath.Abs(p)
			return a, nil
		}
	}
	return "", fmt.Errorf("Compute-Agent nicht gefunden. Gesucht an %d Orten, zuletzt %q. "+
		"Ist packages/compute-node-agent gebaut (pnpm --filter @synapse/compute-node-agent build)? "+
		"Notfalls SYNAPSE_COMPUTE_AGENT auf den vollen Pfad zu dist/index.js setzen",
		len(kandidaten), kandidaten[len(kandidaten)-1])
}
func lokalerGPUHelperPidPath() string {
	return filepath.Join(filepath.Dir(gpuConfigPath()), "local-gpu-helper.pid")
}

// laufenderLokalerGPUHelper liefert die PID eines bereits laufenden GPU-Helfers, sonst 0.
//
// ⚠️ WARUM ES DAS BRAUCHT: der Start war bedingungslos. Gemessen am 01.08.2026
// liefen nach drei Klicks auf "Meine GPU verwenden" drei Helfer gleichzeitig
// (20:01:39, 20:02:18, 20:03:23), die sich gegenseitig die Jobs streitig machten.
// Fuer den dedizierten Ollama gab es diesen Schutz laengst (gpuOllamaOwned und
// gpu-ollama.pid), fuer den Helfer nicht.
func laufenderLokalerGPUHelper() int {
	roh, err := os.ReadFile(lokalerGPUHelperPidPath())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(roh)))
	if err != nil || pid <= 0 {
		return 0
	}
	if !istLokalerGPUHelperProzess(pid) {
		// Verwaiste Datei eines abgestuerzten Helfers oder fremde PID.
		_ = os.Remove(lokalerGPUHelperPidPath())
		return 0
	}
	return pid
}

// stopLokalenGPUHelper beendet den lokalen GPU-Helfer und raeumt die PID-Datei weg.
//
// ⚠️ OHNE DIESEN AUFRUF LAEUFT DER HELFER NACH DEM SPERREN WEITER. "Meine GPU
// nicht verwenden" setzte nur die Sperre in der Registry; der lokale Prozess
// pollte weiter und bekam bei jedem Versuch 403 node_not_usable — am 01.08.2026
// zehntausende Zeilen in compute-node.log, waehrend die Oberflaeche "gesperrt"
// meldete. Ein Nichtstun ist kein Stopp.
func stopLokalenGPUHelper() error {
	lokalerGPUHelperMu.Lock()
	defer lokalerGPUHelperMu.Unlock()
	pid := laufenderLokalerGPUHelper()
	if pid == 0 {
		_ = os.Remove(lokalerGPUHelperPidPath())
		return nil
	}
	if err := prozessBeenden(pid); err != nil {
		return fmt.Errorf("GPU-Helfer (PID %d) konnte nicht beendet werden: %w", pid, err)
	}
	_ = os.Remove(lokalerGPUHelperPidPath())
	return nil
}

func startLokalenGPUHelper(c gpuNodeConfig, ref apiEmbeddingReference) error {
	lokalerGPUHelperMu.Lock()
	defer lokalerGPUHelperMu.Unlock()
	// Laeuft schon einer, bleibt es bei dem. Ein zweiter brachte keinen Durchsatz,
	// sondern nur Konkurrenz um dieselben Jobs.
	if pid := laufenderLokalerGPUHelper(); pid > 0 {
		return nil
	}
	agent, err := findComputeAgent()
	if err != nil {
		return err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return err
	}
	cmd := exec.Command(node, agent)
	cmd.Env = append(os.Environ(), "SYNAPSE_API_URL="+c.Issuer, "SYNAPSE_API_TOKEN="+c.ComputeToken, "SYNAPSE_NODE_ID="+c.NodeID, "OLLAMA_URL="+gpuOllamaURL, "OLLAMA_MODEL="+ref.Model, fmt.Sprintf("EMBEDDING_TARGET_DIM=%d", ref.TargetDimension), fmt.Sprintf("SYNAPSE_GPU_REQUIRED_FREE_MB=%d", ref.RequiredFreeVramMb), fmt.Sprintf("SYNAPSE_GPU_REQUIRED_TOTAL_MB=%d", ref.RequiredTotalVramMb), fmt.Sprintf("SYNAPSE_GPU_INDEX=%d", c.GPUIndex), fmt.Sprintf("CUDA_VISIBLE_DEVICES=%d", c.GPUIndex))
	logf, _ := os.OpenFile(filepath.Join(filepath.Dir(gpuConfigPath()), "compute-node.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if logf != nil {
		cmd.Stdout = logf
		cmd.Stderr = logf
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	// Ohne diese Datei liest laufenderLokalerGPUHelper() beim naechsten Klick ins Leere
	// und der Singleton greift nie — genau der Fehler, der hier behoben werden soll.
	_ = os.WriteFile(lokalerGPUHelperPidPath(), []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
	return cmd.Process.Release()
}
