/**
 * MODUL: MCP-HTTP-Client des API-Agent-Workers (P22-T8)
 * ZWECK: Synapse-Werkzeuge ueber DENSELBEN HTTP-MCP-Weg wie die Claude-CLI des Spezialisten: mcp-http.json aus der
 *        MCP-Bruecke (SYNAPSE_MCP_CONFIG_FILE, Header inkl. x-synapse-agent-token = ${SYNAPSE_AGENT_TOKEN}). tools/list liefert
 *        genau, was der Server diesem Agenten erlaubt (Gate/Profil); tools/call fuehrt als dieser Agent aus (Audit wie immer).
 *        Kein Direktzugriff auf PG, keine lokalen Datei- oder Shell-Werkzeuge.
 * OHNE Konfigurationsdatei: SYNAPSE_API_URL + SYNAPSE_API_TOKEN + SYNAPSE_AGENT_TOKEN (Wrapper-Transport api).
 */
import { readFile } from 'node:fs/promises'
import type { BildBlock, TextBlock, WerkzeugAusfuehrer, WerkzeugDef } from './toolschleife.js'

export const WERKZEUG_PRAEFIX = 'mcp__synapse__'
const ZEITLIMIT_MS = 10 * 60_000

export interface SynapseZugang {
  /** MCP-Endpunkt (POST JSON-RPC) */
  mcpUrl: string
  /** Basis der Synapse-API (ohne Pfad), fuer den Anbieter-Transport */
  apiBasis: string
  kopf: Record<string, string>
}

/** ${NAME} in Headerwerten aus der Umgebung ersetzen (wie die CLI); fehlende Variable -> leer. */
function ersetzeEnv(wert: string, env: NodeJS.ProcessEnv): string {
  return wert.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n: string) => env[n] ?? '')
}

export async function leseSynapseZugang(env: NodeJS.ProcessEnv = process.env): Promise<SynapseZugang> {
  const datei = env.SYNAPSE_MCP_CONFIG_FILE?.trim()
  if (datei) {
    const cfg = JSON.parse(await readFile(datei, 'utf-8')) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }
    const server = Object.values(cfg.mcpServers ?? {}).find(s => typeof s?.url === 'string')
    if (!server?.url) throw new Error(`MCP-Konfiguration ${datei} ohne HTTP-Server-URL`)
    const kopf: Record<string, string> = {}
    for (const [k, v] of Object.entries(server.headers ?? {})) kopf[k] = ersetzeEnv(String(v), env)
    const u = new URL(server.url)
    const apiBasis = (env.SYNAPSE_API_URL ?? '').trim().replace(/\/+$/, '') || u.origin
    return { mcpUrl: server.url, apiBasis, kopf }
  }
  const basis = (env.SYNAPSE_API_URL ?? '').trim().replace(/\/+$/, '')
  const token = (env.SYNAPSE_API_TOKEN ?? '').trim()
  if (!basis || !token) {
    throw new Error('API-Worker braucht SYNAPSE_MCP_CONFIG_FILE (HTTP-MCP-Bruecke) oder SYNAPSE_API_URL + SYNAPSE_API_TOKEN. '
      + 'Kein stiller Rueckfall auf einen Direktzugriff.')
  }
  const kopf: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (env.SYNAPSE_AGENT_TOKEN) kopf['x-synapse-agent-token'] = env.SYNAPSE_AGENT_TOKEN
  if (env.SYNAPSE_AGENT_NAME) kopf['X-Synapse-Agent'] = env.SYNAPSE_AGENT_NAME
  return { mcpUrl: `${basis}/mcp/messages`, apiBasis: basis, kopf }
}

interface McpInhalt { type?: string; text?: string; data?: string; mimeType?: string }

export class McpHttpClient implements WerkzeugAusfuehrer {
  private naechsteId = 1

  constructor(private readonly zugang: SynapseZugang, private readonly holen: typeof fetch = fetch) {}

  private async rpc(methode: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const antwort = await this.holen(this.zugang.mcpUrl, {
      method: 'POST',
      headers: { ...this.zugang.kopf, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.naechsteId++, method: methode, params }),
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
    })
    const text = await antwort.text()
    if (!antwort.ok) throw new Error(`MCP ${methode}: HTTP ${antwort.status} ${text.slice(0, 300)}`)
    // JSON oder SSE (data:-Zeilen) - beides tolerant lesen.
    let daten: Record<string, unknown> | null = null
    try {
      daten = JSON.parse(text) as Record<string, unknown>
    } catch {
      for (const zeile of text.split('\n')) {
        if (!zeile.startsWith('data:')) continue
        try { daten = JSON.parse(zeile.slice(5).trim()) as Record<string, unknown> } catch { /* naechste Zeile */ }
      }
    }
    if (!daten) throw new Error(`MCP ${methode}: Antwort nicht lesbar`)
    if (daten.error) throw new Error(`MCP ${methode}: ${JSON.stringify(daten.error).slice(0, 500)}`)
    return (daten.result ?? {}) as Record<string, unknown>
  }

  /** tools/list -> Werkzeugdefinitionen mit Praefix (Weck-Prompts des Wrappers nennen mcp__synapse__<tool>). */
  async listeWerkzeuge(): Promise<WerkzeugDef[]> {
    const r = await this.rpc('tools/list', {})
    const tools = Array.isArray(r.tools) ? (r.tools as Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>) : []
    return tools.filter(t => typeof t.name === 'string' && t.name).map(t => ({
      name: WERKZEUG_PRAEFIX + t.name,
      beschreibung: t.description ?? '',
      schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    }))
  }

  async rufe(name: string, eingabe: Record<string, unknown>): Promise<{ inhalt: Array<TextBlock | BildBlock>; fehler: boolean }> {
    const werkzeug = name.startsWith(WERKZEUG_PRAEFIX) ? name.slice(WERKZEUG_PRAEFIX.length) : name
    const r = await this.rpc('tools/call', { name: werkzeug, arguments: eingabe ?? {} })
    const inhalt: Array<TextBlock | BildBlock> = []
    for (const c of (Array.isArray(r.content) ? r.content : []) as McpInhalt[]) {
      if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') inhalt.push({ typ: 'bild', media_type: c.mimeType, daten: c.data })
      else if (typeof c.text === 'string') inhalt.push({ typ: 'text', text: c.text })
      else inhalt.push({ typ: 'text', text: JSON.stringify(c) })
    }
    return { inhalt, fehler: r.isError === true }
  }
}
