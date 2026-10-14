package main

// P8-T20: Fenster-Lebenszyklus headless mit dem Fyne-Testtreiber.
//
// Der glfw-Treiber beendet die App, sobald seine Fensterliste leer ist
// (destroyWindow: len(d.windows) == 0 -> d.Quit()). Der Testtreiber kennt diese
// Regel nicht, fuehrt aber dieselbe Fensterliste (AllWindows). Die Tests pruefen
// deshalb genau die Bedingung: nach dem Schliessen muss die Liste nicht leer sein.

import (
	"sync/atomic"
	"testing"

	"fyne.io/fyne/v2"
	fynetest "fyne.io/fyne/v2/test"
	"fyne.io/fyne/v2/widget"
)

func p8t20App(t *testing.T) fyne.App {
	t.Helper()
	vorher := myApp
	a := fynetest.NewApp()
	myApp = a
	p8t20Grund = len(a.Driver().AllWindows())
	t.Cleanup(func() {
		einzelFensterMu.Lock()
		einzelFenster = map[string]fyne.Window{}
		einzelFensterMu.Unlock()
		myApp = vorher
		a.Quit()
	})
	return a
}

// p8t20Grund: Fenster, die der Testtreiber schon vor dem Test fuehrt (geteilter
// Treiber); gezaehlt wird relativ dazu.
var p8t20Grund int

func p8t20Fenster(a fyne.App) int { return len(a.Driver().AllWindows()) - p8t20Grund }

func p8t20HatFenster(a fyne.App, w fyne.Window) bool {
	for _, x := range a.Driver().AllWindows() {
		if x == w {
			return true
		}
	}
	return false
}

func p8t20Esc(w fyne.Window) {
	w.Canvas().OnTypedKey()(&fyne.KeyEvent{Name: fyne.KeyEscape})
}

// Positivkontrolle: so sah es vor dem Fix aus — nach dem Schliessen des einzigen
// Fensters ist die Liste leer, der glfw-Treiber haette die App beendet.
func TestP8T20OhneAnkerWirdFensterlisteLeer(t *testing.T) {
	a := p8t20App(t)
	w := oeffneEinzelFenster("gpu", "GPU", func(fyne.Window) func() { return nil })
	w.Close()
	if n := p8t20Fenster(a); n != 0 {
		t.Fatalf("erwartet leere Fensterliste ohne Anker, gefunden %d", n)
	}
}

func TestP8T20SchliessenUndWiederOeffnenMitAnker(t *testing.T) {
	a := p8t20App(t)
	anker := legeAnkerFensterAn(a)

	aufgeraeumt := 0
	gebaut := 0
	bau := func(w fyne.Window) func() {
		gebaut++
		w.SetContent(widget.NewLabel("gpu"))
		return func() { aufgeraeumt++ }
	}

	erstes := oeffneEinzelFenster("gpu", "GPU", bau)
	// Zweiter Klick: kein zweites Fenster, nur nach vorn holen.
	if zweites := oeffneEinzelFenster("gpu", "GPU", bau); zweites != erstes || gebaut != 1 {
		t.Fatalf("zweites Oeffnen erzeugte ein neues Fenster (gebaut=%d)", gebaut)
	}
	if n := p8t20Fenster(a); n != 2 {
		t.Fatalf("erwartet Anker + GPU = 2 Fenster, gefunden %d", n)
	}

	erstes.Close()
	if aufgeraeumt != 1 {
		t.Fatalf("Aufraeumen lief %d-mal statt einmal", aufgeraeumt)
	}
	if einzelFensterOffen("gpu") {
		t.Fatal("geschlossenes Fenster steht noch in der Registry")
	}
	if n := p8t20Fenster(a); n != 1 || !p8t20HatFenster(a, anker) {
		t.Fatalf("nach dem Schliessen muss genau das Ankerfenster bleiben (glfw quittet bei 0), gefunden %d", n)
	}

	// Wieder oeffnen: frisches Fenster, Tray lebt.
	drittes := oeffneEinzelFenster("gpu", "GPU", bau)
	if drittes == erstes || gebaut != 2 || !einzelFensterOffen("gpu") {
		t.Fatalf("Wiederoeffnen nach dem Schliessen klappte nicht (gebaut=%d)", gebaut)
	}
	drittes.Close()
	if p8t20Fenster(a) != 1 {
		t.Fatal("Anker fehlt nach zweitem Schliessen")
	}
}

func TestP8T20EscSchliesstAusserBeiDialog(t *testing.T) {
	a := p8t20App(t)
	legeAnkerFensterAn(a)
	w := oeffneEinzelFenster("verbindung", "Verbindung", func(w fyne.Window) func() {
		w.SetContent(widget.NewLabel("x"))
		return nil
	})

	// Offener Dialog (Overlay): Esc gehoert dem Dialog, das Fenster bleibt.
	overlay := widget.NewLabel("Dialog")
	w.Canvas().Overlays().Add(overlay)
	p8t20Esc(w)
	if !einzelFensterOffen("verbindung") {
		t.Fatal("Esc schloss das Fenster, obwohl ein Dialog offen war")
	}
	w.Canvas().Overlays().Remove(overlay)

	// Andere Tasten tun nichts.
	w.Canvas().OnTypedKey()(&fyne.KeyEvent{Name: fyne.KeyReturn})
	if !einzelFensterOffen("verbindung") {
		t.Fatal("Enter schloss das Fenster")
	}

	p8t20Esc(w)
	if einzelFensterOffen("verbindung") {
		t.Fatal("Esc schloss das Fenster nicht")
	}
	if p8t20Fenster(a) != 1 {
		t.Fatal("nach Esc muss das Ankerfenster bleiben")
	}
}

