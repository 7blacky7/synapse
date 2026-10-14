package main

// iso_images_ui.go — P18-T65 (RV43a): Fenster "ISO-Images".
// "Image einbinden …" (Dateiauswahl *.iso) und der Bereich "Eingebundene Images"
// mit "Öffnen" (Dateimanager am Mountpunkt) und "Auswerfen". Die Liste kommt bei
// jedem Laden frisch vom System (losetup/lsblk) und wird nur aktualisiert,
// solange das Fenster offen ist.

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/storage"
	"fyne.io/fyne/v2/widget"
)

const isoFensterSchluessel = "iso-images"

// isoRefreshIntervall: Abgleich mit dem System (z. B. extern ausgeworfen), nur bei offenem Fenster.
var isoRefreshIntervall = 5 * time.Second

// isoFensterNeuLaden ist gesetzt, solange das Fenster offen ist (nur UI-Faden).
var isoFensterNeuLaden func()

// isoDateiDialog ist austauschbar (Tests ohne echten Dateidialog).
var isoDateiDialog = func(window fyne.Window, gewaehlt func(string)) {
	d := dialog.NewFileOpen(func(r fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, window)
			return
		}
		if r == nil {
			return
		}
		pfad := r.URI().Path()
		r.Close()
		gewaehlt(pfad)
	}, window)
	d.SetFilter(storage.NewExtensionFileFilter([]string{".iso", ".ISO", ".Iso"}))
	d.Show()
}

// zeigeIsoFenster oeffnet das Fenster; mitDateiwahl startet sofort die Dateiauswahl.
func zeigeIsoFenster(mitDateiwahl bool) {
	var einbinden func()
	w := oeffneEinzelFenster(isoFensterSchluessel, "ISO-Images", func(window fyne.Window) func() {
		var aufraeumen func()
		einbinden, aufraeumen = bauIsoFenster(window)
		return aufraeumen
	})
	if mitDateiwahl {
		if einbinden != nil {
			einbinden()
		} else if btn := isoFindeKnopf(w.Content(), "Image einbinden …"); btn != nil {
			btn.OnTapped()
		}
	}
}

func isoFindeKnopf(o fyne.CanvasObject, text string) *widget.Button {
	if b, ok := o.(*widget.Button); ok && b.Text == text {
		return b
	}
	if c, ok := o.(*fyne.Container); ok {
		for _, k := range c.Objects {
			if b := isoFindeKnopf(k, text); b != nil {
				return b
			}
		}
	}
	return nil
}

// isoEinbindenMitRueckmeldung bindet pfad ein und zeigt das Ergebnis in window.
// Auch vom Reverse-Fenster benutzt. Muss auf dem UI-Faden starten.
func isoEinbindenMitRueckmeldung(ctx context.Context, window fyne.Window, pfad string, fertig func()) {
	balken := widget.NewProgressBarInfinite()
	d := dialog.NewCustomWithoutButtons("Image wird eingebunden …", container.NewVBox(reverseLabel(pfad), balken), window)
	d.Show()
	go func() {
		c, stop := context.WithTimeout(ctx, 60*time.Second)
		defer stop()
		img, err := isoEinbinden(c, pfad)
		fyne.Do(func() {
			balken.Stop()
			d.Hide()
			if ctx.Err() != nil {
				return
			}
			if fertig != nil {
				fertig()
			}
			if isoFensterNeuLaden != nil {
				isoFensterNeuLaden()
			}
			if err != nil {
				dialog.ShowError(err, window)
				return
			}
			text := "Nur lesend eingebunden:\n" + img.Datei + "\nLaufwerk " + img.Geraet + "\nOrdner " + img.Mountpunkt
			dialog.ShowCustomConfirm("Image eingebunden", "Öffnen", "Schließen", reverseLabel(text), func(oeffnen bool) {
				if !oeffnen {
					return
				}
				if err := isoOeffnen(img.Mountpunkt); err != nil {
					dialog.ShowError(err, window)
				}
			}, window)
		})
	}()
}

