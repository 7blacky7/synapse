package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func setupApiBaseConfig(t *testing.T, config map[string]string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".synapse", "file-watcher")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "config.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	apiBaseMu.Lock()
	old := apiLastGood
	apiLastGood = ""
	apiBaseMu.Unlock()
	t.Cleanup(func() {
		apiBaseMu.Lock()
		apiLastGood = old
		apiBaseMu.Unlock()
	})
}

func TestApiBasesUsesSharedFallbackConfig(t *testing.T) {
	t.Setenv("SYNAPSE_API_URL", "")
	t.Setenv("SYNAPSE_API_FALLBACK_URL", "")
	setupApiBaseConfig(t, map[string]string{
		"synapse_api_url":          "https://preferred.test/",
		"synapse_api_fallback_url": "https://fallback.test/",
	})
	want := []string{
		"https://preferred.test",
		apiDefaultTunnel,
		"https://fallback.test",
	}
	if got := apiBases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("apiBases() = %#v, want %#v", got, want)
	}
}

func TestApiBasesKeepsLegacyConfigAndEnvironmentPriority(t *testing.T) {
	t.Setenv("SYNAPSE_API_URL", "https://env-preferred.test/")
	t.Setenv("SYNAPSE_API_FALLBACK_URL", "https://env-fallback.test/")
	setupApiBaseConfig(t, map[string]string{
		"synapse_api_url":          "https://config-preferred.test/",
		"synapse_api_fallback_url": "https://config-fallback.test/",
	})
	rememberBase("https://remembered.test")
	want := []string{
		"https://env-preferred.test",
		"https://remembered.test",
		"https://config-preferred.test",
		apiDefaultTunnel,
		"https://env-fallback.test",
	}
	if got := apiBases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("apiBases() = %#v, want %#v", got, want)
	}
}

func TestApiBasesLegacyConfigUsesPreviousFallback(t *testing.T) {
	t.Setenv("SYNAPSE_API_URL", "")
	t.Setenv("SYNAPSE_API_FALLBACK_URL", "")
	setupApiBaseConfig(t, map[string]string{
		"synapse_api_url": "https://legacy-preferred.test/",
	})
	want := []string{
		"https://legacy-preferred.test",
		apiDefaultTunnel,
		apiFallbackLocalDefault,
	}
	if got := apiBases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("apiBases() = %#v, want %#v", got, want)
	}
}
