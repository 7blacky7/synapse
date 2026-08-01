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
	"bytes"
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
	// Standardweg: der oeffentliche Tunnel. Die REST-API laeuft auf dem Server,
	// NICHT auf dem Rechner des Nutzers — ein Loopback-Default waere hier falsch
	// (der TS-Daemon nutzt 127.0.0.1 zu Recht, aber der laeuft auch dort).
	apiDefaultTunnel = "https://synapse.moosynapse.org"
	// Fallback: derselbe Server im lokalen Netz. Setzt voraus, dass der Container
	// den Port veroeffentlicht (-p 3456:3456); ohne das ist die Adresse tot.
	// Ueberschreibbar per SYNAPSE_API_FALLBACK_URL, damit sie nicht im Binary festwaechst.
	apiFallbackLocalDefault = "http://192.168.50.65:3456"
)

var apiHttpClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

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

	add(apiDefaultTunnel)

	if fb := os.Getenv("SYNAPSE_API_FALLBACK_URL"); fb != "" {
		add(fb)
	} else {
		add(apiFallbackLocalDefault)
	}

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
	return apiRequestBody(method, path, nil, out)
}

// apiRequestBody wie apiRequest, zusaetzlich mit JSON-Body (darf nil sein).
func apiRequestBody(method, path string, body interface{}, out interface{}) (base string, err error) {
	return apiRequestBodyWithToken(method, path, body, apiToken(), out)
}

func apiRequestBodyWithToken(method, path string, body interface{}, token string, out interface{}) (base string, err error) {
	var payload []byte
	if body != nil {
		var mErr error
		payload, mErr = json.Marshal(body)
		if mErr != nil {
			return "", mErr
		}
	}

	// Fehler JE Adresse sammeln. Frueher wurde nur der letzte behalten — dann
	// sieht der Nutzer bloss das letzte Kettenglied und sucht an der falschen
	// Stelle, obwohl alle Adressen probiert wurden.
	var versuche []string

	for _, b := range apiBases() {
		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, reqErr := http.NewRequest(method, b+path, rdr)
		if reqErr != nil {
			versuche = append(versuche, b+": "+reqErr.Error())
			continue
		}
		req.Header.Set("Accept", "application/json")
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, doErr := apiHttpClient.Do(req)
		if doErr != nil {
			versuche = append(versuche, b+": nicht erreichbar")
			forgetBase(b)
			continue // nicht erreichbar -> naechste Basis
		}

		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			return b, fmt.Errorf("HTTP-Redirect %d von %s abgelehnt", resp.StatusCode, b)
		}
		if resp.StatusCode >= 500 {
			versuche = append(versuche, fmt.Sprintf("%s: HTTP %d", b, resp.StatusCode))
			forgetBase(b)
			continue // Serverfehler -> naechste Basis versuchen
		}
		if resp.StatusCode >= 400 {
			// Echte Ablehnung: nicht weiterprobieren, Ursache benennen.
			return b, fmt.Errorf("HTTP %d von %s: %s", resp.StatusCode, b, strings.TrimSpace(string(body)))
		}
		if readErr != nil {
			versuche = append(versuche, b+": Antwort nicht lesbar")
			continue
		}

		if out != nil {
			if jsonErr := json.Unmarshal(body, out); jsonErr != nil {
				versuche = append(versuche, fmt.Sprintf("%s: ungueltiges JSON", b))
				continue
			}
		}
		rememberBase(b)
		return b, nil
	}

	if len(versuche) == 0 {
		return "", fmt.Errorf("Keine API-Adresse konfiguriert.")
	}
	return "", fmt.Errorf("Keine der Adressen hat geantwortet:\n  • %s", strings.Join(versuche, "\n  • "))
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

