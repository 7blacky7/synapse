package main

// api_client.go — Synapse-API-Anbindung fuer den Tray (TRAY-2).
//
// WARUM: Der Tray hielt bisher eine eigene PG-Verbindung mit hartcodierter IP
// ("postgres://synapse@192.168.50.65:5432/synapse", tray.go:309). Damit haengt er
// an der Datenbank statt an der API: keine Auth, kein Fallback, IP fest im Binary,
// und jede Schema-Aenderung trifft ihn direkt.
//
// STATTDESSEN: HTTP gegen die Synapse-API, mit einer Fallback-KETTE aus mehreren
// Basis-Adressen. Wichtig dabei — der Fallback ist reiner TRANSPORT, niemals eine
// zweite Wahrheit: alle Adressen zeigen auf dieselbe API und dieselbe PG. Es wird
// nie lokal weitergeschrieben und spaeter synchronisiert.
//
// REIHENFOLGE der Basen:
//   1. synapse_api_url aus ~/.synapse/file-watcher/config.json (heute die lokale
//      Unraid-IP; kann auf den Cloudflare-Tunnel zeigen)
//   2. SYNAPSE_API_FALLBACK_URL aus der Umgebung, sonst die lokale Unraid-IP
//   3. http://127.0.0.1:3456 (DEFAULT_SYNAPSE_API_URL im TS-Daemon)
// Doppelte Eintraege werden entfernt, die Reihenfolge bleibt erhalten.
//
// AUTH: /api/* ist Bearer-gated (registerAuthHook, AUTH-4). Das Token kommt aus
// SYNAPSE_API_TOKEN oder dem Feld synapse_api_token in derselben config.json.
// Ein Daemon macht KEINEN interaktiven OAuth-Flow — einmalig ausgestelltes
// Service-Token, das fuer alle Basen derselben Ausstellerinstanz gilt. Sonst
// faellt beim Umschalten auf die lokale IP die Identitaet weg, genau dann wenn
// der Tunnel weg ist.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// Letzte Instanz der Kette — der TS-Daemon-Default.
	apiFallbackLoopback = "http://127.0.0.1:3456"
	// Vorletzte Instanz: der Server im lokalen Netz. Bewusst ueberschreibbar,
	// damit die Adresse nicht wieder im Binary festwaechst.
	apiFallbackLocalDefault = "http://192.168.50.65:3456"
)

var apiHttpClient = &http.Client{Timeout: 10 * time.Second}

// Merkt sich die zuletzt erfolgreiche Basis, damit nicht jeder Aufruf erneut
// durch die ganze Kette laeuft. Wird bei Fehlschlag verworfen.
var (
	apiBaseMu   sync.Mutex
	apiLastGood string
)

// trayConfig ist der Ausschnitt der Daemon-Config, den der Tray braucht.
type trayConfig struct {
	SynapseApiUrl   string `json:"synapse_api_url"`
	SynapseApiToken string `json:"synapse_api_token"`
}

func readTrayConfig() trayConfig {
	var cfg trayConfig
	home, err := os.UserHomeDir()
	if err != nil {
		return cfg
	}
	data, err := os.ReadFile(filepath.Join(home, ".synapse", "file-watcher", "config.json"))
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg) // Fehlende Felder sind kein Fehlerfall.
	return cfg
}

// apiToken liefert das Bearer-Token oder "" (dann wird ohne Header gesendet —
// nuetzlich fuer Instanzen mit SYNAPSE_AUTH_DISABLED=1).
func apiToken() string {
	if t := strings.TrimSpace(os.Getenv("SYNAPSE_API_TOKEN")); t != "" {
		return t
	}
	return strings.TrimSpace(readTrayConfig().SynapseApiToken)
}

// apiBases baut die Fallback-Kette auf, ohne Duplikate.
func apiBases() []string {
	var out []string
	seen := map[string]bool{}
	add := func(raw string) {
		u := strings.TrimRight(strings.TrimSpace(raw), "/")
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		out = append(out, u)
	}

	apiBaseMu.Lock()
	last := apiLastGood
	apiBaseMu.Unlock()
	add(last) // zuletzt erfolgreiche Basis zuerst probieren

	add(readTrayConfig().SynapseApiUrl)

	if fb := os.Getenv("SYNAPSE_API_FALLBACK_URL"); fb != "" {
		add(fb)
	} else {
		add(apiFallbackLocalDefault)
	}

	add(apiFallbackLoopback)
	return out
}

