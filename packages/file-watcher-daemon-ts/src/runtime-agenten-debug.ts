/**
 * P22-T116: Daemon-Seite der Runtime-Agenten-Diagnose (Jobs log_lesen, prozesse, prozess_signal aus specialist_jobs).
 * Schalter und Rechte prueft die API (core runtime-agenten-steuerung.ts) BEVOR ein Job entsteht; hier nur begrenztes Lesen.
 * log_lesen: Dateien unter ~/.synapse/agent-runs/<identity>/logs (je Datei hoechstens max_bytes vom Ende, hoechstens 6 Dateien),
 *   Geheimnisse grob maskiert (Ausweise sai_, Bearer, sk-/key=).
 * prozesse: /proc dieses Rechners/Containers (hoechstens 400 Prozesse): PID, PPID, Kommando (200 Zeichen), Laufzeit, CPU-%,
 *   RSS, Identitaet/Agent aus SYNAPSE_AGENT_IDENTITY_ID/SYNAPSE_AGENT_NAME im environ (falls lesbar).
 * prozess_signal: liest den Prozess unmittelbar vorher neu (Rueckgabe prozess) und sendet das Signal; nie PID <= 1, nie sich selbst.
 */
import { readdir, readFile, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_DATEIEN = 6
const MAX_PROZESSE = 400
const HZ = 100
const SIGNALE = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL', 'SIGUSR1', 'SIGUSR2'] as const

export function maskiere(text: string): string {
  return text
    .replace(/sai_[A-Za-z0-9_-]+/g, 'sai_[WERT]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[WERT]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[WERT]')
    .replace(/((?:token|key|secret|password|passwort)\s*[=:]\s*)\S+/gi, '$1[WERT]')
}

async function ende(pfad: string, max: number): Promise<{ text: string; groesse: number; gekappt: boolean }> {
  const s = await stat(pfad)
  const h = await open(pfad, 'r')
  try {
    const laenge = Math.min(s.size, max)
    const buf = Buffer.alloc(laenge)
    await h.read(buf, 0, laenge, s.size - laenge)
    return { text: maskiere(buf.toString('utf-8')), groesse: s.size, gekappt: s.size > max }
  } finally { await h.close() }
}

export async function leseLaufLogs(identity: string, maxBytes: number): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9-]{36}$/.test(identity)) return { success: false, error: 'identity_ungueltig' }
  const max = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(Math.floor(maxBytes), 16_384) : 8_192
  const ordner = join(homedir(), '.synapse', 'agent-runs', identity, 'logs')
  let namen: string[]
  try { namen = (await readdir(ordner)).filter(n => /\.(log|txt)$/.test(n)) } catch { return { success: true, ordner, dateien: [], hinweis: 'kein Log-Ordner' } }
  const mitZeit = await Promise.all(namen.map(async n => ({ n, m: (await stat(join(ordner, n)).catch(() => null))?.mtimeMs ?? 0 })))
  mitZeit.sort((a, b) => b.m - a.m)
  const dateien: Array<Record<string, unknown>> = []
  for (const { n, m } of mitZeit.slice(0, MAX_DATEIEN)) {
    try { dateien.push({ name: n, geaendert: new Date(m).toISOString(), ...(await ende(join(ordner, n), max)) }) }
    catch (e) { dateien.push({ name: n, fehler: String((e as Error).message).slice(0, 200) }) }
  }
  return { success: true, ordner, dateien, weitere: Math.max(0, mitZeit.length - MAX_DATEIEN), max_bytes: max }
}

