/**
 * MODUL: Tool-Antwort-Huelle (P10-T51, 12.10.2026)
 * ZWECK: EIN Weg, auf dem REST (beide tools/call-Endpunkte) und stdio ihre Tool-Ergebnisse
 *        ausliefern. Vorher baute jede Strecke ihre Huelle selbst, mit eingeruecktem JSON
 *        (JSON.stringify(x, null, 2)) und allen Feldern, auch denen ohne Wert.
 *
 * REGELN (Freigabe Koordinator, thought c5e8c303):
 *   - Objekt-Schluessel mit null oder undefined entfallen. Ausnahmen, deren null eine
 *     Aussage traegt, stehen in TOOL_ANTWORT_NULL_BEHALTEN.
 *   - false, 0, '' und leere Arrays/Objekte BLEIBEN (success:false, exit_code:0, count:0,
 *     leerer Dateiinhalt, results:[] = nichts gefunden).
 *   - Array-Elemente werden nie entfernt (Positionen tragen Bedeutung).
 *   - Nur schlichte Objekte werden durchlaufen; Date & Co. serialisiert JSON.stringify wie bisher.
 *   - Text ohne Einrueckung. Text und structuredContent entstehen aus DEMSELBEN Objekt.
 *   - E1: Objekt ohne success (z. B. plan get) bekommt success:true, weil das REST-outputSchema
 *     success verlangt. Nicht bei isError.
 *   - Rueckweg: SYNAPSE_TOOL_ANTWORT_KOMPAKT=0 liefert das alte Format (eingerueckt, alle fachlichen Felder; Skill-Telemetrie bleibt intern).
 *
 * Fachliche Persistenz bleibt unberührt; P10-T62 ergänzt nur getrennte Hinweis-Zustellmarken.
 */


import { getPool } from '../db/client.js';
import { REVERSE_NULL_FELDER } from './reverse-tool.js';
import { getUnreadChatHint } from './chat-unread.js';
import { claimUnreadChannelHints } from './channel-unread.js';
import { claimShellJobHints, markShellJobSeenForToolCall } from './shell-hints.js';
import { hinweisAktiv } from './agent-zuschnitt-kontext.js';

const HINWEIS_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** P10-T62: REST und stdio beanspruchen dieselben dauerhaften Empfänger-Hinweise.
 * Ohne effektive Agent-ID bleibt die Antwort unverändert. Lesemarken bleiben getrennt.
 * Legacy-Shell-Hüllen werden nur für Seen/Projekt/IDs betrachtet, nicht umformatiert.
 */
