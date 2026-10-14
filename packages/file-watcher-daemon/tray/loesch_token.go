package main

// P9-T31: Rechnergebundener Loesch-Code im Tray.
// - "Loesch-Code einrichten": Login-Code (Synapse-Anmeldung) -> QR-Code fuer die Authenticator-App -> erster Code bestaetigt.
// - "Projekt löschen …": Umfang wählen -> Vorschau mit Zählung -> Lösch-Code aus der App -> Ausführen.
// Auch der User selbst muss den Lösch-Code eingeben (Schutz vor Fehlklick, thought a78f5248). Der Code geht nur an
// die API, wird nirgends gespeichert oder protokolliert.
import (
    "bytes"
    "context"
    "encoding/base64"
    "encoding/json"
    "errors"
    "fmt"
    "net/http"
    "sort"
    "strings"
    "time"

    "fyne.io/fyne/v2"
    "fyne.io/fyne/v2/canvas"
    "fyne.io/fyne/v2/container"
    "fyne.io/fyne/v2/dialog"
    "fyne.io/fyne/v2/widget"
)

type apiLoeschTokenStatus struct {
    Success bool `json:"success"`
    Hostname string `json:"hostname"`
    Eingerichtet bool `json:"eingerichtet"`
    BestaetigtAt *string `json:"bestaetigt_at"`
    EinrichtungOffen bool `json:"einrichtung_offen"`
}
type apiLoeschTokenEinrichtung struct {
    Success bool `json:"success"`
    Hostname string `json:"hostname"`
    QR string `json:"qr"`
    ErsetztBestehendes bool `json:"ersetzt_bestehendes"`
    Hinweis string `json:"hinweis"`
}
type apiLoeschZeile struct {
    Tabelle string `json:"tabelle"`
    Gruppe string `json:"gruppe"`
    Anzahl int64 `json:"anzahl"`
}
type apiLoeschVorschau struct {
    Success bool `json:"success"`
    Status string `json:"status"`
    AuftragID *string `json:"loesch_auftrag_id"`
    GueltigBis string `json:"gueltig_bis"`
    Project string `json:"project"`
    Hostname string `json:"hostname"`
    Umfang string `json:"umfang"`
    Ordner *struct { Hostname string `json:"hostname"`; Pfad string `json:"pfad"` } `json:"ordner"`
    Zentral *struct {
        Tabellen []apiLoeschZeile `json:"tabellen"`
        Kaskade []apiLoeschZeile `json:"kaskade"`
        Summe int64 `json:"summe_zeilen"`
        Qdrant []struct { Collection string `json:"collection"`; Punkte *int64 `json:"punkte"` } `json:"qdrant"`
        ProjektDB struct {
            Vorhanden bool `json:"vorhanden"`
            Database string `json:"database"`
            WirdGeloescht bool `json:"wird_geloescht"`
            Gruende []string `json:"gruende"`
        } `json:"projekt_db"`
    } `json:"zentral"`
    RechnerDaten *struct { Tabellen []apiLoeschZeile `json:"tabellen"` } `json:"rechner_daten"`
    Bleibt struct {
        Protokolle []apiLoeschZeile `json:"protokolle"`
        Hinweis string `json:"hinweis"`
    } `json:"bleibt"`
    Blockiert []struct { Grund string `json:"grund"`; Detail string `json:"detail"` } `json:"blockiert"`
}
type apiLoeschErgebnis struct {
    Success bool `json:"success"`
    Status string `json:"status"`
    OrdnerHinweis string `json:"ordner_hinweis"`
    Geloescht struct {
        PG struct { Summe int64 `json:"summe"`; Tabellen []apiLoeschZeile `json:"tabellen"` } `json:"pg"`
        Qdrant []struct { Collection string `json:"collection"`; Geloescht bool `json:"geloescht"` } `json:"qdrant"`
        ProjektDB map[string]interface{} `json:"projekt_db"`
    } `json:"geloescht"`
}

