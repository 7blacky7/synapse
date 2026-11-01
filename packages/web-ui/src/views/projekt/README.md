# Projektansichten der Web-UI

Dieser Ordner enthält die projektbezogenen Ansichten und ihre kleinen, fachlich zugehörigen Hilfsmodule.

Die Module `agententeam-logik.ts` und `agententeam-konstanten.ts` stammen aus dem Refactoring von `components/SynapseWorkspaceMock.tsx`. Sie kapseln die Teamdarstellung des Projektbereichs: Statusfarbe, Team-Schlüssel, Kontextanzeige, Anmeldeanzeige und die zugehörigen Anmeldeanlässe.

`agententeam-suche-logik.ts` (P22-T270) enthält die reine Logik der Agententeam-Suche und des Ausweis-Fensters: Trefferreihenfolge, die bearbeitbaren Ausweis-Felder (nur bestehende Profilfelder), den Patch geänderter Felder und das Zuweisen bzw. Entziehen von Channels. Getestet ohne DB in `web-ui/tests/agententeam-suche-p22-t270.test.mjs`.