// pgZeitKurz formatiert einen Zeitstempel als "25.07. 13:10:15" — dieselbe
// Darstellung, die frueher to_char() in der SQL-Abfrage erzeugt hat.
// Bei unbekanntem Format wird der Rohwert durchgereicht statt zu raten.
//
// ZEITZONE (gefunden 2026-07-26, Nutzer-Beschwerde "ich hasse Zeitverschiebung"):
// Zeitstempel aus der REST-API sind IMMER UTC (JSON-Serialisierung von
// timestamptz haengt "Z" an) — diese drei Layouts tragen eine explizite Zone
// und werden deshalb per .Local() auf die Zeitzone DIESER Maschine umgerechnet.
// Ohne das zeigte der Tray woertlich die UTC-Ziffern an, als waeren es die
// eigenen — bei Sommerzeit zwei Stunden daneben.
func pgZeitKurz(roh string) string {
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999-07",
		"2006-01-02 15:04:05.999999Z07:00",
		"2006-01-02T15:04:05.999999Z07:00",
	} {
		if t, err := time.Parse(layout, roh); err == nil {
			return t.Local().Format("02.01. 15:04:05")
		}
	}
	// VIERTES LAYOUT BEWUSST OHNE .Local(): kommt aus dem direkten PG-Fallback
	// (to_char(spalte, 'DD.MM. HH24:MI:SS') OHNE AT TIME ZONE), der die
	// SESSION-Zeitzone von PostgreSQL benutzt (hier: Europe/Berlin, siehe SHOW
	// timezone) — die Ziffern sind bereits lokale Wanduhrzeit. Go's time.Parse
	// stuft eine zonenlose Zeichenkette als UTC ein; ein zusaetzliches .Local()
	// wuerde die bereits richtige Zeit ein zweites Mal verschieben.
	if t, err := time.Parse("2006-01-02 15:04:05", roh); err == nil {
		return t.Format("02.01. 15:04:05")
	}
	return roh
}

type apiFileVersionsResponse struct {
	Success  bool             `json:"success"`
	Versions []apiFileVersion `json:"versions"`
}

