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
	if !gpuHardwareSuitable(h, requiredTotal, requiredFree) {
		return h, fmt.Errorf("Hardware passt nicht / nicht möglich: mindestens %d MB gesamt und %d MB frei erforderlich; gemessen %d MB gesamt / %d MB frei", requiredTotal, requiredFree, h.TotalMB, h.FreeMB)
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
	runtimeGOOS      = func() string { return runtime.GOOS }
	gpuOllamaMu      sync.Mutex
	gpuOllamaOwned   bool
	gpuOwnedModelDir string
	gpuOwnedGPUIndex int
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

func localOllamaTag(model string) (*ollamaTag, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(gpuOllamaURL + "/api/tags")
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
	// Fail closed: Ein antwortender Prozess ist nicht als unser Prozess beweisbar.
	// Darum wird er nie uebernommen; insbesondere wird OLLAMA_MODELS nicht nur
	// behauptet, wenn ein fremder Daemon bereits auf dem dedizierten Port laeuft.
	pidPath := filepath.Join(filepath.Dir(gpuConfigPath()), "gpu-ollama.pid")
	if resp, e := (&http.Client{Timeout: time.Second}).Get(gpuOllamaURL + "/api/tags"); e == nil {
		resp.Body.Close()
		return errors.New("Dedizierter Ollama-Port 11435 ist bereits belegt; Prozess-Eigentuemerschaft und Zielpfad sind nicht belegbar")
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

func findComputeAgent() (string, error) {
	if p := os.Getenv("SYNAPSE_COMPUTE_AGENT"); p != "" {
		return p, nil
	}
	for _, p := range []string{filepath.Join("packages", "compute-node-agent", "dist", "index.js"), filepath.Join("..", "compute-node-agent", "dist", "index.js")} {
		if _, e := os.Stat(p); e == nil {
			a, _ := filepath.Abs(p)
			return a, nil
		}
	}
	return "", errors.New("Compute-Agent nicht gefunden")
}
func startGPUComputeAgent(c gpuNodeConfig, ref apiEmbeddingReference) error {
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
	return cmd.Process.Release()
}