// loeschAPIFehler macht aus der API-Fehlerantwort {error:{code,message}} einen lesbaren Text (ohne Code-Inhalt).
func loeschAPIFehler(err error) error {
    var he *apiBinaryHTTPError
    if !errors.As(err, &he) { return err }
    var body struct { Error struct { Code string `json:"code"`; Message string `json:"message"` } `json:"error"` }
    if json.Unmarshal([]byte(he.Detail), &body) == nil && body.Error.Message != "" { return fmt.Errorf("%s", body.Error.Message) }
    switch he.Status {
    case http.StatusForbidden: return fmt.Errorf("Abgelehnt (Code falsch oder Zugang nicht berechtigt)")
    case http.StatusTooManyRequests: return fmt.Errorf("Zu viele falsche Codes — bitte später erneut versuchen")
    case http.StatusConflict: return fmt.Errorf("Auftrag nicht mehr gültig — bitte neue Vorschau")
    }
    return err
}

func apiLoeschTokenStatusHolen(ctx context.Context) (apiLoeschTokenStatus, error) {
    var r apiLoeschTokenStatus
    err := apiAssetJSON(ctx, http.MethodGet, "/api/loesch-token/status", nil, &r)
    return r, loeschAPIFehler(err)
}
func apiLoeschTokenEinrichten(ctx context.Context, loginCode string) (apiLoeschTokenEinrichtung, error) {
    var r apiLoeschTokenEinrichtung
    err := apiAssetJSON(ctx, http.MethodPost, "/api/loesch-token/einrichten", map[string]interface{}{"login_code": loginCode}, &r)
    if err == nil && (!r.Success || r.QR == "") { err = fmt.Errorf("Einrichtung wurde abgelehnt") }
    return r, loeschAPIFehler(err)
}
func apiLoeschTokenBestaetigen(ctx context.Context, code string) (apiLoeschTokenStatus, error) {
    var r apiLoeschTokenStatus
    err := apiAssetJSON(ctx, http.MethodPost, "/api/loesch-token/bestaetigen", map[string]interface{}{"code": code}, &r)
    if err == nil && (!r.Success || !r.Eingerichtet) { err = fmt.Errorf("Bestätigung wurde abgelehnt") }
    return r, loeschAPIFehler(err)
}
func apiProjektLoeschenVorschau(ctx context.Context, project, host, umfang string) (apiLoeschVorschau, error) {
    var r apiLoeschVorschau
    err := apiAssetJSON(ctx, http.MethodPost, "/api/projects/"+urlSeg(project)+"/loeschen/vorschau", map[string]interface{}{"hostname": host, "umfang": umfang}, &r)
    return r, loeschAPIFehler(err)
}
func apiLoeschAuftragAusfuehren(ctx context.Context, auftragID, code string) (apiLoeschErgebnis, error) {
    var r apiLoeschErgebnis
    err := apiAssetJSON(ctx, http.MethodPost, "/api/loesch-auftraege/"+urlSeg(auftragID)+"/ausfuehren", map[string]interface{}{"loesch_code": code}, &r)
    if err == nil && !r.Success { err = fmt.Errorf("Löschen wurde abgelehnt") }
    return r, loeschAPIFehler(err)
}

// loeschCodeNormieren: nur 6 Ziffern (Leerzeichen/Bindestriche erlaubt).
func loeschCodeNormieren(roh string) (string, bool) {
    code := strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(strings.TrimSpace(roh))
    if len(code) != 6 { return "", false }
    for _, c := range code { if c < '0' || c > '9' { return "", false } }
    return code, true
}

func loeschZeilenText(zeilen []apiLoeschZeile) []string {
    sort.SliceStable(zeilen, func(i, j int) bool { return zeilen[i].Gruppe < zeilen[j].Gruppe })
    out := []string{}
    for _, z := range zeilen { if z.Anzahl > 0 { out = append(out, fmt.Sprintf("  %s: %d", z.Tabelle, z.Anzahl)) } }
    return out
}

