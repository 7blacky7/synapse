package main

// iso_images.go — P18-T65 (RV43a): ISO-Abbilder (ISO9660/UDF, *.iso) im Tray als
// Laufwerk einbinden und wieder auswerfen (Virtual-CloneDrive-Ersatz).
//
// Linux: udisksctl loop-setup -r -f <iso> (NUR LESEND, ohne Root), danach
// udisksctl mount -b <loop>; Auswerfen: udisksctl unmount -b <loop> + loop-delete.
// Loop-Geraet und Mountpunkt kommen aus der Ausgabe der Werkzeuge, nie geraten.
// Zustand: nur im Speicher bzw. jedes Mal frisch aus losetup/lsblk; keine Datei,
// kein PG, keine API. Eingebunden wird nur, was der User ausdruecklich waehlt.
// Windows/macOS: nicht angeboten (spaeter PowerShell Mount-DiskImage).
//
// Diese Datei enthaelt nur Logik ohne Fyne; das Fenster steht in iso_images_ui.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// isoUnterstuetzt: Menuepunkt und Knopf nur, wo udisks existiert (Linux).
var isoUnterstuetzt = runtime.GOOS == "linux"

// isoKommandoFehler: ein Werkzeug lief nicht oder meldete einen Fehler.
type isoKommandoFehler struct {
	Name    string
	Text    string // stderr bzw. stdout, getrimmt
	Fehlt   bool   // Programm nicht gefunden
	Ursache error
}

func (e *isoKommandoFehler) Error() string {
	if e.Fehlt {
		return e.Name + " nicht gefunden"
	}
	if e.Text != "" {
		return e.Name + ": " + e.Text
	}
	return e.Name + ": " + e.Ursache.Error()
}

// isoRunner fuehrt ein Kommando aus und liefert stdout. Austauschbar fuer Tests.
type isoRunner func(ctx context.Context, name string, args ...string) (string, error)

var isoKommando isoRunner = func(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	// Keine Rueckfragen von udisks/polkit im Terminal.
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	err := cmd.Run()
	if err != nil {
		f := &isoKommandoFehler{Name: name, Ursache: err, Fehlt: errors.Is(err, exec.ErrNotFound)}
		f.Text = strings.TrimSpace(errOut.String())
		if f.Text == "" {
			f.Text = strings.TrimSpace(out.String())
		}
		return out.String(), f
	}
	return out.String(), nil
}

// isoOeffnen zeigt den Mountpunkt im Dateimanager (xdg-open). Austauschbar fuer Tests.
var isoOeffnen = func(pfad string) error {
	if !filepath.IsAbs(pfad) {
		return fmt.Errorf("Kein Mountpunkt bekannt")
	}
	cmd := exec.Command("xdg-open", pfad)
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return fmt.Errorf("xdg-open nicht gefunden – Ordner bitte selbst öffnen: %s", pfad)
		}
		return err
	}
	go cmd.Wait()
	return nil
}

// isoStat ist austauschbar (Tests mit synthetischen Pfaden).
var isoStat = os.Stat

// isoImage ist ein eingebundenes (oder nur als Loop angelegtes) Abbild.
type isoImage struct {
	Geraet     string // /dev/loopN
	Datei      string // Backing-File
	Mountpunkt string // "" = Loop vorhanden, aber nicht eingehaengt
	NurLesen   bool
}

// isoIstIsoDatei: nur *.iso (Gross-/Kleinschreibung egal).
func isoIstIsoDatei(pfad string) bool {
	return strings.EqualFold(filepath.Ext(pfad), ".iso")
}

