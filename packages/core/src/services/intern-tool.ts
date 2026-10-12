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
import { nutzungsStatistik } from './intern-nutzung.js';
import { NEU_EINBETTEN_ARTEN, neuEinbetten } from './neu-einbetten.js';
import { listeEmbedPrioritaet, setzeEmbedPrioritaet } from './embed-prioritaet.js';
import {
  InternModellprofilFehler,
  modellprofilAnzeigen,
  modellprofilKalibrieren,
  modellprofilSetzen,
  type ProfilAenderung,
  type KalibrierAnfrage,
} from './intern-modellprofil.js';
import { ModellNichtKalibriertError } from '../embeddings/modell-profil.js';
import {
  WorkerSteuerungFehler,
  loeseWorkerDurchlaufAus,
  pausiereWorker,
  setzeWorkerFort,
  workerPauseMaxMin,
  workerStatus,
} from './worker-steuerung.js';
import { DaemonBrueckeFehler, daemonUebersicht, sendeAnDaemon } from './daemon-bruecke.js';
// P15-T15: Diagnose-Actions leben in eigener Datei, hier nur eingehaengt.
import { DIAGNOSE_ACTIONS, DIAGNOSE_BESCHREIBUNG, DIAGNOSE_PARAMETER, fuehreDiagnoseAus, istDiagnoseAction } from './intern-diagnose.js';
// P15-T12 E3/E4: Warteschlangen-Actions leben in eigener Datei, hier nur eingehaengt.
import {
  WARTESCHLANGEN_ACTIONS, WARTESCHLANGEN_BESCHREIBUNG, WARTESCHLANGEN_PARAMETER, fuehreWarteschlangeAus, istWarteschlangenAction,
} from './intern-warteschlangen.js';
// P15-T31: tote Co-Edit-Waits sichten, sichern, schliessen (intern-waits.ts).
import { WAITS_ACTIONS, WAITS_BESCHREIBUNG, WAITS_PARAMETER, fuehreWaitsAus, istWaitsAction } from './intern-waits.js';
// P10-T42: Shell-Altbestand mit der Live-Maske nachmaskieren (intern-shell-alt.ts).
import { SHELL_ALT_ACTIONS, SHELL_ALT_BESCHREIBUNG, SHELL_ALT_PARAMETER, fuehreShellAltAus, istShellAltAction } from './intern-shell-alt.js';

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
  'status', 'db_sitzungen', 'langsam', 'nutzung',
  'nachzug_jetzt', 'embedding_messen', 'neu_einbetten', 'embed_prioritaet',
  'modellprofil', 'modellprofil_setzen', 'modellprofil_kalibrieren',
  'worker_status', 'worker_pausieren', 'worker_fortsetzen', 'worker_durchlauf',
  'gpu_helfer_status', 'gpu_helfer_einstellen',
  ...DIAGNOSE_ACTIONS,
  ...WARTESCHLANGEN_ACTIONS,
  ...WAITS_ACTIONS,
  ...SHELL_ALT_ACTIONS,
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
    'nutzung: read-only Zaehlung nach Zeit, Agent, Tool und Action (seit, bis, bucket, agent_ids, tools, project); optional skills:true liest lokale JSONL-Sitzungen ueber den Daemon und liefert nur Zaehlungen/Skill-Namen. ' +
    'nachzug_jetzt: offene Embeddings sofort im Hintergrund-Pool nachholen; ' +
    'embedding_messen (modell, anzahl, praefix, num_ctx, num_batch): Testmessung direkt gegen Ollama ohne Schreiben (Ladezeit, Latenz, Passagen/s, Dimension, VRAM); ' +
    'num_ctx/num_batch ohne Angabe aus EMBEDDING_NUM_CTX/EMBEDDING_NUM_BATCH, sonst Ollama-Standard. ' +
    'neu_einbetten (ausfuehren, arten): baut den Qdrant-Index nach einem Modellwechsel aus PostgreSQL neu auf — ' +
    'veraltete Collections leeren und neu anlegen, embedded_at zuruecksetzen, der Nachzug bettet ein; ohne ausfuehren:true nur Vorschau, ' +
    'erst nach dem Umschalten der Modell-Env. ' +
    'embed_prioritaet (projekte, stufe): Reihenfolge des Code-Nachzugs je Projekt, Stufe 1 zuerst bis 4 zuletzt (ohne Eintrag 3), stufe 0 entfernt; ohne projekte Liste mit offenem Rueckstand. ' +
    'modellprofil (modell): Kalibrierung je Embedding-Modell aus PG (Praefixe, num_ctx, num_batch, max_stueck_zeichen, Score-Schwellen je Zweck), welches Profil gerade gilt, fehlende Zwecke, Pruefhinweise; ' +
    'modellprofil_setzen (modell, digest, query_praefix, dok_praefix, ziel_dimension, num_ctx, num_batch, max_stueck_zeichen, score_schwellen, notiz, messwerte): nur genannte Felder, null = nicht kalibriert, score_schwellen werden gemischt (null entfernt einen Zweck); ohne modell das aktive; ' +
    'modellprofil_kalibrieren (zweck, passend, rauschen, project, schreiben): misst mit dem aktiven Modell passende Anfragen gegen Rauschen und schlaegt die Mitte als Schwelle vor, schreibt nur mit schreiben:true und sauberer Trennung. ' +
    'worker_status: alle Hintergrund-Worker DIESES Prozesses (laeuft|pausiert, seit, bis, von, grund, zuletzt aktiv/Arbeit, Durchlaeufe) plus die PG-Schalter; ' +
    'worker_pausieren (worker: Name | Liste | "alle", dauer_min oder bis PFLICHT, grund PFLICHT): holt keine neue Arbeit mehr, laufender Stapel wird fertig, endet von selbst (Obergrenze SYNAPSE_WORKER_PAUSE_MAX_MIN), Neustart beendet jede Pause; ' +
    'worker_fortsetzen (worker | "alle"); worker_durchlauf (worker): genau ein Durchlauf jetzt, auch waehrend einer Pause. ' +
    'prozess "daemon" bzw. "daemon:<host>" steuert dieselben Actions im lokalen FileWatcher-Daemon (Long-Poll-Bruecke, Antwort <= 10 s). ' +
    'gpu_helfer_status / gpu_helfer_einstellen (lan_bevorzugen, embed_pause_ms; null entfernt) ueber den lokalen Daemon: ~/.synapse/file-watcher/gpu-helfer.json, der Tray startet den Helfer binnen ~5 s neu. ' +
    DIAGNOSE_BESCHREIBUNG +
    WARTESCHLANGEN_BESCHREIBUNG +
    WAITS_BESCHREIBUNG +
    SHELL_ALT_BESCHREIBUNG +
    'Keine Aktion beendet Prozesse/Sitzungen oder loescht PG-Daten; nur neu_einbetten leert Qdrant-Collections (aus PG wiederherstellbar).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...INTERN_ACTIONS], description: 'Aktion' },
      project: { type: 'string', description: 'nutzung: Filter auf ein Projekt; langsam/nachzug_jetzt: jeweiliger Projektfilter; sonst Attribution (Schalter gelten fuer den ganzen Prozess)' },
      agent_id: { type: 'string', description: 'Agent-ID (landet in gesetzt_von)' },
      name: { type: 'string', enum: Object.keys(INTERN_SCHALTER), description: 'schalter_setzen: Schalter' },
      aktiv: { type: 'boolean', description: 'schalter_setzen: true = anhalten, false = wieder freigeben' },
      modus: { type: 'string', description: 'schalter_setzen: embedding hintergrund (Standard) | alle; parser/context7 pause' },
      bis: { type: 'string', description: 'nutzung: Ende (ISO-Zeitpunkt; Standard jetzt); schalter_setzen / worker_pausieren: Ablauf als ISO-Zeitpunkt' },
      dauer_min: { type: 'number', description: 'schalter_setzen / worker_pausieren: Ablauf in Minuten ab jetzt' },
      dauerhaft: { type: 'boolean', description: 'schalter_setzen: ohne Ablauf (nur ausdruecklich)' },
      grund: { type: 'string', description: 'schalter_setzen / worker_pausieren: Grund (sichtbar in schalter_liste bzw. worker_status und im Log)' },
      worker: { type: ['string', 'array'], items: { type: 'string' }, description: 'worker_pausieren/worker_fortsetzen: Name, Liste oder "alle"; worker_durchlauf: ein Name. worker_status zeigt die Namen.' },
      prozess: { type: 'string', description: 'worker_*: "api" (Standard) | "daemon" (der einzige verbundene lokale Daemon) | "daemon:<host>"; gpu_helfer_*: "daemon" (Standard) | "daemon:<host>"' },
      lan_bevorzugen: { type: ['boolean', 'null'], description: 'gpu_helfer_einstellen: API im LAN zuerst (true) oder nur oeffentlich (false); null entfernt' },
      embed_pause_ms: { type: ['number', 'null'], description: 'gpu_helfer_einstellen: Pause zwischen Embedding-Aufrufen des Helfers in ms (EMBED_MIN_GAP_MS); null entfernt' },
      modell: { type: 'string', description: 'ollama_entladen/ollama_laden: Modellname wie in ollama_status (ohne Tag = :latest); modellprofil/modellprofil_setzen: Embedding-Modell (Standard: das aktive)' },
      digest: { type: 'string', description: 'modellprofil_setzen: leer = gilt fuer jeden Digest (Standard), sonst sha256-Anfang (12..64 Hex)' },
      query_praefix: { type: ['string', 'null'], description: 'modellprofil_setzen: Praefix fuer Suchanfragen ("" = bewusst keiner, null = nicht kalibriert). Leerzeichen zaehlen mit.' },
      dok_praefix: { type: ['string', 'null'], description: 'modellprofil_setzen: Praefix fuer gespeicherte Dokumente ("" = keiner, null = nicht kalibriert). Aendern heisst neu einbetten!' },
      ziel_dimension: { type: ['number', 'null'], description: 'modellprofil_setzen: Kontrollwert der Zieldimension (wirksam bleibt EMBEDDING_TARGET_DIM)' },
      max_stueck_zeichen: { type: ['number', 'null'], description: 'modellprofil_setzen: groesstes Textstueck in Zeichen je Embedding-Aufruf (unter dem physischen Batch des Modells)' },
      score_schwellen: { type: ['object', 'string'], description: 'modellprofil_setzen: {zweck: zahl|null} - gemischt in die vorhandenen, null entfernt. Zwecke: modellprofil zeigt sie' },
      notiz: { type: ['string', 'null'], description: 'modellprofil_setzen: Notiz (z. B. Verweis auf den Mess-Thought)' },
      messwerte: { type: ['object', 'string'], description: 'modellprofil_setzen: Objekt, wird in die vorhandenen Messwerte gemischt (wie: messwerte_modus)' },
      messwerte_modus: { type: 'string', enum: ['tief', 'oben', 'ersetzen'], description: 'modellprofil_setzen: tief (Standard, rekursiv, null entfernt einen Schluessel) | oben (nur oberste Ebene ersetzen) | ersetzen (ganzes Objekt neu)' },
      zweck: { type: 'string', description: 'modellprofil_kalibrieren: hook | channel_skill | global_search | graph_code | code_semantic_fallback | graph_wissen | error_patterns | tech_docs_gut' },
      passend: { type: 'array', items: { type: ['string', 'object'] }, description: 'modellprofil_kalibrieren: Anfragen mit erwartetem Treffer - Text oder {query, erwartet, framework} (erwartet = Teil des Namens/Pfads; error_patterns: ID-Anfang oder Teil der Beschreibung; framework nur tech_docs_gut)' },
      rauschen: { type: 'array', items: { type: ['string', 'object'] }, description: 'modellprofil_kalibrieren: Anfragen, zu denen nichts passen soll - Text oder {query, framework}' },
      schreiben: { type: 'boolean', description: 'modellprofil_kalibrieren: Vorschlag ins Profil des aktiven Modells schreiben (nur bei sauberer Trennung)' },
      min_sekunden: { type: 'number', description: 'db_sitzungen: laufende Abfragen ab so vielen Sekunden auflisten (Standard 5)' },
      seit: { type: 'string', description: 'nutzung: Beginn (ISO-Zeitpunkt; Standard letzte 24 h)' },
      bucket: { type: 'string', enum: ['stunde', 'tag'], description: 'nutzung: Zeitgruppierung (Standard tag)' },
      agent_ids: { type: 'array', items: { type: 'string' }, description: 'nutzung: auf diese Agenten begrenzen' },
      tools: { type: 'array', items: { type: 'string' }, description: 'nutzung: auf diese Synapse-Tools begrenzen' },
      skills: { type: 'boolean', description: 'nutzung: zusaetzlich lokale Codex-/Claude-Sitzungen nach wirklich gelesenen SKILL.md-Dateien scannen (Standard false)' },
      vergleich_seit: { type: 'string', description: 'nutzung: Beginn des optionalen Vergleichszeitraums (nur zusammen mit vergleich_bis)' },
      vergleich_bis: { type: 'string', description: 'nutzung: Ende des optionalen Vergleichszeitraums (nur zusammen mit vergleich_seit)' },
      minuten: { type: 'number', description: 'langsam: Zeitfenster in Minuten (Standard 30)' },
      limit: { type: 'number', description: 'langsam: hoechstens so viele Aufrufe (Standard 20, max 200); nachzug_jetzt: so viele Eintraege (Standard 20, max 500)' },
      tabelle: { type: 'string', enum: [...BACKLOG_TABELLEN], description: 'nachzug_jetzt: nur diese Tabelle (sonst alle)' },
      ausfuehren: { type: 'boolean', description: 'neu_einbetten / waits_tot: true = wirklich ausfuehren (Standard: nur Vorschau)' },
      arten: { type: 'array', items: { type: 'string', enum: [...NEU_EINBETTEN_ARTEN] }, description: 'neu_einbetten: nur diese Arten (Standard alle)' },
      projekte: { type: 'array', items: { type: 'string' }, description: 'embed_prioritaet: Projekte, deren Stufe gesetzt wird' },
      stufe: { type: 'number', description: 'embed_prioritaet: 1 (zuerst) bis 4 (zuletzt), 0 = Eintrag entfernen (zurueck auf 3)' },
      anzahl: { type: 'number', description: 'embedding_messen: Zahl der Passagen (Standard 20, 1..200)' },
      praefix: { type: 'string', description: 'embedding_messen: Praefix vor jeder Passage, z. B. "passage: " (Leerzeichen zaehlen mit)' },
      num_ctx: { type: ['number', 'null'], description: 'embedding_messen: num_ctx fuer Ollama (Standard: EMBEDDING_NUM_CTX der Server-Env, sonst Ollama-Standard des Modells); modellprofil_setzen: num_ctx des Modells (null = nicht kalibriert)' },
      num_batch: { type: ['number', 'null'], description: 'embedding_messen: num_batch (physischer Batch) fuer Ollama (Standard: EMBEDDING_NUM_BATCH, sonst Ollama-Standard); modellprofil_setzen: physischer Batch des Modells in Token' },
      keep_alive: { type: ['string', 'number'], description: 'ollama_laden: wie lange geladen bleiben (Ollama-Format, z. B. "30m", "2h", -1 = bis Neustart; Standard 30m)' },
      ...DIAGNOSE_PARAMETER,
      ...WARTESCHLANGEN_PARAMETER,
      ...WAITS_PARAMETER,
      ...SHELL_ALT_PARAMETER,
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