func rememberBase(base string) {
	apiBaseMu.Lock()
	apiLastGood = base
	apiBaseMu.Unlock()
}

func forgetBase(base string) {
	apiBaseMu.Lock()
	if apiLastGood == base {
		apiLastGood = ""
	}
	apiBaseMu.Unlock()
}

// apiRequest schickt method+path an die erste erreichbare Basis und dekodiert die
// JSON-Antwort nach out (darf nil sein). Der Rueckgabewert base nennt die Basis,
// die geantwortet hat — fuer Logging/Anzeige.
//
// Nur Transport-/5xx-Fehler fuehren zum naechsten Kettenglied. Ein 4xx ist eine
// ECHTE Antwort des Servers (falsches Token, Projekt unbekannt) und wird sofort
// zurueckgegeben — sonst wuerde ein Auth-Fehler als "Server nicht erreichbar"
// erscheinen und man debuggt an der falschen Stelle.
func apiRequest(method, path string, out interface{}) (base string, err error) {
	var lastErr error
	token := apiToken()

	for _, b := range apiBases() {
		req, reqErr := http.NewRequest(method, b+path, nil)
		if reqErr != nil {
			lastErr = reqErr
			continue
		}
		req.Header.Set("Accept", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, doErr := apiHttpClient.Do(req)
		if doErr != nil {
			lastErr = doErr
			forgetBase(b)
			continue // nicht erreichbar -> naechste Basis
		}

		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("%s: HTTP %d", b, resp.StatusCode)
			forgetBase(b)
			continue // Serverfehler -> naechste Basis versuchen
		}
		if resp.StatusCode >= 400 {
			// Echte Ablehnung: nicht weiterprobieren, Ursache benennen.
			return b, fmt.Errorf("HTTP %d von %s: %s", resp.StatusCode, b, strings.TrimSpace(string(body)))
		}
		if readErr != nil {
			lastErr = readErr
			continue
		}

		if out != nil {
			if jsonErr := json.Unmarshal(body, out); jsonErr != nil {
				lastErr = fmt.Errorf("%s: ungueltiges JSON: %v", b, jsonErr)
				continue
			}
		}
		rememberBase(b)
		return b, nil
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("keine API-Basis konfiguriert")
	}
	return "", fmt.Errorf("Synapse-API nicht erreichbar: %v", lastErr)
}

func apiGet(path string, out interface{}) error {
	_, err := apiRequest(http.MethodGet, path, out)
	return err
}

func apiPost(path string, out interface{}) error {
	_, err := apiRequest(http.MethodPost, path, out)
	return err
}

// ---------------------------------------------------------------------------
// Antworttypen — Gegenstuecke zu packages/rest-api/src/routes/tray.ts
// ---------------------------------------------------------------------------

type apiAgent struct {
	AgentName     string `json:"agent_name"`
	Model         string `json:"model"`
	Status        string `json:"status"`
	TokensPercent string `json:"tokens_percent"`
	LastActivity  string `json:"last_activity"`
}

type apiAgentsResponse struct {
	Success bool       `json:"success"`
	Agents  []apiAgent `json:"agents"`
}

// apiFileVersion spiegelt die BESTEHENDE Route in routes/specialists.ts.
// Deren Felder sind nullable (kein COALESCE) und created_at ist ein roher
// PG-Zeitstempel — beides wird hier abgefangen statt serverseitig.
type apiFileVersion struct {
	Id         string  `json:"id"`
	FilePath   string  `json:"file_path"`
	EditAction *string `json:"edit_action"`
	AgentId    *string `json:"agent_id"`
	Reason     *string `json:"reason"`
	FeatureTag *string `json:"feature_tag"`
	CreatedAt  string  `json:"created_at"`
}

// oderLeer macht aus einem nullable Feld einen anzeigbaren String.
func oderLeer(s *string, fallback string) string {
	if s == nil || *s == "" {
		return fallback
	}
	return *s
}