// isoVerstaendlich uebersetzt Werkzeugfehler in Klartext.
func isoVerstaendlich(err error) error {
	if err == nil {
		return nil
	}
	var f *isoKommandoFehler
	if !errors.As(err, &f) {
		return err
	}
	text := f.Text
	switch {
	case f.Fehlt && f.Name == "udisksctl":
		return fmt.Errorf("udisks nicht verfügbar: udisksctl ist nicht installiert (Paket udisks2)")
	case f.Fehlt:
		return fmt.Errorf("%s nicht verfügbar (Paket util-linux)", f.Name)
	case strings.Contains(text, "ServiceUnknown") || strings.Contains(text, "Error connecting to the udisks daemon") ||
		strings.Contains(text, "org.freedesktop.UDisks2 was not provided"):
		return fmt.Errorf("udisks nicht verfügbar: der Dienst udisks2 läuft nicht")
	case strings.Contains(text, "NotAuthorized") || strings.Contains(text, "not authorized"):
		return fmt.Errorf("Keine Berechtigung (udisks/polkit hat abgelehnt): %s", text)
	case strings.Contains(text, "NotMountable") || strings.Contains(text, "No usable filesystem") ||
		strings.Contains(text, "wrong fs type") || strings.Contains(text, "unknown filesystem type") ||
		strings.Contains(text, "Filesystem type not supported"):
		return fmt.Errorf("Kein ISO-Dateisystem erkannt (ISO9660/UDF) – das Abbild lässt sich nicht einbinden")
	}
	return err
}

var (
	isoLoopMuster       = regexp.MustCompile(`(?m)^Mapped file .* as (/dev/[^\s]+?)\.?\s*$`)
	isoMountMuster      = regexp.MustCompile(`(?m)^Mounted /dev/[^\s]+ at (.+?)\s*$`)
	isoSchonMountMuster = regexp.MustCompile("already mounted at [`'\"](.+?)['`\"]")
	isoGeraetNameMuster = regexp.MustCompile(`^/dev/loop[0-9]+$`)
)

// isoParseLoop liest das Loop-Geraet aus "Mapped file X as /dev/loop0."
func isoParseLoop(ausgabe string) (string, error) {
	m := isoLoopMuster.FindStringSubmatch(ausgabe)
	if m == nil || !isoGeraetNameMuster.MatchString(m[1]) {
		return "", fmt.Errorf("udisksctl loop-setup: unerwartete Ausgabe %q", strings.TrimSpace(ausgabe))
	}
	return m[1], nil
}

// isoPunktPfad: aeltere udisks-Versionen haengen einen Satzpunkt an. Ein Pfad,
// der wirklich mit Punkt endet und existiert, bleibt unveraendert.
func isoPunktPfad(p string) string {
	if strings.HasSuffix(p, ".") {
		if _, err := isoStat(p); err != nil {
			return strings.TrimSuffix(p, ".")
		}
	}
	return p
}

// isoParseMount liest den Mountpunkt aus "Mounted /dev/loop0 at /run/media/u/X".
func isoParseMount(ausgabe string) (string, error) {
	m := isoMountMuster.FindStringSubmatch(ausgabe)
	if m == nil {
		return "", fmt.Errorf("udisksctl mount: unerwartete Ausgabe %q", strings.TrimSpace(ausgabe))
	}
	p := isoPunktPfad(m[1])
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("udisksctl mount: kein absoluter Mountpunkt %q", p)
	}
	return p, nil
}

// isoParseSchonEingehaengt: "... is already mounted at `/run/media/u/X'."
func isoParseSchonEingehaengt(text string) (string, bool) {
	m := isoSchonMountMuster.FindStringSubmatch(text)
	if m == nil || !filepath.IsAbs(m[1]) {
		return "", false
	}
	return m[1], true
}

// isoBool liest true/false, "1"/"0" oder 1/0 (je nach util-linux-Version).
func isoBool(raw json.RawMessage) bool {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	return s == "true" || s == "1"
}

