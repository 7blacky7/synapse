/**
 * MODUL: Intern-Tool (P14) — Definition + Dispatcher
 * ZWECK: Debugging und Steuerung interner Prozesse (Embedding, Parser-Worker, Context7-Automatik,
 *        Ollama) ohne SQL und ohne Neustart. EINE Definition, EIN Dispatcher; die REST-API haengt
 *        beides nur ein (Muster: asset-intel-tool.ts).
 *
 * SICHTBARKEIT: Das Tool existiert nur, wenn der Prozess mit SYNAPSE_INTERN_TOOL=1 gestartet wurde
 *   (beim Laden dieses Moduls festgehalten, internToolAktiv()). Sonst steht es nicht in tools/list,
 *   und jeder Aufruf wird mit INTERN_TOOL_AUS abgelehnt.
 * GRENZEN: Keine Aktion beendet Prozesse oder Sitzungen, keine loescht PG-Daten. Einzige Ausnahme beim
 *   Qdrant-Index: neu_einbetten (nur mit ausfuehren:true) leert veraltete Collections — sie sind aus PG
 *   wiederherstellbar und werden vom Nachzug neu befuellt (P12-T12).
 * ANTWORT: { success, action, ... } — wirft nie; Fehler als { success:false, action, error:<code>, message }.
 */

import {
  INTERN_SCHALTER,
  InternSchalterFehler,
  alleSchalter,
  hoechstdauerMs,
  setzeSchalter,
} from './intern-schalter.js';
import { InternOllamaFehler, embeddingMessen, ollamaEntladen, ollamaLaden, ollamaStatus } from './intern-ollama.js';
import { BACKLOG_TABELLEN, embeddeOffeneEintraege, zaehleOffeneEmbeddings } from './embed-backlog.js';
import { imHintergrund } from '../db/client.js';
import { dbSitzungen, internStatus, langsameAufrufe } from './intern-einblick.js';
import { NEU_EINBETTEN_ARTEN, neuEinbetten } from './neu-einbetten.js';

const INTERN_TOOL_BEIM_START = process.env.SYNAPSE_INTERN_TOOL === '1';

/** true, wenn der Prozess mit SYNAPSE_INTERN_TOOL=1 gestartet wurde. */
export function internToolAktiv(): boolean {
  return INTERN_TOOL_BEIM_START;
}

export const INTERN_TOOL_AUS = {
  success: false,
  error: 'intern_tool_aus',
  message: 'Das Tool "intern" ist in diesem Prozess nicht freigeschaltet (Start ohne SYNAPSE_INTERN_TOOL=1).',
} as const;

export const INTERN_ACTIONS = [
  'schalter_setzen', 'schalter_liste',
  'ollama_status', 'ollama_entladen', 'ollama_laden',
  'status', 'db_sitzungen', 'langsam',
  'nachzug_jetzt', 'embedding_messen', 'neu_einbetten',
] as const;
export type InternAction = (typeof INTERN_ACTIONS)[number];

