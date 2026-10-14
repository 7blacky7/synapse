package main

// reverse_bibliothek_ui.go — P18-T17 (RV7): Fenster "Reverse-Bibliothek".
// Ordnerwahl (global), Server-Policy (nur lesen), Statusbaum je Fundstelle,
// Hinweis ausblenden / Zurueckholen fuer lokal geloeschte oder verschobene Eintraege.
// Aktualisiert periodisch NUR solange das Fenster offen ist.

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
)

var reverseFenster fyne.Window

// reverseRefreshIntervall: periodischer Refresh, solange das Fenster offen ist.
var reverseRefreshIntervall = 10 * time.Second

// reverseOrdnerDialog ist austauschbar (Tests ohne echten Dateidialog).
var reverseOrdnerDialog = func(window fyne.Window, gewaehlt func(string)) {
	dialog.ShowFolderOpen(func(uri fyne.ListableURI, err error) {
		if err != nil {
			dialog.ShowError(err, window)
			return
		}
		if uri != nil {
			gewaehlt(uri.Path())
		}
	}, window)
}

func reverseLabel(text string) *widget.Label {
	l := widget.NewLabel(text)
	l.Wrapping = fyne.TextWrapWord
	return l
}

func zeigeReverseBibliothekFenster() {
	if reverseFenster != nil {
		reverseFenster.Show()
		reverseFenster.RequestFocus()
		return
	}
	window := myApp.NewWindow("Reverse-Bibliothek")
	reverseFenster = window
	ctx, cancel := context.WithCancel(context.Background())
	window.SetOnClosed(func() { cancel(); reverseFenster = nil })
	window.Resize(fyne.NewSize(960, 700))
	tastaturSchliessen(window, window.Close)

	cfgPfad, cfgErr := trayConfigPfad()
	var konfig reverseBibliothekKonfig
	if cfgErr == nil {
		konfig, cfgErr = leseReverseKonfig(cfgPfad)
	}

	// --- Ordnerwahl -------------------------------------------------------
	pfadEintrag := widget.NewEntry()
	pfadEintrag.SetText(konfig.Pfad)
	pfadHinweis := reverseLabel("")
	switch {
	case cfgErr != nil:
		pfadHinweis.SetText("config.json: " + cfgErr.Error())
	case !konfig.PfadGesetzt:
		pfadHinweis.SetText("Standardordner – wird erst mit „Speichern“ übernommen.")
	}
	waehlen := widget.NewButton("Ordner wählen …", func() {
		reverseOrdnerDialog(window, func(p string) { pfadEintrag.SetText(p) })
	})
	aktivCheck := widget.NewCheck("Reverse-Bibliothek auf diesem PC aktiv", nil)
	aktivCheck.SetChecked(konfig.Aktiv)
	speicherHinweis := reverseLabel("")
	speichern := widget.NewButton("Speichern", nil)

	// --- Server / Daemon --------------------------------------------------
	policyLabel := reverseLabel("Einstellungen werden von Synapse geladen …")
	serverHinweis := reverseLabel("")
	daemonLabel := reverseLabel("Lokaler Daemon wird abgefragt …")
	// P18-T63: fehlende PC-Zuordnung samt Loesung direkt hier (nicht nur im Asset-Sync-Fenster).
	zuordnungLabel := reverseLabel("")
	zuordnungLabel.Importance = widget.DangerImportance
	zuordnungLabel.Hide()
	zuordnungBtn := widget.NewButton("Diesen PC zuordnen", nil)
	zuordnungBtn.Hide()
	zuordnungHost := ""
	zusammenfassung := reverseLabel("")

	// --- Filter -----------------------------------------------------------
	geloeschteAusblenden := widget.NewCheck("lokal gelöschte ausblenden", nil)
	geloeschteAusblenden.SetChecked(konfig.GeloeschteAusblenden)
	ausgeblendeteZeigen := widget.NewCheck("ausgeblendete Hinweise zeigen", nil)

	// --- Baum + Details ---------------------------------------------------
	var letzteDateien []reverseFundstelle
	var letzteAuftraege []reverseDaemonAuftrag
	letzteWurzel := ""
	baum := baueReverseBaum(nil, nil, "", reverseFilter{})
	ausgewaehlt := ""
	tree := widget.NewTree(
		func(uid widget.TreeNodeID) []widget.TreeNodeID { return baum.Kinder[uid] },
		func(uid widget.TreeNodeID) bool { k := baum.Knoten[uid]; return k != nil && k.Ordner },
		func(bool) fyne.CanvasObject { return widget.NewLabel("") },
		func(uid widget.TreeNodeID, _ bool, o fyne.CanvasObject) {
			label := o.(*widget.Label)
			k := baum.Knoten[uid]
			label.Importance = widget.MediumImportance
			if k != nil {
				switch {
				case k.Warnungen > 0:
					label.Importance = widget.DangerImportance
				case k.Gesamt > 0 && k.Gesichert == k.Gesamt:
					label.Importance = widget.SuccessImportance
				}
			}
			label.SetText(reverseKnotenTitel(k))
		},
	)
	detail := container.NewVBox(reverseLabel("Eintrag im Baum auswählen"))
	vorschlagBtn := widget.NewButton("Vorschlag ansehen", nil)
	vorschlagBtn.Disable()
	hinweisBtn := widget.NewButton("Hinweis ausblenden", nil)
	hinweisBtn.Hide()
	zurueckBtn := widget.NewButton("Zurückholen", nil)
	zurueckBtn.Hide()
	// P18-T65: lokal vorhandene ISO-Fundstelle nur lesend als Laufwerk einbinden.
	einbindenBtn := widget.NewButton("Einbinden", nil)
	einbindenBtn.Hide()
	aktualisieren := widget.NewButton("Aktualisieren", nil)

	var neuLaden func()
	aktionLaeuft := false

	zeigeZuordnung := func(pruefen bool, z reversePCZuordnung) {
		text := ""
		if pruefen {
			text = reverseZuordnungText(z)
		}
		if text == "" {
			zuordnungLabel.Hide()
			zuordnungBtn.Hide()
			return
		}
		zuordnungLabel.SetText(text)
		zuordnungLabel.Show()
		if z.Fehlt() {
			zuordnungHost = z.Host
			zuordnungBtn.Show()
			if aktionLaeuft {
				zuordnungBtn.Disable()
			} else {
				zuordnungBtn.Enable()
			}
		} else {
			zuordnungBtn.Hide()
		}
	}
	zuordnungBtn.OnTapped = func() {
		host := zuordnungHost
		if aktionLaeuft || host == "" {
			return
		}
		aktionLaeuft = true
		zuordnungBtn.Disable()
		zuordnungLabel.SetText("PC " + host + " wird bei Synapse zugeordnet …")
		basis := fmt.Sprintf("http://127.0.0.1:%d", port)
		go func() {
			c, stop := context.WithTimeout(ctx, 30*time.Second)
			defer stop()
			neuversuch, err := reversePCZuordnen(c, cfgPfad, host, basis)
			fyne.Do(func() {
				if ctx.Err() != nil {
					return
				}
				aktionLaeuft = false
				if err != nil {
					zuordnungLabel.SetText(reverseZuordnungText(reversePCZuordnung{Host: host}))
					zuordnungBtn.Enable()
					dialog.ShowError(err, window)
					return
				}
				zuordnungLabel.Hide()
				zuordnungBtn.Hide()
				if neuversuch != nil {
					speicherHinweis.SetText("Dieser PC ist jetzt zugeordnet: " + host + ". Der lokale Daemon hat den Neuversuch nicht übernommen (" + neuversuch.Error() + ") – er versucht es spätestens beim nächsten Start.")
				} else {
					speicherHinweis.SetText("Dieser PC ist jetzt zugeordnet: " + host + ". Der lokale Daemon versucht es sofort erneut.")
				}
				neuLaden()
			})
		}()
	}

	bibliotheksWurzel := func() string {
		if letzteWurzel != "" {
			return letzteWurzel
		}
		if cfgPfad != "" {
			if k, err := leseReverseKonfig(cfgPfad); err == nil {
				return k.Pfad
			}
		}
		return konfig.Pfad
	}

	zeigeDetail := func(uid string) {
		ausgewaehlt = uid
		k := baum.Knoten[uid]
		hinweisBtn.Hide()
		zurueckBtn.Hide()
		einbindenBtn.Hide()
		vorschlagBtn.Disable()
		if uid == "" || k == nil {
			detail.Objects = []fyne.CanvasObject{reverseLabel("Eintrag im Baum auswählen")}
			detail.Refresh()
			return
		}
		rows := []fyne.CanvasObject{}
		for _, z := range reverseKnotenZeilen(k) {
			rows = append(rows, reverseLabel(z))
		}
		detail.Objects = rows
		detail.Refresh()
		f := k.Datei
		if f == nil {
			return
		}
		if _, ok := reverseVorschlagText(f.Vorschlag); ok {
			vorschlagBtn.Enable()
		}
		if reverseIsoEinbindbar(f) {
			einbindenBtn.Show()
		}
		if reverseHatLokalHinweis(f) {
			if f.HinweisAusgeblendet {
				hinweisBtn.SetText("Hinweis wieder einblenden")
			} else {
				hinweisBtn.SetText("Hinweis ausblenden")
			}
			hinweisBtn.Show()
			zurueckBtn.Show()
			if reverseIstGesichert(f) && !aktionLaeuft {
				zurueckBtn.Enable()
			} else {
				zurueckBtn.Disable()
			}
			if aktionLaeuft {
				hinweisBtn.Disable()
			} else {
				hinweisBtn.Enable()
			}
		}
	}
	tree.OnSelected = func(uid widget.TreeNodeID) { zeigeDetail(uid) }

	setzeBaum := func() {
		baum = baueReverseBaum(letzteDateien, letzteAuftraege, letzteWurzel, reverseFilter{
			GeloeschteAusblenden: geloeschteAusblenden.Checked,
			AusgeblendeteZeigen:  ausgeblendeteZeigen.Checked,
		})
		tree.Refresh()
		if _, ok := baum.Knoten[ausgewaehlt]; ok && ausgewaehlt != "" {
			zeigeDetail(ausgewaehlt)
		} else {
			tree.UnselectAll()
			zeigeDetail("")
		}
		text := fmt.Sprintf("%d Fundstellen · %d sicher auf Unraid", baum.Dateien, baum.Gesichert)
		if baum.Ausgeblendet > 0 {
			text += fmt.Sprintf(" · %d ausgeblendet (Filter)", baum.Ausgeblendet)
		}
		zusammenfassung.SetText(text)
	}

	vorschlagBtn.OnTapped = func() {
		k := baum.Knoten[ausgewaehlt]
		if k == nil || k.Datei == nil {
			return
		}
		text, ok := reverseVorschlagText(k.Datei.Vorschlag)
		if !ok {
			return
		}
		inhalt := widget.NewLabel(text)
		inhalt.Wrapping = fyne.TextWrapWord
		inhalt.TextStyle = fyne.TextStyle{Monospace: true}
		scroll := container.NewVScroll(inhalt)
		scroll.SetMinSize(fyne.NewSize(600, 380))
		dialog.ShowCustom("Vorschlag (nur Info)", "Schließen", scroll, window)
	}

	hinweisBtn.OnTapped = func() {
		k := baum.Knoten[ausgewaehlt]
		if aktionLaeuft || k == nil || k.Datei == nil {
			return
		}
		relPfad, ausblenden := k.Datei.RelPfad, !k.Datei.HinweisAusgeblendet
		aktionLaeuft = true
		hinweisBtn.Disable()
		go func() {
			c, stop := context.WithTimeout(ctx, 30*time.Second)
			defer stop()
			err := apiReverseHinweis(c, relPfad, ausblenden)
			fyne.Do(func() {
				if ctx.Err() != nil {
					return
				}
				aktionLaeuft = false
				if err != nil {
					dialog.ShowError(err, window)
					zeigeDetail(ausgewaehlt)
					return
				}
				neuLaden()
			})
		}()
	}

	// starteZurueckholen: Fortschritt + Abbrechen; vorhandenes Ziel -> Dialog fuer anderen Namen/Ort.
	var starteZurueckholen func(f reverseFundstelle, wurzel, ziel string)
	waehleAnderesZiel := func(f reverseFundstelle, ziel string) {
		ordner := widget.NewEntry()
		ordner.SetText(filepath.Dir(ziel))
		name := widget.NewEntry()
		basis := filepath.Base(ziel)
		ext := filepath.Ext(basis)
		name.SetText(strings.TrimSuffix(basis, ext) + " (von Unraid)" + ext)
		ordnerBtn := widget.NewButton("Ordner wählen …", func() {
			reverseOrdnerDialog(window, func(p string) { ordner.SetText(p) })
		})
		inhalt := container.NewVBox(
			reverseLabel("Am Originalpfad liegt bereits eine Datei:\n"+ziel+"\nSie wird nicht überschrieben. Anderen Namen oder Ort wählen:"),
			widget.NewLabel("Ordner"), container.NewBorder(nil, nil, nil, ordnerBtn, ordner),
			widget.NewLabel("Dateiname"), name,
		)
		dialog.ShowCustomConfirm("Ziel existiert bereits", "Zurückholen", "Abbrechen", inhalt, func(ok bool) {
			if !ok {
				return
			}
			o := strings.TrimSpace(ordner.Text)
			n := strings.TrimSpace(name.Text)
			if !filepath.IsAbs(o) || n == "" || strings.ContainsAny(n, `/\`) || n == "." || n == ".." {
				dialog.ShowError(fmt.Errorf("Bitte einen absoluten Ordner und einen Dateinamen ohne Pfadtrenner angeben"), window)
				return
			}
			// K5: nie in ein Projekt (der Projekt-Watcher saehe sonst .synapse-tmp-*).
			echt, err := reversePruefeAndererOrt(cfgPfad, o)
			if err != nil {
				dialog.ShowError(err, window)
				return
			}
			starteZurueckholen(f, echt, filepath.Join(echt, n))
		}, window)
	}
	starteZurueckholen = func(f reverseFundstelle, wurzel, ziel string) {
		if aktionLaeuft {
			return
		}
		aktionLaeuft = true
		zeigeDetail(ausgewaehlt)
		aktionCtx, abbrechen := context.WithCancel(ctx)
		balken := widget.NewProgressBarInfinite()
		stand := reverseLabel("Verbinde mit Synapse …")
		inhalt := container.NewVBox(reverseLabel(f.RelPfad+"\n→ "+ziel), balken, stand)
		d := dialog.NewCustom("Von Unraid zurückholen", "Abbrechen", inhalt, window)
		d.SetOnClosed(abbrechen)
		d.Show()
		var zuletzt atomic.Int64
		go func() {
			err := reverseZurueckholen(aktionCtx, f.RelPfad, f.SHA256, wurzel, ziel, func(n int64) {
				// Anzeige hoechstens alle 1 MiB nachziehen.
				if n-zuletzt.Load() < 1<<20 {
					return
				}
				zuletzt.Store(n)
				fyne.Do(func() { stand.SetText(menschenBytes(n) + " empfangen …") })
			})
			fyne.Do(func() {
				abgebrochen := aktionCtx.Err() != nil
				abbrechen()
				balken.Stop()
				d.Hide()
				if ctx.Err() != nil {
					return
				}
				aktionLaeuft = false
				var existiert *reverseZielExistiertFehler
				switch {
				case err == nil:
					dialog.ShowInformation("Zurückgeholt", "Die Datei liegt wieder unter\n"+ziel+"\nPrüfsumme bestätigt. Der Daemon meldet sie beim nächsten Scan.", window)
					neuLaden()
				case errors.As(err, &existiert):
					zeigeDetail(ausgewaehlt)
					waehleAnderesZiel(f, existiert.Ziel)
				case abgebrochen:
					zeigeDetail(ausgewaehlt)
					dialog.ShowInformation("Abgebrochen", "Zurückholen abgebrochen — es wurde nichts installiert.", window)
				default:
					zeigeDetail(ausgewaehlt)
					dialog.ShowError(err, window)
				}
			})
		}()
	}
	einbindenBtn.OnTapped = func() {
		k := baum.Knoten[ausgewaehlt]
		if k == nil || k.Datei == nil || !reverseIsoEinbindbar(k.Datei) {
			return
		}
		ziel, err := reverseZielPfad(bibliotheksWurzel(), k.Datei.RelPfad)
		if err != nil {
			dialog.ShowError(err, window)
			return
		}
		einbindenBtn.Disable()
		isoEinbindenMitRueckmeldung(ctx, window, ziel, func() { einbindenBtn.Enable() })
	}
	zurueckBtn.OnTapped = func() {
		k := baum.Knoten[ausgewaehlt]
		if aktionLaeuft || k == nil || k.Datei == nil || !reverseIstGesichert(k.Datei) {
			return
		}
		wurzel := bibliotheksWurzel()
		ziel, err := reverseZielPfad(wurzel, k.Datei.RelPfad)
		if err != nil {
			dialog.ShowError(err, window)
			return
		}
		starteZurueckholen(*k.Datei, wurzel, ziel)
	}

	// --- Speichern / Filter ----------------------------------------------
	speichern.OnTapped = func() {
		if cfgPfad == "" {
			dialog.ShowError(fmt.Errorf("config.json nicht auffindbar"), window)
			return
		}
		pfad, err := pruefeReversePfad(cfgPfad, pfadEintrag.Text)
		if err != nil {
			dialog.ShowError(err, window)
			return
		}
		aktiv := aktivCheck.Checked
		if err := setzeReverseKonfig(cfgPfad, map[string]interface{}{"aktiv": aktiv, "pfad": pfad}); err != nil {
			speicherHinweis.SetText("Nicht gespeichert: " + err.Error())
			dialog.ShowError(err, window)
			return
		}
		pfadEintrag.SetText(pfad)
		pfadHinweis.SetText("")
		speichern.Disable()
		speicherHinweis.SetText("Gespeichert in config.json · lokaler Daemon wird informiert …")
		basis := fmt.Sprintf("http://127.0.0.1:%d", port)
		go func() {
			c, stop := context.WithTimeout(ctx, 25*time.Second)
			defer stop()
			err := daemonReverseKonfig(c, basis, map[string]interface{}{"aktiv": aktiv, "pfad": pfad, "geloeschte_ausblenden": geloeschteAusblenden.Checked})
			fyne.Do(func() {
				if ctx.Err() != nil {
					return
				}
				speichern.Enable()
				if err != nil {
					speicherHinweis.SetText("Gespeichert in config.json. Der lokale Daemon hat die Änderung nicht übernommen (" + err.Error() + ") – sie gilt spätestens nach dem nächsten Daemon-Start.")
					return
				}
				speicherHinweis.SetText("Gespeichert und vom lokalen Daemon übernommen.")
				neuLaden()
			})
		}()
	}
	filterAendern := false
	geloeschteAusblenden.OnChanged = func(wert bool) {
		if filterAendern {
			return
		}
		if cfgPfad != "" {
			if err := setzeReverseKonfig(cfgPfad, map[string]interface{}{"geloeschte_ausblenden": wert}); err != nil {
				filterAendern = true
				geloeschteAusblenden.SetChecked(!wert)
				filterAendern = false
				dialog.ShowError(err, window)
				return
			}
			// M1: Daemon uebernimmt den Wert, sonst schriebe sein naechstes saveConfig den alten zurueck.
			basis := fmt.Sprintf("http://127.0.0.1:%d", port)
			go func() {
				c, stop := context.WithTimeout(ctx, 25*time.Second)
				defer stop()
				err := daemonReverseKonfig(c, basis, map[string]interface{}{"geloeschte_ausblenden": wert})
				fyne.Do(func() {
					if ctx.Err() != nil {
						return
					}
					if err != nil {
						speicherHinweis.SetText("Filter in config.json gespeichert. Der lokale Daemon hat ihn nicht übernommen (" + err.Error() + ") – er gilt spätestens nach dem nächsten Daemon-Start.")
					} else {
						speicherHinweis.SetText("Filter gespeichert und vom lokalen Daemon übernommen.")
					}
				})
			}()
		}
		setzeBaum()
	}
	ausgeblendeteZeigen.OnChanged = func(bool) { setzeBaum() }

	// --- Laden ------------------------------------------------------------
	var laden atomic.Bool
	neuLaden = func() {
		if !laden.CompareAndSwap(false, true) {
			return
		}
		aktualisieren.Disable()
		go func() {
			defer laden.Store(false)
			c, stop := context.WithTimeout(ctx, 90*time.Second)
			defer stop()
			optionen, optErr := apiReverseSyncOptionen(c)
			var dateien []reverseFundstelle
			fundErr := optErr
			if !errors.Is(optErr, errReverseDeaktiviert) {
				dateien, fundErr = apiReverseFundstellen(c)
			}
			status, daemonErr := daemonReverseStatus(c)
			// P18-T63: Zuordnung nur pruefen, wenn Daemon/API darauf hindeuten.
			pruefen := reverseZuordnungPruefen(status, daemonErr, optErr, fundErr)
			var zuordnung reversePCZuordnung
			if pruefen {
				zuordnung = reverseLadePCZuordnung(c)
			}
			fyne.Do(func() {
				if ctx.Err() != nil {
					return
				}
				aktualisieren.Enable()
				deaktiviert := errors.Is(optErr, errReverseDeaktiviert) || errors.Is(fundErr, errReverseDeaktiviert)
				hinweise := []string{}
				switch {
				case deaktiviert:
					policyLabel.SetText("—")
					hinweise = append(hinweise, errReverseDeaktiviert.Error()+".")
					letzteDateien = nil
				default:
					if optErr == nil {
						policyLabel.SetText(strings.Join(reversePolicyZeilen(optionen), "\n"))
					} else {
						policyLabel.SetText("Einstellungen nicht geladen: " + optErr.Error())
					}
					if fundErr == nil {
						letzteDateien = dateien
					} else {
						hinweise = append(hinweise, "Fundstellen nicht geladen (zeige letzten Stand): "+fundErr.Error())
					}
				}
				serverHinweis.SetText(strings.Join(hinweise, "\n"))
				daemonLabel.Importance = widget.MediumImportance
				if daemonErr == nil {
					letzteAuftraege = status.Auftraege
					letzteWurzel = status.Pfad
					if status.Fehler != "" || status.Modus == "fehler" {
						daemonLabel.Importance = widget.DangerImportance
					}
					daemonLabel.SetText(reverseDaemonText(status))
				} else {
					letzteAuftraege = nil
					daemonLabel.SetText("Lokaler Daemon: " + daemonErr.Error())
				}
				zeigeZuordnung(pruefen, zuordnung)
				setzeBaum()
			})
		}()
	}
	aktualisieren.OnTapped = neuLaden

	fett := fyne.TextStyle{Bold: true}
	kopf := container.NewVBox(
		widget.NewLabelWithStyle("Ordner der Reverse-Bibliothek (global, für alle Projekte)", fyne.TextAlignLeading, fett),
		container.NewBorder(nil, nil, nil, waehlen, pfadEintrag),
		pfadHinweis,
		container.NewHBox(aktivCheck, speichern),
		speicherHinweis,
		widget.NewSeparator(),
		widget.NewLabelWithStyle("Einstellungen von Synapse (nur lesen)", fyne.TextAlignLeading, fett),
		policyLabel,
		serverHinweis,
		widget.NewSeparator(),
		daemonLabel,
		zuordnungLabel,
		container.NewHBox(zuordnungBtn),
		container.NewHBox(aktualisieren, geloeschteAusblenden, ausgeblendeteZeigen),
		zusammenfassung,
	)
	rechts := container.NewBorder(nil, container.NewHBox(vorschlagBtn, hinweisBtn, zurueckBtn, einbindenBtn), nil, nil, container.NewVScroll(detail))
	split := container.NewHSplit(tree, rechts)
	split.Offset = 0.6
	window.SetContent(container.NewBorder(kopf, nil, nil, nil, split))
	window.Show()
	neuLaden()
	intervall := reverseRefreshIntervall
	go func() {
		ticker := time.NewTicker(intervall)
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
}
