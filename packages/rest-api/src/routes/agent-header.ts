/**
 * MODUL: agent-header
 * ZWECK: agent_id aus Request-Headern ableiten, wenn der Aufrufer keinen agent_id-Parameter mitschickt.
 *
 * Quellen (in dieser Reihenfolge):
 *   1. OpenAI/ChatGPT: User-Agent "openai-mcp/*" + X-Openai-Session "v1/<token>" -> "gpt-<8 Zeichen>".
 *   2. X-Synapse-Agent (P7-T32): traegt die HTTP-Bruecke der Spezialisten (mcp-http.json), damit deren
 *      Aufrufe in tool_calls / shell(activity) dem Agenten zugeordnet werden, auch ohne agent_id-Parameter.
 *      NUR Zuordnung, keine Berechtigung (das Token traegt die Rechte; gleiche Vertrauensstufe wie der
 *      agent_id-Parameter). Ungueltige Namen werden still ignoriert — kein Fehler.
 * Ein ausdruecklich gesendeter agent_id-Parameter gewinnt immer (das prueft der Aufrufer).
 */

/** Erlaubte Namen: Buchstaben, Ziffern, _ und -, 1..64 Zeichen. */
const AGENT_NAME_MUSTER = /^[A-Za-z0-9_-]{1,64}$/;

export const AGENT_HEADER_NAME = 'x-synapse-agent';

export function leiteAgentIdAusHeaders(headers: Record<string, unknown>): string | undefined {
  const ua = String(headers['user-agent'] || '').toLowerCase();
  if (ua.startsWith('openai-mcp')) {
    const session = String(headers['x-openai-session'] || '');
    const m = session.match(/v1\/([A-Za-z0-9]{8})/);
    if (m) return `gpt-${m[1].toLowerCase()}`;
    return 'gpt-web';
  }
  const roh = headers[AGENT_HEADER_NAME];
  if (typeof roh === 'string' && AGENT_NAME_MUSTER.test(roh)) return roh;
  return undefined;
}