export const INTERN_DEFINITION = {
  name: 'intern',
  description:
    'Debugging und Steuerung interner Synapse-Ablaeufe (nur sichtbar bei SYNAPSE_INTERN_TOOL=1). ' +
    'schalter_setzen haelt einen Ablauf an oder gibt ihn frei: name embedding (modus hintergrund | alle), parser, context7; ' +
    'aktiv:true = angehalten. Jeder Schalter laeuft ab (Default und Obergrenze 12 h), ohne Ablauf nur mit dauerhaft:true. ' +
    'schalter_liste zeigt alle Schalter mit Ablauf. ' +
    'ollama_status: geladene Modelle (VRAM, CPU/GPU-Anteil, Kontext, Ablauf), Version, installierte Embedding-Modelle; ' +
    'ollama_entladen / ollama_laden (modell): Modell aus dem VRAM nehmen bzw. vorladen — nichts wird heruntergeladen oder geloescht. ' +
    'status: Embedding-Queue, DB-Pools, offene Embeddings, Parser-Worker, Context7-Kontingent, Modell, Schalter in einem Aufruf; ' +
    'db_sitzungen: pg_stat_activity (lange Abfragen, idle in transaction mit Sperren, Blockaden — nur anzeigen); ' +
    'langsam: langsamste Tool-Aufrufe der letzten Minuten ohne bewusst wartende. ' +
    'nachzug_jetzt: offene Embeddings sofort im Hintergrund-Pool nachholen; ' +
    'embedding_messen (modell, anzahl, praefix): Testmessung direkt gegen Ollama ohne Schreiben (Ladezeit, Latenz, Passagen/s, Dimension, VRAM). ' +
    'neu_einbetten (ausfuehren, arten): baut den Qdrant-Index nach einem Modellwechsel aus PostgreSQL neu auf — ' +
    'veraltete Collections leeren und neu anlegen, embedded_at zuruecksetzen, der Nachzug bettet ein; ohne ausfuehren:true nur Vorschau, ' +
    'erst nach dem Umschalten der Modell-Env. ' +
    'Keine Aktion beendet Prozesse/Sitzungen oder loescht PG-Daten; nur neu_einbetten leert Qdrant-Collections (aus PG wiederherstellbar).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...INTERN_ACTIONS], description: 'Aktion' },
      project: { type: 'string', description: 'Optional; bei langsam und nachzug_jetzt Filter auf ein Projekt, sonst nur Attribution (Schalter gelten fuer den ganzen Prozess)' },
      agent_id: { type: 'string', description: 'Agent-ID (landet in gesetzt_von)' },
      name: { type: 'string', enum: Object.keys(INTERN_SCHALTER), description: 'schalter_setzen: Schalter' },
      aktiv: { type: 'boolean', description: 'schalter_setzen: true = anhalten, false = wieder freigeben' },
      modus: { type: 'string', description: 'schalter_setzen: embedding hintergrund (Standard) | alle; parser/context7 pause' },
      bis: { type: 'string', description: 'schalter_setzen: Ablauf als ISO-Zeitpunkt' },
      dauer_min: { type: 'number', description: 'schalter_setzen: Ablauf in Minuten ab jetzt' },
      dauerhaft: { type: 'boolean', description: 'schalter_setzen: ohne Ablauf (nur ausdruecklich)' },
      grund: { type: 'string', description: 'schalter_setzen: Grund (sichtbar in schalter_liste und im Log)' },
      modell: { type: 'string', description: 'ollama_entladen/ollama_laden: Modellname wie in ollama_status (ohne Tag = :latest)' },
      min_sekunden: { type: 'number', description: 'db_sitzungen: laufende Abfragen ab so vielen Sekunden auflisten (Standard 5)' },
      minuten: { type: 'number', description: 'langsam: Zeitfenster in Minuten (Standard 30)' },
      limit: { type: 'number', description: 'langsam: hoechstens so viele Aufrufe (Standard 20, max 200); nachzug_jetzt: so viele Eintraege (Standard 20, max 500)' },
      tabelle: { type: 'string', enum: [...BACKLOG_TABELLEN], description: 'nachzug_jetzt: nur diese Tabelle (sonst alle)' },
      ausfuehren: { type: 'boolean', description: 'neu_einbetten: true = wirklich ausfuehren (Standard: nur Vorschau)' },
      arten: { type: 'array', items: { type: 'string', enum: [...NEU_EINBETTEN_ARTEN] }, description: 'neu_einbetten: nur diese Arten (Standard alle)' },
      anzahl: { type: 'number', description: 'embedding_messen: Zahl der Passagen (Standard 20, 1..200)' },
      praefix: { type: 'string', description: 'embedding_messen: Praefix vor jeder Passage, z. B. "passage: " (Leerzeichen zaehlen mit)' },
      keep_alive: { type: ['string', 'number'], description: 'ollama_laden: wie lange geladen bleiben (Ollama-Format, z. B. "30m", "2h", -1 = bis Neustart; Standard 30m)' },
    },
    required: ['action'],
  },
};

