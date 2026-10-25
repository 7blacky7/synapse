/**
 * P22-T124: reine Logik des Agenten-Chats, gemeinsam fuer den Main-Chat (SynapseWorkspaceMock MainAgentView) und den
 * einheitlichen Chat der Plattform-Agenten (EinheitlicherAgentChat). Bis T124 lagen verlaufInfo/verlaufWerkzeuge/verlaufZugInfo
 * nur im Main-Chat (dort 'Hauptagent' fest); jetzt mit Agentenname als Parameter. Testbar ohne DOM.
 */
import type { MainAgentVerlaufEintrag } from '../api/agent-runtime';
import type { ToolCallViewModel } from '../control-plane/view-model';

export type ToolLauf = { calls: ToolCallViewModel[]; phases: string[] };

export function verlaufInfo(eintrag: MainAgentVerlaufEintrag): string {
  const zeit = new Date(eintrag.erstellt_am);
  const wann = Number.isNaN(zeit.getTime()) ? '' : zeit.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return [eintrag.rolle === 'user' ? eintrag.geraet : null, wann].filter(Boolean).join(' · ');
}

export function verlaufWerkzeuge(eintrag: MainAgentVerlaufEintrag, agentName = 'Hauptagent'): ToolLauf | undefined {
  const calls = (eintrag.werkzeuge?.calls ?? []).map((call): ToolCallViewModel => {
    const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : null;
    const start = Date.parse(call.start);
    const ende = call.ende ? Date.parse(call.ende) : Number.NaN;
    const offen = !call.ende;
    const ausgabe = call.output === undefined || call.output === null ? '' : typeof call.output === 'string' ? call.output : JSON.stringify(call.output);
    return {
      id: 'stream:' + call.id,
      tool: call.name || 'tool',
      action: typeof input?.action === 'string' ? input.action : '',
      agent: agentName,
      status: offen ? (eintrag.status === 'laeuft' ? 'running' : 'failed') : call.isError ? 'failed' : 'done',
      argsPreview: call.input === undefined ? '' : typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
      resultPreview: !offen && !call.isError ? ausgabe : '',
      error: call.isError ? ausgabe || 'Fehler' : offen && eintrag.status !== 'laeuft' ? 'ohne Ergebnis beendet' : '',
      durationMs: Number.isFinite(start) && Number.isFinite(ende) ? Math.max(0, ende - start) : 0,
      ...(call.bilder?.length ? { bilder: call.bilder } : {}),
      createdAt: call.start,
      source: 'stream',
    };
  });
  const phases = eintrag.werkzeuge?.phasen ?? [];
  return calls.length || phases.length ? { calls, phases } : undefined;
}

export const tausender = (n: number): string => n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + 'k' : String(n);

const fensterQuelleText = (q: 'registry' | 'cli' | 'fallback' | undefined): string => q === 'cli' ? 'CLI' : q === 'fallback' ? 'Rückfall' : q === 'registry' ? 'Registry' : 'Quelle unbekannt';

// P22-T63: Token-Zeile je Antwort: Modell · Zuege · Dauer · in/out · Kontext (gemessen = CLI usage).
export function verlaufZugInfo(eintrag: MainAgentVerlaufEintrag): string | undefined {
  const g = eintrag.tokens?.gemessen;
  const teile = [
    eintrag.modell,
    eintrag.zug?.zuege ? eintrag.zug.zuege + (eintrag.zug.zuege === 1 ? ' Zug' : ' Züge') : null,
    eintrag.zug ? (eintrag.zug.dauer_ms / 1000).toFixed(1) + ' s' : null,
    g ? 'in ' + tausender(g.input + g.cache_read + g.cache_creation) + ' / out ' + tausender(g.output) : null,
    // P22-T70: ohne Kontextstand (dauerhafter Weg ohne Wrapper-Messung) ehrlich 'nicht gemessen' statt 0 %.
    // P22-T75: Obergrenze und ihre Quelle sichtbar (Registry | CLI | Rückfall), damit eine falsche Annahme auffaellt.
    eintrag.kontext ? 'Kontext ' + eintrag.kontext.prozent + ' % von ' + tausender(eintrag.kontext.fenster) + ' (' + fensterQuelleText(eintrag.kontext.schwellen_quelle) + ')' : g ? 'Kontext nicht gemessen' : null,
    eintrag.zug?.kosten ? '$' + eintrag.zug.kosten.usd.toFixed(4) : null,
    g ? 'gemessen' : null,
  ].filter(Boolean);
  return teile.length ? teile.join(' · ') : undefined;
}