// isoParseLosetup liest `losetup --list --json --output NAME,BACK-FILE,RO`.
// Leere Ausgabe = keine Loop-Geraete. Nur *.iso-Abbilder werden geliefert.
func isoParseLosetup(ausgabe string) ([]isoImage, error) {
	if strings.TrimSpace(ausgabe) == "" {
		return nil, nil
	}
	var roh struct {
		Loop []struct {
			Name     string          `json:"name"`
			BackFile string          `json:"back-file"`
			RO       json.RawMessage `json:"ro"`
		} `json:"loopdevices"`
	}
	if err := json.Unmarshal([]byte(ausgabe), &roh); err != nil {
		return nil, fmt.Errorf("losetup: Ausgabe nicht lesbar: %v", err)
	}
	var out []isoImage
	for _, l := range roh.Loop {
		datei := strings.TrimSuffix(strings.TrimSpace(l.BackFile), " (deleted)")
		if !isoGeraetNameMuster.MatchString(l.Name) || !isoIstIsoDatei(datei) {
			continue
		}
		out = append(out, isoImage{Geraet: l.Name, Datei: datei, NurLesen: isoBool(l.RO)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Geraet < out[j].Geraet })
	return out, nil
}

type isoLsblkGeraet struct {
	Name       string           `json:"name"`
	Mountpoint *string          `json:"mountpoint"`
	Children   []isoLsblkGeraet `json:"children"`
}

// isoErsterMountpunkt: Geraet selbst oder (Hybrid-ISO) erste Partition.
func isoErsterMountpunkt(g isoLsblkGeraet) string {
	if g.Mountpoint != nil && filepath.IsAbs(*g.Mountpoint) {
		return *g.Mountpoint
	}
	for _, k := range g.Children {
		if p := isoErsterMountpunkt(k); p != "" {
			return p
		}
	}
	return ""
}

// isoParseLsblk liest `lsblk -J -p -o NAME,MOUNTPOINT <geraete>` -> Geraet -> Mountpunkt.
func isoParseLsblk(ausgabe string) (map[string]string, error) {
	var roh struct {
		Geraete []isoLsblkGeraet `json:"blockdevices"`
	}
	if err := json.Unmarshal([]byte(ausgabe), &roh); err != nil {
		return nil, fmt.Errorf("lsblk: Ausgabe nicht lesbar: %v", err)
	}
	out := map[string]string{}
	for _, g := range roh.Geraete {
		out[g.Name] = isoErsterMountpunkt(g)
	}
	return out, nil
}

// isoListe ermittelt die ISO-Loop-Geraete samt Mountpunkt frisch vom System.
func isoListe(ctx context.Context) ([]isoImage, error) {
	aus, err := isoKommando(ctx, "losetup", "--list", "--json", "--output", "NAME,BACK-FILE,RO")
	if err != nil {
		return nil, isoVerstaendlich(err)
	}
	liste, err := isoParseLosetup(aus)
	if err != nil || len(liste) == 0 {
		return liste, err
	}
	args := []string{"-J", "-p", "-o", "NAME,MOUNTPOINT"}
	for _, i := range liste {
		args = append(args, i.Geraet)
	}
	aus, err = isoKommando(ctx, "lsblk", args...)
	if err != nil {
		return liste, isoVerstaendlich(err)
	}
	mounts, err := isoParseLsblk(aus)
	if err != nil {
		return liste, err
	}
	for i := range liste {
		liste[i].Mountpunkt = mounts[liste[i].Geraet]
	}
	return liste, nil
}

// isoPruefeDatei: absolut, existiert, normale Datei, Endung .iso.
func isoPruefeDatei(pfad string) (string, error) {
	if !filepath.IsAbs(pfad) {
		return "", fmt.Errorf("Bitte eine Datei mit absolutem Pfad wählen")
	}
	if !isoIstIsoDatei(pfad) {
		return "", fmt.Errorf("Nur ISO-Abbilder (*.iso) lassen sich einbinden: %s", filepath.Base(pfad))
	}
	echt, err := filepath.EvalSymlinks(pfad)
	if err != nil {
		return "", fmt.Errorf("Abbild nicht gefunden: %s", pfad)
	}
	info, err := isoStat(echt)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("Kein normales Abbild: %s", pfad)
	}
	return echt, nil
}

// isoMount haengt ein Loop-Geraet ein; ist es (z. B. per Desktop-Automount)
// schon eingehaengt, gilt der gemeldete Mountpunkt.
func isoMount(ctx context.Context, geraet string) (string, error) {
	aus, err := isoKommando(ctx, "udisksctl", "mount", "--no-user-interaction", "-b", geraet)
	if err != nil {
		var f *isoKommandoFehler
		if errors.As(err, &f) {
			if p, ok := isoParseSchonEingehaengt(f.Text); ok {
				return p, nil
			}
		}
		return "", isoVerstaendlich(err)
	}
	return isoParseMount(aus)
}

