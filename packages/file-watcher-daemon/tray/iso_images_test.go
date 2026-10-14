package main

// P18-T65 (RV43a): ISO einbinden/auswerfen. Kein echtes udisksctl/losetup/lsblk:
// isoKommando wird durch einen Fake ersetzt, Abbilder sind leere Dateien in t.TempDir().

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"fyne.io/fyne/v2"
	fynetest "fyne.io/fyne/v2/test"
	"fyne.io/fyne/v2/widget"
)

// isoFake beantwortet Kommandos anhand "name arg0" und zeichnet alle Aufrufe auf.
type isoFake struct {
	mu      sync.Mutex
	aufrufe []string
	antwort func(name string, args []string) (string, error)
}

func (f *isoFake) run(_ context.Context, name string, args ...string) (string, error) {
	f.mu.Lock()
	f.aufrufe = append(f.aufrufe, name+" "+strings.Join(args, " "))
	antwort := f.antwort
	f.mu.Unlock()
	return antwort(name, args)
}

func (f *isoFake) liste() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.aufrufe...)
}

func isoSetup(t *testing.T, antwort func(name string, args []string) (string, error)) *isoFake {
	t.Helper()
	f := &isoFake{antwort: antwort}
	altK, altU, altO := isoKommando, isoUnterstuetzt, isoOeffnen
	isoKommando, isoUnterstuetzt = f.run, true
	isoOeffnen = func(string) error { return nil }
	t.Cleanup(func() { isoKommando, isoUnterstuetzt, isoOeffnen = altK, altU, altO })
	return f
}

func isoDatei(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("CD001"), 0o600); err != nil {
		t.Fatal(err)
	}
	echt, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return echt
}

func isoFehler(name, text string) error {
	return &isoKommandoFehler{Name: name, Text: text, Ursache: errors.New("exit status 1")}
}

func isoAufrufMit(aufrufe []string, teil string) bool {
	for _, a := range aufrufe {
		if strings.Contains(a, teil) {
			return true
		}
	}
	return false
}

func TestP18T65Parser(t *testing.T) {
	if g, err := isoParseLoop("Mapped file /home/u/Siedler 3.iso as /dev/loop12.\n"); err != nil || g != "/dev/loop12" {
		t.Fatalf("loop-setup: %q %v", g, err)
	}
	for _, schlecht := range []string{"", "Mapped file x as /dev/sda.", "irgendwas"} {
		if _, err := isoParseLoop(schlecht); err == nil {
			t.Errorf("loop-setup %q akzeptiert", schlecht)
		}
	}
	// Mountpunkt mit Leerzeichen, alter Satzpunkt wird entfernt, neuer Stil ohne Punkt bleibt.
	if p, err := isoParseMount("Mounted /dev/loop12 at /run/media/u/SIEDLER 3.\n"); err != nil || p != "/run/media/u/SIEDLER 3" {
		t.Fatalf("mount alt: %q %v", p, err)
	}
	if p, err := isoParseMount("Mounted /dev/loop0 at /run/media/u/CD\n"); err != nil || p != "/run/media/u/CD" {
		t.Fatalf("mount neu: %q %v", p, err)
	}
	// Echter Ordner, der mit Punkt endet, bleibt erhalten.
	punkt := filepath.Join(t.TempDir(), "Ordner.")
	os.Mkdir(punkt, 0o700)
	if p, _ := isoParseMount("Mounted /dev/loop0 at " + punkt + "\n"); p != punkt {
		t.Fatalf("Punkt-Ordner: %q", p)
	}
	if _, err := isoParseMount("Mounted /dev/loop0 at relativ"); err == nil {
		t.Fatal("relativer Mountpunkt akzeptiert")
	}
	if p, ok := isoParseSchonEingehaengt("Error mounting /dev/loop1: GDBus.Error:org.freedesktop.UDisks2.Error.AlreadyMounted: Device /dev/loop1 is already mounted at `/run/media/u/X Y'.\n"); !ok || p != "/run/media/u/X Y" {
		t.Fatalf("AlreadyMounted: %q %v", p, ok)
	}

	liste, err := isoParseLosetup(`{"loopdevices":[
	 {"name":"/dev/loop3","back-file":"/b/b.ISO","ro":"1"},
	 {"name":"/dev/loop1","back-file":"/a/a.iso","ro":true},
	 {"name":"/dev/loop2","back-file":"/snap/core.snap","ro":true},
	 {"name":"/dev/loop4","back-file":"/c/c.iso (deleted)","ro":0}]}`)
	if err != nil {
		t.Fatal(err)
	}
	want := []isoImage{{Geraet: "/dev/loop1", Datei: "/a/a.iso", NurLesen: true}, {Geraet: "/dev/loop3", Datei: "/b/b.ISO", NurLesen: true}, {Geraet: "/dev/loop4", Datei: "/c/c.iso"}}
	if !reflect.DeepEqual(liste, want) {
		t.Fatalf("losetup: %+v", liste)
	}
	if l, err := isoParseLosetup("  \n"); err != nil || l != nil {
		t.Fatal("leere losetup-Ausgabe")
	}
	if _, err := isoParseLosetup("kaputt"); err == nil {
		t.Fatal("kaputtes JSON akzeptiert")
	}
	m, err := isoParseLsblk(`{"blockdevices":[{"name":"/dev/loop1","mountpoint":"/run/media/u/A"},
	 {"name":"/dev/loop3","mountpoint":null,"children":[{"name":"/dev/loop3p1","mountpoint":"/run/media/u/HYBRID"}]},
	 {"name":"/dev/loop4","mountpoint":null}]}`)
	if err != nil || m["/dev/loop1"] != "/run/media/u/A" || m["/dev/loop3"] != "/run/media/u/HYBRID" || m["/dev/loop4"] != "" {
		t.Fatalf("lsblk: %v %v", m, err)
	}
}