export async function ergaenzeToolHinweise(
  result: unknown,
  toolName: string,
  args: Record<string, unknown>,
  agentId?: string | null,
): Promise<unknown> {
  if (!agentId || (!istSchlichtesObjekt(result) && !Array.isArray(result))) return result;
  const extras: Record<string, unknown> = {};
  let project = typeof args.project === 'string' ? args.project : '';
  const ausgeschlossen = new Set<string>();
  const addId = (id: unknown) => {
    if (typeof id === 'string' && HINWEIS_JOB_ID.test(id)) ausgeschlossen.add(id);
  };
  if (toolName === 'shell' && istSchlichtesObjekt(result)) {
    let kern = result;
    if (Array.isArray(result.content) && result.content.length === 1) {
      const block = result.content[0];
      if (istSchlichtesObjekt(block) && block.type === 'text' && typeof block.text === 'string') {
        try {
          const innen: unknown = JSON.parse(block.text);
          if (istSchlichtesObjekt(innen)) kern = innen;
        } catch { /* Nicht-JSON-Ausgabe ist keine Job-Metadatenquelle. */ }
      }
    }
    await markShellJobSeenForToolCall(args.action, args, kern, agentId);
    const action = typeof args.action === 'string' ? args.action : 'exec';
    if (kern.success !== false && !kern.error) {
      if (action === 'exec') addId(kern.id);
      if (action === 'get' && istSchlichtesObjekt(kern.job)) {
        addId(kern.job.id);
        if (!project && typeof kern.job.project === 'string') project = kern.job.project;
      }
      if ((action === 'get' || action === 'log') && kern.success === true) addId(args.id);
      if (action === 'history' && Array.isArray(kern.jobs)) {
        for (const job of kern.jobs) if (istSchlichtesObjekt(job)) addId(job.id);
      }
      if (!project && typeof kern.project === 'string') project = kern.project;
      // get/log dürfen ohne project aufgerufen werden; nur die exakte Job-ID auflösen.
      try {
        if (action === 'get_stream' && typeof args.stream_id === 'string' && args.stream_id) {
          const { rows } = await getPool().query<{ id: string; project: string }>(
            'SELECT id, project FROM shell_jobs WHERE stream_id = $1 ORDER BY created_at DESC LIMIT 1',
            [args.stream_id],
          );
          if (rows[0]) { addId(rows[0].id); project ||= rows[0].project; }
        } else if (!project && ausgeschlossen.size > 0 && action !== 'history') {
          const { rows } = await getPool().query<{ project: string }>(
            'SELECT project FROM shell_jobs WHERE id = $1::uuid', [[...ausgeschlossen][0]],
          );
          if (rows[0]) project = rows[0].project;
        }
      } catch (error) {
        console.error('[ToolHinweise] Job-Projekt konnte nicht aufgelöst werden:', error);
      }
    }
  }
  // Ausschluss VOR dem Claim: insbesondere history darf andere Hinweise nicht verbrauchen.
  // P22-T13 Paket C: Profilentscheidung VOR Lesen/Claim (ohne Snapshot immer an = t109).
  if (project) {
    const unreadChat = hinweisAktiv('unread_chat', agentId) ? await getUnreadChatHint(project, agentId) : null;
    if (unreadChat) extras.unreadChat = unreadChat;
    const shellHints = hinweisAktiv('shell_activity', agentId) ? await claimShellJobHints(project, agentId, 3, [...ausgeschlossen]) : [];
    if (shellHints.length > 0) extras.shell_activity = shellHints;
  }
  const channels = hinweisAktiv('unread_channels', agentId) ? await claimUnreadChannelHints(agentId) : [];
  if (channels.length > 0) extras.unread_channels = channels.map(hint => ({
    project: hint.project, channel: hint.channel, count: hint.count, newest_id: hint.newestId,
  }));
  if (Object.keys(extras).length === 0) return result;
  // Eine fachliche Liste bleibt vollständig; nur bei echten Hinweisen braucht sie eine Hülle.
  return Array.isArray(result) ? { result, ...extras } : { ...result, ...extras };
}

/** null-Felder, die eine Aussage tragen. '*' gilt fuer alle Tools; Schluessel = Feldname auf jeder Ebene. */
export const TOOL_ANTWORT_NULL_BEHALTEN: Readonly<Record<string, readonly string[]>> = {
  // Laufender oder nie ausgefuehrter Job: null = noch kein Exit-Code (Vertrag in shell-Antworten).
  '*': ['exit_code'],
  // P10-T18: total null = nicht bestimmbar, nicht 0.
  asset_intel: ['total'],
  reverse: REVERSE_NULL_FELDER,
};

/** Schalter: Standard an. 0/false/aus/off/nein = altes Format. */
export function toolAntwortKompaktAktiv(env: NodeJS.ProcessEnv = process.env): boolean {
  const wert = (env.SYNAPSE_TOOL_ANTWORT_KOMPAKT ?? '').trim().toLowerCase();
  return !['0', 'false', 'aus', 'off', 'nein'].includes(wert);
}

function istSchlichtesObjekt(wert: unknown): wert is Record<string, unknown> {
  if (wert === null || typeof wert !== 'object' || Array.isArray(wert)) return false;
  const proto = Object.getPrototypeOf(wert);
  return proto === Object.prototype || proto === null;
}

