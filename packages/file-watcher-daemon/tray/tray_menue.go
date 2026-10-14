package main

// tray_menue.go — Aufbau des Tray-Hauptmenues als reine Funktion (P8-T21).
//
// WARUM: Das Menue listete alle Projekte (87, davon 25 aktiv) oben, darunter
// die globalen Eintraege. Bei langer Liste lagen "Synapse-Verbindung",
// "Beenden" usw. ausser Sicht, und KDE zeigte sie wegen eines fehlenden
// LayoutUpdated gar nicht (siehe Kommentar am Ende von rebuildMenu).
//
// JETZT: globale Eintraege zuerst, darunter nur die aktiven Projekte, die
// inaktiven im Untermenue "Inaktive Projekte (N)". Mehr als
// maxAktiveProjekteOben aktive Projekte wandern in "Weitere aktive Projekte".
// Damit bleibt das Hauptmenue unter maxHauptmenueEintraege Eintraegen.
//
// Die Funktion hier entscheidet nur die REIHENFOLGE und GRUPPIERUNG; sie
// beruehrt systray nicht und ist deshalb ohne D-Bus testbar. rebuildMenu
// (tray.go) setzt das Layout eins zu eins in Menue-Eintraege um.

import "fmt"

const (
	// Hoechstzahl aktiver Projekte direkt im Hauptmenue.
	maxAktiveProjekteOben = 20
	// Obergrenze fuer Eintraege im Hauptmenue (inkl. Trenner), siehe Test.
	maxHauptmenueEintraege = 40
)

type menueArt int

const (
	menueStatus menueArt = iota
	menueTrenner
	menueDaemonStarten
	menueVerbinden
	menueAssetSync
	menueReverse
	menueGPU
	menueWorkspaces
	menueNeuLaden
	menueDeaktivieren
	menueBeenden
	menueKeineProjekte
	menueProjekt
	menueWeitereAktive
	menueInaktive
)

// menueEintrag ist ein Eintrag im Hauptmenue.
type menueEintrag struct {
	Art     menueArt
	Projekt Project   // nur bei menueProjekt
	Gruppe  []Project // nur bei menueWeitereAktive / menueInaktive
}

// projektAufteilung trennt die Projekte fuer das Menue. Die Reihenfolge des
// Daemons bleibt in jeder Gruppe erhalten.
type projektAufteilung struct {
	Oben          []Project
	WeitereAktive []Project
	Inaktive      []Project
}

func teileProjekteAuf(projs []Project, maxOben int) projektAufteilung {
	var a projektAufteilung
	for _, p := range projs {
		switch {
		case !p.Enabled:
			a.Inaktive = append(a.Inaktive, p)
		case len(a.Oben) < maxOben:
			a.Oben = append(a.Oben, p)
		default:
			a.WeitereAktive = append(a.WeitereAktive, p)
		}
	}
	return a
}

// aktiveProjekte liefert nur die aktiven Projekte (Reihenfolge bleibt).
func aktiveProjekte(projs []Project) []Project {
	out := make([]Project, 0, len(projs))
	for _, p := range projs {
		if p.Enabled {
			out = append(out, p)
		}
	}
	return out
}

// hauptmenueLayout berechnet die Eintraege des Hauptmenues in Anzeige-Reihenfolge.
func hauptmenueLayout(verbunden bool, projs []Project) []menueEintrag {
	l := []menueEintrag{{Art: menueStatus}, {Art: menueTrenner}}
	if !verbunden {
		l = append(l, menueEintrag{Art: menueDaemonStarten})
	}
	l = append(l,
		menueEintrag{Art: menueVerbinden},
		menueEintrag{Art: menueAssetSync},
		menueEintrag{Art: menueReverse},
		menueEintrag{Art: menueGPU},
		menueEintrag{Art: menueWorkspaces},
		menueEintrag{Art: menueTrenner},
		menueEintrag{Art: menueNeuLaden},
	)
	// "Deaktivieren" nur wenn der Daemon laeuft — offline steht oben "Daemon starten".
	if verbunden {
		l = append(l, menueEintrag{Art: menueDeaktivieren})
	}
	l = append(l, menueEintrag{Art: menueBeenden})
	if !verbunden {
		return l
	}

	l = append(l, menueEintrag{Art: menueTrenner})
	if len(projs) == 0 {
		return append(l, menueEintrag{Art: menueKeineProjekte})
	}
	a := teileProjekteAuf(projs, maxAktiveProjekteOben)
	for _, p := range a.Oben {
		l = append(l, menueEintrag{Art: menueProjekt, Projekt: p})
	}
	if len(a.WeitereAktive) > 0 {
		l = append(l, menueEintrag{Art: menueWeitereAktive, Gruppe: a.WeitereAktive})
	}
	if len(a.Inaktive) > 0 {
		l = append(l, menueEintrag{Art: menueInaktive, Gruppe: a.Inaktive})
	}
	return l
}

// gruppenLabel beschriftet die Projekt-Untermenues mit Anzahl.
func gruppenLabel(e menueEintrag) string {
	if e.Art == menueWeitereAktive {
		return fmt.Sprintf("Weitere aktive Projekte (%d)", len(e.Gruppe))
	}
	return fmt.Sprintf("Inaktive Projekte (%d)", len(e.Gruppe))
}

// projektLabel: gefuellter Punkt = aktiv, leerer Punkt = inaktiv. Dieselben
// Praefixe setzt toggleProject beim Umschalten.
func projektLabel(p Project) string {
	if p.Enabled {
		return "●  " + p.Name
	}
	return "○  " + p.Name
}

// workspacesLabel beschriftet das Workspaces-Untermenue je Abrufzustand.
func workspacesLabel(ws []Workspace, zustand string) string {
	switch zustand {
	case wsZustandOK:
		running := 0
		for _, w := range ws {
			if w.Status == "active" || w.Status == "warming" {
				running++
			}
		}
		return fmt.Sprintf("Workspaces  (%d/%d)", running, len(ws))
	case wsZustandNichtVerbunden:
		return "Workspaces (nicht verbunden)"
	case "":
		return "Workspaces (wird geladen …)"
	default:
		return "Workspaces (offline)"
	}
}