function text(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function zahl(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return undefined;
}

function wahr(a: Record<string, unknown>, k: string): boolean | undefined {
  const v = a[k];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function fehler(action: string, code: string, message: string): Record<string, unknown> {
  return { success: false, action, error: code, message };
}

/** Dispatcher des Tools. Wirft nie. */
export async function fuehreInternAus(
  args: Record<string, unknown> | undefined | null,
  agentId?: string,
): Promise<Record<string, unknown>> {
  const a = args ?? {};
  const action = text(a, 'action') ?? '';
  if (!internToolAktiv()) return { ...INTERN_TOOL_AUS, action };
  try {
    switch (action) {
      case 'schalter_setzen': {
        const name = text(a, 'name');
        if (!name) return fehler(action, 'parameter_fehlt', `name fehlt (${Object.keys(INTERN_SCHALTER).join(' | ')}).`);
        const aktiv = wahr(a, 'aktiv');
        if (aktiv === undefined) return fehler(action, 'parameter_fehlt', 'aktiv fehlt (true = anhalten, false = wieder freigeben).');
        const stand = await setzeSchalter(name, {
          aktiv,
          modus: text(a, 'modus'),
          bis: text(a, 'bis'),
          dauer_min: zahl(a, 'dauer_min'),
          dauerhaft: wahr(a, 'dauerhaft') === true,
          grund: text(a, 'grund'),
          agent: text(a, 'agent_id') ?? agentId,
        });
        const message = !stand.aktiv
          ? `Schalter ${name} aus — der Ablauf laeuft wieder (Worker merken es spaetestens nach dem Cache-Intervall).`
          : `Schalter ${name} an (${stand.modus}) ${stand.dauerhaft ? 'dauerhaft' : `bis ${stand.bis}`}.`;
        return { success: true, action, schalter: stand, message };
      }
      case 'schalter_liste':
        return {
          success: true,
          action,
          hoechstdauer_stunden: hoechstdauerMs() / 3_600_000,
          moegliche: INTERN_SCHALTER,
          schalter: await alleSchalter(),
        };
      case 'ollama_status':
        return { success: true, action, ...(await ollamaStatus()) };
      case 'ollama_entladen': {
        const modell = text(a, 'modell');
        if (!modell) return fehler(action, 'parameter_fehlt', 'modell fehlt (Name wie in ollama_status).');
        return { success: true, action, ...(await ollamaEntladen(modell)) };
      }
      case 'ollama_laden': {
        const modell = text(a, 'modell');
        if (!modell) return fehler(action, 'parameter_fehlt', 'modell fehlt (Name wie in ollama_status).');
        const ka = a.keep_alive;
        const kaGueltig = ka === undefined || (typeof ka === 'number' && Number.isFinite(ka))
          || (typeof ka === 'string' && /^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(ka.trim()));
        if (!kaGueltig) return fehler(action, 'keep_alive_ungueltig', 'keep_alive: Zahl (Sekunden) oder z. B. "30m", "2h", "-1".');
        return { success: true, action, ...(await ollamaLaden(modell, typeof ka === 'string' ? ka.trim() : (ka as number | undefined))) };
      }
      case 'status':
        return { success: true, action, ...(await internStatus()) };
      case 'db_sitzungen': {
        const sek = zahl(a, 'min_sekunden');
        if (sek !== undefined && !(sek >= 0)) return fehler(action, 'parameter_ungueltig', 'min_sekunden muss eine Zahl >= 0 sein.');
        return { success: true, action, ...(await dbSitzungen(sek ?? 5)) };
      }
      case 'langsam': {
        const minuten = zahl(a, 'minuten');
        const limit = zahl(a, 'limit');
        if ((minuten !== undefined && !(minuten > 0)) || (limit !== undefined && !(limit > 0))) {
          return fehler(action, 'parameter_ungueltig', 'minuten und limit muessen Zahlen > 0 sein.');
        }
        return {
          success: true,
          action,
          ...(await langsameAufrufe({ minuten: Math.ceil(minuten ?? 30), limit: Math.min(Math.floor(limit ?? 20), 200), project: text(a, 'project') })),
        };
      }
      case 'nachzug_jetzt': {
        const limit = zahl(a, 'limit');
        if (limit !== undefined && !(limit > 0)) return fehler(action, 'parameter_ungueltig', 'limit muss eine Zahl > 0 sein.');
        const tabelle = text(a, 'tabelle');
        if (tabelle && !BACKLOG_TABELLEN.includes(tabelle)) {
          return fehler(action, 'parameter_ungueltig', `tabelle: ${BACKLOG_TABELLEN.join(' | ')}.`);
        }
        const project = text(a, 'project');
        const t0 = Date.now();
        // Hintergrund-Pool: der Nachzug darf die Verbindungen der Tool-Anfragen nicht belegen (P5-T15)
        const erg = await imHintergrund(() => embeddeOffeneEintraege(Math.min(Math.floor(limit ?? 20), 500), project, tabelle));
        return {
          success: true,
          action,
          tabelle: tabelle ?? 'alle',
          project: project ?? null,
          ...erg,
          dauer_ms: Date.now() - t0,
          offen_danach: await zaehleOffeneEmbeddings(project),
          ...(erg.angehalten ? { hinweis: 'Schalter embedding ist an — nichts nachgetragen. Erst schalter_setzen(name embedding, aktiv false).' } : {}),
        };
      }
      case 'neu_einbetten': {
        const roh = a.arten;
        const arten = Array.isArray(roh)
          ? roh.map(String)
          : typeof roh === 'string' && roh.trim() !== '' ? roh.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const falsch = (arten ?? []).filter((x) => !(NEU_EINBETTEN_ARTEN as readonly string[]).includes(x));
        if (falsch.length > 0) {
          return fehler(action, 'parameter_ungueltig', 'arten: ' + NEU_EINBETTEN_ARTEN.join(' | ') + ' (unbekannt: ' + falsch.join(', ') + ').');
        }
        // Hintergrund-Pool: die Zaehl- und UPDATE-Abfragen sollen die Tool-Verbindungen nicht belegen (P5-T15)
        const erg = await imHintergrund(() => neuEinbetten({ ausfuehren: wahr(a, 'ausfuehren') === true, arten }));
        return { success: true, action, ...erg };
      }
      case 'embedding_messen': {
        const modell = text(a, 'modell');
        if (!modell) return fehler(action, 'parameter_fehlt', 'modell fehlt (Name wie in ollama_status).');
        const anzahl = zahl(a, 'anzahl');
        if (anzahl !== undefined && !(anzahl >= 1 && anzahl <= 200)) return fehler(action, 'parameter_ungueltig', 'anzahl: 1 bis 200.');
        // praefix NICHT trimmen: "passage: " endet mit einem Leerzeichen, das zum Format gehoert
        const praefix = typeof a.praefix === 'string' ? a.praefix : undefined;
        return { success: true, action, ...(await embeddingMessen(modell, Math.floor(anzahl ?? 20), praefix)) };
      }
      default:
        return fehler(action, 'unbekannte_action', `Unbekannte action "${action}". Erlaubt: ${INTERN_ACTIONS.join(', ')}.`);
    }
  } catch (err) {
    if (err instanceof InternSchalterFehler) return fehler(action, err.code, err.message);
    if (err instanceof InternOllamaFehler) return fehler(action, err.code, err.message);
    return fehler(action, 'interner_fehler', err instanceof Error ? err.message : String(err));
  }
}
