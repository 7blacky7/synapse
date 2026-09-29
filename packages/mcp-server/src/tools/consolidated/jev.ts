/**
 * Konsolidiertes MCP-Tool fuer JEV-10 (P7-T28): Jev entscheidet Rueckfragen, wenn der User weg ist.
 *
 * Actions:
 *  - entscheiden: beantwortet eine ERLAUBTE Rueckfrage (noul|choice|score) — nur bei aktivem Schalter
 *  - abwesend:    Schalter an/aus/status (an/aus nur der Koordinator)
 *  - protokoll:   Jev-Entscheidungen seit Schalter-Beginn
 *  - ueberstimmen: Koordinator markiert eine Entscheidung als ueberstimmt
 * Logik in @synapse/core (jev-entscheidung.ts).
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, num, bool } from './types.js';
import {
  entscheideRueckfrage,
  setzeAbwesenheit,
  holeEntscheidungsProtokoll,
  ueberstimmeEntscheidung,
} from '@synapse/core';

/** optionen kann als Objekt oder als JSON-String ankommen (Connector-Quirk) */
export function optionenAus(args: Record<string, unknown>): Record<string, string> | undefined {
  const v = args.optionen;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, string>;
    } catch { /* ungueltig -> undefined, der Service meldet es */ }
  }
  return undefined;
}