async function leseProzess(pid: number, uptime: number): Promise<Record<string, unknown> | null> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, 'utf-8')
    const rest = statText.slice(statText.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(rest[1])
    const cpuTicks = Number(rest[11]) + Number(rest[12])
    const startTicks = Number(rest[19])
    const laufzeit = Math.max(0, uptime - startTicks / HZ)
    const cmd = (await readFile(`/proc/${pid}/cmdline`, 'utf-8').catch(() => '')).replace(/\0+/g, ' ').trim()
    const status = await readFile(`/proc/${pid}/status`, 'utf-8').catch(() => '')
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0)
    let identity_id: string | null = null
    let agent: string | null = null
    try {
      const env = (await readFile(`/proc/${pid}/environ`, 'utf-8')).split('\0')
      identity_id = env.find(e => e.startsWith('SYNAPSE_AGENT_IDENTITY_ID='))?.slice(26) || null
      agent = env.find(e => e.startsWith('SYNAPSE_AGENT_NAME='))?.slice(19) || null
    } catch { /* fremder Benutzer */ }
    return { pid, ppid, kommando: maskiere(cmd || statText.slice(statText.indexOf('(') + 1, statText.lastIndexOf(')'))).slice(0, 200),
      laufzeit_s: Math.round(laufzeit), cpu_prozent: laufzeit > 0 ? Math.round((cpuTicks / HZ / laufzeit) * 1000) / 10 : 0,
      rss_kb: rss, identity_id, agent, start_ticks: startTicks }
  } catch { return null }
}

async function uptimeS(): Promise<number> {
  return Number((await readFile('/proc/uptime', 'utf-8')).split(' ')[0])
}

/** Eine Seite der Prozessliste: PIDs >= abPid, hoechstens max (Standard/Obergrenze MAX_PROZESSE). Fortsetzung ueber naechste_ab_pid. */
export async function leseProzessliste(abPid = 0, max = MAX_PROZESSE): Promise<Record<string, unknown>> {
  const uptime = await uptimeS()
  const grenze = Number.isSafeInteger(max) && max > 0 ? Math.min(max, MAX_PROZESSE) : MAX_PROZESSE
  const ab = Number.isSafeInteger(abPid) && abPid > 0 ? abPid : 0
  const pids = (await readdir('/proc')).filter(n => /^\d+$/.test(n)).map(Number).filter(p => p >= ab).sort((a, b) => a - b)
  const seite = pids.slice(0, grenze)
  const prozesse: Array<Record<string, unknown>> = []
  for (const pid of seite) {
    const p = await leseProzess(pid, uptime)
    if (p) prozesse.push(p)
  }
  const gekappt = pids.length > grenze
  return { success: true, prozesse, anzahl: prozesse.length, gekappt, naechste_ab_pid: gekappt ? pids[grenze] : null,
    eigene_pid: process.pid, gelesen_am: new Date().toISOString() }
}

/** Pin-Vergleich (rein): derselbe Prozess = gleiche start_ticks UND gleiches Kommando wie in der Vorschau. */
export function gleicherProzess(prozess: Record<string, unknown>, pin: { start_ticks: unknown; kommando: unknown }): boolean {
  return Number.isSafeInteger(pin.start_ticks) && prozess.start_ticks === pin.start_ticks
    && typeof pin.kommando === 'string' && prozess.kommando === pin.kommando
}

export async function sendeProzessSignal(pid: number, signal: string, pin?: { start_ticks: unknown; kommando: unknown }): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return { success: false, error: 'pid_ungueltig' }
  if (!(SIGNALE as readonly string[]).includes(signal)) return { success: false, error: 'signal_ungueltig' }
  if (!pin) return { success: false, error: 'pin_fehlt' }
  const prozess = await leseProzess(pid, await uptimeS())
  if (!prozess) return { success: false, error: 'prozess_nicht_gefunden', pid }
  if (!gleicherProzess(prozess, pin)) return { success: false, error: 'prozess_geaendert', pid, prozess, pin }
  try {
    process.kill(pid, signal as NodeJS.Signals)
    console.error(`[specialist-worker] P22-T116 Signal ${signal} an PID ${pid} (${String(prozess.kommando).slice(0, 80)})`)
    return { success: true, pid, signal, prozess }
  } catch (e) {
    return { success: false, error: 'signal_fehlgeschlagen', message: String((e as Error).message).slice(0, 200), pid, signal, prozess }
  }
}
