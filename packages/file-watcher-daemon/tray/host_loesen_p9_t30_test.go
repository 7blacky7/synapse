package main

// P9-T30 Testphase: "Von diesem PC entfernen" und virtuelle Projekte im Tray — nur Fake-Transport (a9Setup), keine echte API.
import (
    "bytes"
    "context"
    "encoding/json"
    "io"
    "net/http"
    "reflect"
    "strings"
    "testing"
)

func TestP9T30VirtuelleProjekteAusProjektliste(t *testing.T) {
    a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
        if r.Method != http.MethodGet || r.URL.Path != "/api/projects" { t.Fatalf("unerwartet %s %s", r.Method, r.URL.Path) }
        return a9Response(r, 200, strings.NewReader(`{"success":true,"projects":["reverse-bibliothek","p9-t30"],"virtuelle_projekte":["reverse-bibliothek"]}`)), nil
    }))
    list, err := apiAssetProjects(context.Background())
    if err != nil || !reflect.DeepEqual(list.VirtuelleProjekte, []string{"reverse-bibliothek"}) { t.Fatalf("liste %+v %v", list, err) }
}

func TestP9T30HostLoesenVorschauDannAusfuehren(t *testing.T) {
    var bodies []map[string]interface{}
    a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
        if r.Method != http.MethodPost || r.URL.Path != "/api/projects/p9-t30/host-loesen" { t.Fatalf("unerwartet %s %s", r.Method, r.URL.Path) }
        raw, _ := io.ReadAll(r.Body)
        var in map[string]interface{}
        if err := json.Unmarshal(raw, &in); err != nil { t.Fatal(err) }
        bodies = append(bodies, in)
        out := map[string]interface{}{"success": true, "virtuell": false,
            "entfernt": map[string]interface{}{"registry_zeile": map[string]interface{}{"hostname": "pc-t30", "path": "/home/x/dev/p9-t30"}, "tray_bindung_abschalten": true},
            "bleibt": map[string]interface{}{"registry": []interface{}{map[string]interface{}{"hostname": "rest-api", "path": "/virtual/rest-api"}}},
            "hinweis_lokal": "Lokale Ordner entfernt Synapse NICHT: /home/x/dev/p9-t30"}
        if in["vorschau"] == true { out["status"] = "vorschau" } else { out["status"] = "geloest"; out["ergebnis"] = map[string]interface{}{"daemon_job_id": "job-p9-t30"} }
        data, _ := json.Marshal(out)
        return a9Response(r, 200, bytes.NewReader(data)), nil
    }))
    ctx := context.Background()
    v, err := apiAssetHostLoesen(ctx, "p9-t30", "pc-t30", true)
    if err != nil || v.Status != "vorschau" || v.Ergebnis != nil { t.Fatalf("vorschau %+v %v", v, err) }
    text := assetSyncHostLoesenText(v)
    for _, teil := range []string{"pc-t30 → /home/x/dev/p9-t30", "Bleibt: rest-api", "kein Deaktivieren", "Lokale Ordner entfernt Synapse NICHT"} {
        if !strings.Contains(text, teil) { t.Fatalf("Vorschautext ohne %q:\n%s", teil, text) }
    }
    if strings.Contains(text, "Auftrag an den Daemon") { t.Fatal("Vorschau nennt schon einen Auftrag") }
    x, err := apiAssetHostLoesen(ctx, "p9-t30", "pc-t30", false)
    if err != nil || x.Status != "geloest" || x.Ergebnis == nil || x.Ergebnis.DaemonJobID != "job-p9-t30" { t.Fatalf("ausfuehren %+v %v", x, err) }
    if !strings.Contains(assetSyncHostLoesenText(x), "Auftrag an den Daemon: job-p9-t30") { t.Fatal("Ergebnistext ohne Auftrag") }
    want := []map[string]interface{}{{"hostname": "pc-t30", "vorschau": true}, {"hostname": "pc-t30", "vorschau": false}}
    if !reflect.DeepEqual(bodies, want) { t.Fatalf("bodies %v", bodies) }
}

func TestP9T30HostLoesenFehler(t *testing.T) {
    calls := 0
    a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
        calls++
        return a9Response(r, 200, strings.NewReader(`{"success":false}`)), nil
    }))
    if _, err := apiAssetHostLoesen(context.Background(), "p9-t30", "  ", true); err == nil || calls != 0 { t.Fatalf("leerer Host angenommen (calls=%d)", calls) }
    if _, err := apiAssetHostLoesen(context.Background(), "p9-t30", "pc-t30", true); err == nil { t.Fatal("success:false angenommen") }
    leer := assetSyncHostLoesenText(apiHostLoesen{})
    if !strings.Contains(leer, "Keine Zuordnung dieses PCs") { t.Fatalf("Text ohne Zeile: %s", leer) }
}