export const jevTool: ConsolidatedTool = {
  definition: {
    name: 'jev',
    description:
      'Jev entscheidet Rueckfragen, wenn der User nicht da ist. Actions: entscheiden (erlaubte Rueckfrage per Jev beantworten: frage, typ noul|choice|score, kategorie variante|reihenfolge|umsetzungsweg|formulierung, optionen {key: Beschreibung}, agent_id — wirkt NUR bei aktivem Schalter, sonst Antwort \"User/Koordinator fragen\"; unter Confidence 0.7 keine Entscheidung; Antwort ist mit \"entschieden von Jev, nicht vom User\" gekennzeichnet), abwesend (modus an|aus|status; an/aus nur agent_id koordinator, auf Zuruf des Users; aus liefert das Protokoll), protokoll (Entscheidungen seit Schalter-Beginn), ueberstimmen (nur Koordinator). Verboten fuer Jev: loeschen, deploy, git, secrets, aussenwirkung, kosten, regeln.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['entscheiden', 'abwesend', 'protokoll', 'ueberstimmen'], description: 'Aktion' },
        project: { type: 'string', description: 'Projekt-Name' },
        agent_id: { type: 'string', description: 'Wer fragt/setzt (Pflicht fuer entscheiden, abwesend an/aus, ueberstimmen)' },
        frage: { type: 'string', description: 'Nur entscheiden: die Rueckfrage (max. 500 Zeichen)' },
        typ: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'Nur entscheiden: noul = ja/nein, choice = Auswahl, score = Skala (Standard 1..5)' },
        kategorie: { type: 'string', description: 'Nur entscheiden (Pflicht): variante | reihenfolge | umsetzungsweg | formulierung. Verbotene und unbekannte lehnt der Server ab.' },
        optionen: { type: 'object', description: 'Nur entscheiden: choice IMMER genau 5 {key: Beschreibung}: 4 echte (je mit WANN sie richtig ist) + Schluessel "weitere" (Beschreibung setzt der Server); mit letzte_runde:true 2..5 echte OHNE weitere. score optional {"1": Anker, ...}', additionalProperties: { type: 'string' } },
        runde: { type: 'number', description: 'Nur entscheiden (choice): Runde der Kette, Start 1. Waehlt Jev "weitere", ruft der Agent mit runde+1 erneut auf.' },
        verworfen: { type: 'array', description: 'Nur entscheiden (choice): in frueheren Runden verworfene Optionen [{key, beschreibung}] (max 20); sie duerfen nicht wiederkommen und gehen als state.verworfen an Jev', items: { type: 'object', properties: { key: { type: 'string' }, beschreibung: { type: 'string' } }, required: ['key'] } },
        letzte_runde: { type: 'boolean', description: 'Nur entscheiden (choice): Abschluss — "weitere" nicht erlaubt, 2..5 echte Optionen (die besten bisherigen). Pflicht in der Grenzrunde (Standard 4, Env JEV_MAX_RUNDEN).' },
        erste_id: { type: 'number', description: 'Nur entscheiden: ab Runde 2 Pflicht — protokoll_id/erste_id der Antwort auf die erste Frage der Kette (haengt die Runden im Protokoll zusammen)' },
        keine_plausible_option: { type: 'boolean', description: 'Nur entscheiden: dem Agenten faellt keine plausible Option mehr ein — kein Jev-Aufruf, die Frage wird als OFFENE FRAGE fuer den User protokolliert (offen_fuer_user)' },
        blocker: { type: 'boolean', description: 'Nur entscheiden (am Ende der Kette): true = KOMPLETTER Blocker (keine andere passende Task) -> Einsprung Koordinator statt "Task auf todo, andere Task". Standard false.' },
        kontext: { type: 'string', description: 'Nur entscheiden: Task/Plan/bisherige Diskussion (max. 1500 Zeichen, wird gekuerzt)' },
        task_id: { type: 'string', description: 'Nur entscheiden: zugehoerige Task (fuer das Protokoll)' },
        hinweise: { type: 'string', description: 'Nur entscheiden: eigene Prioritaeten fuer Jev (max. 500 Zeichen)' },
        confidence_tor: { type: 'number', description: 'Nur entscheiden: Tor (0..1), Standard 0.7 (Env JEV_ENTSCHEIDUNG_TOR)' },
        modus: { type: 'string', enum: ['an', 'aus', 'status'], description: 'Nur abwesend: Schalter an/aus/status' },
        bis: { type: 'string', description: 'Nur abwesend an (freiwillig): ISO-Zeitpunkt in der Zukunft, danach gilt der Schalter als aus. Standard: kein Ablauf.' },
        stunden: { type: 'number', description: 'Nur abwesend an (freiwillig): Alternative zu bis, in N Stunden' },
        seit: { type: 'string', description: 'Nur protokoll: ISO-Zeitpunkt; Standard = Beginn des Schalters' },
        nur_entschieden: { type: 'boolean', description: 'Nur protokoll: nur tatsaechlich entschiedene Eintraege' },
        limit: { type: 'number', description: 'Nur protokoll: Hoechstzahl (Standard 50, max 200)' },
        id: { type: 'number', description: 'Nur ueberstimmen: Protokoll-Nummer' },
        wahl: { type: 'string', description: 'Nur ueberstimmen: die richtige Entscheidung (Option, ja/nein oder Zahl)' },
        notiz: { type: 'string', description: 'Nur ueberstimmen: Begruendung' },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');
    switch (action) {
      case 'entscheiden':
        return (await entscheideRueckfrage(project, {
          agent_id: str(args, 'agent_id'),
          frage: str(args, 'frage'),
          typ: str(args, 'typ'),
          kategorie: str(args, 'kategorie'),
          optionen: optionenAus(args),
          kontext: str(args, 'kontext'),
          task_id: str(args, 'task_id'),
          hinweise: str(args, 'hinweise'),
          confidence_tor: num(args, 'confidence_tor'),
          runde: num(args, 'runde'),
          verworfen: args.verworfen,
          letzte_runde: bool(args, 'letzte_runde'),
          erste_id: num(args, 'erste_id'),
          blocker: bool(args, 'blocker'),
          keine_plausible_option: bool(args, 'keine_plausible_option'),
        })) as Record<string, unknown>;
      case 'abwesend':
        return (await setzeAbwesenheit(project, {
          modus: str(args, 'modus'),
          agent_id: str(args, 'agent_id'),
          bis: str(args, 'bis'),
          stunden: num(args, 'stunden'),
        })) as Record<string, unknown>;
      case 'protokoll':
        return (await holeEntscheidungsProtokoll(project, {
          seit: str(args, 'seit'),
          nur_entschieden: bool(args, 'nur_entschieden'),
          limit: num(args, 'limit'),
        })) as unknown as Record<string, unknown>;
      case 'ueberstimmen':
        return (await ueberstimmeEntscheidung(project, {
          id: num(args, 'id'),
          wahl: args.wahl,
          notiz: str(args, 'notiz'),
          agent_id: str(args, 'agent_id'),
        })) as Record<string, unknown>;
      default:
        throw new Error(`Unbekannte action "${action}". Gueltig sind: "entscheiden", "abwesend", "protokoll", "ueberstimmen"`);
    }
  },
};