// isoLoopLoeschen entfernt das Loop-Geraet. Ist es schon weg (Autoclear), ist das kein Fehler.
func isoLoopLoeschen(ctx context.Context, geraet string) error {
	_, err := isoKommando(ctx, "udisksctl", "loop-delete", "--no-user-interaction", "-b", geraet)
	if err == nil {
		return nil
	}
	var f *isoKommandoFehler
	if errors.As(err, &f) && (strings.Contains(f.Text, "No such") || strings.Contains(f.Text, "not a loop device") ||
		strings.Contains(f.Text, "Error looking up object for device")) {
		return nil
	}
	return isoVerstaendlich(err)
}

// isoEinbinden bindet ein vom User gewaehltes Abbild NUR LESEND ein. Ist es schon
// eingebunden, wird das vorhandene Loop-Geraet verwendet (kein zweites).
func isoEinbinden(ctx context.Context, pfad string) (isoImage, error) {
	if !isoUnterstuetzt {
		return isoImage{}, fmt.Errorf("Images einbinden folgt für dieses Betriebssystem")
	}
	echt, err := isoPruefeDatei(pfad)
	if err != nil {
		return isoImage{}, err
	}
	if liste, err := isoListe(ctx); err == nil {
		for _, i := range liste {
			if i.Datei != echt {
				continue
			}
			if i.Mountpunkt != "" {
				return i, nil
			}
			mp, err := isoMount(ctx, i.Geraet)
			if err != nil {
				return i, err
			}
			i.Mountpunkt = mp
			return i, nil
		}
	}
	aus, err := isoKommando(ctx, "udisksctl", "loop-setup", "--no-user-interaction", "-r", "-f", echt)
	if err != nil {
		return isoImage{}, isoVerstaendlich(err)
	}
	geraet, err := isoParseLoop(aus)
	if err != nil {
		return isoImage{}, err
	}
	mp, err := isoMount(ctx, geraet)
	if err != nil {
		// Kein haengendes Loop-Geraet zuruecklassen.
		_ = isoLoopLoeschen(context.WithoutCancel(ctx), geraet)
		return isoImage{}, err
	}
	return isoImage{Geraet: geraet, Datei: echt, Mountpunkt: mp, NurLesen: true}, nil
}

// isoAuswerfen haengt aus (falls eingehaengt) und loescht das Loop-Geraet.
func isoAuswerfen(ctx context.Context, img isoImage) error {
	if !isoGeraetNameMuster.MatchString(img.Geraet) {
		return fmt.Errorf("Ungültiges Loop-Gerät: %q", img.Geraet)
	}
	if img.Mountpunkt != "" {
		if _, err := isoKommando(ctx, "udisksctl", "unmount", "--no-user-interaction", "-b", img.Geraet); err != nil {
			var f *isoKommandoFehler
			if !errors.As(err, &f) || !strings.Contains(f.Text, "NotMounted") {
				if errors.As(err, &f) && (strings.Contains(f.Text, "DeviceBusy") || strings.Contains(f.Text, "target is busy")) {
					return fmt.Errorf("Laufwerk wird noch benutzt (offene Datei oder Fenster in %s) – bitte schließen und erneut auswerfen", img.Mountpunkt)
				}
				return isoVerstaendlich(err)
			}
		}
	}
	return isoLoopLoeschen(ctx, img.Geraet)
}

// reverseIsoEinbindbar: Knopf "Einbinden" im Reverse-Fenster nur bei *.iso-Fundstellen,
// die lokal noch im Bibliotheksordner liegen (nicht geloescht/fehlend).
func reverseIsoEinbindbar(f *reverseFundstelle) bool {
	if f == nil || !isoUnterstuetzt || !isoIstIsoDatei(f.RelPfad) {
		return false
	}
	return f.Lokal != "geloescht_lokal" && f.Lokal != "fehlt"
}

// isoImageText: eine Zeile fuer Liste und Dialoge.
func isoImageText(i isoImage) string {
	stand := "nicht eingehängt"
	if i.Mountpunkt != "" {
		stand = "→ " + i.Mountpunkt
	}
	schreib := ""
	if !i.NurLesen {
		schreib = " · NICHT schreibgeschützt"
	}
	return fmt.Sprintf("%s  (%s)  %s%s", filepath.Base(i.Datei), i.Geraet, stand, schreib)
}
