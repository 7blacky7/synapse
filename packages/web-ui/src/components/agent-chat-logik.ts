/**
 * P22-T124: reine Logik des Agenten-Chats, gemeinsam fuer den Main-Chat (SynapseWorkspaceMock MainAgentView) und den
 * einheitlichen Chat der Plattform-Agenten (EinheitlicherAgentChat). Bis T124 lagen verlaufInfo/verlaufWerkzeuge/verlaufZugInfo
 * nur im Main-Chat (dort 'Hauptagent' fest); jetzt mit Agentenname als Parameter. Testbar ohne DOM.
 */
import type { AgentChatInboxNachricht, MainAgentVerlaufEintrag } from '../api/agent-runtime';
import type { ToolCallViewModel } from '../control-plane/view-model';

export type ToolLauf = { calls: ToolCallViewModel[]; phases: string[] };

const zeitText = (iso: string): string => {
  const zeit = new Date(iso);
  return Number.isNaN(zeit.getTime()) ? '' : zeit.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export function verlaufInfo(eintrag: MainAgentVerlaufEintrag): string {
  return [eintrag.rolle === 'user' ? eintrag.geraet : null, zeitText(eintrag.erstellt_am)].filter(Boolean).join(' · ');
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
  /** P22-T137: Weg-Kennung der zugestellten Nachricht (z. B. 'inbox:1037'), steht klein in der Info. */
  kennung?: string;
  /** P22-T137: Inbox-ID (aus der Zustell-Huelle bzw. der Inbox), gegen doppelte Anzeige. */
  inboxId?: number;
  /** P22-T137: Zeitpunkt (ISO) fuer das Einsortieren der Inbox-Nachrichten. */
  zeit?: string;
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

export interface ZustellHuelle { text: string; weg: string | null; id: string | null; von: string | null }

const HUELLEN_SCHLUSS = /^(?:Antworte bei Bedarf\b|Bestaetige das Event bei Bedarf\b|Aeltere Nachrichten bei Bedarf:)/;
/** P22-T142: Rahmen der CLI vor der Huelle (Mod ohne asUser, aeltere Eintraege). Mit asUser beginnt der Text direkt mit dem Kopf. */
const HUELLEN_RAHMEN = /^The synapse-inbox plugin sent a message:?$/;

/**
 * P22-T137 (Punkt 6): Huelle einer zugestellten Nachricht (Mod synapse-inbox bzw. Wrapper, baueZustellText im Daemon) zerlegen.
 * Form: [Praefix der CLI 'The synapse-inbox plugin sent a message:'] '[Synapse-Nachricht]' + Kopfzeilen (Weg/Von/An/ID/Zeit) +
 * Leerzeile + Text + Antwort-Hinweis ['This is how Claude Code surfaces ...' der CLI]. Ergebnis: nur der eigentliche Text, dazu
 * Weg, ID (z. B. 'inbox:1037') und Absender. Ohne Zeile '[Synapse-Nachricht]' am Anfang null (P22-T142: mit asUser fehlt der
 * CLI-Rahmen; beide Formen gelten). Rein.
 */
export function zerlegeZustellHuelle(text: string): ZustellHuelle | null {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n');
  // P22-T142: der Kopf zaehlt nur am Anfang (erste nicht leere Zeile, hoechstens nach dem CLI-Rahmen), nie mitten im Text.
  const naechste = (ab: number): number => { let k = ab; while (k < zeilen.length && !zeilen[k].trim()) k++; return k; };
  let start = naechste(0);
  if (start < zeilen.length && HUELLEN_RAHMEN.test(zeilen[start].trim())) start = naechste(start + 1);
  if (start >= zeilen.length || zeilen[start].trim() !== '[Synapse-Nachricht]') return null;
  const kopf: Record<string, string> = {};
  let i = start + 1;
  for (; i < zeilen.length && zeilen[i].trim(); i++) {
    const m = /^(Weg|Von|An|ID|Zeit):\s*(.*)$/.exec(zeilen[i].trim());
    if (m) kopf[m[1]] = m[2].trim();
  }
  let rumpf = zeilen.slice(i);
  const cli = rumpf.findIndex((z) => /^This is how Claude Code surfaces\b/.test(z.trim()));
  if (cli >= 0) rumpf = rumpf.slice(0, cli);
  while (rumpf.length && (!rumpf[rumpf.length - 1].trim() || HUELLEN_SCHLUSS.test(rumpf[rumpf.length - 1].trim()))) rumpf.pop();
  while (rumpf.length && !rumpf[0].trim()) rumpf.shift();
  return { text: rumpf.join('\n'), weg: kopf.Weg ?? null, id: kopf.ID ?? null, von: kopf.Von ? kopf.Von.split(',')[0].trim() : null };
}

const inboxNummer = (kennung: string | null | undefined): number | undefined => {
  const m = /^inbox:(\d+)$/.exec(kennung ?? '');
  return m ? Number(m[1]) : undefined;
};

/**
 * Verlaufseintraege einer Identitaet -> Chat-Nachrichten in der Form des Main-Chats. karten = Schalter verlauf_tool_karten:
 * Werkzeug-Rohzeilen (weg 'werkzeug') entfallen dann, die Karten haengen an der Antwort. Rein.
 */
export function baueAgentChatNachrichten(eintraege: MainAgentVerlaufEintrag[], name: string, karten: boolean): AgentChatNachricht[] {
  const aus: AgentChatNachricht[] = [];
  for (const e of eintraege) {
    if (!SICHTBAR.has(e.rolle) || e.gehoert_zu || (karten && e.weg === 'werkzeug')) continue;
    const toolRun = karten ? verlaufWerkzeuge(e, name) : undefined;
    // P22-T137: zugestellte Eingaben ohne Huellentext; Weg/ID nur als kleine Kennung.
    const huelle = e.rolle === 'nachricht' && e.weg !== 'werkzeug' ? zerlegeZustellHuelle(e.text) : null;
    const text = huelle ? huelle.text : e.text;
    if (!text.trim() && !toolRun && e.status !== 'laeuft') continue;
    const vomAgent = e.rolle === 'agent' || e.rolle === 'ausgabe' || e.rolle === 'system' || e.richtung === 'aus';
    const kopf = e.rolle === 'system' ? 'System · ' + e.weg
      : vomAgent ? name + (e.rolle === 'ausgabe' ? ' · ' + e.weg : '')
        : e.rolle === 'nachricht' ? herkunftKopf(e.absender) ?? (e.absender?.agent_id || 'unbekannt') + ' · ' + e.weg + (e.absender?.channel ? ' #' + e.absender.channel : '') : 'Du';
    const kennung = huelle?.id ?? undefined;
    aus.push({ id: e.id, role: vomAgent ? 'agent' : 'user', text, kopf, info: [verlaufInfo(e), kennung].filter(Boolean).join(' · '), toolRun,
      laeuft: e.status === 'laeuft', hinweise: e.hinweise?.length ? e.hinweise : [], zugInfo: vomAgent ? verlaufZugInfo(e) : undefined,
      ...(kennung ? { kennung } : {}), ...(inboxNummer(kennung) !== undefined ? { inboxId: inboxNummer(kennung) } : {}), zeit: e.erstellt_am });
  }
  return aus;
}

const zeitwert = (iso: string | undefined): number => { const t = iso ? Date.parse(iso) : Number.NaN; return Number.isFinite(t) ? t : Number.NaN; };

/**
 * P22-T137 (Punkt 5): Inbox zwischen User und Agent in den Fensterverlauf einsortieren. Antworten per chat(inbox_send) an 'user'
 * stehen nicht im CLI-Transkript. Die Reihenfolge des Verlaufs bleibt; jede Inbox-Nachricht steht vor der ersten spaeteren
 * Verlaufsnachricht. Nicht doppelt: eine Inbox-ID, die schon als zugestellte Eingabe im Verlauf steht (Huelle 'ID: inbox:N'),
 * entfaellt. Aelter als der geladene Verlaufsausschnitt: entfaellt (sonst stuende Altes ueber einem gekappten Fenster). Rein.
 */
export function mischeInboxNachrichten(nachrichten: AgentChatNachricht[], inbox: AgentChatInboxNachricht[], name: string): AgentChatNachricht[] {
  const imVerlauf = new Set(nachrichten.map((m) => m.inboxId).filter((n): n is number => typeof n === 'number'));
  const erste = nachrichten.length ? zeitwert(nachrichten[0].zeit) : Number.NaN;
  const zusatz: AgentChatNachricht[] = inbox
    .filter((n) => !imVerlauf.has(n.id) && n.text.trim() && !(Number.isFinite(erste) && zeitwert(n.erstellt_am) < erste))
    .sort((a, b) => (zeitwert(a.erstellt_am) - zeitwert(b.erstellt_am)) || a.id - b.id)
    .map((n): AgentChatNachricht => {
      const kennung = 'inbox:' + n.id;
      const vomAgent = n.richtung === 'aus';
      return { id: kennung, role: vomAgent ? 'agent' : 'user', text: n.text, kopf: (vomAgent ? name : n.von === 'user' ? 'Du' : n.von) + ' · Inbox',
        info: [zeitText(n.erstellt_am), kennung].filter(Boolean).join(' · '), laeuft: false, hinweise: [], kennung, inboxId: n.id, zeit: n.erstellt_am };
    });
  if (!zusatz.length) return nachrichten;
  const aus: AgentChatNachricht[] = [];
  let j = 0;
  for (const m of nachrichten) {
    const t = zeitwert(m.zeit);
    while (j < zusatz.length && Number.isFinite(t) && zeitwert(zusatz[j].zeit) < t) aus.push(zusatz[j++]);
    aus.push(m);
  }
  return aus.concat(zusatz.slice(j));
}

/** Modellanzeige wie im Kopf des Main-Chats: Modell der juengsten Agent-Antwort. */
export function aktuellesModell(eintraege: MainAgentVerlaufEintrag[]): string | null {
  for (let i = eintraege.length - 1; i >= 0; i--) if (eintraege[i].rolle === 'agent' && eintraege[i].modell) return eintraege[i].modell;
  return null;
}