func TestP18T65EinbindenErfolg(t *testing.T) {
	iso := isoDatei(t, "Siedler3.iso")
	f := isoSetup(t, func(name string, args []string) (string, error) {
		switch name + " " + args[0] {
		case "losetup --list":
			return "", nil
		case "udisksctl loop-setup":
			return "Mapped file " + iso + " as /dev/loop7.\n", nil
		case "udisksctl mount":
			return "Mounted /dev/loop7 at /run/media/u/SIEDLER3.\n", nil
		}
		return "", errors.New("unerwartet")
	})
	img, err := isoEinbinden(context.Background(), iso)
	if err != nil {
		t.Fatal(err)
	}
	if img != (isoImage{Geraet: "/dev/loop7", Datei: iso, Mountpunkt: "/run/media/u/SIEDLER3", NurLesen: true}) {
		t.Fatalf("Ergebnis: %+v", img)
	}
	aufrufe := f.liste()
	if !isoAufrufMit(aufrufe, "udisksctl loop-setup --no-user-interaction -r -f "+iso) || !isoAufrufMit(aufrufe, "udisksctl mount --no-user-interaction -b /dev/loop7") {
		t.Fatalf("Aufrufe (read-only Pflicht): %v", aufrufe)
	}
}

func TestP18T65SchonEingebunden(t *testing.T) {
	iso := isoDatei(t, "disk.iso")
	eingehaengt := true
	f := isoSetup(t, func(name string, args []string) (string, error) {
		switch name + " " + args[0] {
		case "losetup --list":
			return `{"loopdevices":[{"name":"/dev/loop2","back-file":"` + iso + `","ro":true}]}`, nil
		case "lsblk -J":
			if eingehaengt {
				return `{"blockdevices":[{"name":"/dev/loop2","mountpoint":"/run/media/u/DISK"}]}`, nil
			}
			return `{"blockdevices":[{"name":"/dev/loop2","mountpoint":null}]}`, nil
		case "udisksctl mount":
			// Desktop-Automount war schneller.
			return "", isoFehler("udisksctl", "Error mounting /dev/loop2: GDBus.Error:org.freedesktop.UDisks2.Error.AlreadyMounted: Device /dev/loop2 is already mounted at `/run/media/u/AUTO'.")
		}
		return "", errors.New("unerwartet " + name)
	})
	img, err := isoEinbinden(context.Background(), iso)
	if err != nil || img.Geraet != "/dev/loop2" || img.Mountpunkt != "/run/media/u/DISK" {
		t.Fatalf("schon eingebunden: %+v %v", img, err)
	}
	if isoAufrufMit(f.liste(), "loop-setup") || isoAufrufMit(f.liste(), "udisksctl mount") {
		t.Fatalf("zweites Loop-Geraet/Mount angelegt: %v", f.liste())
	}
	// Loop vorhanden, nicht eingehaengt -> nur mount; AlreadyMounted liefert den Pfad.
	eingehaengt = false
	img, err = isoEinbinden(context.Background(), iso)
	if err != nil || img.Mountpunkt != "/run/media/u/AUTO" {
		t.Fatalf("nachmounten: %+v %v", img, err)
	}
	if isoAufrufMit(f.liste(), "loop-setup") {
		t.Fatal("loop-setup trotz vorhandenem Loop")
	}
}