/**
 * Liste aus den Args: echtes Array, JSON-Text "[\"a\",\"b\"]" (Connector mit altem Schema schickt
 * unbekannte Felder als Text) oder Komma-Liste. Ohne JSON-Erkennung wurden aus ["a","b"] die
 * Namen ["a" und "b"] — so geschehen am 11.10.2026 bei embed_prioritaet.
 */
function textListe(a: Record<string, unknown>, k: string): string[] | undefined {
  const v = a[k];
  let roh: unknown[] | undefined;
  if (Array.isArray(v)) roh = v;
  else if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const p: unknown = JSON.parse(t);
        if (Array.isArray(p)) roh = p;
      } catch { /* kein JSON -> Komma-Liste */ }
    }
    roh ??= t.split(',');
  }
  if (!roh) return undefined;
  const liste = roh.map((x) => String(x).trim()).filter(Boolean);
  return liste.length > 0 ? liste : undefined;
}

/** Feld fuer modellprofil_setzen: fehlt -> undefined, null bzw. "null" -> null (= nicht kalibriert). */
function nullbar<T>(a: Record<string, unknown>, k: string, umwandeln: (v: unknown) => T): T | null | undefined {
  if (!(k in a) || a[k] === undefined) return undefined;
  if (a[k] === null || a[k] === 'null') return null;
  return umwandeln(a[k]);
}

