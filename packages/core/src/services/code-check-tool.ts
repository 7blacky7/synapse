/**
 * MODUL: code_check Tool (P15-T37) - Definition + Dispatcher
 * ZWECK: EINE Schema-Definition und EIN Dispatcher fuer das MCP-Tool code_check. Der lokale
 *        MCP-Server (stdio) und die REST-API haengen beides nur ein (Muster: asset-intel-tool.ts):
 *          stdio: { definition: CODE_CHECK_DEFINITION, handler: (args) => fuehreCodeCheckAus(args) }
 *          REST:  { ...CODE_CHECK_DEFINITION } in MCP_TOOLS; case 'code_check': fuehreCodeCheckAus(args, agentId)
 *        Vorher hatten beide Strecken eigene Kopien, die nur description/fix/severity kannten - die
 *        E1-Felder (P15-T17) liessen sich nur per SQL setzen (Befund thought 98b79b71).
 * ACTIONS: add_pattern, update_pattern, list_patterns, delete_pattern. Logik: fehlermuster-pflege.ts.
 * ANTWORT: wirft nie; Fehler als { success:false, action, error:<code>, message }.
 */

import { resolveAgentId } from './agent-id-resolver.js';
import { deleteErrorPattern, listErrorPatterns, type ErrorPattern } from './error-patterns.js';
import { _signaturMusterCacheLeeren } from './fehlermuster-pruefung.js';
import {
  PFLEGE_SEVERITY,
  PFLEGE_STATUS,
  aendereMuster,
  legeMusterAn,
  normalisiereErkennung,
  normalisiereGeltung,
  normalisiereVerweise,
  type MusterFelder,
  type PflegeSeverity,
  type PflegeStatus,
} from './fehlermuster-pflege.js';

export const CODE_CHECK_ACTIONS = ['add_pattern', 'update_pattern', 'list_patterns', 'delete_pattern'] as const;

export const CODE_CHECK_DEFINITION = {
  name: 'code_check',
  description:
    'Eigene Fehler-Pattern-Bibliothek im Projekt-Workspace: bekannte Fehler + Loesungen registrieren, aendern, listen, entfernen. ' +
    'Patterns werden bei lokalen Code-Schreib-Operationen automatisch herangezogen: mit Signatur (erkennung) als Fehlerbefund an der Op, ohne als Themenhinweis. ' +
    'add_pattern prueft vor dem Speichern: Selbsttest (Signatur trifft beispiel_falsch, nicht beispiel_richtig) und Dubletten (Ablehnung mit ID). ' +
    'Neue Muster starten als warning; error nur per update_pattern mit grund. Eigene lokale Datenbank, keine externen Systeme.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...CODE_CHECK_ACTIONS], description: 'add_pattern | update_pattern | list_patterns | delete_pattern' },
      id: { type: 'string', description: 'Pflicht fuer update_pattern und delete_pattern: Pattern-ID. update_pattern: volle UUID oder eindeutiger Praefix (mind. 8 Zeichen, wie thought get; mehrdeutig -> Fehler mit Kandidaten, nichts geaendert). delete_pattern: volle UUID' },
      description: { type: 'string', description: 'add_pattern Pflicht: was ist der Fehler (Langtext). update_pattern: neuer Text' },
      fix: { type: 'string', description: 'add_pattern Pflicht: wie wird es richtig ("wie")' },
      found_in_model: { type: 'string', description: 'add_pattern Pflicht: Modell, das den Fehler machte (haiku/sonnet/opus/fable) - leitet model_scope ab, der danach unveraendert bleibt' },
      found_by: { type: 'string', description: 'add_pattern: Agent-ID, die den Fehler fand (Standard: agent_id)' },
      titel: { type: 'string', description: 'Kurztitel ("was", hoechstens 80 Zeichen)' },
      warum: { type: 'string', description: 'Warum ist es ein Fehler (Ursache/Folge)' },
      erkennung: {
        type: 'object',
        description: 'Signatur: {art:"regex" (Standard), signatur:[Regex,...] (Liste = UND: ALLE muessen treffen; ODER als "A|B" in EINEM String), gegen_signatur:[Regex,...] (EINE hebt auf), flags:"imsu", fenster:"zeile"|"block"|"datei"}. signatur/gegen_signatur/flags/fenster gehoeren IN erkennung, nicht auf die oberste Ebene. Tab in der Regex als \\t (JSON "\\\\t"); Steuerzeichen aus JSON-Escapes (Tab, Backspace statt \\b) werden zurueck in Regex-Escapes gewandelt. Braucht beispiel_falsch + beispiel_richtig (Selbsttest). null entfernt (update_pattern).',
      },
      geltung: { type: 'object', description: 'Wo gilt das Muster: {sprachen:["ts","tsx"], dateimuster:["**/app/**"], projekte:["x"], frameworks:["next>=15"]}. Fehlt = ueberall' },
      verweise: {
        type: 'array',
        items: { type: 'object' },
        description: 'Wo nachlesen: [{art:"memory"|"thought"|"doku"|"datei"|"skill", name|id|url|file_path, zeile}] oder Kurzform "memory:<name>", "thought:<id>", "skill:<name>", "datei:<pfad>:<zeile>", URL',
      },
      beispiel_falsch: { type: 'string', description: 'Code, den die Signatur treffen MUSS (Selbsttest)' },
      beispiel_richtig: { type: 'string', description: 'Korrigierter Code, den die Signatur NICHT treffen darf (Selbsttest)' },
      status: { type: 'string', enum: [...PFLEGE_STATUS], description: 'aktiv (Signatur mit Selbsttest, Standard mit erkennung) | themenhinweis (Standard ohne) | stillgelegt (braucht grund). list_patterns: Filter' },
      severity: { type: 'string', enum: [...PFLEGE_SEVERITY], description: 'add_pattern: warning (Standard) oder info - error wird beim Anlegen auf warning gesetzt. update_pattern: error nur fuer aktive Signatur-Muster mit grund' },
      grund: { type: 'string', description: 'update_pattern: Pflicht fuer severity error und status stillgelegt (mind. 10 Zeichen), wird protokolliert' },
      dublette_ok: { type: 'boolean', description: 'Trotz aehnlichem Muster (gleicher Titel / beispiel_falsch schon erkannt) speichern. Gleiche Signatur oder description bleibt abgelehnt' },
      model_scope: { type: 'string', description: 'list_patterns: Filter nach model_scope. Wird bei add/update NICHT gesetzt (abgeleitet aus found_in_model)' },
      limit: { type: 'number', description: 'list_patterns: max. Ergebnisse (Standard 20)' },
      detail: { type: 'boolean', description: 'list_patterns: alle Felder (Standard kompakt: id, titel, status, severity, scope, Signatur-Kurzform)' },
      agent_id: { type: 'string', description: 'Agent-ID' },
    },
    required: ['action'],
  },
} as const;