func loeschVorschauText(v apiLoeschVorschau) string {
    zeilen := []string{fmt.Sprintf("Projekt: %s · Rechner: %s · Umfang: %s", v.Project, v.Hostname, v.Umfang)}
    if v.Ordner != nil { zeilen = append(zeilen, "Ordner auf diesem PC wird gelöscht: "+v.Ordner.Pfad) }
    if v.Zentral != nil {
        zeilen = append(zeilen, fmt.Sprintf("Synapse-Daten (%d Zeilen):", v.Zentral.Summe))
        zeilen = append(zeilen, loeschZeilenText(v.Zentral.Tabellen)...)
        zeilen = append(zeilen, loeschZeilenText(v.Zentral.Kaskade)...)
        for _, q := range v.Zentral.Qdrant {
            p := "?"
            if q.Punkte != nil { p = fmt.Sprint(*q.Punkte) }
            zeilen = append(zeilen, "  Vektor-Collection "+q.Collection+": "+p+" Punkte")
        }
        if v.Zentral.ProjektDB.Vorhanden {
            if v.Zentral.ProjektDB.WirdGeloescht { zeilen = append(zeilen, "  Projekt-DB "+v.Zentral.ProjektDB.Database+" wird entfernt")
            } else { zeilen = append(zeilen, "  Projekt-DB bleibt: "+strings.Join(v.Zentral.ProjektDB.Gruende, " ")) }
        }
    }
    if v.RechnerDaten != nil { zeilen = append(zeilen, "Zuordnung dieses PCs:"); zeilen = append(zeilen, loeschZeilenText(v.RechnerDaten.Tabellen)...) }
    if v.Bleibt.Hinweis != "" { zeilen = append(zeilen, "Bleibt: "+v.Bleibt.Hinweis) }
    for _, b := range v.Blockiert { zeilen = append(zeilen, "BLOCKIERT ("+b.Grund+"): "+b.Detail) }
    if v.GueltigBis != "" { zeilen = append(zeilen, "Auftrag gültig bis "+v.GueltigBis) }
    return strings.Join(zeilen, "\n")
}

func loeschErgebnisText(r apiLoeschErgebnis) string {
    zeilen := []string{"Status: " + r.Status, fmt.Sprintf("Gelöschte Zeilen in Synapse: %d", r.Geloescht.PG.Summe)}
    for _, q := range r.Geloescht.Qdrant {
        s := "gelöscht"
        if !q.Geloescht { s = "NICHT gelöscht" }
        zeilen = append(zeilen, "Vektor-Collection "+q.Collection+": "+s)
    }
    if r.OrdnerHinweis != "" { zeilen = append(zeilen, r.OrdnerHinweis) }
    return strings.Join(zeilen, "\n")
}

func loeschQRBild(dataURL string) (fyne.CanvasObject, error) {
    const praefix = "data:image/png;base64,"
    if !strings.HasPrefix(dataURL, praefix) { return nil, fmt.Errorf("QR-Code im unerwarteten Format") }
    png, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, praefix))
    if err != nil { return nil, err }
    img := canvas.NewImageFromReader(bytes.NewReader(png), "loesch-code-qr.png")
    img.FillMode = canvas.ImageFillContain
    img.SetMinSize(fyne.NewSize(256, 256))
    return img, nil
}

// zeigeLoeschTokenEinrichten: Login-Code -> QR -> erster Code. Nur für diesen PC (Daemon-Zugang des Trays).
func zeigeLoeschTokenEinrichten(ctx context.Context, window fyne.Window, fertig func()) {
    login := widget.NewPasswordEntry()
    login.SetPlaceHolder("6-stelliger Login-Code (Synapse-Anmeldung)")
    info := assetSyncLabel("Der Lösch-Code ist ein EIGENER Eintrag in Ihrer Authenticator-App, nur für diesen PC. Zum Einrichten bestätigen Sie mit Ihrem Synapse-Login-Code.")
    dialog.ShowCustomConfirm("Lösch-Code einrichten", "Weiter", "Abbrechen", container.NewVBox(info, login), func(ok bool) {
        if !ok { return }
        code, gueltig := loeschCodeNormieren(login.Text)
        if !gueltig { dialog.ShowError(fmt.Errorf("Login-Code muss aus 6 Ziffern bestehen"), window); return }
        go func() {
            c, stop := context.WithTimeout(ctx, 30*time.Second); defer stop()
            e, err := apiLoeschTokenEinrichten(c, code)
            fyne.Do(func() {
                if ctx.Err() != nil { return }
                if err != nil { dialog.ShowError(err, window); return }
                bild, bildErr := loeschQRBild(e.QR)
                if bildErr != nil { dialog.ShowError(bildErr, window); return }
                erster := widget.NewEntry()
                erster.SetPlaceHolder("Erster Code aus der App (6 Ziffern)")
                text := "QR-Code mit der Authenticator-App scannen (Eintrag Synapse-Loeschen:" + e.Hostname + ") und den angezeigten Code eingeben."
                if e.ErsetztBestehendes { text += "\nDer bisherige Lösch-Code dieses PCs gilt bis zur Bestätigung weiter." }
                dialog.ShowCustomConfirm("Lösch-Code bestätigen", "Bestätigen", "Abbrechen", container.NewVBox(assetSyncLabel(text), bild, erster), func(ok bool) {
                    if !ok { return }
                    c2, gueltig2 := loeschCodeNormieren(erster.Text)
                    if !gueltig2 { dialog.ShowError(fmt.Errorf("Code muss aus 6 Ziffern bestehen"), window); return }
                    go func() {
                        cc, stop2 := context.WithTimeout(ctx, 30*time.Second); defer stop2()
                        _, err2 := apiLoeschTokenBestaetigen(cc, c2)
                        fyne.Do(func() {
                            if ctx.Err() != nil { return }
                            if err2 != nil { dialog.ShowError(err2, window); return }
                            dialog.ShowInformation("Lösch-Code eingerichtet", "Der Lösch-Code für diesen PC ist aktiv.", window)
                            if fertig != nil { fertig() }
                        })
                    }()
                }, window)
            })
        }()
    }, window)
}

