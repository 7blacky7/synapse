/**
 * MODUL: skills-proxy.ts
 * ZWECK: POST /skills/:aktion — reicht Aufrufe lokaler Werkzeuge (skill-db.mjs,
 *        Skill-Hooks von Claude Code) an das skills-Tool der Synapse-API weiter.
 *
 * WARUM UEBER DEN DAEMON (P12-T19, User-Vorgabe 11.10.2026): Die API ist ueber
 * Cloudflare im Internet erreichbar. Skripte unter ~/.claude sollen deshalb keinen
 * eigenen Token halten. Der Daemon ist schon angemeldet (synapse_api_token in
 * ~/.synapse/file-watcher/config.json, per TOTP ausgehandelt) — die Skripte sehen
 * diesen Token nie, sie sprechen nur 127.0.0.1:7878 an.
 *
 * SCHUTZ:
 *  - Der Daemon bindet nur an 127.0.0.1 (main.ts); zusaetzlich wird hier jede
 *    Nicht-Loopback-Adresse abgelehnt.
 *  - Anfragen mit Origin-Header (Browser) werden abgelehnt, und der Body muss
 *    application/json sein. So kann keine Webseite per Formular-POST Skills
 *    aendern (ein JSON-POST aus dem Browser loest einen CORS-Preflight aus, den
 *    der Daemon nicht beantwortet).
 *  - Allowlist der Aktionen; alles andere 403.
 *
 * Die Suche laeuft damit ueber dasselbe Modell, dieselben Praefixe und denselben
 * Vektorraum wie Synapse selbst, und als interaktive Anfrage mit Vorrang vor
 * Hintergrund-Embeddings (P5-T15).
 */

import type { FastifyInstance } from 'fastify';
import { loadConfig, DEFAULT_SYNAPSE_API_URL } from './config.js';

export const SKILLS_LESEN = ['search', 'list', 'get_section', 'get_full'] as const;
export const SKILLS_SCHREIBEN = ['add_section', 'update_section', 'delete_section', 'delete_skill', 'replace_skill'] as const;
const ERLAUBT = new Set<string>([...SKILLS_LESEN, ...SKILLS_SCHREIBEN]);

/** Lesen kurz (Hooks warten darauf), Schreiben laenger (replace_skill mit vielen Sections). */
const TIMEOUT_LESEN_MS = 10_000;
const TIMEOUT_SCHREIBEN_MS = 60_000;

export function istLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

interface ApiZugang {
  url: string;
  token: string | null;
}

/** Auch fuer intern-bruecke.ts (P15-T12): derselbe Zugang, kein eigener Token. */
export function leseApiZugang(): ApiZugang {
  let url = DEFAULT_SYNAPSE_API_URL;
  let token: string | null = null;
  try {
    const cfg = loadConfig();
    if (cfg.synapse_api_url) url = cfg.synapse_api_url;
    if (typeof cfg.synapse_api_token === 'string' && cfg.synapse_api_token) token = cfg.synapse_api_token;
  } catch { /* Defaults */ }
  return { url: url.replace(/\/+$/, ''), token };
}

/** Ergebnis eines MCP tools/call auspacken: structuredContent bevorzugt, sonst der JSON-Text. */
export function packeToolErgebnisAus(rpc: unknown): Record<string, unknown> {
  const r = rpc as { error?: { message?: string }; result?: { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } };
  if (r?.error) return { success: false, error: 'api_fehler', message: r.error.message ?? 'JSON-RPC-Fehler' };
  const res = r?.result;
  if (res?.structuredContent && typeof res.structuredContent === 'object') {
    return res.structuredContent as Record<string, unknown>;
  }
  const text = res?.content?.find((c) => c?.type === 'text')?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* kein JSON */ }
    return { success: false, error: 'unerwartete_antwort', message: text.slice(0, 500) };
  }
  return { success: false, error: 'unerwartete_antwort', message: 'Antwort ohne Inhalt' };
}

export function registriereSkillsProxy(app: FastifyInstance): void {
  app.post<{ Params: { aktion: string }; Body: Record<string, unknown> }>(
    '/skills/:aktion',
    async (req, reply) => {
      if (!istLoopback(req.ip)) {
        reply.code(403);
        return { success: false, error: 'nur_lokal', message: 'Nur von 127.0.0.1 erlaubt.' };
      }
      if (req.headers.origin !== undefined) {
        reply.code(403);
        return { success: false, error: 'browser_abgelehnt', message: 'Anfragen aus dem Browser (Origin-Header) sind nicht erlaubt.' };
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply.code(415);
        return { success: false, error: 'nur_json', message: 'Content-Type application/json erforderlich.' };
      }
      const aktion = req.params.aktion;
      if (!ERLAUBT.has(aktion)) {
        reply.code(403);
        return { success: false, error: 'aktion_nicht_erlaubt', message: `Erlaubt: ${[...ERLAUBT].join(', ')}` };
      }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      // action kommt ausschliesslich aus dem Pfad — ein action-Feld im Body kann die Allowlist nicht umgehen.
      const args: Record<string, unknown> = { ...body, action: aktion };

      const { url, token } = leseApiZugang();
      const schreibend = (SKILLS_SCHREIBEN as readonly string[]).includes(aktion);
      try {
        const res = await fetch(`${url}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skills', arguments: args } }),
          signal: AbortSignal.timeout(schreibend ? TIMEOUT_SCHREIBEN_MS : TIMEOUT_LESEN_MS),
        });
        if (res.status === 401 || res.status === 403) {
          reply.code(502);
          return { success: false, error: 'api_anmeldung', message: `Synapse-API lehnt den Daemon-Token ab (HTTP ${res.status}). Daemon im Tray neu anmelden.` };
        }
        if (!res.ok) {
          reply.code(502);
          return { success: false, error: 'api_http', message: `Synapse-API antwortete HTTP ${res.status}.` };
        }
        return packeToolErgebnisAus(await res.json());
      } catch (err) {
        reply.code(504);
        return { success: false, error: 'api_nicht_erreichbar', message: `Synapse-API (${url}) nicht erreichbar: ${(err as Error).message}` };
      }
    },
  );
}
