package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestGPUHardwareGate(t *testing.T) {
	tests := []struct {
		name string
		h    gpuHardware
		want bool
	}{
		{"8GB wird abgelehnt", gpuHardware{TotalMB: 8192, FreeMB: 8192}, false},
		{"12GB und 7300MB frei werden akzeptiert", gpuHardware{TotalMB: 12000, FreeMB: 7300}, true},
		{"genug gesamt aber zu wenig frei wird abgelehnt", gpuHardware{TotalMB: 12000, FreeMB: 7299}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := gpuHardwareSuitable(tc.h, gpuRequiredTotalMB, gpuRequiredFreeMB); got != tc.want {
				t.Fatalf("gpuHardwareSuitable(%+v) = %v, want %v", tc.h, got, tc.want)
			}
		})
	}
}

func TestGPUDigestsMatchFailClosed(t *testing.T) {
	const digest = "64b933495768fbd3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if !gpuDigestsMatch(digest, "sha256:"+digest) {
		t.Fatal("vollstaendige identische Digests muessen matchen")
	}
	if gpuDigestsMatch(digest, "64b933495768fbd3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
		t.Fatal("abweichende Digests duerfen nicht matchen")
	}
	if gpuDigestsMatch("", digest) {
		t.Fatal("nicht konfigurierter Referenz-Digest muss fail-closed sein")
	}
	if gpuDigestsMatch("64b933495768fbd3", "64b933495768fbd3") {
		t.Fatal("Digest-Praefixe duerfen nicht matchen")
	}
}

func TestEmbeddingSelfEffectiveStatusContract(t *testing.T) {
	var response apiEmbeddingSelfResponse
	if err := json.Unmarshal([]byte(`{"success":true,"node":{"node_id":"gpu-test","effectiveStatus":"ready"}}`), &response); err != nil {
		t.Fatal(err)
	}
	if response.Node.EffectiveStatus != "ready" {
		t.Fatalf("effectiveStatus = %q, want ready", response.Node.EffectiveStatus)
	}
}

func TestSameOwnedOllamaTarget(t *testing.T) {
	base := t.TempDir()
	equivalent := filepath.Join(base, ".")
	if !sameOwnedOllamaTarget(base, 2, equivalent, 2) {
		t.Fatal("gleicher absolut normalisierter Pfad und GPU-Index muessen matchen")
	}
	if sameOwnedOllamaTarget(base, 2, filepath.Join(base, "anderes-ziel"), 2) {
		t.Fatal("anderer Modellpfad darf nicht wiederverwendet werden")
	}
	if sameOwnedOllamaTarget(base, 2, equivalent, 3) {
		t.Fatal("anderer GPU-Index darf nicht wiederverwendet werden")
	}
	if sameOwnedOllamaTarget("", 2, equivalent, 2) {
		t.Fatal("nicht normalisierbarer Besitzpfad muss fail-closed sein")
	}
}

func TestRequiredGPUModelDiskBytes(t *testing.T) {
	required, err := requiredGPUModelDiskBytes(4.7)
	if err != nil {
		t.Fatal(err)
	}
	const want = uint64(4_700_000_000) + gpuDiskReserveBytes
	if required != want {
		t.Fatalf("required bytes = %d, want %d", required, want)
	}
	if _, err := requiredGPUModelDiskBytes(0); err == nil {
		t.Fatal("fehlende Downloadgroesse muss fail-closed sein")
	}
}

func TestGPUModelDiskThreshold(t *testing.T) {
	required, err := requiredGPUModelDiskBytes(4.7)
	if err != nil {
		t.Fatal(err)
	}
	if required <= uint64(4_700_000_000) {
		t.Fatal("erforderlicher Speicher muss eine Reserve enthalten")
	}
	if required-1 >= required {
		t.Fatal("ein Byte unter dem Grenzwert muss darunter bleiben")
	}
}
