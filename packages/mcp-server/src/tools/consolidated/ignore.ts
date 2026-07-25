/**
 * Synapse MCP - Consolidated ignore Tool
 *
 * Regelt, welche Dateien Synapse indexiert und anzeigt (frueher die Datei
 * .synapseignore). Die Regeln liegen pro Projekt in der Datenbank, damit der
 * lokale Daemon und die API dieselben Regeln sehen.
 */

import {
  listeIgnoreRegeln,
  fuegeIgnoreRegelnHinzu,
  entferneIgnoreRegel,
  schalteIgnoreRegel,
  pruefeIgnorePfad,
  resolveAgentId,
} from '@synapse/core';

import { ConsolidatedTool, str, reqStr } from './types.js';

export const ignoreTool: ConsolidatedTool = {
  definition: {
    name: 'ignore',
    description:
      'Regelt, welche Dateien Synapse indexiert und anzeigt (frueher .synapseignore). ' +
      'Regeln liegen pro Projekt in der Datenbank und gelten fuer den lokalen Daemon und die API gleichermassen. ' +
      'Einzelne Regeln lassen sich ABSCHALTEN statt loeschen (enable/disable) — die Regel bleibt erhalten. ' +
      'Gesperrte Regeln (node_modules, .git, dist, .env, .mcp.json) sind nicht abschaltbar, damit kein Paket- oder ' +
      'Build-Verzeichnis in den Index geraet. action="test" sagt, WELCHE Regel einen Pfad ausblendet.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'enable', 'disable', 'test'],
          description: 'Aktion: list | add | remove | enable | disable | test',
        },
        project: { type: 'string', description: 'Projekt-Name (Pflicht)' },
        pattern: { type: 'string', description: 'Muster wie "*.txt" oder "docs/" — Pflicht fuer add, remove, enable, disable' },
        patterns: { type: 'array', items: { type: 'string' }, description: 'Mehrere Muster auf einmal (nur fuer add)' },
        scope: { type: 'string', description: 'Optional fuer add: Muster nur unterhalb dieses Teilbaums anwenden' },
        kommentar: { type: 'string', description: 'Optional fuer add: wofuer die Regel da ist' },
        file_path: { type: 'string', description: 'Pflicht fuer test: der zu pruefende Pfad, relativ zum Projekt' },
        agent_id: { type: 'string', description: 'Agent-ID' },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');

    switch (action) {
      case 'list': {
        const regeln = await listeIgnoreRegeln(project);
        return {
          success: true,
          count: regeln.length,
          rules: regeln,
          hinweis:
            'Reihenfolge zaehlt: die spaetere Regel gewinnt. Gesperrte Regeln (locked) lassen sich nicht abschalten.',
        };
      }

      case 'add': {
        const einzeln = str(args, 'pattern');
        const mehrere = Array.isArray(args.patterns) ? (args.patterns as string[]) : [];
        const liste = mehrere.length ? mehrere : einzeln ? [einzeln] : [];
        if (!liste.length) throw new Error('pattern oder patterns[] erforderlich');
        const ergebnis = await fuegeIgnoreRegelnHinzu(
          project,
          liste.map((muster) => ({ pattern: muster, scope: str(args, 'scope'), kommentar: str(args, 'kommentar') })),
          resolveAgentId(str(args, 'agent_id')),
        );
        return {
          success: true,
          ...ergebnis,
          message:
            `${ergebnis.hinzugefuegt.length} Regel(n) angelegt` +
            (ergebnis.uebersprungen.length ? `, ${ergebnis.uebersprungen.length} gab es schon` : ''),
        };
      }

      case 'remove': {
        const ergebnis = await entferneIgnoreRegel(project, reqStr(args, 'pattern'));
        return { success: ergebnis.entfernt, ...ergebnis };
      }

      case 'enable':
      case 'disable': {
        const ergebnis = await schalteIgnoreRegel(project, reqStr(args, 'pattern'), action === 'enable');
        return { success: ergebnis.geschaltet, ...ergebnis };
      }

      case 'test': {
        const ergebnis = await pruefeIgnorePfad(project, reqStr(args, 'file_path'));
        return { success: true, ...ergebnis };
      }

      default:
        throw new Error(`Unbekannte ignore action: "${action}"`);
    }
  },
};
