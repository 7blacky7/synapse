package main

// P9-T31 Testphase (TP-B, claude-tpb2): Lösch-Code im Tray — nur Fake-Transport (a9Setup), keine echte API,
// kein echter Daemon, synthetische Namen t31-tray / pc-t31-tray.
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestP9T31LoeschCodeNormieren(t *testing.T) {
	gut := map[string]string{"123456": "123456", " 123 456 ": "123456", "123-456": "123456", "012345": "012345", "\t000 001": "000001"}
	for roh, want := range gut {
		if got, ok := loeschCodeNormieren(roh); !ok || got != want {
			t.Fatalf("%q -> %q %v, erwartet %q", roh, got, ok, want)
		}
	}
	for _, roh := range []string{"", "12345", "1234567", "12a456", "１２３４５６", "123_456", "12 34 5"} {
		if got, ok := loeschCodeNormieren(roh); ok {
			t.Fatalf("%q faelschlich angenommen: %q", roh, got)
		}
	}
}

func TestP9T31VorschauDannAusfuehren(t *testing.T) {
	var aufrufe []string
	var bodies []map[string]interface{}
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		aufrufe = append(aufrufe, r.Method+" "+r.URL.EscapedPath())
		raw, _ := io.ReadAll(r.Body)
		var in map[string]interface{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &in); err != nil {
				t.Fatal(err)
			}
		}
		bodies = append(bodies, in)
		var out string
		switch r.URL.EscapedPath() {
		case "/api/projects/t31-tray/loeschen/vorschau":
			out = `{"success":true,"status":"vorschau","loesch_auftrag_id":"0b8f2c1e-1111-4222-8333-944455556666","gueltig_bis":"2026-10-14T15:00:00.000Z",
			"project":"t31-tray","hostname":"pc-t31-tray","umfang":"komplett","ordner":{"hostname":"pc-t31-tray","pfad":"/home/x/dev/t31-tray"},
			"zentral":{"tabellen":[{"tabelle":"memories","gruppe":"wissen","anzahl":3},{"tabelle":"code_files","gruppe":"code_index","anzahl":12},{"tabelle":"thoughts","gruppe":"wissen","anzahl":0}],
			"kaskade":[{"tabelle":"agent_event_acks","gruppe":"kaskade:agent_events","anzahl":2}],"summe_zeilen":17,
			"qdrant":[{"collection":"project_t31-tray_code","punkte":40},{"collection":"project_t31-tray_media","punkte":null}],
			"projekt_db":{"vorhanden":true,"database":"t31_tray","wird_geloescht":false,"gruende":["Projekt-DB-Konfiguration fehlt auf der API — bleibt."]}},
			"bleibt":{"protokolle":[{"tabelle":"tool_calls","gruppe":"protokoll","anzahl":9}],"hinweis":"Protokolle bleiben als Audit."},"blockiert":[]}`
		case "/api/loesch-auftraege/0b8f2c1e-1111-4222-8333-944455556666/ausfuehren":
			out = `{"success":true,"status":"geloescht","ordner_hinweis":"Der Daemon von \"pc-t31-tray\" loescht /home/x/dev/t31-tray beim naechsten Abruf.",
			"geloescht":{"pg":{"summe":17,"tabellen":[{"tabelle":"memories","anzahl":3}]},"qdrant":[{"collection":"project_t31-tray_code","geloescht":true},{"collection":"project_t31-tray_media","geloescht":false}],"projekt_db":{"vorhanden":true,"geloescht":false}}}`
		default:
			t.Fatalf("unerwartet %s %s", r.Method, r.URL.EscapedPath())
		}
		return a9Response(r, 200, strings.NewReader(out)), nil
	}))
	ctx := context.Background()
	v, err := apiProjektLoeschenVorschau(ctx, "t31-tray", "pc-t31-tray", "komplett")
	if err != nil || v.AuftragID == nil || *v.AuftragID != "0b8f2c1e-1111-4222-8333-944455556666" || len(v.Blockiert) != 0 {
		t.Fatalf("vorschau %+v %v", v, err)
	}
	text := loeschVorschauText(v)
	for _, teil := range []string{
		"Projekt: t31-tray · Rechner: pc-t31-tray · Umfang: komplett",
		"Ordner auf diesem PC wird gelöscht: /home/x/dev/t31-tray",
		"Synapse-Daten (17 Zeilen):",
		"  memories: 3", "  code_files: 12", "  agent_event_acks: 2",
		"Vektor-Collection project_t31-tray_code: 40 Punkte",
		"Vektor-Collection project_t31-tray_media: ? Punkte",
		"Projekt-DB bleibt: Projekt-DB-Konfiguration fehlt",
		"Bleibt: Protokolle bleiben als Audit.",
		"Auftrag gültig bis 2026-10-14T15:00:00.000Z",
	} {
		if !strings.Contains(text, teil) {
			t.Fatalf("Vorschautext ohne %q:\n%s", teil, text)
		}
	}
	if strings.Contains(text, "thoughts: 0") {
		t.Fatalf("Nullzeilen gehoeren nicht in die Vorschau:\n%s", text)
	}
	code, ok := loeschCodeNormieren(" 012 345 ")
	if !ok {
		t.Fatal("Code nicht normiert")
	}
	r, err := apiLoeschAuftragAusfuehren(ctx, *v.AuftragID, code)
	if err != nil || r.Status != "geloescht" {
		t.Fatalf("ausfuehren %+v %v", r, err)
	}
	erg := loeschErgebnisText(r)
	for _, teil := range []string{"Status: geloescht", "Gelöschte Zeilen in Synapse: 17", "project_t31-tray_code: gelöscht", "project_t31-tray_media: NICHT gelöscht", "loescht /home/x/dev/t31-tray"} {
		if !strings.Contains(erg, teil) {
			t.Fatalf("Ergebnistext ohne %q:\n%s", teil, erg)
		}
	}
	wantAufrufe := []string{"POST /api/projects/t31-tray/loeschen/vorschau", "POST /api/loesch-auftraege/0b8f2c1e-1111-4222-8333-944455556666/ausfuehren"}
	if !reflect.DeepEqual(aufrufe, wantAufrufe) {
		t.Fatalf("aufrufe %v", aufrufe)
	}
	wantBodies := []map[string]interface{}{{"hostname": "pc-t31-tray", "umfang": "komplett"}, {"loesch_code": "012345"}}
	if !reflect.DeepEqual(bodies, wantBodies) {
		t.Fatalf("bodies %v", bodies)
	}
}