// Id ist bewusst ein String: agent_sessions.id ist laut schema.ts
// TEXT PRIMARY KEY (der Agent-Name, z.B. "koordinator"), keine Zahl.
// Mit int64 waere jedes Decode fehlgeschlagen und der Tray waere still
// auf die PG-Abfrage zurueckgefallen (TRAY-6).
type apiSession struct {
	Id    string `json:"id"`
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

// apiStatsResponse spiegelt GET /api/projects/:name/stats (routes/stats.ts).
type apiStatsResponse struct {
	Success bool `json:"success"`
	Stats   struct {
		Project      string `json:"project"`
		TotalFiles   int    `json:"totalFiles"`
		TotalVectors int    `json:"totalVectors"`
		Collections  struct {
			Code struct {
				Vectors int `json:"vectors"`
			} `json:"code"`
		} `json:"collections"`
	} `json:"stats"`
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

// apiToolCall ist die LEICHTGEWICHTIGE Zeile fuer die Liste (detail=summary
// auf Server-Seite): args_preview + eine kurze Ergebnis-Vorschau, kein volles
// Ergebnis. Quelle ist tool_calls — der zentrale Audit-Log ALLER MCP-Tool-
// Aufrufe (code_intel, files, shell, alles), nicht nur Datei-Schreibzugriffe.
type apiToolCall struct {
	Id              string  `json:"id"`
	Ts              string  `json:"ts"`
	ToolName        string  `json:"tool_name"`
	Action          *string `json:"action"`
	AgentId         *string `json:"agent_id"`
	Ok              bool    `json:"ok"`
	DurationMs      *int    `json:"duration_ms"`
	ResultPreview   *string `json:"result_preview"`
	ResultBytes     *int    `json:"result_bytes"`
	ResultTruncated *bool   `json:"result_truncated"`
}

type apiToolCallsResponse struct {
	Success bool          `json:"success"`
	Calls   []apiToolCall `json:"calls"`
}

// apiToolCallDetail ist die VOLLE Zeile (detail=full) fuer das Detail-Fenster:
// zusaetzlich Result (ungekuerzt bis zum serverseitigen Cap) und Error.
type apiToolCallDetail struct {
	Id              string  `json:"id"`
	Ts              string  `json:"ts"`
	Project         *string `json:"project"`
	ToolName        string  `json:"tool_name"`
	Action          *string `json:"action"`
	AgentId         *string `json:"agent_id"`
	ArgsPreview     *string `json:"args_preview"`
	Ok              bool    `json:"ok"`
	Error           *string `json:"error"`
	DurationMs      *int    `json:"duration_ms"`
	Result          *string `json:"result"`
	ResultBytes     *int    `json:"result_bytes"`
	ResultTruncated *bool   `json:"result_truncated"`
}

type apiToolCallDetailResponse struct {
	Success bool              `json:"success"`
	Call    apiToolCallDetail `json:"call"`
}

func apiFetchToolCalls(project string, limit int) ([]apiToolCall, error) {
	var r apiToolCallsResponse
	path := fmt.Sprintf("/api/projects/%s/tool-calls?limit=%d", urlSeg(project), limit)
	if err := apiGet(path, &r); err != nil {
		return nil, err
	}
	return r.Calls, nil
}

func apiFetchToolCallDetail(project, id string) (apiToolCallDetail, error) {
	var r apiToolCallDetailResponse
	path := fmt.Sprintf("/api/projects/%s/tool-calls/%s", urlSeg(project), urlSeg(id))
	if err := apiGet(path, &r); err != nil {
		return apiToolCallDetail{}, err
	}
	return r.Call, nil
}

// apiFetchStats liefert Datei- und Chunk-Zahlen des Index. Der lokale Daemon
// kennt diese Werte NICHT — sein /projects/:name/status liefert nur Pfad und
// Laufzustand. Genau deshalb stand im Status-Tab dauerhaft "-".
func apiFetchStats(project string) (apiStatsResponse, error) {
	var r apiStatsResponse
	err := apiGet("/api/projects/"+urlSeg(project)+"/stats", &r)
	return r, err
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

// ---------------------------------------------------------------------------
// Verbinden: Service-Token holen und ablegen (TRAY-3)
// ---------------------------------------------------------------------------

type apiServiceTokenResponse struct {
	Success   bool   `json:"success"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	Scope     string `json:"scope"`
	Issuer    string `json:"-"`
	Error     *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// apiHoleServiceToken tauscht einen 6-stelligen TOTP-Code gegen ein langlebiges
// Token (6 Monate). Der Endpunkt ist bewusst NICHT Bearer-gated — der Code aus
// der Authenticator-App IST die Legitimation. Genau deshalb kann der Tray sich
// hiermit ohne Vorwissen selbst verbinden.
func apiHoleServiceToken(code, label string) (apiServiceTokenResponse, error) {
	var r apiServiceTokenResponse
	body := map[string]string{"code": code, "label": label}
	_, err := apiRequestBody(http.MethodPost, "/api/auth/service-token", body, &r)
	if err != nil {
		return r, err
	}
	if !r.Success {
		if r.Error != nil {
			if r.Error.Code == "invalid_code" {
				return r, fmt.Errorf("Der Code wurde nicht akzeptiert. Er gilt nur 30 Sekunden — nimm den aktuellen aus der App.")
			}
			return r, fmt.Errorf("%s", r.Error.Message)
		}
		return r, fmt.Errorf("Server hat das Token abgelehnt.")
	}
	if r.Token == "" {
		return r, fmt.Errorf("Antwort enthielt kein Token.")
	}
	return r, nil
}

type apiEmbeddingReference struct {
	Model               string  `json:"model"`
	ModelDigest         *string `json:"modelDigest"`
	NativeDimension     int     `json:"nativeDimension"`
	TargetDimension     int     `json:"targetDimension"`
	NumCtx              int     `json:"numCtx"`
	Quantization        *string `json:"quantization"`
	RequiredTotalVramMb int     `json:"requiredTotalVramMb"`
	RequiredFreeVramMb  int     `json:"requiredFreeVramMb"`
}
type apiEmbeddingDownload struct {
	Linux       string  `json:"linux"`
	Windows     string  `json:"windows"`
	MacOS       string  `json:"macos"`
	Model       string  `json:"model"`
	ModelSizeGb float64 `json:"modelSizeGb"`
}
type apiEmbeddingReferenceResponse struct {
	Success   bool                  `json:"success"`
	Reference apiEmbeddingReference `json:"reference"`
	Download  apiEmbeddingDownload  `json:"download"`
}
type apiEmbeddingNode struct {
	NodeID          string  `json:"node_id"`
	Model           string  `json:"modell"`
	ModelDigest     string  `json:"modell_digest"`
	TargetDimension int     `json:"ziel_dimension"`
	Quantization    *string `json:"quantisierung"`
	LockedByUser    bool    `json:"gesperrt_vom_user"`
	EffectiveStatus string  `json:"effectiveStatus"`
}
type apiEmbeddingSelfResponse struct {
	Success   bool                  `json:"success"`
	Reference apiEmbeddingReference `json:"reference"`
	Node      apiEmbeddingNode      `json:"node"`
}

func apiFetchEmbeddingReference() (apiEmbeddingReferenceResponse, error) {
	var r apiEmbeddingReferenceResponse
	err := apiPinnedRequest(http.MethodGet, apiDefaultTunnel, "/api/embedding-nodes/reference", nil, apiToken(), &r)
	return r, err
}
func apiFetchOwnEmbeddingNode(nodeID, issuer, computeToken string) (apiEmbeddingSelfResponse, error) {
	var r apiEmbeddingSelfResponse
	err := apiPinnedRequest(http.MethodGet, issuer, "/api/embedding-nodes/"+urlSeg(nodeID)+"/self", nil, computeToken, &r)
	return r, err
}
func apiHoleComputeToken(code, nodeID string) (apiServiceTokenResponse, error) {
	var r apiServiceTokenResponse
	body := map[string]string{"code": code, "label": nodeID, "node_id": nodeID}
	// Ohne TOTP-Code dient das vorhandene Daemon-Token als Ausweis (User-Vorgabe
	// 01.08.2026: derselbe Rechner soll sich nicht zweimal authentifizieren).
	// Der Server nimmt es nur an, wenn sein scope 'daemon' bzw. 'daemon:*' ist;
	// ein compute-node-Token kann damit keine weiteren Knoten ausstellen.
	ausweis := ""
	if strings.TrimSpace(code) == "" {
		ausweis = apiToken()
	}
	err := apiPinnedRequest(http.MethodPost, apiDefaultTunnel, "/api/auth/service-token", body, ausweis, &r)
	if err != nil {
		return r, err
	}
	r.Issuer = apiDefaultTunnel
	if !r.Success || r.Token == "" || r.Scope != "compute-node:"+nodeID {
		return r, fmt.Errorf("Server hat kein passendes Compute-Token ausgestellt")
	}
	return r, nil
}

type apiVerifyResponse struct {
	Success   bool   `json:"success"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	Issuer    string `json:"-"`
}

func apiVerifyTOTP(code string) (apiVerifyResponse, error) {
	var r apiVerifyResponse
	err := apiPinnedRequest(http.MethodPost, apiDefaultTunnel, "/api/auth/verify", map[string]string{"code": code}, "", &r)
	if err != nil {
		return r, err
	}
	r.Issuer = apiDefaultTunnel
	if !r.Success || r.Token == "" {
		return r, fmt.Errorf("TOTP-Code wurde nicht akzeptiert")
	}
	return r, nil
}

func apiPinnedRequest(method, base, path string, body interface{}, token string, out interface{}) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, strings.TrimRight(base, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := apiHttpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fmt.Errorf("HTTP-Redirect %d abgelehnt", resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func apiSetEmbeddingLockAsAdmin(nodeID string, session apiVerifyResponse, locked bool) error {
	body := map[string]interface{}{"locked": locked, "reason": "Vom lokalen Tray gesetzt"}
	return apiPinnedRequest(http.MethodPatch, session.Issuer, "/api/embedding-nodes/"+urlSeg(nodeID)+"/lock", body, session.Token, nil)
}

// apiSetEmbeddingLockMitDaemonToken sperrt oder entsperrt einen Knoten mit dem
// vorhandenen Daemon-Token statt mit einer frisch per TOTP erzeugten Sitzung.
// Der Server laesst dafuer ausschliesslich Tokens mit scope 'daemon'/'daemon:*'
// zu — ein compute-node-Token wird abgewiesen, damit ein Knoten seine eigene
// Sperre nicht aufheben kann.
func apiSetEmbeddingLockMitDaemonToken(nodeID string, locked bool) error {
	tok := strings.TrimSpace(apiToken())
	if tok == "" {
		return fmt.Errorf("kein Synapse-Token vorhanden — bitte zuerst \"Mit Synapse verbinden\" ausführen")
	}
	body := map[string]interface{}{"locked": locked, "reason": "Vom lokalen Tray gesetzt"}
	return apiPinnedRequest(http.MethodPatch, apiDefaultTunnel, "/api/embedding-nodes/"+urlSeg(nodeID)+"/lock", body, tok, nil)
}

// speichereApiToken schreibt das Token als synapse_api_token in die config.json
// des FileWatcher-Daemons.
//
// Vorsichtsmassnahmen: die Datei wird als map[string]json.RawMessage gelesen, damit
// ALLE anderen Felder (port, projekte, synapse_api_url, ...) unveraendert erhalten
// bleiben — auch solche, die dieser Tray gar nicht kennt. Geschrieben wird in eine
// Temp-Datei und dann umbenannt, damit ein Absturz mittendrin die Config nicht
// zerreisst.
func speichereApiToken(token string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("Home-Verzeichnis nicht ermittelbar: %v", err)
	}
	dir := filepath.Join(home, ".synapse", "file-watcher")
	cfgPath := filepath.Join(dir, "config.json")

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("Konfigurationsordner nicht anlegbar: %v", err)
	}

	felder := map[string]json.RawMessage{}
	if data, readErr := os.ReadFile(cfgPath); readErr == nil {
		if jErr := json.Unmarshal(data, &felder); jErr != nil {
			// Lieber abbrechen als eine unlesbare Config ueberschreiben.
			return fmt.Errorf("config.json ist nicht lesbar (%v) — bitte pruefen, es wurde nichts geaendert", jErr)
		}
	}

	kodiert, err := json.Marshal(token)
	if err != nil {
		return err
	}
	felder["synapse_api_token"] = kodiert

	neu, err := json.MarshalIndent(felder, "", "  ")
	if err != nil {
		return err
	}
	neu = append(neu, '\n')

	tmp := cfgPath + ".tmp"
	if err := os.WriteFile(tmp, neu, 0o600); err != nil {
		return fmt.Errorf("Schreiben fehlgeschlagen: %v", err)
	}
	if err := os.Rename(tmp, cfgPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("Ersetzen der config.json fehlgeschlagen: %v", err)
	}
	return nil
}

// apiVerbindungPruefen testet das aktuell hinterlegte Token gegen /api/status.
// Liefert die antwortende Basis-Adresse zurueck, damit der Nutzer sieht WOHIN
// der Tray spricht — Tunnel oder lokale IP.
func apiVerbindungPruefen() (basis string, err error) {
	if apiToken() == "" {
		return "", fmt.Errorf("kein Token hinterlegt")
	}
	return apiRequest(http.MethodGet, "/api/status", nil)
}

// zeitLesbar macht aus einem ISO-Zeitstempel ein deutsches Datum. Bei
// unbekanntem Format wird der Rohwert durchgereicht.
func zeitLesbar(iso string) string {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999-07"} {
		if t, err := time.Parse(layout, iso); err == nil {
			return t.Local().Format("02.01.2006")
		}
	}
	return iso
}
