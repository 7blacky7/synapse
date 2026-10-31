# Entitäten-Views

Dieser Ordner enthält die Web-UI-Ansichten für Entitäten und Systemstatus:

- EntityView.tsx zeigt den Bereich abhängig von Area, lädt für den Systembereich die Statuswerte über die echte API, verwaltet Auswahl, Ladezustand und Fehler und stellt die Liste dar.
- EntityDetail.tsx zeigt die Detaildaten der ausgewählten Entität einschließlich Status, Quelle und Detailwerten.

Die beiden Module wurden im Rahmen von P26-T20 aus packages/web-ui/src/components/SynapseWorkspaceMock.tsx herausgelöst. Die Implementierung und die sichtbaren Texte entsprechen dem dortigen Bestand; ergänzt wurden lediglich die für die eigenständigen Dateien erforderlichen Importe und Exporte.
