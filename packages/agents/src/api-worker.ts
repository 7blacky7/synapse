#!/usr/bin/env node
/**
 * MODUL: API-Agent-Worker (P22-T8, W2-API) - Node-Runtime im Wrapper wie agents-gemini (process.ts node-Zweig).
 * ZWECK: Persistenter Agent mit Identitaet (Ausweis), Persona/Regeln (chat anmelden + System-Prompt des Wrappers),
 *        Verlauf und Nachrichteneingang (stdin, Stream-JSON wie die Claude-CLI). Modell per API-Key - der Key bleibt
 *        serverseitig, jeder Aufruf geht ueber den Provider-Transport der Synapse-API (Budget, Kosten).
 * START: der Wrapper bzw. im Container der Runtime-Daemon (T6) spawnt ihn fuer einen Modell-Alias mit runtime_binary 'node'
 *   und runtime_path '@synapse/agents/api-worker' (model_registry, provider 'anthropic-api'). Kein eigener Startweg.
 * ENV (vom Wrapper): SYNAPSE_WRAPPER_MODE=1, SYNAPSE_AGENT_NAME, SYNAPSE_AGENT_MODEL (Alias), SYNAPSE_PROJECT_PATH,
 *   SYNAPSE_PROJECT_NAME, SYNAPSE_SYSTEM_PROMPT_FILE, SYNAPSE_SESSION_ID, SYNAPSE_AGENT_TOKEN, dazu SYNAPSE_MCP_CONFIG_FILE
 *   (HTTP-MCP-Bruecke) oder SYNAPSE_API_URL + SYNAPSE_API_TOKEN.
 * AUSGABE: system/init, assistant (Text), ping waehrend langer Schritte, result mit usage - wie die Claude-CLI; dazu die
 *   Token-JSONL unter ~/.claude/projects/<pfad>/<session>.jsonl fuer den Kontextstand des Wrappers. Kein Bash, keine lokalen
 *   Werkzeuge: nur die Synapse-MCP-Tools, die der Server diesem Agenten erlaubt.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolveModel } from './models.js'
import { berechneKontextSchwellen } from '@synapse/core'
import { fuehreNachrichtAus, type Nutzung } from './api-worker/toolschleife.js'
import { DateiVerlauf } from './api-worker/verlauf.js'
import { McpHttpClient, leseSynapseZugang, WERKZEUG_PRAEFIX } from './api-worker/mcp-http-client.js'
import { AnthropicUeberSynapse, holeApiRahmen } from './api-worker/anbieter-anthropic.js'

const PING_MS = 30_000
/** Anfangsgroesse der Ausgabe je Aufruf; der Server kappt an seiner Einstellung max_tokens_obergrenze. */
const MAX_TOKENS_WUNSCH = 128_000
const ANMELDUNG_MAX_ZEICHEN = 20_000

function pflicht(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`FEHLER: ${name} nicht gesetzt (API-Worker laeuft nur im Wrapper-Modus)`)
    process.exit(1)
  }
  return v
}