func TestP9T31VorschauBlockiertUndRechnerUmfang(t *testing.T) {
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		return a9Response(r, 200, strings.NewReader(`{"success":false,"status":"blockiert","loesch_auftrag_id":null,"project":"t31-tray","hostname":"pc-t31-tray","umfang":"rechner",
		"ordner":null,"zentral":null,"rechner_daten":{"tabellen":[{"tabelle":"projects","gruppe":"registry","anzahl":1}]},
		"bleibt":{"hinweis":"Zentrale Synapse-Daten bleiben."},"blockiert":[{"grund":"kein_loesch_token","detail":"Fuer Rechner \"pc-t31-tray\" ist kein Loesch-Code eingerichtet."}]}`)), nil
	}))
	v, err := apiProjektLoeschenVorschau(context.Background(), "t31-tray", "pc-t31-tray", "rechner")
	if err != nil || v.AuftragID != nil || v.Success {
		t.Fatalf("blockierte Vorschau %+v %v", v, err)
	}
	text := loeschVorschauText(v)
	for _, teil := range []string{"Zuordnung dieses PCs:", "  projects: 1", "BLOCKIERT (kein_loesch_token): Fuer Rechner", "Bleibt: Zentrale Synapse-Daten bleiben."} {
		if !strings.Contains(text, teil) {
			t.Fatalf("Text ohne %q:\n%s", teil, text)
		}
	}
	if strings.Contains(text, "Synapse-Daten (") || strings.Contains(text, "Ordner auf diesem PC") {
		t.Fatalf("rechner-Umfang zeigt zentrale Daten/Ordner:\n%s", text)
	}
}