func TestP18T65EinbindenFehler(t *testing.T) {
	iso := isoDatei(t, "kaputt.iso")
	t.Run("kein ISO-Dateisystem raeumt Loop weg", func(t *testing.T) {
		f := isoSetup(t, func(name string, args []string) (string, error) {
			switch name + " " + args[0] {
			case "losetup --list":
				return "", nil
			case "udisksctl loop-setup":
				return "Mapped file " + iso + " as /dev/loop9.\n", nil
			case "udisksctl mount":
				return "", isoFehler("udisksctl", "Error mounting /dev/loop9: GDBus.Error:org.freedesktop.UDisks2.Error.NotMountable: No usable filesystem")
			case "udisksctl loop-delete":
				return "", nil
			}
			return "", errors.New("unerwartet")
		})
		_, err := isoEinbinden(context.Background(), iso)
		if err == nil || !strings.Contains(err.Error(), "Kein ISO-Dateisystem") {
			t.Fatalf("Fehlertext: %v", err)
		}
		if !isoAufrufMit(f.liste(), "udisksctl loop-delete --no-user-interaction -b /dev/loop9") {
			t.Fatalf("Loop nicht entfernt: %v", f.liste())
		}
	})
	t.Run("udisks fehlt", func(t *testing.T) {
		isoSetup(t, func(name string, args []string) (string, error) {
			if name == "losetup" {
				return "", nil
			}
			return "", &isoKommandoFehler{Name: name, Fehlt: true, Ursache: errors.New("not found")}
		})
		if _, err := isoEinbinden(context.Background(), iso); err == nil || !strings.Contains(err.Error(), "udisks nicht verfügbar") {
			t.Fatalf("Fehlertext: %v", err)
		}
	})
	t.Run("udisks-Dienst laeuft nicht", func(t *testing.T) {
		isoSetup(t, func(name string, args []string) (string, error) {
			if name == "losetup" {
				return "", nil
			}
			return "", isoFehler(name, "Error connecting to the udisks daemon: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown")
		})
		if _, err := isoEinbinden(context.Background(), iso); err == nil || !strings.Contains(err.Error(), "udisks nicht verfügbar") {
			t.Fatalf("Fehlertext: %v", err)
		}
	})
	t.Run("nur ausgewaehlte ISO-Dateien", func(t *testing.T) {
		f := isoSetup(t, func(string, []string) (string, error) { return "", errors.New("darf nicht laufen") })
		exe := filepath.Join(t.TempDir(), "setup.exe")
		os.WriteFile(exe, nil, 0o600)
		for _, p := range []string{"relativ.iso", exe, filepath.Join(t.TempDir(), "fehlt.iso"), t.TempDir() + "/ordner.iso"} {
			if p == "" {
				continue
			}
			if strings.HasSuffix(p, "ordner.iso") {
				os.Mkdir(p, 0o700)
			}
			if _, err := isoEinbinden(context.Background(), p); err == nil {
				t.Errorf("%s akzeptiert", p)
			}
		}
		if len(f.liste()) != 0 {
			t.Fatalf("Kommandos trotz ungueltiger Datei: %v", f.liste())
		}
	})
	t.Run("anderes Betriebssystem", func(t *testing.T) {
		isoSetup(t, func(string, []string) (string, error) { return "", nil })
		isoUnterstuetzt = false
		if _, err := isoEinbinden(context.Background(), iso); err == nil || !strings.Contains(err.Error(), "folgt") {
			t.Fatalf("Windows-Hinweis: %v", err)
		}
	})
}

