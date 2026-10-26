/** P22-T195: EIN Vertrag fuer REST und stdio. */
export const ANMERKUNGEN_DEFINITION = {
  "name": "anmerkungen",
  "description": "P22-T195: dauerhafte User-Anmerkungen an Quellen lesen und mit Beleg abarbeiten. liste (Standard offen), get mit unveraenderlicher Vorversion und aktueller Version, status eingearbeitet/abgelehnt, diagnose mit Schalter zeilen_anmerkungen (Standard AUS) und PG-Grenzen. Quelle ueber ihre bestehenden Schreibwege bereinigen; erst danach status mit beleg_version_id und Grund setzen. Ein Versand ist kein Einarbeitungsbeleg.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "liste",
          "get",
          "status",
          "diagnose"
        ],
        "description": "Offene Quellenanmerkungen lesen; Status mit Grund und Versionsbeleg setzen."
      },
      "project": {
        "type": "string",
        "description": "Projekt der Quelle."
      },
      "art": {
        "type": "string",
        "enum": [
          "thought",
          "memory",
          "task",
          "plan",
          "artefakt",
          "chat",
          "nachricht"
        ],
        "description": "Quellenart fuer liste."
      },
      "quelle_id": {
        "type": "string",
        "description": "liste: stabile Quellen-ID, Memory-Name oder Plan-/Task-Kurz-ID."
      },
      "id": {
        "type": "string",
        "description": "get/status: Anmerkungs-ID."
      },
      "status": {
        "type": "string",
        "enum": [
          "offen",
          "eingearbeitet",
          "abgelehnt",
          "alle"
        ],
        "description": "liste: Filter; status: eingearbeitet oder abgelehnt."
      },
      "grund": {
        "type": "string",
        "description": "status: Begruendung, bei Ablehnung zwingend."
      },
      "beleg_version_id": {
        "type": "string",
        "description": "eingearbeitet: aktuelle geaenderte Version aus get.aktuelle_version.id."
      },
      "offset": {
        "type": "number",
        "description": "liste: Cursor aus naechster_offset."
      },
      "agent_id": {
        "type": "string",
        "description": "Optionale Agent-ID fuer Attribution."
      }
    },
    "required": [
      "action",
      "project"
    ]
  }
};