// pgZeitKurz formatiert "2026-07-25 13:10:15.123456+02" als "25.07. 13:10:15" —
// dieselbe Darstellung, die frueher to_char() in der SQL-Abfrage erzeugt hat.
// Bei unbekanntem Format wird der Rohwert durchgereicht statt zu raten.
func pgZeitKurz(roh string) string {
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999-07",
		"2006-01-02 15:04:05.999999Z07:00",
		"2006-01-02T15:04:05.999999Z07:00",
		"2006-01-02 15:04:05",
	} {
		if t, err := time.Parse(layout, roh); err == nil {
			return t.Format("02.01. 15:04:05")
		}
	}
	return roh
}

type apiFileVersionsResponse struct {
	Success  bool             `json:"success"`
	Versions []apiFileVersion `json:"versions"`
}

type apiSession struct {
	Id    int64  `json:"id"`
	Model string `json:"model"`
}

type apiSessionsResponse struct {
	Success  bool         `json:"success"`
	Sessions []apiSession `json:"sessions"`
}

type apiChannelMessage struct {
	Id        int64  `json:"id"`
	Sender    string `json:"sender"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type apiChannelMessagesResponse struct {
	Success  bool                `json:"success"`
	Order    string              `json:"order"` // "desc" beim Erst-Laden, "asc" beim Polling
	Messages []apiChannelMessage `json:"messages"`
}

type apiReembedResponse struct {
	Success          bool   `json:"success"`
	ChunksReset      int    `json:"chunksReset"`
	FilesReset       int    `json:"filesReset"`
	VectorSizeBefore *int   `json:"vectorSizeBefore"`
	VectorSizeAfter  *int   `json:"vectorSizeAfter"`
	Message          string `json:"message"`
	Error            string `json:"error"`
}

// ---------------------------------------------------------------------------
// Konkrete Abfragen
// ---------------------------------------------------------------------------

func apiFetchAgents(project string) ([]apiAgent, error) {
	var r apiAgentsResponse
	if err := apiGet("/api/projects/"+urlSeg(project)+"/agents", &r); err != nil {
		return nil, err
	}
	return r.Agents, nil
}

func apiFetchFileVersions(project string, limit int) ([]apiFileVersion, error) {
	var r apiFileVersionsResponse
	path := fmt.Sprintf("/api/projects/%s/file-versions?limit=%d", urlSeg(project), limit)
	if err := apiGet(path, &r); err != nil {
		return nil, err
	}
	return r.Versions, nil
}

func apiFetchSessions(project string) ([]apiSession, error) {
	var r apiSessionsResponse
	if err := apiGet("/api/projects/"+urlSeg(project)+"/sessions", &r); err != nil {
		return nil, err
	}
	return r.Sessions, nil
}

// apiFetchChannelMessages liefert die Nachrichten IMMER aufsteigend sortiert —
// die Antwort meldet ihre Reihenfolge im Feld order, hier wird sie vereinheitlicht,
// damit die Aufrufer sich darum nicht kuemmern muessen.
func apiFetchChannelMessages(project, channel string, sinceId int64, limit int) ([]apiChannelMessage, error) {
	path := fmt.Sprintf("/api/projects/%s/channels/%s/messages?limit=%d",
		urlSeg(project), urlSeg(channel), limit)
	if sinceId > 0 {
		path += fmt.Sprintf("&since_id=%d", sinceId)
	}
	var r apiChannelMessagesResponse
	if err := apiGet(path, &r); err != nil {
		return nil, err
	}
	if r.Order == "desc" {
		for i, j := 0, len(r.Messages)-1; i < j; i, j = i+1, j-1 {
			r.Messages[i], r.Messages[j] = r.Messages[j], r.Messages[i]
		}
	}
	return r.Messages, nil
}

// apiReembedProject stoesst den Embedding-Reset nach einem Modellwechsel an.
// Die Antwort kommt sofort; das Neu-Embedden laeuft serverseitig im Hintergrund.
func apiReembedProject(project string) (apiReembedResponse, error) {
	var r apiReembedResponse
	err := apiPost("/api/projects/"+urlSeg(project)+"/reembed", &r)
	return r, err
}

// urlSeg escaped einen Pfad-Abschnitt. Eigene Funktion statt url.PathEscape im
// Aufrufer, damit die Pfadbildung an EINER Stelle liegt.
func urlSeg(s string) string {
	return strings.ReplaceAll(url.PathEscape(s), "/", "%2F")
}
