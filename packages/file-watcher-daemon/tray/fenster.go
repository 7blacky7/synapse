package main

// P8-T20: gemeinsamer Lebenszyklus aller Tray-Fenster.
//
// ABSTURZURSACHE (belegt an fyne v2.7.4, internal/driver/glfw/loop.go,
// destroyWindow): Nach dem Zerstoeren eines Fensters gilt
//
//	if len(d.windows) == 0 { d.Quit() }
//
// Das GPU-, Verbindungs-, Asset-Sync- und Tool-Call-Fenster werden beim
// Schliessen zerstoert. War es das einzige Fenster (Projekt- und Chatfenster
// werden nur versteckt und zaehlen nur, wenn sie vorher einmal offen waren),
// beendete Fyne seine Event-Loop: myApp.Run() kehrte zurueck, main() rief
// end() fuer systray auf und der Tray-Prozess war weg — der Daemon lief weiter.
//
// FIX: ein Ankerfenster, das nie gezeigt wird. Ohne Show() bekommt es keinen
// Viewport, die Loop ueberspringt es, es bleibt aber in der Fensterliste — die
// Liste wird also nie leer. Beendet wird der Tray nur noch ueber "Beenden"
// (quitApp -> systray.Quit -> myApp.Quit).

import (
	"sync"
	"sync/atomic"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/widget"
)

// ankerFenster haelt die Fyne-Loop am Leben (siehe oben). Nie zeigen, nie schliessen.
var ankerFenster fyne.Window

// fyneTreiberInitialisiert wird erst nach dem ersten gezeigten User-Fenster gesetzt.
// Vorher kann app.Quit im GLFW-Treiber wegen fehlendem Kontext paniken.
var fyneTreiberInitialisiert atomic.Bool

func zeigeFyneFenster(w fyne.Window) {
	w.Show()
	fyneTreiberInitialisiert.Store(true)
}

// legeAnkerFensterAn erzeugt das unsichtbare Ankerfenster.
func legeAnkerFensterAn(a fyne.App) fyne.Window {
	w := a.NewWindow("Synapse-Tray")
	// Sollte ein Fenstermanager es doch je zeigen und schliessen wollen: nur verstecken.
	w.SetCloseIntercept(func() { w.Hide() })
	return w
}

var (
	einzelFensterMu sync.Mutex
	einzelFenster   = map[string]fyne.Window{}
)

// oeffneEinzelFenster zeigt das Fenster mit diesem Schluessel. Ist es schon offen,
// wird es nur nach vorn geholt (vorher entstand je Klick ein weiteres Fenster).
// bau fuellt das neue Fenster (Inhalt, Groesse) und liefert optional eine
// Aufraeumfunktion, die beim Schliessen laeuft. bau darf weder Show() noch
// SetOnClosed() aufrufen. Muss auf dem UI-Faden laufen (fyne.Do).
func oeffneEinzelFenster(schluessel, titel string, bau func(fyne.Window) func()) fyne.Window {
	einzelFensterMu.Lock()
	if w, ok := einzelFenster[schluessel]; ok {
		einzelFensterMu.Unlock()
		zeigeFyneFenster(w)
		w.RequestFocus()
		return w
	}
	w := myApp.NewWindow(titel)
	einzelFenster[schluessel] = w
	einzelFensterMu.Unlock()

	aufraeumen := bau(w)
	w.SetOnClosed(func() {
		einzelFensterMu.Lock()
		if einzelFenster[schluessel] == w {
			delete(einzelFenster, schluessel)
		}
		einzelFensterMu.Unlock()
		if aufraeumen != nil {
			aufraeumen()
		}
	})
	tastaturSchliessen(w, w.Close)
	zeigeFyneFenster(w)
	return w
}

// einzelFensterOffen meldet, ob ein Fenster mit diesem Schluessel offen ist (Tests).
func einzelFensterOffen(schluessel string) bool {
	einzelFensterMu.Lock()
	defer einzelFensterMu.Unlock()
	_, ok := einzelFenster[schluessel]
	return ok
}

// versteckbaresFenster: Projekt- und Chatfenster werden beim Schliessen nur
// versteckt, damit sie beim naechsten Oeffnen sofort stehen. sichtbar steuert die
// Live-Aktualisierung (runLiveRefreshLoop fragt nur sichtbare Fenster ab).
func versteckbaresFenster(w fyne.Window, sichtbar *atomic.Bool) {
	verstecken := func() {
		sichtbar.Store(false)
		w.Hide()
	}
	w.SetCloseIntercept(verstecken)
	tastaturSchliessen(w, verstecken)
}

// zeigeVersteckt holt ein verstecktes Fenster zurueck. sichtbar MUSS wieder auf
// true: ohne das blieb die Live-Aktualisierung nach dem Wiederoeffnen aus.
func zeigeVersteckt(w fyne.Window, sichtbar *atomic.Bool) {
	sichtbar.Store(true)
	zeigeFyneFenster(w)
	w.RequestFocus()
}