function aus(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function textAusEingabe(zeile: string): string {
  try {
    const msg = JSON.parse(zeile) as unknown
    if (typeof msg === 'string') return msg
    const m = msg as { message?: { content?: Array<{ type?: string; text?: string }> }; text?: string }
    if (Array.isArray(m.message?.content)) return m.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    if (typeof m.text === 'string') return m.text
    return JSON.stringify(msg)
  } catch {
    return zeile
  }
}

async function main(): Promise<void> {
  if (process.env.SYNAPSE_WRAPPER_MODE !== '1') {
    console.error('API-Worker: nur im Wrapper-Modus (SYNAPSE_WRAPPER_MODE=1). Start ueber den Spezialisten-Weg mit einem api-* Modell.')
    process.exit(1)
  }
  const agentName = pflicht('SYNAPSE_AGENT_NAME')
  const alias = pflicht('SYNAPSE_AGENT_MODEL')
  const projectPath = pflicht('SYNAPSE_PROJECT_PATH')
  const project = pflicht('SYNAPSE_PROJECT_NAME')
  const sessionId = process.env.SYNAPSE_SESSION_ID?.trim() || randomUUID()
  const modell = resolveModel(alias)

  const zugang = await leseSynapseZugang()
  const mcp = new McpHttpClient(zugang)
  const adapter = new AnthropicUeberSynapse(zugang, { project, modell: alias })

  aus({ type: 'system', subtype: 'init', session_id: sessionId, cwd: projectPath, model: modell?.fullId ?? alias, runtime: 'api-worker' })

  // Persona/Regeln: System-Prompt des Wrappers + Anmeldung mit dem eigenen Ausweis (Regeln, Profil, Skills).
  let system = process.env.SYNAPSE_SYSTEM_PROMPT_FILE ? await readFile(process.env.SYNAPSE_SYSTEM_PROMPT_FILE, 'utf-8') : ''
  if (process.env.SYNAPSE_AGENT_TOKEN) {
    try {
      const anm = await mcp.rufe(WERKZEUG_PRAEFIX + 'chat', { action: 'anmelden', token: process.env.SYNAPSE_AGENT_TOKEN })
      const text = anm.inhalt.filter(b => b.typ === 'text').map(b => (b as { text: string }).text).join('\n')
      if (!anm.fehler && text) {
        system += `\n\n# Synapse-Anmeldung (Ausweis bereits angemeldet; den Ausweis bei jedem Synapse-Aufruf als token mitgeben)\n${text.slice(0, ANMELDUNG_MAX_ZEICHEN)}`
      }
    } catch (err) {
      console.error(`[api-worker] Anmeldung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  system += '\n\nDu arbeitest ausschliesslich mit den angebotenen Synapse-Werkzeugen (kein Bash, kein lokales Dateisystem).'

  const werkzeuge = await mcp.listeWerkzeuge()
  const verlauf = await DateiVerlauf.oeffne(join(projectPath, '.synapse', 'agents', agentName, `api-verlauf-${sessionId}.jsonl`))

  // Token-Stand fuer den Wrapper (syncTokensFromHistory) im Claude-JSONL-Format.
  const jsonlDir = join(homedir(), '.claude', 'projects', projectPath.replace(/\//g, '-'))
  await mkdir(jsonlDir, { recursive: true })
  const jsonl = join(jsonlDir, `${sessionId}.jsonl`)
  await writeFile(jsonl, '', { flag: 'a' })
  const handoffTokens = berechneKontextSchwellen(modell, alias).handoffTokens
  let handoffGemeldet = false
  let gesamtAusgabe = 0

  const stdin = createInterface({ input: process.stdin })
  for await (const zeile of stdin) {
    if (!zeile.trim()) continue
    const eingabe = textAusEingabe(zeile)
    await verlauf.fuegeHinzu({ rolle: 'user', inhalt: [{ typ: 'text', text: eingabe }] })

    const ping = setInterval(() => aus({ type: 'ping' }), PING_MS)
    let letzte: Nutzung | null = null
    try {
      const rahmen = await holeApiRahmen(zugang, project).catch(() => null)
      const g = (rahmen?.grenzen ?? {}) as { toolrunden_max?: number; laufzeit_minuten?: number; max_tokens_obergrenze?: number }
      const ergebnis = await fuehreNachrichtAus({
        adapter, werkzeuge, ausfuehrer: mcp, verlauf, system,
        max_tokens: Math.min(MAX_TOKENS_WUNSCH, g.max_tokens_obergrenze ?? MAX_TOKENS_WUNSCH, modell?.outputLimit ?? MAX_TOKENS_WUNSCH),
        // Ohne lesbaren Rahmen: der Transport lehnt ohnehin ab; die Werte hier sind nur die Schleifengrenze bis dahin.
        grenzen: { toolrunden_max: g.toolrunden_max ?? 1, laufzeit_ms: (g.laufzeit_minuten ?? 1) * 60_000 },
        beiText: (text) => aus({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
        beiNutzung: async (n) => {
          letzte = n
          gesamtAusgabe += n.output
          await appendFile(jsonl, JSON.stringify({ message: { usage: { input_tokens: n.input, output_tokens: n.output,
            cache_read_input_tokens: n.cache_read, cache_creation_input_tokens: n.cache_creation } } }) + '\n')
        },
        beiEreignis: (art, daten) => console.error(`[api-worker] ${art} ${JSON.stringify(daten)}`),
      })
      const kontext = letzte ? (letzte as Nutzung).input + (letzte as Nutzung).cache_read + (letzte as Nutzung).cache_creation : 0
      if (!handoffGemeldet && kontext >= handoffTokens) {
        handoffGemeldet = true
        await mcp.rufe(WERKZEUG_PRAEFIX + 'thought', {
          action: 'add', project, source: agentName, tags: ['auto-handoff'], trigger_respawn: true,
          ...(process.env.SYNAPSE_AGENT_TOKEN ? { token: process.env.SYNAPSE_AGENT_TOKEN } : {}),
          content: `AUTO-HANDOFF: Kontext ${kontext} Tokens (Korridor ab ${handoffTokens}), API-Worker ${alias}`,
        }).catch(err => console.error(`[api-worker] trigger_respawn fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`))
      }
      aus({ type: 'result', result: ergebnis.text, ende: ergebnis.ende, kosten_usd: ergebnis.kosten_usd,
        usage: { input_tokens: kontext, output_tokens: gesamtAusgabe } })
    } catch (err) {
      aus({ type: 'result', result: `API-Worker-Fehler: ${err instanceof Error ? err.message : String(err)}`, ende: 'fehler', usage: { input_tokens: 0, output_tokens: gesamtAusgabe } })
    } finally {
      clearInterval(ping)
    }
  }
}

main().catch((err) => {
  console.error('[api-worker] Fataler Fehler:', err)
  process.exit(1)
})