const str = (args: Record<string, unknown>, k: string): string | undefined =>
  typeof args[k] === 'string' && (args[k] as string).trim() !== '' ? (args[k] as string) : undefined;
/** Text-Felder: undefined = nicht angegeben, null bzw. '' = leeren. */
const textFeld = (args: Record<string, unknown>, k: string): string | null | undefined => {
  if (!(k in args) || args[k] === undefined) return undefined;
  if (args[k] === null || (typeof args[k] === 'string' && (args[k] as string).trim() === '')) return null;
  return String(args[k]);
};

function fehlerAntwort(action: string, error: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: false, action, error, message, ...extra };
}

/** Liest die Musterfelder aus den Tool-Argumenten. fehler = Eingabefehler (nichts gespeichert). */
function leseFelder(args: Record<string, unknown>): { felder: MusterFelder; fehler: string[] } {
  const fehler: string[] = [];
  const felder: MusterFelder = {};
  for (const k of ['titel', 'warum', 'beispiel_falsch', 'beispiel_richtig'] as const) {
    const v = textFeld(args, k);
    if (v !== undefined) felder[k] = v;
  }
  for (const k of ['description', 'fix'] as const) {
    const v = textFeld(args, k);
    if (v === null) fehler.push(`${k} darf nicht leer sein`);
    else if (v !== undefined) felder[k] = v;
  }
  const e = normalisiereErkennung(args.erkennung);
  fehler.push(...e.fehler);
  if (e.wert !== undefined) felder.erkennung = e.wert;
  const g = normalisiereGeltung(args.geltung);
  fehler.push(...g.fehler);
  if (g.wert !== undefined) felder.geltung = g.wert;
  const v = normalisiereVerweise(args.verweise);
  fehler.push(...v.fehler);
  if (v.wert !== undefined) felder.verweise = v.wert;
  const status = str(args, 'status');
  if (status !== undefined) {
    if ((PFLEGE_STATUS as readonly string[]).includes(status)) felder.status = status as PflegeStatus;
    else fehler.push(`status nur ${PFLEGE_STATUS.join(' | ')} (ist ${status})`);
  }
  const severity = str(args, 'severity');
  if (severity !== undefined) {
    if ((PFLEGE_SEVERITY as readonly string[]).includes(severity)) felder.severity = severity as PflegeSeverity;
    else fehler.push(`severity nur ${PFLEGE_SEVERITY.join(' | ')} (ist ${severity})`);
  }
  const grund = str(args, 'grund');
  if (grund !== undefined) felder.grund = grund;
  if (args.dublette_ok === true || args.dublette_ok === 'true') felder.dublette_ok = true;
  return { felder, fehler };
}

const kurz = (s: string | null | undefined, n: number): string | null =>
  s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null;