/** Objekt aus den Args: echtes Objekt oder JSON-Text (Connector mit altem Schema). */
function objekt(a: Record<string, unknown>, k: string): Record<string, unknown> | undefined {
  let v = a[k];
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try { v = JSON.parse(v); } catch { /* unten als ungueltig */ }
  }
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InternModellprofilFehler('parameter_ungueltig', k + ': Objekt erwartet.');
  return v as Record<string, unknown>;
}

/** Liste aus den Args: echtes Array oder JSON-Text. */
function liste(a: Record<string, unknown>, k: string): unknown[] {
  let v = a[k];
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { v = JSON.parse(v); } catch { /* unten als leer */ }
  }
  return Array.isArray(v) ? v : [];
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
  // P15-T15: Diagnose-Actions (intern-diagnose.ts) - wirft nie
  if (istDiagnoseAction(action)) return await fuehreDiagnoseAus(action, a, agentId);
  // P15-T12 E3/E4: Warteschlangen (intern-warteschlangen.ts) - wirft nie
  if (istWarteschlangenAction(action)) return await fuehreWarteschlangeAus(action, a, agentId);
  // P15-T31: tote Co-Edit-Waits (intern-waits.ts) - wirft nie
  if (istWaitsAction(action)) return await fuehreWaitsAus(action, a, agentId);
  // P10-T42: Shell-Altbestand nachmaskieren (intern-shell-alt.ts) - wirft nie
  if (istShellAltAction(action)) return await fuehreShellAltAus(action, a, agentId);
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
      case 'nutzung': {
        const seit = text(a, 'seit');
        const bis = text(a, 'bis');
        const vergleichSeit = text(a, 'vergleich_seit');
        const vergleichBis = text(a, 'vergleich_bis');
        const bucket = text(a, 'bucket') ?? 'tag';
        if (bucket !== 'tag' && bucket !== 'stunde') return fehler(action, 'parameter_ungueltig', 'bucket: tag | stunde.');
        for (const [feld, wert] of [['seit', seit], ['bis', bis], ['vergleich_seit', vergleichSeit], ['vergleich_bis', vergleichBis]] as const) {
          if (wert !== undefined && !Number.isFinite(Date.parse(wert))) return fehler(action, 'parameter_ungueltig', feld + ': ISO-Zeitpunkt erwartet.');
        }
        if (seit !== undefined && bis !== undefined && Date.parse(seit) >= Date.parse(bis)) return fehler(action, 'parameter_ungueltig', 'seit muss vor bis liegen.');
        if ((vergleichSeit === undefined) !== (vergleichBis === undefined)) return fehler(action, 'parameter_ungueltig', 'vergleich_seit und vergleich_bis gemeinsam angeben.');
        if (vergleichSeit !== undefined && vergleichBis !== undefined && Date.parse(vergleichSeit) >= Date.parse(vergleichBis)) return fehler(action, 'parameter_ungueltig', 'vergleich_seit muss vor vergleich_bis liegen.');
        const limit = zahl(a, 'limit');
        if (limit !== undefined && !(limit > 0)) return fehler(action, 'parameter_ungueltig', 'limit muss eine Zahl > 0 sein.');
        const erg = await nutzungsStatistik({
          seit, bis, bucket, agent_ids: textListe(a, 'agent_ids'), tools: textListe(a, 'tools'),
          project: text(a, 'project'), limit: Math.min(Math.floor(limit ?? 200), 500),
          vergleich_seit: vergleichSeit, vergleich_bis: vergleichBis,
        });
        let skill_nutzung: unknown;
        if (wahr(a, 'skills') === true) {
          const prozess = text(a, 'prozess') ?? 'daemon';
          if (prozess !== 'daemon' && !prozess.startsWith('daemon:')) return fehler(action, 'parameter_ungueltig', 'skills:true nutzt prozess daemon | daemon:<host>.');
          const host = prozess.startsWith('daemon:') ? prozess.slice('daemon:'.length) : undefined;
          const ende = bis ?? new Date().toISOString();
          const start = seit ?? new Date(Date.parse(ende) - 24 * 60 * 60 * 1000).toISOString();
          try {
            const { host: ziel, ergebnis } = await sendeAnDaemon('skills_scan', {
              seit: start, bis: ende, bucket, agent_ids: textListe(a, 'agent_ids'), project: text(a, 'project'),
            }, host, 30_000);
            skill_nutzung = { prozess: 'daemon:' + ziel, ...ergebnis };
          } catch (err) {
            skill_nutzung = { verfuegbar: false, error: err instanceof DaemonBrueckeFehler ? err.code : 'daemon_fehler' };
          }
        }
        return { success: true, action, ...erg, ...(skill_nutzung === undefined ? {} : { skill_nutzung }) };
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
        const arten = textListe(a, 'arten');
        const falsch = (arten ?? []).filter((x) => !(NEU_EINBETTEN_ARTEN as readonly string[]).includes(x));
        if (falsch.length > 0) {
          return fehler(action, 'parameter_ungueltig', 'arten: ' + NEU_EINBETTEN_ARTEN.join(' | ') + ' (unbekannt: ' + falsch.join(', ') + ').');
        }
        // Hintergrund-Pool: die Zaehl- und UPDATE-Abfragen sollen die Tool-Verbindungen nicht belegen (P5-T15)
        const erg = await imHintergrund(() => neuEinbetten({ ausfuehren: wahr(a, 'ausfuehren') === true, arten }));
        return { success: true, action, ...erg };
      }
      case 'embed_prioritaet': {
        const projekte = textListe(a, 'projekte') ?? [];
        if (projekte.length > 0) {
          const stufe = zahl(a, 'stufe');
          if (stufe === undefined || !Number.isInteger(stufe) || stufe < 0 || stufe > 4) {
            return fehler(action, 'parameter_ungueltig', 'stufe: 1 (zuerst) bis 4 (zuletzt), 0 = Eintrag entfernen.');
          }
          const erg = await setzeEmbedPrioritaet(projekte, stufe, text(a, 'agent_id') ?? agentId);
          return { success: true, action, ...erg, stufe, projekte, liste: await listeEmbedPrioritaet() };
        }
        return {
          success: true,
          action,
          hinweis: 'Reihenfolge des Code-Nachzugs: Stufe 1 zuerst, ohne Eintrag 3; innerhalb einer Stufe der groesste Rueckstand zuerst.',
          liste: await listeEmbedPrioritaet(),
        };
      }
      case 'embedding_messen': {
        const modell = text(a, 'modell');
        if (!modell) return fehler(action, 'parameter_fehlt', 'modell fehlt (Name wie in ollama_status).');
        const anzahl = zahl(a, 'anzahl');
        if (anzahl !== undefined && !(anzahl >= 1 && anzahl <= 200)) return fehler(action, 'parameter_ungueltig', 'anzahl: 1 bis 200.');
        // praefix NICHT trimmen: "passage: " endet mit einem Leerzeichen, das zum Format gehoert
        const praefix = typeof a.praefix === 'string' ? a.praefix : undefined;
        // P15-T5: num_ctx/num_batch wie im Betrieb; ohne Angabe entscheidet embeddingMessen (Env bzw. weglassen)
        const numCtx = zahl(a, 'num_ctx');
        const numBatch = zahl(a, 'num_batch');
        for (const [feld, wert] of [['num_ctx', numCtx], ['num_batch', numBatch]] as const) {
          if (wert !== undefined && !(Number.isInteger(wert) && wert > 0)) {
            return fehler(action, 'parameter_ungueltig', feld + ': positive ganze Zahl (Token).');
          }
        }
        return {
          success: true,
          action,
          ...(await embeddingMessen(modell, Math.floor(anzahl ?? 20), praefix, { num_ctx: numCtx, num_batch: numBatch })),
        };
      }
      case 'modellprofil':
        return { success: true, action, ...(await modellprofilAnzeigen(text(a, 'modell'))) };
      case 'modellprofil_setzen': {
        const ganzzahl = (v: unknown): number => Number(v);
        const roh = (v: unknown): string => String(v);
        const schwellenRoh = objekt(a, 'score_schwellen');
        const aenderung: ProfilAenderung = {
          modell: text(a, 'modell'),
          digest: text(a, 'digest'),
          // Praefixe NICHT trimmen: "query: " endet mit einem Leerzeichen, das zum Format gehoert
          query_praefix: nullbar(a, 'query_praefix', roh),
          dok_praefix: nullbar(a, 'dok_praefix', roh),
          ziel_dimension: nullbar(a, 'ziel_dimension', ganzzahl),
          num_ctx: nullbar(a, 'num_ctx', ganzzahl),
          num_batch: nullbar(a, 'num_batch', ganzzahl),
          max_stueck_zeichen: nullbar(a, 'max_stueck_zeichen', ganzzahl),
          notiz: nullbar(a, 'notiz', roh),
          score_schwellen: schwellenRoh
            ? Object.fromEntries(Object.entries(schwellenRoh).map(([z, w]) => [z, w === null || w === 'null' ? null : Number(w)]))
            : undefined,
          messwerte: objekt(a, 'messwerte'),
          messwerte_modus: text(a, 'messwerte_modus'),
          agent: text(a, 'agent_id') ?? agentId,
        };
        return { success: true, action, ...(await modellprofilSetzen(aenderung)) };
      }
      case 'modellprofil_kalibrieren': {
        const zweck = text(a, 'zweck');
        if (!zweck) return fehler(action, 'parameter_fehlt', 'zweck fehlt (modellprofil zeigt die Zwecke).');
        // P15-T18: roh durchreichen - modellprofilKalibrieren normalisiert (Text oder {query, erwartet, framework})
        const passend = liste(a, 'passend') as Array<string | KalibrierAnfrage>;
        const rauschen = liste(a, 'rauschen') as Array<string | KalibrierAnfrage>;
        return {
          success: true,
          action,
          ...(await modellprofilKalibrieren({
            zweck, passend, rauschen, project: text(a, 'project'), schreiben: wahr(a, 'schreiben') === true, agent: text(a, 'agent_id') ?? agentId,
          })),
        };
      }
      case 'worker_status':
      case 'worker_pausieren':
      case 'worker_fortsetzen':
      case 'worker_durchlauf': {
        const prozess = text(a, 'prozess') ?? 'api';
        if (prozess === 'api') return await fuehreWorkerActionAus(action, a, agentId);
        if (prozess !== 'daemon' && !prozess.startsWith('daemon:')) {
          return fehler(action, 'parameter_ungueltig', 'prozess: api | daemon | daemon:<host>.');
        }
        const host = prozess.startsWith('daemon:') ? prozess.slice('daemon:'.length) : undefined;
        const { host: ziel, ergebnis } = await sendeAnDaemon(action, {
          worker: a.worker,
          dauer_min: zahl(a, 'dauer_min'),
          bis: text(a, 'bis'),
          grund: text(a, 'grund'),
          von: text(a, 'agent_id') ?? agentId,
        }, host);
        return { success: true, action, prozess: `daemon:${ziel}`, ...ergebnis, host: ziel };
      }
      case 'gpu_helfer_status':
      case 'gpu_helfer_einstellen': {
        const prozess = text(a, 'prozess') ?? 'daemon';
        if (prozess !== 'daemon' && !prozess.startsWith('daemon:')) {
          return fehler(action, 'parameter_ungueltig', 'prozess: daemon | daemon:<host> (der GPU-Helfer laeuft am lokalen PC).');
        }
        const host = prozess.startsWith('daemon:') ? prozess.slice('daemon:'.length) : undefined;
        const args: Record<string, unknown> = {};
        if (action === 'gpu_helfer_einstellen') {
          if ('lan_bevorzugen' in a) args.lan_bevorzugen = a.lan_bevorzugen === null || a.lan_bevorzugen === 'null' ? null : wahr(a, 'lan_bevorzugen');
          if ('embed_pause_ms' in a) args.embed_pause_ms = a.embed_pause_ms === null || a.embed_pause_ms === 'null' ? null : zahl(a, 'embed_pause_ms');
        }
        const { host: ziel, ergebnis } = await sendeAnDaemon(action, args, host);
        return { success: true, action, prozess: `daemon:${ziel}`, ...ergebnis, host: ziel };
      }
      default:
        return fehler(action, 'unbekannte_action', `Unbekannte action "${action}". Erlaubt: ${INTERN_ACTIONS.join(', ')}.`);
    }
  } catch (err) {
    if (err instanceof InternSchalterFehler) return fehler(action, err.code, err.message);
    if (err instanceof WorkerSteuerungFehler) return fehler(action, err.code, err.message);
    if (err instanceof DaemonBrueckeFehler) return fehler(action, err.code, err.message);
    if (err instanceof InternOllamaFehler) return fehler(action, err.code, err.message);
    if (err instanceof InternModellprofilFehler) return fehler(action, err.code, err.message);
    if (err instanceof ModellNichtKalibriertError) return fehler(action, err.code, err.message);
    return fehler(action, 'interner_fehler', err instanceof Error ? err.message : String(err));
  }
}