/** Nachricht des einheitlichen Chats (Teilmenge der Main-Chat-Nachricht ohne Artefakte/Anhaenge). */
export interface AgentChatNachricht {
  id: string; role: 'user' | 'agent'; text: string; kopf: string; info: string; toolRun?: ToolLauf; laeuft: boolean; hinweise: string[]; zugInfo?: string;
}

const SICHTBAR = new Set(['user', 'agent', 'nachricht', 'ausgabe', 'system']);

/** P22-T137: Antwort ist reines HTML (beginnt mit einem Tag, endet mit '>' und enthaelt ein schliessendes Tag). Rein. */
export function istHtmlAntwort(text: string): boolean {
  const t = text.trim();
  return t.length > 6 && t.startsWith('<') && t.endsWith('>') && /<\/[a-z][a-z0-9-]*\s*>/i.test(t);
}

/** P22-T135: Kopf einer Eingabe mit bekannter Herkunft (CLI-Verlauf setzt absender.herkunft). null = unbekannt. Rein. */
export function herkunftKopf(a: MainAgentVerlaufEintrag['absender']): string | null {
  if (!a?.herkunft) return null;
  if (a.herkunft === 'cli') return 'Du · Eingabe über CLI';
  const wer = !a.agent_id || a.agent_id === 'user' ? 'Du' : a.agent_id;
  if (a.herkunft === 'mod_inbox') return wer + ' · ' + (wer === 'Du' ? 'Web-UI' : 'Nachricht');
  if (a.herkunft === 'cc_send') return wer + ' · cc-send';
  return null;
}

/**
 * Verlaufseintraege einer Identitaet -> Chat-Nachrichten in der Form des Main-Chats. karten = Schalter verlauf_tool_karten:
 * Werkzeug-Rohzeilen (weg 'werkzeug') entfallen dann, die Karten haengen an der Antwort. Rein.
 */
export function baueAgentChatNachrichten(eintraege: MainAgentVerlaufEintrag[], name: string, karten: boolean): AgentChatNachricht[] {
  const aus: AgentChatNachricht[] = [];
  for (const e of eintraege) {
    if (!SICHTBAR.has(e.rolle) || e.gehoert_zu || (karten && e.weg === 'werkzeug')) continue;
    const toolRun = karten ? verlaufWerkzeuge(e, name) : undefined;
    if (!e.text.trim() && !toolRun && e.status !== 'laeuft') continue;
    const vomAgent = e.rolle === 'agent' || e.rolle === 'ausgabe' || e.rolle === 'system' || e.richtung === 'aus';
    const kopf = e.rolle === 'system' ? 'System · ' + e.weg
      : vomAgent ? name + (e.rolle === 'ausgabe' ? ' · ' + e.weg : '')
        : e.rolle === 'nachricht' ? herkunftKopf(e.absender) ?? (e.absender?.agent_id || 'unbekannt') + ' · ' + e.weg + (e.absender?.channel ? ' #' + e.absender.channel : '') : 'Du';
    aus.push({ id: e.id, role: vomAgent ? 'agent' : 'user', text: e.text, kopf, info: verlaufInfo(e), toolRun, laeuft: e.status === 'laeuft',
      hinweise: e.hinweise?.length ? e.hinweise : [], zugInfo: vomAgent ? verlaufZugInfo(e) : undefined });
  }
  return aus;
}

/** Modellanzeige wie im Kopf des Main-Chats: Modell der juengsten Agent-Antwort. */
export function aktuellesModell(eintraege: MainAgentVerlaufEintrag[]): string | null {
  for (let i = eintraege.length - 1; i >= 0; i--) if (eintraege[i].rolle === 'agent' && eintraege[i].modell) return eintraege[i].modell;
  return null;
}