func TestP18T65Auswerfen(t *testing.T) {
	var unmount error
	var loopDelete error
	f := isoSetup(t, func(name string, args []string) (string, error) {
		switch name + " " + args[0] {
		case "udisksctl unmount":
			return "Unmounted /dev/loop5.\n", unmount
		case "udisksctl loop-delete":
			return "", loopDelete
		}
		return "", errors.New("unerwartet")
	})
	img := isoImage{Geraet: "/dev/loop5", Datei: "/a/x.iso", Mountpunkt: "/run/media/u/X", NurLesen: true}
	if err := isoAuswerfen(context.Background(), img); err != nil {
		t.Fatal(err)
	}
	want := []string{"udisksctl unmount --no-user-interaction -b /dev/loop5", "udisksctl loop-delete --no-user-interaction -b /dev/loop5"}
	if !reflect.DeepEqual(f.liste(), want) {
		t.Fatalf("Aufrufe: %v", f.liste())
	}
	// Nicht eingehaengt: nur loop-delete. Schon weg (Autoclear): kein Fehler.
	loopDelete = isoFehler("udisksctl", "Error looking up object for device /dev/loop5")
	if err := isoAuswerfen(context.Background(), isoImage{Geraet: "/dev/loop5"}); err != nil {
		t.Fatalf("Autoclear: %v", err)
	}
	// Belegt: verstaendlicher Text, kein loop-delete.
	loopDelete = nil
	unmount = isoFehler("udisksctl", "Error unmounting /dev/loop5: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: target is busy")
	vorher := len(f.liste())
	if err := isoAuswerfen(context.Background(), img); err == nil || !strings.Contains(err.Error(), "noch benutzt") {
		t.Fatalf("busy: %v", err)
	}
	if isoAufrufMit(f.liste()[vorher:], "loop-delete") {
		t.Fatal("loop-delete trotz belegtem Laufwerk")
	}
	// Extern schon ausgehaengt: weiter mit loop-delete.
	unmount = isoFehler("udisksctl", "Error unmounting /dev/loop5: GDBus.Error:org.freedesktop.UDisks2.Error.NotMounted: Device is not mounted")
	if err := isoAuswerfen(context.Background(), img); err != nil {
		t.Fatalf("NotMounted: %v", err)
	}
	if err := isoAuswerfen(context.Background(), isoImage{Geraet: "/dev/sda"}); err == nil {
		t.Fatal("fremdes Geraet akzeptiert")
	}
}

func TestP18T65ReverseKnopfUndMenue(t *testing.T) {
	alt := isoUnterstuetzt
	t.Cleanup(func() { isoUnterstuetzt = alt })
	isoUnterstuetzt = true
	for _, fall := range []struct {
		f    *reverseFundstelle
		soll bool
	}{
		{&reverseFundstelle{RelPfad: "CDs/Siedler3/disk1.ISO", Lokal: "gesehen"}, true},
		{&reverseFundstelle{RelPfad: "CDs/a.iso"}, true},
		{&reverseFundstelle{RelPfad: "CDs/a.iso", Lokal: "geloescht_lokal"}, false},
		{&reverseFundstelle{RelPfad: "CDs/a.iso", Lokal: "fehlt"}, false},
		{&reverseFundstelle{RelPfad: "Tools/setup.exe"}, false},
		{nil, false},
	} {
		if got := reverseIsoEinbindbar(fall.f); got != fall.soll {
			t.Errorf("%+v: %v", fall.f, got)
		}
	}
	if artIndex(hauptmenueLayout(true, nil), menueImages) < 0 || artIndex(hauptmenueLayout(false, nil), menueImages) < 0 {
		t.Fatal("Linux: Menuepunkt fehlt")
	}
	isoUnterstuetzt = false
	if reverseIsoEinbindbar(&reverseFundstelle{RelPfad: "a.iso"}) || artIndex(hauptmenueLayout(true, nil), menueImages) >= 0 {
		t.Fatal("ohne udisks darf weder Knopf noch Menuepunkt erscheinen")
	}
}