/**
 * P15-T12: worker_* im eigenen Prozess. Die API ruft das fuer prozess 'api', der lokale Daemon fuer
 * Befehle aus der Daemon-Bruecke (prozessName 'daemon:<host>'). Wirft WorkerSteuerungFehler.
 */
export async function fuehreWorkerActionAus(
  action: string,
  a: Record<string, unknown>,
  agentId?: string,
  prozessName = 'api',
): Promise<Record<string, unknown>> {
  switch (action) {
      case 'worker_status': {
        let schalter: unknown;
        try { schalter = await alleSchalter(); } catch (err) { schalter = { fehler: (err as Error).message }; }
        const worker = workerStatus();
        return {
          success: true,
          action,
          prozess: prozessName,
          pause_max_min: workerPauseMaxMin(),
          pausiert: worker.filter((w) => w.zustand === 'pausiert').map((w) => w.name),
          worker,
          pg_schalter: schalter,
          ...(prozessName === 'api' ? { daemons: daemonUebersicht() } : {}),
          hinweis: 'Pausen leben im Speicher dieses Prozesses (Neustart beendet sie). pg_schalter = P14-Schalter (schalter_setzen), wirken zusaetzlich. Lokale Daemons: prozess "daemon".',
        };
      }
      case 'worker_pausieren': {
        const erg = pausiereWorker(textListe(a, 'worker'), {
          dauer_min: zahl(a, 'dauer_min'),
          bis: text(a, 'bis'),
          grund: text(a, 'grund'),
          von: text(a, 'agent_id') ?? agentId,
        });
        return {
          success: true,
          action,
          ...erg,
          message: `${erg.pausiert.length} Worker pausiert bis ${erg.bis}; laufende Arbeit wird fertig, danach nichts Neues.`,
        };
      }
      case 'worker_fortsetzen': {
        const erg = setzeWorkerFort(textListe(a, 'worker'), text(a, 'agent_id') ?? agentId);
        return { success: true, action, ...erg };
      }
      case 'worker_durchlauf': {
        const namen = textListe(a, 'worker');
        if (namen && namen.length > 1) return fehler(action, 'parameter_ungueltig', 'worker_durchlauf: genau ein Worker.');
        return { success: true, action, ...(await loeseWorkerDurchlaufAus(namen?.[0])) };
      }
      default:
        return fehler(action, 'unbekannte_action', `Unbekannte action "${action}".`);
  }
}
