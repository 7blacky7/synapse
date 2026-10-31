# Übersicht

Dieser Ordner enthält die UI-Module für die Projektübersicht der Web-Oberfläche.

## Module

- `ProjectSelector.tsx`: zeigt aktive und inaktive Projekte, ermöglicht Suche, Vorschläge, Tastaturnavigation und die Auswahl eines Projekts. Wird seit P22-T230 auch in der Seitenleiste wiederverwendet (`components/workspace/SeitenleisteProjekt.tsx`, Feld an der Karte 'Aktives Projekt', Prop `autoFocus`); keine zweite Suchlogik.

## Herkunft

Die Module wurden im Rahmen von P26 aus `packages/web-ui/src/components/SynapseWorkspaceMock.tsx` herausgelöst. `ProjectSelector` stammt aus der dortigen Übersichtskomponente und bewahrt deren bestehende Logik, Texte und Styles.