func TestP9T31Fehlertexte(t *testing.T) {
	type antwort struct {
		status int
		body   string
	}
	var naechste antwort
	aufrufe := 0
	a9Setup(t, a9RoundTrip(func(r *http.Request) (*http.Response, error) {
		aufrufe++
		return a9Response(r, naechste.status, strings.NewReader(naechste.body)), nil
	}))
	ctx := context.Background()
	faelle := []struct {
		name string
		a    antwort
		lauf func() error
		want string
	}{
		{"403 mit API-Meldung", antwort{403, `{"success":false,"error":{"code":"code_ungueltig","message":"Loesch-Code falsch, abgelaufen oder schon benutzt (Rechner \"pc-t31-tray\")."}}`},
			func() error { _, e := apiLoeschAuftragAusfuehren(ctx, "a1", "123456"); return e }, "Loesch-Code falsch, abgelaufen oder schon benutzt"},
		{"403 ohne Body", antwort{403, ``}, func() error { _, e := apiLoeschAuftragAusfuehren(ctx, "a1", "123456"); return e }, "Abgelehnt (Code falsch oder Zugang nicht berechtigt)"},
		{"429", antwort{429, ``}, func() error { _, e := apiLoeschAuftragAusfuehren(ctx, "a1", "123456"); return e }, "Zu viele falsche Codes"},
		{"409", antwort{409, `kein json`}, func() error { _, e := apiLoeschAuftragAusfuehren(ctx, "a1", "123456"); return e }, "Auftrag nicht mehr gültig — bitte neue Vorschau"},
		{"409 umfang_geaendert", antwort{409, `{"success":false,"error":{"code":"umfang_geaendert","message":"Der Loesch-Umfang hat sich seit der Vorschau geaendert"}}`},
			func() error { _, e := apiLoeschAuftragAusfuehren(ctx, "a1", "123456"); return e }, "Der Loesch-Umfang hat sich seit der Vorschau geaendert"},
		{"200 success:false", antwort{200, `{"success":false}`}, func() error { _, e := apiLoeschAuftragAusfuehren(ctx, "a1", "123456"); return e }, "Löschen wurde abgelehnt"},
		{"Einrichten ohne QR", antwort{200, `{"success":true,"hostname":"pc-t31-tray"}`}, func() error { _, e := apiLoeschTokenEinrichten(ctx, "111111"); return e }, "Einrichtung wurde abgelehnt"},
		{"Einrichten Login falsch", antwort{403, `{"success":false,"error":{"code":"login_code_ungueltig","message":"Login-Code (Synapse-Anmeldung) falsch — Einrichtung abgelehnt."}}`},
			func() error { _, e := apiLoeschTokenEinrichten(ctx, "111111"); return e }, "Login-Code (Synapse-Anmeldung) falsch"},
		{"Bestaetigen nicht eingerichtet", antwort{200, `{"success":true,"eingerichtet":false}`}, func() error { _, e := apiLoeschTokenBestaetigen(ctx, "123456"); return e }, "Bestätigung wurde abgelehnt"},
	}
	for _, f := range faelle {
		naechste = f.a
		err := f.lauf()
		if err == nil || !strings.Contains(err.Error(), f.want) {
			t.Fatalf("%s: Fehler %v, erwartet %q", f.name, err, f.want)
		}
		if strings.Contains(err.Error(), "123456") || strings.Contains(err.Error(), "111111") {
			t.Fatalf("%s: Fehlertext nennt den Code: %v", f.name, err)
		}
	}
	if aufrufe != len(faelle) {
		t.Fatalf("4xx darf nicht auf weitere Adressen wiederholt werden: %d Aufrufe fuer %d Faelle", aufrufe, len(faelle))
	}
	naechste = antwort{200, `{"success":true,"hostname":"pc-t31-tray","eingerichtet":true,"bestaetigt_at":"2026-10-14T14:00:00Z","einrichtung_offen":false}`}
	st, err := apiLoeschTokenStatusHolen(ctx)
	if err != nil || !st.Eingerichtet || st.Hostname != "pc-t31-tray" {
		t.Fatalf("status %+v %v", st, err)
	}
}

func TestP9T31QRBild(t *testing.T) {
	if _, err := loeschQRBild("otpauth://totp/x?secret=ABC"); err == nil {
		t.Fatal("Nicht-Bild-URI angenommen (Geheimnis darf nie als Text im Dialog landen)")
	}
	if _, err := loeschQRBild("data:image/png;base64,%%%"); err == nil {
		t.Fatal("kaputtes Base64 angenommen")
	}
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	bild, err := loeschQRBild("data:image/png;base64," + base64.StdEncoding.EncodeToString(png))
	if err != nil || bild == nil {
		t.Fatalf("QR-Bild %v", err)
	}
	if min := bild.MinSize(); min.Width < 256 || min.Height < 256 {
		t.Fatalf("QR zu klein: %v", min)
	}
}