/** Entfernt null/undefined-Felder rekursiv (ausser den Ausnahmen). Aendert das Eingabeobjekt nicht. */
export function kompaktiereToolAntwort(wert: unknown, tool?: string): unknown {
  const behalten = new Set<string>([
    ...(TOOL_ANTWORT_NULL_BEHALTEN['*'] ?? []),
    ...((tool ? TOOL_ANTWORT_NULL_BEHALTEN[tool] : undefined) ?? []),
  ]);
  const lauf = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(lauf);
    if (!istSchlichtesObjekt(v)) return v;
    const aus: Record<string, unknown> = {};
    for (const [schluessel, feld] of Object.entries(v)) {
      if (feld === undefined) continue;
      if (feld === null && !behalten.has(schluessel)) continue;
      aus[schluessel] = lauf(feld);
    }
    return aus;
  };
  return lauf(wert);
}

export interface ToolErgebnisHuelle {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolErgebnisOptionen {
  /** Tool-Name fuer die Ausnahmen-Liste. */
  tool?: string;
  /** Aktion begrenzt die freigegebene Legacy-Hüllenvereinheitlichung. */
  action?: string;
  isError?: boolean;
  /** REST: structuredContent mitliefern (Arrays als { result }). */
  strukturiert?: boolean;
}

/** Nur die zwei freigegebenen Legacy-Antworten entpacken; Daten/Textblöcke bleiben Daten. */
function entpackeInnereHuelle(payload: unknown, optionen: ToolErgebnisOptionen): unknown {
  if (!((optionen.tool === 'shell' && optionen.action === 'get') ||
        (optionen.tool === 'channel' && optionen.action === 'feed'))) return payload;
  if (!istSchlichtesObjekt(payload) || !Array.isArray(payload.content) || payload.content.length !== 1) return payload;
  const block = payload.content[0];
  if (!istSchlichtesObjekt(block) || block.type !== 'text' || typeof block.text !== 'string') return payload;
  let innen: unknown;
  try { innen = JSON.parse(block.text); } catch { return payload; }
  if (!istSchlichtesObjekt(innen)) return payload;
  const { content: _content, ...anhaenge } = payload;
  // Äußere Hooks sind der jüngste Stand; ein fachliches success:false bleibt sichtbar.
  return { ...innen, ...anhaenge, ...('success' in innen ? { success: innen.success } : {}) };
}

/** P10-T53: nur bekannte Anzeige-Anhänge kürzen, Zustellung und fachliche Werte nicht ändern. */
function kuerzeAntwortAnhaenge(payload: unknown, kompakt: boolean): unknown {
  if (!istSchlichtesObjekt(payload)) return payload;
  const aus = { ...payload };
  // Produzenten zählen weiterhin intern in PG; Telemetrie gehört nicht in Tool-Antworten.
  delete aus.skill_hook_metrics;
  if (!kompakt) return aus;
  const kurz: Record<string, string> = {
    'Erfolgreich. Ergebnis: shell(get, id).': 'Details: shell(get, id).',
    'Gueltig — nichts geaendert. Ergebnis: shell(get, id).': 'Gültig; unverändert. Details: shell(get, id).',
    'Fehlgeschlagen. Details: shell(log, id).': 'Details: shell(log, id).',
  };
  if (Array.isArray(payload.shell_activity)) {
    aus.shell_activity = payload.shell_activity.map(hinweis =>
      istSchlichtesObjekt(hinweis) && typeof hinweis.hinweis === 'string' && kurz[hinweis.hinweis]
        ? { ...hinweis, hinweis: kurz[hinweis.hinweis] } : hinweis);
  }
  if (istSchlichtesObjekt(payload.open_plans)) {
    const plaene = { ...payload.open_plans };
    // P6-T49: der erste Satz nennt die Ablauffrist (Wert + Quelle) und bleibt; der Rest wird kompakt.
    if (typeof plaene.hinweis === 'string' && plaene.hinweis.startsWith('Offene Plaene laufen ')) {
      const satzEnde = plaene.hinweis.indexOf('. ');
      const satz = (satzEnde >= 0 ? plaene.hinweis.slice(0, satzEnde + 1) : plaene.hinweis).replace('Offene Plaene', 'Offene Pläne');
      plaene.hinweis = satz + ' Prüfen: files(plan_status, plan_id); ändern: commit/cancel/plan_update.';
    }
    if (istSchlichtesObjekt(plaene.aeltere)) {
      const alt = plaene.aeltere;
      if (typeof alt.hinweis === 'string' && alt.hinweis.startsWith('dazu ') &&
          alt.hinweis.includes('aeltere offene Plaene ohne Aktivitaet seit >7 Tagen') && alt.hinweis.endsWith('zum Ansehen.')) {
        plaene.aeltere = { ...alt, hinweis: 'Ältere Pläne: files(plan_status, plan_id).' };
      }
    }
    aus.open_plans = plaene;
  }
  return aus;
}

/** Im Format-Rückweg bleibt die innere Hülle, bekannte interne Telemetrie bleibt trotzdem intern. */
function ohneInnereMetriken(payload: unknown, optionen: ToolErgebnisOptionen): unknown {
  if (!((optionen.tool === 'shell' && optionen.action === 'get') ||
        (optionen.tool === 'channel' && optionen.action === 'feed'))) return payload;
  if (!istSchlichtesObjekt(payload) || !Array.isArray(payload.content) || payload.content.length !== 1) return payload;
  const block = payload.content[0];
  if (!istSchlichtesObjekt(block) || block.type !== 'text' || typeof block.text !== 'string') return payload;
  let innen: unknown;
  try { innen = JSON.parse(block.text); } catch { return payload; }
  if (!istSchlichtesObjekt(innen) || !('skill_hook_metrics' in innen)) return payload;
  return { ...payload, content: [{ ...block,
    text: JSON.stringify(kuerzeAntwortAnhaenge(innen, false), null, block.text.includes('\n') ? 2 : undefined) }] };
}

/** Baut die MCP-Huelle aus einem Tool-Ergebnis. */
export function baueToolErgebnis(payload: unknown, optionen: ToolErgebnisOptionen = {}): ToolErgebnisHuelle {
  const kompakt = toolAntwortKompaktAktiv();
  const normal = kompakt ? entpackeInnereHuelle(payload, optionen) : ohneInnereMetriken(payload, optionen);
  const anzeige = kuerzeAntwortAnhaenge(normal, kompakt);
  let objekt: unknown = kompakt ? kompaktiereToolAntwort(anzeige, optionen.tool) : anzeige;
  if (kompakt && !optionen.isError && istSchlichtesObjekt(objekt) && !('success' in objekt)) {
    objekt = { success: true, ...objekt };
  }
  const text = kompakt ? JSON.stringify(objekt) : JSON.stringify(objekt, null, 2);
  const huelle: ToolErgebnisHuelle = { content: [{ type: 'text', text }] };
  if (optionen.strukturiert) {
    huelle.structuredContent = objekt && typeof objekt === 'object' && !Array.isArray(objekt)
      ? (objekt as Record<string, unknown>)
      : { result: objekt };
  }
  if (optionen.isError) huelle.isError = true;
  return huelle;
}

/**
 * stdio: die fertige Antwort (Text-JSON in content[0]) am Ende EINMAL kompaktieren.
 * Nicht-JSON-Text bleibt unveraendert. Mutiert content[0].text und gibt resp zurueck.
 */
export function kompaktiereTextErgebnis<T extends { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }>(
  resp: T,
  tool?: string,
  action?: string,
): T {
  const erstes = resp?.content?.[0];
  if (!erstes || erstes.type !== 'text' || typeof erstes.text !== 'string') return resp;
  let geparst: unknown;
  try {
    geparst = JSON.parse(erstes.text);
  } catch {
    return resp;
  }
  if (!toolAntwortKompaktAktiv() && (!istSchlichtesObjekt(geparst) ||
      (!('skill_hook_metrics' in geparst) && ohneInnereMetriken(geparst, { tool, action }) === geparst))) return resp;
  const strukturiert = toolAntwortKompaktAktiv() && ((tool === 'shell' && action === 'get') || (tool === 'channel' && action === 'feed'));
  const huelle = baueToolErgebnis(geparst, { tool, action, isError: resp.isError === true, strukturiert });
  erstes.text = huelle.content[0].text;
  if (strukturiert) resp.structuredContent = huelle.structuredContent;
  return resp;
}