// bauIsoFenster fuellt das Fenster und liefert die Aktion "Image einbinden …"
// sowie die Aufraeumfunktion (laeuft beim Schliessen, auch per Esc/Strg+W).
func bauIsoFenster(window fyne.Window) (func(), func()) {
	window.Resize(fyne.NewSize(720, 420))
	ctx, cancel := context.WithCancel(context.Background())

	hinweis := reverseLabel("")
	if !isoUnterstuetzt {
		hinweis.SetText("ISO-Images einbinden folgt für dieses Betriebssystem.")
	} else {
		hinweis.SetText("Bindet ISO-Abbilder (ISO9660/UDF) nur lesend als Laufwerk ein (udisks, ohne Root). Eingebunden wird nur, was du auswählst.")
	}
	stand := reverseLabel("Eingebundene Images werden ermittelt …")
	liste := container.NewVBox()
	var laden, nochmal atomic.Bool
	aktionLaeuft := false
	var neuLaden func()

	einbinden := widget.NewButton("Image einbinden …", nil)
	aktualisieren := widget.NewButton("Aktualisieren", nil)
	if !isoUnterstuetzt {
		einbinden.Disable()
		aktualisieren.Disable()
	}

	zeigeListe := func(bilder []isoImage, err error) {
		zeilen := []fyne.CanvasObject{}
		for _, img := range bilder {
			img := img
			oeffnen := widget.NewButton("Öffnen", func() {
				if err := isoOeffnen(img.Mountpunkt); err != nil {
					dialog.ShowError(err, window)
				}
			})
			if img.Mountpunkt == "" {
				oeffnen.Disable()
			}
			var auswerfen *widget.Button
			auswerfen = widget.NewButton("Auswerfen", func() {
				if aktionLaeuft {
					return
				}
				aktionLaeuft = true
				auswerfen.Disable()
				stand.SetText("Werfe " + img.Geraet + " aus …")
				go func() {
					c, stop := context.WithTimeout(ctx, 60*time.Second)
					defer stop()
					err := isoAuswerfen(c, img)
					fyne.Do(func() {
						if ctx.Err() != nil {
							return
						}
						aktionLaeuft = false
						if err != nil {
							dialog.ShowError(err, window)
						}
						neuLaden()
					})
				}()
			})
			if aktionLaeuft {
				auswerfen.Disable()
			}
			zeilen = append(zeilen, container.NewBorder(nil, nil, nil, container.NewHBox(oeffnen, auswerfen), reverseLabel(isoImageText(img))))
		}
		liste.Objects = zeilen
		liste.Refresh()
		switch {
		case err != nil:
			stand.SetText("Eingebundene Images nicht ermittelt: " + err.Error())
		case len(bilder) == 0:
			stand.SetText("Keine ISO-Images eingebunden.")
		default:
			stand.SetText(fmt.Sprintf("%d ISO-Image(s) eingebunden.", len(bilder)))
		}
	}

	neuLaden = func() {
		if !isoUnterstuetzt {
			return
		}
		if !laden.CompareAndSwap(false, true) {
			// Laeuft gerade: danach noch einmal laden (sonst fehlte z. B. ein frisch eingebundenes Image).
			nochmal.Store(true)
			return
		}
		go func() {
			c, stop := context.WithTimeout(ctx, 20*time.Second)
			bilder, err := isoListe(c)
			stop()
			laden.Store(false)
			fyne.Do(func() {
				if ctx.Err() != nil {
					return
				}
				if !aktionLaeuft {
					zeigeListe(bilder, err)
				}
				if nochmal.Swap(false) {
					neuLaden()
				}
			})
		}()
	}
	aktualisieren.OnTapped = neuLaden
	waehlen := func() {
		if !isoUnterstuetzt || aktionLaeuft {
			return
		}
		isoDateiDialog(window, func(pfad string) {
			pfad = strings.TrimSpace(pfad)
			if pfad == "" {
				return
			}
			aktionLaeuft = true
			einbinden.Disable()
			isoEinbindenMitRueckmeldung(ctx, window, pfad, func() {
				aktionLaeuft = false
				einbinden.Enable()
			})
		})
	}
	einbinden.OnTapped = waehlen

	fett := fyne.TextStyle{Bold: true}
	kopf := container.NewVBox(hinweis, container.NewHBox(einbinden, aktualisieren), widget.NewSeparator(),
		widget.NewLabelWithStyle("Eingebundene Images", fyne.TextAlignLeading, fett), stand)
	window.SetContent(container.NewBorder(kopf, nil, nil, nil, container.NewVScroll(liste)))

	isoFensterNeuLaden = neuLaden
	neuLaden()
	go func() {
		ticker := time.NewTicker(isoRefreshIntervall)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				fyne.Do(func() {
					if ctx.Err() == nil && !aktionLaeuft {
						neuLaden()
					}
				})
			}
		}
	}()
	return waehlen, func() {
		cancel()
		isoFensterNeuLaden = nil
	}
}