/** Kompakte Zeile je Muster fuer list_patterns (detail:false). */
export function kompaktesMuster(p: ErrorPattern): Record<string, unknown> {
  const e = p.erkennung;
  const sig = e && e.art === 'regex' && e.signatur?.length
    ? `regex ${e.signatur.length}${e.gegen_signatur?.length ? ` + gegen ${e.gegen_signatur.length}` : ''}${e.fenster ? `, fenster ${e.fenster}` : ''}`
    : null;
  const g = p.geltung;
  const geltung = g
    // Feste Reihenfolge (jsonb sortiert die Schluessel um).
    ? (['sprachen', 'dateimuster', 'projekte', 'frameworks'] as const)
      .filter((k) => Array.isArray(g[k]) && g[k]!.length).map((k) => `${k} ${g[k]!.join(',')}`).join('; ') || null
    : null;
  return {
    id: p.id,
    titel: p.titel ?? kurz(p.description, 100),
    status: p.status ?? 'themenhinweis',
    severity: p.severity,
    model_scope: p.modelScope,
    signatur: sig,
    ...(geltung ? { geltung } : {}),
    ...(p.verweise?.length ? { verweise: p.verweise.length } : {}),
    beispiele: !!(p.beispielFalsch && p.beispielRichtig),
    ...(p.stillgelegtGrund ? { stillgelegt_grund: kurz(p.stillgelegtGrund, 120) } : {}),
    ...(p.ersetztDurch ? { ersetzt_durch: p.ersetztDurch } : {}),
    created_at: p.createdAt,
  };
}

/**
 * Dispatcher fuer code_check (beide Strecken). agentId = effektive Agent-ID der Strecke
 * (REST: effectiveAgentId; stdio: args.agent_id bzw. SYNAPSE_AGENT_NAME ueber resolveAgentId).
 */
export async function fuehreCodeCheckAus(args: Record<string, unknown>, agentId?: string | null): Promise<Record<string, unknown>> {
  const action = typeof args.action === 'string' ? args.action : '';
  const aufrufer = resolveAgentId(agentId ?? str(args, 'agent_id') ?? null);
  try {
    switch (action) {
      case 'add_pattern': {
        const { felder, fehler } = leseFelder(args);
        const fehlt = (['description', 'fix'] as const).filter((k) => !felder[k]);
        const foundInModel = str(args, 'found_in_model');
        if (!foundInModel) fehler.push('found_in_model fehlt');
        if (fehlt.length) fehler.push(`${fehlt.join(', ')} fehlt`);
        const foundBy = resolveAgentId(str(args, 'found_by') ?? aufrufer);
        if (!foundBy) fehler.push('found_by erforderlich (oder agent_id / SYNAPSE_AGENT_NAME)');
        if (fehler.length) return fehlerAntwort(action, 'ungueltig', fehler.join('; '), { fehler });
        const r = await legeMusterAn({ ...felder, description: felder.description!, fix: felder.fix!, found_by: foundBy!, found_in_model: foundInModel! });
        // modelScope (camelCase) bleibt fuer bestehende Aufrufer erhalten.
        return { action, ...r, ...(r.success ? { modelScope: r.model_scope } : {}) };
      }
      case 'update_pattern': {
        const id = str(args, 'id');
        if (!id) return fehlerAntwort(action, 'ungueltig', 'id fehlt');
        const { felder, fehler } = leseFelder(args);
        if (fehler.length) return fehlerAntwort(action, 'ungueltig', fehler.join('; '), { fehler });
        const r = await aendereMuster(id, felder, aufrufer);
        const hinweis = str(args, 'model_scope') || str(args, 'found_in_model')
          ? ['model_scope/found_in_model werden bei update_pattern nicht geaendert (User-Entscheidung E-c).']
          : [];
        return { action, ...r, ...(hinweis.length ? { hinweise: [...(r.hinweise ?? []), ...hinweis] } : {}) };
      }
      case 'list_patterns': {
        const status = str(args, 'status');
        const lim = Number(args.limit);
        const limit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 500) : 20;
        const muster = await listErrorPatterns(str(args, 'model_scope'), limit, { status });
        const detail = args.detail === true || args.detail === 'true';
        return {
          success: true,
          action,
          count: muster.length,
          patterns: detail ? muster : muster.map(kompaktesMuster),
          ...(detail ? {} : { hinweis: 'Kompakt. Alle Felder (warum, fix, erkennung, beispiele, verweise, statistik): detail:true.' }),
        };
      }
      case 'delete_pattern': {
        const id = str(args, 'id');
        if (!id) return fehlerAntwort(action, 'ungueltig', 'id fehlt');
        const deleted = await deleteErrorPattern(id);
        _signaturMusterCacheLeeren();
        return {
          success: deleted,
          action,
          message: deleted
            ? 'Pattern geloescht. Lieber stilllegen (nachvollziehbar): update_pattern status:"stillgelegt", grund:"...".'
            : 'Pattern nicht gefunden',
        };
      }
      default:
        return fehlerAntwort(action, 'unbekannte_action', `Unbekannte code_check action: "${action}". Erlaubt: ${CODE_CHECK_ACTIONS.join(', ')}`);
    }
  } catch (err) {
    return fehlerAntwort(action, 'fehler', (err as Error).message);
  }
}