func TestP8T20VersteckenUndWiederZeigen(t *testing.T) {
	a := p8t20App(t)
	w := a.NewWindow("Chat")
	var sichtbar atomic.Bool
	sichtbar.Store(true)
	versteckbaresFenster(w, &sichtbar)
	w.Show()

	p8t20Esc(w)
	if sichtbar.Load() {
		t.Fatal("Esc versteckte das Fenster nicht (sichtbar=true)")
	}
	if p8t20Fenster(a) != 1 {
		t.Fatal("verstecktes Fenster darf nicht zerstoert werden")
	}
	// Vor dem Fix blieb sichtbar beim Wiederoeffnen eines Chats false -> keine Live-Aktualisierung.
	zeigeVersteckt(w, &sichtbar)
	if !sichtbar.Load() {
		t.Fatal("zeigeVersteckt setzt sichtbar nicht zurueck")
	}
}

func TestP8T20AuswahlFolgtDemSchluessel(t *testing.T) {
	a := p8t20App(t)
	rows := [][]string{{"a1", "x"}, {"b2", "y"}, {"c3", "z"}}
	tab := neueTabelle([]string{"Agent", "Info"}, func() [][]string { return rows })
	w := a.NewWindow("Tabelle")
	w.SetContent(tab)
	w.Resize(fyne.NewSize(400, 300))

	var auswahl tabellenAuswahl
	gewaehlt := -1
	tab.OnSelected = func(id widget.TableCellID) {
		gewaehlt = id.Row
		auswahl.waehle(spaltenSchluessel(rows, 0), id.Row, id.Col)
	}
	tab.Select(widget.TableCellID{Row: 1, Col: 0})
	if auswahl.schluessel != "b2" {
		t.Fatalf("Auswahl merkt %q statt b2", auswahl.schluessel)
	}

	// Live-Refresh: eine neue Zeile kommt oben dazu, "b2" rutscht auf Index 2.
	rows = append([][]string{{"neu", "!"}}, rows...)
	tab.Refresh()
	auswahl.nachfuehren(tab, spaltenSchluessel(rows, 0))
	if gewaehlt != 2 || auswahl.schluessel != "b2" {
		t.Fatalf("Markierung folgte nicht dem Eintrag: Zeile %d, Schluessel %q", gewaehlt, auswahl.schluessel)
	}
	if idx := zeileZuSchluessel(spaltenSchluessel(rows, 0), auswahl.schluessel); rows[idx][0] != "b2" {
		t.Fatalf("Aktion traefe %q statt b2", rows[idx][0])
	}

	// Eintrag verschwindet: Auswahl wird aufgehoben, keine Aktion auf fremde Zeile.
	rows = [][]string{{"neu", "!"}}
	tab.Refresh()
	auswahl.nachfuehren(tab, spaltenSchluessel(rows, 0))
	if auswahl.schluessel != "" {
		t.Fatalf("Auswahl haelt verschwundenen Eintrag %q", auswahl.schluessel)
	}
}

func TestP8T20TabellenKopf(t *testing.T) {
	tab := neueTabelle([]string{"Zeit", "Agent"}, func() [][]string { return [][]string{{"1", "a"}} })
	if !tab.ShowHeaderRow || tab.CreateHeader == nil || tab.UpdateHeader == nil {
		t.Fatal("Tabelle ohne Kopfzeile")
	}
	kopf := tab.CreateHeader().(*widget.Label)
	tab.UpdateHeader(widget.TableCellID{Row: -1, Col: 1}, kopf)
	if kopf.Text != "Agent" {
		t.Fatalf("Kopf zeigt %q", kopf.Text)
	}
}

func TestP8T20Hilfsfunktionen(t *testing.T) {
	if !nahAmEnde(560, 400, 1000) || nahAmEnde(100, 400, 1000) {
		t.Fatal("nahAmEnde falsch")
	}
	k := spaltenSchluessel([][]string{{"z", "a", "f"}, {"z"}}, 0, 2)
	if k[0] != "z\x1ff" || k[1] != "z\x1f" {
		t.Fatalf("spaltenSchluessel: %q", k)
	}
	if zeileZuSchluessel(k, "") != -1 || zeileZuSchluessel(k, "z\x1f") != 1 {
		t.Fatal("zeileZuSchluessel falsch")
	}
	l := lesefeld("abc", true)
	if !l.Selectable || l.Wrapping != fyne.TextWrapWord || !l.TextStyle.Monospace {
		t.Fatal("lesefeld nicht markierbar/umbrechend")
	}
}