// tastaturSchliessen: Esc und Strg+W schliessen das Fenster. Liegt ein Dialog
// (Overlay) offen, gehoert Esc dem Dialog — sonst schloesse Esc beim Abbrechen
// einer Rueckfrage gleich das ganze Fenster.
func tastaturSchliessen(w fyne.Window, schliessen func()) {
	c := w.Canvas()
	c.SetOnTypedKey(func(k *fyne.KeyEvent) {
		if k.Name != fyne.KeyEscape {
			return
		}
		if c.Overlays() != nil && c.Overlays().Top() != nil {
			return
		}
		schliessen()
	})
	c.AddShortcut(&desktop.CustomShortcut{KeyName: fyne.KeyW, Modifier: fyne.KeyModifierShortcutDefault},
		func(fyne.Shortcut) { schliessen() })
}

// neueTabelle baut eine Tabelle mit fester Kopfzeile und Ellipse in den Zellen.
// Vorher hatten die Tabellen keine Spaltenkoepfe und lange Texte wurden ohne
// Hinweis hart abgeschnitten.
func neueTabelle(kopf []string, zeilen func() [][]string) *widget.Table {
	t := widget.NewTable(
		func() (int, int) { return len(zeilen()), len(kopf) },
		func() fyne.CanvasObject {
			l := widget.NewLabel("Template")
			l.Truncation = fyne.TextTruncateEllipsis
			return l
		},
		func(id widget.TableCellID, o fyne.CanvasObject) {
			l := o.(*widget.Label)
			r := zeilen()
			if id.Row >= 0 && id.Row < len(r) && id.Col >= 0 && id.Col < len(r[id.Row]) {
				l.SetText(r[id.Row][id.Col])
				return
			}
			l.SetText("")
		},
	)
	t.ShowHeaderRow = true
	t.CreateHeader = func() fyne.CanvasObject {
		l := widget.NewLabelWithStyle("", fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
		l.Truncation = fyne.TextTruncateEllipsis
		return l
	}
	t.UpdateHeader = func(id widget.TableCellID, o fyne.CanvasObject) {
		l := o.(*widget.Label)
		if id.Col >= 0 && id.Col < len(kopf) {
			l.SetText(kopf[id.Col])
			return
		}
		l.SetText("")
	}
	return t
}

// tabellenAuswahl merkt sich die Auswahl einer live aktualisierten Tabelle ueber
// einen SCHLUESSEL statt ueber den Zeilenindex. Vorher zeigte der Index nach dem
// 3-s-Refresh (neue Zeilen kommen oben dazu) auf eine andere Zeile — "Stoppen",
// "Oeffnen" und "Details" trafen dann einen anderen Eintrag als den markierten.
// Nur auf dem UI-Faden benutzen.
type tabellenAuswahl struct {
	schluessel string
	zeile      int
	spalte     int
}

// waehle merkt sich die Zeile row aus der aktuellen Schluesselliste.
func (a *tabellenAuswahl) waehle(schluessel []string, row, col int) {
	if row < 0 || row >= len(schluessel) {
		a.schluessel = ""
		return
	}
	a.schluessel = schluessel[row]
	a.zeile = row
	a.spalte = col
}

// nachfuehren setzt die Markierung nach einem Refresh auf die Zeile mit dem
// gemerkten Schluessel. Ist der Eintrag weg, wird die Auswahl aufgehoben.
// Steht er noch in derselben Zeile, passiert nichts (Select scrollt zur Zeile
// und wuerde sonst alle 3 s die Ansicht verreissen).
func (a *tabellenAuswahl) nachfuehren(t *widget.Table, schluessel []string) {
	if a.schluessel == "" {
		return
	}
	idx := zeileZuSchluessel(schluessel, a.schluessel)
	if idx < 0 {
		a.schluessel = ""
		t.UnselectAll()
		return
	}
	if idx == a.zeile {
		return
	}
	a.zeile = idx
	t.Select(widget.TableCellID{Row: idx, Col: a.spalte})
}

// zeileZuSchluessel liefert den Index des Schluessels oder -1.
func zeileZuSchluessel(schluessel []string, gesucht string) int {
	if gesucht == "" {
		return -1
	}
	for i, s := range schluessel {
		if s == gesucht {
			return i
		}
	}
	return -1
}

// spaltenSchluessel bildet je Zeile einen Schluessel aus den angegebenen Spalten.
func spaltenSchluessel(rows [][]string, spalten ...int) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		k := ""
		for j, s := range spalten {
			if j > 0 {
				k += "\x1f"
			}
			if s < len(r) {
				k += r[s]
			}
		}
		out[i] = k
	}
	return out
}

// nahAmEnde: liegt die Ansicht (fast) am unteren Ende? Nur dann scrollt der Chat
// bei neuen Nachrichten automatisch mit — wer weiter oben liest, bleibt dort.
func nahAmEnde(offsetY, sichtHoehe, inhaltHoehe float32) bool {
	return offsetY+sichtHoehe >= inhaltHoehe-40
}

// lesefeld: mehrzeiliger, umbrechender, markier- und kopierbarer Text. Ersetzt
// deaktivierte Eingabefelder, die Fyne ausgraut (auf dunklem Grund kaum lesbar).
func lesefeld(text string, monospace bool) *widget.Label {
	l := widget.NewLabel(text)
	l.Wrapping = fyne.TextWrapWord
	l.Selectable = true
	l.TextStyle = fyne.TextStyle{Monospace: monospace}
	return l
}