// zeigeProjektLoeschen: Umfang -> Vorschau -> Lösch-Code -> Ausführen. Auch für den User Pflicht (kein Ein-Klick-Löschen).
func zeigeProjektLoeschen(ctx context.Context, window fyne.Window, project, host string, fertig func()) {
    umfaenge := map[string]string{
        "Von diesem PC und aus Synapse löschen": "komplett",
        "Nur den Ordner auf diesem PC löschen": "rechner",
        "Nur die Synapse-Daten löschen (kein PC mehr gebunden)": "zentral",
    }
    auswahl := widget.NewRadioGroup([]string{"Von diesem PC und aus Synapse löschen", "Nur den Ordner auf diesem PC löschen", "Nur die Synapse-Daten löschen (kein PC mehr gebunden)"}, nil)
    auswahl.SetSelected("Von diesem PC und aus Synapse löschen")
    dialog.ShowCustomConfirm("Projekt löschen: "+project, "Vorschau", "Abbrechen", container.NewVBox(assetSyncLabel("Was soll gelöscht werden? Zuerst kommt eine Vorschau, gelöscht wird erst mit Ihrem Lösch-Code."), auswahl), func(ok bool) {
        if !ok { return }
        umfang := umfaenge[auswahl.Selected]
        if umfang == "" { return }
        go func() {
            c, stop := context.WithTimeout(ctx, 60*time.Second); defer stop()
            v, err := apiProjektLoeschenVorschau(c, project, host, umfang)
            fyne.Do(func() {
                if ctx.Err() != nil { return }
                if err != nil { dialog.ShowError(err, window); return }
                text := assetSyncLabel(loeschVorschauText(v))
                scroll := container.NewVScroll(text)
                scroll.SetMinSize(fyne.NewSize(620, 320))
                if !v.Success || v.AuftragID == nil || len(v.Blockiert) > 0 {
                    dialog.ShowCustom("Löschen nicht möglich", "Schließen", scroll, window)
                    return
                }
                auftrag := *v.AuftragID
                code := widget.NewEntry()
                code.SetPlaceHolder("Lösch-Code aus der App (Synapse-Loeschen:" + host + ")")
                dialog.ShowCustomConfirm("Endgültig löschen?", "Löschen", "Abbrechen", container.NewBorder(nil, code, nil, nil, scroll), func(ok bool) {
                    if !ok { return }
                    wert, gueltig := loeschCodeNormieren(code.Text)
                    if !gueltig { dialog.ShowError(fmt.Errorf("Lösch-Code muss aus 6 Ziffern bestehen"), window); return }
                    go func() {
                        cc, stop2 := context.WithTimeout(ctx, 5*time.Minute); defer stop2()
                        r, err2 := apiLoeschAuftragAusfuehren(cc, auftrag, wert)
                        fyne.Do(func() {
                            if ctx.Err() != nil { return }
                            if err2 != nil { dialog.ShowError(err2, window); return }
                            dialog.ShowInformation("Projekt gelöscht", loeschErgebnisText(r), window)
                            if fertig != nil { fertig() }
                        })
                    }()
                }, window)
            })
        }()
    }, window)
}