// TestP18T65FensterHeadless: echtes Fenster ohne Display, Fake-Kommandos.
func TestP18T65FensterHeadless(t *testing.T) {
	iso := isoDatei(t, "neu.iso")
	var mu sync.Mutex
	eingebunden := map[string]string{"/dev/loop1": "/alt/alt.iso"}
	mounts := map[string]string{"/dev/loop1": "/run/media/u/ALT"}
	f := isoSetup(t, func(name string, args []string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		switch name + " " + args[0] {
		case "losetup --list":
			teile := []string{}
			for g, d := range eingebunden {
				teile = append(teile, `{"name":"`+g+`","back-file":"`+d+`","ro":true}`)
			}
			if len(teile) == 0 {
				return "", nil
			}
			return `{"loopdevices":[` + strings.Join(teile, ",") + `]}`, nil
		case "lsblk -J":
			teile := []string{}
			for g, m := range mounts {
				teile = append(teile, `{"name":"`+g+`","mountpoint":"`+m+`"}`)
			}
			return `{"blockdevices":[` + strings.Join(teile, ",") + `]}`, nil
		case "udisksctl loop-setup":
			eingebunden["/dev/loop2"] = iso
			return "Mapped file " + iso + " as /dev/loop2.\n", nil
		case "udisksctl mount":
			mounts["/dev/loop2"] = "/run/media/u/NEU"
			return "Mounted /dev/loop2 at /run/media/u/NEU\n", nil
		case "udisksctl unmount":
			delete(mounts, args[len(args)-1])
			return "", nil
		case "udisksctl loop-delete":
			delete(eingebunden, args[len(args)-1])
			return "", nil
		}
		return "", errors.New("unerwartet")
	})
	var geoeffnet []string
	isoOeffnen = func(p string) error { mu.Lock(); geoeffnet = append(geoeffnet, p); mu.Unlock(); return nil }
	altDialog := isoDateiDialog
	dialogAufrufe := 0
	isoDateiDialog = func(_ fyne.Window, gewaehlt func(string)) { dialogAufrufe++; gewaehlt(iso) }

	previousApp := fyne.CurrentApp()
	baseApp := fynetest.NewApp()
	app := a9SerialApp{App: baseApp, driver: &a9SerialDriver{Driver: baseApp.Driver()}}
	fyne.SetCurrentApp(app)
	oldApp := myApp
	myApp = app
	t.Cleanup(func() {
		fyne.DoAndWait(func() {
			einzelFensterMu.Lock()
			w := einzelFenster[isoFensterSchluessel]
			einzelFensterMu.Unlock()
			if w != nil {
				w.Close()
			}
			myApp = oldApp
		})
		isoDateiDialog = altDialog
		baseApp.Quit()
		fyne.SetCurrentApp(previousApp)
	})

	fenster := func() fyne.Window {
		einzelFensterMu.Lock()
		defer einzelFensterMu.Unlock()
		return einzelFenster[isoFensterSchluessel]
	}
	labelMit := func(teil string) bool {
		gefunden := false
		a9Visit(fenster().Content(), func(o fyne.CanvasObject) {
			if l, ok := o.(*widget.Label); ok && strings.Contains(l.Text, teil) {
				gefunden = true
			}
		})
		return gefunden
	}
	// Menuepunkt: Fenster + Dateiauswahl sofort; die Auswahl bindet neu.iso ein.
	fyne.DoAndWait(func() { zeigeIsoFenster(true) })
	if dialogAufrufe != 1 {
		t.Fatalf("Dateiauswahl nicht gestartet: %d", dialogAufrufe)
	}
	a9WaitWidget(t, func() bool {
		return labelMit("neu.iso") && labelMit("alt.iso") && labelMit("2 ISO-Image(s) eingebunden")
	})
	if !isoAufrufMit(f.liste(), "loop-setup --no-user-interaction -r -f "+iso) {
		t.Fatalf("nicht read-only eingebunden: %v", f.liste())
	}
	// Auswerfen von alt.iso.
	var auswerfen *widget.Button
	fyne.DoAndWait(func() {
		a9Visit(fenster().Content(), func(o fyne.CanvasObject) {
			c, ok := o.(*fyne.Container)
			if !ok {
				return
			}
			istAlt := false
			for _, k := range c.Objects {
				if l, ok := k.(*widget.Label); ok && strings.Contains(l.Text, "alt.iso") {
					istAlt = true
				}
			}
			if !istAlt {
				return
			}
			a9Visit(c, func(o fyne.CanvasObject) {
				if b, ok := o.(*widget.Button); ok && b.Text == "Auswerfen" {
					auswerfen = b
				}
			})
		})
	})
	if auswerfen == nil {
		t.Fatal("Knopf Auswerfen fuer alt.iso fehlt")
	}
	fyne.DoAndWait(func() { fynetest.Tap(auswerfen) })
	a9WaitWidget(t, func() bool { return !labelMit("alt.iso") && labelMit("1 ISO-Image(s) eingebunden") })
	if !isoAufrufMit(f.liste(), "udisksctl unmount --no-user-interaction -b /dev/loop1") || !isoAufrufMit(f.liste(), "udisksctl loop-delete --no-user-interaction -b /dev/loop1") {
		t.Fatalf("Auswerfen: %v", f.liste())
	}
	// Zweiter Menueklick bei offenem Fenster: nur nach vorn + Dateiauswahl, kein zweites Fenster.
	fyne.DoAndWait(func() { zeigeIsoFenster(true) })
	if dialogAufrufe != 2 || !einzelFensterOffen(isoFensterSchluessel) {
		t.Fatalf("zweiter Klick: Dialoge %d", dialogAufrufe)
	}
	// Einbinden laeuft im Hintergrund: abwarten (Knopf wieder frei), bevor Cleanup die Fakes zuruecksetzt.
	a9WaitWidget(t, func() bool {
		b := isoFindeKnopf(fenster().Content(), "Image einbinden …")
		return b != nil && !b.Disabled()
	})
	setups := 0
	for _, a := range f.liste() {
		if strings.Contains(a, "loop-setup") {
			setups++
		}
	}
	if setups != 1 {
		t.Fatalf("bereits eingebundenes Image erneut angelegt (%d loop-setup)", setups)
	}
}
