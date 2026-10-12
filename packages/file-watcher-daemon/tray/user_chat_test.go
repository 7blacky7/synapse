package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type chatTransport func(*http.Request) (*http.Response, error)

func (f chatTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTrayChatBestehendeVerbindung(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SYNAPSE_API_TOKEN", "")
	dir := filepath.Join(home, ".synapse", "file-watcher")
	if err := os.MkdirAll(dir, 0700); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"synapse_api_url":"http://tray-test.invalid","synapse_api_token":"test-bestehender-service-zugang"}`), 0600); err != nil { t.Fatal(err) }
	oldClient := apiHttpClient
	apiBaseMu.Lock()
	oldBase := apiLastGood
	apiLastGood = ""
	apiBaseMu.Unlock()
	t.Cleanup(func() {
		apiHttpClient = oldClient
		apiBaseMu.Lock()
		apiLastGood = oldBase
		apiBaseMu.Unlock()
	})
	calls := 0
	apiHttpClient = &http.Client{Transport: chatTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "tray-test.invalid" || r.URL.Path != "/api/projects/test/channels/team/user-post" || r.Method != http.MethodPost {
			t.Fatalf("Unerwarteter Request statt direktem Chat: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer test-bestehender-service-zugang" { t.Fatal("Bestehender Config-Zugang fehlt") }
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil { t.Fatal(err) }
		if len(body) != 1 || body["content"] != "Hallo" { t.Fatalf("Chat-Nutzlast: %v", body) }
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true}`)), Header: make(http.Header)}, nil
	})}
	if err := sendeTrayUserNachricht("test", "team", "Hallo"); err != nil { t.Fatal(err) }
	if calls != 1 { t.Fatalf("%d Requests statt einem Chat-Request", calls) }
	if _, err := os.Stat(filepath.Join(home, ".synapse", "tray", "user-session.json")); !os.IsNotExist(err) { t.Fatal("Chat darf keine zusätzliche Sitzung anlegen") }
}

func TestTrayChatAblehnungBleibtFehler(t *testing.T) {
	oldClient := apiHttpClient
	t.Cleanup(func() { apiHttpClient = oldClient })
	calls := 0
	apiHttpClient = &http.Client{Transport: chatTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"success":false}`)), Header: make(http.Header)}, nil
	})}
	if err := sendeTrayUserNachricht("test", "team", "Hallo"); err == nil { t.Fatal("Ablehnung darf nicht als Erfolg erscheinen") }
	if calls != 1 { t.Fatalf("Auth-Ablehnung darf keinen zweiten Login auslösen: %d", calls) }
}
